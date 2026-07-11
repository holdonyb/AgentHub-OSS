# macOS Worker

AgentHub supports macOS as an official worker platform. The worker runs in the current user's login session through a per-user LaunchAgent, so Codex, Claude, Kimi, and OpenCode can use that user's existing CLI login, files, and configuration.

This is worker support, not the macOS desktop client. You can control the worker from the AgentHub Web console or another supported client.

## Prerequisites

- a running AgentHub server and a worker enrollment token
- Node.js 20 or newer for the `npx` installer
- at least one explicit local workspace root
- a logged-in macOS user session for the LaunchAgent
- the agent CLIs you want to expose installed for the same user

Python 3 is used for the worker runtime. If Python is not available, the installer can create the virtual environment with `uv`.

## Install

Run this as the macOS user who owns the agent CLI sessions. Do not use `sudo`.

```bash
npx agenthub-worker@latest doctor --platform macos
npx agenthub-worker@latest install \
  --api-url https://agenthub.example.com \
  --enrollment-token ahe_worker_enroll_xxx \
  --platform macos \
  --worker-id macbook-pro-01 \
  --workspace-root "$HOME/Work"
```

Repeat `--workspace-root` when the worker may operate on more than one code root. The installer refuses to invent a default workspace root.

The npm wrapper first downloads `worker-bundles-manifest.json`, downloads `agenthub-worker-macos.tar.gz`, and verifies the archive's required SHA256 before extraction. It then copies the bundle out of the temporary download directory into a durable per-worker root.

## Installed Paths

```text
~/Library/Application Support/AgentHub/workers/<worker-id>
~/Library/LaunchAgents/dev.myagenthub.worker.<worker-id>.plist
~/Library/Logs/AgentHub/<worker-id>.stdout.log
~/Library/Logs/AgentHub/<worker-id>.stderr.log
```

The LaunchAgent PATH includes `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`, plus common user-local binary directories. Worker configuration and the cached worker token stay under the installed worker's `.runtime` directory. The environment file is mode `0600`.

## Inspect And Restart

```bash
label='dev.myagenthub.worker.macbook-pro-01'
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl print "gui/$(id -u)/$label"
tail -f "$HOME/Library/Logs/AgentHub/macbook-pro-01.stderr.log"

launchctl bootout "gui/$(id -u)" "$plist" || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
```

For a foreground diagnostic run:

```bash
worker_root="$HOME/Library/Application Support/AgentHub/workers/macbook-pro-01"
bash "$worker_root/scripts/start-macos-worker.sh" --repo-root "$worker_root" --once
```

The normal LaunchAgent start path checks the published manifest and applies a verified worker update before starting. Pass `--disable-auto-update` during install to opt out.

## Uninstall

Stop the LaunchAgent and keep configuration/token files for a later reinstall:

```bash
worker_root="$HOME/Library/Application Support/AgentHub/workers/macbook-pro-01"
bash "$worker_root/scripts/uninstall-macos-worker.sh" --worker-id macbook-pro-01
```

Add `--purge` to remove the default per-worker installation root as well. Logs under `~/Library/Logs/AgentHub` are retained for diagnostics.

## Limitations

- LaunchAgents run in a user login domain. A Mac with no logged-in user session needs a different operational model; do not convert this installer into a root LaunchDaemon because the agent CLI login and user configuration would no longer match.
- The repository can validate scripts, bundle contents, Python behavior, and manifest integrity on Windows/Linux CI. Actual `launchctl bootstrap`, macOS Python bootstrap, and CLI discovery require the macOS CI job or a real Mac smoke test.
