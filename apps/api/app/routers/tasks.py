from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func

from app.core.audit import write_event
from app.core.config import get_settings
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


def _workspace_project_name(workspace_root: str) -> str:
    return workspace_root.rstrip("/\\").replace("\\", "/").split("/")[-1] or "workspace"


def _dispatch_task(db: DbSession, actor: Actor, task: AgentTask, controls: dict[str, object]) -> Job:
    if not task.target_worker_id or not task.backend or not task.workspace_root:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Task needs worker, backend, and workspace before submit",
                "code": "TASK_DISPATCH_INCOMPLETE",
            },
        )
    backend = task.backend.strip().lower()
    _require_worker_backend_available(db, actor.space_id, task.target_worker_id, backend)
    now = utcnow()
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
                "project_name": _workspace_project_name(task.workspace_root),
                "namespace": task.namespace or "default",
                "start_mode": "new",
                "timeout_seconds": get_settings().default_session_job_timeout_seconds,
            }
        ),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    db.add(
        AgentTaskExecution(
            space_id=actor.space_id,
            task_id=task.task_id,
            job_id=job.job_id,
            kind=job.kind,
            status=job.status,
        )
    )
    task.status = "queued"
    task.latest_job_id = job.job_id
    task.updated_at = now
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
    response: dict[str, object] = {"task": task_out(task, artifact_count=0)}
    if job is not None:
        response["job"] = job_out(job)
    return response


@router.get("/api/tasks")
def list_tasks(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    status: str | None = None,
    archived: bool = False,
):
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
def review_task(
    task_id: str,
    payload: TaskReviewIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
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
