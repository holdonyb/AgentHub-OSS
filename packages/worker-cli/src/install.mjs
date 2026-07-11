import { homedir, hostname } from "node:os";
import path from "node:path";

import { prepareBundle } from "./lib/bundle.mjs";
import { normalizePlatform } from "./lib/platform.mjs";
import { runInstaller } from "./lib/run-installer.mjs";

const MANIFEST_NAME = "worker-bundles-manifest.json";
const ARCHIVES = {
  windows: "agenthub-worker-windows.zip",
  linux: "agenthub-worker-linux.tar.gz",
  macos: "agenthub-worker-macos.tar.gz",
};

function safeWorkerId(value) {
  const normalized = (value || hostname()).trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return !normalized || normalized === "." || normalized === ".." ? "worker" : normalized;
}

export function defaultInstallRoot(platform, workerId, environment = {}) {
  const homeDir = environment.homeDir || homedir();
  const id = safeWorkerId(workerId);
  if (platform === "windows") {
    const localAppData = environment.localAppData || process.env.LOCALAPPDATA || path.win32.join(homeDir, "AppData", "Local");
    return path.win32.join(localAppData, "AgentHub", "workers", id);
  }
  if (platform === "macos") {
    return path.posix.join(homeDir, "Library", "Application Support", "AgentHub", "workers", id);
  }
  return path.posix.join(homeDir, ".local", "share", "AgentHub", "workers", id);
}

export function buildInstallPlan(options) {
  const platform = normalizePlatform(options.platform);
  const apiUrl = (options.apiUrl || "").trim().replace(/\/+$/, "");
  const archiveName = ARCHIVES[platform];
  const manifestUrl = (options.workerManifestUrl || `${apiUrl}/downloads/workers/${MANIFEST_NAME}`).trim();
  const manifestBase = new URL("./", manifestUrl).toString();
  const bundleUrl = (options.workerBundleUrl || new URL(archiveName, manifestBase).toString()).trim();
  const installRoot = (options.installRoot || defaultInstallRoot(platform, options.workerId)).trim();
  return { platform, manifestUrl, bundleUrl, archiveName, installRoot };
}

export async function installWorker(options) {
  if (!options.apiUrl) {
    throw new Error("--api-url is required");
  }
  if (!options.enrollmentToken) {
    throw new Error("--enrollment-token is required");
  }

  const plan = buildInstallPlan(options);
  const prepared = await prepareBundle(plan);
  try {
    await runInstaller({
      bundleRoot: prepared.bundleRoot,
      plan,
      options: { ...options, installRoot: plan.installRoot },
    });
  } finally {
    await prepared.cleanup();
  }
  return plan;
}
