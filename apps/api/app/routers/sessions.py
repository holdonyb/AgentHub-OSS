from __future__ import annotations

import base64
import binascii
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case
from sqlalchemy.orm import load_only

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role
from app.core.config import get_settings
from app.core.job_recovery import recover_stale_running_jobs_for_space
from app.core.json import dumps_json, loads_json
from app.models import AgentPermission, AgentSession, AgentTimeline, Job, ProviderSnapshot, Worker, utcnow
from app.schemas import (
    SessionBtwIn,
    SessionControlsIn,
    SessionCreateIn,
    SessionFastToggleIn,
    SessionFileListIn,
    SessionFileCreateIn,
    SessionFileMkdirIn,
    SessionFileReadIn,
    SessionFileRenameIn,
    SessionFileUploadIn,
    SessionFileWriteIn,
    SessionForkIn,
    SessionInputIn,
    SessionRenameIn,
    SessionStartIn,
)
from app.services import (
    SESSION_STATES,
    expire_superseded_pending_permissions,
    job_out,
    session_summary_out,
    session_out,
    strip_ansi,
    sync_session_from_timeline,
    upsert_timeline_items,
)

router = APIRouter()
ACK_TITLES = {"ok", "okay", "好", "好的", "可以", "行", "继续", "继续吧", "收到", "回复了"}
HANDOFF_TIMELINE_TYPES = {"user_message", "assistant_message", "compaction", "error"}
HANDOFF_CONTEXT_LIMIT = 16
PLAN_OPTIONS_MARKER = "AGENTHUB_OPTIONS:"
ALLOWED_IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
ALLOWED_ATTACHMENT_TYPES = {
    *ALLOWED_IMAGE_TYPES.keys(),
    "application/json",
    "application/octet-stream",
    "application/pdf",
    "application/x-zip-compressed",
    "application/xml",
    "application/zip",
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/xml",
}
UNSUPPORTED_VIRTUAL_SESSION_SOURCES = {"autopilot_cockpit"}

SESSION_LIST_LOAD_ONLY = (
    AgentSession.space_id,
    AgentSession.session_id,
    AgentSession.backend,
    AgentSession.worker_id,
    AgentSession.workspace_root,
    AgentSession.project_name,
    AgentSession.namespace,
    AgentSession.mode,
    AgentSession.runtime_session_ref,
    AgentSession.status,
    AgentSession.title,
    AgentSession.display_title,
    AgentSession.custom_title,
    AgentSession.heuristic_title,
    AgentSession.llm_title,
    AgentSession.activity_summary,
    AgentSession.last_message,
    AgentSession.last_activity_at,
    AgentSession.last_role,
    AgentSession.controls_json,
    AgentSession.archived_at,
    AgentSession.updated_at,
)


def _is_machine_title(value: str) -> bool:
    normalized = value.strip().lower().replace("rollout-", "")
    if not normalized:
        return True
    if normalized in ACK_TITLES:
        return True
    machine_chars = sum(ch.isdigit() or ch in "abcdef-_" for ch in normalized)
    return machine_chars >= max(12, int(len(normalized) * 0.65))


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _workspace_label(workspace_root: str) -> str:
    normalized = workspace_root.rstrip("/\\")
    if not normalized:
        return "workspace"
    return normalized.replace("\\", "/").split("/")[-1] or "workspace"


def _session_runtime_source(session: AgentSession) -> str:
    runtime_metadata = loads_json(session.runtime_metadata_json, {})
    if isinstance(runtime_metadata, dict):
        source = str(runtime_metadata.get("source") or "").strip()
        if source:
            return source
    metadata = loads_json(session.metadata_json, {})
    if isinstance(metadata, dict):
        source = str(metadata.get("source") or "").strip()
        if source:
            return source
    return ""


def _reject_unsupported_virtual_session(session: AgentSession, *, action: str) -> None:
    source = _session_runtime_source(session)
    if source not in UNSUPPORTED_VIRTUAL_SESSION_SOURCES:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "message": f"This {action} target is a virtual AgentHub session and cannot be resumed from the OSS runtime",
            "code": "UNSUPPORTED_VIRTUAL_SESSION",
            "source": source,
            "action": action,
        },
    )


def _runtime_title(payload: SessionCreateIn) -> str | None:
    source = f"{payload.runtime_session_ref} {payload.session_id}"
    match = re.search(r"(?:rollout-)?(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})T(?P<hour>\d{2})-(?P<minute>\d{2})", source)
    if not match:
        return None
    backend = payload.backend.strip().title() or "Agent"
    return f"{backend} · {match.group('month')}-{match.group('day')} {match.group('hour')}:{match.group('minute')}"


def _readable_title(payload: SessionCreateIn) -> str:
    for value in (payload.heuristic_title, payload.display_title, payload.title, payload.last_message):
        title = " ".join(value.strip().split())
        if title and not _is_machine_title(title):
            return title[:120]
    runtime_title = _runtime_title(payload)
    if runtime_title:
        return runtime_title
    project = payload.project_name.strip() or _workspace_label(payload.workspace_root)
    backend = payload.backend.strip() or "agent"
    return f"{project} · {backend}"


def _session_visibility_fingerprint(session: AgentSession) -> tuple[object, ...]:
    return (
        session.space_id,
        session.backend,
        session.worker_id,
        session.workspace_root,
        session.project_name,
        session.namespace,
        session.mode,
        session.runtime_session_ref,
        session.status,
        session.title,
        session.display_title,
        session.custom_title,
        session.heuristic_title,
        session.llm_title,
        session.activity_summary,
        session.last_message,
        session.last_activity_at,
        session.last_role,
        session.controls_json,
        session.archived_at,
    )


def _session_ordering():
    attention_rank = case(
        (AgentSession.status == "needs_reply", 0),
        (AgentSession.status == "running", 1),
        (AgentSession.status == "queued", 2),
        else_=3,
    )
    return (
        attention_rank.asc(),
        AgentSession.last_activity_at.is_(None).asc(),
        AgentSession.last_activity_at.desc(),
        AgentSession.updated_at.desc(),
    )


def _raise_dispatch_failure(
    db: DbSession,
    *,
    space_id: str | None,
    worker_id: str,
    backend: str,
    reason: str,
    message: str,
    code: str,
    actor: Actor | None = None,
    action: str = "worker_job_dispatch",
    session_id: str | None = None,
    workspace_root: str | None = None,
) -> None:
    write_event(
        db,
        space_id=space_id,
        actor_type=actor.actor_type if actor else "system",
        actor_id=actor.actor_id if actor else "dispatch-guard",
        source_type="worker",
        source_id=worker_id,
        event_type="job.dispatch_failed",
        level="warning",
        payload={
            "type": "dispatch_failed",
            "worker_id": worker_id,
            "job_id": None,
            "reason": reason,
            "code": code,
            "action": action,
            "backend": backend,
            "session_id": session_id,
            "workspace_root": workspace_root,
        },
    )
    db.commit()
    raise HTTPException(status_code=409, detail={"message": message, "code": code})


def _require_worker_backend_available(
    db: DbSession,
    space_id: str | None,
    worker_id: str,
    backend: str,
    *,
    actor: Actor | None = None,
    action: str = "worker_job_dispatch",
    session_id: str | None = None,
    workspace_root: str | None = None,
) -> Worker:
    worker = db.query(Worker).filter(Worker.space_id == space_id, Worker.worker_id == worker_id).one_or_none()
    if worker is None:
        _raise_dispatch_failure(
            db,
            space_id=space_id,
            worker_id=worker_id,
            backend=backend,
            reason="worker_unavailable",
            message="Worker is not registered",
            code="WORKER_UNAVAILABLE",
            actor=actor,
            action=action,
            session_id=session_id,
            workspace_root=workspace_root,
        )
    if worker.status == "offline":
        _raise_dispatch_failure(
            db,
            space_id=space_id,
            worker_id=worker_id,
            backend=backend,
            reason="worker_offline",
            message="Worker is offline",
            code="WORKER_OFFLINE",
            actor=actor,
            action=action,
            session_id=session_id,
            workspace_root=workspace_root,
        )
    reachable_backends = {
        str(backend).strip().lower()
        for backend in loads_json(worker.reachable_backends_json, [])
        if str(backend).strip()
    }
    if backend.strip().lower() not in reachable_backends:
        _raise_dispatch_failure(
            db,
            space_id=space_id,
            worker_id=worker_id,
            backend=backend,
            reason="worker_backend_unavailable",
            message=f"Worker {worker_id} cannot run {backend}",
            code="WORKER_BACKEND_UNAVAILABLE",
            actor=actor,
            action=action,
            session_id=session_id,
            workspace_root=workspace_root,
        )
    return worker


def _require_worker_backend(
    db: DbSession,
    session: AgentSession,
    *,
    actor: Actor | None = None,
    action: str = "worker_job_dispatch",
) -> None:
    _require_worker_backend_available(
        db,
        session.space_id,
        session.worker_id,
        session.backend,
        actor=actor,
        action=action,
        session_id=session.session_id,
        workspace_root=session.workspace_root,
    )


def _require_codex_native_fast(db: DbSession, session: AgentSession) -> None:
    _require_worker_backend(db, session)
    if session.backend.strip().lower() != "codex":
        raise HTTPException(
            status_code=409,
            detail={"message": "Native fast mode is only available for Codex sessions", "code": "FAST_MODE_UNAVAILABLE"},
        )


def _active_session_input_job_status(db: DbSession, session_id: str, space_id: str | None) -> str | None:
    row = (
        db.query(Job.status)
        .filter(Job.space_id == space_id)
        .filter(Job.target_session_id == session_id)
        .filter(Job.kind == "session_input")
        .filter(Job.status.in_(["running", "queued"]))
        .order_by(case((Job.status == "running", 0), else_=1).asc(), Job.updated_at.desc())
        .first()
    )
    return row[0] if row is not None else None

def _session_has_pending_permission(db: DbSession, session_id: str, space_id: str | None) -> bool:
    return (
        db.query(AgentPermission.permission_id)
        .filter(AgentPermission.space_id == space_id)
        .filter(AgentPermission.session_id == session_id)
        .filter(AgentPermission.status == "pending")
        .first()
        is not None
    )


def _merged_discovered_status(db: DbSession, session: AgentSession, discovered_status: str) -> str:
    if _session_has_pending_permission(db, session.session_id, session.space_id):
        return "needs_reply"
    active_input_status = _active_session_input_job_status(db, session.session_id, session.space_id)
    if active_input_status:
        return active_input_status
    return discovered_status


def _session_runtime_busy(session: AgentSession) -> bool:
    if session.status != "running":
        return False
    if session.last_activity_at is None:
        return True
    runtime_busy_seconds = max(get_settings().claimed_job_stale_seconds * 2, 1800)
    return session.last_activity_at + timedelta(seconds=runtime_busy_seconds) > utcnow()


def _handoff_text(value: str, limit: int = 1200) -> str:
    compacted = " ".join(strip_ansi(value).split())
    return f"{compacted[: limit - 3]}..." if len(compacted) > limit else compacted


def _session_handoff_context(db: DbSession, session: AgentSession) -> dict[str, object]:
    rows = (
        db.query(AgentTimeline)
        .filter(AgentTimeline.space_id == session.space_id)
        .filter(AgentTimeline.session_id == session.session_id)
        .filter(AgentTimeline.item_type.in_(HANDOFF_TIMELINE_TYPES))
        .filter(AgentTimeline.text != "")
        .order_by(AgentTimeline.seq.desc())
        .limit(HANDOFF_CONTEXT_LIMIT)
        .all()
    )
    timeline: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in reversed(rows):
        text = _handoff_text(row.text)
        if not text:
            continue
        role = row.role or ("assistant" if row.item_type == "assistant_message" else "user" if row.item_type == "user_message" else "system")
        key = (row.item_type, role, text)
        if key in seen:
            continue
        seen.add(key)
        timeline.append(
            {
                "seq": row.seq,
                "item_type": row.item_type,
                "role": role,
                "text": text,
            }
        )
    return {
        "session_id": session.session_id,
        "backend": session.backend,
        "worker_id": session.worker_id,
        "workspace_root": session.workspace_root,
        "project_name": session.project_name,
        "title": _handoff_text(session.custom_title or session.display_title or session.heuristic_title or session.title or session.session_id, 160),
        "activity_summary": _handoff_text(session.activity_summary or session.last_message or "", 1200),
        "last_message": _handoff_text(session.last_message or "", 1200),
        "timeline": timeline,
    }


def _plan_prompt(raw_prompt: str, backend: str) -> str:
    backend_label = backend.strip() or "agent"
    return (
        f"进入 AgentHub 计划模式。你正在控制 {backend_label} session。\n"
        "要求：不要修改文件，不要运行会写入的命令，不要直接执行方案。\n"
        "先用简洁步骤列出计划、风险和需要用户选择的选项。\n"
        "如果有多个可执行方向，最后必须输出下面这个标记和编号选项：\n"
        f"{PLAN_OPTIONS_MARKER}\n"
        "1. <选项一>\n"
        "2. <选项二>\n"
        "如果只有一个自然下一步，也输出：\n"
        f"{PLAN_OPTIONS_MARKER}\n"
        "1. 按这个计划执行\n"
        "2. 调整计划\n\n"
        f"用户目标：{raw_prompt}"
    )


def _is_goal_command(prompt: str) -> bool:
    text = prompt.lstrip()
    if not text.lower().startswith("/goal"):
        return False
    return len(text) == 5 or text[5].isspace()


def _goal_prompt(raw_prompt: str, backend: str) -> str:
    goal_text = raw_prompt.lstrip()[5:].strip()
    backend_label = backend.strip() or "agent"
    if not goal_text:
        return raw_prompt
    return (
        f"进入 AgentHub 目标推进模式。你正在控制 {backend_label} session。\n"
        "要求：围绕下面这个目标持续推进，优先自己完成，只有在确实缺少信息、权限或需要用户决策时再停下来。\n"
        "如果需要用户决策，明确列出你需要的选择；如果可以直接做，就直接开始做并持续推进。\n\n"
        f"目标：{goal_text}"
    )


def _controls_for_reply_mode(backend: str, controls: dict[str, object], reply_mode: str) -> dict[str, object]:
    next_controls = dict(controls)
    if reply_mode != "plan":
        return next_controls
    backend_name = backend.strip().lower()
    if backend_name == "codex":
        return next_controls
    next_controls.pop("yolo", None)
    if backend_name == "claude":
        next_controls["permission_mode"] = "plan"
    if backend_name == "opencode":
        next_controls["agent"] = "plan"
    return next_controls

NATIVE_GOAL_BACKENDS = {"codex"}


def _provider_native_goal_command(
    db: DbSession,
    *,
    space_id: str | None,
    worker_id: str,
    backend: str,
) -> bool | None:
    snapshot = (
        db.query(ProviderSnapshot)
        .filter(
            ProviderSnapshot.space_id == space_id,
            ProviderSnapshot.worker_id == worker_id,
            ProviderSnapshot.backend == backend.strip().lower(),
        )
        .one_or_none()
    )
    if snapshot is None:
        return None
    features = loads_json(snapshot.features_json, {})
    value = features.get("native_goal_command") if isinstance(features, dict) else None
    return value if isinstance(value, bool) else None


def _is_native_goal_command(db: DbSession, session: AgentSession, prompt: str) -> bool:
    if not _is_goal_command(prompt):
        return False
    runtime_value = _provider_native_goal_command(
        db,
        space_id=session.space_id,
        worker_id=session.worker_id,
        backend=session.backend,
    )
    if runtime_value is not None:
        return runtime_value
    return session.backend.strip().lower() in NATIVE_GOAL_BACKENDS


def _normalize_controls(value: dict[str, object] | None, *, backend: str | None = None) -> dict[str, object]:
    controls = dict(value) if isinstance(value, dict) else {}
    backend_name = (backend or "").strip().lower()
    if backend_name == "claude":
        permission = str(controls.get("permission_mode") or "").strip()
        legacy_approval = str(controls.get("approval_mode") or "").strip()
        if not permission and legacy_approval == "never":
            controls["permission_mode"] = "bypassPermissions"
        controls.pop("approval_mode", None)
    return controls


def _job_project_name(workspace_root: str, project_name: str | None) -> str:
    return (project_name or "").strip() or _workspace_label(workspace_root)


def _create_worker_job(
    *,
    db: DbSession,
    actor: Actor,
    kind: str,
    worker_id: str,
    backend: str,
    workspace_root: str,
    namespace: str,
    payload: dict[str, object],
    target_session_id: str | None = None,
) -> Job:
    job = Job(
        space_id=actor.space_id,
        kind=kind,
        target_session_id=target_session_id,
        worker_id=worker_id,
        backend=backend,
        workspace_root=workspace_root,
        namespace=namespace,
        payload_json=dumps_json(payload),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    return job


def upsert_session(db: DbSession, payload: SessionCreateIn, *, space_id: str | None) -> AgentSession:
    if payload.status not in SESSION_STATES:
        raise HTTPException(status_code=400, detail={"message": "Invalid session status", "code": "SESSION_STATUS_INVALID"})
    session = db.query(AgentSession).filter(AgentSession.space_id == space_id, AgentSession.session_id == payload.session_id).one_or_none()
    is_new_session = session is None
    if session is None:
        session = AgentSession(space_id=space_id, session_id=payload.session_id)
        db.add(session)
    elif session.space_id is None:
        session.space_id = space_id
    previous_visibility = None if is_new_session else _session_visibility_fingerprint(session)
    previous_activity_at = session.last_activity_at
    existing_controls = _normalize_controls(loads_json(session.controls_json, {}), backend=payload.backend)
    runtime_metadata = dict(payload.runtime_metadata)
    timeline_items = runtime_metadata.pop("timeline", [])
    session.backend = payload.backend
    session.worker_id = payload.worker_id
    session.workspace_root = payload.workspace_root
    session.project_name = payload.project_name
    session.namespace = payload.namespace
    session.mode = payload.mode
    session.runtime_session_ref = payload.runtime_session_ref
    session.status = _merged_discovered_status(db, session, payload.status)
    heuristic_title = _readable_title(payload)
    display_title = session.custom_title or payload.custom_title or payload.llm_title or heuristic_title
    if payload.custom_title:
        session.custom_title = payload.custom_title
    session.heuristic_title = heuristic_title
    session.llm_title = payload.llm_title
    session.display_title = display_title
    session.title = display_title
    incoming_activity_at = _naive_utc(payload.last_activity_at)
    should_accept_activity = previous_activity_at is None or (
        incoming_activity_at is not None and incoming_activity_at >= previous_activity_at
    )
    if should_accept_activity:
        session.activity_summary = payload.activity_summary or payload.last_message or "当前空闲"
        session.last_message = payload.last_message
        session.last_activity_at = incoming_activity_at
        session.last_role = payload.last_role or session.last_role
    elif not session.activity_summary:
        session.activity_summary = payload.activity_summary or payload.last_message or "当前空闲"
    session.controls_json = dumps_json(_normalize_controls(existing_controls or payload.controls, backend=payload.backend))
    session.runtime_metadata_json = dumps_json(runtime_metadata)
    session.metadata_json = dumps_json(payload.metadata)
    if isinstance(timeline_items, list) and timeline_items:
        upsert_timeline_items(db, session.session_id, timeline_items, replace=True, space_id=session.space_id)
        sync_session_from_timeline(db, session)
    elif is_new_session or previous_visibility != _session_visibility_fingerprint(session):
        session.updated_at = utcnow()
    return session


@router.post("/api/sessions")
def create_session(
    payload: SessionCreateIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = upsert_session(db, payload, space_id=actor.space_id)
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="session",
        source_id=session.session_id,
        event_type="session.upsert",
    )
    db.commit()
    return {"session": session_out(session)}


@router.get("/api/sessions")
def list_sessions(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    backend: str | None = None,
    project: str | None = None,
    worker: str | None = None,
    status: str | None = None,
    search: str = "",
    archived: bool = False,
):
    if recover_stale_running_jobs_for_space(db, actor.space_id):
        db.commit()
    query = db.query(AgentSession).options(load_only(*SESSION_LIST_LOAD_ONLY)).filter(AgentSession.space_id == actor.space_id)
    query = query.filter(AgentSession.archived_at.is_not(None) if archived else AgentSession.archived_at.is_(None))
    if backend:
        query = query.filter(AgentSession.backend == backend)
    if project:
        query = query.filter(AgentSession.project_name == project)
    if worker:
        query = query.filter(AgentSession.worker_id == worker)
    if status:
        query = query.filter(AgentSession.status == status)
    sessions = query.order_by(*_session_ordering()).all()
    if search.strip():
        needle = search.strip().lower()
        sessions = [
            session
            for session in sessions
            if needle
            in " ".join(
                [
                    session.custom_title or "",
                    session.display_title,
                    session.heuristic_title,
                    session.activity_summary,
                    session.project_name,
                    session.backend,
                    session.last_message,
                ]
            ).lower()
        ]
    return {"items": [session_summary_out(session) for session in sessions]}


def _require_session(db: DbSession, space_id: str | None, session_id: str) -> AgentSession:
    session = db.query(AgentSession).filter(AgentSession.space_id == space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    return session


def _set_session_archive(
    *,
    session_id: str,
    archived: bool,
    db: DbSession,
    actor: Actor,
) -> dict[str, object]:
    session = _require_session(db, actor.space_id, session_id)
    now = utcnow()
    session.archived_at = now if archived else None
    session.updated_at = now
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="session",
        source_id=session.session_id,
        event_type="session.archive" if archived else "session.unarchive",
    )
    db.commit()
    return {"session": session_out(session)}


@router.post("/api/sessions/start")
def start_session(
    payload: SessionStartIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    backend = payload.backend.strip().lower()
    workspace_root = payload.workspace_root.strip()
    _require_worker_backend_available(
        db,
        actor.space_id,
        payload.worker_id,
        backend,
        actor=actor,
        action="session_start",
        workspace_root=workspace_root,
    )
    controls = _normalize_controls(payload.controls, backend=backend)
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="session_start",
        worker_id=payload.worker_id,
        backend=backend,
        workspace_root=workspace_root,
        namespace=payload.namespace or "default",
        payload={
            "prompt": payload.prompt.strip(),
            "title": (payload.title or "").strip(),
            "controls": controls,
            "project_name": _job_project_name(workspace_root, payload.project_name),
            "namespace": payload.namespace or "default",
            "start_mode": "new",
            "timeout_seconds": get_settings().default_session_job_timeout_seconds,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="session.start",
        payload={"worker_id": payload.worker_id, "backend": backend},
    )
    db.commit()
    return {"job": job_out(job)}


@router.get("/api/sessions/{session_id}")
def get_session(session_id: str, db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    return {"session": session_out(session)}


@router.post("/api/sessions/{session_id}/fork")
def fork_session(
    session_id: str,
    payload: SessionForkIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _reject_unsupported_virtual_session(session, action="fork")
    worker_id = (payload.worker_id or session.worker_id).strip()
    backend = (payload.backend or session.backend).strip().lower()
    workspace_root = (payload.workspace_root or session.workspace_root).strip()
    namespace = (payload.namespace or session.namespace or "default").strip() or "default"
    _require_worker_backend_available(
        db,
        actor.space_id,
        worker_id,
        backend,
        actor=actor,
        action="session_fork",
        session_id=session.session_id,
        workspace_root=workspace_root,
    )
    controls = (
        _normalize_controls(payload.controls, backend=backend)
        if payload.controls is not None
        else _normalize_controls(loads_json(session.controls_json, {}), backend=backend)
    )
    handoff_context = _session_handoff_context(db, session)
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="session_fork",
        target_session_id=session.session_id,
        worker_id=worker_id,
        backend=backend,
        workspace_root=workspace_root,
        namespace=namespace,
        payload={
            "prompt": payload.prompt.strip(),
            "title": (payload.title or "").strip(),
            "controls": controls,
            "project_name": _job_project_name(workspace_root, payload.project_name or session.project_name),
            "namespace": namespace,
            "source_session_id": session.session_id,
            "source_title": handoff_context["title"],
            "runtime_session_ref": session.runtime_session_ref,
            "handoff_context": handoff_context,
            "start_mode": "fork",
            "timeout_seconds": get_settings().default_session_job_timeout_seconds,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="session.fork",
        payload={"source_session_id": session.session_id, "worker_id": worker_id, "backend": backend},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/btw")
def btw_session(
    session_id: str,
    payload: SessionBtwIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _reject_unsupported_virtual_session(session, action="btw")
    _require_worker_backend(db, session, actor=actor, action="session_btw")
    controls = (
        _normalize_controls(payload.controls, backend=session.backend)
        if payload.controls is not None
        else _normalize_controls(loads_json(session.controls_json, {}), backend=session.backend)
    )
    handoff_context = _session_handoff_context(db, session)
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="session_btw",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={
            "prompt": payload.prompt.strip(),
            "title": (payload.title or "").strip(),
            "controls": controls,
            "source_session_id": session.session_id,
            "source_title": handoff_context["title"],
            "runtime_session_ref": session.runtime_session_ref,
            "handoff_context": handoff_context,
            "timeout_seconds": get_settings().default_session_job_timeout_seconds,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="session.btw",
        payload={"source_session_id": session.session_id, "worker_id": session.worker_id, "backend": session.backend},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/list")
def list_session_files(
    session_id: str,
    payload: SessionFileListIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_list")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_list",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={"path": payload.path.strip() or "."},
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.list",
        payload={"session_id": session.session_id, "path": payload.path},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/read")
def read_session_file(
    session_id: str,
    payload: SessionFileReadIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_read")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_read",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={"path": payload.path.strip(), "max_bytes": payload.max_bytes},
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.read",
        payload={"session_id": session.session_id, "path": payload.path, "max_bytes": payload.max_bytes},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/write")
def write_session_file(
    session_id: str,
    payload: SessionFileWriteIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_write")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_write",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={
            "path": payload.path.strip(),
            "text": payload.text,
            "expected_modified_at": payload.expected_modified_at,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.write",
        payload={"session_id": session.session_id, "path": payload.path},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/upload")
def upload_session_file(
    session_id: str,
    payload: SessionFileUploadIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_upload")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_upload",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={
            "path": payload.path.strip() or ".",
            "filename": payload.filename.strip(),
            "content_type": payload.content_type.strip(),
            "data_base64": payload.data_base64,
            "overwrite": payload.overwrite,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.upload",
        payload={"session_id": session.session_id, "path": payload.path, "filename": payload.filename},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/create")
def create_session_file(
    session_id: str,
    payload: SessionFileCreateIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_create")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_create",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={"path": payload.path.strip(), "text": payload.text, "overwrite": payload.overwrite},
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.create",
        payload={"session_id": session.session_id, "path": payload.path},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/mkdir")
def mkdir_session_file(
    session_id: str,
    payload: SessionFileMkdirIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_mkdir")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_mkdir",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={"path": payload.path.strip()},
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.mkdir",
        payload={"session_id": session.session_id, "path": payload.path},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/files/rename")
def rename_session_file(
    session_id: str,
    payload: SessionFileRenameIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _require_worker_backend(db, session, actor=actor, action="file_rename")
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="file_rename",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={
            "path": payload.path.strip(),
            "new_path": payload.new_path.strip(),
            "expected_modified_at": payload.expected_modified_at,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="file.rename",
        payload={"session_id": session.session_id, "path": payload.path, "new_path": payload.new_path},
    )
    db.commit()
    return {"job": job_out(job)}


def _safe_attachment_filename(value: str, content_type: str) -> str:
    filename = value.replace("\\", "/").split("/")[-1].strip().strip(".")
    if not filename:
        filename = "upload"
    suffix = ALLOWED_IMAGE_TYPES.get(content_type, "")
    if suffix and "." not in filename:
        filename = f"{filename}{suffix}"
    return filename[:180]


def _is_valid_image_data(content_type: str, data: bytes) -> bool:
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if content_type == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    return False


def _is_allowed_attachment_type(content_type: str) -> bool:
    return content_type in ALLOWED_ATTACHMENT_TYPES or content_type.startswith("text/")


def _attachment_summaries(attachments: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        {
            "filename": str(item["filename"]),
            "content_type": str(item["content_type"]),
            "size_bytes": int(item["size_bytes"]),
        }
        for item in attachments
    ]


def _normalize_session_attachments(payload: SessionInputIn) -> list[dict[str, object]]:
    settings = get_settings()
    if len(payload.attachments) > settings.max_session_attachments:
        raise HTTPException(
            status_code=400,
            detail={
                "message": f"At most {settings.max_session_attachments} attachments are supported",
                "code": "ATTACHMENT_LIMIT",
            },
        )
    normalized: list[dict[str, object]] = []
    for attachment in payload.attachments:
        content_type = attachment.content_type.split(";", 1)[0].strip().lower()
        if not _is_allowed_attachment_type(content_type):
            raise HTTPException(status_code=400, detail={"message": "Unsupported attachment type", "code": "ATTACHMENT_TYPE"})
        try:
            data = base64.b64decode(attachment.data_base64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail={"message": "Invalid attachment data", "code": "ATTACHMENT_INVALID"}) from None
        if not data:
            raise HTTPException(status_code=400, detail={"message": "Attachment cannot be empty", "code": "ATTACHMENT_EMPTY"})
        if content_type in ALLOWED_IMAGE_TYPES and not _is_valid_image_data(content_type, data):
            raise HTTPException(status_code=400, detail={"message": "Invalid attachment data", "code": "ATTACHMENT_INVALID"})
        if len(data) > settings.max_session_attachment_bytes:
            raise HTTPException(status_code=413, detail={"message": "Attachment is too large", "code": "ATTACHMENT_TOO_LARGE"})
        normalized.append(
            {
                "filename": _safe_attachment_filename(attachment.filename, content_type),
                "content_type": content_type,
                "size_bytes": len(data),
                "data_base64": base64.b64encode(data).decode("ascii"),
            }
        )
    return normalized


@router.post("/api/sessions/{session_id}/input")
def send_session_input(
    session_id: str,
    payload: SessionInputIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    attachments = _normalize_session_attachments(payload)
    raw_prompt = payload.prompt.strip()
    if not raw_prompt and not attachments:
        raise HTTPException(status_code=400, detail={"message": "Prompt cannot be empty", "code": "PROMPT_EMPTY"})
    if not raw_prompt:
        image_count = sum(1 for item in attachments if str(item.get("content_type") or "").startswith("image/"))
        if image_count == len(attachments) == 1:
            raw_prompt = "请看这张图片。"
        elif image_count == len(attachments):
            raw_prompt = "请看这些图片。"
        else:
            raw_prompt = "请看这些附件。"
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    _reject_unsupported_virtual_session(session, action="session_input")
    _require_worker_backend(db, session, actor=actor, action="session_input")
    session_was_running = _session_runtime_busy(session)
    reply_mode = payload.reply_mode
    backend_name = session.backend.strip().lower()
    native_plan_mode = reply_mode == "plan" and backend_name == "codex"
    goal_command = _is_goal_command(raw_prompt)
    native_goal_command = _is_native_goal_command(db, session, raw_prompt)
    native_default_turn = backend_name == "codex" and reply_mode == "direct" and not attachments
    native_turn_mode = "default" if native_default_turn or (backend_name == "codex" and native_goal_command) else None
    if native_goal_command:
        job_prompt = raw_prompt
    elif goal_command and reply_mode != "plan":
        job_prompt = _goal_prompt(raw_prompt, session.backend)
    else:
        job_prompt = raw_prompt if native_plan_mode or reply_mode != "plan" else _plan_prompt(raw_prompt, session.backend)
    controls = _controls_for_reply_mode(
        session.backend,
        _normalize_controls(loads_json(session.controls_json, {}), backend=session.backend),
        reply_mode,
    )
    job_payload = {
        "prompt": job_prompt,
        "raw_prompt": raw_prompt,
        "reply_mode": reply_mode,
        "native_plan_mode": native_plan_mode,
        "timeout_seconds": get_settings().default_session_job_timeout_seconds,
        "controls": controls,
        "handoff_context": _session_handoff_context(db, session),
        "runtime_session_ref": session.runtime_session_ref,
        "defer_until_session_ready": session_was_running,
        "attachments": attachments,
    }
    if native_turn_mode:
        job_payload["native_turn_mode"] = native_turn_mode
    if native_goal_command:
        job_payload["native_goal_command"] = True
    job = Job(
        space_id=session.space_id,
        kind="session_input",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload_json=dumps_json(job_payload),
        created_by=actor.actor_id,
    )
    if not session_was_running:
        session.status = "queued"
    session.updated_at = utcnow()
    db.add(job)
    db.flush()
    expire_superseded_pending_permissions(
        db,
        session,
        reason="new_session_input",
        superseded_by_job_id=job.job_id,
    )
    upsert_timeline_items(
        db,
        session.session_id,
        [
            {
                "item_type": "user_message",
                "role": "user",
                "text": raw_prompt,
                "payload": {
                    "source": "session_input",
                    "job_id": job.job_id,
                    "reply_mode": reply_mode,
                    "native_plan_mode": native_plan_mode,
                    "attachments": _attachment_summaries(attachments),
                },
            }
        ],
        space_id=session.space_id,
    )
    sync_session_from_timeline(db, session)
    write_event(
        db,
        space_id=session.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.create",
        payload={"kind": job.kind, "session_id": session.session_id},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/sessions/{session_id}/fast/refresh")
def refresh_session_fast_mode(
    session_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = _require_session(db, actor.space_id, session_id)
    _require_codex_native_fast(db, session)
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="session_fast_state_refresh",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={
            "timeout_seconds": get_settings().default_session_job_timeout_seconds,
            "runtime_session_ref": session.runtime_session_ref,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="session.fast_refresh",
        payload={"session_id": session.session_id},
    )
    db.commit()
    return {"job": job_out(job), "session": session_out(session)}


@router.post("/api/sessions/{session_id}/fast")
def toggle_session_fast_mode(
    session_id: str,
    payload: SessionFastToggleIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = _require_session(db, actor.space_id, session_id)
    _require_codex_native_fast(db, session)
    job = _create_worker_job(
        db=db,
        actor=actor,
        kind="session_fast_toggle",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload={
            "enabled": payload.enabled,
            "timeout_seconds": get_settings().default_session_job_timeout_seconds,
            "runtime_session_ref": session.runtime_session_ref,
        },
    )
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="session.fast_toggle",
        payload={"session_id": session.session_id, "enabled": payload.enabled},
    )
    db.commit()
    return {"job": job_out(job), "session": session_out(session)}


@router.post("/api/sessions/{session_id}/rename")
def rename_session(
    session_id: str,
    payload: SessionRenameIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    session.custom_title = payload.custom_title.strip()
    session.display_title = session.custom_title
    session.title = session.custom_title
    session.updated_at = utcnow()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="session",
        source_id=session.session_id,
        event_type="session.rename",
    )
    db.commit()
    return {"session": session_out(session)}


@router.patch("/api/sessions/{session_id}/controls")
def update_session_controls(
    session_id: str,
    payload: SessionControlsIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    controls = _normalize_controls(loads_json(session.controls_json, {}), backend=session.backend)
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is None:
            controls.pop(key, None)
        else:
            controls[key] = value
    controls = _normalize_controls(controls, backend=session.backend)
    session.controls_json = dumps_json(controls)
    session.updated_at = utcnow()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="session",
        source_id=session.session_id,
        event_type="session.controls_update",
        payload={"keys": sorted(controls.keys())},
    )
    db.commit()
    return {"session": session_out(session)}


@router.post("/api/sessions/{session_id}/archive")
def archive_session(
    session_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _set_session_archive(session_id=session_id, archived=True, db=db, actor=actor)


@router.post("/api/sessions/{session_id}/unarchive")
def unarchive_session(
    session_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _set_session_archive(session_id=session_id, archived=False, db=db, actor=actor)


@router.post("/api/sessions/{session_id}/terminate")
def terminate_session(
    session_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    session.status = "terminated"
    session.updated_at = utcnow()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="session",
        source_id=session.session_id,
        event_type="session.terminate",
    )
    db.commit()
    return {"session": session_out(session)}
