import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function extractArchive(archivePath, extractRoot, platform) {
  if (platform === "windows") {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractRoot.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }

  await runCommand("tar", ["-xzf", archivePath, "-C", extractRoot]);
}

export function verifyBundlePayload(payload, manifest, { archiveName, platform }) {
  const bundle = Array.isArray(manifest?.bundles)
    ? manifest.bundles.find((item) => item?.platform === platform)
    : undefined;
  if (!bundle) {
    throw new Error(`Worker manifest does not contain a ${platform} bundle`);
  }
  if (bundle.archive !== archiveName) {
    throw new Error(`Worker manifest archive mismatch: expected ${archiveName}, got ${bundle.archive || "<missing>"}`);
  }
  const expectedSha = String(bundle.sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error(`Worker manifest is missing a valid sha256 for ${platform}`);
  }
  const actualSha = createHash("sha256").update(payload).digest("hex");
  if (actualSha !== expectedSha) {
    throw new Error(`Worker bundle sha256 mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  return bundle;
}

export async function prepareBundle(
  { bundleUrl, manifestUrl, archiveName, platform },
  dependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const extract = dependencies.extractArchive || extractArchive;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "agenthub-worker-cli-"));
  try {
    const manifestResponse = await fetchImpl(manifestUrl);
    if (!manifestResponse.ok) {
      throw new Error(`Failed to download worker manifest: ${manifestResponse.status} ${manifestResponse.statusText || ""}`.trim());
    }
    let manifest;
    try {
      manifest = await manifestResponse.json();
    } catch (error) {
      throw new Error(`Failed to parse worker manifest: ${error.message}`);
    }

    const response = await fetchImpl(bundleUrl);
    if (!response.ok) {
      throw new Error(`Failed to download worker bundle: ${response.status} ${response.statusText}`);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    verifyBundlePayload(payload, manifest, { archiveName, platform });
    const archivePath = path.join(tempRoot, archiveName);
    const extractRoot = path.join(tempRoot, "extract");
    await writeFile(archivePath, payload);
    await mkdir(extractRoot, { recursive: true });
    await extract(archivePath, extractRoot, platform);

    const bundleRoot = path.join(extractRoot, "agenthub-worker");
    return {
      tempRoot,
      bundleRoot,
      cleanup: async () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
