from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.core.json import loads_json
from app.core.secrets import decrypt_secret_value, encrypt_secret_value, secret_value_hash
from app.models import AgentSecret, Job, utcnow
from app.routers.internal import _assert_worker_binding
from app.schemas import SecretCreateIn, SecretResolveIn
from app.services import secret_out

router = APIRouter()


def _normalize_name(value: str) -> str:
    return value.strip().upper()


def _normalize_scope(value: str) -> str:
    return value.strip() or "default"


def _job_secret_controls(job: Job) -> tuple[set[str], str, str]:
    payload = loads_json(job.payload_json, {})
    if not isinstance(payload, dict):
        payload = {}
    controls = payload.get("controls") if isinstance(payload.get("controls"), dict) else {}
    raw_refs = controls.get("secret_refs") if isinstance(controls, dict) else []
    refs = {_normalize_name(str(name)) for name in raw_refs if str(name).strip()} if isinstance(raw_refs, list) else set()
    environment = _normalize_scope(str(controls.get("secret_environment") or payload.get("secret_environment") or "default"))
    namespace = _normalize_scope(str(controls.get("secret_namespace") or payload.get("secret_namespace") or job.namespace or "default"))
    return refs, environment, namespace


@router.get("/api/secrets")
def list_secrets(
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
    namespace: str | None = None,
    environment: str | None = None,
):
    query = db.query(AgentSecret).filter(AgentSecret.space_id == actor.space_id, AgentSecret.revoked_at.is_(None))
    if namespace:
        query = query.filter(AgentSecret.namespace == _normalize_scope(namespace))
    if environment:
        query = query.filter(AgentSecret.environment == _normalize_scope(environment))
    rows = query.order_by(AgentSecret.environment.asc(), AgentSecret.namespace.asc(), AgentSecret.name.asc()).all()
    return {"items": [secret_out(row) for row in rows]}


@router.post("/api/secrets")
def upsert_secret(payload: SecretCreateIn, db: DbSession, actor: Actor = Depends(require_min_role("admin"))):
    settings = db.info.get("settings")
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    namespace = _normalize_scope(payload.namespace)
    environment = _normalize_scope(payload.environment)
    name = _normalize_name(payload.name)
    secret = (
        db.query(AgentSecret)
        .filter(
            AgentSecret.space_id == actor.space_id,
            AgentSecret.namespace == namespace,
            AgentSecret.environment == environment,
            AgentSecret.name == name,
        )
        .one_or_none()
    )
    if secret is None:
        secret = AgentSecret(space_id=actor.space_id, namespace=namespace, environment=environment, name=name, created_by=actor.actor_id)
        db.add(secret)
    secret.description = payload.description.strip()
    secret.value_ciphertext = encrypt_secret_value(payload.value, settings)
    secret.value_hash = secret_value_hash(payload.value, settings)
    secret.revoked_at = None
    secret.updated_at = utcnow()
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="secret",
        source_id=secret.secret_id,
        event_type="secret.upsert",
        payload={"name": name, "namespace": namespace, "environment": environment},
    )
    db.commit()
    return {"secret": secret_out(secret)}


@router.delete("/api/secrets/{secret_id}")
def revoke_secret(secret_id: str, db: DbSession, actor: Actor = Depends(require_min_role("admin"))):
    secret = db.query(AgentSecret).filter(AgentSecret.space_id == actor.space_id, AgentSecret.secret_id == secret_id).one_or_none()
    if secret is None:
        raise HTTPException(status_code=404, detail={"message": "Secret not found", "code": "SECRET_NOT_FOUND"})
    secret.revoked_at = utcnow()
    secret.updated_at = secret.revoked_at
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="secret",
        source_id=secret.secret_id,
        event_type="secret.revoke",
        payload={"name": secret.name, "namespace": secret.namespace, "environment": secret.environment},
    )
    db.commit()
    return {"secret": secret_out(secret)}


@router.post("/api/internal/secrets/resolve")
def resolve_worker_secrets(payload: SecretResolveIn, db: DbSession, actor: Actor = Depends(require_worker)):
    worker = _assert_worker_binding(actor, payload.worker_id)
    settings = db.info.get("settings")
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    names = {_normalize_name(name) for name in payload.names if name.strip()}
    if not names:
        return {"secrets": {}}
    if not payload.job_id:
        raise HTTPException(status_code=400, detail={"message": "job_id is required for secret resolution", "code": "SECRET_JOB_REQUIRED"})
    job = (
        db.query(Job)
        .filter(Job.space_id == worker.space_id, Job.job_id == payload.job_id, Job.worker_id == worker.worker_id)
        .one_or_none()
    )
    if job is None:
        raise HTTPException(status_code=404, detail={"message": "Job not found", "code": "JOB_NOT_FOUND"})
    if job.status != "running":
        raise HTTPException(status_code=409, detail={"message": "Secrets can only be resolved for running jobs", "code": "JOB_NOT_RUNNING"})
    allowed_names, allowed_environment, allowed_namespace = _job_secret_controls(job)
    if not names.issubset(allowed_names):
        raise HTTPException(status_code=403, detail={"message": "Secret name is not referenced by this job", "code": "SECRET_REF_NOT_ALLOWED"})
    if _normalize_scope(payload.environment) != allowed_environment or _normalize_scope(payload.namespace) != allowed_namespace:
        raise HTTPException(status_code=403, detail={"message": "Secret scope does not match this job", "code": "SECRET_SCOPE_MISMATCH"})
    rows = (
        db.query(AgentSecret)
        .filter(
            AgentSecret.space_id == worker.space_id,
            AgentSecret.namespace == _normalize_scope(payload.namespace),
            AgentSecret.environment == _normalize_scope(payload.environment),
            AgentSecret.name.in_(names),
            AgentSecret.revoked_at.is_(None),
        )
        .all()
    )
    return {"secrets": {row.name: decrypt_secret_value(row.value_ciphertext, settings) for row in rows}}
