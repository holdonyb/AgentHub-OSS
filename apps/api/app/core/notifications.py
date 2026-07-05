from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.json import dumps_json
from app.models import Event


NOTIFIABLE_EVENT_TYPES = {"job.complete", "permission.request"}


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
