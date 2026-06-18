# Project Status

## Purpose

AgentHub-OSS is the public self-hosted distribution of AgentHub. It packages the FastAPI control plane, Web console, Android APK build, Windows desktop build, and Windows/Linux worker bundles for users who want to manage Codex, Claude, Kimi, and similar local agent sessions across their own machines.

## Current State

The public repo already builds and documents the core self-hosted product surface. In this round, the repo gained an initial public website surface under `website/`, a website nginx deployment template, a website deployment script, and a safer self-host smoke path that can validate a disposable VM by raw IP with a self-signed certificate before DNS is ready. The public entry site is live on `https://myagenthub.dev`, with `https://www.myagenthub.dev` covered by the same certificate, `docs.myagenthub.dev` redirecting to GitHub docs, `app.myagenthub.dev` serving a placeholder hosted-entry page, and the root domain now expected to hand users off through dedicated `/install/`, `/download/`, and `/release/` website routes instead of dropping them straight into GitHub.

The public website surface now also includes `/press/`, which packages launch copy, website links, and reusable screenshot assets into one public-facing press kit. That page is meant to keep README, website, GitHub Release text, and community posts aligned without re-drafting the same positioning each time.

The canary deployment has now been moved onto `gpu-server` after the previous Beijing VM hit an upstream domain-level ingress problem that broke public TLS only when accessed through `canary.myagenthub.dev`. The public canary remains exposed at `https://canary.myagenthub.dev`, but it now shares the stable public edge with the website host while keeping a separate AgentHub install root and API service. During that migration, the self-host nginx template was corrected so `/.well-known/acme-challenge/` stays reachable over plain HTTP instead of being swallowed by the port-80 HTTPS redirect, which makes fresh Let's Encrypt issuance reliable on new hosts.

This phase also starts reducing install friction directly in the public repo. The repo now contains a publishable `agenthub-worker` npm workspace that wraps the existing worker bundle installers, a public `scripts/install.sh` Linux entrypoint that maps to the self-host installer, an official Docker self-host stack under `deploy/docker-compose.selfhost.yml`, a dedicated `.github/workflows/npm-worker-publish.yml` workflow for npm release through Trusted Publishing or an npm automation token, and first-class `uv` bootstrap fallback inside both worker install scripts so clean or nonstandard hosts no longer depend on `python` or `py` being exposed on `PATH`.

The current stabilization round also fixed a real Claude resume regression in the public OSS line. PR `#36` was merged into `main` on `2026-06-15` after adding Windows Claude interactive bridge support, normalizing legacy Claude `approval_mode=never` into the valid `permission_mode=bypassPermissions`, and making Claude runtime session paths such as `.claude/projects/E--work/...jsonl` or `.claude/projects/srv--work/...jsonl` resolve back to the correct workspace root before `claude --resume` runs. The hotfix was validated on a downstream self-host deployment before the merge landed, and the merged `main` branch then passed CI, Secret Scan, and Android APK workflows again.

The Web/App client file surface has now been upgraded from a basic preview pane into a broader mobile-first workspace workbench. The current OSS branch supports richer file capability metadata from workers, inline preview for text, Markdown, images, audio, and video, a stronger text editor with line numbers/search/save shortcuts, recent-file chips, file detail sheets, and safe workspace mutations for creating files, creating folders, renaming entries, and uploading single files through worker-side jobs. The API and worker protocol were extended in lockstep so these operations still stay scoped to the worker workspace root instead of writing directly from the control plane.

## Active Work

Current focus is release operations for the open-source distribution:

- canary/self-host smoke environment
- public root-domain website handoff
- release/test runbook hardening
- install-surface simplification for server and worker onboarding
- install-mode consolidation across local, Docker, and VM paths
- mobile-first file browsing and lightweight file editing inside the Web/App client
- file-workbench stabilization, QA, and deployment for the new upload/create/rename/media-preview path

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
curl -fsSL https://myagenthub.dev/install.sh | bash -s -- \
  --domain agenthub.example.com \
  --admin-email you@example.com \
  --install-root /opt/agenthub
```

Repo-local equivalent:

```bash
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --admin-email you@example.com \
  --install-root /opt/agenthub
```

For Docker self-host:

```bash
cp .env.example .env
docker compose -f deploy/docker-compose.selfhost.yml up -d --build
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
- `scripts/install.sh`: thin public Linux installer entrypoint, suitable for `curl ... | bash`
- `deploy/docker-compose.selfhost.yml`: official Docker self-host stack with API + Web reverse proxy
- `deploy/docker/Dockerfile.api`: API image build
- `deploy/docker/Dockerfile.web`: Web + worker-bundle image build
- `deploy/docker/nginx-selfhost.conf`: same-origin `/api` proxy for Docker mode
- `scripts/check-worker-package-version.mjs`: validates that the repo version and `agenthub-worker` package version stay aligned, and optionally checks a `worker-vX.Y.Z` tag
- `scripts/smoke-selfhost-vm.sh`: disposable VM smoke entrypoint; now supports raw IP targets with `--skip-certbot`
- `scripts/deploy-website.sh`: static website deployment helper for the root public domain
- `packages/worker-cli/`: npm worker installer package that downloads a worker bundle and calls the existing platform installer
- `.github/workflows/npm-worker-publish.yml`: dedicated workflow for publishing `agenthub-worker` to npm
- `docs/DOCKER_SELFHOST_MODE.md`: operator guide for the official compose path
- `deploy/nginx/agenthub-website.conf.template`: nginx vhost template for `myagenthub.dev`, `www`, `docs`, and `app`
- `website/`: static public website source
- `docs/LAUNCH_COPY.md`: channel-ready public launch copy aligned with the website and Release text
- `docs/WEBSITE_DEPLOYMENT.md`: public website deployment guide
- `docs/SELF_HOST_QUICKSTART.md`: self-host flow including raw-IP precheck path
- `docs/TESTING.md`: live release-gate guidance
- `apps/web/src/App.tsx`: unified mobile-first workspace workbench UI, preview flows, and lightweight editor
- `workers/shared/agenthub_worker/executor.py`: workspace-scoped file mutation path for list/read/write/upload/create/mkdir/rename
- `apps/api/app/routers/sessions.py`: session file job endpoints for upload/create/mkdir/rename

## Known Risks / Blockers

- `agenthub-worker` is now the canonical public package name. The older scoped package still exists, but all public docs and workflows now default to the unscoped package.
- WinRM on the current smoke host is listening on `5985`, but cross-network local-account auth still depends on the target machine's local policy and the caller's TrustedHosts/auth settings. SSH is the more reliable automation path for this environment.

## Recent Decisions

- 2026-05-26: Added a raw-IP self-host smoke path so infrastructure can be validated before public DNS is ready.
- 2026-05-26: Added a separate static website surface for the OSS repo instead of mixing marketing/entry content into the product Web console.
- 2026-05-26: Changed the Ubuntu self-host installer to skip Electron and Playwright binary download during `npm ci`, because those binaries are not needed on a server-only install and were slowing smoke deployment significantly.
- 2026-05-27: Promoted the Ubuntu canary from raw-IP precheck to `https://canary.myagenthub.dev` with a valid Let's Encrypt certificate and a passing public self-host smoke.
- 2026-05-27: Deployed the static public website to `https://myagenthub.dev`, expanded the certificate to include `www.myagenthub.dev`, and wired `docs.myagenthub.dev` / `app.myagenthub.dev` on the public host.
- 2026-05-27: Completed a real Windows public-relay smoke on `120.26.35.12`: scheduled task running, persistent heartbeats visible on canary, Kimi session discovery active, and `health_check` jobs automatically claimed and completed.
- 2026-05-28: Moved `canary.myagenthub.dev` onto `gpu-server` after the previous Beijing VM showed a domain-level ingress/TLS reset problem, and fixed the self-host nginx template so HTTP ACME challenge paths are served before the HTTPS redirect.
- 2026-05-31: Added `scripts/install.sh` as the public Linux self-host entrypoint, published it through the website deploy flow, added a new `agenthub-worker` npm workspace, taught both worker install scripts to fall back to `uv` for bootstrap when `python`/`py` are absent, added a dedicated worker publish workflow, and codified the `worker-vX.Y.Z` tag/version check path.
- 2026-05-31: Added a first-class Docker self-host path with API/Web container builds, same-origin nginx proxying, downloadable worker bundles, and a dedicated Docker operator guide so install UX now centers on local, Docker, and VM modes.
- 2026-05-31: Fixed the worker publish workflow to branch on a job-level `NODE_AUTH_TOKEN` env wrapper instead of reading `secrets.NPM_TOKEN` directly inside step `if` guards, which avoids false-failure workflow parses on ordinary `main` pushes.
- 2026-05-31: Ran a full remote Docker smoke on `gpu-server`: `docker compose -f deploy/docker-compose.selfhost.yml up -d --build` completed, `/healthz`, `/`, and `/downloads/workers/worker-bundles-manifest.json` all returned `200`, then the temporary stack was torn down. That smoke also exposed a real operator-UX bug in `AGENTHUB_CORS_ORIGINS`, which is now normalized from single-origin and compose-style bracketed values instead of requiring strict JSON parsing.
- 2026-06-01: Promoted local mode into a first-class preset with `npm run local:dev`, a dedicated website install chooser, and unified defaults of `http://localhost:43073` for Web/UI plus `http://127.0.0.1:43080` for the API. The local-mode smoke remains the same dev shape, but the operator-facing install surface is now aligned across README, docs, website, and local worker defaults.
- 2026-06-06: Added a public `/press/` page plus `docs/LAUNCH_COPY.md`, so the website, README, GitHub Release body, and community launch copy share one stable wording surface.
- 2026-06-15: Merged PR `#36` to fix OSS Claude resume stability: Windows Claude now has an interactive bridge path, legacy `approval_mode=never` is translated into `bypassPermissions`, and runtime session refs under `.claude/projects/<bucket>/...jsonl` are resolved back to the correct workspace root before resume.
- 2026-06-18: Expanded the mobile file surface into a workspace workbench with Markdown/image/audio/video preview plus safe create/upload/rename/mkdir mutations routed through worker jobs.

## Next Step

Deploy and dogfood the upgraded workspace workbench:

1. push the file-workbench branch changes and deploy API/Web/worker together
2. validate text/image/audio/video preview plus create/upload/rename on a real mobile client
3. then return to the public release-track tasks (`agenthub-worker` publishing cleanup and install-surface polish)
