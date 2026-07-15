# Per-device Background Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver approval, failure, and completion notifications to each registered Android/iOS device even when another AgentHub client is open.

**Architecture:** Preserve `NotificationRecord` as user inbox state and add `PushDevice` plus `NotificationDelivery` for device transport. A bounded server dispatcher sends Expo Push tickets and receipts while React Native registers a stable device/token and keeps local polling as a compatibility fallback.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, httpx, Expo Notifications, React Native, Jest, pytest.

---

### Task 1: Device registry and delivery schema

**Files:**
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/schemas.py`
- Create: `apps/api/alembic/versions/0007_per_device_push_delivery.py`
- Modify: `apps/api/app/core/database.py`
- Create: `apps/api/tests/test_push_devices.py`
- Modify: `apps/api/tests/test_database_compatibility.py`

- [ ] Write failing API and compatibility tests for device upsert ownership, redacted responses, revocation, fresh schema, and upgrade schema.
- [ ] Run `pytest apps/api/tests/test_push_devices.py apps/api/tests/test_database_compatibility.py -q` and confirm failures are caused by missing models/routes.
- [ ] Add `PushDevice` and `NotificationDelivery`, migration `0007`, schemas, and compatibility indexes.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Authenticated device API and no historical replay

**Files:**
- Create: `apps/api/app/routers/push_devices.py`
- Modify: `apps/api/app/main.py`
- Modify: `apps/api/app/core/notifications.py`
- Modify: `apps/api/tests/test_push_devices.py`
- Modify: `apps/api/tests/test_notification_ledger.py`

- [ ] Add failing tests proving registration does not backfill old records, new notifications create one row per enabled device, Web delivery does not change device delivery, and revoked devices receive no new rows.
- [ ] Run focused tests and confirm the missing behavior fails.
- [ ] Implement user-scoped upsert/list/revoke endpoints and delivery row creation in the same transaction as notification persistence.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Expo ticket and receipt dispatcher

**Files:**
- Create: `apps/api/app/core/push_dispatcher.py`
- Modify: `apps/api/app/core/config.py`
- Modify: `apps/api/app/main.py`
- Create: `apps/api/tests/test_push_dispatcher.py`
- Modify: `.env.example`

- [ ] Add failing transport-injected tests for successful tickets, transient retry, malformed provider responses, receipt success, and `DeviceNotRegistered` disabling.
- [ ] Run `pytest apps/api/tests/test_push_dispatcher.py -q` and confirm failures are due to the missing dispatcher.
- [ ] Implement bounded claim/send/receipt passes and an optional API lifecycle loop controlled by configuration.
- [ ] Re-run dispatcher and notification tests.

### Task 4: React Native registration and revocation

**Files:**
- Modify: `apps/mobile-native/package.json`
- Modify: `apps/mobile-native/app.json` or create `apps/mobile-native/app.config.ts`
- Modify: `apps/mobile-native/src/api/mobileApi.ts`
- Modify: `apps/mobile-native/src/api/mobileApi.test.ts`
- Create: `apps/mobile-native/src/notifications/pushRegistration.ts`
- Create: `apps/mobile-native/src/notifications/pushRegistration.test.ts`
- Modify: `apps/mobile-native/src/notifications/useNativeNotificationGuard.ts`
- Modify: `apps/mobile-native/src/notifications/useNativeNotificationGuard.test.tsx`
- Modify: the existing logout owner in `apps/mobile-native/src/`

- [ ] Add failing tests for stable device id, absent project id, denied permission, successful upsert, idempotent refresh, and logout revocation.
- [ ] Run focused Jest tests and confirm expected failures.
- [ ] Add Expo token acquisition and authenticated registration without exposing the push token in UI state.
- [ ] Keep current ledger polling when registration is unavailable.
- [ ] Re-run React Native tests and typecheck.

### Task 5: Documentation, regression, and real-device gate

**Files:**
- Modify: `apps/mobile-native/README.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/TESTING.md`
- Modify: `PROJECT_STATUS.md`

- [ ] Document Expo project/credential setup, optional self-host behavior, token privacy, and troubleshooting.
- [ ] Add a physical-device smoke checklist covering terminated app, locked screen, tap deep-link, permission disabled, and token revocation.
- [ ] Run API full tests, React Native full tests/typecheck, Web tests/build, migration replay, `git diff --check`, public audit, and secret scan.
- [ ] Commit, push, open a PR closing issue #107, and wait for all required checks.
- [ ] Merge only after checks pass; deploy only from merged `main` after a consistent SQLite backup.

