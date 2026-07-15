from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.json import dumps_json
from app.models import (
    AgentPermission,
    AgentSession,
    Event,
    Job,
    NotificationDelivery,
    NotificationRecord,
    PushDevice,
    SpaceMembership,
    utcnow,
)


NOTIFIABLE_EVENT_TYPES = {"job.complete", "job.fail", "permission.request"}
NOTIFIABLE_JOB_KINDS = {"session_input", "session_start", "session_fork"}
NOTIFICATION_TITLE_LIMIT = 240
NOTIFICATION_BODY_LIMIT = 500


def _notification_summary(value: str | None, fallback: str, *, limit: int) -> str:
    compact = " ".join((value or fallback).split()) or fallback
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 3)].rstrip() + "..."


def notification_out(record: NotificationRecord) -> dict[str, Any]:
    return {
        "notification_id": record.notification_id,
        "notification_type": record.notification_type,
        "source_type": record.source_type,
        "source_id": record.source_id,
        "session_id": record.session_id,
        "title": record.title,
        "body": record.body,
        "severity": record.severity,
        "status": record.status,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "delivered_at": record.delivered_at,
        "read_at": record.read_at,
        "acknowledged_at": record.acknowledged_at,
        "dismissed_at": record.dismissed_at,
    }


def _session_label(session: AgentSession | None) -> str:
    if session is None:
        return "Agent session"
    return (
        session.custom_title
        or session.llm_title
        or session.display_title
        or session.heuristic_title
        or session.title
        or session.project_name
        or session.session_id
    )


def _ledger_payload(
    db: Session,
    *,
    event_type: str,
    source_id: str,
    level: str,
) -> dict[str, str | None] | None:
    if event_type == "permission.request":
        permission = db.query(AgentPermission).filter(AgentPermission.permission_id == source_id).one_or_none()
        if permission is None:
            return None
        session = (
            db.query(AgentSession)
            .filter(
                AgentSession.space_id == permission.space_id,
                AgentSession.session_id == permission.session_id,
            )
            .one_or_none()
        )
        return {
            "transition_key": f"permission:{permission.permission_id}",
            "notification_type": "approval",
            "source_type": "permission",
            "source_id": permission.permission_id,
            "session_id": permission.session_id,
            "title": _notification_summary(
                permission.title or f"{_session_label(session)} is waiting",
                "Approval required",
                limit=NOTIFICATION_TITLE_LIMIT,
            ),
            "body": _notification_summary(
                permission.description,
                "Open the session to respond.",
                limit=NOTIFICATION_BODY_LIMIT,
            ),
            "severity": "warning",
        }

    if event_type not in {"job.complete", "job.fail"}:
        return None
    job = db.query(Job).filter(Job.job_id == source_id).one_or_none()
    if job is None or not job.target_session_id or job.kind not in NOTIFIABLE_JOB_KINDS:
        return None
    session = (
        db.query(AgentSession)
        .filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id)
        .one_or_none()
    )
    failed = event_type == "job.fail"
    return {
        "transition_key": f"{event_type}:{job.job_id}",
        "notification_type": "failure" if failed else "completion",
        "source_type": "job",
        "source_id": job.job_id,
        "session_id": job.target_session_id,
        "title": _notification_summary(
            f"{_session_label(session)} {'failed' if failed else 'completed'}",
            "Agent task update",
            limit=NOTIFICATION_TITLE_LIMIT,
        ),
        "body": "Open the session to review the error." if failed else "Open the session to review the result.",
        "severity": "error" if failed or level == "error" else "info",
    }


def _persist_notification_records(
    db: Session,
    *,
    space_id: str | None,
    event_type: str,
    source_id: str,
    level: str,
    enqueue_push: bool = True,
) -> None:
    if not space_id:
        return
    payload = _ledger_payload(db, event_type=event_type, source_id=source_id, level=level)
    if payload is None:
        return
    memberships = db.query(SpaceMembership).filter(SpaceMembership.space_id == space_id).all()
    for membership in memberships:
        existing = (
            db.query(NotificationRecord)
            .filter(
                NotificationRecord.space_id == space_id,
                NotificationRecord.recipient_user_id == membership.user_id,
                NotificationRecord.transition_key == payload["transition_key"],
            )
            .one_or_none()
        )
        if existing is not None:
            continue
        record = NotificationRecord(
            space_id=space_id,
            recipient_user_id=membership.user_id,
            transition_key=str(payload["transition_key"]),
            notification_type=str(payload["notification_type"]),
            source_type=str(payload["source_type"]),
            source_id=str(payload["source_id"]),
            session_id=str(payload["session_id"]) if payload["session_id"] else None,
            title=str(payload["title"]),
            body=str(payload["body"]),
            severity=str(payload["severity"]),
        )
        db.add(record)
        if not enqueue_push:
            continue
        db.flush([record])
        devices = (
            db.query(PushDevice)
            .filter(
                PushDevice.space_id == space_id,
                PushDevice.user_id == membership.user_id,
                PushDevice.enabled.is_(True),
            )
            .all()
        )
        for device in devices:
            db.add(
                NotificationDelivery(
                    notification_record_id=record.id,
                    push_device_id=device.id,
                )
            )


def acknowledge_source_notifications(
    db: Session,
    *,
    space_id: str | None,
    source_type: str,
    source_id: str,
) -> int:
    if not space_id:
        return 0
    rows = (
        db.query(NotificationRecord)
        .filter(
            NotificationRecord.space_id == space_id,
            NotificationRecord.source_type == source_type,
            NotificationRecord.source_id == source_id,
            NotificationRecord.status.in_(["pending", "delivered", "read"]),
        )
        .all()
    )
    now = utcnow()
    for row in rows:
        if row.delivered_at is None:
            row.delivered_at = now
        if row.read_at is None:
            row.read_at = now
        if row.acknowledged_at is None:
            row.acknowledged_at = now
        row.status = "acknowledged"
        row.updated_at = now
    return len(rows)


def backfill_pending_notification_records(db: Session) -> int:
    permissions = (
        db.query(AgentPermission)
        .filter(
            AgentPermission.status == "pending",
            AgentPermission.space_id.is_not(None),
        )
        .all()
    )
    before = len(db.new)
    for permission in permissions:
        _persist_notification_records(
            db,
            space_id=permission.space_id,
            event_type="permission.request",
            source_id=permission.permission_id,
            level="warning",
            enqueue_push=False,
        )
    return len(db.new) - before


def _target_host(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc or parsed.path


def _add_notification_event(
    db: Session,
    *,
    space_id: str | None,
    source_type: str,
    source_id: str,
    event_type: str,
    level: str,
    payload: dict[str, Any],
) -> None:
    db.add(
        Event(
            space_id=space_id,
            actor_type="system",
            actor_id="notification-dispatcher",
            source_type=source_type,
            source_id=source_id,
            event_type=event_type,
            level=level,
            payload_json=dumps_json(payload),
        )
    )


def notify_for_audit_event(
    db: Session,
    *,
    space_id: str | None,
    actor_type: str,
    actor_id: str,
    source_type: str,
    source_id: str,
    event_type: str,
    level: str,
    payload: dict[str, Any] | None,
) -> None:
    if event_type not in NOTIFIABLE_EVENT_TYPES:
        return

    _persist_notification_records(
        db,
        space_id=space_id,
        event_type=event_type,
        source_id=source_id,
        level=level,
    )

    settings = get_settings()
    webhook_url = settings.notification_webhook_url.strip()
    if not webhook_url:
        return

    attempts = settings.notification_max_attempts
    timeout = settings.notification_timeout_seconds
    backoff = settings.notification_backoff_seconds
    notification_payload = {
        "notification_type": event_type,
        "source_type": source_type,
        "source_id": source_id,
        "level": level,
        "actor_type": actor_type,
        "actor_id": actor_id,
        "payload": payload or {},
    }
    reason = "unknown"
    for attempt in range(1, attempts + 1):
        try:
            response = httpx.post(webhook_url, json=notification_payload, timeout=timeout)
        except httpx.TimeoutException:
            reason = "timeout"
        except Exception as exc:  # pragma: no cover - concrete exception type depends on transport.
            reason = f"{type(exc).__name__}: {exc}"
        else:
            if 200 <= response.status_code < 300:
                _add_notification_event(
                    db,
                    space_id=space_id,
                    source_type=source_type,
                    source_id=source_id,
                    event_type="notification.delivered",
                    level="info",
                    payload={
                        "notification_type": event_type,
                        "attempts": attempt,
                        "target_host": _target_host(webhook_url),
                        "status_code": response.status_code,
                    },
                )
                return
            reason = f"http_{response.status_code}"

        if attempt < attempts and backoff > 0:
            time.sleep(backoff * (2 ** (attempt - 1)))

    _add_notification_event(
        db,
        space_id=space_id,
        source_type=source_type,
        source_id=source_id,
        event_type="notification.delivery_failed",
        level="warning",
        payload={
            "notification_type": event_type,
            "attempts": attempts,
            "target_host": _target_host(webhook_url),
            "reason": reason,
            "retry_exhausted": True,
        },
    )
