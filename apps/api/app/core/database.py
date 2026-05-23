from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def create_db_engine(database_url: str) -> Engine:
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    return create_engine(database_url, connect_args=connect_args, future=True)


def create_session_local(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


def init_database(engine: Engine) -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_compatible_columns(engine)
    _bootstrap_default_space(engine)


def _ensure_compatible_columns(engine: Engine) -> None:
    """Small SQLite-compatible bootstrap migration for existing v1 installs."""
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "agent_sessions" not in table_names:
        return
    space_columns = {
        "workers": {
            "space_id": "VARCHAR(64)",
            "connection_mode": "VARCHAR(32) NOT NULL DEFAULT 'private'",
            "transport_state": "VARCHAR(64) NOT NULL DEFAULT 'polling'",
            "worker_version": "VARCHAR(64)",
            "max_concurrent_jobs": "INTEGER NOT NULL DEFAULT 2",
            "job_poll_interval_seconds": "INTEGER NOT NULL DEFAULT 5",
            "heartbeat_interval_seconds": "INTEGER NOT NULL DEFAULT 30",
        },
        "agent_sessions": {"space_id": "VARCHAR(64)"},
        "agent_timeline": {"space_id": "VARCHAR(64)"},
        "agent_permissions": {"space_id": "VARCHAR(64)"},
        "provider_snapshots": {"space_id": "VARCHAR(64)"},
        "jobs": {"space_id": "VARCHAR(64)"},
        "events": {"space_id": "VARCHAR(64)"},
        "memories": {"space_id": "VARCHAR(64)"},
        "schedules": {"space_id": "VARCHAR(64)"},
        "invites": {"space_id": "VARCHAR(64)"},
        "access_tokens": {"space_id": "VARCHAR(64)"},
    }
    existing = {column["name"] for column in inspector.get_columns("agent_sessions")}
    session_columns = {
        "display_title": "VARCHAR(240) NOT NULL DEFAULT ''",
        "custom_title": "VARCHAR(240)",
        "heuristic_title": "VARCHAR(240) NOT NULL DEFAULT ''",
        "llm_title": "VARCHAR(240)",
        "activity_summary": "TEXT NOT NULL DEFAULT ''",
        "last_activity_at": "DATETIME",
        "last_role": "VARCHAR(32) NOT NULL DEFAULT ''",
        "controls_json": "TEXT NOT NULL DEFAULT '{}'",
        "runtime_metadata_json": "TEXT NOT NULL DEFAULT '{}'",
        "archived_at": "DATETIME",
    }
    if engine.dialect.name == "sqlite":
        with engine.begin() as conn:
            for table_name, columns in space_columns.items():
                if table_name not in table_names:
                    continue
                existing_columns = {column["name"] for column in inspector.get_columns(table_name)}
                for name, ddl in columns.items():
                    if name not in existing_columns:
                        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {name} {ddl}"))
            for name, ddl in session_columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE agent_sessions ADD COLUMN {name} {ddl}"))
    Base.metadata.create_all(bind=engine)


def _bootstrap_default_space(engine: Engine) -> None:
    from app.models import AccessToken, AgentPermission, AgentSession, AgentTimeline, Event, Invite, Job, Memory, ProviderSnapshot, Schedule, SettingEntry, Space, SpaceMembership, User, Worker, WorkerEnrollment

    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)
    with SessionLocal() as db:
        users = db.query(User).order_by(User.created_at.asc()).all()
        if not users and db.query(Space).count() == 0 and db.query(Worker).count() == 0:
            return
        space = db.query(Space).order_by(Space.created_at.asc()).first()
        if space is None:
            owner = users[0] if users else None
            space_name = f"{owner.email.split('@', 1)[0]} space" if owner is not None else "default space"
            slug = "default"
            suffix = 2
            while db.query(Space.space_id).filter(Space.slug == slug).first() is not None:
                slug = f"default-{suffix}"
                suffix += 1
            space = Space(
                space_id=f"spc_bootstrap_{suffix}" if db.query(Space).count() > 0 else "spc_default",
                name=space_name,
                slug=slug,
                mode="private",
                created_by=owner.id if owner is not None else None,
            )
            db.add(space)
            db.flush()
        for user in users:
            membership = (
                db.query(SpaceMembership)
                .filter(SpaceMembership.space_id == space.space_id, SpaceMembership.user_id == user.id)
                .one_or_none()
            )
            if membership is None:
                db.add(SpaceMembership(space_id=space.space_id, user_id=user.id, role=user.role))
        business_tables = (
            Worker,
            AgentSession,
            AgentTimeline,
            AgentPermission,
            ProviderSnapshot,
            Job,
            Event,
            Memory,
            Schedule,
            Invite,
            AccessToken,
            WorkerEnrollment,
            SettingEntry,
        )
        for model in business_tables:
            if hasattr(model, "space_id"):
                db.query(model).filter(model.space_id.is_(None)).update({"space_id": space.space_id}, synchronize_session=False)
        db.query(SpaceMembership).filter(SpaceMembership.space_id.is_(None)).delete(synchronize_session=False)
        db.commit()


def reset_database(engine: Engine) -> None:
    from app import models  # noqa: F401

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    _bootstrap_default_space(engine)


def session_scope(SessionLocal: sessionmaker[Session]) -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
