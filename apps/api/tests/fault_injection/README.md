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

FI-1 currently covers the control-plane recovery contract for a worker that dies
or restarts after claiming a job: the active job must be recovered into a
terminal state, the target session must unblock, late zombie completion must be
rejected, and a structured recovery event must be written.

Scenario runs write machine-readable evidence to
`apps/api/tests/fault_injection/reports/` by default. Override with
`AGENTHUB_FAULT_REPORT_DIR` when CI should collect reports from a custom path.
