from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.exc import OperationalError

from app.core.audit import write_event
from app.core.config import get_settings
from app.core.deps import Actor, DbSession, require_min_role
from app.core.json import dumps_json, loads_json
from app.models import AgentArtifact, AgentTask, AgentTaskExecution, Job, utcnow
from app.routers.sessions import _normalize_controls, _require_worker_backend_available
from app.schemas import TaskCreateIn, TaskReviewIn
from app.services import artifact_out, job_out, task_execution_out, task_out

router = APIRouter()

REWORKABLE_TASK_STATUSES = frozenset({"ready_to_review", "failed", "blocked", "rejected"})
READ_ONLY_AUTHORITY_PRESETS = frozenset({"read_only", "review_only"})
ACTIVE_TASK_STATUSES = frozenset({"queued", "working"})


def _authority_controls(
    authority_preset: str,
    backend: str | None,
    requested_controls: dict[str, object],
) -> dict[str, object]:
    controls = dict(requested_controls)
    backend_name = str(backend or "").strip().lower()
    read_only = authority_preset in READ_ONLY_AUTHORITY_PRESETS
    controls["yolo"] = False
    if backend_name == "codex":
        controls.pop("permission_mode", None)
        controls["sandbox_mode"] = "read-only" if read_only else "workspace-write"
        controls["approval_mode"] = "on-request"
    elif backend_name == "claude":
        controls.pop("sandbox_mode", None)
        controls.pop("approval_mode", None)
        controls["permission_mode"] = "plan" if read_only else "default"
    else:
        controls.pop("sandbox_mode", None)
        controls.pop("approval_mode", None)
        controls.pop("permission_mode", None)
    return controls


def _task_metadata(task: AgentTask) -> dict[str, object]:
    metadata = loads_json(task.metadata_json, {})
    return dict(metadata) if isinstance(metadata, dict) else {}


def _task_prompt(task: AgentTask, *, review_note: str = "") -> str:
    prompt = (
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
    if review_note:
        prompt += f"\n\n## Requested Changes\n{review_note}"
    return prompt


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


def _has_report_artifact(db: DbSession, task: AgentTask) -> bool:
    return (
        db.query(AgentArtifact.id)
        .filter(
            AgentArtifact.space_id == task.space_id,
            AgentArtifact.task_id == task.task_id,
            AgentArtifact.kind == "report",
        )
        .first()
        is not None
    )


def _stored_task_controls(task: AgentTask) -> dict[str, object]:
    metadata = _task_metadata(task)
    controls = metadata.get("controls")
    return dict(controls) if isinstance(controls, dict) else {}


def _task_workspace_config(
    task: AgentTask,
    *,
    controls: dict[str, object],
    attempt_number: int,
    review_note: str,
) -> dict[str, object]:
    metadata = _task_metadata(task)
    template_key = str(metadata.get("template_key") or "implement_feature")
    authority_preset = str(metadata.get("authority_preset") or "feature")
    raw_paths = metadata.get("relevant_paths")
    relevant_paths = [str(path) for path in raw_paths] if isinstance(raw_paths, list) else []
    boundary_paths = relevant_paths or ["."]
    return {
        "schema_version": 1,
        "task_id": task.task_id,
        "relative_path": f".agenthub/tasks/{task.task_id}",
        "title": task.title,
        "brief_markdown": task.brief_markdown,
        "success_criteria_markdown": task.success_criteria_markdown,
        "template_key": template_key,
        "authority_preset": authority_preset,
        "relevant_paths": relevant_paths,
        "attempt_number": attempt_number,
        "review_note": review_note,
        "authority": {
            "read_paths": boundary_paths,
            "write_paths": [] if authority_preset in READ_ONLY_AUTHORITY_PRESETS else boundary_paths,
            "runtime_controls": controls,
            "enforcement": {
                "runtime_controls": "mapped",
                "command_level": "declared_only",
            },
        },
    }


def _review_state_conflict(task: AgentTask, action: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "message": f"Task cannot {action} from {task.status}",
            "code": "TASK_REVIEW_STATE_INVALID",
            "action": action,
            "status": task.status,
        },
    )


def _claim_review_transition(
    db: DbSession,
    task: AgentTask,
    *,
    action: str,
    allowed_statuses: frozenset[str],
    next_status: str,
    now: datetime,
) -> None:
    try:
        updated = (
            db.query(AgentTask)
            .filter(
                AgentTask.id == task.id,
                AgentTask.space_id == task.space_id,
                AgentTask.status.in_(allowed_statuses),
            )
            .update(
                {AgentTask.status: next_status, AgentTask.updated_at: now},
                synchronize_session="fetch",
            )
        )
    except OperationalError as error:
        if db.bind is None or db.bind.dialect.name != "sqlite" or "locked" not in str(error).lower():
            raise
        db.rollback()
        current = (
            db.query(AgentTask)
            .filter(AgentTask.id == task.id, AgentTask.space_id == task.space_id)
            .one_or_none()
        )
        raise _review_state_conflict(current or task, action) from error
    if updated != 1:
        db.expire(task)
        raise _review_state_conflict(task, action)


def _workspace_project_name(workspace_root: str) -> str:
    return workspace_root.rstrip("/\\").replace("\\", "/").split("/")[-1] or "workspace"


def _dispatch_task(
    db: DbSession,
    actor: Actor,
    task: AgentTask,
    controls: dict[str, object],
    *,
    review_note: str = "",
) -> Job:
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
    latest_attempt = (
        db.query(func.max(AgentTaskExecution.attempt_number))
        .filter(
            AgentTaskExecution.space_id == actor.space_id,
            AgentTaskExecution.task_id == task.task_id,
        )
        .scalar()
    )
    attempt_number = int(latest_attempt or 0) + 1
    now = utcnow()
    normalized_controls = _authority_controls(
        str(_task_metadata(task).get("authority_preset") or "feature"),
        backend,
        controls,
    )
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
                "prompt": _task_prompt(task, review_note=review_note),
                "title": task.title,
                "controls": _normalize_controls(normalized_controls, backend=backend),
                "task_workspace": _task_workspace_config(
                    task,
                    controls=_normalize_controls(normalized_controls, backend=backend),
                    attempt_number=attempt_number,
                    review_note=review_note,
                ),
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
            attempt_number=attempt_number,
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
    backend = payload.backend.strip().lower() if payload.backend else None
    controls = _authority_controls(payload.authority_preset, backend, payload.controls)
    task = AgentTask(
        space_id=actor.space_id,
        title=payload.title.strip(),
        brief_markdown=payload.brief_markdown.strip(),
        success_criteria_markdown=payload.success_criteria_markdown.strip(),
        priority=payload.priority,
        target_worker_id=payload.target_worker_id.strip() if payload.target_worker_id else None,
        backend=backend,
        workspace_root=payload.workspace_root.strip() if payload.workspace_root else None,
        namespace=(payload.namespace or "default").strip() or "default",
        created_by=actor.actor_id,
        metadata_json=dumps_json(
            {
                "template_key": payload.template_key,
                "authority_preset": payload.authority_preset,
                "relevant_paths": payload.relevant_paths,
                "controls": controls,
            }
        ),
    )
    db.add(task)
    db.flush()
    job = _dispatch_task(db, actor, task, controls) if payload.submit else None
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
        .order_by(AgentTaskExecution.attempt_number.desc(), AgentTaskExecution.created_at.desc())
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
    note = payload.note_markdown.strip()
    if payload.action in {"accept", "reject"} and task.status != "ready_to_review":
        raise _review_state_conflict(task, payload.action)
    if payload.action == "request_changes" and task.status not in REWORKABLE_TASK_STATUSES:
        raise _review_state_conflict(task, payload.action)
    if payload.action == "restore" and task.archived_at is None and task.status != "archived":
        raise _review_state_conflict(task, payload.action)
    if payload.action == "archive" and task.status in ACTIVE_TASK_STATUSES:
        raise _review_state_conflict(task, payload.action)
    if payload.action == "request_changes" and not note:
        raise HTTPException(
            status_code=400,
            detail={"message": "Request changes requires a review note", "code": "TASK_REVIEW_NOTE_REQUIRED"},
        )

    now = utcnow()
    if payload.action in {"accept", "reject"}:
        _claim_review_transition(
            db,
            task,
            action=payload.action,
            allowed_statuses=frozenset({"ready_to_review"}),
            next_status="accepted" if payload.action == "accept" else "rejected",
            now=now,
        )
    elif payload.action == "request_changes":
        _claim_review_transition(
            db,
            task,
            action=payload.action,
            allowed_statuses=REWORKABLE_TASK_STATUSES,
            next_status="queued",
            now=now,
        )
    job: Job | None = None
    if payload.action == "accept":
        pass
    elif payload.action == "reject":
        pass
    elif payload.action == "archive":
        if task.status == "archived" and task.archived_at is not None:
            return {"task": task_out(task, artifact_count=_artifact_count(db, task))}
        task.status = "archived"
        task.archived_at = task.archived_at or now
    elif payload.action == "restore":
        task.archived_at = None
        task.status = "ready_to_review" if _has_report_artifact(db, task) else "draft"
    elif payload.action == "request_changes":
        job = _dispatch_task(
            db,
            actor,
            task,
            _stored_task_controls(task),
            review_note=note,
        )
    if note:
        db.add(
            AgentArtifact(
                space_id=actor.space_id,
                task_id=task.task_id,
                kind="review_note",
                title=f"Review: {payload.action}",
                content_markdown=note,
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
        payload={"job_id": job.job_id} if job is not None else None,
    )
    db.commit()
    response: dict[str, object] = {"task": task_out(task, artifact_count=_artifact_count(db, task))}
    if job is not None:
        response["job"] = job_out(job)
    return response
