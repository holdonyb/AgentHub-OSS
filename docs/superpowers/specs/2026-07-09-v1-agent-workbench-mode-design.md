# AgentHub 1.0 Agent Workbench Mode Design

Date: 2026-07-09
Branch: `v1/agent-workbench`

## Decision

AgentHub 1.0 adds a new **Workbench Mode** without removing or downgrading the existing **Session Mode**.

The top app chrome owns a global mode switch:

```text
Workbench | Session
```

Switching modes changes the entire main interface, not just the left navigation filter.

- **Workbench Mode**: async task control plane. The primary object is `AgentTask`.
- **Session Mode**: existing remote session/chat control console. The primary object remains `AgentSession`.

This preserves the current product while adding a first-class 1.0 work mode for delegated, asynchronous agent work.

## Why This Shape

The current AgentHub strength is already the Server / Worker / Agent Runtime split: local runtimes keep running on the user's machines, while AgentHub manages session inbox, worker connection, job queue, permissions, files, and audit events.

The 1.0 change is not to make the chat UI prettier. It is to add a task delegation layer:

```text
task brief -> worker/runtime execution -> artifacts -> review -> accept/request changes/archive
```

The existing Session Mode is still useful for live control, debugging, approvals, and ad hoc interaction. Workbench Mode is for "send the work away, come back to review".

## Non-Goals

- Do not remove the existing session/chat workflow.
- Do not make Session a hidden tab inside Task in the first 1.0 version.
- Do not publish or release this work immediately; this belongs to the 1.0 branch.
- Do not make a Factorio-style pipeline the default UI. Pipeline/debug visualization can come later as an advanced diagnostic view.
- Do not build multi-agent autonomous orchestration before the one-person async task loop works.

## Information Architecture

### Global Chrome

The top bar contains:

- AgentHub brand / current space
- Global mode switch: `Workbench | Session`
- Shared status entry points: review count, approval count, worker health, settings

The selected mode is a user preference. Existing installs should not be forced into Workbench unexpectedly.

Recommended default:

- Existing users with active sessions: keep Session Mode as default until they switch.
- New/empty installs: default to Workbench Mode, with a clear path to Session Mode.

### Workbench Mode

Primary layout:

```text
Top chrome
  Workbench selected

Left pane: Task Inbox
  Ready to Review
  Blocked
  Working
  Queued
  Draft
  Archived

Middle pane: Task list
  status, title, worker, backend, workspace, latest result

Right pane: Task detail
  Brief
  Artifacts
  Review
  Approvals
  Sessions
  Files
  Events
```

Primary actions:

- New Task Brief
- Accept
- Request Changes
- Archive
- Open related session
- Open artifact
- Approve / deny blocked action

### Session Mode

Session Mode keeps the current mental model:

```text
Top chrome
  Session selected

Session list
Thread / timeline
Controls
Files
Workers
Permissions
```

Session Mode may display whether a session is linked to a task, but it does not require a task.

## Domain Model

### AgentTask

`AgentTask` is the new human-facing unit of delegated work.

```ts
type TaskStatus =
  | "draft"
  | "queued"
  | "working"
  | "blocked"
  | "needs_approval"
  | "ready_to_review"
  | "accepted"
  | "rejected"
  | "archived"
  | "failed";

interface AgentTask {
  task_id: string;
  space_id: string;
  title: string;
  brief_markdown: string;
  success_criteria_markdown: string;
  status: TaskStatus;
  priority: number;
  target_worker_id?: string | null;
  backend?: string | null;
  workspace_root?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  due_at?: string | null;
}
```

Relationship model:

```text
AgentTask
  -> Job(s)
  -> Session(s)
  -> Timeline
  -> Artifact(s)
  -> Permission(s)
  -> Event(s)
```

This does not replace existing `AgentSession`. It adds a higher-level object above it.

### Artifact

Artifacts are the review surface for completed work.

```ts
type ArtifactKind =
  | "report"
  | "diff"
  | "test_result"
  | "screenshot"
  | "log"
  | "document"
  | "patch"
  | "build_output"
  | "review_note";

interface Artifact {
  artifact_id: string;
  task_id: string;
  kind: ArtifactKind;
  title: string;
  path?: string | null;
  content_markdown?: string | null;
  mime_type?: string | null;
  created_by: "agent" | "human" | "system";
  created_at: string;
  version: number;
}
```

The user should review artifacts before reading raw chat logs.

## Task Brief Composer

Workbench Mode replaces one-line chat-first input with a structured task brief.

Required fields:

- Title
- Task brief
- Success criteria
- Target worker or auto-select
- Backend/runtime
- Workspace root or project path

Optional fields:

- Relevant file paths
- Attachments
- Deadline
- Budget
- Interruption policy
- Authority scope

Minimum composer flow:

```text
New Task
  -> write brief and success criteria
  -> select workspace / worker / backend
  -> choose authority preset
  -> submit
```

On submit, AgentHub creates an `AgentTask`, then reuses the existing job/session execution path.

## Workspace Task Folder

1.0 should introduce a workspace-readable task folder protocol, but it can be phased in after the initial task UI lands.

Recommended path:

```text
.agenthub/tasks/<task_id>/
  task.md
  agenthub.task.json
  status.md
  report.md
  artifacts/
  logs/
```

Purpose:

- `task.md`: human-readable brief and success criteria.
- `agenthub.task.json`: machine-readable metadata, allowed paths, and authority settings.
- `status.md`: progress notes for async recovery.
- `report.md`: final delivery report.
- `artifacts/`: screenshots, diffs, test outputs, generated docs.

This turns the workspace into an Office Desk instead of relying only on chat history.

## Permission And Authority

1.0 should keep current permission mechanisms but start moving permission policy toward task-level authority.

Initial authority presets:

- Read-only research
- Code fix
- Feature implementation
- Review only

Longer-term model:

```ts
interface AuthorityScope {
  can_read_paths: string[];
  can_write_paths: string[];
  can_run_commands: string[];
  can_create_branch: boolean;
  can_commit: boolean;
  can_push: boolean;
  can_install_dependencies: boolean;
  can_access_network: boolean;
  can_use_secrets: string[];
  destructive_actions: "forbidden" | "ask" | "allowed";
}
```

The 1.0 MVP may store this as structured metadata before every runtime fully enforces it.

## Exception Routing

Workbench Mode should notify humans about exceptions and review moments, not routine progress.

Do not interrupt for:

- routine file reads
- ordinary tool calls
- normal test runs
- minor status updates

Interrupt or surface prominently for:

- task ready to review
- task blocked on missing context
- permission approval needed
- repeated failure
- budget or time limit reached
- destructive action request
- runtime authentication failure

## MVP Execution Flow

The smallest useful 1.0 loop:

```text
User creates task brief
  -> API stores AgentTask
  -> API creates existing session_start/session_input job
  -> Worker starts or resumes runtime
  -> Runtime receives task brief
  -> Existing timeline keeps recording execution
  -> Runtime writes final report or assistant final message
  -> AgentHub creates report artifact
  -> Task moves to ready_to_review
  -> User accepts / requests changes / archives
```

This avoids a runtime rewrite while changing the product-level object from session-first to task-first in Workbench Mode.

## Implementation Phases

### Phase 1: Product Shell And Task MVP

- Add app-level mode switch.
- Preserve existing Session Mode route/state.
- Add Task Inbox, Task list, Task detail shell.
- Add `AgentTask` API and persistence.
- Link task to one or more existing sessions/jobs.
- Add basic report artifact.

### Phase 2: Workspace Task Folder

- Worker creates `.agenthub/tasks/<task_id>/task.md`.
- Runtime prompt instructs agent to read/write task files.
- Worker collects `report.md` and known artifacts.
- Task review uses artifacts first, sessions second.

### Phase 3: Templates And Authority Presets

- Add task templates: Fix Bug, Implement Feature, Code Review, Release Assistant.
- Add authority presets.
- Add request-changes loop.
- Add exception routing filters.

### Phase 4: Pipeline Debugger

- Add optional advanced flow view for debugging task execution.
- Show job/session/artifact/event relationships.
- Keep it outside the default user path.

## Validation

Design acceptance:

- Current Session Mode still works and remains reachable through the top switch.
- Workbench Mode can create a task, run it through existing worker/session infrastructure, and reach Ready to Review.
- A user can review artifacts without reading the whole chat transcript.
- A blocked task appears in Workbench and can route to approval/session detail.

Technical validation:

- API tests for task CRUD and task-session linkage.
- Web tests for mode switch persistence and no regression to existing session UI.
- Worker/API tests for task brief dispatch through existing job queue.
- Artifact tests for report creation and rendering.
- `npm run web:test`, `npm run web:build`, and relevant API tests before landing implementation.

## Open Decisions

- Exact persistence location for app mode preference: browser local storage only, user profile, or both.
- Whether new installs default to Workbench immediately or after a short onboarding screen.
- Whether `request changes` creates a new session input on the same session or forks a new task attempt.
- Which authority presets must be enforced in 1.0 versus displayed as declared intent.
