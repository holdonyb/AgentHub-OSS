# Runtime, Attention, and Notification State Implementation Plan

1. Add failing API tests for legacy-state projection, monotonic revisions, notification idempotency, user/space isolation, lifecycle mutations, and SQLite compatibility.
2. Add session state fields and the notification ledger model, migration, compatibility upgrade, schemas, and state transition helpers.
3. Route existing job, permission, recovery, and user session mutations through the transition helper while preserving the legacy `status` contract.
4. Add space-scoped notification list and lifecycle endpoints and create notifications from stable audit transitions.
5. Add protocol types and failing Web tests for server-ledger loading, delivery acknowledgement, read state, navigation, fallback, and stale revision rejection.
6. Update Web notification behavior to prefer the ledger while preserving compatibility with old servers.
7. Add Android tests and update the foreground service to poll the ledger, acknowledge delivery, and retain the old sync path only as fallback.
8. Run focused tests, full API/Web/mobile suites, builds, migration compatibility checks, and `git diff --check`.
9. Review the diff, update durable project status, commit, push, open a PR, and merge/deploy only after CI is green.
