import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

export async function prepareBundle({ bundleUrl, archiveName, platform }) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "agenthub-worker-cli-"));
  try {
    const response = await fetch(bundleUrl);
    if (!response.ok) {
      throw new Error(`Failed to download worker bundle: ${response.status} ${response.statusText}`);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    const archivePath = path.join(tempRoot, archiveName);
    const extractRoot = path.join(tempRoot, "extract");
    await writeFile(archivePath, payload);
    await extractArchive(archivePath, extractRoot, platform);

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
