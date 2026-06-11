# Deployment

AgentHub supports two worker connection shapes:

- private mode: Tailscale or other private network, preserving `/api/internal/*` and `/api/workers/*`
- public relay mode: outbound HTTPS worker traffic through `/api/worker/*`

Private mode remains the default for personal deployments. Public relay mode exists for multi-tenant and non-Tailscale worker onboarding.
Worker enrollment tokens are now the preferred bootstrap path for both modes. The legacy VM-wide `AGENTHUB_WORKER_REGISTRATION_TOKEN` stays available for compatibility, but new installs should use per-space enrollment.

For a fresh VM install, start with [SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md). For a containerized single-host install, use [DOCKER_SELFHOST_MODE.md](DOCKER_SELFHOST_MODE.md). For private-network deployments, use [TAILSCALE_PRIVATE_MODE.md](TAILSCALE_PRIVATE_MODE.md). For running AgentHub directly on your own Windows, macOS, or Linux machine, use [LOCAL_SERVER_MODE.md](LOCAL_SERVER_MODE.md). For common failures, use [SELF_HOST_TROUBLESHOOTING.md](SELF_HOST_TROUBLESHOOTING.md).

## Local Dev

```powershell
cd E:/work/AgentHub
copy .env.example .env
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
npm install
npm run api:dev
npm run web:dev
```

Set a stable `AGENTHUB_SECRET_ENCRYPTION_KEY` before using API secrets. Generate it once and keep it in `.env` or your service environment:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

## Windows Desktop Client

AgentHub also ships an Electron desktop client in `apps/desktop`.

```powershell
cd E:/work/AgentHub
npm install
npm run desktop:build
npm run desktop:start
```

The desktop client opens:

- a full AgentHub console window
- a separate always-on-top AgentHub Island window from the tray

Default console URL is `https://agenthub.example.com`. Override it when needed:

```powershell
$env:AGENTHUB_DESKTOP_URL="http://100.99.254.119:8019"
npm run desktop:start
```

## Android APK Build

```powershell
npm run web:build
npm run mobile:build:debug
npm run mobile:build:release
```

The local build script auto-detects JDKs. On this workstation it prefers Android Studio JBR 21 at:

```text
E:/Program Files/Android/Android Studio/jbr
```

APK output:

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Use the same upload key for every APK that users install. Set these variables locally or in GitHub Actions:

```text
AGENTHUB_ANDROID_KEYSTORE_FILE
AGENTHUB_ANDROID_KEYSTORE_PASSWORD
AGENTHUB_ANDROID_KEY_ALIAS
AGENTHUB_ANDROID_KEY_PASSWORD
```

For GitHub Actions, store the binary keystore as base64 in `AGENTHUB_ANDROID_KEYSTORE_BASE64`. The workflow decodes it on the runner and signs both debug and release APKs with the same key. Do not commit `.jks`, `.keystore`, or password files.

Useful local commands:

```powershell
# Create a one-time upload key. Keep this file private and backed up.
keytool -genkeypair -v -keystore .runtime/agenthub-upload-key.jks -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias agenthub

$env:AGENTHUB_ANDROID_KEYSTORE_FILE="E:/Work/AgentHub/.runtime/agenthub-upload-key.jks"
$env:AGENTHUB_ANDROID_KEYSTORE_PASSWORD="replace-me"
$env:AGENTHUB_ANDROID_KEY_ALIAS="agenthub"
$env:AGENTHUB_ANDROID_KEY_PASSWORD="replace-me"
npm run mobile:build:debug
```

## Public Release Build Path

The public repo treats deployment as a source-based self-host workflow, not as a hard-coded production VM pipeline.

Recommended paths:

- local machine as the server: [LOCAL_SERVER_MODE.md](LOCAL_SERVER_MODE.md)
- Docker self-host: [DOCKER_SELFHOST_MODE.md](DOCKER_SELFHOST_MODE.md)
- public VM with HTTPS: [SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md)
- private tailnet deployment: [TAILSCALE_PRIVATE_MODE.md](TAILSCALE_PRIVATE_MODE.md)

For repeatable public release assets, use:

```powershell
npm ci
.\.venv\Scripts\python.exe scripts\audit-public-export.py
npm run web:build
npm run mobile:build:release
npm run desktop:package:win
.\.venv\Scripts\python.exe scripts\build-worker-bundle.py --output-root dist/release/workers
```

Keep `AGENTHUB_SECRET_ENCRYPTION_KEY` stable across restarts and redeploys. Rotating it without a migration makes previously stored secret values unreadable.

## VM Traffic Monitoring

If you want a cheap, always-on view of how much bandwidth AgentHub is actually burning on the VM, install `vnstat` on the host and keep the query path out of the UI:

```powershell
.\scripts\install-vm-traffic-monitor.ps1
.\scripts\report-vm-traffic.ps1
```

The report returns JSON with:

- `today`
- `yesterday`
- `last_24_hours`
- `current_month`
- `lifetime_total_bytes`

Linux-only equivalents:

```bash
sudo bash scripts/install-vm-traffic-monitor.sh
bash scripts/report-vm-traffic.sh
```

This is intentionally VM-level network accounting, not an in-app estimate. It catches Web, Android background sync, worker polling, release downloads, and any accidental full-refresh regressions on the public relay.

## Tailscale-First Topology

```text
phone/browser -- Tailscale URL -- reverse proxy -- FastAPI
Windows worker -- Tailscale URL -- FastAPI internal worker APIs
Linux worker -- Tailscale URL -- FastAPI internal worker APIs
```

Recommended API URL examples:

```text
https://agenthub.tailnet-name.ts.net
https://agenthub.internal.example
```

Workers should use the same private URL through `AGENTHUB_API_URL`.

Public relay workers should instead point `AGENTHUB_API_URL` at the public HTTPS entry and set:

```powershell
$env:AGENTHUB_CONNECTION_MODE="public_relay"
$env:AGENTHUB_ENROLLMENT_TOKEN="replace-with-space-enrollment-token"
```

## frpc Public Web/API Entry

Allowed:

- `https://agenthub.example.com/`
- `https://agenthub.example.com/api/*`
- `https://agenthub.example.com/healthz`

Not allowed on the public entry:

- database ports
- SSH/RDP
- worker-local services
- raw Uvicorn HTTP
- legacy worker internal APIs and legacy worker registration/heartbeat on the public HTTPS entry

Example frpc mapping:

```text
deploy/frpc/agenthub-public.toml.example
```

Reverse proxy requirements:

Use the checked-in template:

```text
deploy/nginx/agenthub-public.conf.template
```

Production should serve the built Web assets from `apps/web/dist` and proxy `/api` to FastAPI.

If a local reverse proxy port is needed for frpc or a private tunnel, bind it to loopback first:

```text
deploy/nginx/agenthub-loopback.conf.template
```

Open legacy worker registration, heartbeat, and `/api/internal/*` only on a Tailscale/private listener after Tailscale is installed and source-restricted.
Public relay deployments should expose only `/api/worker/*` on the public reverse proxy.

## Linux systemd API Service

Use:

```text
deploy/systemd/agenthub-api.service.template
```

## Linux Worker Service

Use:

```text
deploy/systemd/agenthub-linux-worker.service.template
```

## Windows Worker Startup

Use the downloadable worker bundle instead of cloning the full repo. The installer performs a one-shot bootstrap, caches the worker token under `.runtime`, and registers a scheduled task that can start at boot.

```powershell
$workerRoot = 'C:\ProgramData\AgentHub\workers\win-office-01'
$bundleUrl = 'https://agenthub.example.com/downloads/workers/agenthub-worker-windows.zip'
$bundleZip = Join-Path $env:TEMP 'agenthub-worker-win-office-01.zip'
$bundleDir = Join-Path $env:TEMP 'agenthub-worker-win-office-01'
Invoke-WebRequest -Uri $bundleUrl -OutFile $bundleZip
Expand-Archive -LiteralPath $bundleZip -DestinationPath $bundleDir -Force
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleDir 'agenthub-worker\scripts\install-windows-worker.ps1') `
  -ApiUrl 'https://agenthub.example.com' `
  -EnrollmentToken 'replace-with-space-enrollment-token' `
  -WorkerId 'win-office-01' `
  -ConnectionMode private `
  -InstallRoot $workerRoot `
  -WorkspaceRoot 'C:/Work' `
  -StartAtBoot
```

The installer writes `.runtime/windows-worker.env.ps1` and a cached worker token path such as `.runtime/win-office-01.worker-token` inside the installed worker root. You can still edit the env file directly when needed:

```powershell
$env:AGENTHUB_API_URL="https://agenthub.tailnet-name.ts.net"
$env:AGENTHUB_CONNECTION_MODE="private"
$env:AGENTHUB_WORKER_ID="win-main"
$env:AGENTHUB_ENROLLMENT_TOKEN="replace-with-space-enrollment-token"
$env:AGENTHUB_WORKER_TOKEN_PATH="E:\work\AgentHub\.runtime\win-main.worker-token"
$env:AGENTHUB_WORKER_MAX_CONCURRENT_JOBS="2"
$env:AGENTHUB_WORKER_JOB_POLL_SECONDS="5"
$env:AGENTHUB_WORKER_HEARTBEAT_SECONDS="30"
```

Optional:

```powershell
$env:AGENTHUB_SESSION_ROOTS="C:\Users\you\.codex\sessions;C:\Users\you\.claude\projects"
```

`AGENTHUB_WORKSPACE_ROOTS` is now reserved for actual code roots. Session discovery uses `AGENTHUB_SESSION_ROOTS` plus the default `.codex/.claude/.kimi` locations, so session stores no longer need to be mixed into workspace roots.

Installed Windows workers auto-update on worker loop startup. The loop runs `scripts/update-windows-worker.ps1`, which reads `/downloads/workers/worker-bundles-manifest.json`, validates the published bundle sha256, copies only the manifest-listed worker files into the install root, installs `workers/requirements.txt`, and then starts the worker process. The updater writes `.runtime/worker-bundle-version.txt` and logs to `.runtime/agenthub-windows-worker-update.log`.

To disable auto-update for a specific worker, pass `-DisableAutoUpdate` during install or set this in `.runtime/windows-worker.env.ps1`:

```powershell
$env:AGENTHUB_WORKER_AUTO_UPDATE="false"
```

If you prefer login-only startup on a personal desktop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleDir 'agenthub-worker\scripts\install-windows-worker.ps1') `
  -ApiUrl 'https://agenthub.example.com' `
  -EnrollmentToken 'replace-with-space-enrollment-token' `
  -WorkerId 'win-office-01' `
  -ConnectionMode private `
  -InstallRoot $workerRoot `
  -WorkspaceRoot 'C:/Work' `
  -StartAtLogOn
```

`-StartAtBoot` is the recommended default when the machine should stay reachable without an interactive logon.

## Linux Worker Startup

Linux workers use the matching bundle and installer:

```bash
worker_root='/opt/agenthub-worker/linux-office-01'
bundle_url='https://agenthub.example.com/downloads/workers/agenthub-worker-linux.tar.gz'
bundle_tar='/tmp/agenthub-worker-linux-office-01.tar.gz'
bundle_dir="$(mktemp -d /tmp/agenthub-worker-XXXXXX)"
curl -fsSL "$bundle_url" -o "$bundle_tar"
tar -xzf "$bundle_tar" -C "$bundle_dir"
sudo bash "$bundle_dir/agenthub-worker/scripts/install-linux-worker.sh" \
  --api-url 'https://agenthub.example.com' \
  --enrollment-token 'replace-with-space-enrollment-token' \
  --worker-id 'linux-office-01' \
  --connection-mode public_relay \
  --install-root "$worker_root" \
  --service-name 'agenthub-linux-worker-linux-office-01.service' \
  --workspace-root '/srv/work'
rm -rf "$bundle_dir" "$bundle_tar"
```

The Linux installer writes `.runtime/linux-worker.env`, caches the worker token, renders a systemd unit, and enables it immediately unless `--skip-systemd` is passed.

Installed Linux workers auto-update through the generated systemd unit's `ExecStartPre`. It runs `scripts/update-linux-worker.sh`, which uses the same manifest, sha256 validation, and version file behavior as Windows. Logs are written to `.runtime/agenthub-linux-worker-update.log`. Disable it with `--disable-auto-update` during install or set `AGENTHUB_WORKER_AUTO_UPDATE=false` in `.runtime/linux-worker.env`.

Session input jobs default to `AGENTHUB_DEFAULT_SESSION_JOB_TIMEOUT_SECONDS=3600`.
The API writes that timeout into each queued session job so stale-job recovery does not requeue a still-running Codex/Claude/Kimi turn too early.

## Verification

```powershell
curl https://agenthub.example.com/healthz
curl -I https://agenthub.example.com/
```

Worker internal API should reject public unauthenticated calls:

```powershell
curl -X POST https://agenthub.example.com/api/internal/jobs/claim -d "{}" -H "Content-Type: application/json"
```

Expected: `401` or `403`.

Public relay verification:

```powershell
curl -X POST https://agenthub.example.com/api/worker/enroll -H "Content-Type: application/json" -d "{}"
curl -X POST https://agenthub.example.com/api/worker/jobs/claim -H "Authorization: Bearer <worker-token>" -H "Content-Type: application/json" -d "{}"
```

Expected:

- enroll without a valid enrollment token returns `403`
- relay claim without a valid worker token returns `401` or `403`
