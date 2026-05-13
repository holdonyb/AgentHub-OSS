# AgentHub

AgentHub is a self-hosted control plane for managing Codex, Claude, Kimi, and other local agent sessions across Windows and Linux workers.

It provides:

- FastAPI control plane in `apps/api`
- React + TypeScript console in `apps/web`
- Electron desktop client in `apps/desktop`
- Capacitor Android client in `apps/mobile`
- Shared protocol package in `packages/protocol`
- Windows and Linux worker entry points in `workers/`

The project is self-host first. Public SaaS relay, billing, and hosted multi-tenant operations are not part of the v0.1 release.

## Quick Start

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run api:dev
npm run web:dev
```

Open `http://localhost:5173` and create the first owner with `AGENTHUB_BOOTSTRAP_TOKEN`.

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
- [Support matrix](docs/SUPPORT_MATRIX.md)
- [Provenance](PROVENANCE.md)
- [Contributing](CONTRIBUTING.md)
