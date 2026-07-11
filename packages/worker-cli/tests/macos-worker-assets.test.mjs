import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function pythonCommand() {
  const venvPython = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (process.platform === "win32") {
    return venvPython;
  }
  return "python3";
}

describe("macOS worker bundle", () => {
  it("builds a macOS archive and records it in the published manifest", () => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), "agenthub-macos-bundle-"));
    try {
      const result = spawnSync(
        pythonCommand(),
        [path.join(repoRoot, "scripts", "build-worker-bundle.py"), "--output-root", outputRoot, "--version", "test-macos"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);

      const manifest = JSON.parse(readFileSync(path.join(outputRoot, "worker-bundles-manifest.json"), "utf8"));
      expect(manifest.bundles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            platform: "macos",
            archive: "agenthub-worker-macos.tar.gz",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
      );

      const listing = spawnSync("tar", ["-tzf", path.join(outputRoot, "agenthub-worker-macos.tar.gz")], {
        encoding: "utf8",
      });
      expect(listing.status, listing.stderr).toBe(0);
      expect(listing.stdout).toContain("agenthub-worker/scripts/install-macos-worker.sh");
      expect(listing.stdout).toContain("agenthub-worker/scripts/uninstall-macos-worker.sh");
      expect(listing.stdout).toContain("agenthub-worker/scripts/start-macos-worker.sh");
      expect(listing.stdout).toContain("agenthub-worker/workers/local-macos/agenthub_macos_worker/main.py");
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("applies a verified macOS archive through the shared updater", () => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), "agenthub-macos-update-"));
    const installRoot = path.join(outputRoot, "installed");
    try {
      const build = spawnSync(
        pythonCommand(),
        [path.join(repoRoot, "scripts", "build-worker-bundle.py"), "--output-root", outputRoot, "--version", "test-update"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);

      const update = spawnSync(
        pythonCommand(),
        [
          path.join(repoRoot, "scripts", "worker_self_update.py"),
          "--platform",
          "macos",
          "--repo-root",
          installRoot,
          "--force",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            AGENTHUB_WORKER_AUTO_UPDATE: "true",
            AGENTHUB_WORKER_UPDATE_SKIP_PIP: "true",
            AGENTHUB_WORKER_MANIFEST_URL: pathToFileURL(path.join(outputRoot, "worker-bundles-manifest.json")).toString(),
            AGENTHUB_WORKER_BUNDLE_URL: pathToFileURL(path.join(outputRoot, "agenthub-worker-macos.tar.gz")).toString(),
          },
        },
      );
      expect(update.status, update.stderr).toBe(0);
      expect(readFileSync(path.join(installRoot, ".runtime", "worker-bundle-version.txt"), "utf8").trim()).toBe(
        "test-update",
      );
      expect(readFileSync(path.join(installRoot, "workers", "local-macos", "agenthub_macos_worker", "main.py"), "utf8")).toContain(
        '"os": "macos"',
      );
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

describe("macOS LaunchAgent contract", () => {
  it("installs per user with stable paths and requires an explicit workspace root", () => {
    const installer = readRepoFile("scripts/install-macos-worker.sh");
    const starter = readRepoFile("scripts/start-macos-worker.sh");
    const uninstaller = readRepoFile("scripts/uninstall-macos-worker.sh");
    const workerMain = readRepoFile("workers/local-macos/agenthub_macos_worker/main.py");
    const cliRunner = readRepoFile("packages/worker-cli/src/lib/run-installer.mjs");

    expect(installer).toContain("Library/Application Support/AgentHub/workers");
    expect(installer).toContain("Library/LaunchAgents");
    expect(installer).toContain("Library/Logs/AgentHub");
    expect(installer).toContain("At least one --workspace-root is required");
    expect(installer).toContain("Invalid --launch-agent-label");
    expect(installer).toContain("launchctl bootstrap");
    expect(installer).not.toContain("/Library/LaunchDaemons");
    expect(starter).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(starter).toContain("worker_self_update.py");
    expect(uninstaller).toContain("launchctl bootout");
    expect(uninstaller).toContain("Invalid --launch-agent-label");
    expect(uninstaller).toContain("resolved_workers_root");
    expect(uninstaller).toContain("resolved_install_root");
    expect(uninstaller).toContain("Refusing to purge worker root outside");
    expect(workerMain).toContain('"os": "macos"');
    expect(workerMain).toContain("AGENTHUB_WORKSPACE_ROOTS");
    expect(cliRunner).toContain("install-macos-worker.sh");
  });

  it("uses uv venv correctly when Linux has no Python launcher", () => {
    const installer = readRepoFile("scripts/install-linux-worker.sh");

    expect(installer).toContain('uv venv "$venv_root" --python 3');
    expect(installer).not.toContain("printf 'uv python'");
  });

  it("runs plist rendering and macOS worker checks on a macOS CI runner", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("macos-worker:");
    expect(workflow).toContain("runs-on: macos-latest");
    expect(workflow).toContain("install-macos-worker.sh");
    expect(workflow).toContain("plutil -lint");
  });

  it("requires the macOS archive in deploy and self-host smoke gates", () => {
    for (const relativePath of ["scripts/deploy-linux.sh", "scripts/check-selfhost.sh", "scripts/check-selfhost.ps1"]) {
      expect(readRepoFile(relativePath), relativePath).toContain("agenthub-worker-macos.tar.gz");
    }
  });
});
