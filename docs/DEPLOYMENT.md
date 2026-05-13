# Deployment

AgentHub is self-host first. A normal deployment has:

- FastAPI API service
- built Web assets
- HTTPS reverse proxy
- Windows or Linux workers enrolled with per-space enrollment tokens

## Local development

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run api:dev
npm run web:dev
```

Open `http://localhost:5173` and create the owner with `AGENTHUB_BOOTSTRAP_TOKEN`.

## Production settings

Set a stable encryption key before storing provider secrets:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Set at least:

```text
AGENTHUB_ENVIRONMENT=production
AGENTHUB_DATABASE_URL=sqlite+pysqlite:////var/lib/agenthub/agenthub.db
AGENTHUB_SECRET_ENCRYPTION_KEY=replace-with-stable-random-secret
AGENTHUB_COOKIE_SECURE=true
AGENTHUB_CORS_ORIGINS=["https://agenthub.example.com"]
AGENTHUB_PUBLIC_BASE_URL=https://agenthub.example.com
```

SQLite is acceptable for a small private deployment. Use PostgreSQL before running a multi-user public service.

## Reverse proxy

Expose only:

- `/`
- `/healthz`
- `/api/*`
- `/api/worker/*` when public relay workers are used

Do not expose database ports, SSH/RDP, raw Uvicorn, worker-local services, or legacy internal worker APIs on a public listener.

Use the templates under `deploy/` as starting points, then set your own domain and certificate paths.

## Worker bundles

Build worker bundles:

```powershell
.\.venv\Scripts\python.exe scripts\build-worker-bundle.py --output-root .runtime\worker-bundles
```

Publish the generated files behind your HTTPS server or attach them to a GitHub Release:

```text
agenthub-worker-windows.zip
agenthub-worker-linux.tar.gz
worker-bundles-manifest.json
```

Install workers with the matching installer in each bundle and a Web/API-generated enrollment token.

## Desktop and Android

Public desktop and Android clients ask for a server URL on first launch. For preconfigured internal builds, set:

```text
AGENTHUB_DESKTOP_URL=https://agenthub.example.com
AGENTHUB_MOBILE_SERVER_URL=https://agenthub.example.com
AGENTHUB_PUBLIC_BASE_URL=https://agenthub.example.com
```

Android signing keys must stay outside git:

```text
AGENTHUB_ANDROID_KEYSTORE_FILE
AGENTHUB_ANDROID_KEYSTORE_PASSWORD
AGENTHUB_ANDROID_KEY_ALIAS
AGENTHUB_ANDROID_KEY_PASSWORD
```

## Release

The public release workflow builds:

- Web assets
- Desktop TypeScript output
- Android APKs
- Windows and Linux worker bundles
- `SHA256SUMS`

Tagged pushes like `v0.1.0` publish these assets to GitHub Releases.
