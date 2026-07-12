# V1 Agent Workbench Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AgentHub 1.0 Workbench Mode as a top-level mode beside the existing Session Mode, with a task brief -> existing session job -> report artifact -> review loop.

**Architecture:** Keep current Session Mode intact. Add `AgentTask`, `AgentTaskExecution`, and `AgentArtifact` as a thin domain layer over existing jobs/sessions, using `payload.task_id` to connect worker job completion back to task state. The Web app gets an app-level `Workbench | Session` switch; Workbench consumes new task APIs while Session continues using existing session state and UI.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite-compatible bootstrap migrations, Pydantic, React, TypeScript, Vitest, pytest.

---

## Scope Boundary

This plan implements Phase 1 from the design spec:

- global mode switch
- task model and API
- task creation dispatching through existing `session_start` jobs
- report artifact creation when a task job completes or fails
- Workbench shell with task inbox, task detail, and review actions
- existing Session Mode preserved

This plan does not implement `.agenthub/tasks/<task_id>/` workspace folders, task templates, task-level command enforcement, or pipeline debugger. Those are later phases after the first task loop works.

## Files

- Modify: `packages/protocol/ts/src/index.ts`
- Modify: `packages/protocol/agenthub_protocol/models.py`
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/schemas.py`
- Modify: `apps/api/app/services.py`
- Modify: `apps/api/app/core/database.py`
- Create: `apps/api/app/routers/tasks.py`
- Modify: `apps/api/app/routers/internal.py`
- Modify: `apps/api/app/main.py`
- Create: `apps/api/tests/test_tasks.py`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/superpowers/specs/2026-07-09-v1-agent-workbench-mode-design.md` only if implementation discovers a design correction

## Shared Names

Use these exact names across backend, protocol, and web code.

```ts
export type AppMode = 'workbench' | 'session';

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'working'
  | 'blocked'
  | 'needs_approval'
  | 'ready_to_review'
  | 'accepted'
  | 'rejected'
  | 'archived'
  | 'failed';

export type ArtifactKind =
  | 'report'
  | 'diff'
  | 'test_result'
  | 'screenshot'
  | 'log'
  | 'document'
  | 'patch'
  | 'build_output'
  | 'review_note';
```

---

### Task 1: Protocol And Backend Domain Model

**Files:**
- Modify: `packages/protocol/ts/src/index.ts`
- Modify: `packages/protocol/agenthub_protocol/models.py`
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/schemas.py`
- Modify: `apps/api/app/services.py`
- Modify: `apps/api/app/core/database.py`
- Test: `apps/api/tests/test_tasks.py`

- [ ] **Step 1: Write the failing API model test**

Create `apps/api/tests/test_tasks.py` with:

```python
from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_task_create_list_and_detail_contract(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "修复登录页移动端布局",
            "brief_markdown": "登录页在 390px 宽度下按钮遮挡。",
            "success_criteria_markdown": "- npm run web:test passes\n- 390px no overlap",
            "target_worker_id": worker["worker"]["worker_id"],
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "controls": {"sandbox_mode": "workspace-write"},
            "submit": False,
        },
    )

    assert response.status_code == 200, response.text
    task = response.json()["task"]
    assert task["task_id"].startswith("tsk_")
    assert task["status"] == "draft"
    assert task["title"] == "修复登录页移动端布局"
    assert task["artifact_count"] == 0
    assert task["latest_job_id"] is None

    listed = client.get("/api/tasks", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["task_id"] == task["task_id"]

    detail = client.get(f"/api/tasks/{task['task_id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["task_id"] == task["task_id"]
    assert detail.json()["artifacts"] == []
    assert detail.json()["executions"] == []
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py::test_task_create_list_and_detail_contract -q
```

Expected: fail with `404 Not Found` for `/api/tasks` or import errors for missing task schemas.

- [ ] **Step 3: Add TypeScript protocol types**

Modify `packages/protocol/ts/src/index.ts` after `Event` with:

```ts
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'working'
  | 'blocked'
  | 'needs_approval'
  | 'ready_to_review'
  | 'accepted'
  | 'rejected'
  | 'archived'
  | 'failed';

export type ArtifactKind =
  | 'report'
  | 'diff'
  | 'test_result'
  | 'screenshot'
  | 'log'
  | 'document'
  | 'patch'
  | 'build_output'
  | 'review_note';

export interface AgentTask {
  task_id: string;
  space_id: string | null;
  title: string;
  brief_markdown: string;
  success_criteria_markdown: string;
  status: TaskStatus;
  priority: number;
  target_worker_id: string | null;
  backend: string | null;
  workspace_root: string | null;
  namespace: string;
  latest_job_id: string | null;
  latest_session_id: string | null;
  artifact_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  archived_at: string | null;
  metadata: Record<string, unknown>;
}

export interface AgentTaskExecution {
  execution_id: string;
  task_id: string;
  job_id: string | null;
  session_id: string | null;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentArtifact {
  artifact_id: string;
  task_id: string;
  kind: ArtifactKind;
  title: string;
  path: string | null;
  content_markdown: string | null;
  mime_type: string | null;
  created_by: 'agent' | 'human' | 'system';
  created_at: string;
  version: number;
}
```

- [ ] **Step 4: Add Python protocol models**

Modify `packages/protocol/agenthub_protocol/models.py` after `JobResult` with:

```python
TaskStatus = Literal[
    "draft",
    "queued",
    "working",
    "blocked",
    "needs_approval",
    "ready_to_review",
    "accepted",
    "rejected",
    "archived",
    "failed",
]
ArtifactKind = Literal[
    "report",
    "diff",
    "test_result",
    "screenshot",
    "log",
    "document",
    "patch",
    "build_output",
    "review_note",
]


class AgentTask(BaseModel):
    task_id: str
    title: str
    brief_markdown: str
    success_criteria_markdown: str
    status: TaskStatus
    priority: int = 100
    target_worker_id: str | None = None
    backend: str | None = None
    workspace_root: str | None = None
    namespace: str = "default"
    latest_job_id: str | None = None
    latest_session_id: str | None = None
    artifact_count: int = 0
    created_at: datetime
    updated_at: datetime
```

- [ ] **Step 5: Add SQLAlchemy models**

Modify `apps/api/app/models.py` after `AgentSession` with:

```python
class AgentTask(Base):
    __tablename__ = "agent_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("atk"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    task_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("tsk"))
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    brief_markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    success_criteria_markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    target_worker_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    backend: Mapped[str | None] = mapped_column(String(64), nullable=True)
    workspace_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    namespace: Mapped[str] = mapped_column(String(120), default="default", nullable=False)
    latest_job_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    latest_session_id: Mapped[str | None] = mapped_column(String(180), nullable=True, index=True)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentTaskExecution(Base):
    __tablename__ = "agent_task_executions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("ate"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    execution_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("tex"))
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    session_id: Mapped[str | None] = mapped_column(String(180), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(80), default="session_start", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentArtifact(Base):
    __tablename__ = "agent_artifacts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("art"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    artifact_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("art"))
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(40), default="report", index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    path: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by: Mapped[str] = mapped_column(String(32), default="system", nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
```

- [ ] **Step 6: Add Pydantic schemas**

Modify `apps/api/app/schemas.py` after `SessionStartIn` with:

```python
TaskStatus = Literal[
    "draft",
    "queued",
    "working",
    "blocked",
    "needs_approval",
    "ready_to_review",
    "accepted",
    "rejected",
    "archived",
    "failed",
]
ArtifactKind = Literal[
    "report",
    "diff",
    "test_result",
    "screenshot",
    "log",
    "document",
    "patch",
    "build_output",
    "review_note",
]


class TaskCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    brief_markdown: str = Field(min_length=1, max_length=80_000)
    success_criteria_markdown: str = Field(default="", max_length=40_000)
    target_worker_id: str | None = Field(default=None, max_length=160)
    backend: str | None = Field(default=None, max_length=64)
    workspace_root: str | None = None
    namespace: str = Field(default="default", max_length=120)
    priority: int = Field(default=100, ge=0, le=1000)
    controls: dict[str, Any] = Field(default_factory=dict)
    submit: bool = False


class TaskReviewIn(BaseModel):
    action: Literal["accept", "reject", "archive", "request_changes"]
    note_markdown: str = Field(default="", max_length=20_000)


class AgentTaskOut(BaseModel):
    space_id: str | None
    task_id: str
    title: str
    brief_markdown: str
    success_criteria_markdown: str
    status: str
    priority: int
    target_worker_id: str | None
    backend: str | None
    workspace_root: str | None
    namespace: str
    latest_job_id: str | None
    latest_session_id: str | None
    artifact_count: int
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    due_at: datetime | None
    archived_at: datetime | None
    metadata: dict[str, Any]


class AgentTaskExecutionOut(BaseModel):
    execution_id: str
    task_id: str
    job_id: str | None
    session_id: str | None
    kind: str
    status: str
    created_at: datetime
    updated_at: datetime


class AgentArtifactOut(BaseModel):
    artifact_id: str
    task_id: str
    kind: str
    title: str
    path: str | None
    content_markdown: str | None
    mime_type: str | None
    created_by: str
    created_at: datetime
    version: int
```

- [ ] **Step 7: Add output helpers**

Modify `apps/api/app/services.py` imports to include `AgentArtifact`, `AgentTask`, and `AgentTaskExecution`, then add:

```python
def task_out(task: AgentTask, *, artifact_count: int = 0) -> dict[str, Any]:
    return {
        "space_id": task.space_id,
        "task_id": task.task_id,
        "title": strip_ansi(task.title),
        "brief_markdown": strip_ansi(task.brief_markdown),
        "success_criteria_markdown": strip_ansi(task.success_criteria_markdown),
        "status": task.status,
        "priority": task.priority,
        "target_worker_id": task.target_worker_id,
        "backend": task.backend,
        "workspace_root": task.workspace_root,
        "namespace": task.namespace,
        "latest_job_id": task.latest_job_id,
        "latest_session_id": task.latest_session_id,
        "artifact_count": artifact_count,
        "created_by": task.created_by,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "due_at": task.due_at,
        "archived_at": task.archived_at,
        "metadata": sanitize_text(loads_json(task.metadata_json, {})),
    }


def task_execution_out(execution: AgentTaskExecution) -> dict[str, Any]:
    return {
        "execution_id": execution.execution_id,
        "task_id": execution.task_id,
        "job_id": execution.job_id,
        "session_id": execution.session_id,
        "kind": execution.kind,
        "status": execution.status,
        "created_at": execution.created_at,
        "updated_at": execution.updated_at,
    }


def artifact_out(artifact: AgentArtifact) -> dict[str, Any]:
    return {
        "artifact_id": artifact.artifact_id,
        "task_id": artifact.task_id,
        "kind": artifact.kind,
        "title": strip_ansi(artifact.title),
        "path": artifact.path,
        "content_markdown": strip_ansi(artifact.content_markdown or "") if artifact.content_markdown is not None else None,
        "mime_type": artifact.mime_type,
        "created_by": artifact.created_by,
        "created_at": artifact.created_at,
        "version": artifact.version,
    }
```

- [ ] **Step 8: Register compatible SQLite indexes**

Modify `_ensure_compatible_indexes` in `apps/api/app/core/database.py` by adding:

```python
"agent_tasks": [
    (
        "CREATE INDEX IF NOT EXISTS ix_agent_tasks_space_status_updated ON agent_tasks (space_id, status, updated_at DESC)",
        {"space_id", "status", "updated_at"},
    ),
],
"agent_artifacts": [
    (
        "CREATE INDEX IF NOT EXISTS ix_agent_artifacts_space_task_created ON agent_artifacts (space_id, task_id, created_at DESC)",
        {"space_id", "task_id", "created_at"},
    ),
],
"agent_task_executions": [
    (
        "CREATE INDEX IF NOT EXISTS ix_agent_task_executions_space_task_updated ON agent_task_executions (space_id, task_id, updated_at DESC)",
        {"space_id", "task_id", "updated_at"},
    ),
    (
        "CREATE INDEX IF NOT EXISTS ix_agent_task_executions_space_job ON agent_task_executions (space_id, job_id)",
        {"space_id", "job_id"},
    ),
],
```

- [ ] **Step 9: Run model test again**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py::test_task_create_list_and_detail_contract -q
```

Expected: still fail because the router is not implemented.

- [ ] **Step 10: Commit domain model**

```powershell
git add packages/protocol/ts/src/index.ts packages/protocol/agenthub_protocol/models.py apps/api/app/models.py apps/api/app/schemas.py apps/api/app/services.py apps/api/app/core/database.py apps/api/tests/test_tasks.py
git commit -m "feat: add agent task domain model"
```

---

### Task 2: Task API And Session Job Dispatch

**Files:**
- Create: `apps/api/app/routers/tasks.py`
- Modify: `apps/api/app/main.py`
- Modify: `apps/api/tests/test_tasks.py`

- [ ] **Step 1: Extend the failing tests for submit behavior**

Append to `apps/api/tests/test_tasks.py`:

```python
def test_task_submit_creates_session_start_job_and_execution(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "实现 Workbench shell",
            "brief_markdown": "新增顶部 Workbench / Session 模式开关。",
            "success_criteria_markdown": "- Session Mode still renders\n- Workbench Mode renders task inbox",
            "target_worker_id": worker["worker"]["worker_id"],
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "submit": True,
            "controls": {"sandbox_mode": "workspace-write"},
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    task = payload["task"]
    assert task["status"] == "queued"
    assert payload["job"]["kind"] == "session_start"
    assert payload["job"]["payload"]["task_id"] == task["task_id"]
    assert "AgentHub Task" in payload["job"]["payload"]["prompt"]

    detail = client.get(f"/api/tasks/{task['task_id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["executions"][0]["job_id"] == payload["job"]["job_id"]
```

- [ ] **Step 2: Run the failing submit test**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py::test_task_submit_creates_session_start_job_and_execution -q
```

Expected: fail because `tasks.py` is missing.

- [ ] **Step 3: Create task router**

Create `apps/api/app/routers/tasks.py` with:

```python
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role
from app.core.json import dumps_json
from app.models import AgentArtifact, AgentTask, AgentTaskExecution, Job, utcnow
from app.routers.sessions import _normalize_controls, _require_worker_backend_available
from app.schemas import TaskCreateIn, TaskReviewIn
from app.services import artifact_out, job_out, task_execution_out, task_out

router = APIRouter()


def _task_prompt(task: AgentTask) -> str:
    return (
        "You are executing an AgentHub Task, not chatting casually.\n\n"
        f"# AgentHub Task: {task.title}\n\n"
        "## Brief\n"
        f"{task.brief_markdown}\n\n"
        "## Success Criteria\n"
        f"{task.success_criteria_markdown or '- Produce a concise delivery report.'}\n\n"
        "## Delivery\n"
        "Work asynchronously. Only ask the user when blocked, over authority, or missing critical context. "
        "When finished, return a final report with changed files, validation, risks, and next steps."
    )


def _require_task(db: DbSession, actor: Actor, task_id: str) -> AgentTask:
    task = db.query(AgentTask).filter(AgentTask.space_id == actor.space_id, AgentTask.task_id == task_id).one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail={"message": "Task not found", "code": "TASK_NOT_FOUND"})
    return task


def _artifact_count(db: DbSession, task: AgentTask) -> int:
    return (
        db.query(func.count(AgentArtifact.id))
        .filter(AgentArtifact.space_id == task.space_id, AgentArtifact.task_id == task.task_id)
        .scalar()
        or 0
    )


def _dispatch_task(db: DbSession, actor: Actor, task: AgentTask, controls: dict[str, object]) -> Job:
    if not task.target_worker_id or not task.backend or not task.workspace_root:
        raise HTTPException(status_code=400, detail={"message": "Task needs worker, backend, and workspace before submit", "code": "TASK_DISPATCH_INCOMPLETE"})
    backend = task.backend.strip().lower()
    _require_worker_backend_available(db, actor.space_id, task.target_worker_id, backend)
    job = Job(
        space_id=actor.space_id,
        kind="session_start",
        worker_id=task.target_worker_id,
        backend=backend,
        workspace_root=task.workspace_root,
        namespace=task.namespace or "default",
        priority=task.priority,
        payload_json=dumps_json(
            {
                "task_id": task.task_id,
                "prompt": _task_prompt(task),
                "title": task.title,
                "controls": _normalize_controls(controls, backend=backend),
                "project_name": task.workspace_root.rstrip("/\\").replace("\\", "/").split("/")[-1] or "workspace",
                "namespace": task.namespace or "default",
                "start_mode": "new",
            }
        ),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    execution = AgentTaskExecution(
        space_id=actor.space_id,
        task_id=task.task_id,
        job_id=job.job_id,
        kind=job.kind,
        status=job.status,
    )
    db.add(execution)
    task.status = "queued"
    task.latest_job_id = job.job_id
    task.updated_at = utcnow()
    return job


@router.post("/api/tasks")
def create_task(payload: TaskCreateIn, db: DbSession, actor: Actor = Depends(require_min_role("operator"))):
    task = AgentTask(
        space_id=actor.space_id,
        title=payload.title.strip(),
        brief_markdown=payload.brief_markdown.strip(),
        success_criteria_markdown=payload.success_criteria_markdown.strip(),
        priority=payload.priority,
        target_worker_id=payload.target_worker_id.strip() if payload.target_worker_id else None,
        backend=payload.backend.strip().lower() if payload.backend else None,
        workspace_root=payload.workspace_root.strip() if payload.workspace_root else None,
        namespace=(payload.namespace or "default").strip() or "default",
        created_by=actor.actor_id,
        metadata_json=dumps_json({"controls": payload.controls}),
    )
    db.add(task)
    db.flush()
    job = _dispatch_task(db, actor, task, payload.controls) if payload.submit else None
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="task",
        source_id=task.task_id,
        event_type="task.create",
        payload={"submitted": bool(job)},
    )
    db.commit()
    response = {"task": task_out(task, artifact_count=0)}
    if job is not None:
        response["job"] = job_out(job)
    return response


@router.get("/api/tasks")
def list_tasks(db: DbSession, actor: Actor = Depends(require_min_role("viewer")), status: str | None = None, archived: bool = False):
    query = db.query(AgentTask).filter(AgentTask.space_id == actor.space_id)
    query = query.filter(AgentTask.archived_at.is_not(None) if archived else AgentTask.archived_at.is_(None))
    if status:
        query = query.filter(AgentTask.status == status)
    tasks = query.order_by(AgentTask.updated_at.desc(), AgentTask.created_at.desc()).all()
    counts = {
        row[0]: row[1]
        for row in db.query(AgentArtifact.task_id, func.count(AgentArtifact.id))
        .filter(AgentArtifact.space_id == actor.space_id)
        .group_by(AgentArtifact.task_id)
        .all()
    }
    return {"items": [task_out(task, artifact_count=int(counts.get(task.task_id, 0))) for task in tasks]}


@router.get("/api/tasks/{task_id}")
def get_task(task_id: str, db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    task = _require_task(db, actor, task_id)
    artifacts = (
        db.query(AgentArtifact)
        .filter(AgentArtifact.space_id == actor.space_id, AgentArtifact.task_id == task.task_id)
        .order_by(AgentArtifact.created_at.desc())
        .all()
    )
    executions = (
        db.query(AgentTaskExecution)
        .filter(AgentTaskExecution.space_id == actor.space_id, AgentTaskExecution.task_id == task.task_id)
        .order_by(AgentTaskExecution.created_at.desc())
        .all()
    )
    return {
        "task": task_out(task, artifact_count=len(artifacts)),
        "artifacts": [artifact_out(artifact) for artifact in artifacts],
        "executions": [task_execution_out(execution) for execution in executions],
    }


@router.post("/api/tasks/{task_id}/review")
def review_task(task_id: str, payload: TaskReviewIn, db: DbSession, actor: Actor = Depends(require_min_role("operator"))):
    task = _require_task(db, actor, task_id)
    now = utcnow()
    if payload.action == "accept":
        task.status = "accepted"
    elif payload.action == "reject":
        task.status = "rejected"
    elif payload.action == "archive":
        task.status = "archived"
        task.archived_at = now
    elif payload.action == "request_changes":
        task.status = "blocked"
    if payload.note_markdown.strip():
        db.add(
            AgentArtifact(
                space_id=actor.space_id,
                task_id=task.task_id,
                kind="review_note",
                title=f"Review: {payload.action}",
                content_markdown=payload.note_markdown.strip(),
                mime_type="text/markdown",
                created_by="human",
            )
        )
    task.updated_at = now
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="task",
        source_id=task.task_id,
        event_type=f"task.{payload.action}",
    )
    db.commit()
    return {"task": task_out(task, artifact_count=_artifact_count(db, task))}
```

- [ ] **Step 4: Register the router**

Modify `apps/api/app/main.py` imports to include `tasks`, then include it after `sessions.router`:

```python
app.include_router(tasks.router)
```

- [ ] **Step 5: Run task API tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py -q
```

Expected: both tests pass.

- [ ] **Step 6: Run relevant existing API smoke**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_control_plane.py::test_anonymous_business_apis_return_401 apps/api/tests/test_control_plane.py::test_sync_status_changes_only_when_relevant_state_changes -q
```

Expected: pass.

- [ ] **Step 7: Commit task API**

```powershell
git add apps/api/app/routers/tasks.py apps/api/app/main.py apps/api/tests/test_tasks.py
git commit -m "feat: add task api and dispatch"
```

---

### Task 3: Job Completion Updates Task Artifacts

**Files:**
- Modify: `apps/api/app/routers/internal.py`
- Modify: `apps/api/tests/test_tasks.py`

- [ ] **Step 1: Add completion and failure tests**

Append to `apps/api/tests/test_tasks.py`:

```python
def _claim_and_complete_task_job(client: TestClient, worker_token: str, worker_id: str, job_id: str, result_text: str) -> None:
    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={"worker_id": worker_id, "result_text": result_text},
    )
    assert completed.status_code == 200, completed.text


def test_task_job_completion_creates_report_artifact(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]

    created = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "生成 report artifact",
            "brief_markdown": "完成后应该进入验收。",
            "success_criteria_markdown": "- report artifact exists",
            "target_worker_id": worker_id,
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "submit": True,
        },
    )
    assert created.status_code == 200, created.text
    task_id = created.json()["task"]["task_id"]
    job_id = created.json()["job"]["job_id"]

    _claim_and_complete_task_job(client, worker["worker_token"], worker_id, job_id, "完成：测试通过，风险较低。")

    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["status"] == "ready_to_review"
    assert detail.json()["artifacts"][0]["kind"] == "report"
    assert "完成：测试通过" in detail.json()["artifacts"][0]["content_markdown"]
    assert detail.json()["executions"][0]["status"] == "succeeded"


def test_task_job_failure_marks_task_failed_with_log_artifact(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]

    created = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "失败任务",
            "brief_markdown": "失败时应该留下日志。",
            "target_worker_id": worker_id,
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "submit": True,
        },
    )
    job_id = created.json()["job"]["job_id"]
    task_id = created.json()["task"]["task_id"]

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text

    failed = client.post(
        f"/api/internal/jobs/{job_id}/fail",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"worker_id": worker_id, "error_text": "runtime crashed"},
    )
    assert failed.status_code == 200, failed.text

    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    assert detail.json()["task"]["status"] == "failed"
    assert detail.json()["artifacts"][0]["kind"] == "log"
    assert "runtime crashed" in detail.json()["artifacts"][0]["content_markdown"]
```

- [ ] **Step 2: Run failing completion tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py::test_task_job_completion_creates_report_artifact apps/api/tests/test_tasks.py::test_task_job_failure_marks_task_failed_with_log_artifact -q
```

Expected: fail because complete/fail do not update tasks.

- [ ] **Step 3: Add task finalization helpers**

Modify imports in `apps/api/app/routers/internal.py`:

```python
from app.models import AgentArtifact, AgentPermission, AgentSession, AgentTask, AgentTaskExecution, AgentTimeline, Job, Schedule, Worker, utcnow
```

Add helper functions above `complete_job`:

```python
def _task_id_from_job(job: Job) -> str:
    payload = loads_json(job.payload_json, {})
    return str(payload.get("task_id") or "").strip() if isinstance(payload, dict) else ""


def _mark_task_job_complete(db: DbSession, job: Job, *, result_text: str, at: datetime) -> None:
    task_id = _task_id_from_job(job)
    if not task_id:
        return
    task = db.query(AgentTask).filter(AgentTask.space_id == job.space_id, AgentTask.task_id == task_id).one_or_none()
    if task is None:
        return
    execution = (
        db.query(AgentTaskExecution)
        .filter(AgentTaskExecution.space_id == job.space_id, AgentTaskExecution.task_id == task_id, AgentTaskExecution.job_id == job.job_id)
        .one_or_none()
    )
    if execution is not None:
        execution.status = "succeeded"
        execution.session_id = job.target_session_id
        execution.updated_at = at
    task.status = "ready_to_review"
    task.latest_job_id = job.job_id
    task.latest_session_id = job.target_session_id or task.latest_session_id
    task.updated_at = at
    db.add(
        AgentArtifact(
            space_id=job.space_id,
            task_id=task.task_id,
            kind="report",
            title="Delivery report",
            content_markdown=result_text or "Task completed without a textual report.",
            mime_type="text/markdown",
            created_by="agent",
        )
    )


def _mark_task_job_failed(db: DbSession, job: Job, *, error_text: str, at: datetime) -> None:
    task_id = _task_id_from_job(job)
    if not task_id:
        return
    task = db.query(AgentTask).filter(AgentTask.space_id == job.space_id, AgentTask.task_id == task_id).one_or_none()
    if task is None:
        return
    execution = (
        db.query(AgentTaskExecution)
        .filter(AgentTaskExecution.space_id == job.space_id, AgentTaskExecution.task_id == task_id, AgentTaskExecution.job_id == job.job_id)
        .one_or_none()
    )
    if execution is not None:
        execution.status = "failed"
        execution.updated_at = at
    task.status = "failed"
    task.latest_job_id = job.job_id
    task.updated_at = at
    db.add(
        AgentArtifact(
            space_id=job.space_id,
            task_id=task.task_id,
            kind="log",
            title="Failure log",
            content_markdown=error_text or "Task failed without an error message.",
            mime_type="text/markdown",
            created_by="system",
        )
    )
```

- [ ] **Step 4: Call helpers from complete and fail**

In `complete_job`, after existing session update logic and before `write_event`, add:

```python
    _mark_task_job_complete(db, job, result_text=payload.result_text or "", at=now)
```

In `fail_job`, after existing session update logic and before `write_event`, add:

```python
    _mark_task_job_failed(db, job, error_text=payload.error_text or "", at=now)
```

- [ ] **Step 5: Run task tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py -q
```

Expected: pass.

- [ ] **Step 6: Run worker state machine smoke**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_state_machines.py apps/api/tests/test_worker_client.py -q
```

Expected: pass.

- [ ] **Step 7: Commit job completion integration**

```powershell
git add apps/api/app/routers/internal.py apps/api/tests/test_tasks.py
git commit -m "feat: link task status to job completion"
```

---

### Task 4: Top-Level Mode Switch And Workbench Shell

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add failing web tests for mode switch**

In `apps/web/src/App.test.tsx`, extend the default fetch mock near the `/api/sessions` handler:

```ts
      if (url.endsWith('/api/tasks')) return jsonResponse({ items: taskPayload.items });
      if (url.endsWith('/api/tasks/task-1')) return jsonResponse(taskDetailPayload);
```

Add fixture near `sessionPayload`:

```ts
const taskPayload = {
  items: [
    {
      task_id: 'task-1',
      space_id: 'spc_default',
      title: '修复登录页移动端布局',
      brief_markdown: '登录页在 390px 宽度下按钮遮挡。',
      success_criteria_markdown: '- npm run web:test passes',
      status: 'ready_to_review',
      priority: 100,
      target_worker_id: 'win-main',
      backend: 'codex',
      workspace_root: 'E:/work/AgentHub-OSS',
      namespace: 'default',
      latest_job_id: 'job-task-1',
      latest_session_id: 'sess-1',
      artifact_count: 1,
      created_by: 'usr_1',
      created_at: '2026-07-09T02:00:00Z',
      updated_at: '2026-07-09T02:18:00Z',
      due_at: null,
      archived_at: null,
      metadata: {},
    },
  ],
};

const taskDetailPayload = {
  task: taskPayload.items[0],
  artifacts: [
    {
      artifact_id: 'art-1',
      task_id: 'task-1',
      kind: 'report',
      title: 'Delivery report',
      path: null,
      content_markdown: '测试通过，风险较低。',
      mime_type: 'text/markdown',
      created_by: 'agent',
      created_at: '2026-07-09T02:18:00Z',
      version: 1,
    },
  ],
  executions: [],
};
```

Add test:

```ts
  it('switches globally between Workbench and Session modes without hiding session mode', async () => {
    render(<App />);

    expect(await screen.findByRole('button', { name: /Workbench/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Session/ })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Task Inbox/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修复登录页移动端布局/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Session/ }));
    expect(await screen.findByRole('heading', { name: /会话收件箱/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修复移动控制台/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Workbench/ }));
    expect(await screen.findByRole('heading', { name: /Task Inbox/ })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run failing web test**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "switches globally"
```

Expected: fail because Workbench controls do not exist.

- [ ] **Step 3: Add app mode state and task types**

Modify `apps/web/src/App.tsx` imports from protocol:

```ts
  AgentArtifact,
  AgentTask,
  AgentTaskExecution,
```

Add near storage keys:

```ts
const APP_MODE_STORAGE_KEY = 'agenthub.appMode';
type AppMode = 'workbench' | 'session';

function initialAppMode(): AppMode {
  return localStorage.getItem(APP_MODE_STORAGE_KEY) === 'session' ? 'session' : 'workbench';
}
```

Add state inside `App()`:

```ts
  const [appMode, setAppMode] = useState<AppMode>(() => initialAppMode());
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<{
    task: AgentTask;
    artifacts: AgentArtifact[];
    executions: AgentTaskExecution[];
  } | null>(null);
```

Add persistence effect:

```ts
  useEffect(() => {
    localStorage.setItem(APP_MODE_STORAGE_KEY, appMode);
  }, [appMode]);
```

- [ ] **Step 4: Load tasks with existing data refresh**

Add functions near `loadInitialData`:

```ts
  async function loadTasks() {
    const payload = await apiGet<{ items: AgentTask[] }>('/api/tasks');
    setTasks(payload.items);
    const nextTaskId = selectedTaskId && payload.items.some((task) => task.task_id === selectedTaskId)
      ? selectedTaskId
      : payload.items[0]?.task_id ?? null;
    setSelectedTaskId(nextTaskId);
    if (nextTaskId) {
      const detail = await apiGet<{ task: AgentTask; artifacts: AgentArtifact[]; executions: AgentTaskExecution[] }>(`/api/tasks/${nextTaskId}`);
      setTaskDetail(detail);
    } else {
      setTaskDetail(null);
    }
  }
```

Call `loadTasks()` at the end of `loadInitialData`, after the existing session, worker, job, schedule, provider, permission, and timeline state is hydrated. Keep task load failures non-fatal only if the API returns `404` during local mixed-version development:

```ts
    await loadTasks().catch((error) => {
      if (String(error.message) !== '404') throw error;
    });
```

- [ ] **Step 5: Add topbar mode switch**

Inside the topbar after brand/mobile worker signal and before `.topbar-actions`, add:

```tsx
        <div className="app-mode-switch" role="group" aria-label="AgentHub mode">
          <button
            type="button"
            className={appMode === 'workbench' ? 'selected' : ''}
            aria-pressed={appMode === 'workbench'}
            onClick={() => setAppMode('workbench')}
          >
            Workbench
          </button>
          <button
            type="button"
            className={appMode === 'session' ? 'selected' : ''}
            aria-pressed={appMode === 'session'}
            onClick={() => setAppMode('session')}
          >
            Session
          </button>
        </div>
```

- [ ] **Step 6: Add Workbench shell component**

Add this component before `IslandConsole` or near other view components:

```tsx
function WorkbenchShell({
  tasks,
  selectedTaskId,
  taskDetail,
  onSelectTask,
}: {
  tasks: AgentTask[];
  selectedTaskId: string | null;
  taskDetail: { task: AgentTask; artifacts: AgentArtifact[]; executions: AgentTaskExecution[] } | null;
  onSelectTask: (taskId: string) => void;
}) {
  const selectedTask = taskDetail?.task ?? tasks.find((task) => task.task_id === selectedTaskId) ?? tasks[0] ?? null;
  const ready = tasks.filter((task) => task.status === 'ready_to_review').length;
  const blocked = tasks.filter((task) => task.status === 'blocked' || task.status === 'needs_approval').length;
  const working = tasks.filter((task) => task.status === 'working' || task.status === 'queued').length;
  return (
    <section className="workbench-layout" aria-label="Agent Workbench">
      <aside className="task-inbox">
        <div className="section-heading">
          <h1>Task Inbox</h1>
        </div>
        <div className="task-status-stack">
          <span>Ready to Review · {ready}</span>
          <span>Blocked · {blocked}</span>
          <span>Working · {working}</span>
          <span>All · {tasks.length}</span>
        </div>
      </aside>
      <section className="task-list" aria-label="Tasks">
        <button type="button" className="icon-button primary-top-action">
          <Plus size={17} />
          New Task Brief
        </button>
        {tasks.length === 0 && <p className="empty">No tasks yet.</p>}
        {tasks.map((task) => (
          <button
            key={task.task_id}
            type="button"
            className={`task-row ${task.task_id === selectedTask?.task_id ? 'selected' : ''}`}
            onClick={() => onSelectTask(task.task_id)}
          >
            <strong>{task.title}</strong>
            <small>{task.status} · {task.backend ?? 'agent'} · {task.workspace_root ?? 'workspace'}</small>
          </button>
        ))}
      </section>
      <section className="task-detail" aria-label="Task Detail">
        {selectedTask ? (
          <>
            <p>{selectedTask.backend ?? 'Agent'} · {selectedTask.namespace}</p>
            <h2>{selectedTask.title}</h2>
            <span className={`state-pill ${statusClass(selectedTask.status)}`}>{selectedTask.status}</span>
            <h3>Brief</h3>
            <p>{selectedTask.brief_markdown}</p>
            <h3>Artifacts</h3>
            {taskDetail?.artifacts.length ? (
              taskDetail.artifacts.map((artifact) => (
                <article key={artifact.artifact_id} className="artifact-card">
                  <strong>{artifact.title}</strong>
                  <small>{artifact.kind} · v{artifact.version}</small>
                  {artifact.content_markdown && <p>{artifact.content_markdown}</p>}
                </article>
              ))
            ) : (
              <p className="empty">No artifacts yet.</p>
            )}
          </>
        ) : (
          <p className="empty">Create a task brief to start Workbench Mode.</p>
        )}
      </section>
    </section>
  );
}
```

- [ ] **Step 7: Render Workbench or existing Session workspace**

Wrap the existing `<section className={`workspace mobile-pane-${mobilePane}`}>...</section>` block with:

```tsx
      {appMode === 'workbench' ? (
        <WorkbenchShell
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          taskDetail={taskDetail}
          onSelectTask={(taskId) => {
            setSelectedTaskId(taskId);
            void apiGet<{ task: AgentTask; artifacts: AgentArtifact[]; executions: AgentTaskExecution[] }>(`/api/tasks/${taskId}`).then(setTaskDetail);
          }}
        />
      ) : (
        <section className={`workspace mobile-pane-${mobilePane}`}>
          ...
        </section>
      )}
```

Only move the opening and closing wrapper; keep the current Session Mode content unchanged inside the `else`.

- [ ] **Step 8: Add CSS**

Append to `apps/web/src/styles.css`:

```css
.app-mode-switch {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--ah-border);
  border-radius: 9px;
  background: var(--ah-surface-soft);
}

.app-mode-switch button {
  border: 0;
  border-radius: 7px;
  padding: 7px 12px;
  background: transparent;
  color: var(--ah-muted-strong);
  font-weight: 800;
}

.app-mode-switch button.selected {
  background: var(--ah-surface);
  color: var(--ah-text);
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.1);
}

.workbench-layout {
  display: grid;
  grid-template-columns: 220px minmax(320px, 0.9fr) minmax(380px, 1.2fr);
  gap: 0;
  min-height: calc(100dvh - 64px);
  border-top: 1px solid var(--ah-border-soft);
}

.task-inbox,
.task-list,
.task-detail {
  padding: 18px;
  border-right: 1px solid var(--ah-border-soft);
  background: var(--ah-surface);
  min-width: 0;
}

.task-inbox {
  background: var(--ah-surface-soft);
}

.task-status-stack {
  display: grid;
  gap: 8px;
}

.task-status-stack span,
.task-row,
.artifact-card {
  border: 1px solid var(--ah-border);
  border-radius: 8px;
  background: var(--ah-surface);
  padding: 10px;
}

.task-list {
  display: grid;
  align-content: start;
  gap: 10px;
}

.task-row {
  width: 100%;
  display: grid;
  gap: 5px;
  text-align: left;
  color: var(--ah-text);
}

.task-row.selected {
  border-color: var(--ah-accent);
  background: var(--ah-accent-soft);
}

.task-detail {
  border-right: 0;
}

.artifact-card {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}

@media (max-width: 900px) {
  .app-mode-switch {
    order: 3;
    width: 100%;
    justify-content: center;
  }

  .workbench-layout {
    grid-template-columns: 1fr;
  }

  .task-inbox,
  .task-list,
  .task-detail {
    border-right: 0;
    border-bottom: 1px solid var(--ah-border-soft);
  }
}
```

- [ ] **Step 9: Run web mode test**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "switches globally"
```

Expected: pass.

- [ ] **Step 10: Run focused layout tests**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run src/App.test.tsx src/styles.test.ts src/mobile-layout.test.ts
```

Expected: pass. If existing tests assume Session is default, update those tests by switching to Session mode before asserting session-specific UI.

- [ ] **Step 11: Commit mode switch shell**

```powershell
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat: add workbench mode shell"
```

---

### Task 5: Task Brief Composer And Review Actions

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add failing create/review web tests**

Add to `apps/web/src/App.test.tsx`:

```ts
  it('creates a task brief from Workbench mode and reviews it', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      if (url.endsWith('/api/settings')) return jsonResponse(settingsPayload);
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [{ ...providersPayload.items[0], machine_name: 'DevBox', os: 'windows', reachable_backends: ['codex'], workspace_roots: ['E:/work/AgentHub-OSS'], capabilities: {}, last_heartbeat_at: null, runtime_settings: { max_concurrent_jobs: 2, job_poll_interval_seconds: 5, heartbeat_interval_seconds: 30 } }] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(permissionsPayload);
      if (url.endsWith('/api/tasks') && init?.method === 'POST') {
        expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        const body = JSON.parse(String(init.body ?? '{}'));
        expect(body.title).toBe('修复登录页移动端布局');
        expect(body.submit).toBe(true);
        return jsonResponse({ task: { ...taskPayload.items[0], title: body.title }, job: { job_id: 'job-task-1', status: 'queued' } });
      }
      if (url.endsWith('/api/tasks')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/tasks/task-1/review')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ action: 'accept', note_markdown: '' });
        return jsonResponse({ task: { ...taskPayload.items[0], status: 'accepted' } });
      }
      if (url.endsWith('/api/tasks/task-1')) return jsonResponse(taskDetailPayload);
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      return jsonResponse({});
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /New Task Brief/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: '修复登录页移动端布局' } });
    fireEvent.change(screen.getByLabelText('Task brief'), { target: { value: '登录页移动端按钮遮挡。' } });
    fireEvent.change(screen.getByLabelText('Success criteria'), { target: { value: '- 390px no overlap' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Task/ }));

    expect(await screen.findByText(/Task queued/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/tasks/task-1/review', expect.any(Object)));
  });
```

- [ ] **Step 2: Run failing create/review test**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "creates a task brief"
```

Expected: fail because the composer is not implemented.

- [ ] **Step 3: Add task draft state**

Inside `App()` add:

```ts
  const [taskComposerOpen, setTaskComposerOpen] = useState(false);
  const [taskDraft, setTaskDraft] = useState({
    title: '',
    brief_markdown: '',
    success_criteria_markdown: '',
    target_worker_id: '',
    backend: 'codex',
    workspace_root: '',
  });
```

Add helper:

```ts
  function openTaskComposer() {
    const worker = workers[0];
    setTaskDraft({
      title: '',
      brief_markdown: '',
      success_criteria_markdown: '',
      target_worker_id: worker?.worker_id ?? '',
      backend: worker?.reachable_backends?.[0] ?? 'codex',
      workspace_root: worker?.workspace_roots?.[0] ?? '',
    });
    setTaskComposerOpen(true);
  }
```

- [ ] **Step 4: Add submit and review handlers**

Inside `App()` add:

```ts
  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate(user)) return;
    const payload = await apiPost<{ task: AgentTask; job?: Job }>(
      '/api/tasks',
      {
        ...taskDraft,
        namespace: 'default',
        submit: true,
      },
      csrfToken,
    );
    setTasks((current) => [payload.task, ...current.filter((task) => task.task_id !== payload.task.task_id)]);
    setSelectedTaskId(payload.task.task_id);
    setTaskComposerOpen(false);
    setNotice('Task queued');
    const detail = await apiGet<{ task: AgentTask; artifacts: AgentArtifact[]; executions: AgentTaskExecution[] }>(`/api/tasks/${payload.task.task_id}`);
    setTaskDetail(detail);
  }

  async function handleTaskReview(action: 'accept' | 'reject' | 'archive' | 'request_changes') {
    if (!taskDetail || !canOperate(user)) return;
    const payload = await apiPost<{ task: AgentTask }>(
      `/api/tasks/${taskDetail.task.task_id}/review`,
      { action, note_markdown: '' },
      csrfToken,
    );
    setTaskDetail((current) => (current ? { ...current, task: payload.task } : current));
    setTasks((current) => current.map((task) => (task.task_id === payload.task.task_id ? payload.task : task)));
  }
```

- [ ] **Step 5: Wire handlers into WorkbenchShell**

Change `WorkbenchShell` props:

```ts
  onNewTask: () => void;
  onReviewTask: (action: 'accept' | 'reject' | 'archive' | 'request_changes') => void;
```

Change the New Task button:

```tsx
<button type="button" className="icon-button primary-top-action" onClick={onNewTask}>
  <Plus size={17} />
  New Task Brief
</button>
```

Add review buttons under artifacts when a selected task exists:

```tsx
<div className="task-review-actions" role="group" aria-label="Task review actions">
  <button type="button" onClick={() => onReviewTask('accept')}>Accept</button>
  <button type="button" onClick={() => onReviewTask('request_changes')}>Request Changes</button>
  <button type="button" onClick={() => onReviewTask('archive')}>Archive</button>
</div>
```

- [ ] **Step 6: Add composer dialog**

Near other dialogs in `App()` render:

```tsx
{taskComposerOpen && (
  <div className="dialog-backdrop" role="presentation">
    <form className="launch-dialog task-composer" aria-label="New Task Brief" onSubmit={handleCreateTask}>
      <div className="dialog-head">
        <div>
          <p>Workbench</p>
          <h2>New Task Brief</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Close task composer" onClick={() => setTaskComposerOpen(false)}>
          <X size={17} />
        </button>
      </div>
      <label>
        Task title
        <input
          aria-label="Task title"
          value={taskDraft.title}
          onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))}
          required
        />
      </label>
      <label>
        Task brief
        <textarea
          aria-label="Task brief"
          value={taskDraft.brief_markdown}
          onChange={(event) => setTaskDraft((current) => ({ ...current, brief_markdown: event.target.value }))}
          required
        />
      </label>
      <label>
        Success criteria
        <textarea
          aria-label="Success criteria"
          value={taskDraft.success_criteria_markdown}
          onChange={(event) => setTaskDraft((current) => ({ ...current, success_criteria_markdown: event.target.value }))}
        />
      </label>
      <button type="submit" disabled={!taskDraft.title.trim() || !taskDraft.brief_markdown.trim() || !taskDraft.target_worker_id || !taskDraft.workspace_root}>
        Submit Task
      </button>
    </form>
  </div>
)}
```

- [ ] **Step 7: Add composer CSS**

Append:

```css
.task-composer {
  width: min(720px, calc(100vw - 28px));
}

.task-composer textarea {
  min-height: 120px;
  resize: vertical;
}

.task-review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.task-review-actions button {
  border: 1px solid var(--ah-border);
  border-radius: 7px;
  background: var(--ah-surface-soft);
  color: var(--ah-text);
  padding: 9px 12px;
  font-weight: 800;
}
```

- [ ] **Step 8: Run create/review web test**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "creates a task brief"
```

Expected: pass.

- [ ] **Step 9: Run full web test/build**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run
npm run web:build
```

Expected: pass.

- [ ] **Step 10: Commit composer and review UI**

```powershell
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat: add task brief composer"
```

---

### Task 6: Final Validation And Documentation Touch-Up

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `PROJECT_STATUS.md`
- Modify: `docs/superpowers/specs/2026-07-09-v1-agent-workbench-mode-design.md` if implementation differs from the spec

- [ ] **Step 1: Update project status**

Modify `PROJECT_STATUS.md` Current State or Active Work with:

```markdown
The `v1/agent-workbench` line now introduces Workbench Mode beside the existing Session Mode. Workbench Mode uses a top-level `Workbench | Session` switch, adds `AgentTask` and `AgentArtifact` APIs, dispatches task briefs through existing session jobs, and routes completed task jobs into report artifacts for review.
```

- [ ] **Step 2: Add README 1.0 preview note**

Add a short note under "它解决什么" in `README.md`:

```markdown
- **1.0 Workbench Mode（开发中）。** 在保留当前 Session 控制台的基础上，新增异步任务工作台：写任务书、派发到本地 worker、等待 artifact、再验收。
```

Add matching note to `README.en.md`:

```markdown
- **1.0 Workbench Mode (in development).** AgentHub keeps the existing Session console and adds an async task workbench for briefs, local worker execution, artifacts, and review.
```

- [ ] **Step 3: Run API tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_tasks.py apps/api/tests/test_control_plane.py apps/api/tests/test_state_machines.py -q
```

Expected: pass.

- [ ] **Step 4: Run frontend tests and build**

Run:

```powershell
npm --workspace @agenthub/web run test -- --run
npm run web:build
```

Expected: pass.

- [ ] **Step 5: Run public export audit**

Run:

```powershell
.\.venv\Scripts\python.exe scripts\audit-public-export.py --root .
```

Expected: pass.

- [ ] **Step 6: Inspect diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 7: Commit docs and final status**

```powershell
git add README.md README.en.md PROJECT_STATUS.md docs/superpowers/specs/2026-07-09-v1-agent-workbench-mode-design.md
git commit -m "docs: document v1 workbench mode preview"
```

---

## Self-Review Checklist

- Spec coverage: Phase 1 covers global mode switch, Task MVP, Task -> Job -> Artifact linkage, Workbench shell, Session preservation, and review actions.
- Deferred by design: workspace task folder, task templates, task-level authority enforcement, and pipeline debugger.
- Risk: `apps/web/src/App.tsx` is large. Keep the implementation surgical and avoid unrelated UI rewrites.
- Risk: `payload.task_id` linkage depends on task-dispatched jobs. Do not require all existing jobs to have task IDs.
- Required validation before merging the implementation branch: `apps/api/tests/test_tasks.py`, selected existing API tests, full web test, `web:build`, public export audit.
