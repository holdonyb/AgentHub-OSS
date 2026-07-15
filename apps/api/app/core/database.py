from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def create_db_engine(database_url: str) -> Engine:
    if database_url.startswith("sqlite"):
        connect_args = {"check_same_thread": False, "timeout": 30}
        engine = create_engine(database_url, connect_args=connect_args, future=True)

        @event.listens_for(engine, "connect")
        def _configure_sqlite_connection(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return engine
    return create_engine(database_url, future=True)


def create_session_local(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


def init_database(engine: Engine) -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_compatible_columns(engine)
    _ensure_compatible_indexes(engine)
    _bootstrap_default_space(engine)
    _bootstrap_pending_notifications(engine)


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
        "agent_timeline": {
            "space_id": "VARCHAR(64)",
            "updated_at": "DATETIME",
        },
        "agent_permissions": {"space_id": "VARCHAR(64)"},
        "provider_snapshots": {"space_id": "VARCHAR(64)"},
        "jobs": {"space_id": "VARCHAR(64)"},
        "events": {"space_id": "VARCHAR(64)"},
        "memories": {"space_id": "VARCHAR(64)"},
        "schedules": {"space_id": "VARCHAR(64)"},
        "invites": {"space_id": "VARCHAR(64)"},
        "access_tokens": {"space_id": "VARCHAR(64)"},
        "agent_task_executions": {"attempt_number": "INTEGER NOT NULL DEFAULT 1"},
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
        "execution_status": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
        "execution_status_source": "VARCHAR(32) NOT NULL DEFAULT 'legacy'",
        "execution_status_seq": "INTEGER NOT NULL DEFAULT 0",
        "execution_status_observed_at": "DATETIME",
        "attention_status": "VARCHAR(32) NOT NULL DEFAULT 'none'",
        "attention_reason": "VARCHAR(32) NOT NULL DEFAULT ''",
        "attention_revision": "INTEGER NOT NULL DEFAULT 0",
        "attention_changed_at": "DATETIME",
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
                        existing_columns.add(name)
            for name, ddl in session_columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE agent_sessions ADD COLUMN {name} {ddl}"))
                    existing.add(name)
            status_projection = (
                "CASE status "
                "WHEN 'ready' THEN 'idle' "
                "WHEN 'queued' THEN 'queued' "
                "WHEN 'running' THEN 'running' "
                "WHEN 'needs_reply' THEN 'waiting_input' "
                "WHEN 'failed' THEN 'failed' "
                "WHEN 'terminated' THEN 'terminated' "
                "ELSE 'unknown' END"
                if "status" in existing
                else "'unknown'"
            )
            observed_fallbacks = [
                column for column in ("updated_at", "created_at") if column in existing
            ]
            observed_expression = "COALESCE(" + ", ".join(
                ["execution_status_observed_at", *observed_fallbacks, "CURRENT_TIMESTAMP"]
            ) + ")"
            approval_attention_predicate = (
                "status = 'needs_reply' AND COALESCE(attention_revision, 0) = 0"
                if "status" in existing
                else "0"
            )
            conn.execute(
                text(
                    "UPDATE agent_sessions SET "
                    f"execution_status = {status_projection}, "
                    "execution_status_source = COALESCE(NULLIF(execution_status_source, ''), 'legacy'), "
                    "execution_status_seq = CASE WHEN COALESCE(execution_status_seq, 0) < 1 THEN 1 ELSE execution_status_seq END, "
                    f"execution_status_observed_at = {observed_expression}"
                )
            )
            conn.execute(
                text(
                    "UPDATE agent_sessions SET "
                    "attention_status = CASE "
                    f"WHEN {approval_attention_predicate} "
                    "THEN 'unseen' ELSE attention_status END, "
                    "attention_reason = CASE "
                    f"WHEN {approval_attention_predicate} "
                    "THEN 'approval' ELSE attention_reason END, "
                    "attention_revision = CASE "
                    f"WHEN {approval_attention_predicate} "
                    "THEN 1 ELSE attention_revision END, "
                    "attention_changed_at = CASE "
                    f"WHEN {approval_attention_predicate} AND COALESCE(attention_changed_at, '') = '' "
                    f"THEN {observed_expression} ELSE attention_changed_at END"
                )
            )
            execution_columns = (
                {column["name"] for column in inspector.get_columns("agent_task_executions")}
                if "agent_task_executions" in table_names
                else set()
            )
            if "agent_task_executions" in table_names and "attempt_number" not in execution_columns:
                execution_columns.add("attempt_number")
            if {"id", "space_id", "task_id", "attempt_number", "created_at"}.issubset(execution_columns):
                conn.execute(
                    text(
                        "UPDATE agent_task_executions "
                        "SET attempt_number = ("
                        "SELECT COUNT(*) FROM agent_task_executions AS earlier "
                        "WHERE COALESCE(earlier.space_id, '') = "
                        "COALESCE(agent_task_executions.space_id, '') "
                        "AND earlier.task_id = agent_task_executions.task_id "
                        "AND ("
                        "COALESCE(earlier.created_at, '') < "
                        "COALESCE(agent_task_executions.created_at, '') "
                        "OR ("
                        "COALESCE(earlier.created_at, '') = "
                        "COALESCE(agent_task_executions.created_at, '') "
                        "AND earlier.id <= agent_task_executions.id"
                        ")"
                        ")"
                        ")"
                    )
                )
            if "agent_timeline" in table_names:
                conn.execute(
                    text(
                        "UPDATE agent_timeline "
                        "SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) "
                        "WHERE updated_at IS NULL"
                    )
                )
    Base.metadata.create_all(bind=engine)


def _ensure_compatible_indexes(engine: Engine) -> None:
    """Add query-shaping indexes that older SQLite installs may be missing."""
    if engine.dialect.name != "sqlite":
        return
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    table_columns = {
        table_name: {column["name"] for column in inspector.get_columns(table_name)}
        for table_name in table_names
    }
    index_statements = {
        "events": [
            ("CREATE INDEX IF NOT EXISTS ix_events_space_created_at ON events (space_id, created_at DESC)", {"space_id", "created_at"}),
        ],
        "jobs": [
            ("CREATE INDEX IF NOT EXISTS ix_jobs_space_created_at ON jobs (space_id, created_at DESC)", {"space_id", "created_at"}),
            ("CREATE INDEX IF NOT EXISTS ix_jobs_space_target_updated_at ON jobs (space_id, target_session_id, updated_at DESC)", {"space_id", "target_session_id", "updated_at"}),
        ],
        "agent_timeline": [
            ("CREATE INDEX IF NOT EXISTS ix_agent_timeline_space_session_created_seq ON agent_timeline (space_id, session_id, created_at DESC, seq DESC)", {"space_id", "session_id", "created_at", "seq"}),
            ("CREATE INDEX IF NOT EXISTS ix_agent_timeline_space_session_updated_id ON agent_timeline (space_id, session_id, updated_at ASC, seq ASC)", {"space_id", "session_id", "updated_at", "seq"}),
        ],
        "agent_tasks": [
            ("CREATE INDEX IF NOT EXISTS ix_agent_tasks_space_status_updated ON agent_tasks (space_id, status, updated_at DESC)", {"space_id", "status", "updated_at"}),
        ],
        "agent_artifacts": [
            ("CREATE INDEX IF NOT EXISTS ix_agent_artifacts_space_task_created ON agent_artifacts (space_id, task_id, created_at DESC)", {"space_id", "task_id", "created_at"}),
        ],
        "agent_task_executions": [
            ("CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_executions_space_task_attempt ON agent_task_executions (space_id, task_id, attempt_number)", {"space_id", "task_id", "attempt_number"}),
            ("CREATE INDEX IF NOT EXISTS ix_agent_task_executions_space_task_updated ON agent_task_executions (space_id, task_id, updated_at DESC)", {"space_id", "task_id", "updated_at"}),
            ("CREATE INDEX IF NOT EXISTS ix_agent_task_executions_space_job ON agent_task_executions (space_id, job_id)", {"space_id", "job_id"}),
        ],
        "notification_records": [
            (
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_recipient_transition "
                "ON notification_records (space_id, recipient_user_id, transition_key)",
                {"space_id", "recipient_user_id", "transition_key"},
            ),
            (
                "CREATE INDEX IF NOT EXISTS ix_notification_recipient_created "
                "ON notification_records (space_id, recipient_user_id, created_at DESC)",
                {"space_id", "recipient_user_id", "created_at"},
            ),
        ],
        "notification_deliveries": [
            (
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_delivery_record_device "
                "ON notification_deliveries (notification_record_id, push_device_id)",
                {"notification_record_id", "push_device_id"},
            ),
            (
                "CREATE INDEX IF NOT EXISTS ix_notification_delivery_dispatch "
                "ON notification_deliveries (status, next_attempt_at, created_at)",
                {"status", "next_attempt_at", "created_at"},
            ),
        ],
    }
    with engine.begin() as conn:
        for table_name, statements in index_statements.items():
            if table_name not in table_names:
                continue
            columns = table_columns.get(table_name, set())
            for statement, required_columns in statements:
                if not required_columns.issubset(columns):
                    continue
                conn.execute(text(statement))


def _bootstrap_default_space(engine: Engine) -> None:
    from app.models import AccessToken, AgentArtifact, AgentPermission, AgentSession, AgentTask, AgentTaskExecution, AgentTimeline, Event, Invite, Job, Memory, ProviderSnapshot, Schedule, SettingEntry, Space, SpaceMembership, User, Worker, WorkerEnrollment

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
            AgentTask,
            AgentTaskExecution,
            AgentArtifact,
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


def _bootstrap_pending_notifications(engine: Engine) -> None:
    from app.core.notifications import backfill_pending_notification_records

    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)
    with SessionLocal() as db:
        backfill_pending_notification_records(db)
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
