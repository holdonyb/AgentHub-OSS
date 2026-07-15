from __future__ import annotations

from datetime import timedelta
import logging
from threading import Event as ThreadEvent, Thread
from typing import Any, Protocol

import httpx
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import NotificationDelivery, NotificationRecord, PushDevice, utcnow


logger = logging.getLogger("agenthub.push")


class PushHttpClient(Protocol):
    def post(self, url: str, **kwargs: Any) -> Any: ...


def _headers(settings: Settings) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if settings.expo_push_access_token:
        headers["Authorization"] = f"Bearer {settings.expo_push_access_token}"
    return headers


def _post_json(
    settings: Settings,
    url: str,
    payload: object,
    http_client: PushHttpClient | None,
) -> object:
    client = http_client or httpx.Client()
    try:
        response = client.post(
            url,
            json=payload,
            headers=_headers(settings),
            timeout=settings.expo_push_timeout_seconds,
        )
        response.raise_for_status()
        return response.json()
    finally:
        if http_client is None:
            client.close()


def _error_text(error: object) -> str:
    compact = " ".join(str(error).split()) or type(error).__name__
    return compact[:500]


def _retry_or_fail(delivery: NotificationDelivery, settings: Settings, error: object) -> str:
    now = utcnow()
    delivery.last_error = _error_text(error)
    delivery.updated_at = now
    if delivery.attempts >= settings.expo_push_max_attempts:
        delivery.status = "failed"
        delivery.next_attempt_at = None
        return "failed"
    delay = settings.expo_push_backoff_seconds * (2 ** max(0, delivery.attempts - 1))
    delivery.status = "retry"
    delivery.next_attempt_at = now + timedelta(seconds=delay)
    return "retry"


def _disable_device(db: Session, device: PushDevice, reason: object) -> None:
    now = utcnow()
    device.enabled = False
    device.push_token = ""
    device.revoked_at = now
    device.updated_at = now
    db.query(NotificationDelivery).filter(
        NotificationDelivery.push_device_id == device.id,
        NotificationDelivery.status.in_(["queued", "retry", "sending", "ticketed"]),
    ).update(
        {
            NotificationDelivery.status: "disabled",
            NotificationDelivery.last_error: _error_text(reason),
            NotificationDelivery.next_attempt_at: None,
            NotificationDelivery.updated_at: now,
        },
        synchronize_session=False,
    )


def _message(record: NotificationRecord, device: PushDevice) -> dict[str, Any]:
    return {
        "to": device.push_token,
        "title": record.title,
        "body": record.body,
        "sound": "default",
        "priority": "high" if record.notification_type in {"approval", "failure"} else "default",
        "channelId": "agenthub-urgent-v1",
        "data": {
            "notificationId": record.notification_id,
            "sessionId": record.session_id,
            "notificationType": record.notification_type,
        },
    }


def dispatch_pending_pushes(
    db: Session,
    settings: Settings,
    *,
    http_client: PushHttpClient | None = None,
) -> dict[str, int]:
    result = {"ticketed": 0, "retry": 0, "failed": 0, "disabled": 0}
    if not settings.expo_push_enabled:
        return result

    now = utcnow()
    deliveries = (
        db.query(NotificationDelivery)
        .join(PushDevice, PushDevice.id == NotificationDelivery.push_device_id)
        .filter(
            PushDevice.enabled.is_(True),
            NotificationDelivery.status.in_(["queued", "retry"]),
            or_(
                NotificationDelivery.next_attempt_at.is_(None),
                NotificationDelivery.next_attempt_at <= now,
            ),
        )
        .order_by(NotificationDelivery.created_at.asc(), NotificationDelivery.delivery_id.asc())
        .limit(settings.expo_push_batch_size)
        .all()
    )
    if not deliveries:
        return result

    records: list[NotificationRecord] = []
    devices: list[PushDevice] = []
    claimed: list[NotificationDelivery] = []
    for delivery in deliveries:
        updated = (
            db.query(NotificationDelivery)
            .filter(
                NotificationDelivery.id == delivery.id,
                NotificationDelivery.status.in_(["queued", "retry"]),
            )
            .update(
                {
                    NotificationDelivery.status: "sending",
                    NotificationDelivery.attempts: NotificationDelivery.attempts + 1,
                    NotificationDelivery.updated_at: now,
                },
                synchronize_session=False,
            )
        )
        if not updated:
            continue
        db.refresh(delivery)
        record = db.query(NotificationRecord).filter(NotificationRecord.id == delivery.notification_record_id).one()
        device = db.query(PushDevice).filter(PushDevice.id == delivery.push_device_id).one()
        if not device.enabled or not device.push_token:
            _disable_device(db, device, "push device is disabled")
            result["disabled"] += 1
            continue
        claimed.append(delivery)
        records.append(record)
        devices.append(device)
    db.commit()
    if not claimed:
        return result

    try:
        payload = _post_json(
            settings,
            settings.expo_push_send_url,
            [_message(record, device) for record, device in zip(records, devices)],
            http_client,
        )
        tickets = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(tickets, list) or len(tickets) != len(claimed):
            raise ValueError("Expo returned an invalid ticket batch")
    except Exception as exc:
        for delivery in claimed:
            outcome = _retry_or_fail(delivery, settings, exc)
            result[outcome] += 1
        db.commit()
        return result

    for delivery, device, ticket in zip(claimed, devices, tickets):
        if not isinstance(ticket, dict):
            outcome = _retry_or_fail(delivery, settings, "invalid Expo ticket")
            result[outcome] += 1
            continue
        if ticket.get("status") == "ok" and isinstance(ticket.get("id"), str):
            delivery.status = "ticketed"
            delivery.provider_ticket_id = ticket["id"]
            delivery.ticketed_at = utcnow()
            delivery.next_attempt_at = None
            delivery.last_error = ""
            delivery.updated_at = utcnow()
            result["ticketed"] += 1
            continue
        details = ticket.get("details") if isinstance(ticket.get("details"), dict) else {}
        reason = details.get("error") or ticket.get("message") or "Expo rejected the notification"
        if details.get("error") == "DeviceNotRegistered":
            _disable_device(db, device, reason)
            result["disabled"] += 1
        else:
            outcome = _retry_or_fail(delivery, settings, reason)
            result[outcome] += 1
    db.commit()
    return result


def refresh_push_receipts(
    db: Session,
    settings: Settings,
    *,
    http_client: PushHttpClient | None = None,
) -> dict[str, int]:
    result = {"delivered": 0, "pending": 0, "failed": 0, "disabled": 0}
    if not settings.expo_push_enabled:
        return result

    cutoff = utcnow() - timedelta(seconds=settings.expo_push_receipt_delay_seconds)
    deliveries = (
        db.query(NotificationDelivery)
        .join(PushDevice, PushDevice.id == NotificationDelivery.push_device_id)
        .filter(
            NotificationDelivery.status == "ticketed",
            NotificationDelivery.provider_ticket_id.is_not(None),
            NotificationDelivery.ticketed_at <= cutoff,
        )
        .order_by(NotificationDelivery.ticketed_at.asc(), NotificationDelivery.delivery_id.asc())
        .limit(settings.expo_push_batch_size)
        .all()
    )
    if not deliveries:
        return result

    ticket_ids = [str(delivery.provider_ticket_id) for delivery in deliveries]
    try:
        payload = _post_json(
            settings,
            settings.expo_push_receipt_url,
            {"ids": ticket_ids},
            http_client,
        )
        receipts = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(receipts, dict):
            raise ValueError("Expo returned an invalid receipt batch")
    except Exception:
        result["pending"] = len(deliveries)
        return result

    for delivery in deliveries:
        ticket_id = str(delivery.provider_ticket_id)
        receipt = receipts.get(ticket_id)
        if not isinstance(receipt, dict):
            result["pending"] += 1
            continue
        if receipt.get("status") == "ok":
            delivery.status = "delivered"
            delivery.provider_receipt_id = ticket_id
            delivery.delivered_at = utcnow()
            delivery.updated_at = utcnow()
            delivery.last_error = ""
            result["delivered"] += 1
            continue
        details = receipt.get("details") if isinstance(receipt.get("details"), dict) else {}
        reason = details.get("error") or receipt.get("message") or "Expo receipt reported an error"
        device = db.query(PushDevice).filter(PushDevice.id == delivery.push_device_id).one()
        if details.get("error") == "DeviceNotRegistered":
            _disable_device(db, device, reason)
            result["disabled"] += 1
        else:
            delivery.status = "failed"
            delivery.last_error = _error_text(reason)
            delivery.updated_at = utcnow()
            result["failed"] += 1
    db.commit()
    return result


class PushDispatchWorker:
    def __init__(self, session_factory, settings: Settings):
        self._session_factory = session_factory
        self._settings = settings
        self._stop_event = ThreadEvent()
        self._thread: Thread | None = None

    @property
    def is_alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def run_once(self) -> None:
        with self._session_factory() as db:
            dispatch_pending_pushes(db, self._settings)
            refresh_push_receipts(db, self._settings)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("Background push dispatch pass failed")
            self._stop_event.wait(self._settings.expo_push_dispatch_interval_seconds)

    def start(self) -> None:
        if self.is_alive:
            return
        self._stop_event.clear()
        self._thread = Thread(target=self._run, name="agenthub-push-dispatcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(2.0, self._settings.expo_push_timeout_seconds + 1.0))
