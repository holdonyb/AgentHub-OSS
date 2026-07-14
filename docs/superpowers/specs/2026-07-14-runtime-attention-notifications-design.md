# Runtime, Attention, and Notification State Design

## Goal

Make AgentHub's session state and notifications predictable across browsers, Android installs, and multiple user devices without breaking existing workers or existing SQLite data.

## Problem

The legacy `AgentSession.status` field currently mixes two different questions:

- Is the agent idle, queued, running, waiting for input, failed, or terminated?
- Does a user need to notice a completion, approval request, or failure?

Web and Android then infer notifications from the current session and permission snapshots. Delivery and read state live in browser local storage or Android preferences. That causes repeated old notifications after reinstall or device changes, while a transient state can disappear before a client sees it.

## State Model

Keep `status` as the compatibility field accepted from existing workers. Add server-owned projections:

- `execution_status`: `unknown`, `idle`, `queued`, `running`, `waiting_input`, `failed`, `terminated`
- `execution_status_source`: `legacy`, `job`, `permission`, `worker`, `recovery`, `user`
- `execution_status_seq`: monotonically increasing per session
- `execution_status_observed_at`: server observation time
- `attention_status`: `none`, `unseen`, `seen`
- `attention_reason`: empty, `completion`, `approval`, or `failure`
- `attention_revision`: monotonically increasing per session
- `attention_changed_at`: server transition time

Compatibility mapping:

| Legacy status | Execution status |
| --- | --- |
| `ready` | `idle` |
| `queued` | `queued` |
| `running` | `running` |
| `needs_reply` | `waiting_input` |
| `failed` | `failed` |
| `terminated` | `terminated` |

Transition rules:

- `running` or `queued` to `ready` creates unseen `completion` attention.
- `needs_reply` creates unseen `approval` attention.
- `failed` creates unseen `failure` attention.
- returning to active work clears old attention.
- opening the relevant session marks its attention as seen.
- stale observations with an older sequence never replace newer state.

## Notification Ledger

Add a `notification_records` table scoped by space and recipient user. Each record contains a stable transition key, source session or permission, title/body, lifecycle status, and delivery/read timestamps.

Lifecycle:

`pending -> delivered -> read -> acknowledged`

`dismissed` and `superseded` are terminal alternatives. A unique `(space_id, recipient_user_id, transition_key)` constraint makes notification creation idempotent.

The audit event path creates records for:

- permission/request-user-input events
- session completion
- session failure

The notification API returns ordered records and supports delivered, read, acknowledge, dismiss, and read-all mutations. All endpoints are user-only and space-scoped. Worker tokens cannot read the ledger.

## Client Behavior

Web and Android use the server ledger as authority. Local storage/preferences remain only as a compatibility fallback for servers that do not expose the new endpoint.

- Browser notification and Android system notification delivery call the delivered endpoint.
- Opening a notification marks it read and navigates to its session.
- Opening a session marks related attention seen.
- Clients merge session updates only when state revisions are not older than the local revision.
- An active session does not generate another visible alert for an already delivered transition.

## Migration and Safety

- Existing `status` values remain unchanged.
- New columns have defaults and are backfilled from legacy status.
- Existing pending permission requests are backfilled into the per-user ledger at startup; historical completions are not replayed.
- Existing SQLite installs are upgraded through Alembic and the startup compatibility path.
- Notification records contain summaries and identifiers, not transcript bodies or secrets.
- No production deployment is performed from the feature worktree. Deployment can happen only after merge to `main`, CI, and a database backup.

## Verification

- Legacy sessions serialize with the projected execution state.
- State sequences and attention revisions are monotonic.
- One transition creates one notification per space member.
- A second device sees the same read/delivery state.
- Worker tokens cannot access notification endpoints.
- Old SQLite databases gain the new columns and table without losing rows.
- Web and Android no longer notify from stale current-state snapshots when the server ledger is available.
