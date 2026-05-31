import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInstallPlan } from "../src/install.mjs";

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
