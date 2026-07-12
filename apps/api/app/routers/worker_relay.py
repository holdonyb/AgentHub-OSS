from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_worker
from app.core.security import hash_token
from app.core.settings_store import get_worker_runtime_defaults
from app.core.spaces import ensure_default_space
from app.models import Worker, WorkerEnrollment, utcnow
from app.routers.internal import _assert_worker_binding, _recover_orphaned_running_jobs, _recover_stale_running_jobs, claim_job as claim_job_internal, complete_job as complete_job_internal, discovered_sessions as discovered_sessions_internal, fail_job as fail_job_internal
from app.routers.permissions import get_permission_for_worker, request_permission, resolve_permission_from_worker
from app.routers.providers import publish_provider_snapshots
from app.routers.secrets import resolve_worker_secrets
from app.routers.timeline import publish_session_timeline
from app.routers.workers import _upsert_worker
from app.schemas import ClaimJobIn, CompleteJobIn, DiscoveredSessionsIn, FailJobIn, PermissionRequestedIn, PermissionResolvedIn, ProviderSnapshotsIn, SecretResolveIn, TimelinePublishIn, WorkerEnrollIn, WorkerHeartbeatIn
from app.services import worker_out

router = APIRouter()


@router.post("/api/worker/enroll")
def enroll_worker(payload: WorkerEnrollIn, db: DbSession):
    now = utcnow()
    enrollment_hash = hash_token(payload.enrollment_token)
    enrollment = db.query(WorkerEnrollment).filter(WorkerEnrollment.token_hash == enrollment_hash).one_or_none()
    if (
        enrollment is None
        or enrollment.used_at is not None
        or enrollment.revoked_at is not None
        or enrollment.expires_at <= now
    ):
        raise HTTPException(status_code=403, detail={"message": "Enrollment token is invalid or expired", "code": "WORKER_ENROLLMENT_INVALID"})
    existing_worker = (
        db.query(Worker)
        .filter(Worker.space_id == enrollment.space_id, Worker.worker_id == payload.worker_id)
        .one_or_none()
    )
    if (
        existing_worker is not None
        and (
            not payload.worker_token
            or existing_worker.token_hash != hash_token(payload.worker_token)
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"message": "Worker is already enrolled", "code": "WORKER_ALREADY_ENROLLED"},
        )

    consumed = (
        db.query(WorkerEnrollment)
        .filter(
            WorkerEnrollment.id == enrollment.id,
            WorkerEnrollment.used_at.is_(None),
            WorkerEnrollment.revoked_at.is_(None),
            WorkerEnrollment.expires_at > now,
        )
        .update({WorkerEnrollment.used_at: now}, synchronize_session=False)
    )
    if consumed != 1:
        db.rollback()
        raise HTTPException(status_code=403, detail={"message": "Enrollment token is invalid or expired", "code": "WORKER_ENROLLMENT_INVALID"})

    worker, issued_token = _upsert_worker(
        db,
        space_id=enrollment.space_id,
        payload=payload,
        worker_token=payload.worker_token if existing_worker is None else None,
    )
    write_event(
        db,
        space_id=enrollment.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="worker",
        source_id=worker.worker_id,
        event_type="worker.enroll",
        payload={"connection_mode": worker.connection_mode, "label": enrollment.label},
    )
    db.commit()
    return {
        "worker": worker_out(worker),
        "worker_token": issued_token,
        "runtime_settings": get_worker_runtime_defaults(db, space_id=enrollment.space_id),
    }


@router.post("/api/worker/heartbeat")
def heartbeat_public(payload: WorkerHeartbeatIn, db: DbSession, actor: Actor = Depends(require_worker)):
    worker = actor.worker
    assert worker is not None
    worker.status = payload.status
    worker.last_heartbeat_at = utcnow()
    worker.updated_at = utcnow()
    if payload.transport_state is not None:
        worker.transport_state = payload.transport_state
    if payload.worker_version is not None:
        worker.worker_version = payload.worker_version
    if payload.reachable_backends is not None:
        from app.core.json import dumps_json

        worker.reachable_backends_json = dumps_json(payload.reachable_backends)
    if payload.workspace_roots is not None:
        from app.core.json import dumps_json

        worker.workspace_roots_json = dumps_json(payload.workspace_roots)
    if payload.capabilities is not None:
        from app.core.json import dumps_json

        worker.capabilities_json = dumps_json(payload.capabilities)
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
        payload={"status": worker.status, "transport_state": worker.transport_state, "relay": True},
    )
    db.commit()
    space_id = worker.space_id or actor.space_id or ensure_default_space(db).space_id
    return {"worker": worker_out(worker), "runtime_settings": get_worker_runtime_defaults(db, space_id=space_id)}


@router.post("/api/worker/jobs/claim")
def claim_job_public(
    response: Response,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = actor.worker
    assert worker is not None
    return claim_job_internal(ClaimJobIn(worker_id=worker.worker_id), response=response, db=db, actor=actor)


@router.post("/api/worker/jobs/{job_id}/complete")
def complete_job_public(job_id: str, payload: CompleteJobIn, db: DbSession, actor: Actor = Depends(require_worker)):
    worker = _assert_worker_binding(actor, payload.worker_id)
    return complete_job_internal(job_id, payload, db=db, actor=Actor(actor.actor_type, actor.actor_id, actor.auth_mode, worker=worker, space_id=worker.space_id))


@router.post("/api/worker/jobs/{job_id}/fail")
def fail_job_public(job_id: str, payload: FailJobIn, db: DbSession, actor: Actor = Depends(require_worker)):
    worker = _assert_worker_binding(actor, payload.worker_id)
    return fail_job_internal(job_id, payload, db=db, actor=Actor(actor.actor_type, actor.actor_id, actor.auth_mode, worker=worker, space_id=worker.space_id))


@router.post("/api/worker/sessions/discovered")
def discovered_sessions_public(payload: DiscoveredSessionsIn, db: DbSession, actor: Actor = Depends(require_worker)):
    return discovered_sessions_internal(payload, db=db, actor=actor)


@router.post("/api/worker/providers/snapshot")
def publish_provider_snapshots_public(payload: ProviderSnapshotsIn, db: DbSession, actor: Actor = Depends(require_worker)):
    return publish_provider_snapshots(payload, db=db, actor=actor)


@router.post("/api/worker/sessions/{session_id}/timeline")
def publish_session_timeline_public(
    session_id: str,
    payload: TimelinePublishIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    return publish_session_timeline(session_id, payload, db=db, actor=actor)


@router.post("/api/worker/permissions/requested")
def request_permission_public(payload: PermissionRequestedIn, db: DbSession, actor: Actor = Depends(require_worker)):
    return request_permission(payload, db=db, actor=actor)


@router.get("/api/worker/permissions/{permission_id}")
def get_permission_public(permission_id: str, db: DbSession, actor: Actor = Depends(require_worker)):
    return get_permission_for_worker(permission_id, db=db, actor=actor)


@router.post("/api/worker/permissions/{permission_id}/resolved")
def resolve_permission_public(
    permission_id: str,
    payload: PermissionResolvedIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    return resolve_permission_from_worker(permission_id, payload, db=db, actor=actor)


@router.post("/api/worker/secrets/resolve")
def resolve_worker_secrets_public(payload: SecretResolveIn, db: DbSession, actor: Actor = Depends(require_worker)):
    return resolve_worker_secrets(payload, db=db, actor=actor)
