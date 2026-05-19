# Tailscale Private Mode

Tailscale Private Mode keeps AgentHub traffic inside your tailnet. Use it when the control plane and workers are personal, family, or internal team infrastructure.

The public relay path is easiest for general self-host users. Tailscale is safer when you can install Tailscale on every device that needs access.

## 1. Install Tailscale on the VM

On Ubuntu:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

Enable MagicDNS in the Tailscale admin console if you want a stable Tailscale DNS name. You can also use the VM's `100.x.y.z` Tailscale IP.

Useful URL shapes:

```text
https://agenthub.tailnet-name.ts.net
https://100.x.y.z
```

## 2. Install AgentHub on the VM

Install AgentHub normally with the self-host script, but use the Tailscale hostname as the public base URL if this deployment should stay private:

```bash
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.tailnet-name.ts.net \
  --public-base-url https://agenthub.tailnet-name.ts.net \
  --skip-certbot \
  --install-root /opt/agenthub
```

With `--skip-certbot`, the installer creates a temporary self-signed certificate so nginx can start. Replace it with Tailscale HTTPS, a private CA certificate, or a normal domain certificate before giving the URL to non-technical users.

For HTTPS inside the tailnet, use a certificate strategy that matches your tailnet setup:

- Tailscale HTTPS / Serve in front of the local AgentHub listener.
- A normal domain that resolves privately to the VM.
- A manually installed certificate path rendered into `deploy/nginx/agenthub-selfhost.conf.template`.

## 3. Private worker mode

In the AgentHub Web console, open **Add Worker** and choose `private`.

For Windows, the generated command should include:

```powershell
-ApiUrl 'https://agenthub.tailnet-name.ts.net' `
-ConnectionMode private
```

If writing the command manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleDir 'agenthub-worker\scripts\install-windows-worker.ps1') `
  -ApiUrl 'https://agenthub.tailnet-name.ts.net' `
  -EnrollmentToken 'replace-with-space-enrollment-token' `
  -WorkerId 'win-office-01' `
  -ConnectionMode private `
  -InstallRoot 'C:\ProgramData\AgentHub\workers\win-office-01' `
  -WorkspaceRoot 'C:/Work' `
  -StartAtBoot
```

For Linux, the generated command should include:

```bash
--api-url 'https://agenthub.tailnet-name.ts.net' \
--connection-mode private
```

## 4. Android and desktop clients

Install Tailscale on Android and sign in to the same tailnet.

Before opening AgentHub, verify the phone can reach:

```text
https://agenthub.tailnet-name.ts.net/healthz
```

On first launch, set the Android or Desktop server URL to the same Tailscale DNS URL. If Android cannot load it, check that Tailscale is connected and that the VM is visible in `tailscale status`.

## 5. Mixed public Web + private workers

You can expose the Web console publicly while keeping workers private:

- Public nginx listener exposes `/`, `/healthz`, and normal `/api/*`.
- Public listener blocks `/api/internal/`, `/api/workers/register`, and legacy heartbeat routes.
- Workers use the Tailscale URL and `ConnectionMode private`.
- Public relay workers use `/api/worker/*` only when you intentionally enable relay mode.

This shape is useful when your phone uses the public domain but local Windows/Linux workers stay on Tailscale.

## 6. Verification

From a Tailscale-connected device:

```bash
bash scripts/check-selfhost.sh \
  --base-url https://agenthub.tailnet-name.ts.net \
  --expect-worker-bundles \
  --insecure
```

The checker verifies `/healthz`, the Web console, and that `/api/internal/` rejects unauthenticated public-style calls.

Additional worker checks:

- worker heartbeat appears in the Web console
- session discovery updates session list
- `health_check` job completes
- a `session_input` job moves from queued to running quickly

For repeatable private-mode validation, use the manual GitHub Actions **Self-host Smoke** workflow with `mode=tailscale_private`. The runner or smoke VM must be able to reach the Tailscale URL. Full Tailscale HTTPS automation depends on your tailnet certificate/Serve setup, so the first smoke target is reachability, worker-token auth, and private worker enrollment.

## 7. When to choose each mode

Use `public_relay` when:

- the worker machine cannot join your tailnet
- you want the easiest setup for outside users
- outbound HTTPS polling is acceptable

Use `private` when:

- every device can join Tailscale
- you want a smaller public attack surface
- you are operating a personal/private deployment

Private mode still requires worker tokens and enrollment tokens. Tailscale is a network boundary, not a replacement for AgentHub authentication.
