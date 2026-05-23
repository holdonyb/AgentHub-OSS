# Local Server Mode

AgentHub already supports running the server directly on your own machine. You do not need a VM for the first setup.

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
  ├─ FastAPI API
  ├─ built Web console
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
npm run web:build
npm run api:dev
```

Then open the Web console locally and point Android or Windows desktop at either:

- `http://localhost:5173` for local-only testing
- your Tailscale URL for remote access from phone or another machine

### macOS / Linux

```bash
cp .env.example .env
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r apps/api/requirements.txt
npm install
npm run web:build
npm run api:dev
```

## Tailscale-first setup

This is the simplest remote-control path when you do not have a VM.

1. Install Tailscale on the machine running AgentHub.
2. Install Tailscale on your Android phone or other client devices.
3. Confirm the server machine has a stable Tailscale name or IP.
4. Use that URL in AgentHub desktop or Android.

Typical examples:

```text
http://100.x.y.z:8019
https://agenthub.tailnet-name.ts.net
```

If you use HTTPS on the tailnet hostname, prefer that over raw IP.

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
