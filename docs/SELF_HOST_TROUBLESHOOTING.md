# Self-Host Troubleshooting

Use this checklist when a self-host AgentHub deployment does not reach worker-online and successful session input.

## nginx 502

Check the API service:

```bash
systemctl status agenthub-api.service
journalctl -u agenthub-api.service -n 120 --no-pager
curl -v http://127.0.0.1:8019/healthz
```

Common causes:

- `.venv` dependencies were not installed.
- `AGENTHUB_DATABASE_URL` points to a path the service cannot write.
- nginx upstream port does not match the API service port.
- `apps/web/dist` was not built before nginx started serving the site.

## HTTPS or cookie login loop

Production Web login requires secure cookies when served over HTTPS.

Check `/opt/agenthub/.env`:

```text
AGENTHUB_COOKIE_SECURE=true
AGENTHUB_PUBLIC_BASE_URL=https://agenthub.example.com
AGENTHUB_CORS_ORIGINS=["https://agenthub.example.com"]
```

If you are testing over plain HTTP, use local development mode instead of production cookies.

## CORS failure

Browser CORS errors usually mean the origin in `.env` does not match the URL in the address bar.

Fix:

```text
AGENTHUB_CORS_ORIGINS=["https://agenthub.example.com"]
```

Restart:

```bash
systemctl restart agenthub-api.service
```

## worker enroll returns 403

Expected: invalid or expired enrollment tokens return `403`.

If a real install gets `403`:

- Generate a fresh enrollment token in **Add Worker**.
- Confirm the command was copied completely.
- Confirm the worker uses the same server URL as the Web console.
- Confirm the worker mode matches the generated command: `public_relay` or `private`.
- Check API logs for `WORKER_ENROLLMENT_INVALID`.

## worker online but jobs stay queued

Check:

```bash
journalctl -u agenthub-linux-worker-linux-office-01.service -n 120 --no-pager
```

On Windows, check the installed worker `.runtime` logs under the worker install root.

Common causes:

- worker token file was not written after enrollment
- worker has no backend CLI on PATH
- workspace root does not exist on that machine
- session root points to the wrong Codex/Claude/Kimi store
- the worker is in `private` mode but cannot reach the Tailscale URL
- `AGENTHUB_WORKER_MAX_CONCURRENT_JOBS` is already saturated

## session input fails immediately

Open the job detail in the Web console and read the error text.

Common causes:

- Codex/Claude/Kimi CLI missing
- backend account not logged in
- sandbox/permission mode prevents the requested operation
- image attachment sent to a backend that does not support images
- worker process was restarted while the job was claimed

## Android cannot connect

Check:

- The server URL has no trailing path, for example `https://agenthub.example.com`.
- For Tailscale mode, Android Tailscale is connected before opening AgentHub.
- `https://agenthub.example.com/healthz` or the Tailscale URL loads in the Android browser.
- The installed APK was rebuilt with the expected server configuration or configured on first launch.

## Voice upload fails

Check nginx body size and timeout. The self-host template uses:

```nginx
location = /api/voice/transcribe {
    client_max_body_size 20m;
    proxy_read_timeout 240s;
    proxy_send_timeout 240s;
}
```

Also check the ASR environment variables if using Doubao speech recognition.

## Re-run smoke checks

From Linux/macOS:

```bash
bash scripts/check-selfhost.sh --base-url https://agenthub.example.com --expect-public-relay
```

From Windows:

```powershell
.\scripts\check-selfhost.ps1 -BaseUrl https://agenthub.example.com -ExpectPublicRelay
```
