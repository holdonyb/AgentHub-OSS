# AgentHub Multi-Tenant And Relay Plan

## Goal

AgentHub should support two deployment shapes:

- Private deployment: one owner runs a control plane for personal/family use.
- SaaS deployment: one hosted control plane relays Web/APK/desktop clients to each user's own workers.

Both shapes need the same isolation primitive: a private `space`.

## Current State

AgentHub already has multiple users and global roles: `owner`, `admin`, `operator`, `viewer`.

It is not yet safe multi-tenant isolation because workers, sessions, jobs, permissions, events, memory, providers, and schedules are global resources. A viewer/operator can see or act on resources outside their intended personal scope.

## Target Model

Add `spaces` as the primary isolation boundary.

- `server_owner`: manages deployment, billing/quota, global abuse controls, and break-glass support.
- `space_owner`: owns one private space and its workers/sessions.
- `space_admin`: manages users and workers inside one space.
- `space_operator`: can reply, approve, start/fork sessions, and create allowed jobs in one space.
- `space_viewer`: read-only access inside one space.

Users can belong to multiple spaces. Every request resolves an active `space_id`; all business queries and mutations are filtered by it.

## Data Model Changes

Add tables:

- `spaces`: `space_id`, `name`, `slug`, `mode`, `created_by`, `created_at`, `archived_at`
- `space_memberships`: `space_id`, `user_id`, `role`, `created_at`
- `worker_enrollments`: one-time or short-lived tokens for registering a worker into one space
- `notification_devices`: APK/browser/desktop notification tokens per user and space
- `space_quotas`: max workers, sessions, queued jobs, voice upload size, transcript bytes

Add `space_id` to:

- workers
- agent_sessions
- agent_timeline
- agent_permissions
- provider_snapshots
- jobs
- events
- memories
- schedules
- invites
- access_tokens

Use composite uniqueness where needed:

- workers: `(space_id, worker_id)`
- sessions: `(space_id, session_id)`
- memory entries: `(space_id, namespace, observation, source)`

## API Rules

All user APIs must require a current space and filter by it.

Examples:

- `GET /api/sessions` returns only sessions in the active space.
- `POST /api/sessions/{id}/input` verifies the session belongs to the active space.
- `GET /api/workers` returns only workers in the active space.
- `POST /api/permissions/{id}/respond` verifies permission, session, and worker share the active space.
- PATs carry allowed `space_id` and scopes.

Worker APIs must be space-bound:

- worker token authenticates both `worker_id` and `space_id`
- worker can claim only jobs in its own space
- worker can publish only sessions/timeline/permissions for its own space
- worker registration uses a space-scoped enrollment token

## Worker Connection Modes

### Private Mode

Worker talks to the API through Tailscale/private URL.

This is safest for personal/private deployment and should stay the default.

### Public Relay Mode

Worker talks outbound HTTPS to the SaaS/control-plane relay.

Requirements:

- expose a dedicated public worker path, for example `/api/worker/*`
- keep `/api/internal/*` private/blocked
- require worker token on every call
- bind token to `space_id + worker_id`
- rate limit registration, heartbeat, claim, complete, fail, timeline, permission endpoints
- audit every worker registration and anomalous claim/fail pattern

No inbound port is opened on the user's machine. Their worker only polls outbound.

## Worker Install UX

Both Windows and Linux workers exist today:

- Windows: `workers/local-windows`
- Linux: `workers/local-linux`

The product should add an "Add Worker" wizard:

- choose OS: Windows / Linux
- choose backend: Codex / Claude / Kimi / auto-detect
- choose connection mode: Tailscale private / public relay
- generate one-time enrollment token
- show copyable install command
- show QR code for APK-to-desktop pairing later

Future packaging:

- Windows: signed installer plus scheduled task
- Linux: install script plus systemd service
- Docker: optional worker container for VM/server use

## Notification Plan

Local APK notifications are useful for the current private app, but SaaS needs server-driven notification delivery.

Add notification pipeline:

- API writes `notification_events` when a session enters `needs_reply`, a job fails, or a long-running job completes.
- Web/APK/desktop register `notification_devices`.
- Private deployment can use WebSocket/SSE while the app is open.
- APK should support push provider tokens where available.
- For China Android devices, keep a fallback foreground/polling service option because FCM may not be reliable on all phones.

Notification delivery must be per user and per space. Never notify another space's users about private sessions.

## Storage And Concurrency

SQLite is acceptable for personal use. Multi-user/SaaS should move to PostgreSQL.

Required changes:

- atomic job claim with row locks or equivalent update conditions
- DB-backed or Redis-backed rate limits
- per-space quotas
- stale running job recovery per space
- transcript storage limits and cleanup policy
- encrypted secret storage for worker enrollment and PAT metadata

## Implementation Order

1. Add `spaces` and `space_memberships`; migrate current data into one default owner space.
2. Add `space_id` to all business tables and API serializers.
3. Enforce current-space filtering in every user route.
4. Bind worker tokens and worker claim/complete/fail to `space_id`.
5. Add tenant-isolation tests for every route.
6. Add Add Worker wizard and enrollment tokens.
7. Add public worker relay path while keeping `/api/internal/*` private.
8. Move production DB to PostgreSQL.
9. Add server-driven notification events and device tokens.
10. Add SaaS quotas, audit views, and abuse controls.

## Non-Goals For The First Isolation Pass

- Billing
- public self-signup
- arbitrary shell jobs
- cross-space sharing
- end-to-end encrypted transcript storage
