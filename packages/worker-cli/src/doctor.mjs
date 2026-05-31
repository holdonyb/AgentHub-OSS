import { spawnSync } from "node:child_process";

import { normalizePlatform } from "./lib/platform.mjs";

function hasCommand(command) {
  const probe = process.platform === "win32" ? ["where", [command]] : ["which", [command]];
  const result = spawnSync(probe[0], probe[1], { stdio: "ignore" });
  return result.status === 0;
}

export function renderDoctor(options = {}) {
  const platform = normalizePlatform(options.platform);
  const lines = [
    `Platform: ${platform}`,
    `PowerShell: ${hasCommand("powershell.exe") ? "available" : "missing"}`,
    `bash: ${hasCommand("bash") ? "available" : "missing"}`,
    `python: ${hasCommand("python") ? "available" : "missing"}`,
    `py: ${hasCommand("py") ? "available" : "missing"}`,
    `uv: ${hasCommand("uv") ? "available" : "missing"}`,
  ];
  return `${lines.join("\n")}\n`;
}
