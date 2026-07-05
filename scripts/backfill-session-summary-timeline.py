from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.core.config import Settings  # noqa: E402
from app.core.database import create_db_engine, create_session_local, init_database  # noqa: E402
from app.maintenance import backfill_session_summary_timeline_rows  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill missing agent_timeline rows from agent_sessions.last_message summaries."
    )
    parser.add_argument("--apply", action="store_true", help="Write missing timeline rows. Defaults to dry-run.")
    parser.add_argument("--backend", choices=["codex", "claude", "kimi", "opencode"], help="Only scan one backend.")
    parser.add_argument("--limit", type=int, help="Maximum number of candidate sessions to inspect or write.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = Settings()
    engine = create_db_engine(settings.database_url)
    init_database(engine)
    SessionLocal = create_session_local(engine)
    with SessionLocal() as db:
        result = backfill_session_summary_timeline_rows(
            db,
            dry_run=not args.apply,
            backend=args.backend,
            limit=args.limit,
        )
        if args.apply:
            db.commit()
        else:
            db.rollback()
        print(json.dumps(result.as_dict(), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
