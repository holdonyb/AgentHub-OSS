from __future__ import annotations

from datetime import datetime

from app.models import AgentSession, utcnow


LEGACY_EXECUTION_STATUS = {
    "ready": "idle",
    "queued": "queued",
    "running": "running",
    "needs_reply": "waiting_input",
    "failed": "failed",
    "terminated": "terminated",
}


def projected_execution_status(status: str) -> str:
    return LEGACY_EXECUTION_STATUS.get(status, "unknown")


def _set_attention(session: AgentSession, status: str, reason: str, *, at: datetime) -> None:
    if session.attention_status == status and session.attention_reason == reason:
        return
    session.attention_status = status
    session.attention_reason = reason
    session.attention_revision = max(int(session.attention_revision or 0), 0) + 1
    session.attention_changed_at = at


def set_session_status(
    session: AgentSession,
    status: str,
    *,
    source: str = "legacy",
    at: datetime | None = None,
) -> None:
    observed_at = at or utcnow()
    old_execution = session.execution_status or projected_execution_status(session.status or "")
    new_execution = projected_execution_status(status)

    session.status = status
    session.execution_status_source = source
    session.execution_status_observed_at = observed_at
    if old_execution != new_execution or int(session.execution_status_seq or 0) == 0:
        session.execution_status = new_execution
        session.execution_status_seq = max(int(session.execution_status_seq or 0), 0) + 1
    else:
        session.execution_status = new_execution

    if new_execution == "waiting_input":
        _set_attention(session, "unseen", "approval", at=observed_at)
    elif new_execution == "failed":
        _set_attention(session, "unseen", "failure", at=observed_at)
    elif new_execution == "idle":
        if old_execution in {"queued", "running"}:
            _set_attention(session, "unseen", "completion", at=observed_at)
        elif old_execution != "idle":
            _set_attention(session, "none", "", at=observed_at)
    elif new_execution in {"queued", "running", "terminated"}:
        _set_attention(session, "none", "", at=observed_at)


def ensure_session_state(session: AgentSession) -> None:
    if int(session.execution_status_seq or 0) > 0 and session.execution_status:
        return
    set_session_status(session, session.status or "ready", source="legacy")


def mark_session_attention_seen(session: AgentSession, *, at: datetime | None = None) -> None:
    if session.attention_status != "unseen":
        return
    _set_attention(session, "seen", session.attention_reason or "", at=at or utcnow())
