# Changelog

## v1.0.3 - 2026-07-20

- Reworked the native Android session inbox into a denser phone-first layout with compact actions, on-demand search, and backend/status/worker filters in a bottom sheet.
- Reduced native session-card height while preserving title, backend, worker, attention state, activity time, and a bounded transcript preview.
- Simplified the native session detail composer so reply modes and quick actions stay collapsed until needed, leaving substantially more space for the timeline.
- Localized native execution states and stopped exposing raw terminal values such as `completed` in the conversation UI.
- Reduced the WebView mobile composer footprint, collapsed secondary controls while typing, and made timeline filters horizontally scrollable instead of consuming sticky viewport space.
- Verified the native layout against the configured production server in an Android emulator, including login, real sessions, filters, detail navigation, and reply-option expansion.

## v1.0.2 - 2026-07-19

- Expanded the React Native console into a complete mobile control surface: session search and reply, approvals, full-message reader, image and voice input, task creation and review, worker diagnostics, notification inbox, and update checks.
- Added scoped workspace browsing, image preview, text editing, file creation, rename, directory creation, and image upload through the session's assigned worker.
- Made task artifacts open directly in the matching session workspace instead of requiring manual path lookup.
- Reduced mobile timeline noise by collapsing completed tool output until the user explicitly opens it.
- Added GitHub Release metadata lookup with a stable signed-APK fallback and raised Android versionCode for in-place updates.
- Fixed native relative times by treating timezone-less server datetimes as UTC and sorting cards by the newest activity/update timestamp.
- Changed worker history discovery from one shared file cap to a per-backend cap so large Codex histories cannot hide Claude, Kimi, or OpenCode sessions.
- Added stable Android light/dark semantic resources and applied the saved appearance before the authenticated console mounts.

## v1.0.0 - 2026-07-12

- Added Workbench Mode beside the existing Session console, including structured task briefs, worker dispatch, attempts, artifacts, review, approval, and rework.
- Added the React Native Android/iOS client with self-host server setup, sessions, tasks, files, workers, approvals, image attachments, voice dictation, and native notification deduplication.
- Added official macOS worker installation through a per-user LaunchAgent with verified bundle updates and rollback protection.
- Added Windows and macOS desktop packaging with runtime-configured server selection and optional platform signing credentials.
- Unified package, Android, React Native, desktop, and protocol versions at `1.0.0`, with CI checks that reject mismatched tags or component versions.
- Expanded GitHub Actions to compile React Native Android on Linux and the iOS Simulator target on macOS before release.
- Fixed the mobile Workbench task sheet so its title, close control, and submit actions remain reachable while long forms scroll.
- Preserved existing SQLite deployments by keeping task migrations compatible with SQLite 3.22 and validating the production upgrade against a database snapshot.
- Stabilized cross-platform release CI on macOS 26 and removed the remaining vulnerable build-time `uuid` dependency.

## v0.1.1 - 2026-05-27

- Added the public root-domain website, nginx deployment template, and deployment script for `myagenthub.dev`, `www`, `docs`, and `app`.
- Promoted the self-host smoke flow from raw IP precheck to live `canary.myagenthub.dev` HTTPS verification with worker bundle checks.
- Hardened the Ubuntu self-host installer by skipping unnecessary Electron and Playwright binary downloads during server-only installs.
- Documented the Windows worker fallback path for hosts that already have real session data but only expose `uv`, not a usable `python` or `py` launcher.
- Fixed the Android native clipboard web test to wait for the asynchronous copied state before asserting the success label.

## v0.1.0 - 2026-05-24

- First public OSS release of AgentHub.
- Added Android first-launch server setup before login.
- Added Windows desktop client packaging and worker bundles for self-host installs.
- Added architecture diagrams, self-host onboarding, and Tailscale/private-mode docs.
