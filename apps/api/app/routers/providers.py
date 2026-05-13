from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.core.json import dumps_json, loads_json
from app.models import Job, ProviderSnapshot, Worker, utcnow
from app.routers.internal import _assert_worker_binding
from app.schemas import ProviderSnapshotsIn
from app.services import provider_snapshot_out, job_out

router = APIRouter()
AUTH_STATUSES = {"ready", "auth_required", "handoff_required", "unknown"}


@router.get("/api/providers")
def list_provider_snapshots(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
):
    rows = (
        db.query(ProviderSnapshot)
        .filter(ProviderSnapshot.space_id == actor.space_id)
        .order_by(ProviderSnapshot.worker_id.asc(), ProviderSnapshot.backend.asc())
        .all()
    )
    return {"items": [provider_snapshot_out(row) for row in rows]}


def _require_provider_worker_backend(db: DbSession, space_id: str | None, worker_id: str, backend: str) -> Worker:
    worker = db.query(Worker).filter(Worker.space_id == space_id, Worker.worker_id == worker_id).one_or_none()
    if worker is None:
        raise HTTPException(status_code=409, detail={"message": "Worker is not registered", "code": "WORKER_UNAVAILABLE"})
    if worker.status == "offline":
        raise HTTPException(status_code=409, detail={"message": "Worker is offline", "code": "WORKER_OFFLINE"})
    reachable = {
        str(item).strip().lower()
        for item in loads_json(worker.reachable_backends_json, [])
        if str(item).strip()
    }
    if backend.strip().lower() not in reachable:
        raise HTTPException(
            status_code=409,
            detail={"message": f"Worker {worker_id} cannot run {backend}", "code": "WORKER_BACKEND_UNAVAILABLE"},
        )
    return worker


def _create_provider_job(action: str, worker_id: str, backend: str, db: DbSession, actor: Actor) -> dict[str, object]:
    backend_name = backend.strip().lower()
    _require_provider_worker_backend(db, actor.space_id, worker_id, backend_name)
    job = Job(
        space_id=actor.space_id,
        kind=f"provider_{action}",
        worker_id=worker_id,
        backend=backend_name,
        namespace="default",
        payload_json=dumps_json({"backend": backend_name, "action": action}),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type=f"provider.{action}",
        payload={"worker_id": worker_id, "backend": backend_name},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/providers/{worker_id}/{backend}/login")
def login_provider(
    worker_id: str,
    backend: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    return _create_provider_job("login", worker_id, backend, db, actor)


@router.post("/api/providers/{worker_id}/{backend}/logout")
def logout_provider(
    worker_id: str,
    backend: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    return _create_provider_job("logout", worker_id, backend, db, actor)


@router.post("/api/internal/providers/snapshot")
def publish_provider_snapshots(
    payload: ProviderSnapshotsIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    now = utcnow()
    saved: list[ProviderSnapshot] = []
    for item in payload.providers:
        snapshot = (
            db.query(ProviderSnapshot)
            .filter(
                ProviderSnapshot.space_id == worker.space_id,
                ProviderSnapshot.worker_id == worker.worker_id,
                ProviderSnapshot.backend == item.backend,
            )
            .one_or_none()
        )
        if snapshot is None:
            snapshot = ProviderSnapshot(space_id=worker.space_id, worker_id=worker.worker_id, backend=item.backend)
            db.add(snapshot)
        snapshot.status = item.status
        snapshot.models_json = dumps_json(item.models)
        snapshot.modes_json = dumps_json(item.modes)
        snapshot.features_json = dumps_json(item.features)
        diagnostics = dict(item.diagnostics)
        diagnostics_auth_status = diagnostics.get("auth_status")
        diagnostics["auth_status"] = (
            diagnostics_auth_status
            if item.auth_status == "unknown" and diagnostics_auth_status in AUTH_STATUSES
            else item.auth_status
        )
        snapshot.diagnostics_json = dumps_json(diagnostics)
        snapshot.fetched_at = item.fetched_at or now
        snapshot.updated_at = now
        saved.append(snapshot)
    db.commit()
    return {"items": [provider_snapshot_out(item) for item in saved]}
