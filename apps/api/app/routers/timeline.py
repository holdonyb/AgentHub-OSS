from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_

from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.models import AgentSession, AgentTimeline
from app.routers.internal import _assert_worker_binding
from app.schemas import TimelinePublishIn
from app.services import (
    ensure_session_summary_timeline_row,
    ensure_codex_plan_exit_permission_from_timeline,
    ensure_missing_codex_plan_exit_permission_from_session_timeline,
    expire_pending_permissions_superseded_by_timeline,
    sync_session_from_timeline,
    timeline_item_out,
    upsert_timeline_items,
)

router = APIRouter()


def _normalize_cursor_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/api/sessions/{session_id}/timeline")
def get_session_timeline(
    session_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    limit: int = 100,
    before: int | None = None,
    before_created_at: datetime | None = None,
    before_seq: int | None = None,
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    plan_exit_permission, expired_permissions = ensure_missing_codex_plan_exit_permission_from_session_timeline(db, session)
    summary_row = ensure_session_summary_timeline_row(db, session)
    if plan_exit_permission is not None or expired_permissions or summary_row is not None:
        db.commit()
    query = db.query(AgentTimeline).filter(AgentTimeline.space_id == actor.space_id, AgentTimeline.session_id == session_id)
    cursor_created_at = _normalize_cursor_datetime(before_created_at)
    if cursor_created_at is not None:
        if before_seq is None:
            query = query.filter(AgentTimeline.created_at < cursor_created_at)
        else:
            query = query.filter(
                or_(
                    AgentTimeline.created_at < cursor_created_at,
                    and_(AgentTimeline.created_at == cursor_created_at, AgentTimeline.seq < before_seq),
                )
            )
    elif before is not None:
        query = query.filter(AgentTimeline.seq < before)
    page_size = max(1, min(limit, 500))
    rows = query.order_by(AgentTimeline.created_at.desc(), AgentTimeline.seq.desc()).limit(page_size + 1).all()
    has_more = len(rows) > page_size
    page_rows = rows[:page_size]
    ordered_rows = list(reversed(page_rows))
    next_after_seq = max((item.seq for item in ordered_rows), default=0)
    next_after_cursor = ""
    if ordered_rows:
        tail = ordered_rows[-1]
        tail_updated = tail.updated_at.astimezone(timezone.utc) if tail.updated_at.tzinfo else tail.updated_at.replace(tzinfo=timezone.utc)
        next_after_cursor = f"{tail_updated.isoformat()}|{tail.seq}"
    return {
        "items": [timeline_item_out(item) for item in ordered_rows],
        "has_more": has_more,
        "next_after_seq": next_after_seq,
        "next_after_cursor": next_after_cursor,
    }


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
    expire_pending_permissions_superseded_by_timeline(db, session, saved)
    ensure_codex_plan_exit_permission_from_timeline(db, session, saved)
    db.commit()
    return {"items": [timeline_item_out(item) for item in saved]}
