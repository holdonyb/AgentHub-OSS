from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, case, or_
from sqlalchemy.orm import load_only

from app.core.deps import Actor, DbSession, require_min_role
from app.core.json import dumps_json
from app.models import AgentPermission, AgentSession, AgentTimeline, Job, ProviderSnapshot, Schedule, Worker
from app.schemas import InboxSyncOut, PermissionSyncOut, SessionSyncOut, SyncStatusOut
from app.services import job_out, permission_out, session_out, session_summary_out, timeline_item_out

router = APIRouter()
EPOCH_UTC = datetime.fromtimestamp(0, tz=timezone.utc)
SESSION_SYNC_LOAD_ONLY = (
    AgentSession.space_id,
    AgentSession.session_id,
    AgentSession.backend,
    AgentSession.worker_id,
    AgentSession.workspace_root,
    AgentSession.project_name,
    AgentSession.namespace,
    AgentSession.mode,
    AgentSession.runtime_session_ref,
    AgentSession.status,
    AgentSession.title,
    AgentSession.display_title,
    AgentSession.custom_title,
    AgentSession.heuristic_title,
    AgentSession.llm_title,
    AgentSession.activity_summary,
    AgentSession.last_message,
    AgentSession.last_activity_at,
    AgentSession.last_role,
    AgentSession.controls_json,
    AgentSession.archived_at,
    AgentSession.updated_at,
)


def _iso(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "tzinfo"):
        return value.astimezone(timezone.utc).isoformat() if value.tzinfo else value.isoformat()
    return str(value)


def _digest_rows(rows: list[tuple[Any, ...]]) -> str:
    payload = [[_iso(value) for value in row] for row in rows]
    return hashlib.sha256(dumps_json(payload).encode("utf-8")).hexdigest()


def _latest_timestamp(*rows: tuple[Any, ...]) -> datetime:
    latest: datetime | None = None
    for row in rows:
        for value in row:
            if not isinstance(value, datetime):
                continue
            candidate = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            if latest is None or candidate > latest:
                latest = candidate
    return latest or EPOCH_UTC


def _session_rows(db: DbSession, space_id: str | None, archived: bool) -> list[tuple[Any, ...]]:
    return (
        db.query(
            AgentSession.session_id,
            AgentSession.status,
            AgentSession.worker_id,
            AgentSession.last_activity_at,
            AgentSession.updated_at,
            AgentSession.archived_at,
        )
        .filter(AgentSession.space_id == space_id)
        .filter(AgentSession.archived_at.is_not(None) if archived else AgentSession.archived_at.is_(None))
        .order_by(AgentSession.session_id.asc())
        .all()
    )


def _worker_rows(db: DbSession, space_id: str | None) -> list[tuple[Any, ...]]:
    return (
        db.query(
            Worker.worker_id,
            Worker.status,
            Worker.transport_state,
            Worker.last_heartbeat_at,
            Worker.updated_at,
        )
        .filter(Worker.space_id == space_id)
        .order_by(Worker.worker_id.asc())
        .all()
    )


def _job_rows(db: DbSession, space_id: str | None) -> list[tuple[Any, ...]]:
    return (
        db.query(
            Job.job_id,
            Job.kind,
            Job.status,
            Job.target_session_id,
            Job.updated_at,
            Job.completed_at,
        )
        .filter(Job.space_id == space_id)
        .order_by(Job.job_id.asc())
        .all()
    )


def _schedule_rows(db: DbSession, space_id: str | None) -> list[tuple[Any, ...]]:
    return (
        db.query(
            Schedule.schedule_id,
            Schedule.enabled,
            Schedule.interval_seconds,
            Schedule.last_run_at,
            Schedule.next_run_at,
            Schedule.updated_at,
        )
        .filter(Schedule.space_id == space_id)
        .order_by(Schedule.schedule_id.asc())
        .all()
    )


def _provider_rows(db: DbSession, space_id: str | None) -> list[tuple[Any, ...]]:
    return (
        db.query(
            ProviderSnapshot.worker_id,
            ProviderSnapshot.backend,
            ProviderSnapshot.status,
            ProviderSnapshot.updated_at,
            ProviderSnapshot.fetched_at,
        )
        .filter(ProviderSnapshot.space_id == space_id)
        .order_by(ProviderSnapshot.worker_id.asc(), ProviderSnapshot.backend.asc())
        .all()
    )


def _permission_rows(db: DbSession, space_id: str | None) -> list[tuple[Any, ...]]:
    return (
        db.query(
            AgentPermission.permission_id,
            AgentPermission.session_id,
            AgentPermission.kind,
            AgentPermission.status,
            AgentPermission.created_at,
            AgentPermission.resolved_at,
        )
        .filter(AgentPermission.space_id == space_id)
        .order_by(AgentPermission.permission_id.asc())
        .all()
    )


def _timeline_rows(db: DbSession, space_id: str | None, session_id: str | None) -> list[tuple[Any, ...]]:
    if not session_id:
        return []
    return (
        db.query(
            AgentTimeline.session_id,
            AgentTimeline.seq,
            AgentTimeline.item_type,
            AgentTimeline.role,
            AgentTimeline.status,
            AgentTimeline.created_at,
        )
        .filter(AgentTimeline.space_id == space_id, AgentTimeline.session_id == session_id)
        .order_by(AgentTimeline.seq.asc())
        .all()
    )


def _cursor_datetime(value: datetime | None) -> datetime:
    if value is None:
        return EPOCH_UTC
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _encode_cursor(value: datetime | None, item_id: str | None) -> str:
    item = (item_id or "").strip()
    return f"{_cursor_datetime(value).isoformat()}|{item}"


def _decode_cursor(cursor: str | None) -> tuple[datetime, str]:
    if not cursor:
        return EPOCH_UTC, ""
    raw_value, _, raw_item = cursor.partition("|")
    try:
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"message": "Invalid sync cursor", "code": "SYNC_CURSOR_INVALID"}) from exc
    return _cursor_datetime(parsed), raw_item.strip()


def _encode_timeline_cursor(value: datetime | None, seq: int | None) -> str:
    return f"{_cursor_datetime(value).isoformat()}|{int(seq or 0)}"


def _decode_timeline_cursor(cursor: str | None) -> tuple[datetime, int]:
    changed_after, raw_seq = _decode_cursor(cursor)
    try:
        seq_after = int(raw_seq or "0")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"message": "Invalid timeline sync cursor", "code": "SYNC_CURSOR_INVALID"}) from exc
    return changed_after, max(0, seq_after)


def _timeline_delta_query(
    db: DbSession,
    space_id: str | None,
    session_id: str,
    *,
    cursor: str | None,
    after_seq: int,
):
    query = db.query(AgentTimeline).filter(AgentTimeline.space_id == space_id, AgentTimeline.session_id == session_id)
    if cursor:
        updated_after, seq_after = _decode_timeline_cursor(cursor)
        query = query.filter(
            or_(
                AgentTimeline.updated_at > updated_after,
                and_(AgentTimeline.updated_at == updated_after, AgentTimeline.seq > seq_after),
            )
        )
        return query.order_by(AgentTimeline.updated_at.asc(), AgentTimeline.seq.asc())
    if after_seq > 0:
        query = query.filter(AgentTimeline.seq > after_seq)
    return query.order_by(AgentTimeline.seq.asc())


def _session_delta_query(db: DbSession, space_id: str | None, cursor: str | None):
    updated_after, session_after = _decode_cursor(cursor)
    query = db.query(AgentSession).options(load_only(*SESSION_SYNC_LOAD_ONLY)).filter(AgentSession.space_id == space_id)
    if cursor:
        query = query.filter(
            or_(
                AgentSession.updated_at > updated_after,
                and_(AgentSession.updated_at == updated_after, AgentSession.session_id > session_after),
            )
        )
    return query.order_by(AgentSession.updated_at.asc(), AgentSession.session_id.asc())


def _permission_changed_at():
    return case(
        (AgentPermission.resolved_at.is_not(None), AgentPermission.resolved_at),
        else_=AgentPermission.created_at,
    )


def _permission_delta_query(db: DbSession, space_id: str | None, cursor: str | None):
    changed_after, permission_after = _decode_cursor(cursor)
    changed_at = _permission_changed_at()
    query = db.query(AgentPermission, changed_at.label("changed_at")).filter(AgentPermission.space_id == space_id)
    if cursor:
        query = query.filter(
            or_(
                changed_at > changed_after,
                and_(changed_at == changed_after, AgentPermission.permission_id > permission_after),
            )
        )
    return query.order_by(changed_at.asc(), AgentPermission.permission_id.asc())


@router.get("/api/sync/status", response_model=SyncStatusOut)
def get_sync_status(
    db: DbSession,
    archived: bool = Query(default=False),
    selected_session_id: str | None = Query(default=None),
    actor: Actor = Depends(require_min_role("viewer")),
) -> SyncStatusOut:
    session_rows = _session_rows(db, actor.space_id, archived)
    worker_rows = _worker_rows(db, actor.space_id)
    job_rows = _job_rows(db, actor.space_id)
    schedule_rows = _schedule_rows(db, actor.space_id)
    provider_rows = _provider_rows(db, actor.space_id)
    permission_rows = _permission_rows(db, actor.space_id)
    timeline_rows = _timeline_rows(db, actor.space_id, selected_session_id)
    return SyncStatusOut(
        archived=archived,
        selected_session_id=selected_session_id,
        sessions_digest=_digest_rows(session_rows),
        workers_digest=_digest_rows(worker_rows),
        jobs_digest=_digest_rows(job_rows),
        schedules_digest=_digest_rows(schedule_rows),
        providers_digest=_digest_rows(provider_rows),
        permissions_digest=_digest_rows(permission_rows),
        selected_timeline_digest=_digest_rows(timeline_rows),
        generated_at=_latest_timestamp(
            *session_rows,
            *worker_rows,
            *job_rows,
            *schedule_rows,
            *provider_rows,
            *permission_rows,
            *timeline_rows,
        ),
    )


@router.get("/api/sync/inbox", response_model=InboxSyncOut)
def get_inbox_sync(
    db: DbSession,
    archived: bool = Query(default=False),
    cursor: str = Query(default=""),
    limit: int = Query(default=200, ge=1, le=1000),
    actor: Actor = Depends(require_min_role("viewer")),
) -> InboxSyncOut:
    rows = _session_delta_query(db, actor.space_id, cursor).limit(limit).all()
    items = [
        session_summary_out(session)
        for session in rows
        if (session.archived_at is not None) == archived
    ]
    removed_session_ids = [
        session.session_id
        for session in rows
        if (session.archived_at is not None) != archived
    ]
    next_cursor = cursor
    if rows:
        tail = rows[-1]
        next_cursor = _encode_cursor(tail.updated_at, tail.session_id)
    return InboxSyncOut(
        archived=archived,
        cursor=next_cursor,
        items=items,
        removed_session_ids=removed_session_ids,
    )


@router.get("/api/sync/session/{session_id}", response_model=SessionSyncOut)
def get_session_sync(
    session_id: str,
    db: DbSession,
    cursor: str = Query(default=""),
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    actor: Actor = Depends(require_min_role("viewer")),
) -> SessionSyncOut:
    session = (
        db.query(AgentSession)
        .filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id)
        .one_or_none()
    )
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    timeline_rows = _timeline_delta_query(
        db,
        actor.space_id,
        session_id,
        cursor=cursor,
        after_seq=after_seq,
    ).limit(limit + 1).all()
    has_more = len(timeline_rows) > limit
    page_rows = timeline_rows[:limit]
    job_rows = (
        db.query(Job)
        .filter(Job.space_id == actor.space_id, Job.target_session_id == session_id)
        .order_by(Job.updated_at.desc(), Job.created_at.desc())
        .limit(20)
        .all()
    )
    next_after_seq = after_seq
    if page_rows:
        next_after_seq = max(after_seq, page_rows[-1].seq)
    next_after_cursor = cursor
    if page_rows:
        next_after_cursor = _encode_timeline_cursor(page_rows[-1].updated_at, page_rows[-1].seq)
    return SessionSyncOut(
        session=session_out(session),
        items=[timeline_item_out(item) for item in page_rows],
        jobs=[job_out(job) for job in job_rows],
        next_after_seq=next_after_seq,
        next_after_cursor=next_after_cursor,
        has_more=has_more,
    )


@router.get("/api/sync/permissions", response_model=PermissionSyncOut)
def get_permission_sync(
    db: DbSession,
    cursor: str = Query(default=""),
    limit: int = Query(default=200, ge=1, le=1000),
    actor: Actor = Depends(require_min_role("viewer")),
) -> PermissionSyncOut:
    rows = _permission_delta_query(db, actor.space_id, cursor).limit(limit).all()
    next_cursor = cursor
    if rows:
        _, changed_at = rows[-1]
        next_cursor = _encode_cursor(changed_at, rows[-1][0].permission_id)
    return PermissionSyncOut(
        cursor=next_cursor,
        items=[permission_out(permission) for permission, _changed_at in rows],
    )
