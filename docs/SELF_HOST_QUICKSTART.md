# Self-Host Quickstart

This guide takes a fresh Ubuntu VM to a usable AgentHub control plane with HTTPS, Web console, downloadable worker bundles, and public relay worker enrollment.

Use this path when the worker machines can reach your AgentHub server over outbound HTTPS. Workers do not need inbound ports.

## 1. Prepare the VM

Requirements:

- Ubuntu 22.04 or Ubuntu 24.04.
- A DNS A record such as `agenthub.example.com` pointing to the VM public IP.
- Inbound TCP `80` and `443` open in the cloud firewall.
- Root or sudo access.
- At least 2 GB RAM for build-time dependency installation.

Check DNS from your workstation:

```bash
dig +short agenthub.example.com
curl -I http://agenthub.example.com
```

## 2. Install AgentHub

Clone the repo on the VM, then run the installer:

```bash
sudo apt-get update
sudo apt-get install -y git curl
git clone https://github.com/YOUR_ORG/AgentHub.git /tmp/agenthub-src
cd /tmp/agenthub-src
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --admin-email you@example.com \
  --install-root /opt/agenthub
```

The script installs Python, Node.js 20, nginx, certbot, creates `/opt/agenthub/.env`, builds the Web console, builds worker bundles, creates `agenthub-api.service`, requests a Let's Encrypt certificate, and renders nginx.

If DNS is not ready yet, render everything with a temporary self-signed certificate:

```bash
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --skip-certbot \
  --install-root /opt/agenthub
```

After DNS is fixed, run the installer again with `--admin-email` to request a Let's Encrypt certificate.

## 3. Create the owner

Read the bootstrap token on the VM:

```bash
sudo grep AGENTHUB_BOOTSTRAP_TOKEN /opt/agenthub/.env
```

Open:

```text
https://agenthub.example.com
```

Create the first owner with `AGENTHUB_BOOTSTRAP_TOKEN`. After the owner exists, the bootstrap token is no longer accepted.

## 4. Verify the server

From your workstation:

```bash
bash scripts/check-selfhost.sh \
  --base-url https://agenthub.example.com \
  --expect-public-relay \
  --expect-worker-bundles
```

From Windows PowerShell:

```powershell
.\scripts\check-selfhost.ps1 -BaseUrl https://agenthub.example.com -ExpectPublicRelay -ExpectWorkerBundles
```

Expected checks:

- `/healthz` returns `200`.
- `/` returns `200`.
- `/api/internal/jobs/claim` rejects public unauthenticated calls with `401` or `403`.
- `/api/worker/enroll` rejects invalid enrollment with `403`.
- `/downloads/workers/worker-bundles-manifest.json` and both worker archives return `200`.

For a repeatable real-VM check, use the GitHub Actions **Self-host Smoke** workflow. It is manual only and requires `confirm=SELFHOST_SMOKE_OK`, a dedicated smoke VM/domain, and SSH secrets. The workflow runs `scripts/smoke-selfhost-vm.sh`, installs the selected branch, checks nginx/systemd/HTTPS, verifies worker bundles, and can optionally run `scripts/smoke-worker-onboarding.sh` when `AGENTHUB_SMOKE_ADMIN_TOKEN` is configured.

## 5. Add Worker

In the Web console, open **Add Worker**.

Choose:

- OS: Windows or Linux.
- Connection mode: `public_relay`.
- Workspace roots: real code roots such as `C:/Work`, `E:/Work`, or `/srv/work`.
- Session roots: optional Codex/Claude/Kimi session stores if they are outside default locations.

AgentHub generates a one-time enrollment token and a copyable install command. The command downloads one of:

```text
agenthub-worker-windows.zip
agenthub-worker-linux.tar.gz
```

The worker caches the real worker token locally under `.runtime` after enrollment. The enrollment token is short-lived and should not be reused.

## 6. Windows worker smoke

Run the generated PowerShell command on the Windows machine. It should install a worker under `C:\ProgramData\AgentHub\workers\<worker-id>` and register a scheduled task when `-StartAtBoot` or `-StartAtLogOn` is used.

Verify in the Web console:

- worker status becomes online
- reachable backends include installed CLIs
- discovered sessions appear
- sending a short prompt creates a job, changes to running, and completes or asks for approval

## 7. Linux worker smoke

Run the generated Linux command on the worker VM. It should create a systemd service named like `agenthub-linux-worker-<worker-id>.service`.

Check:

```bash
systemctl status agenthub-linux-worker-linux-office-01.service
journalctl -u agenthub-linux-worker-linux-office-01.service -n 100 --no-pager
```

## 8. Client login

Desktop and Android clients ask for the AgentHub server URL on first launch. Use:

```text
https://agenthub.example.com
```

Then log in with the owner or invited user account.

## 9. Update and redeploy

For a normal update:

```bash
cd /opt/agenthub
git fetch origin main
git merge --ff-only origin/main
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --admin-email you@example.com \
  --install-root /opt/agenthub \
  --skip-packages
```

Installed workers auto-update from `/downloads/workers/worker-bundles-manifest.json` unless disabled during worker install.

## Security notes

- Keep `/opt/agenthub/.env` private.
- Keep `AGENTHUB_SECRET_ENCRYPTION_KEY` stable across restarts and redeploys.
- Do not expose SSH, database ports, raw Uvicorn, or worker-local services publicly.
- The public nginx template blocks `/api/internal/` and legacy worker registration on the public listener.
