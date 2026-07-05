from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query

from app.core.deps import Actor, DbSession, require_min_role
from app.core.json import loads_json
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


def _event_payload_matches(
    event: Event,
    *,
    payload_type: str | None,
    worker_id: str | None,
    job_id: str | None,
    reason: str | None,
) -> bool:
    payload = loads_json(event.payload_json, {})
    if not isinstance(payload, dict):
        payload = {}
    checks = {
        "type": payload_type,
        "worker_id": worker_id,
        "job_id": job_id,
        "reason": reason,
    }
    for key, expected in checks.items():
        if expected is None:
            continue
        value = payload.get(key)
        if value is None or str(value) != expected:
            return False
    return True


@router.get("/api/events")
def list_events(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    event_type: str | None = None,
    source_type: str | None = None,
    source_id: str | None = None,
    payload_type: str | None = None,
    worker_id: str | None = None,
    job_id: str | None = None,
    reason: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
):
    query = db.query(Event).filter(Event.space_id == actor.space_id)
    if event_type:
        query = query.filter(Event.event_type == event_type)
    if source_type:
        query = query.filter(Event.source_type == source_type)
    if source_id:
        query = query.filter(Event.source_id == source_id)
    candidate_limit = limit if not any([payload_type, worker_id, job_id, reason]) else 1000
    events = query.order_by(Event.created_at.desc()).limit(candidate_limit).all()
    events = [
        event
        for event in events
        if _event_payload_matches(
            event,
            payload_type=payload_type,
            worker_id=worker_id,
            job_id=job_id,
            reason=reason,
        )
    ][:limit]
    return {"items": [event_out(event) for event in events]}

