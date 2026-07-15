from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


ROOT = Path(__file__).resolve().parents[3]
API_ROOT = ROOT / "apps" / "api"


def test_fresh_sqlite_upgrade_bootstraps_current_schema(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database_path = tmp_path / "fresh-agenthub.db"
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    monkeypatch.setenv("AGENTHUB_DATABASE_URL", database_url)
    config = Config(str(API_ROOT / "alembic.ini"))

    command.upgrade(config, "head")

    engine = create_engine(database_url)
    try:
        tables = set(inspect(engine).get_table_names())
        assert {
            "agent_sessions",
            "agent_timeline",
            "notification_records",
            "notification_deliveries",
            "push_devices",
            "spaces",
        }.issubset(tables)
        with engine.connect() as connection:
            revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert revision == "0007_per_device_push_delivery"
    finally:
        engine.dispose()
