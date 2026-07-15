from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import NotificationDelivery, PushDevice, utcnow


ACTIVE_DELIVERY_STATUSES = ("queued", "retry", "sending", "ticketed", "checking_receipt")


def disable_push_device(db: Session, device: PushDevice, reason: object) -> None:
    now = utcnow()
    error_text = " ".join(str(reason).split())[:500]
    device.enabled = False
    device.push_token = ""
    device.revoked_at = now
    device.updated_at = now
    db.query(NotificationDelivery).filter(
        NotificationDelivery.push_device_id == device.id,
        NotificationDelivery.status.in_(ACTIVE_DELIVERY_STATUSES),
    ).update(
        {
            NotificationDelivery.status: "disabled",
            NotificationDelivery.last_error: error_text,
            NotificationDelivery.next_attempt_at: None,
            NotificationDelivery.receipt_next_attempt_at: None,
            NotificationDelivery.updated_at: now,
        },
        synchronize_session=False,
    )
