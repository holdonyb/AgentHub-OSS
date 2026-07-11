import { spawnSync } from "node:child_process";

import { normalizePlatform } from "./lib/platform.mjs";

function hasCommand(command) {
  const probe = process.platform === "win32" ? ["where", [command]] : ["which", [command]];
  const result = spawnSync(probe[0], probe[1], { stdio: "ignore" });
  return result.status === 0;
}

export function inspectDoctor(options = {}, probe = hasCommand) {
  const platform = normalizePlatform(options.platform);
  if (platform === "macos") {
    const availability = Object.fromEntries(
      ["bash", "python3", "uv", "tar", "launchctl"].map((command) => [command, probe(command)]),
    );
    return {
      platform,
      ok: availability.bash && availability.tar && availability.launchctl && (availability.python3 || availability.uv),
      lines: [
        `Platform: ${platform}`,
        ...Object.entries(availability).map(([command, available]) => `${command}: ${available ? "available" : "missing"}`),
      ],
    };
  }
  const requirements = {
    windows: [
      ["PowerShell", ["powershell.exe"]],
      ["python|py|uv", ["python", "py", "uv"]],
    ],
    linux: [
      ["bash", ["bash"]],
      ["tar", ["tar"]],
      ["python3|python|uv", ["python3", "python", "uv"]],
    ],
  };
  const checks = requirements[platform].map(([label, commands]) => ({
    label,
    available: commands.some((command) => probe(command)),
  }));
  return {
    platform,
    ok: checks.every((check) => check.available),
    lines: [`Platform: ${platform}`, ...checks.map((check) => `${check.label}: ${check.available ? "available" : "missing"}`)],
  };
}

export function renderDoctor(options = {}, probe = hasCommand) {
  const report = inspectDoctor(options, probe);
  return `${report.lines.join("\n")}\n`;
}
