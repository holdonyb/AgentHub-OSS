from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.core.audit import write_event
from app.core.deps import CSRF_COOKIE, SESSION_COOKIE, Actor, DbSession, require_min_role, require_space_user, require_user
from app.core.json import dumps_json, loads_json
from app.core.security import generate_token, hash_password, hash_token, verify_password
from app.core.spaces import actor_space_payload, ensure_default_space, ensure_space_membership
from app.models import AccessToken, Invite, SessionToken, SpaceMembership, User, utcnow
from app.schemas import BootstrapIn, InviteAcceptIn, InviteCreateIn, LoginIn, TokenCreateIn
from app.services import user_out

router = APIRouter()


def _space_payload(db: Session, user: User) -> dict[str, str] | None:
    membership = (
        db.query(SpaceMembership)
        .filter(SpaceMembership.user_id == user.id)
        .order_by(SpaceMembership.created_at.asc())
        .one_or_none()
    )
    if membership is None:
        return None
    actor = Actor("user", user.id, "cookie", user=user, space_id=membership.space_id, space_role=membership.role)
    actor.space = membership.space
    return actor_space_payload(actor)


def _issue_session(request: Request, response: Response, db: Session, user: User) -> str:
    session_token = generate_token("ahs")
    csrf_token = generate_token("csrf")
    db.add(
        SessionToken(
            user_id=user.id,
            token_hash=hash_token(session_token),
            csrf_hash=hash_token(csrf_token),
        )
    )
    membership = (
        db.query(SpaceMembership)
        .filter(SpaceMembership.user_id == user.id)
        .order_by(SpaceMembership.created_at.asc())
        .first()
    )
    write_event(
        db,
        space_id=membership.space_id if membership is not None else None,
        actor_type="user",
        actor_id=user.id,
        source_type="auth",
        source_id=user.id,
        event_type="auth.login",
    )
    db.commit()
    settings = request.app.state.settings
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=60 * 60 * 24 * 14,
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf_token,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=60 * 60 * 24 * 14,
        path="/",
    )
    return csrf_token


@router.post("/api/auth/bootstrap")
def bootstrap_owner(payload: BootstrapIn, request: Request, response: Response, db: DbSession):
    if db.query(User).count() > 0:
        raise HTTPException(status_code=409, detail={"message": "Owner already exists", "code": "BOOTSTRAP_USED"})
    bootstrap_token = request.app.state.bootstrap_token
    if hash_token(payload.bootstrap_token) != hash_token(bootstrap_token):
        write_event(
            db,
            actor_type="anonymous",
            actor_id="anonymous",
            source_type="auth",
            source_id=payload.email,
            event_type="auth.bootstrap_failed",
            level="warning",
        )
        db.commit()
        raise HTTPException(status_code=403, detail={"message": "Invalid bootstrap token", "code": "BOOTSTRAP_INVALID"})
    user = User(email=str(payload.email), password_hash=hash_password(payload.password), role="owner")
    db.add(user)
    db.flush()
    space = ensure_default_space(db, owner_user=user)
    write_event(
        db,
        space_id=space.space_id,
        actor_type="user",
        actor_id=user.id,
        source_type="auth",
        source_id=user.id,
        event_type="auth.bootstrap_owner",
    )
    csrf_token = _issue_session(request, response, db, user)
    return {"user": user_out(user), "csrf_token": csrf_token, "space": _space_payload(db, user)}


@router.post("/api/auth/login")
def login(payload: LoginIn, request: Request, response: Response, db: DbSession):
    user = db.query(User).filter(User.email == str(payload.email)).one_or_none()
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        write_event(
            db,
            actor_type="anonymous",
            actor_id="anonymous",
            source_type="auth",
            source_id=str(payload.email),
            event_type="auth.login_failed",
            level="warning",
        )
        db.commit()
        raise HTTPException(status_code=401, detail={"message": "Invalid credentials", "code": "BAD_CREDENTIALS"})
    csrf_token = _issue_session(request, response, db, user)
    return {"user": user_out(user), "csrf_token": csrf_token, "space": _space_payload(db, user)}


@router.post("/api/auth/logout")
def logout(response: Response, db: DbSession, actor: Actor = Depends(require_user)):
    if actor.session_token:
        actor.session_token.revoked_at = utcnow()
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="auth",
            source_id=actor.actor_id,
            event_type="auth.logout",
        )
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
def me(request: Request, actor: Actor = Depends(require_user)):
    assert actor.user is not None
    csrf_token = request.cookies.get(CSRF_COOKIE, "")
    return {"user": user_out(actor.user), "csrf_token": csrf_token, "space": actor_space_payload(actor)}


@router.post("/api/invites")
def create_invite(
    payload: InviteCreateIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    assert actor.user is not None
    invite_token = generate_token("ahi")
    invite = Invite(
        space_id=actor.space_id,
        email=str(payload.email),
        role=payload.role,
        token_hash=hash_token(invite_token),
        expires_at=utcnow() + timedelta(hours=payload.expires_in_hours),
        created_by=actor.user.id,
    )
    db.add(invite)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.user.id,
        source_type="invite",
        source_id=invite.id,
        event_type="invite.create",
        payload={"email": invite.email, "role": invite.role},
    )
    db.commit()
    return {
        "invite_id": invite.id,
        "invite_token": invite_token,
        "email": invite.email,
        "role": invite.role,
        "expires_at": invite.expires_at,
    }


@router.post("/api/invites/accept")
def accept_invite(payload: InviteAcceptIn, request: Request, response: Response, db: DbSession):
    invite = db.query(Invite).filter(Invite.token_hash == hash_token(payload.invite_token)).one_or_none()
    if invite is None or invite.used_at is not None or invite.expires_at <= utcnow():
        raise HTTPException(status_code=400, detail={"message": "Invite is invalid or expired", "code": "INVITE_INVALID"})
    if invite.email.lower() != str(payload.email).lower():
        raise HTTPException(status_code=400, detail={"message": "Invite email mismatch", "code": "INVITE_EMAIL_MISMATCH"})
    if db.query(User).filter(User.email == str(payload.email)).one_or_none():
        raise HTTPException(status_code=409, detail={"message": "User already exists", "code": "USER_EXISTS"})
    user = User(email=str(payload.email), password_hash=hash_password(payload.password), role=invite.role)
    db.add(user)
    db.flush()
    if invite.space_id:
        ensure_space_membership(db, invite.space_id, user, role=invite.role)
        event_space_id = invite.space_id
    else:
        event_space_id = ensure_default_space(db).space_id
        ensure_space_membership(db, event_space_id, user, role=invite.role)
    invite.used_at = utcnow()
    write_event(
        db,
        space_id=event_space_id,
        actor_type="user",
        actor_id=user.id,
        source_type="invite",
        source_id=invite.id,
        event_type="invite.accept",
    )
    csrf_token = _issue_session(request, response, db, user)
    return {"user": user_out(user), "csrf_token": csrf_token, "space": _space_payload(db, user)}


@router.get("/api/tokens")
def list_tokens(db: DbSession, actor: Actor = Depends(require_space_user)):
    assert actor.user is not None
    tokens = (
        db.query(AccessToken)
        .filter(AccessToken.user_id == actor.user.id, AccessToken.space_id == actor.space_id)
        .order_by(AccessToken.created_at.desc())
        .all()
    )
    return {
        "items": [
            {
                "token_id": token.id,
                "space_id": token.space_id,
                "name": token.name,
                "scopes": loads_json(token.scopes_json, []),
                "created_at": token.created_at,
                "revoked_at": token.revoked_at,
            }
            for token in tokens
        ]
    }


@router.post("/api/tokens")
def create_token(
    payload: TokenCreateIn,
    db: DbSession,
    actor: Actor = Depends(require_space_user),
):
    assert actor.user is not None
    token_value = generate_token("ahp")
    token = AccessToken(
        user_id=actor.user.id,
        space_id=actor.space_id,
        name=payload.name,
        token_hash=hash_token(token_value),
        scopes_json=dumps_json(payload.scopes),
    )
    db.add(token)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.user.id,
        source_type="token",
        source_id=token.id,
        event_type="token.create",
        payload={"name": token.name},
    )
    db.commit()
    return {"token_id": token.id, "token": token_value, "space_id": token.space_id}


@router.delete("/api/tokens/{token_id}")
def revoke_token(
    token_id: str,
    db: DbSession,
    actor: Actor = Depends(require_space_user),
):
    assert actor.user is not None
    token = (
        db.query(AccessToken)
        .filter(AccessToken.id == token_id, AccessToken.user_id == actor.user.id, AccessToken.space_id == actor.space_id)
        .one_or_none()
    )
    if token is None:
        raise HTTPException(status_code=404, detail={"message": "Token not found", "code": "TOKEN_NOT_FOUND"})
    token.revoked_at = utcnow()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.user.id,
        source_type="token",
        source_id=token.id,
        event_type="token.revoke",
    )
    db.commit()
    return {"ok": True}
