# Runtime Cockpit Design

## Goal

Add an attention-first runtime cockpit to AgentHub so a user can see every agent across every worker at a glance, identify the sessions that need intervention, and return to the existing Session or Workbench surface in one action.

The design distills three useful ideas from Herdr: explicit agent attention states, persistent session switching, and compact keyboard/touch navigation. It does not copy Herdr source code or implement a terminal multiplexer. Herdr is an AGPL terminal application; AgentHub remains a self-hosted multi-worker control plane with scoped worker operations.

## Product Boundary

The cockpit is a projection over existing `AgentSession`, `Worker`, and `AgentTask` data. It does not introduce another runtime, transcript store, task model, or status authority.

Included:

- Group active sessions into `attention`, `working`, `done`, `idle`, and `offline` lanes.
- Prefer user-attention state over execution state when a session needs input or approval.
- Show backend, worker, project, last activity, and a concise current summary.
- Show why a state was assigned and when its source was updated.
- Open the existing Session view for conversation and controls.
- Open the existing Workbench task when a cockpit item represents a task.
- Provide a compact mobile switcher with touch targets at least 44px high.
- Preserve keyboard navigation and visible focus on desktop.

Excluded:

- Browser PTY streaming or arbitrary remote shell.
- Terminal pane creation, splitting, or process injection.
- A plugin marketplace or agent-executable socket API.
- Replacing current Session and Workbench screens.
- Inferring state from rendered transcript strings when authoritative fields exist.

## State Projection

The client derives one `RuntimeCockpitItem` for each non-archived session.

Classification precedence for each session:

1. `attention`: unresolved permission, `needs_reply`, or explicit user-attention state.
2. `offline`: owning worker is offline or missing.
3. `working`: session execution state is `queued` or `running`.
4. `done`: the latest execution reached a terminal state and has unseen output.
5. `idle`: ready, terminated, or otherwise not active.

The default display order is `attention`, `working`, `done`, `idle`, then `offline`. Offline ownership still overrides execution state during classification, but offline sessions stay at the end of the list so stale machines cannot crowd active work out of the first viewport.

Each item carries `stateReason` and `stateUpdatedAt`. The UI displays these as product-facing labels and relative time; it does not expose implementation diagnostics by default.

The projection is a pure TypeScript module with deterministic tests. It accepts current sessions, workers, and pending permissions and returns stable lane ordering. Items inside a lane are sorted by latest activity descending, then by session ID for deterministic output.

## Interaction Model

The top-level mode switch becomes `Cockpit | Workbench | Session` on desktop. On mobile it remains compact and horizontally scrollable without widening the viewport.

Selecting a cockpit session:

1. Sets the existing selected session.
2. Switches to Session mode.
3. Opens the thread pane on mobile.
4. Uses the existing timeline refresh path; it does not create a new fetch loop.

The cockpit includes lane filters and a single list/detail layout. Empty lanes stay hidden. A global empty state appears only when there are no non-archived sessions.

## Safety And Reliability

- All actions reuse existing RBAC-protected APIs.
- No cockpit action sends input, starts a shell, or changes controls implicitly.
- Offline state is based on the server-projected worker state, not browser reachability.
- Stale sync responses remain governed by existing session revision handling.
- A cockpit rendering failure cannot block Session mode; the projection returns an empty result for invalid optional metadata.

## Testing

- Unit tests for priority, offline handling, deterministic sort, and archived-session exclusion.
- Web tests for mode switching and opening a session from the cockpit.
- Mobile layout tests for viewport containment, horizontal mode-switch scrolling, and 44px touch targets.
- Existing Web, API, React Native, compatibility Android, and desktop suites remain required before merge.
- Playwright screenshots at desktop and 390x844 verify hierarchy, contrast, scrolling, and no overlap.

## Follow-up, Not This Slice

A later capability-gated live terminal surface may be evaluated against existing PSMUX/tmux bridges. It requires a separate threat model, protocol, bounded output transport, and worker capability contract. It is not a UI-only extension and is deliberately excluded from this slice.
