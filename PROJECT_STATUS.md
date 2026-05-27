# Project Status

## Purpose

AgentHub-OSS is the public self-hosted distribution of AgentHub. It packages the FastAPI control plane, Web console, Android APK build, Windows desktop build, and Windows/Linux worker bundles for users who want to manage Codex, Claude, Kimi, and similar local agent sessions across their own machines.

## Current State

The public repo already builds and documents the core self-hosted product surface. In this round, the repo gained an initial public website surface under `website/`, a website nginx deployment template, a website deployment script, and a safer self-host smoke path that can validate a disposable VM by raw IP with a self-signed certificate before DNS is ready. The canary Ubuntu host is now up at `https://canary.myagenthub.dev` with a valid Let's Encrypt certificate, worker bundle downloads, and public relay rejection verified by live smoke. The public entry site is also live on `https://myagenthub.dev`, with `https://www.myagenthub.dev` covered by the same certificate, `docs.myagenthub.dev` redirecting to GitHub docs, and `app.myagenthub.dev` serving a placeholder hosted-entry page.

## Active Work

Current focus is release operations for the open-source distribution:

- canary/self-host smoke environment
- public root-domain website handoff
- release/test runbook hardening
- remote Windows smoke path documentation and repeatability

## How to Run

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run api:dev
npm run web:dev
```

For Ubuntu self-host:

```bash
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --admin-email you@example.com \
  --install-root /opt/agenthub
```

For the public website:

```bash
sudo bash scripts/deploy-website.sh \
  --domain myagenthub.dev \
  --site-root /var/www/agenthub-site \
  --github-repo YOUR_ORG/AgentHub-OSS
```

## How to Test / Validate

```powershell
npm run api:test
npm run web:test
npm run web:build
npm run desktop:test
npm run mobile:test
python scripts/audit-public-export.py --root .
git diff --check
```

Disposable self-host smoke without DNS:

```bash
bash scripts/check-selfhost.sh \
  --base-url https://123.57.71.62 \
  --expect-public-relay \
  --expect-worker-bundles \
  --insecure
```

## Important Files

- `scripts/install-selfhost-linux.sh`: Ubuntu self-host installer; now skips Electron/Playwright binary download during server-side `npm ci`
- `scripts/smoke-selfhost-vm.sh`: disposable VM smoke entrypoint; now supports raw IP targets with `--skip-certbot`
- `scripts/deploy-website.sh`: static website deployment helper for the root public domain
- `deploy/nginx/agenthub-website.conf.template`: nginx vhost template for `myagenthub.dev`, `www`, `docs`, and `app`
- `website/`: static public website source
- `docs/WEBSITE_DEPLOYMENT.md`: public website deployment guide
- `docs/SELF_HOST_QUICKSTART.md`: self-host flow including raw-IP precheck path
- `docs/TESTING.md`: live release-gate guidance

## Known Risks / Blockers

- Windows worker install still has an operator footgun on existing Windows hosts whose environment has `uv` available but no reliable `python` / `py` launcher on `PATH`. The bundle itself works, but the fallback path should stay documented until the install flow grows first-class `uv` detection.
- WinRM on the current smoke host is listening on `5985`, but cross-network local-account auth still depends on the target machine's local policy and the caller's TrustedHosts/auth settings. SSH is the more reliable automation path for this environment.

## Recent Decisions

- 2026-05-26: Added a raw-IP self-host smoke path so infrastructure can be validated before public DNS is ready.
- 2026-05-26: Added a separate static website surface for the OSS repo instead of mixing marketing/entry content into the product Web console.
- 2026-05-26: Changed the Ubuntu self-host installer to skip Electron and Playwright binary download during `npm ci`, because those binaries are not needed on a server-only install and were slowing smoke deployment significantly.
- 2026-05-27: Promoted the Ubuntu canary from raw-IP precheck to `https://canary.myagenthub.dev` with a valid Let's Encrypt certificate and a passing public self-host smoke.
- 2026-05-27: Deployed the static public website to `https://myagenthub.dev`, expanded the certificate to include `www.myagenthub.dev`, and wired `docs.myagenthub.dev` / `app.myagenthub.dev` on the public host.
- 2026-05-27: Completed a real Windows public-relay smoke on `120.26.35.12`: scheduled task running, persistent heartbeats visible on canary, Kimi session discovery active, and `health_check` jobs automatically claimed and completed.

## Next Step

Turn the verified rollout into a release gate:

1. keep the Windows `uv` fallback documented for clean hosts
2. run the full local CI/build suite on the branch
3. merge the canary/website/release-ops changes and cut the next public release
