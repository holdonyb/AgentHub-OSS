from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.audit import write_event
from app.core.config import get_settings
from app.core.json import dumps_json, loads_json
from app.models import AgentPermission, AgentSession, AgentTimeline, Event, Job, Memory, ProviderSnapshot, Schedule, User, Worker, utcnow


ALLOWED_JOB_KINDS = {
    "session_input",
    "session_start",
    "session_fork",
    "session_btw",
    "session_fast_state_refresh",
    "session_fast_toggle",
    "session_discovery",
    "observer",
    "reflector",
    "memory_extract",
    "health_check",
    "provider_login",
    "provider_logout",
    "file_list",
    "file_read",
}

SESSION_STATES = {"ready", "queued", "running", "needs_reply", "failed", "terminated"}
JOB_STATES = {"queued", "running", "succeeded", "failed", "cancelled"}
WORKER_STATES = {"registered", "online", "degraded", "offline"}
TIMELINE_ITEM_TYPES = {"user_message", "assistant_message", "reasoning", "tool_call", "todo", "goal", "error", "compaction"}
ACK_TITLES = {"ok", "okay", "好", "好的", "可以", "行", "继续", "继续吧", "收到", "回复了"}
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\[(?:\d{1,3}(?:;\d{1,3})*)m")
CODEX_PLAN_EXIT_SOURCE = "codex_plan_exit"
CODEX_PLAN_TIMELINE_SOURCES = {"codex_app_server", "job_complete_plan_result"}
INTERACTION_PERMISSION_KINDS = {"question", "plan", "plan_exit", "mode"}
CODEX_PLAN_EXIT_CHOICES = [
    {"id": "implement", "label": "执行计划", "description": "退出计划模式，并按当前计划继续执行。"},
    {
        "id": "clear_context_implement",
        "label": "清空上下文并执行",
        "description": "要求后端尽量清理上下文后再按当前计划执行。",
    },
    {"id": "keep_planning", "label": "继续规划", "description": "继续留在计划模式，补充或调整计划。"},
    {"id": "cancel", "label": "暂不处理", "description": "保留计划，不继续投递。"},
]


def strip_ansi(value: str) -> str:
    return ANSI_ESCAPE_RE.sub("", value)


def sanitize_text(value: Any) -> Any:
    if isinstance(value, str):
        return strip_ansi(value)
    if isinstance(value, list):
        return [sanitize_text(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize_text(item) for key, item in value.items()}
    return value


def redact_payload(value: Any) -> Any:
    sanitized = sanitize_text(value)
    if isinstance(sanitized, list):
        return [redact_payload(item) for item in sanitized]
    if isinstance(sanitized, dict):
        redacted: dict[str, Any] = {}
        for key, item in sanitized.items():
            if key == "data_base64":
                continue
            redacted[key] = redact_payload(item)
        return redacted
    return sanitized


def _compact(value: str, limit: int = 120) -> str:
    compacted = " ".join(strip_ansi(value).split())
    return f"{compacted[: limit - 3]}..." if len(compacted) > limit else compacted


def _is_machine_title(value: str) -> bool:
    normalized = value.strip().lower().replace("rollout-", "")
    if not normalized:
        return True
    if normalized in ACK_TITLES:
        return True
    machine_chars = sum(ch.isdigit() or ch in "abcdef-_:t." for ch in normalized)
    return machine_chars >= max(8, int(len(normalized) * 0.62))


def _backend_label(backend: str) -> str:
    labels = {"codex": "Codex", "claude": "Claude", "kimi": "Kimi"}
    return labels.get(backend.lower(), backend.strip().title() or "Agent")


def _title_from_runtime_ref(session: AgentSession) -> str:
    source = f"{session.runtime_session_ref} {session.session_id}"
    match = re.search(r"(?:rollout-)?(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})T(?P<hour>\d{2})-(?P<minute>\d{2})", source)
    if match:
        return f"{_backend_label(session.backend)} · {match.group('month')}-{match.group('day')} {match.group('hour')}:{match.group('minute')}"
    for value in (session.project_name, session.workspace_root.rstrip("/\\").replace("\\", "/").split("/")[-1]):
        label = value.strip()
        if label and not label.isdigit() and not _is_machine_title(label):
            return f"{label} · {session.backend}"
    return f"{_backend_label(session.backend)} session"


def _safe_session_title(session: AgentSession, preferred: str) -> str:
    if preferred and preferred != session.session_id and not _is_machine_title(preferred):
        return _compact(preferred, 120)
    for value in (session.activity_summary, session.last_message):
        if value and not _is_machine_title(value):
            return _compact(value, 80)
    return _title_from_runtime_ref(session)


def user_out(user: User) -> dict[str, Any]:
    return {"id": user.id, "email": user.email, "role": user.role, "created_at": user.created_at}


def worker_out(worker: Worker) -> dict[str, Any]:
    return {
        "space_id": worker.space_id,
        "worker_id": worker.worker_id,
        "machine_name": worker.machine_name,
        "os": worker.os,
        "connection_mode": worker.connection_mode,
        "transport_state": worker.transport_state,
        "worker_version": worker.worker_version,
        "reachable_backends": loads_json(worker.reachable_backends_json, []),
        "workspace_roots": loads_json(worker.workspace_roots_json, []),
        "capabilities": loads_json(worker.capabilities_json, {}),
        "status": worker.status,
        "last_heartbeat_at": worker.last_heartbeat_at,
        "runtime_settings": {
            "max_concurrent_jobs": worker.max_concurrent_jobs,
            "job_poll_interval_seconds": worker.job_poll_interval_seconds,
            "heartbeat_interval_seconds": worker.heartbeat_interval_seconds,
        },
    }


def session_out(session: AgentSession) -> dict[str, Any]:
    preferred_title = session.custom_title or session.llm_title or session.display_title or session.heuristic_title or session.title
    display_title = _safe_session_title(session, preferred_title)
    activity_summary = session.activity_summary or session.last_message or "当前空闲"
    return {
        "space_id": session.space_id,
        "session_id": session.session_id,
        "backend": session.backend,
        "worker_id": session.worker_id,
        "workspace_root": session.workspace_root,
        "project_name": session.project_name,
        "namespace": session.namespace,
        "mode": session.mode,
        "runtime_session_ref": session.runtime_session_ref,
        "status": session.status,
        "title": display_title,
        "display_title": display_title,
        "custom_title": session.custom_title,
        "heuristic_title": session.heuristic_title,
        "llm_title": session.llm_title,
        "activity_summary": strip_ansi(activity_summary),
        "last_message": strip_ansi(session.last_message),
        "last_activity_at": session.last_activity_at,
        "last_role": session.last_role,
        "controls": loads_json(session.controls_json, {}),
        "runtime_metadata": sanitize_text(loads_json(session.runtime_metadata_json, {})),
        "metadata": sanitize_text(loads_json(session.metadata_json, {})),
        "archived_at": session.archived_at,
        "updated_at": session.updated_at,
    }


def session_summary_out(session: AgentSession) -> dict[str, Any]:
    preferred_title = session.custom_title or session.llm_title or session.display_title or session.heuristic_title or session.title
    display_title = _safe_session_title(session, preferred_title)
    activity_summary = session.activity_summary or session.last_message or "当前空闲"
    return {
        "space_id": session.space_id,
        "session_id": session.session_id,
        "backend": session.backend,
        "worker_id": session.worker_id,
        "workspace_root": session.workspace_root,
        "project_name": session.project_name,
        "namespace": session.namespace,
        "mode": session.mode,
        "runtime_session_ref": session.runtime_session_ref,
        "status": session.status,
        "title": display_title,
        "display_title": display_title,
        "custom_title": session.custom_title,
        "heuristic_title": session.heuristic_title,
        "llm_title": session.llm_title,
        "activity_summary": strip_ansi(activity_summary),
        "last_message": strip_ansi(session.last_message),
        "last_activity_at": session.last_activity_at,
        "last_role": session.last_role,
        "controls": loads_json(session.controls_json, {}),
        "runtime_metadata": {},
        "metadata": {},
        "archived_at": session.archived_at,
        "updated_at": session.updated_at,
    }


def timeline_item_out(item: AgentTimeline) -> dict[str, Any]:
    return {
        "space_id": item.space_id,
        "session_id": item.session_id,
        "seq": item.seq,
        "item_type": item.item_type,
        "role": item.role,
        "text": strip_ansi(item.text),
        "tool_call_id": item.tool_call_id,
        "tool_name": item.tool_name,
        "status": item.status,
        "payload": sanitize_text(loads_json(item.payload_json, {})),
        "created_at": item.created_at,
    }


def permission_out(permission: AgentPermission) -> dict[str, Any]:
    return {
        "space_id": permission.space_id,
        "permission_id": permission.permission_id,
        "session_id": permission.session_id,
        "worker_id": permission.worker_id,
        "backend": permission.backend,
        "kind": permission.kind,
        "title": permission.title,
        "description": permission.description,
        "detail": loads_json(permission.detail_json, {}),
        "actions": loads_json(permission.actions_json, {}),
        "status": permission.status,
        "response": loads_json(permission.response_json, {}),
        "created_at": permission.created_at,
        "resolved_at": permission.resolved_at,
    }


def _plan_hash(plan_text: str) -> str:
    return hashlib.sha256(strip_ansi(plan_text).strip().encode("utf-8")).hexdigest()


def _matching_plan_exit_permission(db: Any, session: AgentSession, plan_text: str) -> AgentPermission | None:
    plan_hash = _plan_hash(plan_text)
    rows = (
        db.query(AgentPermission)
        .filter(AgentPermission.space_id == session.space_id)
        .filter(AgentPermission.session_id == session.session_id)
        .filter(AgentPermission.kind == "plan_exit")
        .order_by(AgentPermission.created_at.desc())
        .limit(50)
        .all()
    )
    for permission in rows:
        detail = loads_json(permission.detail_json, {})
        if not isinstance(detail, dict) or detail.get("source") != CODEX_PLAN_EXIT_SOURCE:
            continue
        if detail.get("plan_hash") == plan_hash or detail.get("plan_text") == plan_text:
            if permission.status == "expired" and detail.get("source_type") == "timeline_backfill":
                continue
            return permission
    return None


def ensure_codex_plan_exit_permission(
    db: Any,
    session: AgentSession,
    *,
    plan_text: str,
    source_type: str,
    job_id: str | None = None,
    raw_prompt: str = "",
    timeline_seq: int | None = None,
) -> AgentPermission | None:
    if session.backend.strip().lower() != "codex" or not plan_text.strip():
        return None
    existing = _matching_plan_exit_permission(db, session, plan_text)
    if existing is not None:
        if existing.status == "pending":
            session.status = "needs_reply"
            session.last_activity_at = utcnow()
            session.updated_at = session.last_activity_at
            session.last_message = plan_text or session.last_message
            session.last_role = "assistant"
            session.activity_summary = "等待你处理计划审批"
        return existing

    detail: dict[str, Any] = {
        "source": CODEX_PLAN_EXIT_SOURCE,
        "source_type": source_type,
        "raw_prompt": raw_prompt,
        "plan_text": plan_text,
        "plan_hash": _plan_hash(plan_text),
    }
    if job_id:
        detail["job_id"] = job_id
    if timeline_seq is not None:
        detail["timeline_seq"] = timeline_seq
    permission = AgentPermission(
        space_id=session.space_id,
        session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        kind="plan_exit",
        title="计划已生成",
        description="选择下一步，AgentHub 会投递到当前 Codex session。",
        detail_json=dumps_json(detail),
        actions_json=dumps_json({"choices": CODEX_PLAN_EXIT_CHOICES}),
        status="pending",
        response_json=dumps_json({}),
    )
    db.add(permission)
    db.flush()
    now = utcnow()
    session.status = "needs_reply"
    session.last_activity_at = now
    session.updated_at = now
    session.last_message = plan_text or session.last_message
    session.last_role = "assistant"
    session.activity_summary = "等待你处理计划审批"
    write_event(
        db,
        space_id=session.space_id,
        actor_type="system",
        actor_id="codex-plan-mode",
        source_type="permission",
        source_id=permission.permission_id,
        event_type="permission.request",
        payload={"session_id": session.session_id, "kind": permission.kind, "job_id": job_id, "source_type": source_type},
    )
    return permission


def _is_codex_plan_timeline_item(session: AgentSession, item: AgentTimeline) -> bool:
    if session.backend.strip().lower() != "codex":
        return False
    if item.item_type != "assistant_message":
        return False
    if item.role not in {None, "assistant"}:
        return False
    text = strip_ansi(item.text or "").strip()
    if not text:
        return False
    if re.search(r"</?\s*proposed_plan\b", text, flags=re.IGNORECASE):
        return True
    payload = loads_json(item.payload_json, {})
    if not isinstance(payload, dict):
        return False
    source = str(payload.get("source") or "").strip()
    return source in CODEX_PLAN_TIMELINE_SOURCES and (
        payload.get("reply_mode") == "plan" or payload.get("native_turn_mode") == "plan"
    )


def _timeline_sort_key(item: AgentTimeline) -> tuple[datetime, int]:
    return (item.created_at or datetime.min, item.seq)


def _timeline_item_supersedes_plan(session: AgentSession, item: AgentTimeline, plan_item: AgentTimeline) -> bool:
    if _timeline_sort_key(item) <= _timeline_sort_key(plan_item):
        return False
    if item.item_type in {"user_message", "tool_call", "error", "compaction"}:
        return True
    if item.item_type == "assistant_message" and not _is_codex_plan_timeline_item(session, item):
        return bool(strip_ansi(item.text or "").strip())
    return False


def _latest_live_codex_plan_item(session: AgentSession, items: list[AgentTimeline]) -> AgentTimeline | None:
    plans = [item for item in items if _is_codex_plan_timeline_item(session, item)]
    for plan_item in sorted(plans, key=_timeline_sort_key, reverse=True):
        if any(_timeline_item_supersedes_plan(session, item, plan_item) for item in items):
            continue
        return plan_item
    return None


def expire_superseded_pending_permissions(
    db: Any,
    session: AgentSession,
    *,
    reason: str,
    superseded_by_job_id: str | None = None,
) -> int:
    permissions = (
        db.query(AgentPermission)
        .filter(AgentPermission.space_id == session.space_id)
        .filter(AgentPermission.session_id == session.session_id)
        .filter(AgentPermission.status == "pending")
        .filter(AgentPermission.kind.in_(INTERACTION_PERMISSION_KINDS))
        .all()
    )
    if not permissions:
        return 0
    now = utcnow()
    response = {"action": "expired", "reason": reason}
    if superseded_by_job_id:
        response["superseded_by_job_id"] = superseded_by_job_id
    for permission in permissions:
        permission.status = "expired"
        permission.response_json = dumps_json(response)
        permission.resolved_at = now
        write_event(
            db,
            space_id=session.space_id,
            actor_type="system",
            actor_id="interaction-state",
            source_type="permission",
            source_id=permission.permission_id,
            event_type="permission.expire",
            payload={
                "session_id": session.session_id,
                "kind": permission.kind,
                "reason": reason,
                "superseded_by_job_id": superseded_by_job_id,
            },
        )
    return len(permissions)


def _timeline_item_supersedes_pending_interaction(session: AgentSession, item: AgentTimeline) -> bool:
    if item.item_type in {"user_message", "error"}:
        return True
    if item.item_type == "assistant_message" and not _is_codex_plan_timeline_item(session, item):
        payload = loads_json(item.payload_json, {})
        source = str(payload.get("source") or "").strip() if isinstance(payload, dict) else ""
        return source in CODEX_PLAN_TIMELINE_SOURCES and bool(strip_ansi(item.text or "").strip())
    return False


def expire_pending_permissions_superseded_by_timeline(
    db: Any,
    session: AgentSession,
    items: list[AgentTimeline],
) -> int:
    superseding_items = [item for item in items if _timeline_item_supersedes_pending_interaction(session, item)]
    if not superseding_items:
        return 0
    permissions = (
        db.query(AgentPermission)
        .filter(AgentPermission.space_id == session.space_id)
        .filter(AgentPermission.session_id == session.session_id)
        .filter(AgentPermission.status == "pending")
        .filter(AgentPermission.kind.in_(INTERACTION_PERMISSION_KINDS))
        .all()
    )
    expired = 0
    now = utcnow()
    for permission in permissions:
        if not any((item.created_at or datetime.min) >= permission.created_at for item in superseding_items):
            continue
        permission.status = "expired"
        permission.response_json = dumps_json({"action": "expired", "reason": "timeline_superseded"})
        permission.resolved_at = now
        expired += 1
        write_event(
            db,
            space_id=session.space_id,
            actor_type="system",
            actor_id="interaction-state",
            source_type="permission",
            source_id=permission.permission_id,
            event_type="permission.expire",
            payload={"session_id": session.session_id, "kind": permission.kind, "reason": "timeline_superseded"},
        )
    return expired


def _plan_exit_permission_plan_item(
    session: AgentSession,
    permission: AgentPermission,
    items: list[AgentTimeline],
) -> AgentTimeline | None:
    detail = loads_json(permission.detail_json, {})
    if not isinstance(detail, dict) or detail.get("source") != CODEX_PLAN_EXIT_SOURCE:
        return None
    timeline_seq = detail.get("timeline_seq")
    if isinstance(timeline_seq, int):
        for item in items:
            if item.seq == timeline_seq and _is_codex_plan_timeline_item(session, item):
                return item
    plan_text = str(detail.get("plan_text") or "")
    plan_hash = str(detail.get("plan_hash") or "")
    if not plan_text and not plan_hash:
        return None
    for item in items:
        if not _is_codex_plan_timeline_item(session, item):
            continue
        if plan_text and item.text == plan_text:
            return item
        if plan_hash and _plan_hash(item.text) == plan_hash:
            return item
    return None


def expire_pending_plan_exit_permissions_no_longer_waiting_on_timeline(
    db: Any,
    session: AgentSession,
    items: list[AgentTimeline],
) -> int:
    if not items:
        return 0
    permissions = (
        db.query(AgentPermission)
        .filter(AgentPermission.space_id == session.space_id)
        .filter(AgentPermission.session_id == session.session_id)
        .filter(AgentPermission.status == "pending")
        .filter(AgentPermission.kind == "plan_exit")
        .all()
    )
    if not permissions:
        return 0
    now = utcnow()
    expired = 0
    for permission in permissions:
        plan_item = _plan_exit_permission_plan_item(session, permission, items)
        if plan_item is None:
            continue
        if not any(_timeline_item_supersedes_plan(session, item, plan_item) for item in items):
            continue
        permission.status = "expired"
        permission.response_json = dumps_json({"action": "expired", "reason": "timeline_no_longer_waiting"})
        permission.resolved_at = now
        expired += 1
        write_event(
            db,
            space_id=session.space_id,
            actor_type="system",
            actor_id="interaction-state",
            source_type="permission",
            source_id=permission.permission_id,
            event_type="permission.expire",
            payload={"session_id": session.session_id, "kind": permission.kind, "reason": "timeline_no_longer_waiting"},
        )
    if expired and not _session_has_pending_interaction_permission(db, session):
        session.status = "ready"
        session.updated_at = now
        session.activity_summary = session.activity_summary if session.activity_summary != "等待你处理计划审批" else "当前空闲"
    return expired


def _session_has_pending_interaction_permission(db: Any, session: AgentSession) -> bool:
    return (
        db.query(AgentPermission.permission_id)
        .filter(AgentPermission.space_id == session.space_id)
        .filter(AgentPermission.session_id == session.session_id)
        .filter(AgentPermission.status == "pending")
        .filter(AgentPermission.kind.in_(INTERACTION_PERMISSION_KINDS))
        .first()
        is not None
    )


def reconcile_stale_plan_exit_permissions(
    db: Any,
    *,
    space_id: str | None,
    session_id: str | None = None,
    limit: int = 200,
) -> int:
    query = (
        db.query(AgentPermission)
        .filter(AgentPermission.space_id == space_id)
        .filter(AgentPermission.status == "pending")
        .filter(AgentPermission.kind == "plan_exit")
    )
    if session_id:
        query = query.filter(AgentPermission.session_id == session_id)
    query = query.order_by(AgentPermission.created_at.desc()).limit(max(1, min(limit, 500)))
    permissions = query.all()
    expired = 0
    checked_sessions: set[str] = set()
    for permission in permissions:
        if permission.session_id in checked_sessions:
            continue
        checked_sessions.add(permission.session_id)
        session = (
            db.query(AgentSession)
            .filter(AgentSession.space_id == space_id)
            .filter(AgentSession.session_id == permission.session_id)
            .one_or_none()
        )
        if session is None:
            continue
        rows = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.space_id == session.space_id)
            .filter(AgentTimeline.session_id == session.session_id)
            .order_by(AgentTimeline.created_at.desc(), AgentTimeline.seq.desc())
            .limit(500)
            .all()
        )
        expired += expire_pending_plan_exit_permissions_no_longer_waiting_on_timeline(db, session, rows)
    return expired


def ensure_codex_plan_exit_permission_from_timeline(
    db: Any,
    session: AgentSession,
    items: list[AgentTimeline],
) -> AgentPermission | None:
    latest = _latest_live_codex_plan_item(session, items)
    if latest is None:
        return None
    return ensure_codex_plan_exit_permission(
        db,
        session,
        plan_text=latest.text,
        source_type="timeline",
        timeline_seq=latest.seq,
    )


def ensure_missing_codex_plan_exit_permission_from_session_timeline(
    db: Any,
    session: AgentSession,
    *,
    source_type: str = "timeline_open",
    limit: int = 300,
) -> tuple[AgentPermission | None, int]:
    rows = (
        db.query(AgentTimeline)
        .filter(AgentTimeline.space_id == session.space_id)
        .filter(AgentTimeline.session_id == session.session_id)
        .order_by(AgentTimeline.created_at.desc(), AgentTimeline.seq.desc())
        .limit(max(1, min(limit, 500)))
        .all()
    )
    latest = _latest_live_codex_plan_item(session, rows)
    if latest is None:
        expired = expire_pending_plan_exit_permissions_no_longer_waiting_on_timeline(db, session, rows)
        return None, expired
    if _matching_plan_exit_permission(db, session, latest.text) is not None:
        return None, 0
    return ensure_codex_plan_exit_permission(
        db,
        session,
        plan_text=latest.text,
        source_type=source_type,
        timeline_seq=latest.seq,
    ), 0


def provider_snapshot_out(snapshot: ProviderSnapshot) -> dict[str, Any]:
    diagnostics = loads_json(snapshot.diagnostics_json, {})
    return {
        "space_id": snapshot.space_id,
        "worker_id": snapshot.worker_id,
        "backend": snapshot.backend,
        "status": snapshot.status,
        "auth_status": diagnostics.get("auth_status", "unknown") if isinstance(diagnostics, dict) else "unknown",
        "models": loads_json(snapshot.models_json, []),
        "modes": loads_json(snapshot.modes_json, []),
        "features": loads_json(snapshot.features_json, {}),
        "diagnostics": diagnostics,
        "fetched_at": snapshot.fetched_at,
        "updated_at": snapshot.updated_at,
    }


def _parse_created_at(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            return utcnow()
    return utcnow()


def _timeline_payload(item: Any) -> dict[str, Any]:
    if hasattr(item, "model_dump"):
        return item.model_dump()
    return item if isinstance(item, dict) else {}


def _timeline_text_key(value: Any) -> str:
    return strip_ansi(str(value or "")).strip()


def _optional_created_at(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            return None
    return None


def _timeline_job_id(payload: dict[str, Any]) -> str:
    raw_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    job_id = (raw_payload.get("job_id") or raw_payload.get("agenthub_job_id")) if isinstance(raw_payload, dict) else ""
    return str(job_id or "")


def _timeline_created_at(payload: dict[str, Any]) -> datetime | None:
    return _optional_created_at(payload.get("created_at"))


def _created_at_close_enough(left: datetime | None, right: datetime | None) -> bool:
    if left is None or right is None:
        return False
    return abs((left - right).total_seconds()) <= 600


def _preserved_session_input_rows(existing_rows: list[AgentTimeline]) -> list[dict[str, Any]]:
    preserved: list[dict[str, Any]] = []
    for row in existing_rows:
        payload = loads_json(row.payload_json, {})
        if row.item_type != "user_message":
            continue
        if not isinstance(payload, dict) or payload.get("source") != "session_input":
            continue
        preserved.append(
            {
                "item_type": row.item_type,
                "role": row.role,
                "text": row.text,
                "tool_call_id": row.tool_call_id,
                "tool_name": row.tool_name,
                "status": row.status,
                "payload": payload,
                "created_at": row.created_at,
            }
        )
    return preserved


def _pop_matching_preserved_row(payload: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    incoming_job_id = _timeline_job_id(payload)
    if incoming_job_id:
        for index, candidate in enumerate(candidates):
            if _timeline_job_id(candidate) == incoming_job_id:
                return candidates.pop(index)

    incoming_created_at = _timeline_created_at(payload)
    for index, candidate in enumerate(candidates):
        if _created_at_close_enough(incoming_created_at, _timeline_created_at(candidate)):
            return candidates.pop(index)
    return None


def _merge_replace_timeline_with_local_inputs(existing_rows: list[AgentTimeline], incoming_items: list[Any]) -> list[dict[str, Any]]:
    preserved_rows = _preserved_session_input_rows(existing_rows)
    if not preserved_rows:
        return [_timeline_payload(item) for item in incoming_items]

    preserved_by_text: dict[str, list[dict[str, Any]]] = {}
    for row in preserved_rows:
        preserved_by_text.setdefault(_timeline_text_key(row.get("text")), []).append(row)

    merged: list[dict[str, Any]] = []
    for incoming in incoming_items:
        payload = _timeline_payload(incoming)
        item_type = str(payload.get("item_type") or "")
        if item_type == "user_message":
            text_key = _timeline_text_key(payload.get("text"))
            candidates = preserved_by_text.get(text_key) or []
            preserved = _pop_matching_preserved_row(payload, candidates)
            if preserved:
                preserved_payload = preserved.get("payload") if isinstance(preserved.get("payload"), dict) else {}
                incoming_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
                payload["payload"] = {**preserved_payload, **incoming_payload}
                if not payload.get("created_at") and preserved.get("created_at") is not None:
                    payload["created_at"] = preserved["created_at"]
        merged.append(payload)

    for remaining in preserved_by_text.values():
        remaining.sort(key=lambda item: _timeline_created_at(item) or datetime.min)
        merged.extend(remaining)
    return merged


def upsert_timeline_items(
    db: Any,
    session_id: str,
    items: list[Any],
    *,
    replace: bool = False,
    space_id: str | None = None,
) -> list[AgentTimeline]:
    existing_query = db.query(AgentTimeline).filter(AgentTimeline.session_id == session_id)
    if space_id is not None:
        existing_query = existing_query.filter(AgentTimeline.space_id == space_id)
    existing_rows = existing_query.all()
    if replace:
        items = _merge_replace_timeline_with_local_inputs(existing_rows, items)
        existing_query.delete()
        db.flush()
        existing_rows = []
    existing = {item.seq: item for item in existing_rows}
    next_seq = (max(existing) + 1) if existing else 1
    saved: list[AgentTimeline] = []
    for raw in items:
        payload = _timeline_payload(raw)
        item_type = str(payload.get("item_type") or "")
        if item_type not in TIMELINE_ITEM_TYPES:
            continue
        seq_value = payload.get("seq")
        seq = int(seq_value) if isinstance(seq_value, int) or (isinstance(seq_value, str) and seq_value.isdigit()) else next_seq
        next_seq = max(next_seq, seq + 1)
        item = existing.get(seq)
        if item is None:
            item = AgentTimeline(space_id=space_id, session_id=session_id, seq=seq)
            db.add(item)
            existing[seq] = item
        elif item.space_id is None and space_id is not None:
            item.space_id = space_id
        item.item_type = item_type
        item.role = payload.get("role") if isinstance(payload.get("role"), str) else None
        item.text = strip_ansi(str(payload.get("text") or ""))
        item.tool_call_id = payload.get("tool_call_id") if isinstance(payload.get("tool_call_id"), str) else None
        item.tool_name = payload.get("tool_name") if isinstance(payload.get("tool_name"), str) else None
        item.status = payload.get("status") if isinstance(payload.get("status"), str) else None
        item.payload_json = dumps_json(payload.get("payload") if isinstance(payload.get("payload"), dict) else {})
        item.created_at = _parse_created_at(payload.get("created_at"))
        saved.append(item)
    db.flush()
    return saved


def _message_from_timeline(item: AgentTimeline) -> dict[str, Any] | None:
    if not item.text.strip():
        return None
    role = item.role
    if role is None:
        role = "assistant" if item.item_type == "assistant_message" else "user" if item.item_type == "user_message" else "system"
    return {
        "session_id": item.session_id,
        "seq": item.seq,
        "role": role,
        "text": strip_ansi(item.text),
        "created_at": item.created_at.isoformat(),
        "kind": item.item_type,
    }


def sync_session_from_timeline(db: Any, session: AgentSession) -> None:
    rows = (
        db.query(AgentTimeline)
        .filter(AgentTimeline.session_id == session.session_id)
        .filter(AgentTimeline.space_id == session.space_id)
        .order_by(AgentTimeline.seq.asc())
        .all()
    )
    if not rows:
        return
    messages = [message for row in rows if (message := _message_from_timeline(row))]
    metadata = loads_json(session.runtime_metadata_json, {})
    metadata.pop("timeline", None)
    metadata["messages"] = messages[-20:]
    session.runtime_metadata_json = dumps_json(metadata)
    last_activity = max(rows, key=lambda row: (row.created_at, row.seq))
    last_conversation = next(
        (
            message
            for message in sorted(messages, key=lambda item: (str(item.get("created_at") or ""), int(item.get("seq") or 0)), reverse=True)
            if message["role"] in {"assistant", "user"} and str(message["text"]).strip()
        ),
        messages[-1] if messages else None,
    )
    current_activity = session.last_activity_at
    timeline_is_current = current_activity is None or last_activity.created_at >= current_activity
    if timeline_is_current and last_conversation:
        session.last_message = str(last_conversation["text"])
        session.last_role = str(last_conversation["role"])
    if timeline_is_current:
        session.last_activity_at = last_activity.created_at
    if timeline_is_current and not session.activity_summary and session.last_message:
        session.activity_summary = f"最近上下文：{_compact(session.last_message)}"
    session.updated_at = utcnow()


def _job_queue_reason(job: Job, payload: dict[str, Any]) -> tuple[str | None, str | None]:
    if job.status != "queued":
        return None, None
    if payload.get("defer_until_session_ready") is True:
        return "waiting_for_session_idle", "等待当前会话空闲后自动执行"
    if job.worker_id:
        return "waiting_for_worker", "等待目标 worker 领取"
    return "waiting_for_available_worker", "等待可用 worker 领取"


def job_out(job: Job, *, include_private_payload: bool = False) -> dict[str, Any]:
    raw_payload = loads_json(job.payload_json, {})
    payload = sanitize_text(raw_payload) if include_private_payload else redact_payload(raw_payload)
    queue_reason, queue_reason_text = _job_queue_reason(job, payload)
    return {
        "space_id": job.space_id,
        "job_id": job.job_id,
        "kind": job.kind,
        "target_session_id": job.target_session_id,
        "worker_id": job.worker_id,
        "backend": job.backend,
        "workspace_root": job.workspace_root,
        "namespace": job.namespace,
        "priority": job.priority,
        "status": job.status,
        "queue_reason": queue_reason,
        "queue_reason_text": queue_reason_text,
        "payload": payload,
        "result_text": strip_ansi(job.result_text or "") if job.result_text is not None else None,
        "error_text": strip_ansi(job.error_text or "") if job.error_text is not None else None,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


def job_summary_out(job: Job, *, include_private_payload: bool = False) -> dict[str, Any]:
    raw_payload = loads_json(job.payload_json, {})
    payload = sanitize_text(raw_payload) if include_private_payload else redact_payload(raw_payload)
    queue_reason, queue_reason_text = _job_queue_reason(job, payload)
    return {
        "space_id": job.space_id,
        "job_id": job.job_id,
        "kind": job.kind,
        "target_session_id": job.target_session_id,
        "worker_id": job.worker_id,
        "backend": job.backend,
        "workspace_root": job.workspace_root,
        "namespace": job.namespace,
        "priority": job.priority,
        "status": job.status,
        "queue_reason": queue_reason,
        "queue_reason_text": queue_reason_text,
        "payload": payload,
        "result_text": None,
        "error_text": _compact(job.error_text or "", 400) if job.error_text is not None else None,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


def event_out(event: Event) -> dict[str, Any]:
    return {
        "space_id": event.space_id,
        "event_id": event.event_id,
        "actor_type": event.actor_type,
        "actor_id": event.actor_id,
        "source_type": event.source_type,
        "source_id": event.source_id,
        "event_type": event.event_type,
        "level": event.level,
        "payload": loads_json(event.payload_json, {}),
        "created_at": event.created_at,
    }


def memory_out(memory: Memory) -> dict[str, Any]:
    return {
        "space_id": memory.space_id,
        "namespace": memory.namespace,
        "observation": memory.observation,
        "source": memory.source,
        "project_name": memory.project_name,
        "backend": memory.backend,
        "created_by": memory.created_by,
        "created_at": memory.created_at,
    }


def secret_out(secret: Any) -> dict[str, Any]:
    return {
        "secret_id": secret.secret_id,
        "namespace": secret.namespace,
        "environment": secret.environment,
        "name": secret.name,
        "description": secret.description,
        "has_value": secret.revoked_at is None and bool(secret.value_ciphertext),
        "created_at": secret.created_at,
        "updated_at": secret.updated_at,
        "revoked_at": secret.revoked_at,
    }


class DoubaoAsrFacade:
    SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
    QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"
    FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo"
    STS_SUCCESS_KEYS = ("jwt_token", "token")
    PENDING_STATUS_CODES = {"20000001", "20000002"}
    SUCCESS_STATUS_CODES = {"", "0", "20000000"}

    async def transcribe_audio_bytes(
        self,
        audio_bytes: bytes,
        *,
        audio_format: str,
        language: str | None = None,
    ) -> str:
        settings = get_settings()
        api_key = settings.doubao_asr_api_key.strip()
        app_key = settings.doubao_asr_app_key.strip()
        access_key = settings.doubao_asr_access_key.strip()
        resource_id = settings.doubao_asr_resource_id.strip() or "volc.seedasr.auc"
        if not api_key and not (app_key and access_key):
            raise RuntimeError("Doubao ASR credentials are not configured")
        if resource_id == self.FLASH_RESOURCE_ID:
            try:
                return await self._transcribe_flash(
                    audio_bytes,
                    audio_format=audio_format,
                    language=language,
                    api_key=api_key,
                    app_key=app_key,
                    access_key=access_key,
                    endpoint=settings.doubao_asr_endpoint,
                    resource_id=resource_id,
                )
            except Exception:
                if not (app_key and access_key):
                    raise
                return await self._transcribe_submit_query(
                    audio_bytes,
                    audio_format=audio_format,
                    language=language,
                    api_key="",
                    app_key=app_key,
                    access_key=access_key,
                    resource_id="volc.bigasr.auc",
                )
        return await self._transcribe_submit_query(
            audio_bytes,
            audio_format=audio_format,
            language=language,
            api_key=api_key,
            app_key=app_key,
            access_key=access_key,
            resource_id=resource_id,
        )

    def _auth_headers(self, *, api_key: str, app_key: str, access_key: str) -> dict[str, str]:
        if api_key:
            return {"X-Api-Key": api_key}
        return {"X-Api-App-Key": app_key, "X-Api-Access-Key": access_key}

    def _raise_for_provider_status(self, response: httpx.Response, *, action: str) -> None:
        api_status = response.headers.get("X-Api-Status-Code", "")
        if api_status in self.SUCCESS_STATUS_CODES:
            return
        api_message = response.headers.get("X-Api-Message", "").strip()
        suffix = f": {api_message}" if api_message else ""
        raise RuntimeError(f"Doubao ASR {action} status: {api_status}{suffix}")

    async def _transcribe_flash(
        self,
        audio_bytes: bytes,
        *,
        audio_format: str,
        language: str | None,
        api_key: str,
        app_key: str,
        access_key: str,
        endpoint: str,
        resource_id: str,
    ) -> str:
        request_id = str(uuid.uuid4())
        headers = {
            "Content-Type": "application/json",
            "X-Api-Request-Id": request_id,
            "X-Api-Resource-Id": resource_id,
            "X-Api-Sequence": "-1",
        }
        if api_key:
            headers["X-Api-Key"] = api_key
        else:
            headers["X-Api-App-Key"] = app_key
            headers["X-Api-Access-Key"] = access_key
        audio: dict[str, str] = {
            "format": audio_format,
            "data": base64.b64encode(audio_bytes).decode("ascii"),
        }
        if language:
            audio["language"] = language
        payload = {
            "user": {"uid": api_key or app_key or "agenthub"},
            "audio": audio,
            "request": {"model_name": "bigmodel", "enable_itn": True, "enable_punc": True, "enable_ddc": True},
        }
        async with httpx.AsyncClient(timeout=90.0) as client:
            response = await client.post(endpoint, json=payload, headers=headers)
            response.raise_for_status()
        api_status = response.headers.get("X-Api-Status-Code")
        if api_status and api_status not in {"0", "20000000"}:
            raise RuntimeError(f"Doubao ASR status: {api_status}")
        return self._extract_text(response.json())

    async def _transcribe_submit_query(
        self,
        audio_bytes: bytes,
        *,
        audio_format: str,
        language: str | None,
        api_key: str,
        app_key: str,
        access_key: str,
        resource_id: str,
    ) -> str:
        request_id = str(uuid.uuid4())
        headers = {
            "Content-Type": "application/json",
            "X-Api-Resource-Id": resource_id,
            "X-Api-Request-Id": request_id,
            "X-Api-Sequence": "-1",
        }
        headers.update(self._auth_headers(api_key=api_key, app_key=app_key, access_key=access_key))
        audio: dict[str, str] = {
            "format": audio_format,
            "data": base64.b64encode(audio_bytes).decode("ascii"),
        }
        if language:
            audio["language"] = language
        payload = {
            "user": {"uid": "agenthub"},
            "audio": audio,
            "request": {"model_name": "bigmodel", "enable_itn": True, "enable_punc": True},
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=60, write=60, pool=30)) as client:
            submit_response = await client.post(self.SUBMIT_URL, json=payload, headers=headers)
            submit_response.raise_for_status()
            self._raise_for_provider_status(submit_response, action="submit")
            query_headers = {
                "Content-Type": "application/json",
                "X-Api-Resource-Id": resource_id,
                "X-Api-Request-Id": request_id,
            }
            query_headers.update(self._auth_headers(api_key=api_key, app_key=app_key, access_key=access_key))
            for _ in range(60):
                await asyncio.sleep(3)
                query_response = await client.post(self.QUERY_URL, json={}, headers=query_headers)
                query_response.raise_for_status()
                api_status = query_response.headers.get("X-Api-Status-Code", "")
                if api_status in self.PENDING_STATUS_CODES:
                    continue
                self._raise_for_provider_status(query_response, action="query")
                return self._extract_text(query_response.json())
        raise RuntimeError("Doubao ASR timed out")

    def _extract_text(self, payload: dict[str, Any]) -> str:
        result = payload.get("result") if isinstance(payload, dict) else {}
        result = result if isinstance(result, dict) else {}
        utterances = result.get("utterances")
        if isinstance(utterances, list):
            text = "".join(str(item.get("text") or "") for item in utterances if isinstance(item, dict)).strip()
            if text:
                return text
        text = str(result.get("text") or payload.get("text") or "").strip()
        if not text:
            raise RuntimeError("Doubao ASR returned empty text")
        return text

    async def issue_stream_auth(self, *, uid: str) -> dict[str, Any]:
        settings = get_settings()
        app_key = settings.doubao_asr_app_key.strip()
        access_key = settings.doubao_asr_access_key.strip()
        if not app_key or not access_key:
            raise RuntimeError("Doubao streaming ASR credentials are not configured")
        headers = {
            "Authorization": f"Bearer; {access_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "appid": app_key,
            "duration": settings.doubao_stream_token_duration_seconds,
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(settings.doubao_asr_sts_endpoint, json=payload, headers=headers)
            response.raise_for_status()
        body = response.json() if response.content else {}
        token = ""
        if isinstance(body, dict):
            for key in self.STS_SUCCESS_KEYS:
                value = body.get(key)
                if isinstance(value, str) and value.strip():
                    token = value.strip()
                    break
        if not token:
            raise RuntimeError("Doubao streaming ASR token response was empty")
        return {
            "url": settings.doubao_stream_asr_url,
            "auth": {
                "api_resource_id": settings.doubao_stream_asr_resource_id.strip() or "volc.bigasr.sauc.duration",
                "api_app_key": app_key,
                "api_access_key": f"Jwt; {token}",
            },
            "config": {
                "user": {"uid": uid},
                "audio": {
                    "format": "pcm",
                    "rate": 16000,
                    "bits": 16,
                    "channel": 1,
                },
                "request": {
                    "model_name": "bigmodel",
                    "show_utterances": True,
                    "enable_itn": True,
                    "enable_punc": True,
                    "enable_ddc": True,
                },
            },
            "expires_in_seconds": settings.doubao_stream_token_duration_seconds,
        }


doubao_asr = DoubaoAsrFacade()


class OpenAIWhisperAsrFacade:
    async def transcribe_audio_bytes(
        self,
        audio_bytes: bytes,
        *,
        filename: str,
        content_type: str,
        language: str | None = None,
        api_key: str,
        base_url: str,
        model: str,
    ) -> str:
        key = api_key.strip()
        if not key:
            raise RuntimeError("OpenAI-compatible ASR credentials are not configured")
        normalized_base_url = (base_url or "https://api.openai.com/v1").strip().rstrip("/")
        url = f"{normalized_base_url}/audio/transcriptions"
        data = {"model": (model or "whisper-1").strip() or "whisper-1"}
        if language:
            data["language"] = language
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=90, write=90, pool=30)) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {key}"},
                files={"file": (filename, audio_bytes, content_type)},
                data=data,
            )
            response.raise_for_status()
        payload = response.json() if response.content else {}
        text = str(payload.get("text") or "").strip() if isinstance(payload, dict) else ""
        if not text:
            raise RuntimeError("OpenAI-compatible ASR returned empty text")
        return text


openai_asr = OpenAIWhisperAsrFacade()


def schedule_out(schedule: Schedule) -> dict[str, Any]:
    return {
        "space_id": schedule.space_id,
        "schedule_id": schedule.schedule_id,
        "name": schedule.name,
        "job_kind": schedule.job_kind,
        "enabled": schedule.enabled,
        "interval_seconds": schedule.interval_seconds,
        "target_worker_id": schedule.target_worker_id,
        "backend": schedule.backend,
        "namespace": schedule.namespace,
        "payload": loads_json(schedule.payload_json, {}),
        "last_run_at": schedule.last_run_at,
        "next_run_at": schedule.next_run_at,
        "created_at": schedule.created_at,
        "updated_at": schedule.updated_at,
    }
