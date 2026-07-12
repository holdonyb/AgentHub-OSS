function pushValueOption(target, key, value) {
  if (value === undefined) {
    throw new Error(`Missing value for --${key}`);
  }
  if (Array.isArray(target[key])) {
    target[key].push(value);
    return;
  }
  target[key] = value;
}

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const args = {
    command: command || "help",
    options: {
      workspaceRoot: [],
      sessionRoot: [],
    },
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") {
      args.options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }

    const key = token.slice(2);
    switch (key) {
      case "api-url":
        pushValueOption(args.options, "apiUrl", rest[++index]);
        break;
      case "enrollment-token":
        pushValueOption(args.options, "enrollmentToken", rest[++index]);
        break;
      case "worker-id":
        pushValueOption(args.options, "workerId", rest[++index]);
        break;
      case "connection-mode":
        pushValueOption(args.options, "connectionMode", rest[++index]);
        break;
      case "install-root":
        pushValueOption(args.options, "installRoot", rest[++index]);
        break;
      case "workspace-root":
        pushValueOption(args.options, "workspaceRoot", rest[++index]);
        break;
      case "session-root":
        pushValueOption(args.options, "sessionRoot", rest[++index]);
        break;
      case "worker-manifest-url":
        pushValueOption(args.options, "workerManifestUrl", rest[++index]);
        break;
      case "worker-bundle-url":
        pushValueOption(args.options, "workerBundleUrl", rest[++index]);
        break;
      case "service-name":
        pushValueOption(args.options, "serviceName", rest[++index]);
        break;
      case "launch-agent-label":
        pushValueOption(args.options, "serviceName", rest[++index]);
        break;
      case "platform":
        pushValueOption(args.options, "platform", rest[++index]);
        break;
      case "skip-bootstrap":
        args.options.skipBootstrap = true;
        break;
      case "disable-auto-update":
        args.options.disableAutoUpdate = true;
        break;
      case "start-at-boot":
        args.options.startAtBoot = true;
        break;
      case "start-at-logon":
        args.options.startAtLogOn = true;
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }

  return args;
}
