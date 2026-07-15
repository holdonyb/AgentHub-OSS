from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import Actor, DbSession, require_space_user
from app.models import PushDevice, utcnow
from app.schemas import PushDeviceListOut, PushDeviceUpsertIn, PushDeviceUpsertOut


router = APIRouter(tags=["push-devices"])


def _device_out(device: PushDevice) -> dict[str, object]:
    return {
        "device_id": device.device_id,
        "platform": device.platform,
        "transport": device.transport,
        "app_version": device.app_version,
        "enabled": device.enabled,
        "created_at": device.created_at,
        "updated_at": device.updated_at,
        "last_seen_at": device.last_seen_at,
    }


@router.get("/api/push/devices", response_model=PushDeviceListOut)
def list_push_devices(db: DbSession, actor: Actor = Depends(require_space_user)):
    assert actor.user is not None
    rows = (
        db.query(PushDevice)
        .filter(
            PushDevice.space_id == actor.space_id,
            PushDevice.user_id == actor.user.id,
            PushDevice.enabled.is_(True),
        )
        .order_by(PushDevice.updated_at.desc(), PushDevice.device_id.asc())
        .all()
    )
    return {"items": [_device_out(row) for row in rows]}


@router.post("/api/push/devices", response_model=PushDeviceUpsertOut)
def upsert_push_device(
    payload: PushDeviceUpsertIn,
    db: DbSession,
    actor: Actor = Depends(require_space_user),
):
    assert actor.user is not None
    device = db.query(PushDevice).filter(PushDevice.device_id == payload.device_id).one_or_none()
    if device is not None and (device.space_id != actor.space_id or device.user_id != actor.user.id):
        raise HTTPException(
            status_code=409,
            detail={"message": "Device is already registered", "code": "PUSH_DEVICE_CONFLICT"},
        )

    now = utcnow()
    if device is None:
        device = PushDevice(
            device_id=payload.device_id,
            space_id=actor.space_id,
            user_id=actor.user.id,
            platform=payload.platform,
            transport=payload.transport,
            push_token=payload.push_token,
            app_version=payload.app_version,
            created_at=now,
            updated_at=now,
            last_seen_at=now,
        )
        db.add(device)
    else:
        device.platform = payload.platform
        device.transport = payload.transport
        device.push_token = payload.push_token
        device.app_version = payload.app_version
        device.enabled = True
        device.revoked_at = None
        device.updated_at = now
        device.last_seen_at = now
    db.commit()
    db.refresh(device)
    return {"device": _device_out(device)}


@router.delete("/api/push/devices/{device_id}")
def revoke_push_device(
    device_id: str,
    db: DbSession,
    actor: Actor = Depends(require_space_user),
):
    assert actor.user is not None
    device = (
        db.query(PushDevice)
        .filter(
            PushDevice.device_id == device_id,
            PushDevice.space_id == actor.space_id,
            PushDevice.user_id == actor.user.id,
        )
        .one_or_none()
    )
    if device is None:
        return {"revoked": False}
    now = utcnow()
    device.enabled = False
    device.push_token = ""
    device.revoked_at = now
    device.updated_at = now
    db.commit()
    return {"revoked": True}

