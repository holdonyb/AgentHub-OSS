from __future__ import annotations

from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.audit import write_event
from app.core.config import get_settings
from app.core.json import loads_json
from app.models import AgentPermission, AgentSession, Job, Worker, utcnow


def _job_updates_target_session(job: Job) -> bool:
    return job.kind == "session_input"


def _session_has_queued_job(db: Session, session_id: str, space_id: str | None) -> bool:
    return (
        db.query(Job.job_id)
        .filter(Job.space_id == space_id)
        .filter(Job.target_session_id == session_id)
        .filter(Job.status == "queued")
        .first()
        is not None
    )


def _session_has_pending_permission(db: Session, session_id: str, space_id: str | None) -> bool:
    return (
        db.query(AgentPermission.permission_id)
        .filter(AgentPermission.space_id == space_id)
        .filter(AgentPermission.session_id == session_id)
        .filter(AgentPermission.status == "pending")
        .first()
        is not None
    )


def _session_status_after_stale_job(db: Session, session: AgentSession) -> str:
    if _session_has_pending_permission(db, session.session_id, session.space_id):
        return "needs_reply"
    if _session_has_queued_job(db, session.session_id, session.space_id):
        return "queued"
    return "ready"


def job_stale_after_seconds(job: Job) -> int:
    settings = get_settings()
    payload = loads_json(job.payload_json, {})
    timeout_value = payload.get("timeout_seconds") if isinstance(payload, dict) else None
    try:
        payload_timeout = int(timeout_value) if timeout_value is not None else settings.claimed_job_stale_seconds
    except (TypeError, ValueError):
        payload_timeout = settings.claimed_job_stale_seconds
    return max(settings.claimed_job_stale_seconds, payload_timeout + 60)


def _recover_job_rows(db: Session, jobs: list[Job], *, worker_id_for_event: str) -> int:
    now = utcnow()
    recovered = 0
    for job in jobs:
        assert job.claimed_at is not None
        stale_after = job_stale_after_seconds(job)
        if job.claimed_at + timedelta(seconds=stale_after) > now:
            continue
        job.status = "failed"
        job.error_text = f"Worker job timed out after {stale_after} seconds and was released to unblock queued input."
        job.completed_at = now
        job.updated_at = now
        recovered += 1
        if job.target_session_id and _job_updates_target_session(job):
            session = (
                db.query(AgentSession)
                .filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id)
                .one_or_none()
            )
            if session:
                session.status = _session_status_after_stale_job(db, session)
                session.updated_at = now
        write_event(
            db,
            space_id=job.space_id,
            actor_type="system",
            actor_id="stale-job-recovery",
            source_type="job",
            source_id=job.job_id,
            event_type="job.fail_stale",
            level="warning",
            payload={
                "type": "stale_job",
                "worker_id": job.worker_id or worker_id_for_event,
                "job_id": job.job_id,
                "kind": job.kind,
                "reason": "claimed_job_timeout",
                "recovery_action": "failed_unblock_queued_input",
                "stale_after_seconds": stale_after,
            },
        )
    return recovered


def recover_orphaned_running_jobs(
    db: Session,
    worker_id: str,
    space_id: str | None,
    active_job_ids: list[str],
) -> int:
    settings = get_settings()
    active_ids = {str(job_id) for job_id in active_job_ids if str(job_id).strip()}
    now = utcnow()
    running_jobs = (
        db.query(Job)
        .filter(Job.space_id == space_id)
        .filter(Job.status == "running")
        .filter(Job.claimed_at.is_not(None))
        .filter(Job.worker_id == worker_id)
        .all()
    )
    recovered = 0
    for job in running_jobs:
        assert job.claimed_at is not None
        if job.job_id in active_ids:
            continue
        if job.claimed_at + timedelta(seconds=settings.orphaned_claimed_job_grace_seconds) > now:
            continue
        job.status = "failed"
        job.error_text = (
            "Worker job orphaned after worker heartbeat no longer reported it as active; "
            "released to unblock queued input."
        )
        job.completed_at = now
        job.updated_at = now
        recovered += 1
        if job.target_session_id and _job_updates_target_session(job):
            session = (
                db.query(AgentSession)
                .filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id)
                .one_or_none()
            )
            if session:
                session.status = _session_status_after_stale_job(db, session)
                session.updated_at = now
        write_event(
            db,
            space_id=job.space_id,
            actor_type="system",
            actor_id="orphaned-job-recovery",
            source_type="job",
            source_id=job.job_id,
            event_type="job.fail_orphaned",
            level="warning",
            payload={
                "type": "stale_job",
                "worker_id": worker_id,
                "job_id": job.job_id,
                "kind": job.kind,
                "reason": "worker_restart_without_active_job",
                "recovery_action": "failed_unblock_queued_input",
                "grace_seconds": settings.orphaned_claimed_job_grace_seconds,
                "active_job_count": len(active_ids),
            },
        )
    return recovered


def recover_stale_running_jobs(db: Session, worker_id: str, space_id: str | None = None) -> int:
    worker_query = db.query(Worker).filter(Worker.worker_id == worker_id)
    if space_id is not None:
        worker_query = worker_query.filter(Worker.space_id == space_id)
    worker = worker_query.one_or_none()
    worker_space_id = space_id if space_id is not None else worker.space_id if worker is not None else None
    running_jobs = (
        db.query(Job)
        .filter(Job.space_id == worker_space_id)
        .filter(Job.status == "running")
        .filter(Job.claimed_at.is_not(None))
        .filter((Job.worker_id == worker_id) | (Job.worker_id.is_(None)))
        .all()
    )
    return _recover_job_rows(db, running_jobs, worker_id_for_event=worker_id)


def _recover_disconnected_worker_jobs(db: Session, worker: Worker, now: datetime) -> int:
    settings = get_settings()
    running_jobs = (
        db.query(Job)
        .filter(Job.space_id == worker.space_id)
        .filter(Job.status == "running")
        .filter(Job.claimed_at.is_not(None))
        .filter(Job.worker_id == worker.worker_id)
        .all()
    )
    recovered = 0
    for job in running_jobs:
        assert job.claimed_at is not None
        if job.claimed_at + timedelta(seconds=settings.orphaned_claimed_job_grace_seconds) > now:
            continue
        job.status = "failed"
        job.error_text = (
            f"Worker heartbeat expired after {settings.heartbeat_offline_seconds} seconds; "
            "released to unblock queued input."
        )
        job.completed_at = now
        job.updated_at = now
        recovered += 1
        if job.target_session_id and _job_updates_target_session(job):
            session = (
                db.query(AgentSession)
                .filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id)
                .one_or_none()
            )
            if session:
                session.status = _session_status_after_stale_job(db, session)
                session.updated_at = now
        write_event(
            db,
            space_id=job.space_id,
            actor_type="system",
            actor_id="worker-heartbeat-recovery",
            source_type="job",
            source_id=job.job_id,
            event_type="job.fail_worker_offline",
            level="warning",
            payload={
                "type": "worker_offline",
                "worker_id": worker.worker_id,
                "job_id": job.job_id,
                "kind": job.kind,
                "reason": "worker_heartbeat_expired",
                "recovery_action": "failed_unblock_queued_input",
                "heartbeat_offline_seconds": settings.heartbeat_offline_seconds,
            },
        )
    return recovered


def recover_disconnected_workers_for_space(db: Session, space_id: str | None) -> int:
    settings = get_settings()
    now = utcnow()
    cutoff = now - timedelta(seconds=settings.heartbeat_offline_seconds)
    stale_workers = (
        db.query(Worker)
        .filter(Worker.space_id == space_id)
        .filter(Worker.status != "offline")
        .filter(Worker.last_heartbeat_at.is_not(None))
        .filter(Worker.last_heartbeat_at < cutoff)
        .all()
    )
    changed = 0
    for worker in stale_workers:
        worker.status = "offline"
        worker.updated_at = now
        changed += 1
        changed += _recover_disconnected_worker_jobs(db, worker, now)
        write_event(
            db,
            space_id=worker.space_id,
            actor_type="system",
            actor_id="worker-heartbeat-recovery",
            source_type="worker",
            source_id=worker.worker_id,
            event_type="worker.offline_heartbeat_expired",
            level="warning",
            payload={
                "type": "worker_offline",
                "worker_id": worker.worker_id,
                "job_id": None,
                "reason": "heartbeat_expired",
                "heartbeat_offline_seconds": settings.heartbeat_offline_seconds,
            },
        )
    return changed


def recover_stale_running_jobs_for_space(db: Session, space_id: str | None) -> int:
    recovered = recover_disconnected_workers_for_space(db, space_id)
    worker_ids = [
        row[0]
        for row in db.query(Worker.worker_id)
        .filter(Worker.space_id == space_id)
        .filter(Worker.worker_id.is_not(None))
        .all()
    ]
    query = (
        db.query(Job)
        .filter(Job.space_id == space_id)
        .filter(Job.status == "running")
        .filter(Job.claimed_at.is_not(None))
    )
    if worker_ids:
        query = query.filter((Job.worker_id.in_(worker_ids)) | (Job.worker_id.is_(None)))
    else:
        query = query.filter(Job.worker_id.is_(None))
    return recovered + _recover_job_rows(db, query.all(), worker_id_for_event="unassigned")
