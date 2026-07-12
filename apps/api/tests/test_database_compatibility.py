from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError, OperationalError


def _sqlite_index_names(engine, table_name: str) -> set[str]:
    with engine.connect() as conn:
        return {row[1] for row in conn.execute(text(f"PRAGMA index_list('{table_name}')")).all()}


def _sqlite_column_names(engine, table_name: str) -> set[str]:
    with engine.connect() as conn:
        return {row[1] for row in conn.execute(text(f"PRAGMA table_info('{table_name}')")).all()}


def test_ensure_compatible_columns_adds_timeline_updated_at_to_legacy_sqlite(tmp_path: Path) -> None:
    from app.core.database import _ensure_compatible_columns

    db_path = tmp_path / "legacy-agenthub.db"
    engine = create_engine(f"sqlite+pysqlite:///{db_path.as_posix()}", future=True)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE agent_sessions (session_id VARCHAR(180), created_at DATETIME)"))
        conn.execute(
            text(
                "CREATE TABLE agent_timeline ("
                "id VARCHAR(64), session_id VARCHAR(180), seq INTEGER, item_type VARCHAR(64), "
                "role VARCHAR(32), text TEXT, payload_json TEXT, created_at DATETIME, space_id VARCHAR(64)"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO agent_timeline "
                "(id, session_id, seq, item_type, role, text, payload_json, created_at, space_id) "
                "VALUES ('tli_1', 'sess_1', 1, 'assistant_message', 'assistant', 'ready', '{}', "
                "'2026-07-05 12:34:56', 'spc_1')"
            )
        )

    _ensure_compatible_columns(engine)

    assert "updated_at" in _sqlite_column_names(engine, "agent_timeline")
    with engine.connect() as conn:
        updated_at = conn.execute(text("SELECT updated_at FROM agent_timeline WHERE id = 'tli_1'")).scalar_one()

    assert str(updated_at) == "2026-07-05 12:34:56"


def test_ensure_compatible_columns_adds_task_attempt_number_with_default_one(tmp_path: Path) -> None:
    from app.core.database import _ensure_compatible_columns

    db_path = tmp_path / "legacy-task-attempt.db"
    engine = create_engine(f"sqlite+pysqlite:///{db_path.as_posix()}", future=True)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE agent_sessions (session_id VARCHAR(180), created_at DATETIME)"))
        conn.execute(
            text(
                "CREATE TABLE agent_task_executions ("
                "id VARCHAR(64), execution_id VARCHAR(64), task_id VARCHAR(64), status VARCHAR(32)"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO agent_task_executions (id, execution_id, task_id, status) "
                "VALUES ('ate_1', 'tex_1', 'tsk_1', 'succeeded')"
            )
        )

    _ensure_compatible_columns(engine)

    assert "attempt_number" in _sqlite_column_names(engine, "agent_task_executions")
    with engine.connect() as conn:
        attempt_number = conn.execute(
            text("SELECT attempt_number FROM agent_task_executions WHERE id = 'ate_1'")
        ).scalar_one()
        default_value = next(
            row[4]
            for row in conn.execute(text("PRAGMA table_info('agent_task_executions')")).all()
            if row[1] == "attempt_number"
        )

    assert attempt_number == 1
    assert str(default_value).strip("'\"") == "1"


def test_ensure_compatible_indexes_adds_composite_indexes_to_legacy_sqlite(tmp_path: Path) -> None:
    from app.core.database import _ensure_compatible_indexes

    db_path = tmp_path / "legacy-agenthub.db"
    engine = create_engine(f"sqlite+pysqlite:///{db_path.as_posix()}", future=True)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE events (id VARCHAR(64), space_id VARCHAR(64), created_at DATETIME)"))
        conn.execute(
            text(
                "CREATE TABLE jobs ("
                "id VARCHAR(64), space_id VARCHAR(64), target_session_id VARCHAR(180), "
                "created_at DATETIME, updated_at DATETIME"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE agent_timeline ("
                "id VARCHAR(64), space_id VARCHAR(64), session_id VARCHAR(180), created_at DATETIME, updated_at DATETIME, seq INTEGER"
                ")"
            )
        )

    _ensure_compatible_indexes(engine)

    assert "ix_events_space_created_at" in _sqlite_index_names(engine, "events")
    assert "ix_jobs_space_created_at" in _sqlite_index_names(engine, "jobs")
    assert "ix_jobs_space_target_updated_at" in _sqlite_index_names(engine, "jobs")
    assert "ix_agent_timeline_space_session_created_seq" in _sqlite_index_names(engine, "agent_timeline")
    assert "ix_agent_timeline_space_session_updated_id" in _sqlite_index_names(engine, "agent_timeline")


def test_task_attempt_migration_renumbers_legacy_duplicates_and_enforces_uniqueness(tmp_path: Path) -> None:
    from app.core.database import _ensure_compatible_columns, _ensure_compatible_indexes

    db_path = tmp_path / "legacy-duplicate-task-attempts.db"
    engine = create_engine(f"sqlite+pysqlite:///{db_path.as_posix()}", future=True)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE agent_sessions (session_id VARCHAR(180), created_at DATETIME)"))
        conn.execute(
            text(
                "CREATE TABLE agent_task_executions ("
                "id VARCHAR(64), execution_id VARCHAR(64), space_id VARCHAR(64), task_id VARCHAR(64), "
                "attempt_number INTEGER NOT NULL DEFAULT 1, status VARCHAR(32), created_at DATETIME"
                ")"
            )
        )
        conn.execute(
            text(
                "INSERT INTO agent_task_executions "
                "(id, execution_id, space_id, task_id, attempt_number, status, created_at) VALUES "
                "('ate_1', 'tex_1', 'spc_1', 'tsk_1', 1, 'completed', '2026-07-01 10:00:00'), "
                "('ate_2', 'tex_2', 'spc_1', 'tsk_1', 1, 'queued', '2026-07-01 11:00:00')"
            )
        )

    _ensure_compatible_columns(engine)
    _ensure_compatible_indexes(engine)

    with engine.connect() as conn:
        attempts = conn.execute(
            text(
                "SELECT attempt_number FROM agent_task_executions "
                "WHERE space_id = 'spc_1' AND task_id = 'tsk_1' ORDER BY created_at"
            )
        ).scalars().all()
    assert attempts == [1, 2]
    assert "uq_agent_task_executions_space_task_attempt" in _sqlite_index_names(
        engine,
        "agent_task_executions",
    )

    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO agent_task_executions "
                    "(id, execution_id, space_id, task_id, attempt_number, status, created_at) "
                    "VALUES ('ate_3', 'tex_3', 'spc_1', 'tsk_1', 2, 'queued', '2026-07-01 12:00:00')"
                )
            )


def test_create_db_engine_configures_sqlite_for_wal_and_busy_timeout(tmp_path: Path) -> None:
    from app.core.database import create_db_engine

    db_path = tmp_path / "wal-agenthub.db"
    engine = create_db_engine(f"sqlite+pysqlite:///{db_path.as_posix()}")
    with engine.connect() as conn:
        journal_mode = conn.execute(text("PRAGMA journal_mode")).scalar_one()
        busy_timeout = conn.execute(text("PRAGMA busy_timeout")).scalar_one()
        foreign_keys = conn.execute(text("PRAGMA foreign_keys")).scalar_one()

    assert str(journal_mode).lower() == "wal"
    assert int(busy_timeout) == 30000
    assert int(foreign_keys) == 1


def test_database_busy_operational_error_maps_to_503() -> None:
    from app.factory import _database_error_payload

    status_code, detail = _database_error_payload(
        OperationalError("SELECT 1", {}, Exception("database is locked"))
    )

    assert status_code == 503
    assert detail == {"message": "Database is busy, retry shortly", "code": "DB_BUSY"}
