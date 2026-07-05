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

Allowed `recovery_action` values:

- `failed_unblock_queued_input`

### Worker Offline Events

`worker.offline_heartbeat_expired` must include:

- `worker_id`
- `reason`
- `heartbeat_offline_seconds`

Allowed `reason` values:

- `heartbeat_expired`

## Measurement Rules

The future A5 script (`slo_report.py`) must emit JSON with the field names in
the Metrics table and a short Chinese paragraph suitable for daily reports.
Daily reports must quote the script output directly.

Until A5 lands, tests in `apps/api/tests/fault_injection/` are the executable
source of truth for the recovery event fields.
