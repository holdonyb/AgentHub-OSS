from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core.json import dumps_json
from app.core.notifications import notify_for_audit_event
from app.models import Event


def write_event(
    db: Session,
    *,
    space_id: str | None = None,
    actor_type: str,
    actor_id: str,
    source_type: str,
    source_id: str,
    event_type: str,
    level: str = "info",
    payload: dict[str, Any] | None = None,
) -> Event:
    event = Event(
        space_id=space_id,
        actor_type=actor_type,
        actor_id=actor_id,
        source_type=source_type,
        source_id=source_id,
        event_type=event_type,
        level=level,
        payload_json=dumps_json(payload or {}),
    )
    db.add(event)
    notify_for_audit_event(
        db,
        space_id=space_id,
        actor_type=actor_type,
        actor_id=actor_id,
        source_type=source_type,
        source_id=source_id,
        event_type=event_type,
        level=level,
        payload=payload,
    )
    return event

