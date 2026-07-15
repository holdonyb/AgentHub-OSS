from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import Actor, DbSession, require_space_user
from app.core.notifications import notification_out
from app.models import NotificationRecord, utcnow
from app.schemas import NotificationListOut, NotificationTransitionOut


router = APIRouter(tags=["notifications"])


def _require_notification(db: DbSession, actor: Actor, notification_id: str) -> NotificationRecord:
    assert actor.user is not None
    record = (
        db.query(NotificationRecord)
        .filter(
            NotificationRecord.space_id == actor.space_id,
            NotificationRecord.recipient_user_id == actor.user.id,
            NotificationRecord.notification_id == notification_id,
        )
        .one_or_none()
    )
    if record is None:
        raise HTTPException(
            status_code=404,
            detail={"message": "Notification not found", "code": "NOTIFICATION_NOT_FOUND"},
        )
    return record


@router.get("/api/notifications", response_model=NotificationListOut)
def list_notifications(
    db: DbSession,
    actor: Actor = Depends(require_space_user),
    limit: int = 100,
):
    assert actor.user is not None
    bounded_limit = max(1, min(limit, 200))
    rows = (
        db.query(NotificationRecord)
        .filter(
            NotificationRecord.space_id == actor.space_id,
            NotificationRecord.recipient_user_id == actor.user.id,
        )
        .order_by(NotificationRecord.created_at.desc(), NotificationRecord.notification_id.desc())
        .limit(bounded_limit)
        .all()
    )
    return {"items": [notification_out(row) for row in rows]}


def _transition_notification(record: NotificationRecord, target: str) -> None:
    now = utcnow()
    record.updated_at = now
    if target == "delivered":
        if record.delivered_at is None:
            record.delivered_at = now
        if record.status == "pending":
            record.status = "delivered"
    elif target == "read":
        if record.delivered_at is None:
            record.delivered_at = now
        if record.read_at is None:
            record.read_at = now
        if record.status not in {"acknowledged", "dismissed", "superseded"}:
            record.status = "read"
    elif target == "acknowledged":
        if record.delivered_at is None:
            record.delivered_at = now
        if record.read_at is None:
            record.read_at = now
        if record.acknowledged_at is None:
            record.acknowledged_at = now
        if record.status not in {"dismissed", "superseded"}:
            record.status = "acknowledged"
    elif target == "dismissed":
        if record.dismissed_at is None:
            record.dismissed_at = now
        record.status = "dismissed"


def _notification_transition_response(
    notification_id: str,
    target: str,
    db: DbSession,
    actor: Actor,
) -> dict[str, object]:
    record = _require_notification(db, actor, notification_id)
    claimed = False
    if target == "delivered":
        now = utcnow()
        claimed = bool(
            db.query(NotificationRecord)
            .filter(
                NotificationRecord.id == record.id,
                NotificationRecord.status == "pending",
                NotificationRecord.delivered_at.is_(None),
            )
            .update(
                {
                    NotificationRecord.status: "delivered",
                    NotificationRecord.delivered_at: now,
                    NotificationRecord.updated_at: now,
                },
                synchronize_session=False,
            )
        )
        db.commit()
        db.refresh(record)
        return {"notification": notification_out(record), "claimed": claimed}
    _transition_notification(record, target)
    db.commit()
    return {"notification": notification_out(record), "claimed": claimed}


@router.post("/api/notifications/{notification_id}/delivered", response_model=NotificationTransitionOut)
def mark_delivered(notification_id: str, db: DbSession, actor: Actor = Depends(require_space_user)):
    return _notification_transition_response(notification_id, "delivered", db, actor)


@router.post("/api/notifications/{notification_id}/read", response_model=NotificationTransitionOut)
def mark_read(notification_id: str, db: DbSession, actor: Actor = Depends(require_space_user)):
    return _notification_transition_response(notification_id, "read", db, actor)


@router.post("/api/notifications/{notification_id}/acknowledge", response_model=NotificationTransitionOut)
def acknowledge(notification_id: str, db: DbSession, actor: Actor = Depends(require_space_user)):
    return _notification_transition_response(notification_id, "acknowledged", db, actor)


@router.post("/api/notifications/{notification_id}/dismiss", response_model=NotificationTransitionOut)
def dismiss(notification_id: str, db: DbSession, actor: Actor = Depends(require_space_user)):
    return _notification_transition_response(notification_id, "dismissed", db, actor)


@router.post("/api/notifications/read-all")
def mark_all_read(db: DbSession, actor: Actor = Depends(require_space_user)):
    assert actor.user is not None
    rows = (
        db.query(NotificationRecord)
        .filter(
            NotificationRecord.space_id == actor.space_id,
            NotificationRecord.recipient_user_id == actor.user.id,
            NotificationRecord.status.in_(["pending", "delivered"]),
        )
        .all()
    )
    for row in rows:
        _transition_notification(row, "read")
    db.commit()
    return {"updated": len(rows)}
