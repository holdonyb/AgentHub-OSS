# Project Status

## Purpose

AgentHub is a public, self-hosted control plane and workbench for Codex, Claude, Kimi, OpenCode, and similar agent runtimes running on the user's own machines. The server owns authentication, task/session state, audit data, and client access. Windows, Linux, and macOS workers discover local sessions and execute scoped work.

## Current Release Line

- Branch: `main`
- Release: [`v1.0.0`](https://github.com/holdonyb/AgentHub-OSS/releases/tag/v1.0.0)
- Release commit: `dd8ab44cbb969334357475811f7c4063eacd2324`
- Repository version: `1.0.0`
- Production: upgraded from merged OSS `main` with the existing SQLite database preserved; `/healthz` and self-host smoke pass

The 1.0 line keeps Session Mode and adds Workbench Mode. A Workbench task moves from a structured brief through worker dispatch, attempts, artifacts, review, approval, or rework without replacing the existing interactive session console.

## Unreleased

The runtime-attention notification work is implemented on `feature/runtime-attention-notifications` and is not deployed yet.

- Sessions expose revisioned execution state separately from user-attention state, so stale discovery or sync responses cannot overwrite newer worker transitions.
- The API owns a per-user notification ledger with pending, delivered, read, acknowledged, and dismissed lifecycle states.
- Permission resolution and terminal job outcomes acknowledge their matching notifications instead of leaving historical alerts active.
- Web and compatibility Android clients claim delivery through the server ledger before showing an alert, preventing repeat notifications across refreshes and app restarts.
- Opening an unseen session from either the notification inbox or session list marks its attention state as seen through an idempotent API transition.
- Older servers remain supported: Web and Android fall back to the legacy notification projection only when the notification ledger endpoint is unavailable.

Fresh feature-branch verification on `2026-07-15`:

- API: `381 passed, 4 skipped`
- Web: `201 passed`; production build passed
- Compatibility Android: `16 passed`; JDK 21 debug APK compile passed
- React Native: `83 passed`; TypeScript typecheck passed
- Desktop: `34 passed`
- Alembic: production-representative `0005 -> 0006` SQLite upgrade smoke passed with legacy session projection preserved
- `git diff --check`: passed

## Implemented Surface

- FastAPI task APIs, lifecycle projection, attempt recovery, artifacts, review, approval, and rework
- Web Workbench with task inbox, detail view, task composer, responsive dark/light surfaces, and mobile-safe scrolling/actions
- Shared TypeScript/Python protocol and client transport for tasks, sessions, files, workers, and approvals
- Windows, Linux, and macOS workers with workspace-scoped execution
- macOS worker installation through a per-user LaunchAgent, verified bundle updates, and rollback protection
- Windows and macOS Electron packaging with runtime-configured self-host server selection
- React Native Android/iOS client source with Sessions, Tasks, Files, Workers, Profile, approvals, image attachments, voice dictation, and native notification deduplication
- Compatibility Capacitor Android client retained during the 1.0 transition
- Separate in-product download channels for the compatibility APK (`xin.ifix.agenthub`) and the side-by-side React Native APK (`dev.myagenthub.mobile`)
- Unified `1.0.0` version checks across root packages, clients, desktop packages, and release tags

## Verification Evidence

Fresh local verification on `2026-07-12`:

- API: `370 passed, 3 skipped`
- Web: `198 passed`
- Web production build: passed
- React Native: `83 passed`; TypeScript typecheck passed
- Compatibility Android: `16 passed`
- Desktop: `34 passed`; build passed
- Worker CLI: `21 passed`
- Shared client core: `6 passed`
- macOS worker: `9 passed`
- release version check and `git diff --check`: passed

Fresh GitHub release checks on `2026-07-12`:

- public export audit: passed
- secret scan: passed
- Linux/Windows verification: passed
- React Native Android debug compile on Linux/JDK 21: passed
- React Native iOS Simulator compile on macOS: passed
- macOS worker installer/LaunchAgent validation: passed
- signed Android APK/AAB build: passed
- Windows x64 EXE and macOS arm64/x64 DMG/ZIP packaging: passed
- GitHub Release: 13 assets published; complete 12-entry `SHA256SUMS` independently verified
- npm dependency audit: 0 vulnerabilities

Fresh production download checks on `2026-07-13`:

- compatibility APK: HTTP `200`, Android APK MIME, SHA-256 matched the GitHub Release manifest
- React Native APK: HTTP `200`, Android APK MIME, SHA-256 matched the GitHub Release manifest
- self-host nginx serves both assets from the public Web build root; private runtime data permissions remain unchanged
- mobile Web check at `390x844`: both download cards rendered without horizontal overflow

## Distribution Status

| Surface | 1.0 status | Release condition |
| --- | --- | --- |
| Web/API | released and deployed | production data preserved; health and self-host smoke pass |
| Compatibility Android APK | released | signed APK published |
| React Native Android APK/AAB | released | signed APK/AAB published |
| Windows desktop | released | x64 EXE published; public code signing still pending |
| macOS desktop | released | arm64/x64 DMG/ZIP published; signing/notarization still pending |
| React Native iOS | source + CI Simulator build | signed IPA, provisioning, and real-device smoke not complete |
| Windows/Linux/macOS workers | released | versioned bundles and manifest published |

## Post-1.0 Follow-ups

1. Add public code-signing credentials for Windows desktop distribution.
2. Add Apple signing/notarization credentials for macOS desktop distribution.
3. Produce and validate a signed iOS IPA on a real device before claiming iOS distribution.
4. Upgrade the production Node runtime to the repository-supported Node 22 line during a separate maintenance window.

## Run And Validate

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run local:dev
```

```powershell
npm run api:test
npm run web:test
npm run web:build
npm run mobile:test
npm run mobile:native:test
npm run mobile:native:typecheck
npm run desktop:test
npm run release:version:check
.\.venv\Scripts\python.exe scripts\audit-public-export.py
git diff --check
```

## Important Files

- `apps/api/app/routers/tasks.py`: Workbench task API
- `apps/api/app/task_lifecycle.py`: task/job lifecycle projection
- `apps/web/src/App.tsx`: Web Session and Workbench surfaces
- `apps/mobile-native/`: React Native Android/iOS client
- `apps/desktop/`: Windows/macOS Electron client and packaging
- `workers/local-macos/`: macOS worker implementation
- `scripts/install-macos-worker.sh`: macOS LaunchAgent installer
- `.github/workflows/ci.yml`: cross-platform compile/test gates
- `.github/workflows/release.yml`: 1.0 release assets
- `docs/OPEN_SOURCE_LAUNCH.md`: release checklist

## Safety Constraints

- Do not deploy from a feature worktree or replace the production database.
- Deploy only a merged `main` commit that has passed CI.
- Back up production state before schema migration or binary promotion.
- Do not claim signed iOS distribution until an IPA and real-device smoke exist.
- Do not claim notarized macOS distribution until Apple signing/notarization evidence exists.
