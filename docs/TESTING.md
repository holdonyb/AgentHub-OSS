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

## Web Coverage

Implemented tests cover:

- session inbox loading
- XSS fixture rendered as text
- reply box creates `session_input`
- viewer role hides admin controls
- mobile WebView layout keeps `viewport-fit=cover`, safe-area CSS, and no fixed body width

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

## Deployment Regression Notes

The production smoke in `scripts/deploy-linux.sh` verifies API health, public worker enrollment rejection, and internal worker API isolation. It does not prove that a live Windows worker can drain a real queued Codex/Claude/Kimi job, and it does not inspect Android device safe areas. Those gaps caused the queued-job stall and APK layout regression to escape earlier deployment checks.

For releases that touch workers, job state, mobile WebView, or Android native code, run the automated CI suite plus one live smoke:

1. Confirm each active worker is heartbeating.
2. Send a short `session_input` to a disposable session on that worker.
3. Confirm the job leaves `queued/running` and ends as `succeeded` or a visible `failed` error.
4. Install the freshly built APK and check the top status/cutout area, bottom nav, and reply bar on a real phone.

