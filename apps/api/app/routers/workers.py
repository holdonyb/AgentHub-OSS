from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.core.job_recovery import recover_stale_running_jobs_for_space
from app.core.json import dumps_json
from app.core.security import generate_token, hash_token
from app.core.settings_store import default_worker_runtime_defaults, get_worker_runtime_defaults
from app.core.spaces import ensure_default_space
from app.models import Worker, WorkerEnrollment, utcnow
from app.routers.internal import _recover_orphaned_running_jobs, _recover_stale_running_jobs
from app.schemas import WorkerEnrollmentCreateIn, WorkerHeartbeatIn, WorkerRegisterIn, WorkerRuntimeSettingsPatchIn
from app.services import worker_out

router = APIRouter()


def _refresh_worker_runtime_from_space_defaults(worker: Worker, runtime_defaults: dict[str, float | int]) -> bool:
    baseline = default_worker_runtime_defaults()
    updated = False
    baseline_max = int(baseline["max_concurrent_jobs"])
    baseline_job_poll = int(baseline["job_poll_interval_seconds"])
    baseline_heartbeat = int(baseline["heartbeat_interval_seconds"])
    desired_max = int(runtime_defaults["max_concurrent_jobs"])
    desired_job_poll = int(runtime_defaults["job_poll_interval_seconds"])
    desired_heartbeat = int(runtime_defaults["heartbeat_interval_seconds"])
    if worker.max_concurrent_jobs == baseline_max and desired_max != baseline_max:
        worker.max_concurrent_jobs = desired_max
        updated = True
    if worker.job_poll_interval_seconds == baseline_job_poll and desired_job_poll != baseline_job_poll:
        worker.job_poll_interval_seconds = desired_job_poll
        updated = True
    if worker.heartbeat_interval_seconds == baseline_heartbeat and desired_heartbeat != baseline_heartbeat:
        worker.heartbeat_interval_seconds = desired_heartbeat
        updated = True
    if updated:
        worker.updated_at = utcnow()
    return updated


def _bearer(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return ""
    return authorization.split(" ", 1)[1].strip()


def _upsert_worker(
    db: DbSession,
    *,
    space_id: str,
    payload: WorkerRegisterIn,
    worker_token: str | None,
) -> tuple[Worker, str | None]:
    existing = (
        db.query(Worker)
        .filter(Worker.space_id == space_id, Worker.worker_id == payload.worker_id)
        .one_or_none()
    )
    issued_token: str | None = None
    runtime_defaults = get_worker_runtime_defaults(db, space_id=space_id)
    if existing:
        existing.machine_name = payload.machine_name
        existing.os = payload.os
        existing.connection_mode = payload.connection_mode
        existing.transport_state = payload.transport_state
        existing.worker_version = payload.worker_version
        existing.reachable_backends_json = dumps_json(payload.reachable_backends)
        existing.workspace_roots_json = dumps_json(payload.workspace_roots)
        existing.capabilities_json = dumps_json(payload.capabilities)
        existing.status = "online"
        existing.last_heartbeat_at = utcnow()
        existing.updated_at = utcnow()
        _refresh_worker_runtime_from_space_defaults(existing, runtime_defaults)
        if worker_token:
            existing.token_hash = hash_token(worker_token)
        return existing, None
    issued_token = worker_token or generate_token("ahw")
    worker = Worker(
        space_id=space_id,
        worker_id=payload.worker_id,
        machine_name=payload.machine_name,
        os=payload.os,
        token_hash=hash_token(issued_token),
        connection_mode=payload.connection_mode,
        transport_state=payload.transport_state,
        worker_version=payload.worker_version,
        reachable_backends_json=dumps_json(payload.reachable_backends),
        workspace_roots_json=dumps_json(payload.workspace_roots),
        capabilities_json=dumps_json(payload.capabilities),
        max_concurrent_jobs=int(runtime_defaults["max_concurrent_jobs"]),
        job_poll_interval_seconds=int(runtime_defaults["job_poll_interval_seconds"]),
        heartbeat_interval_seconds=int(runtime_defaults["heartbeat_interval_seconds"]),
        status="online",
        last_heartbeat_at=utcnow(),
    )
    db.add(worker)
    return worker, issued_token if worker_token is None else None


@router.post("/api/workers/register")
def register_worker(payload: WorkerRegisterIn, request: Request, db: DbSession):
    registration_token = request.app.state.settings.worker_registration_token
    bearer = _bearer(request)
    if registration_token is None or hash_token(bearer) != hash_token(registration_token):
        raise HTTPException(status_code=403, detail={"message": "Invalid worker registration token", "code": "WORKER_REGISTER_FORBIDDEN"})

    space = ensure_default_space(db)
    worker, issued_token = _upsert_worker(db, space_id=space.space_id, payload=payload, worker_token=payload.worker_token)
    write_event(
        db,
        space_id=space.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="worker",
        source_id=worker.worker_id,
        event_type="worker.register",
        payload={"idempotent": worker.id is not None, "connection_mode": worker.connection_mode, "os": worker.os},
    )
    db.commit()
    return {
        "worker": worker_out(worker),
        "worker_token": issued_token,
        "runtime_settings": get_worker_runtime_defaults(db, space_id=space.space_id),
    }


@router.post("/api/workers/{worker_id}/heartbeat")
def heartbeat_worker(
    worker_id: str,
    payload: WorkerHeartbeatIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    assert actor.worker is not None
    if actor.worker.worker_id != worker_id:
        raise HTTPException(status_code=403, detail={"message": "Worker token is bound to another worker", "code": "WORKER_ID_MISMATCH"})
    worker = actor.worker
    worker.status = payload.status
    worker.last_heartbeat_at = utcnow()
    worker.updated_at = utcnow()
    if payload.transport_state is not None:
        worker.transport_state = payload.transport_state
    if payload.worker_version is not None:
        worker.worker_version = payload.worker_version
    if payload.reachable_backends is not None:
        worker.reachable_backends_json = dumps_json(payload.reachable_backends)
    if payload.workspace_roots is not None:
        worker.workspace_roots_json = dumps_json(payload.workspace_roots)
    if payload.capabilities is not None:
        worker.capabilities_json = dumps_json(payload.capabilities)
    runtime_defaults = get_worker_runtime_defaults(
        db,
        space_id=worker.space_id or actor.space_id or ensure_default_space(db).space_id,
    )
    _refresh_worker_runtime_from_space_defaults(worker, runtime_defaults)
    if payload.active_job_ids is not None:
        _recover_orphaned_running_jobs(db, worker.worker_id, worker.space_id, payload.active_job_ids)
    _recover_stale_running_jobs(db, worker.worker_id, worker.space_id)
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="worker",
        source_id=worker.worker_id,
        event_type="worker.heartbeat",
        payload={"status": worker.status, "transport_state": worker.transport_state},
    )
    db.commit()
    return {"worker": worker_out(worker), "runtime_settings": runtime_defaults}


@router.get("/api/workers")
def list_workers(db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    if recover_stale_running_jobs_for_space(db, actor.space_id):
        db.commit()
    workers = (
        db.query(Worker)
        .filter(Worker.space_id == actor.space_id)
        .order_by(Worker.worker_id.asc())
        .all()
    )
    return {"items": [worker_out(worker) for worker in workers]}


@router.patch("/api/workers/{worker_id}/runtime-settings")
def patch_worker_runtime_settings(
    worker_id: str,
    payload: WorkerRuntimeSettingsPatchIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    worker = (
        db.query(Worker)
        .filter(Worker.space_id == actor.space_id, Worker.worker_id == worker_id)
        .one_or_none()
    )
    if worker is None:
        raise HTTPException(status_code=404, detail={"message": "Worker not found", "code": "WORKER_NOT_FOUND"})
    updates = payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail={"message": "No runtime settings supplied", "code": "WORKER_RUNTIME_SETTINGS_EMPTY"})
    for key, value in updates.items():
        setattr(worker, key, int(value))
    worker.updated_at = utcnow()
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="worker",
        source_id=worker.worker_id,
        event_type="worker.runtime_settings_update",
        payload=updates,
    )
    db.commit()
    return {"worker": worker_out(worker)}


@router.get("/api/worker-enrollments")
def list_worker_enrollments(db: DbSession, actor: Actor = Depends(require_min_role("admin"))):
    rows = (
        db.query(WorkerEnrollment)
        .filter(WorkerEnrollment.space_id == actor.space_id)
        .order_by(WorkerEnrollment.created_at.desc())
        .all()
    )
    return {
        "items": [
            {
                "enrollment_id": row.enrollment_id,
                "space_id": row.space_id,
                "label": row.label,
                "created_at": row.created_at,
                "expires_at": row.expires_at,
                "used_at": row.used_at,
                "revoked_at": row.revoked_at,
            }
            for row in rows
        ]
    }


@router.post("/api/worker-enrollments")
def create_worker_enrollment(
    payload: WorkerEnrollmentCreateIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    token = generate_token("ahe")
    row = WorkerEnrollment(
        space_id=actor.space_id or ensure_default_space(db).space_id,
        label=payload.label.strip(),
        token_hash=hash_token(token),
        created_by=actor.actor_id,
        expires_at=utcnow() + timedelta(hours=payload.expires_in_hours),
    )
    db.add(row)
    db.flush()
    write_event(
        db,
        space_id=row.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="worker_enrollment",
        source_id=row.enrollment_id,
        event_type="worker.enrollment_create",
        payload={"label": row.label},
    )
    db.commit()
    return {
        "enrollment_id": row.enrollment_id,
        "space_id": row.space_id,
        "label": row.label,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "enrollment_token": token,
    }
