from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import load_only

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role
from app.core.job_recovery import recover_stale_running_jobs_for_space
from app.core.json import dumps_json
from app.core.session_state import set_session_status
from app.models import AgentPermission, AgentSession, Job, utcnow
from app.schemas import JobCreateIn
from app.services import ALLOWED_JOB_KINDS, job_out, job_summary_out
from app.task_lifecycle import project_task_job_lifecycle

router = APIRouter()
JOB_LIST_LOAD_ONLY = (
    Job.space_id,
    Job.job_id,
    Job.kind,
    Job.target_session_id,
    Job.worker_id,
    Job.backend,
    Job.workspace_root,
    Job.namespace,
    Job.priority,
    Job.status,
    Job.payload_json,
    Job.error_text,
    Job.created_at,
    Job.updated_at,
)


def _session_has_job_status(db: DbSession, session: AgentSession, status: str) -> bool:
    return (
        db.query(Job.job_id)
        .filter(Job.space_id == session.space_id)
        .filter(Job.target_session_id == session.session_id)
        .filter(Job.status == status)
        .first()
        is not None
    )


def _session_has_pending_permission(db: DbSession, session: AgentSession) -> bool:
    return (
        db.query(AgentPermission.permission_id)
        .filter(AgentPermission.space_id == session.space_id)
        .filter(AgentPermission.session_id == session.session_id)
        .filter(AgentPermission.status == "pending")
        .first()
        is not None
    )


def _session_status_after_job_cancel(db: DbSession, session: AgentSession) -> str:
    if _session_has_pending_permission(db, session):
        return "needs_reply"
    if _session_has_job_status(db, session, "running"):
        return "running"
    if _session_has_job_status(db, session, "queued"):
        return "queued"
    return "ready"


@router.post("/api/jobs")
def create_job(payload: JobCreateIn, db: DbSession, actor: Actor = Depends(require_min_role("operator"))):
    if payload.kind not in ALLOWED_JOB_KINDS:
        raise HTTPException(status_code=400, detail={"message": "Job kind is not allowed", "code": "JOB_KIND_NOT_ALLOWED"})
    job = Job(
        space_id=actor.space_id,
        kind=payload.kind,
        target_session_id=payload.target_session_id,
        worker_id=payload.worker_id,
        backend=payload.backend,
        workspace_root=payload.workspace_root,
        namespace=payload.namespace,
        priority=payload.priority,
        payload_json=dumps_json(payload.payload),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.create",
        payload={"kind": job.kind},
    )
    db.commit()
    return {"job": job_out(job)}


@router.get("/api/jobs")
def list_jobs(db: DbSession, actor: Actor = Depends(require_min_role("viewer")), limit: int = 120):
    if recover_stale_running_jobs_for_space(db, actor.space_id):
        db.commit()
    bounded_limit = max(1, min(limit, 500))
    jobs = (
        db.query(Job)
        .options(load_only(*JOB_LIST_LOAD_ONLY))
        .filter(Job.space_id == actor.space_id)
        .order_by(Job.created_at.desc())
        .limit(bounded_limit)
        .all()
    )
    return {"items": [job_summary_out(job) for job in jobs]}


@router.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, db: DbSession, actor: Actor = Depends(require_min_role("operator"))):
    job = db.query(Job).filter(Job.space_id == actor.space_id, Job.job_id == job_id).one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail={"message": "Job not found", "code": "JOB_NOT_FOUND"})
    if job.status not in {"queued", "running"}:
        raise HTTPException(status_code=409, detail={"message": "Job cannot be cancelled", "code": "JOB_STATE_INVALID"})
    now = utcnow()
    job.status = "cancelled"
    job.error_text = f"Cancelled by {actor.actor_id}"
    job.completed_at = now
    job.updated_at = now
    project_task_job_lifecycle(
        db,
        job,
        state="cancelled",
        at=now,
        detail_text=job.error_text or "",
    )
    db.flush()
    if job.kind == "session_input" and job.target_session_id:
        session = (
            db.query(AgentSession)
            .filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id)
            .one_or_none()
        )
        if session:
            set_session_status(
                session,
                _session_status_after_job_cancel(db, session),
                source="job",
            )
            session.updated_at = now
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.cancel",
        payload={"kind": job.kind, "session_id": job.target_session_id},
    )
    db.commit()
    return {"job": job_out(job)}
