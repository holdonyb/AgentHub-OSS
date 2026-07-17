# Remote Workspace v2 Implementation Plan

## Phase 1: Independent adaptive Files workspace

- [x] Add tests proving Files can select a worker/workspace independently from the current session.
- [x] Add a pure workspace-context resolver that chooses a compatible session only for legacy job submission.
- [x] Add compact explorer/detail navigation and browser/Android back behavior.
- [x] Add regular-width list-detail layout with one shared state model.
- [x] Preserve directory, query, recent files, preview, and editor draft while switching panes.
- [x] Verify at 390x844, 768x1024, 1024x768, and 1440x900.

Validation:

```powershell
npm run web:test
npm run web:build
npm run mobile:test
```

## Phase 2: Bounded legacy transport

- [x] Add worker tests proving `file_read` reads at most `max_bytes + 1` from disk rather than loading the entire file.
- [x] Add offset/length metadata for bounded text previews while preserving current response fields.
- [x] Reduce default inline binary preview limits and refuse oversized Base64 results.
- [x] Add configurable retention that clears completed legacy file job bodies after their compatibility TTL. Cleanup is currently triggered by job list/detail reads rather than a scheduler.

Validation:

```powershell
npm run api:test
python -m pytest workers/shared/tests -q
```

## Phase 3: Ephemeral transfer tickets

- [x] Add transfer-ticket model, expiry, scope, and audit events.
- [x] Add user ticket creation and worker claim/stream authorization endpoints.
- [x] Add worker capability negotiation and outbound transfer handling without SSH or new worker ingress.
- [x] Add ranged read/download/media and streamed upload with configurable temporary directory, TTL, and size limit.
- [x] Add periodic server cleanup for expired transfer bodies and crash-left partial files, with request-time cleanup retained as a fallback.
- [x] Move image/audio/video/download previews and uploads to tickets with automatic legacy fallback; keep bounded text/Markdown reads on jobs for compatibility.
- [x] Return the stored SHA-256 digest with transfer bodies and make workers reject and remove downloads whose digest does not match.
- [x] Complete protected-file explicit reveal for the built-in sensitive filename and suffix policy: per-request Web/WebView confirmation, API propagation, worker enforcement, and reveal-specific audit metadata. Operator-configurable globs remain a later hardening option.

Validation includes path traversal, symlink escape, replay, expiry, cross-worker access, range boundaries, stale write conflicts, worker disconnect, and interrupted upload tests.

## Phase 4: Cross-device QA and rollout

- [x] Run responsive browser QA at 390x844, 768x1024, 1024x768, and 1440x900 with dark/light theme checks, no horizontal overflow, and no browser console errors.
- [x] Run compatibility Android WebView and React Native regression suites. Transfer-ticket behavior is currently exercised by Web/WebView; React Native remains on the bounded session-file API. Physical-device file-transfer smoke remains part of rollout.
- [ ] Run Windows and Linux real-worker text/image/media/edit smokes.
- [x] Confirm bounded legacy job behavior and `file_transfer_v2` capability routing through automated API, Web, and worker tests.
- [ ] Confirm the rolling-upgrade path against one installed old worker and one installed new worker.
- [ ] Deploy API/Web first, then worker bundles, then APK/native releases.
- [ ] Monitor transfer failures, file-job fallback rate, database growth, and stale ticket cleanup before removing compatibility paths.

## Deferred hardening

- [ ] Add image thumbnail derivatives and composite text revision hashes.
- [ ] Add React Native `file_transfer_v2` transport and native temporary-cache controls.
- [ ] Add operator-configurable protected-file globs and a dedicated concurrent-transfer limiter.
