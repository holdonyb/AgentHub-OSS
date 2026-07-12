import { spawn } from "node:child_process";
import path from "node:path";

function pushArg(args, key, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  args.push(key, value);
}

function pushRepeatable(args, key, values) {
  for (const value of values || []) {
    if (value) {
      args.push(key, value);
    }
  }
}

function run(command, args) {
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

export async function runInstaller({ bundleRoot, plan, options }) {
  if (plan.platform === "windows") {
    const scriptPath = path.join(bundleRoot, "scripts", "install-windows-worker.ps1");
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ApiUrl",
      options.apiUrl,
      "-EnrollmentToken",
      options.enrollmentToken,
      "-RepoRoot",
      bundleRoot,
    ];
    pushArg(args, "-WorkerId", options.workerId);
    pushArg(args, "-ConnectionMode", options.connectionMode);
    pushArg(args, "-InstallRoot", plan.installRoot);
    pushRepeatable(args, "-WorkspaceRoot", options.workspaceRoot);
    pushRepeatable(args, "-SessionRoot", options.sessionRoot);
    pushArg(args, "-WorkerBundleUrl", plan.bundleUrl);
    pushArg(args, "-WorkerManifestUrl", plan.manifestUrl);
    if (options.disableAutoUpdate) {
      args.push("-DisableAutoUpdate");
    }
    if (options.skipBootstrap) {
      args.push("-SkipBootstrap");
    }
    if (options.startAtBoot) {
      args.push("-StartAtBoot");
    }
    if (options.startAtLogOn) {
      args.push("-StartAtLogOn");
    }
    return run("powershell.exe", args);
  }

  if (plan.platform === "macos") {
    const scriptPath = path.join(bundleRoot, "scripts", "install-macos-worker.sh");
    const args = [
      scriptPath,
      "--api-url",
      options.apiUrl,
      "--enrollment-token",
      options.enrollmentToken,
      "--repo-root",
      bundleRoot,
      "--install-root",
      plan.installRoot,
      "--worker-manifest-url",
      plan.manifestUrl,
      "--worker-bundle-url",
      plan.bundleUrl,
    ];
    pushArg(args, "--worker-id", options.workerId);
    pushArg(args, "--connection-mode", options.connectionMode);
    pushArg(args, "--launch-agent-label", options.serviceName);
    pushRepeatable(args, "--workspace-root", options.workspaceRoot);
    pushRepeatable(args, "--session-root", options.sessionRoot);
    if (options.disableAutoUpdate) {
      args.push("--disable-auto-update");
    }
    if (options.skipBootstrap) {
      args.push("--skip-bootstrap");
    }
    return run("bash", args);
  }

  const scriptPath = path.join(bundleRoot, "scripts", "install-linux-worker.sh");
  const args = [
    scriptPath,
    "--api-url",
    options.apiUrl,
    "--enrollment-token",
    options.enrollmentToken,
    "--repo-root",
    bundleRoot,
    "--worker-manifest-url",
    plan.manifestUrl,
    "--worker-bundle-url",
    plan.bundleUrl,
  ];
  pushArg(args, "--worker-id", options.workerId);
  pushArg(args, "--connection-mode", options.connectionMode);
  pushArg(args, "--install-root", plan.installRoot);
  pushArg(args, "--service-name", options.serviceName);
  pushRepeatable(args, "--workspace-root", options.workspaceRoot);
  pushRepeatable(args, "--session-root", options.sessionRoot);
  if (options.disableAutoUpdate) {
    args.push("--disable-auto-update");
  }
  if (options.skipBootstrap) {
    args.push("--skip-bootstrap");
  }
  return run("bash", args);
}
