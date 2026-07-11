import { describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInstallPlan, defaultInstallRoot } from "../src/install.mjs";
import { parseCliArgs } from "../src/lib/args.mjs";
import { prepareBundle, verifyBundlePayload } from "../src/lib/bundle.mjs";
import { inspectDoctor } from "../src/doctor.mjs";
import { normalizePlatform } from "../src/lib/platform.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("buildInstallPlan", () => {
  it("derives manifest and bundle URLs from apiUrl", () => {
    const plan = buildInstallPlan({
      apiUrl: "https://agenthub.example.com",
      enrollmentToken: "token",
      platform: "linux",
    });

    expect(plan.manifestUrl).toBe("https://agenthub.example.com/downloads/workers/worker-bundles-manifest.json");
    expect(plan.archiveName).toBe("agenthub-worker-linux.tar.gz");
    expect(plan.bundleUrl).toBe("https://agenthub.example.com/downloads/workers/agenthub-worker-linux.tar.gz");
  });

  it("derives a macOS bundle URL for darwin hosts", () => {
    const plan = buildInstallPlan({
      apiUrl: "https://agenthub.example.com/",
      enrollmentToken: "token",
      platform: "darwin",
      installRoot: "/Users/alice/Library/Application Support/AgentHub/workers/macbook",
    });

    expect(plan.platform).toBe("macos");
    expect(plan.archiveName).toBe("agenthub-worker-macos.tar.gz");
    expect(plan.bundleUrl).toBe("https://agenthub.example.com/downloads/workers/agenthub-worker-macos.tar.gz");
  });

  it("uses durable per-worker install roots instead of the downloaded temp directory", () => {
    expect(defaultInstallRoot("macos", "macbook-pro", { homeDir: "/Users/alice" })).toBe(
      "/Users/alice/Library/Application Support/AgentHub/workers/macbook-pro",
    );
    expect(defaultInstallRoot("linux", "build-vm", { homeDir: "/home/alice" })).toBe(
      "/home/alice/.local/share/AgentHub/workers/build-vm",
    );
    expect(
      defaultInstallRoot("windows", "office-pc", {
        homeDir: "C:\\Users\\alice",
        localAppData: "C:\\Users\\alice\\AppData\\Local",
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Local\\AgentHub\\workers\\office-pc");
  });

  it("keeps reserved worker ids inside the durable workers directory", () => {
    expect(defaultInstallRoot("macos", "..", { homeDir: "/Users/alice" })).toBe(
      "/Users/alice/Library/Application Support/AgentHub/workers/worker",
    );
  });
});

describe("platform normalization", () => {
  it("routes both darwin and macOS to the macos worker", () => {
    expect(normalizePlatform("darwin")).toBe("macos");
    expect(normalizePlatform("macOS")).toBe("macos");
  });
});

describe("macOS CLI options", () => {
  it("accepts an explicit LaunchAgent label", () => {
    const parsed = parseCliArgs(["install", "--launch-agent-label", "dev.myagenthub.worker.macbook"]);

    expect(parsed.options.serviceName).toBe("dev.myagenthub.worker.macbook");
  });
});

describe("doctor", () => {
  it("checks native macOS prerequisites without reporting PowerShell", () => {
    const available = new Set(["bash", "python3", "tar", "launchctl"]);
    const report = inspectDoctor({ platform: "macos" }, (command) => available.has(command));

    expect(report.ok).toBe(true);
    expect(report.lines).toContain("python3: available");
    expect(report.lines).toContain("tar: available");
    expect(report.lines).toContain("launchctl: available");
    expect(report.lines.join("\n")).not.toContain("PowerShell");
  });

  it("fails when a required macOS prerequisite is missing", () => {
    const report = inspectDoctor({ platform: "macos" }, (command) => command !== "launchctl");

    expect(report.ok).toBe(false);
    expect(report.lines).toContain("launchctl: missing");
  });

  it("accepts uv as the macOS Python bootstrap fallback", () => {
    const available = new Set(["bash", "uv", "tar", "launchctl"]);
    const report = inspectDoctor({ platform: "macos" }, (command) => available.has(command));

    expect(report.ok).toBe(true);
    expect(report.lines).toContain("python3: missing");
    expect(report.lines).toContain("uv: available");
  });
});

describe("worker bundle integrity", () => {
  it("accepts a bundle only when the manifest sha256 matches", () => {
    const payload = Buffer.from("signed-worker-bundle");
    const manifest = {
      bundle_version: "1.0.0",
      bundles: [
        {
          platform: "macos",
          archive: "agenthub-worker-macos.tar.gz",
          sha256: "05a1cc62d2a36c0bed2ec7e099a0cbaedbf2d8a253a13129dcb5a20265388d52",
          paths: ["workers/local-macos/agenthub_macos_worker"],
        },
      ],
    };

    expect(
      verifyBundlePayload(payload, manifest, {
        platform: "macos",
        archiveName: "agenthub-worker-macos.tar.gz",
      }),
    ).toMatchObject({ platform: "macos", archive: "agenthub-worker-macos.tar.gz" });
  });

  it("rejects missing or mismatched manifest digests", () => {
    const payload = Buffer.from("tampered-worker-bundle");
    const baseBundle = {
      platform: "macos",
      archive: "agenthub-worker-macos.tar.gz",
      paths: ["workers/local-macos/agenthub_macos_worker"],
    };

    expect(() =>
      verifyBundlePayload(payload, { bundles: [{ ...baseBundle, sha256: "0".repeat(64) }] }, {
        platform: "macos",
        archiveName: "agenthub-worker-macos.tar.gz",
      }),
    ).toThrow(/sha256 mismatch/i);
    expect(() =>
      verifyBundlePayload(payload, { bundles: [baseBundle] }, {
        platform: "macos",
        archiveName: "agenthub-worker-macos.tar.gz",
      }),
    ).toThrow(/missing.*sha256/i);
  });

  it("checks the manifest before extracting a downloaded archive", async () => {
    const payload = Buffer.from("tampered-worker-bundle");
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("worker-bundles-manifest.json")) {
        return {
          ok: true,
          json: async () => ({
            bundles: [
              {
                platform: "macos",
                archive: "agenthub-worker-macos.tar.gz",
                sha256: "0".repeat(64),
                paths: ["workers/local-macos/agenthub_macos_worker"],
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        arrayBuffer: async () => payload,
      };
    });
    const extractArchive = vi.fn();

    await expect(
      prepareBundle(
        {
          platform: "macos",
          archiveName: "agenthub-worker-macos.tar.gz",
          manifestUrl: "https://agenthub.example.com/downloads/workers/worker-bundles-manifest.json",
          bundleUrl: "https://agenthub.example.com/downloads/workers/agenthub-worker-macos.tar.gz",
        },
        { fetchImpl, extractArchive },
      ),
    ).rejects.toThrow(/sha256 mismatch/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it("creates the extraction directory after verifying a valid archive", async () => {
    const payload = Buffer.from("signed-worker-bundle");
    const manifest = {
      bundles: [
        {
          platform: "macos",
          archive: "agenthub-worker-macos.tar.gz",
          sha256: "05a1cc62d2a36c0bed2ec7e099a0cbaedbf2d8a253a13129dcb5a20265388d52",
          paths: ["workers/local-macos/agenthub_macos_worker"],
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => manifest })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => payload });
    const extractArchive = vi.fn(async (_archivePath, extractRoot) => {
      expect((await stat(extractRoot)).isDirectory()).toBe(true);
      await mkdir(path.join(extractRoot, "agenthub-worker"));
    });

    const prepared = await prepareBundle(
      {
        platform: "macos",
        archiveName: "agenthub-worker-macos.tar.gz",
        manifestUrl: "https://agenthub.example.com/downloads/workers/worker-bundles-manifest.json",
        bundleUrl: "https://agenthub.example.com/downloads/workers/agenthub-worker-macos.tar.gz",
      },
      { fetchImpl, extractArchive },
    );
    try {
      expect(prepared.bundleRoot).toContain("agenthub-worker");
      expect(extractArchive).toHaveBeenCalledOnce();
    } finally {
      await prepared.cleanup();
    }
  });
});

describe("package publish surface", () => {
  it("declares npm publish metadata and docs", () => {
    const packageJsonPath = path.resolve(__dirname, "..", "package.json");
    const rootPackageJsonPath = path.resolve(__dirname, "..", "..", "..", "package.json");
    const readmePath = path.resolve(__dirname, "..", "README.md");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf8"));

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.repository?.url).toContain("AgentHub-OSS");
    expect(packageJson.files).toContain("src");
    expect(packageJson.bin?.["agenthub-worker"]).toBe("src/cli.mjs");
    expect(packageJson.name).toBe("agenthub-worker");
    expect(packageJson.version).toBe(rootPackageJson.version);
    expect(existsSync(readmePath)).toBe(true);
  });
});
