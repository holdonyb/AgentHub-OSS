from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.models import AgentSession, AgentTimeline
from app.routers.internal import _assert_worker_binding
from app.schemas import TimelinePublishIn
from app.services import sync_session_from_timeline, timeline_item_out, upsert_timeline_items

router = APIRouter()


@router.get("/api/sessions/{session_id}/timeline")
def get_session_timeline(
    session_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    limit: int = 100,
    before: int | None = None,
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    query = db.query(AgentTimeline).filter(AgentTimeline.space_id == actor.space_id, AgentTimeline.session_id == session_id)
    if before is not None:
        query = query.filter(AgentTimeline.seq < before)
    page_size = max(1, min(limit, 500))
    rows = query.order_by(AgentTimeline.seq.desc()).limit(page_size + 1).all()
    has_more = len(rows) > page_size
    page_rows = rows[:page_size]
    return {"items": [timeline_item_out(item) for item in reversed(page_rows)], "has_more": has_more}


@router.post("/api/internal/sessions/{session_id}/timeline")
def publish_session_timeline(
    session_id: str,
    payload: TimelinePublishIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    session = db.query(AgentSession).filter(AgentSession.space_id == worker.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    if session.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Session is not owned by this worker", "code": "SESSION_WORKER_MISMATCH"})
    saved = upsert_timeline_items(db, session_id, payload.items, replace=payload.replace, space_id=session.space_id)
    sync_session_from_timeline(db, session)
    db.commit()
    return {"items": [timeline_item_out(item) for item in saved]}
