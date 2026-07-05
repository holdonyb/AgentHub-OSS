from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from fastapi import Query

from app.core.deps import Actor, DbSession, require_min_role
from app.models import Event, Job, utcnow
from app.services import event_out, job_summary_out

router = APIRouter()


@router.get("/api/events/slo-source")
def reliability_slo_source(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(5000, ge=1, le=20000),
):
    cutoff = utcnow() - timedelta(days=days)
    events = (
        db.query(Event)
        .filter(Event.space_id == actor.space_id)
        .filter(Event.created_at >= cutoff)
        .order_by(Event.created_at.asc(), Event.id.asc())
        .limit(limit)
        .all()
    )
    jobs = (
        db.query(Job)
        .filter(Job.space_id == actor.space_id)
        .filter(Job.created_at >= cutoff)
        .order_by(Job.created_at.asc(), Job.id.asc())
        .limit(limit)
        .all()
    )
    return {
        "window_days": days,
        "window_start": cutoff,
        "generated_at": utcnow(),
        "event_count": len(events),
        "job_count": len(jobs),
        "events": [event_out(event) for event in events],
        "jobs": [job_summary_out(job) for job in jobs],
    }


@router.get("/api/events")
def list_events(db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    events = db.query(Event).filter(Event.space_id == actor.space_id).order_by(Event.created_at.desc()).limit(200).all()
    return {"items": [event_out(event) for event in events]}

