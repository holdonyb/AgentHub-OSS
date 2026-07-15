from __future__ import annotations

from datetime import timedelta
import logging
from threading import Event as ThreadEvent, Thread
from typing import Any, Protocol

import httpx
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.push_devices import disable_push_device
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


def _receipt_retry_or_fail(delivery: NotificationDelivery, settings: Settings, error: object) -> str:
    now = utcnow()
    delivery.last_error = _error_text(error)
    delivery.updated_at = now
    if delivery.receipt_attempts >= settings.expo_push_max_attempts:
        delivery.status = "failed"
        delivery.receipt_next_attempt_at = None
        return "failed"
    delay = settings.expo_push_backoff_seconds * (2 ** max(0, delivery.receipt_attempts - 1))
    delivery.status = "ticketed"
    delivery.receipt_next_attempt_at = now + timedelta(seconds=delay)
    return "pending"


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
    stale_cutoff = now - timedelta(days=settings.expo_push_device_ttl_days)
    stale_devices = (
        db.query(PushDevice)
        .filter(
            PushDevice.enabled.is_(True),
            PushDevice.last_seen_at < stale_cutoff,
        )
        .all()
    )
    for device in stale_devices:
        disable_push_device(db, device, "Push device registration expired")
        result["disabled"] += 1
    if stale_devices:
        db.commit()

    exhausted_sends = (
        db.query(NotificationDelivery)
        .filter(
            NotificationDelivery.status == "sending",
            NotificationDelivery.next_attempt_at <= now,
            NotificationDelivery.attempts >= settings.expo_push_max_attempts,
        )
        .all()
    )
    for delivery in exhausted_sends:
        delivery.status = "failed"
        delivery.next_attempt_at = None
        delivery.last_error = "Push send claim expired after maximum attempts"
        delivery.updated_at = now
        result["failed"] += 1
    if exhausted_sends:
        db.commit()

    send_due = or_(
        (
            NotificationDelivery.status.in_(["queued", "retry"])
            & or_(
                NotificationDelivery.next_attempt_at.is_(None),
                NotificationDelivery.next_attempt_at <= now,
            )
        ),
        (
            (NotificationDelivery.status == "sending")
            & (NotificationDelivery.next_attempt_at <= now)
        ),
    )
    delivery_ids = [
        row[0]
        for row in (
        db.query(NotificationDelivery)
        .join(PushDevice, PushDevice.id == NotificationDelivery.push_device_id)
        .filter(
            PushDevice.enabled.is_(True),
            send_due,
            NotificationDelivery.attempts < settings.expo_push_max_attempts,
        )
        .order_by(NotificationDelivery.created_at.asc(), NotificationDelivery.delivery_id.asc())
        .with_entities(NotificationDelivery.id)
        .limit(settings.expo_push_batch_size)
        .all()
        )
    ]
    if not delivery_ids:
        return result

    claimed_ids: list[str] = []
    lease_until = now + timedelta(seconds=settings.expo_push_claim_lease_seconds)
    for delivery_id in delivery_ids:
        updated = (
            db.query(NotificationDelivery)
            .filter(
                NotificationDelivery.id == delivery_id,
                send_due,
                NotificationDelivery.attempts < settings.expo_push_max_attempts,
            )
            .update(
                {
                    NotificationDelivery.status: "sending",
                    NotificationDelivery.attempts: NotificationDelivery.attempts + 1,
                    NotificationDelivery.next_attempt_at: lease_until,
                    NotificationDelivery.updated_at: now,
                },
                synchronize_session=False,
            )
        )
        if updated:
            claimed_ids.append(delivery_id)
    db.commit()
    if not claimed_ids:
        return result
    db.expire_all()

    records: list[NotificationRecord] = []
    devices: list[PushDevice] = []
    claimed: list[NotificationDelivery] = []
    for delivery_id in claimed_ids:
        delivery = db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).one()
        if delivery.status != "sending":
            continue
        record = db.query(NotificationRecord).filter(NotificationRecord.id == delivery.notification_record_id).one()
        device = db.query(PushDevice).filter(PushDevice.id == delivery.push_device_id).one()
        if not device.enabled or not device.push_token:
            disable_push_device(db, device, "push device is disabled")
            result["disabled"] += 1
            continue
        claimed.append(delivery)
        records.append(record)
        devices.append(device)
    db.commit()
    if not claimed:
        return result

    claimed_delivery_ids = [delivery.id for delivery in claimed]
    claimed_device_ids = [device.id for device in devices]

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
        db.rollback()
        db.expire_all()
        for delivery_id, device_id in zip(claimed_delivery_ids, claimed_device_ids):
            delivery = db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).one()
            device = db.query(PushDevice).filter(PushDevice.id == device_id).one()
            if delivery.status != "sending" or not device.enabled:
                continue
            outcome = _retry_or_fail(delivery, settings, exc)
            result[outcome] += 1
        db.commit()
        return result

    db.rollback()
    db.expire_all()
    for delivery_id, device_id, ticket in zip(claimed_delivery_ids, claimed_device_ids, tickets):
        delivery = db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).one()
        device = db.query(PushDevice).filter(PushDevice.id == device_id).one()
        if delivery.status != "sending" or not device.enabled:
            continue
        if not isinstance(ticket, dict):
            outcome = _retry_or_fail(delivery, settings, "invalid Expo ticket")
            result[outcome] += 1
            continue
        if ticket.get("status") == "ok" and isinstance(ticket.get("id"), str):
            delivery.status = "ticketed"
            delivery.provider_ticket_id = ticket["id"]
            delivery.ticketed_at = utcnow()
            delivery.next_attempt_at = None
            delivery.receipt_attempts = 0
            delivery.receipt_next_attempt_at = delivery.ticketed_at + timedelta(
                seconds=settings.expo_push_receipt_delay_seconds
            )
            delivery.last_error = ""
            delivery.updated_at = utcnow()
            result["ticketed"] += 1
            continue
        details = ticket.get("details") if isinstance(ticket.get("details"), dict) else {}
        reason = details.get("error") or ticket.get("message") or "Expo rejected the notification"
        if details.get("error") == "DeviceNotRegistered":
            disable_push_device(db, device, reason)
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

    now = utcnow()
    exhausted_receipts = (
        db.query(NotificationDelivery)
        .filter(
            NotificationDelivery.status == "checking_receipt",
            NotificationDelivery.receipt_next_attempt_at <= now,
            NotificationDelivery.receipt_attempts >= settings.expo_push_max_attempts,
        )
        .all()
    )
    for delivery in exhausted_receipts:
        delivery.status = "failed"
        delivery.receipt_next_attempt_at = None
        delivery.last_error = "Push receipt claim expired after maximum attempts"
        delivery.updated_at = now
        result["failed"] += 1
    if exhausted_receipts:
        db.commit()

    cutoff = now - timedelta(seconds=settings.expo_push_receipt_delay_seconds)
    receipt_due = or_(
        (
            (NotificationDelivery.status == "ticketed")
            & or_(
                NotificationDelivery.receipt_next_attempt_at <= now,
                (
                    NotificationDelivery.receipt_next_attempt_at.is_(None)
                    & (NotificationDelivery.ticketed_at <= cutoff)
                ),
            )
        ),
        (
            (NotificationDelivery.status == "checking_receipt")
            & (NotificationDelivery.receipt_next_attempt_at <= now)
        ),
    )
    delivery_ids = [
        row[0]
        for row in (
        db.query(NotificationDelivery)
        .join(PushDevice, PushDevice.id == NotificationDelivery.push_device_id)
        .filter(
            PushDevice.enabled.is_(True),
            receipt_due,
            NotificationDelivery.provider_ticket_id.is_not(None),
            NotificationDelivery.receipt_attempts < settings.expo_push_max_attempts,
        )
        .order_by(NotificationDelivery.ticketed_at.asc(), NotificationDelivery.delivery_id.asc())
        .with_entities(NotificationDelivery.id)
        .limit(settings.expo_push_batch_size)
        .all()
        )
    ]
    if not delivery_ids:
        return result

    claimed_ids: list[str] = []
    lease_until = now + timedelta(seconds=settings.expo_push_claim_lease_seconds)
    for delivery_id in delivery_ids:
        updated = (
            db.query(NotificationDelivery)
            .filter(
                NotificationDelivery.id == delivery_id,
                receipt_due,
                NotificationDelivery.receipt_attempts < settings.expo_push_max_attempts,
            )
            .update(
                {
                    NotificationDelivery.status: "checking_receipt",
                    NotificationDelivery.receipt_attempts: NotificationDelivery.receipt_attempts + 1,
                    NotificationDelivery.receipt_next_attempt_at: lease_until,
                    NotificationDelivery.updated_at: now,
                },
                synchronize_session=False,
            )
        )
        if updated:
            claimed_ids.append(delivery_id)
    db.commit()

    db.expire_all()
    deliveries: list[NotificationDelivery] = []
    for delivery_id in claimed_ids:
        delivery = db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).one()
        device = db.query(PushDevice).filter(PushDevice.id == delivery.push_device_id).one()
        if delivery.status == "checking_receipt" and device.enabled and device.push_token:
            deliveries.append(delivery)
    if not deliveries:
        return result

    delivery_ids = [delivery.id for delivery in deliveries]
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
    except Exception as exc:
        db.rollback()
        db.expire_all()
        for delivery_id in delivery_ids:
            delivery = db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).one()
            device = db.query(PushDevice).filter(PushDevice.id == delivery.push_device_id).one()
            if delivery.status != "checking_receipt" or not device.enabled:
                continue
            outcome = _receipt_retry_or_fail(delivery, settings, exc)
            result[outcome] += 1
        db.commit()
        return result

    db.rollback()
    db.expire_all()
    for delivery_id in delivery_ids:
        delivery = db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).one()
        device = db.query(PushDevice).filter(PushDevice.id == delivery.push_device_id).one()
        if delivery.status != "checking_receipt" or not device.enabled:
            continue
        ticket_id = str(delivery.provider_ticket_id)
        receipt = receipts.get(ticket_id)
        if not isinstance(receipt, dict):
            outcome = _receipt_retry_or_fail(delivery, settings, "Expo receipt is not available yet")
            result[outcome] += 1
            continue
        if receipt.get("status") == "ok":
            delivery.status = "delivered"
            delivery.provider_receipt_id = ticket_id
            delivery.delivered_at = utcnow()
            delivery.receipt_next_attempt_at = None
            delivery.updated_at = utcnow()
            delivery.last_error = ""
            result["delivered"] += 1
            continue
        details = receipt.get("details") if isinstance(receipt.get("details"), dict) else {}
        reason = details.get("error") or receipt.get("message") or "Expo receipt reported an error"
        if details.get("error") == "DeviceNotRegistered":
            disable_push_device(db, device, reason)
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
