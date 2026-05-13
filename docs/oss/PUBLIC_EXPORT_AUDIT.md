# AgentHub Public Export Audit

Last updated: 2026-05-12

This document tracks what blocks AgentHub from being exported into a clean public OSS repository. It lives in the private repo on purpose so the export can be reviewed before any public push exists.

Quick scan command:

```powershell
.\.venv\Scripts\python.exe scripts\audit-public-export.py
```

## Locked Export Strategy

- publish a **new public repo**
- keep current private repo and git history private
- ship OSS as **self-host first**
- retain the `AgentHub` name
- include `API + Web + Desktop + Android + Windows/Linux Workers`

## Classification

- `carry`: safe to copy into the public repo with little or no change
- `rewrite`: logic can stay, but docs/text/defaults must change
- `template`: keep the pattern, strip private deployment assumptions
- `private-only`: never copy into the public repo

## Current Blockers

### 1. Hosted URL assumptions

| Path | Status | Notes |
| --- | --- | --- |
| `README.md` | rewrite | still references the private hosted console directly |
| `docs/DEPLOYMENT.md` | rewrite | mixes public examples with current private deployment defaults |
| `docs/SECURITY.md` | rewrite | described the APK as a wrapper for one fixed hosted URL |
| `apps/mobile/README.md` | rewrite | still documents the private hosted APK and fixed remote shell |
| `apps/desktop/src/main/windowConfig.ts` | rewrite | legacy fallback still points at the private hosted console |
| `apps/mobile/capacitor.config.ts` | rewrite | now supports env overrides, but still keeps the legacy fallback for private continuity |
| `apps/mobile/android/app/src/main/java/xin/ifix/agenthub/AgentHubNotificationService.java` | rewrite | now reads `BuildConfig.AGENTHUB_SERVER_URL`, but the Gradle fallback is still private |

### 2. Production deployment workflows

| Path | Status | Notes |
| --- | --- | --- |
| `.github/workflows/android-apk.yml` | template | still contains optional publish-to-production-downloads steps |
| `.github/workflows/deploy.yml` | private-only | deploys to the private VM over SSH |
| `scripts/deploy-linux.sh` | template | valid deploy pattern, but still tied to the private production flow |
| `scripts/deploy-vm.ps1` | private-only | private production wrapper |
| `scripts/publish-apk.ps1` | private-only | pushes APKs into the private download path |

### 3. Runtime residue

| Path / Pattern | Status | Notes |
| --- | --- | --- |
| `.runtime/` | private-only | contains worker cache, logs, temp keys, runtime state |
| `agenthub.db*` | private-only | local database and journal files |
| `output/` | private-only | local export/build artifacts |
| `artifacts/` | private-only | local generated artifacts |
| local signing keys (`*.jks`, `*.keystore`) | private-only | never export |

### 4. OSS repo metadata still missing

These should be created in the future public repo, not copied blindly from here:

- `LICENSE`
- `CONTRIBUTING.md`
- root `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `CHANGELOG.md`
- `PROVENANCE.md`
- public-facing `README.md`
- `docs/SUPPORT_MATRIX.md`

### 5. Capability honesty requirements

The future public repo must document provider differences explicitly:

- `codex`: deepest interaction bridge
- `claude`: compatibility layer, but some native runtime prompts still need bridging work
- `kimi`: compatibility layer, with structured interaction gaps still being closed
- mobile/desktop notifications, images, plan controls, and structured user input are not yet equivalent across every provider

## What Was Completed In This Pass

- Desktop now resolves the console URL via `--url`, `AGENTHUB_DESKTOP_URL`, `AGENTHUB_PUBLIC_BASE_URL`, then the legacy fallback.
- Android Capacitor config now supports `AGENTHUB_MOBILE_SERVER_URL` and `AGENTHUB_PUBLIC_BASE_URL`.
- Android notification polling now reads `BuildConfig.AGENTHUB_SERVER_URL` instead of hardcoding the console URL in Java.
- README / deployment / security docs now describe the env-driven mobile/desktop URL path instead of presenting the private hosted URL as the only shape.

## Still Required Before Public Export

1. remove remaining private hosted fallbacks or isolate them into a private-only build profile
2. split public CI from private production deploy workflows
3. create public repo metadata and support matrix docs
4. run a clean-room provenance pass on UI copy and interaction naming
5. validate fresh-clone self-host install on a machine that does not know the private environment
