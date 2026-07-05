# AgentHub Reliability SLO

This document defines the reliability metrics used by the 2026H2 WS-A gate. The
metrics are intentionally derived from AgentHub database rows and structured
events so they can be produced by a script, quoted in daily reports, and audited
later without hand-entered numbers.

## Metrics

| SLO | A5 output field | Source rows | Passing target |
| --- | --- | --- | --- |
| Message delivery | `message_delivery_success_rate_7d` | `jobs` where `kind=session_input`, plus `job.create`, `job.claim`, `job.complete`, `job.fail`, `job.fail_stale`, `job.fail_orphaned`, and `job.fail_worker_offline` events | 7-day rolling success rate >= 99.5% |
| Notification latency | `notification_latency_p95_seconds` | notification request and delivery events emitted for completion and permission alerts | P95 <= 30 seconds |
| Worker recovery | `worker_recovery_success_rate` | `job.fail_stale`, `job.fail_orphaned`, `job.fail_worker_offline`, and `worker.offline_heartbeat_expired` events | 100%; any miss is P1 |
| Codex exec fallback count | `weekly_codex_exec_fallback_count` | degraded execution events emitted by Autopilot or worker fallback paths | Target 0 per week; >2 triggers a focused reliability task |

## Structured Event Contract

Recovery and failure events must be queryable without parsing human text.

### Job Recovery Events

`job.fail_stale`, `job.fail_orphaned`, and `job.fail_worker_offline` must include:

- `type`
- `worker_id`
- `job_id`
- `kind`
- `reason`
- `recovery_action`

The event `source_type` remains `job`, and `source_id` is the recovered job id.

Allowed `reason` values for the current WS-A slice:

- `claimed_job_timeout`
- `worker_restart_without_active_job`
- `worker_heartbeat_expired`

Allowed `type` values:

- `stale_job`
- `worker_offline`

Allowed `recovery_action` values:

- `failed_unblock_queued_input`

### Worker Offline Events

`worker.offline_heartbeat_expired` must include:

- `type`
- `worker_id`
- `job_id`
- `reason`
- `heartbeat_offline_seconds`

Allowed `reason` values:

- `heartbeat_expired`

### Dispatch Failure Events

`job.dispatch_failed` records user-visible dispatch rejection before returning
409. It must include:

- `type`
- `worker_id`
- `job_id`
- `reason`
- `code`
- `action`
- `backend`
- `session_id`
- `workspace_root`

Allowed `type` values:

- `dispatch_failed`

Allowed `reason` values for the current WS-A slice:

- `worker_unavailable`
- `worker_offline`
- `worker_backend_unavailable`

### Notification Delivery Events

When `AGENTHUB_NOTIFICATION_WEBHOOK_URL` is configured, user-visible
completion, approval, dispatch-failure, worker-offline, and stale-job events
must attempt a bounded webhook delivery. Notification delivery failure must
never fail or roll back the source job/permission/recovery flow.

`notification.delivery_failed` must include:

- `notification_type`
- `attempts`
- `target_host`
- `reason`
- `retry_exhausted`

Allowed `notification_type` values for the current WS-A slice:

- `job.complete`
- `job.dispatch_failed`
- `job.fail_orphaned`
- `job.fail_stale`
- `job.fail_worker_offline`
- `permission.request`
- `worker.offline_heartbeat_expired`

## Operator Query Surface

Operators can filter recent events without parsing human text:

```text
GET /api/events?payload_type=stale_job&worker_id=<worker-id>&reason=claimed_job_timeout
GET /api/events?event_type=job.dispatch_failed&payload_type=dispatch_failed
```

## Measurement Rules

The A5 script (`periodic_jobs/autopilot/src/slo_report.py`) reads the
read-only API endpoint:

```text
GET /api/events/slo-source?days=7&limit=10000
```

and emits JSON with the field names in the Metrics table plus a short Chinese
paragraph suitable for daily reports. Daily reports must quote the script
output directly.

Tests in `apps/api/tests/fault_injection/` remain the executable source of
truth for the recovery event fields.
