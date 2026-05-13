from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.spaces import resolve_actor_space, require_space_role
from app.core.security import hash_token
from app.models import AccessToken, SessionToken, Space, SpaceMembership, User, Worker, utcnow


ROLE_RANK = {"viewer": 10, "operator": 20, "admin": 30, "owner": 40}
SESSION_COOKIE = "agenthub_session"
CSRF_COOKIE = "agenthub_csrf"


@dataclass
class Actor:
    actor_type: str
    actor_id: str
    auth_mode: str
    user: User | None = None
    worker: Worker | None = None
    session_token: SessionToken | None = None
    access_token: AccessToken | None = None
    space_id: str | None = None
    space_role: str | None = None
    space: Space | None = None
    space_membership: SpaceMembership | None = None


def get_db(request: Request):
    db = request.app.state.SessionLocal()
    try:
        yield db
    finally:
        db.close()


DbSession = Annotated[Session, Depends(get_db)]


def _bearer_token(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip()


def authenticate_actor(request: Request, db: Session) -> Actor | None:
    bearer = _bearer_token(request)
    if bearer:
        token_hash = hash_token(bearer)
        access_token = (
            db.query(AccessToken)
            .filter(AccessToken.token_hash == token_hash, AccessToken.revoked_at.is_(None))
            .one_or_none()
        )
        if access_token:
            user = db.get(User, access_token.user_id)
            if user and user.is_active:
                access_token.last_used_at = utcnow()
                db.commit()
                return Actor("user", user.id, "pat", user=user, access_token=access_token)
        worker = db.query(Worker).filter(Worker.token_hash == token_hash).one_or_none()
        if worker:
            return Actor("worker", worker.worker_id, "worker", worker=worker, space_id=worker.space_id)
        return None

    cookie_token = request.cookies.get(SESSION_COOKIE)
    if cookie_token:
        token_hash = hash_token(cookie_token)
        session_token = (
            db.query(SessionToken)
            .filter(SessionToken.token_hash == token_hash, SessionToken.revoked_at.is_(None))
            .one_or_none()
        )
        if session_token:
            user = db.get(User, session_token.user_id)
            if user and user.is_active:
                return Actor("user", user.id, "cookie", user=user, session_token=session_token)
    return None


def _require_csrf(request: Request, actor: Actor) -> None:
    if actor.auth_mode != "cookie":
        return
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return
    token = request.headers.get("x-csrf-token")
    if not token:
        raise HTTPException(status_code=403, detail={"message": "Missing CSRF token", "code": "CSRF_REQUIRED"})
    if not actor.session_token or hash_token(token) != actor.session_token.csrf_hash:
        raise HTTPException(status_code=403, detail={"message": "Invalid CSRF token", "code": "CSRF_INVALID"})


def require_user(request: Request, db: DbSession) -> Actor:
    actor = authenticate_actor(request, db)
    if actor is None:
        raise HTTPException(status_code=401, detail={"message": "Authentication required", "code": "AUTH_REQUIRED"})
    if actor.actor_type != "user" or actor.user is None:
        raise HTTPException(status_code=403, detail={"message": "User token required", "code": "USER_REQUIRED"})
    _require_csrf(request, actor)
    return resolve_actor_space(request, db, actor, required=False)


def require_space_user(request: Request, db: DbSession) -> Actor:
    actor = require_user(request, db)
    return resolve_actor_space(request, db, actor, required=True)


def require_min_role(min_role: str):
    def dependency(actor: Annotated[Actor, Depends(require_space_user)]) -> Actor:
        return require_space_role(actor, min_role)

    return dependency


def require_worker(request: Request, db: DbSession) -> Actor:
    actor = authenticate_actor(request, db)
    if actor is None:
        if _bearer_token(request):
            raise HTTPException(status_code=403, detail={"message": "Invalid worker token", "code": "WORKER_TOKEN_INVALID"})
        raise HTTPException(status_code=401, detail={"message": "Worker authentication required", "code": "AUTH_REQUIRED"})
    if actor.actor_type != "worker" or actor.worker is None:
        raise HTTPException(status_code=403, detail={"message": "Worker token required", "code": "WORKER_REQUIRED"})
    return actor
