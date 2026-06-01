# Local Server Mode

AgentHub already supports running the server directly on your own machine. You do not need a VM for the first setup.

Docker is a separate install mode. Use this document when you want host-native Python + Node on the same machine. If you want containers instead, go to [DOCKER_SELFHOST_MODE.md](DOCKER_SELFHOST_MODE.md).

This is the recommended path when:

- you mainly want to control your own Codex, Claude, or Kimi sessions
- you already use Tailscale
- your phone and laptop are in the same tailnet
- you want the smallest setup surface before moving to a VM

Supported local server hosts:

- Windows
- macOS
- Linux

This document is about the server role. It is separate from the currently published first-party client matrix. The public release still ships Web, Android, Windows desktop, and Windows/Linux worker bundles.

## What local server mode looks like

```text
laptop or desktop
  ├─ FastAPI API on 43080
  ├─ Vite Web console on 43073
  ├─ optional local worker
  └─ Tailscale address

phone / tablet / another desktop
  └─ connect to the same Tailscale URL
```

You can start with one machine doing both:

- AgentHub server
- local worker
- Codex/Claude/Kimi session discovery

Later, you can add extra workers or move the server to a VM without changing the product model.

## Recommended path

### Windows

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run local:dev
```

Then open the Web console locally and point Android or Windows desktop at either:

- `http://localhost:43073` for local-only testing
- your Tailscale URL for remote access from phone or another machine

Android behavior:

- first launch opens a server setup screen
- paste the local or Tailscale URL there
- after saving, the app opens the login page for that server

### macOS / Linux

```bash
cp .env.example .env
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r apps/api/requirements.txt
npm install
npm run local:dev
```

For the first local smoke, use the local preset as the user-facing entrypoint:

- Web/UI entrypoint: `http://localhost:43073`
- backend/API entrypoint: `http://127.0.0.1:43080`

The API port is backend-only in this mode. Android, Windows desktop, and browser users should point at the Web entrypoint, not the raw API port.

## Tailscale-first setup

This is the simplest remote-control path when you do not have a VM.

1. Install Tailscale on the machine running AgentHub.
2. Install Tailscale on your Android phone or other client devices.
3. Confirm the server machine has a stable Tailscale name or IP.
4. Use that URL in AgentHub desktop or Android.

Typical examples:

```text
http://100.x.y.z:43073
https://agenthub.tailnet-name.ts.net
```

If you use HTTPS on the tailnet hostname, prefer that over raw IP. That HTTPS hostname assumes you are fronting the local API and Web console with your own reverse proxy; the bare `npm run local:dev` path exposes `43073` for the browser and `43080` for the backend.

On Android:

- public internet hosts should use `https://`
- `http://` is accepted only for localhost, LAN, and Tailscale-style private addresses

## When to move to a VM

Start local first. Move to a VM when:

- you want 24/7 availability
- you want multiple family members or teammates to use the same control plane
- your worker machine should stay separate from the server
- you want public relay for non-tailnet workers

At that point switch to:

- [SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md)
- [TAILSCALE_PRIVATE_MODE.md](TAILSCALE_PRIVATE_MODE.md)

## Voice configuration

Voice is optional in local server mode.

- no voice provider: AgentHub still works
- Doubao: supports upload and streaming auth
- OpenAI-compatible Whisper: supports upload transcription

See [CONFIGURATION_REFERENCE.md](CONFIGURATION_REFERENCE.md) for the exact environment variables.

## Validation checklist

After your local server starts:

1. Open `/healthz`
2. Create the owner account
3. Open AgentHub Android or Windows desktop
4. Enter the local or Tailscale URL
5. Register one worker
6. Confirm one session appears
7. Send one session input

If you want a scripted check:

```bash
bash scripts/check-selfhost.sh --base-url https://agenthub.example.com --expect-public-relay
```

Replace the URL with your own local reverse proxy or Tailscale hostname.

## Advanced: run the two processes manually

If you do not want the unified launcher, the equivalent manual commands are:

```powershell
npm run api:dev
npm run web:dev
```

In that shape, the defaults are still:

- Web/UI: `http://localhost:43073`
- API: `http://127.0.0.1:43080`
