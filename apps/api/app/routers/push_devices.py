from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError

from app.core.deps import Actor, DbSession, require_space_user
from app.core.push_devices import disable_push_device
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


def _device_conflict() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"message": "Device is already registered", "code": "PUSH_DEVICE_CONFLICT"},
    )


def _apply_registration(
    db: DbSession,
    device: PushDevice,
    payload: PushDeviceUpsertIn,
    *,
    space_id: str,
    user_id: str,
) -> None:
    owned_by_actor = device.space_id == space_id and device.user_id == user_id
    if not owned_by_actor and device.enabled:
        raise _device_conflict()
    if not owned_by_actor:
        disable_push_device(db, device, "Push device reassigned after revocation")
        device.space_id = space_id
        device.user_id = user_id
    now = utcnow()
    device.platform = payload.platform
    device.transport = payload.transport
    device.push_token = payload.push_token
    device.app_version = payload.app_version
    device.enabled = True
    device.revoked_at = None
    device.updated_at = now
    device.last_seen_at = now


def _disable_previous_token_owners(
    db: DbSession,
    *,
    device_id: str,
    push_token: str,
) -> None:
    previous_devices = (
        db.query(PushDevice)
        .filter(
            PushDevice.device_id != device_id,
            PushDevice.push_token == push_token,
            PushDevice.enabled.is_(True),
        )
        .all()
    )
    for previous_device in previous_devices:
        disable_push_device(db, previous_device, "Push token moved to another signed-in account")


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
    actor_space_id = str(actor.space_id)
    actor_user_id = actor.user.id

    now = utcnow()
    created = device is None
    if device is None:
        device = PushDevice(
            device_id=payload.device_id,
            space_id=actor_space_id,
            user_id=actor_user_id,
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
        _apply_registration(
            db,
            device,
            payload,
            space_id=actor_space_id,
            user_id=actor_user_id,
        )
    _disable_previous_token_owners(
        db,
        device_id=payload.device_id,
        push_token=payload.push_token,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if not created:
            raise
        device = db.query(PushDevice).filter(PushDevice.device_id == payload.device_id).one_or_none()
        if device is None:
            raise exc
        _apply_registration(
            db,
            device,
            payload,
            space_id=actor_space_id,
            user_id=actor_user_id,
        )
        _disable_previous_token_owners(
            db,
            device_id=payload.device_id,
            push_token=payload.push_token,
        )
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
    disable_push_device(db, device, "Push device revoked by user")
    db.commit()
    return {"revoked": True}
