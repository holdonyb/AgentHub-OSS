from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.core.json import dumps_json, loads_json
from app.models import AgentPermission, AgentSession, Job, utcnow
from app.routers.internal import _assert_worker_binding, _touch_session_activity
from app.schemas import PermissionRequestedIn, PermissionResolvedIn, PermissionRespondIn
from app.services import permission_out, reconcile_stale_plan_exit_permissions

router = APIRouter()

ACTION_STATUS = {
    "allow": "allowed",
    "edit_and_allow": "allowed",
    "deny": "denied",
    "answer": "answered",
}

NATIVE_TURN_PERMISSION_SOURCES = {"codex_request_user_input"}
PLAN_EXIT_SOURCES = {"codex_plan_exit"}


def _is_native_turn_permission(permission: AgentPermission) -> bool:
    detail = loads_json(permission.detail_json, {})
    return isinstance(detail, dict) and detail.get("source") in NATIVE_TURN_PERMISSION_SOURCES


def _permission_source(permission: AgentPermission) -> str:
    detail = loads_json(permission.detail_json, {})
    return str(detail.get("source") or "") if isinstance(detail, dict) else ""


def _is_plan_exit_permission(permission: AgentPermission) -> bool:
    return permission.kind == "plan_exit" or _permission_source(permission) in PLAN_EXIT_SOURCES


def _session_has_running_job(db: DbSession, session_id: str) -> bool:
    return (
        db.query(Job.job_id)
        .filter(Job.target_session_id == session_id)
        .filter(Job.status == "running")
        .first()
        is not None
    )


def _permission_answer_label(permission: AgentPermission, response: dict[str, object]) -> str:
    value = response.get("label") or response.get("choice") or response.get("value") or response.get("text")
    if isinstance(value, str) and value.strip():
        return " ".join(value.strip().split())
    choices = loads_json(permission.actions_json, {}).get("choices", [])
    choice_id = response.get("choice")
    if isinstance(choices, list) and isinstance(choice_id, str):
        for choice in choices:
            if isinstance(choice, dict) and choice.get("id") == choice_id and isinstance(choice.get("label"), str):
                return " ".join(choice["label"].strip().split())
    return "继续执行"


def _permission_answer_summary(permission: AgentPermission, response: dict[str, object]) -> str:
    answers = response.get("answers")
    if not isinstance(answers, dict):
        return _permission_answer_label(permission, response)
    detail = loads_json(permission.detail_json, {})
    questions = detail.get("questions") if isinstance(detail, dict) and isinstance(detail.get("questions"), list) else []
    question_labels: dict[str, str] = {}
    for question in questions:
        if not isinstance(question, dict):
            continue
        question_id = str(question.get("id") or "").strip()
        if not question_id:
            continue
        question_labels[question_id] = str(question.get("header") or question.get("question") or question_id).strip()
    parts: list[str] = []
    for question_id, raw_answer in answers.items():
        if not isinstance(question_id, str) or not isinstance(raw_answer, dict):
            continue
        label = _permission_answer_label(permission, raw_answer)
        parts.append(f"{question_labels.get(question_id) or question_id}：{label}")
    return "\n".join(f"- {part}" for part in parts) or _permission_answer_label(permission, response)


def _plan_exit_prompt_and_mode(response: dict[str, object]) -> tuple[str, str, bool] | None:
    choice = str(response.get("choice") or response.get("value") or "").strip()
    note = str(response.get("note") or response.get("text") or "").strip()
    if choice == "cancel":
        return None
    if choice == "clear_context_implement":
        prompt = "Clear context and implement the plan."
        reply_mode = "direct"
        native_plan_mode = False
    elif choice == "keep_planning":
        prompt = "Continue improving the plan."
        reply_mode = "plan"
        native_plan_mode = True
    else:
        prompt = "Implement the plan."
        reply_mode = "direct"
        native_plan_mode = False
    if note:
        prompt = f"{prompt}\n\nAdditional instruction from user:\n{note}"
    return prompt, reply_mode, native_plan_mode


def _enqueue_permission_answer_job(
    db: DbSession,
    session: AgentSession,
    permission: AgentPermission,
    actor: Actor,
    response: dict[str, object],
) -> Job:
    reply_mode = "direct"
    native_plan_mode = False
    native_turn_mode: str | None = None
    if _is_plan_exit_permission(permission):
        plan_exit = _plan_exit_prompt_and_mode(response)
        if plan_exit is None:
            raise ValueError("plan exit was cancelled")
        prompt, reply_mode, native_plan_mode = plan_exit
        if session.backend.strip().lower() == "codex" and _permission_source(permission) in PLAN_EXIT_SOURCES:
            native_turn_mode = "plan" if native_plan_mode else "default"
    else:
        label = _permission_answer_summary(permission, response)
        prompt = f"我选择：\n{label}\n请按这个选择继续执行。"
    payload = {
        "prompt": prompt,
        "raw_prompt": prompt,
        "reply_mode": reply_mode,
        "controls": loads_json(session.controls_json, {}),
        "handoff_context": {
            "session_id": session.session_id,
            "backend": session.backend,
            "worker_id": session.worker_id,
            "workspace_root": session.workspace_root,
            "project_name": session.project_name,
            "title": session.display_title or session.title,
            "activity_summary": session.activity_summary,
            "last_message": session.last_message,
            "timeline": [],
        },
        "runtime_session_ref": session.runtime_session_ref,
        "answered_permission_id": permission.permission_id,
    }
    if native_plan_mode:
        payload["native_plan_mode"] = True
    if native_turn_mode:
        payload["native_turn_mode"] = native_turn_mode
    job = Job(
        space_id=session.space_id,
        kind="session_input",
        target_session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        workspace_root=session.workspace_root,
        namespace=session.namespace,
        payload_json=dumps_json(payload),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    if session.status != "running":
        session.status = "queued"
    _touch_session_activity(
        session,
        message=prompt,
        role="user",
        summary="已提交审批回复，等待 worker 领取",
    )
    write_event(
        db,
        space_id=session.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.create",
        payload={"kind": job.kind, "session_id": session.session_id, "permission_id": permission.permission_id},
    )
    return job


@router.get("/api/permissions")
def list_permissions(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    status: str | None = None,
    session_id: str | None = None,
):
    if status in {None, "pending"}:
        expired = reconcile_stale_plan_exit_permissions(db, space_id=actor.space_id, session_id=session_id)
        if expired:
            db.commit()
    query = db.query(AgentPermission).filter(AgentPermission.space_id == actor.space_id)
    if status:
        query = query.filter(AgentPermission.status == status)
    if session_id:
        query = query.filter(AgentPermission.session_id == session_id)
    rows = query.order_by(AgentPermission.created_at.desc()).limit(200).all()
    return {"items": [permission_out(row) for row in rows]}


@router.post("/api/permissions/{permission_id}/respond")
def respond_permission(
    permission_id: str,
    payload: PermissionRespondIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    permission = db.query(AgentPermission).filter(AgentPermission.space_id == actor.space_id, AgentPermission.permission_id == permission_id).one_or_none()
    if permission is None:
        raise HTTPException(status_code=404, detail={"message": "Permission not found", "code": "PERMISSION_NOT_FOUND"})
    if permission.status != "pending":
        raise HTTPException(status_code=409, detail={"message": "Permission is already resolved", "code": "PERMISSION_STATE_INVALID"})
    permission.status = ACTION_STATUS[payload.action]
    permission.response_json = dumps_json({"action": payload.action, "response": payload.response})
    permission.resolved_at = utcnow()
    session = db.query(AgentSession).filter(AgentSession.space_id == actor.space_id, AgentSession.session_id == permission.session_id).one_or_none()
    continuation_job = None
    native_turn_permission = _is_native_turn_permission(permission)
    if session:
        running_native_turn = native_turn_permission and _session_has_running_job(db, session.session_id)
        if payload.action == "answer" and (permission.kind in {"question", "plan", "plan_exit", "mode"} or _is_plan_exit_permission(permission)) and not running_native_turn:
            try:
                continuation_job = _enqueue_permission_answer_job(db, session, permission, actor, payload.response)
            except ValueError:
                continuation_job = None
        has_pending = (
            db.query(AgentPermission)
            .filter(
                AgentPermission.space_id == actor.space_id,
                AgentPermission.session_id == permission.session_id,
                AgentPermission.permission_id != permission.permission_id,
                AgentPermission.status == "pending",
            )
            .count()
            > 0
        )
        if continuation_job is None and not has_pending and session.status == "needs_reply":
            session.status = "running" if native_turn_permission and _session_has_running_job(db, session.session_id) else "ready"
            _touch_session_activity(session, summary=session.activity_summary)
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="permission",
        source_id=permission.permission_id,
        event_type="permission.respond",
        payload={"action": payload.action, "status": permission.status},
    )
    db.commit()
    return {"permission": permission_out(permission)}


@router.get("/api/interactions")
def list_interactions(
    db: DbSession,
    actor: Actor = Depends(require_min_role("viewer")),
    status: str | None = None,
    session_id: str | None = None,
):
    return list_permissions(db=db, actor=actor, status=status, session_id=session_id)


@router.post("/api/interactions/{interaction_id}/respond")
def respond_interaction(
    interaction_id: str,
    payload: PermissionRespondIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    result = respond_permission(interaction_id, payload, db=db, actor=actor)
    return {"interaction": result["permission"]}


@router.get("/api/internal/permissions/{permission_id}")
def get_permission_for_worker(
    permission_id: str,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = actor.worker
    assert worker is not None
    permission = db.query(AgentPermission).filter(AgentPermission.space_id == worker.space_id, AgentPermission.permission_id == permission_id).one_or_none()
    if permission is None:
        raise HTTPException(status_code=404, detail={"message": "Permission not found", "code": "PERMISSION_NOT_FOUND"})
    if permission.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Permission is not owned by this worker", "code": "PERMISSION_WORKER_MISMATCH"})
    return {"permission": permission_out(permission)}


@router.post("/api/internal/permissions/requested")
def request_permission(
    payload: PermissionRequestedIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    session = db.query(AgentSession).filter(AgentSession.space_id == worker.space_id, AgentSession.session_id == payload.permission.session_id).one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    if session.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Session is not owned by this worker", "code": "SESSION_WORKER_MISMATCH"})
    permission_id = payload.permission.permission_id
    permission = None
    if permission_id:
        permission = db.query(AgentPermission).filter(AgentPermission.space_id == worker.space_id, AgentPermission.permission_id == permission_id).one_or_none()
    if permission is None:
        permission = AgentPermission(permission_id=permission_id or None) if permission_id else AgentPermission()
        db.add(permission)
    if permission.status != "pending" and permission.resolved_at is not None:
        raise HTTPException(status_code=409, detail={"message": "Permission is already resolved", "code": "PERMISSION_STATE_INVALID"})
    permission.space_id = worker.space_id
    permission.session_id = session.session_id
    permission.worker_id = worker.worker_id
    permission.backend = payload.permission.backend
    permission.kind = payload.permission.kind
    permission.title = payload.permission.title
    permission.description = payload.permission.description
    permission.detail_json = dumps_json(payload.permission.detail)
    permission.actions_json = dumps_json(payload.permission.actions)
    permission.status = "pending"
    permission.response_json = dumps_json({})
    permission.resolved_at = None
    session.status = "needs_reply"
    _touch_session_activity(
        session,
        message=permission.description or permission.title or session.last_message,
        role="assistant",
        summary=permission.description or permission.title or "等待你处理审批",
    )
    db.flush()
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="permission",
        source_id=permission.permission_id,
        event_type="permission.request",
        payload={"session_id": session.session_id, "kind": permission.kind},
    )
    db.commit()
    return {"permission": permission_out(permission)}


@router.post("/api/internal/permissions/{permission_id}/resolved")
def resolve_permission_from_worker(
    permission_id: str,
    payload: PermissionResolvedIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    permission = db.query(AgentPermission).filter(AgentPermission.space_id == worker.space_id, AgentPermission.permission_id == permission_id).one_or_none()
    if permission is None:
        raise HTTPException(status_code=404, detail={"message": "Permission not found", "code": "PERMISSION_NOT_FOUND"})
    if permission.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Permission is not owned by this worker", "code": "PERMISSION_WORKER_MISMATCH"})
    if permission.status != "pending":
        raise HTTPException(status_code=409, detail={"message": "Permission is already resolved", "code": "PERMISSION_STATE_INVALID"})
    permission.status = payload.status
    permission.response_json = dumps_json(payload.response)
    permission.resolved_at = utcnow()
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="permission",
        source_id=permission.permission_id,
        event_type="permission.resolve",
        payload={"status": permission.status},
    )
    db.commit()
    return {"permission": permission_out(permission)}
