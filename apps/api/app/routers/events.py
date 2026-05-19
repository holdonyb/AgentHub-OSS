from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import Actor, DbSession, require_min_role
from app.models import Event
from app.services import event_out

router = APIRouter()


@router.get("/api/events")
def list_events(db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    events = db.query(Event).filter(Event.space_id == actor.space_id).order_by(Event.created_at.desc()).limit(200).all()
    return {"items": [event_out(event) for event in events]}

