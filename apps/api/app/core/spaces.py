from __future__ import annotations

import re
from typing import TYPE_CHECKING

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app.models import Space, SpaceMembership, User, new_id, utcnow

if TYPE_CHECKING:
    from app.core.deps import Actor


SPACE_HEADER = "X-AgentHub-Space"
ROLE_RANK = {"viewer": 10, "operator": 20, "admin": 30, "owner": 40}
SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify_space_name(value: str) -> str:
    slug = SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or "space"


def _unique_slug(db: Session, base_slug: str) -> str:
    slug = base_slug
    suffix = 2
    while db.query(Space.space_id).filter(Space.slug == slug).first() is not None:
        slug = f"{base_slug}-{suffix}"
        suffix += 1
    return slug


def ensure_default_space(
    db: Session,
    *,
    owner_user: User | None = None,
    name: str | None = None,
) -> Space:
    existing = db.query(Space).order_by(Space.created_at.asc()).first()
    if existing is not None:
        if owner_user is not None:
            ensure_space_membership(db, existing.space_id, owner_user, role=owner_user.role)
        return existing
    if name:
        space_name = name.strip()
    elif owner_user is not None:
        email_name = owner_user.email.split("@", 1)[0].strip() or "owner"
        space_name = f"{email_name} space"
    else:
        space_name = "default space"
    space = Space(
        space_id=new_id("spc"),
        name=space_name,
        slug=_unique_slug(db, slugify_space_name(space_name)),
        mode="private",
        created_by=owner_user.id if owner_user is not None else None,
    )
    db.add(space)
    db.flush()
    if owner_user is not None:
        ensure_space_membership(db, space.space_id, owner_user, role=owner_user.role)
    return space


def ensure_space_membership(db: Session, space_id: str, user: User, *, role: str) -> SpaceMembership:
    membership = (
        db.query(SpaceMembership)
        .filter(SpaceMembership.space_id == space_id, SpaceMembership.user_id == user.id)
        .one_or_none()
    )
    if membership is None:
        membership = SpaceMembership(space_id=space_id, user_id=user.id, role=role or user.role)
        db.add(membership)
        db.flush()
    elif membership.role != role and role:
        membership.role = role
    return membership


def resolve_actor_space(
    request: Request,
    db: Session,
    actor: "Actor",
    *,
    required: bool,
) -> "Actor":
    if actor.actor_type != "user" or actor.user is None:
        return actor
    requested_space_id = request.headers.get(SPACE_HEADER, "").strip()
    pinned_space_id = actor.access_token.space_id if actor.access_token is not None else None
    if pinned_space_id and requested_space_id and requested_space_id != pinned_space_id:
        raise HTTPException(
            status_code=403,
            detail={"message": "Token is bound to another space", "code": "SPACE_TOKEN_MISMATCH"},
        )
    target_space_id = pinned_space_id or requested_space_id
    memberships = (
        db.query(SpaceMembership)
        .filter(SpaceMembership.user_id == actor.user.id)
        .order_by(SpaceMembership.created_at.asc())
        .all()
    )
    membership = None
    if target_space_id:
        membership = next((row for row in memberships if row.space_id == target_space_id), None)
        if membership is None and required:
            raise HTTPException(
                status_code=403,
                detail={"message": "User is not a member of this space", "code": "SPACE_FORBIDDEN"},
            )
    elif memberships:
        membership = memberships[0]
    elif required:
        raise HTTPException(
            status_code=409,
            detail={"message": "User does not belong to any space", "code": "SPACE_REQUIRED"},
        )
    actor.space_membership = membership
    actor.space_id = membership.space_id if membership is not None else target_space_id or None
    actor.space_role = membership.role if membership is not None else None
    actor.space = db.query(Space).filter(Space.space_id == actor.space_id).one_or_none() if actor.space_id else None
    return actor


def require_space_role(actor: "Actor", min_role: str) -> "Actor":
    if actor.user is None:
        raise HTTPException(status_code=403, detail={"message": "User token required", "code": "USER_REQUIRED"})
    if actor.space_id is None:
        raise HTTPException(status_code=409, detail={"message": "Active space is required", "code": "SPACE_REQUIRED"})
    effective_role = actor.space_role or actor.user.role
    if ROLE_RANK.get(effective_role, 0) < ROLE_RANK[min_role]:
        raise HTTPException(status_code=403, detail={"message": "Insufficient role", "code": "FORBIDDEN"})
    return actor


def actor_space_payload(actor: "Actor") -> dict[str, str] | None:
    if actor.space is None:
        return None
    return {
        "space_id": actor.space.space_id,
        "name": actor.space.name,
        "slug": actor.space.slug,
        "mode": actor.space.mode,
        "role": actor.space_role or "",
    }
