#!/usr/bin/env node
import { parseCliArgs } from "./lib/args.mjs";
import { installWorker } from "./install.mjs";
import { renderDoctor } from "./doctor.mjs";

function renderHelp() {
  return `Usage:
  agenthub-worker install --api-url URL --enrollment-token TOKEN [options]
  agenthub-worker doctor [--platform windows|linux|macos]

Options:
  --worker-id VALUE
  --connection-mode private|public_relay
  --install-root PATH
  --workspace-root PATH
  --session-root PATH
  --worker-manifest-url URL
  --worker-bundle-url URL
  --disable-auto-update
  --skip-bootstrap
  --start-at-boot
  --start-at-logon
  --service-name VALUE
  --launch-agent-label VALUE
  --platform windows|linux|macos
`;
}

async function main(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.options.help || parsed.command === "help") {
    process.stdout.write(renderHelp());
    return 0;
  }

  if (parsed.command === "doctor") {
    process.stdout.write(renderDoctor(parsed.options));
    return 0;
  }

  if (parsed.command === "install") {
    await installWorker(parsed.options);
    return 0;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
