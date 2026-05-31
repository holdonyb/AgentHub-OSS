import { prepareBundle } from "./lib/bundle.mjs";
import { normalizePlatform } from "./lib/platform.mjs";
import { runInstaller } from "./lib/run-installer.mjs";

const MANIFEST_NAME = "worker-bundles-manifest.json";
const ARCHIVES = {
  windows: "agenthub-worker-windows.zip",
  linux: "agenthub-worker-linux.tar.gz",
};

export function buildInstallPlan(options) {
  const platform = normalizePlatform(options.platform);
  const apiUrl = (options.apiUrl || "").trim().replace(/\/+$/, "");
  const archiveName = ARCHIVES[platform];
  const manifestUrl = (options.workerManifestUrl || `${apiUrl}/downloads/workers/${MANIFEST_NAME}`).trim();
  const manifestBase = new URL("./", manifestUrl).toString();
  const bundleUrl = (options.workerBundleUrl || new URL(archiveName, manifestBase).toString()).trim();
  return { platform, manifestUrl, bundleUrl, archiveName };
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
      options,
    });
  } finally {
    await prepared.cleanup();
  }
  return plan;
}
