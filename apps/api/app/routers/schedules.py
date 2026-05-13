from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role
from app.core.json import dumps_json
from app.models import Schedule, utcnow
from app.schemas import ScheduleCreateIn, SchedulePatchIn
from app.services import ALLOWED_JOB_KINDS, schedule_out

router = APIRouter()


def _validate_job_kind(job_kind: str) -> None:
    if job_kind not in ALLOWED_JOB_KINDS:
        raise HTTPException(status_code=400, detail={"message": "Job kind is not allowed", "code": "JOB_KIND_NOT_ALLOWED"})


@router.get("/api/schedules")
def list_schedules(db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    schedules = db.query(Schedule).filter(Schedule.space_id == actor.space_id).order_by(Schedule.created_at.desc()).all()
    return {"items": [schedule_out(schedule) for schedule in schedules]}


@router.post("/api/schedules")
def create_schedule(payload: ScheduleCreateIn, db: DbSession, actor: Actor = Depends(require_min_role("admin"))):
    _validate_job_kind(payload.job_kind)
    now = utcnow()
    schedule = Schedule(
        space_id=actor.space_id,
        name=payload.name,
        job_kind=payload.job_kind,
        enabled=payload.enabled,
        interval_seconds=payload.interval_seconds,
        target_worker_id=payload.target_worker_id,
        backend=payload.backend,
        namespace=payload.namespace,
        payload_json=dumps_json(payload.payload),
        created_by=actor.actor_id,
        next_run_at=now if payload.enabled else None,
    )
    db.add(schedule)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="schedule",
        source_id=schedule.schedule_id,
        event_type="schedule.create",
        payload={"job_kind": schedule.job_kind},
    )
    db.commit()
    return {"schedule": schedule_out(schedule)}


@router.patch("/api/schedules/{schedule_id}")
def update_schedule(
    schedule_id: str,
    payload: SchedulePatchIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    schedule = db.query(Schedule).filter(Schedule.space_id == actor.space_id, Schedule.schedule_id == schedule_id).one_or_none()
    if schedule is None:
        raise HTTPException(status_code=404, detail={"message": "Schedule not found", "code": "SCHEDULE_NOT_FOUND"})
    changes = payload.model_dump(exclude_unset=True)
    if "job_kind" in changes:
        _validate_job_kind(str(changes["job_kind"]))
    for key, value in changes.items():
        if key == "payload":
            schedule.payload_json = dumps_json(value or {})
        elif hasattr(schedule, key):
            setattr(schedule, key, value)
    schedule.updated_at = utcnow()
    if schedule.enabled and schedule.next_run_at is None:
        schedule.next_run_at = utcnow() + timedelta(seconds=schedule.interval_seconds)
    if not schedule.enabled:
        schedule.next_run_at = None
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="schedule",
        source_id=schedule.schedule_id,
        event_type="schedule.update",
    )
    db.commit()
    return {"schedule": schedule_out(schedule)}


@router.delete("/api/schedules/{schedule_id}")
def delete_schedule(schedule_id: str, db: DbSession, actor: Actor = Depends(require_min_role("admin"))):
    schedule = db.query(Schedule).filter(Schedule.space_id == actor.space_id, Schedule.schedule_id == schedule_id).one_or_none()
    if schedule is None:
        raise HTTPException(status_code=404, detail={"message": "Schedule not found", "code": "SCHEDULE_NOT_FOUND"})
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="schedule",
        source_id=schedule.schedule_id,
        event_type="schedule.delete",
    )
    db.delete(schedule)
    db.commit()
    return {"ok": True}
