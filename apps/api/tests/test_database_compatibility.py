from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError


def _sqlite_index_names(engine, table_name: str) -> set[str]:
    with engine.connect() as conn:
        return {row[1] for row in conn.execute(text(f"PRAGMA index_list('{table_name}')")).all()}


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
                "id VARCHAR(64), space_id VARCHAR(64), session_id VARCHAR(180), created_at DATETIME, seq INTEGER"
                ")"
            )
        )

    _ensure_compatible_indexes(engine)

    assert "ix_events_space_created_at" in _sqlite_index_names(engine, "events")
    assert "ix_jobs_space_created_at" in _sqlite_index_names(engine, "jobs")
    assert "ix_jobs_space_target_updated_at" in _sqlite_index_names(engine, "jobs")
    assert "ix_agent_timeline_space_session_created_seq" in _sqlite_index_names(engine, "agent_timeline")


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
    from app.main import _database_error_payload

    status_code, detail = _database_error_payload(
        OperationalError("SELECT 1", {}, Exception("database is locked"))
    )

    assert status_code == 503
    assert detail == {"message": "Database is busy, retry shortly", "code": "DB_BUSY"}
