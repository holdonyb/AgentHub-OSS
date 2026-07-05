from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.models import AgentSession
from app.services import ensure_session_summary_timeline_row, session_needs_summary_timeline_row


@dataclass
class SummaryTimelineBackfillResult:
    dry_run: bool
    scanned: int = 0
    candidates: int = 0
    created: int = 0
    unresolved: int = 0
    by_backend: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "dry_run": self.dry_run,
            "scanned": self.scanned,
            "candidates": self.candidates,
            "created": self.created,
            "unresolved": self.unresolved,
            "by_backend": dict(sorted(self.by_backend.items())),
        }


def backfill_session_summary_timeline_rows(
    db: Any,
    *,
    dry_run: bool = True,
    backend: str | None = None,
    limit: int | None = None,
) -> SummaryTimelineBackfillResult:
    result = SummaryTimelineBackfillResult(dry_run=dry_run)
    query = db.query(AgentSession).filter(AgentSession.last_message != "", AgentSession.last_role != "user")
    if backend:
        query = query.filter(AgentSession.backend == backend)
    query = query.order_by(AgentSession.last_activity_at.is_(None), AgentSession.last_activity_at.desc(), AgentSession.updated_at.desc())

    for session in query:
        result.scanned += 1
        if not session_needs_summary_timeline_row(db, session):
            continue
        result.candidates += 1
        result.by_backend[session.backend] = result.by_backend.get(session.backend, 0) + 1
        if not dry_run:
            if ensure_session_summary_timeline_row(db, session) is not None:
                db.commit()
                result.created += 1
            elif session_needs_summary_timeline_row(db, session):
                result.unresolved += 1
        if limit is not None and result.candidates >= limit:
            break

    return result
