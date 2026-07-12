# Project Status

## Purpose

AgentHub is a public, self-hosted control plane and workbench for Codex, Claude, Kimi, OpenCode, and similar agent runtimes running on the user's own machines. The server owns authentication, task/session state, audit data, and client access. Windows, Linux, and macOS workers discover local sessions and execute scoped work.

## Current Release Line

- Branch: `v1/agenthub-1.0`
- Pull request: `#95`
- Repository version: `1.0.0`
- Production: unchanged until the release candidate passes canary and upgrade smoke

The 1.0 line keeps Session Mode and adds Workbench Mode. A Workbench task moves from a structured brief through worker dispatch, attempts, artifacts, review, approval, or rework without replacing the existing interactive session console.

## Implemented Surface

- FastAPI task APIs, lifecycle projection, attempt recovery, artifacts, review, approval, and rework
- Web Workbench with task inbox, detail view, task composer, responsive dark/light surfaces, and mobile-safe scrolling/actions
- Shared TypeScript/Python protocol and client transport for tasks, sessions, files, workers, and approvals
- Windows, Linux, and macOS workers with workspace-scoped execution
- macOS worker installation through a per-user LaunchAgent, verified bundle updates, and rollback protection
- Windows and macOS Electron packaging with runtime-configured self-host server selection
- React Native Android/iOS client source with Sessions, Tasks, Files, Workers, Profile, approvals, image attachments, voice dictation, and native notification deduplication
- Compatibility Capacitor Android client retained during the 1.0 transition
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

Fresh GitHub PR checks after the native release and macOS installer changes:

- public export audit: passed
- secret scan: passed
- Linux/Windows verification: passed
- React Native Android debug compile on Linux/JDK 21: passed
- React Native iOS Simulator compile on macOS: passed
- macOS worker installer/LaunchAgent validation: passed

## Distribution Status

| Surface | 1.0 status | Release condition |
| --- | --- | --- |
| Web/API | release candidate | canary migration and production upgrade smoke |
| Compatibility Android APK | build supported | existing signing path |
| React Native Android APK/AAB | build supported | Android signing secrets required |
| Windows desktop | package supported | optional Windows code-signing credentials |
| macOS desktop | package supported | public distribution requires Apple signing/notarization credentials |
| React Native iOS | source + CI Simulator build | signed IPA, provisioning, and real-device smoke not complete |
| Windows/Linux/macOS workers | bundle supported | upgrade smoke against a real self-host server |

## Remaining 1.0 Gates

1. Finish documentation and release-copy alignment.
2. Run the complete test matrix after the documentation commit.
3. Confirm required Android signing secrets; confirm whether macOS signing/notarization credentials are available.
4. Merge PR `#95` only after review and green CI.
5. Deploy merged `main` to canary without replacing production data.
6. Exercise upgrade, login, worker heartbeat, session reply, Workbench dispatch/review, file access, Android install/upgrade, and desktop connection smokes.
7. Tag `v1.0.0`, verify all GitHub Release artifacts and checksums, then promote the tested build.

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
