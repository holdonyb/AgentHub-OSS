# Fault Injection Tests

These tests implement the E1 reliability scenarios from
`docs/RELIABILITY_SLO.md`.

Run all scenarios:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m all_scenarios -q
```

Run FI-1 only:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m fi_1 -q
```

Run FI-2 only:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m fi_2 -q
```

Run FI-3 only:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m fi_3 -q
```

Run FI-4 only:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m fi_4 -q
```

Run FI-5 only:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/fault_injection -m fi_5 -q
```

FI-1 currently covers the control-plane recovery contract for a worker that dies
or restarts after claiming a job: the active job must be recovered into a
terminal state, the target session must unblock, late zombie completion must be
rejected, and a structured recovery event must be written.

FI-2 currently covers the control-plane recovery contract for a temporary
network or heartbeat gap shorter than the offline timeout: the running job must
not be falsely failed, the worker must recover on the next heartbeat, completion
must still succeed, and the session timeline sequence must remain monotonic.

FI-3 currently covers the control-plane persistence contract for an API restart
while a worker job is in flight: the restarted API must still show the running
job, accept the legitimate worker completion, reject duplicate completion, write
exactly one completion event, and expose the final succeeded job / ready session
state to clients.

FI-4 currently covers concurrent control-plane dispatch: ten sessions are
created and queued concurrently, the worker claims each unique job exactly once,
all jobs reach a terminal succeeded state, all sessions return to ready, and the
run fails if SQLite lock or duplicate-job behavior appears.

FI-5 currently covers notification-channel failure: a configured completion
notification webhook returns 500 on every attempt, AgentHub retries the bounded
number of attempts, records a structured `notification.delivery_failed` event,
and still returns the job/session to the correct final state.

Scenario runs write machine-readable evidence to
`apps/api/tests/fault_injection/reports/` by default. Override with
`AGENTHUB_FAULT_REPORT_DIR` when CI should collect reports from a custom path.
