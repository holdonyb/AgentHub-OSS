# Testing

## Commands

```powershell
npm run api:test
npm run web:test
npm run web:build
```

## API Coverage

Implemented tests cover:

- owner bootstrap is one-time
- password hashes use Argon2id, not plaintext
- login rate limit
- CSRF enforcement for cookie-auth mutations
- worker token isolation from Web APIs
- user token isolation from worker internal APIs
- invite expiry and reuse
- anonymous business API 401
- viewer 403 on job mutation
- session input job creation and audit event
- unknown job kind rejection
- job cannot complete twice
- offline worker is not assigned jobs
- duplicate worker registration is idempotent
- worker token is bound to worker_id
- stale running worker jobs are failed from heartbeat recovery so queued input is unblocked
- backend CLI timeouts are converted into reportable job failures
- worker discovery skips unstable dependency/cache directories and survives disappearing paths
- Codex/Claude JSONL fixture parsing
- Windows path normalization with Chinese names and spaces

Reliability SLOs and E1 fault-injection scenarios are documented in
[`RELIABILITY_SLO.md`](RELIABILITY_SLO.md). Run the current fault-injection suite
with:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m all_scenarios -q
```

## Web Coverage

Implemented tests cover:

- session inbox loading
- XSS fixture rendered as text
- reply box creates `session_input`
- viewer role hides admin controls
- mobile WebView layout keeps `viewport-fit=cover`, safe-area CSS, and no fixed body width

## React Native Coverage

Run the native console gates with:

```powershell
npm run mobile:native:test
npm run mobile:native:typecheck
npm run mobile:native:build:android
```

The `1.0.2` acceptance suite covers:

- session inbox search, backend/status/worker filters, archive and batch archive
- timezone-less UTC parsing, `updated_at` fallback, recent-activity sorting, polling, and foreground refresh
- timeline paging/search, delayed transcript refresh, Markdown, full reader/copy, local file links, persisted attachments, and collapsed tool output
- direct/plan replies, multiline text, quick replies, image/document/voice input, delivery states, and runtime controls
- `request_user_input`, approval rejection, notification deep links, session rename/fork/BTW/archive, and termination confirmation
- task search/create/dispatch/review/reject/rework/archive/restore and artifact-to-Files handoff
- worker provider readiness and provider login/logout role gates
- workspace browse/search/recent/preview/edit/save/create/mkdir/rename/upload/download and viewer restrictions
- notification inbox read/dismiss, appearance and composer preferences, release metadata, and server switching
- generated Android light/dark semantic resources and theme application before the authenticated console mounts

For the worker freshness regression, run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_worker_discovery.py -q
```

The discovery gate must prove that a large Codex history cannot starve recent Claude, Kimi, or OpenCode files. After merging a discovery change, update one real installed worker and verify the newest local session from each configured backend reaches the server.

## Manual E2E Checklist

1. Start API on a Tailscale-reachable host.
2. Bootstrap owner.
3. Register Windows worker.
4. Confirm local Codex/Claude sessions appear.
5. Send a reply from a phone browser.
6. Confirm worker claims and completes the job.
7. Register Linux VM worker.
8. Run a `health_check` job.
9. Expose Web/API through frpc HTTPS.
10. Confirm worker internal API is not usable without worker token.
11. Stop a worker and confirm no queued jobs are assigned to it.

## Physical-device Push Checklist

Use a release-signed React Native build with `EXPO_PUBLIC_EAS_PROJECT_ID` configured and an API with Expo push enabled.

1. Log in, grant notification permission, and confirm `GET /api/push/devices` returns one redacted enabled device.
2. Terminate the app process, create a new approval for that user, and confirm the locked phone receives exactly one notification.
3. Open the notification and confirm AgentHub deep-links to the target session and marks the inbox item read.
4. Keep Web open while creating another approval and confirm the phone still receives its own delivery.
5. Disable OS notification permission and confirm the notification remains available in the in-app inbox after reopening.
6. Log out and confirm the device is revoked; create another approval and confirm no push is sent to that installation.
7. Rotate/reinstall the app, register the new token, and confirm an Expo `DeviceNotRegistered` response disables the stale token without deleting inbox history.

Simulators, Expo Go, and foreground-only local notifications do not satisfy this gate.

## Deployment Regression Notes

The production smoke in `scripts/deploy-linux.sh` verifies API health, public worker enrollment rejection, and internal worker API isolation. It does not prove that a live Windows worker can drain a real queued Codex/Claude/Kimi job, and it does not inspect Android device safe areas. Those gaps caused the queued-job stall and APK layout regression to escape earlier deployment checks.

For releases that touch workers, job state, mobile WebView, or Android native code, run the automated CI suite plus one live smoke:

1. Confirm each active worker is heartbeating.
2. Send a short `session_input` to a disposable session on that worker.
3. Confirm the job leaves `queued/running` and ends as `succeeded` or a visible `failed` error.
4. Install the freshly built APK and check the top status/cutout area, bottom nav, and reply bar on a real phone.
5. Compare one timezone-less API activity timestamp with local time and confirm the card is not shifted by the device UTC offset.
6. On a worker with histories from multiple backends, confirm the newest Codex, Claude, and Kimi sessions all appear after discovery.

If your public smoke domain has not switched yet, do one disposable precheck directly against the VM IP with `--skip-certbot` and `check-selfhost.sh --insecure`, then rerun the same smoke against the final HTTPS domain after DNS is correct.

## Live Smoke Reference: Canary + Windows Worker

The current canary flow has already been proven against a real public relay deployment:

- `https://canary.myagenthub.dev`
- real Windows worker host
- real discovered Kimi session
- repeated `worker.heartbeat`
- repeated `session.discovery`
- real `health_check` job `queued -> claimed -> succeeded`

That matters because it closes the gap between "bundle downloads and API health are fine" and "a long-running Windows worker can actually stay online and drain work".

If the Windows host already has real session data but does not have a reliable `python` / `py` launcher on `PATH`, the fallback that worked in production smoke was:

1. Download and extract `agenthub-worker-windows.zip`.
2. Use `uv` directly from the host, for example:

```powershell
uv run --with-requirements workers\requirements.txt --python 3.13 python `
  workers\local-windows\agenthub_windows_worker\main.py `
  --api-url https://agenthub.example.com `
  --worker-id windows-office-01 `
  --connection-mode public_relay `
  --workspace-root C:/Users/Administrator `
  --once
```

3. After enrollment succeeds, remove the one-time enrollment token and use the cached `.runtime/<worker-id>.worker-token` for recurring runs or a scheduled task.

