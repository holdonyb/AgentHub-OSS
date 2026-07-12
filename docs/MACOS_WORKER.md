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

Repeat `--workspace-root` when the worker may operate on more than one code root. Workspace and optional session roots must already exist and must be absolute paths; the installer stores their physical resolved paths. The installer refuses to invent a default workspace root.

The npm wrapper first downloads `worker-bundles-manifest.json`, downloads `agenthub-worker-macos.tar.gz`, and verifies the archive's required SHA256 before extraction. It then copies the bundle out of the temporary download directory into a durable per-worker root.

## Installed Paths

```text
~/Library/Application Support/AgentHub/workers/<worker-id>
~/Library/LaunchAgents/dev.myagenthub.worker.<worker-id>.plist
~/Library/Logs/AgentHub/<worker-id>.stdout.log
~/Library/Logs/AgentHub/<worker-id>.stderr.log
```

The LaunchAgent PATH includes `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`, plus common user-local binary directories. Worker configuration and the cached worker token stay under the installed worker's `.runtime` directory. The environment file and token cache are written atomically with mode `0600`. The one-time enrollment token is passed only to the bootstrap process and is not retained in the environment file.

## Inspect And Restart

```bash
label='dev.myagenthub.worker.macbook-pro-01'
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl print "gui/$(id -u)/$label"
tail -f "$HOME/Library/Logs/AgentHub/macbook-pro-01.stderr.log"

if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$label"
fi
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
```

For a foreground diagnostic run:

```bash
label='dev.myagenthub.worker.macbook-pro-01'
plist="$HOME/Library/LaunchAgents/$label.plist"
worker_root="$HOME/Library/Application Support/AgentHub/workers/macbook-pro-01"

# Stop the managed instance first. The start script also holds a single-instance lock.
if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$label"
fi
bash "$worker_root/scripts/start-macos-worker.sh" --repo-root "$worker_root" --once
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
```

The normal LaunchAgent start path checks the published manifest, prepares the verified bundle and dependencies in staging, then switches the published paths with rollback protection. If preparation or switching fails, the start script refuses to run a potentially mixed version. Pass `--disable-auto-update` during install to opt out.

## Uninstall

Stop the LaunchAgent and keep configuration/token files for a later reinstall:

```bash
worker_root="$HOME/Library/Application Support/AgentHub/workers/macbook-pro-01"
bash "$worker_root/scripts/uninstall-macos-worker.sh" --worker-id macbook-pro-01
```

Add `--purge` to remove the default per-worker installation root as well. Logs under `~/Library/Logs/AgentHub` are retained for diagnostics.

## Limitations

- LaunchAgents run in a user login domain. A Mac with no logged-in user session needs a different operational model; do not convert this installer into a root LaunchDaemon because the agent CLI login and user configuration would no longer match.
- The repository validates scripts, bundle contents, Python behavior, plist rendering, and manifest integrity in macOS CI. Actual user-session `launchctl bootstrap`, installed CLI discovery, and long-running sleep/wake behavior still require a real Mac smoke test.
