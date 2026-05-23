# AgentHub

AgentHub is a self-hosted control plane for managing Codex, Claude, Kimi, and other local agent sessions across your own machines.

It is for people who want:

- one inbox for local agent sessions
- phone and desktop access to the same sessions
- Tailscale-first private control without building a SaaS stack first
- the option to start on one laptop and move to a VM later

You do not need a VM for the first setup. AgentHub can run directly on your own Windows, macOS, or Linux machine, then expose itself through Tailscale to your phone and other devices.

Repository surface:

- FastAPI control plane in `apps/api`
- React + TypeScript console in `apps/web`
- Electron desktop client in `apps/desktop`
- Capacitor Android client in `apps/mobile`
- Shared protocol package in `packages/protocol`
- Windows and Linux worker entry points in `workers/`

The project is self-host first. Public SaaS relay, billing, and hosted multi-tenant operations are not part of the v0.1 release.

## v0.1 Release Surface

Officially supported in the first public release:

- Web self-host deployment
- Android APK client
- Windows desktop client
- Windows and Linux worker bundles

Not part of the current public support matrix:

- iOS
- macOS

If you want to add one of those platforms, see [CONTRIBUTING.md](CONTRIBUTING.md). The repo includes contribution prompts and platform guardrails so you can open a focused PR instead of starting from scratch.

## Quick Start

Fastest path if you just want to try it locally:

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run api:dev
npm run web:dev
```

Open `http://localhost:5173` and create the first owner with `AGENTHUB_BOOTSTRAP_TOKEN`.

If you want phone access without a VM, use [docs/LOCAL_SERVER_MODE.md](docs/LOCAL_SERVER_MODE.md) and point the client at your Tailscale URL.

## Start Here

- run on your own machine: [docs/LOCAL_SERVER_MODE.md](docs/LOCAL_SERVER_MODE.md)
- run on a public VM: [docs/SELF_HOST_QUICKSTART.md](docs/SELF_HOST_QUICKSTART.md)
- private tailnet deployment: [docs/TAILSCALE_PRIVATE_MODE.md](docs/TAILSCALE_PRIVATE_MODE.md)
- configure voice providers and limits: [docs/CONFIGURATION_REFERENCE.md](docs/CONFIGURATION_REFERENCE.md)
- prepare a release and launch: [docs/OPEN_SOURCE_LAUNCH.md](docs/OPEN_SOURCE_LAUNCH.md)

## Self-Host Paths

- Local server mode: [docs/LOCAL_SERVER_MODE.md](docs/LOCAL_SERVER_MODE.md)
- Self-Host Public Relay: [docs/SELF_HOST_QUICKSTART.md](docs/SELF_HOST_QUICKSTART.md)
- Tailscale Private Mode: [docs/TAILSCALE_PRIVATE_MODE.md](docs/TAILSCALE_PRIVATE_MODE.md)
- Configuration Reference: [docs/CONFIGURATION_REFERENCE.md](docs/CONFIGURATION_REFERENCE.md)
- AI deployment runbook: [docs/AI_DEPLOYMENT_RUNBOOK.md](docs/AI_DEPLOYMENT_RUNBOOK.md)
- Deployment brief template: [docs/DEPLOYMENT_BRIEF.example.json](docs/DEPLOYMENT_BRIEF.example.json)
- OSS export flow: [docs/OSS_RELEASE.md](docs/OSS_RELEASE.md)
- Open-source launch checklist: [docs/OPEN_SOURCE_LAUNCH.md](docs/OPEN_SOURCE_LAUNCH.md)

## Clients

Desktop and Android clients ask for your AgentHub server URL on first launch. For preconfigured builds, set:

```text
AGENTHUB_PUBLIC_BASE_URL=https://agenthub.example.com
AGENTHUB_DESKTOP_URL=https://agenthub.example.com
AGENTHUB_MOBILE_SERVER_URL=https://agenthub.example.com
```

Build commands:

```powershell
npm run web:build
npm run desktop:build
npm run mobile:build:debug
npm run mobile:build:release
```

`npm run desktop:package:win` prewarms the Electron Windows archive in small chunks and defaults Electron and `electron-builder` downloads to `npmmirror` on local machines. Override with `ELECTRON_MIRROR`, `ELECTRON_BUILDER_BINARIES_MIRROR`, `AGENTHUB_ELECTRON_MIRROR`, or `AGENTHUB_ELECTRON_BUILDER_BINARIES_MIRROR` if you need a different cache or relay.

Current release packaging:

- Android: separate APK artifact, even though the app is primarily a WebView shell
- Windows: separate desktop package artifact
- Web: self-host source and build output

iOS and macOS builds are not published today.

## Workers

Generate downloadable worker bundles:

```powershell
.\.venv\Scripts\python.exe scripts\build-worker-bundle.py --output-root .runtime\worker-bundles
```

Use an enrollment token from the Web console or API, then install the Windows or Linux bundle on the target machine.

## Verification

```powershell
npm run api:test
npm run web:test
npm run web:build
npm run desktop:test
npm run desktop:build
npm run mobile:test
npm run mobile:build:debug
```

Before exporting a public release, run:

```powershell
.\.venv\Scripts\python.exe scripts\audit-public-export.py
```

## Documentation

- [Deployment](docs/DEPLOYMENT.md)
- [Security](SECURITY.md)
- [Security model](docs/SECURITY.md)
- [Self-host quickstart](docs/SELF_HOST_QUICKSTART.md)
- [Tailscale private mode](docs/TAILSCALE_PRIVATE_MODE.md)
- [Configuration reference](docs/CONFIGURATION_REFERENCE.md)
- [AI deployment runbook](docs/AI_DEPLOYMENT_RUNBOOK.md)
- [Deployment brief template](docs/DEPLOYMENT_BRIEF.example.json)
- [Provenance](PROVENANCE.md)
- [Contributing](CONTRIBUTING.md)
