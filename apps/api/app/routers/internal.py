from __future__ import annotations

import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.audit import write_event
from app.core.config import get_settings
from app.core.deps import Actor, DbSession, require_worker
from app.core.job_recovery import recover_orphaned_running_jobs, recover_stale_running_jobs
from app.core.json import dumps_json, loads_json
from app.models import AgentPermission, AgentSession, AgentTimeline, Job, Schedule, Worker, utcnow
from app.routers.sessions import upsert_session
from app.schemas import ClaimJobIn, CompleteJobIn, DiscoveredSessionsIn, FailJobIn
from app.services import ALLOWED_JOB_KINDS, ensure_codex_plan_exit_permission, job_out, sync_session_from_timeline, upsert_timeline_items
from app.task_lifecycle import project_task_job_lifecycle

router = APIRouter()
PLAN_OPTIONS_MARKER = "AGENTHUB_OPTIONS:"
PLAN_CHOICE_RE = re.compile(r"^\s*(?:[-*]|\d+[\.)、]|[A-Za-z][\.)、]|[一二三四五六七八九十]+[、\.)])\s*(?P<label>.+?)\s*$")
SIDECAR_JOB_KINDS = {
    "file_list",
    "file_read",
    "file_write",
    "file_upload",
    "file_create",
    "file_mkdir",
    "file_rename",
    "session_btw",
    "session_fast_state_refresh",
    "session_fast_toggle",
}
FAST_SESSION_JOB_KINDS = {"session_fast_state_refresh", "session_fast_toggle"}


def _assert_worker_binding(actor: Actor, worker_id: str) -> Worker:
    assert actor.worker is not None
    if actor.worker.worker_id != worker_id:
        raise HTTPException(status_code=403, detail={"message": "Worker token is bound to another worker", "code": "WORKER_ID_MISMATCH"})
    return actor.worker


def _enqueue_due_schedules(db: DbSession, worker: Worker) -> None:
    now = utcnow()
    schedules = (
        db.query(Schedule)
        .filter(Schedule.space_id == worker.space_id)
        .filter(Schedule.enabled.is_(True))
        .filter(Schedule.next_run_at.is_not(None))
        .filter(Schedule.next_run_at <= now)
        .filter((Schedule.target_worker_id == worker.worker_id) | (Schedule.target_worker_id.is_(None)))
        .order_by(Schedule.next_run_at.asc())
        .all()
    )
    for schedule in schedules:
        if schedule.job_kind not in ALLOWED_JOB_KINDS:
            schedule.enabled = False
            schedule.next_run_at = None
            schedule.updated_at = now
            write_event(
                db,
                space_id=worker.space_id,
                actor_type="system",
                actor_id="scheduler",
                source_type="schedule",
                source_id=schedule.schedule_id,
                event_type="schedule.disabled",
                level="warning",
                payload={"reason": "job_kind_not_allowed", "job_kind": schedule.job_kind},
            )
            continue

        payload = loads_json(schedule.payload_json, {})
        payload["schedule_id"] = schedule.schedule_id
        job = Job(
            space_id=worker.space_id,
            kind=schedule.job_kind,
            target_session_id=payload.get("target_session_id") if isinstance(payload.get("target_session_id"), str) else None,
            worker_id=schedule.target_worker_id or worker.worker_id,
            backend=schedule.backend,
            workspace_root=payload.get("workspace_root") if isinstance(payload.get("workspace_root"), str) else None,
            namespace=schedule.namespace,
            payload_json=dumps_json(payload),
            created_by=schedule.created_by,
        )
        db.add(job)
        db.flush()
        schedule.last_run_at = now
        schedule.next_run_at = now + timedelta(seconds=schedule.interval_seconds)
        schedule.updated_at = now
        write_event(
            db,
            space_id=worker.space_id,
            actor_type="system",
            actor_id="scheduler",
            source_type="schedule",
            source_id=schedule.schedule_id,
            event_type="schedule.enqueue",
            payload={"job_id": job.job_id, "job_kind": job.kind, "worker_id": job.worker_id},
        )


def _session_has_running_job(db: DbSession, session_id: str | None, space_id: str | None) -> bool:
    if not session_id:
        return False
    return (
        db.query(Job.job_id)
        .filter(Job.space_id == space_id)
        .filter(Job.target_session_id == session_id)
        .filter(Job.status == "running")
        .first()
        is not None
    )


def _session_is_running(db: DbSession, session_id: str | None, space_id: str | None) -> bool:
    if not session_id:
        return False
    session = db.query(AgentSession).filter(AgentSession.space_id == space_id, AgentSession.session_id == session_id).one_or_none()
    if session is None or session.status != "running":
        return False
    if session.last_activity_at is None:
        return True
    runtime_busy_seconds = max(get_settings().claimed_job_stale_seconds * 2, 1800)
    return session.last_activity_at + timedelta(seconds=runtime_busy_seconds) > utcnow()


def _job_is_claimable(db: DbSession, job: Job) -> bool:
    if job.kind not in SIDECAR_JOB_KINDS and _session_has_running_job(db, job.target_session_id, job.space_id):
        return False
    if job.kind == "session_input" and _session_is_running(db, job.target_session_id, job.space_id):
        return False
    return True


def _job_updates_target_session(job: Job) -> bool:
    return job.kind == "session_input"


def _job_updates_runtime_metadata(job: Job) -> bool:
    return job.kind in FAST_SESSION_JOB_KINDS


def _touch_session_activity(
    session: AgentSession,
    *,
    at: datetime | None = None,
    message: str | None = None,
    role: str | None = None,
    summary: str | None = None,
) -> datetime:
    touched_at = at or utcnow()
    session.last_activity_at = touched_at
    session.updated_at = touched_at
    if message is not None:
        session.last_message = message
    if role is not None:
        session.last_role = role
    if summary is not None:
        session.activity_summary = summary
    return touched_at


def _attach_btw_result(db: DbSession, job: Job, session: AgentSession, result_text: str) -> None:
    payload = loads_json(job.payload_json, {})
    if not isinstance(payload, dict):
        payload = {}
    prompt = payload.get("prompt") if isinstance(payload.get("prompt"), str) else ""
    upsert_timeline_items(
        db,
        session.session_id,
        [
            {
                "item_type": "assistant_message",
                "role": "assistant",
                "text": result_text,
                "payload": {
                    "source": "btw",
                    "job_id": job.job_id,
                    "prompt": prompt,
                },
            }
        ],
        space_id=session.space_id,
    )
    sync_session_from_timeline(db, session)


def _update_fast_mode_runtime_metadata(session: AgentSession, job: Job, result_text: str, *, at: datetime) -> None:
    payload = loads_json(result_text, {})
    if not isinstance(payload, dict):
        payload = {}
    current = loads_json(session.runtime_metadata_json, {})
    if not isinstance(current, dict):
        current = {}
    fast_mode = {
        "state": str(payload.get("state") or "unknown"),
        "service_tier": payload.get("service_tier"),
        "reasoning_effort": payload.get("reasoning_effort"),
        "raw": payload.get("raw") if isinstance(payload.get("raw"), dict) else {},
        "job_id": job.job_id,
        "observed_at": at.isoformat().replace("+00:00", "Z"),
        "supported": session.backend.strip().lower() == "codex",
    }
    current["fast_mode"] = fast_mode
    session.runtime_metadata_json = dumps_json(current)
    session.updated_at = at


def _recover_stale_running_jobs(db: DbSession, worker_id: str, space_id: str | None = None) -> int:
    return recover_stale_running_jobs(db, worker_id, space_id)


def _recover_orphaned_running_jobs(db: DbSession, worker_id: str, space_id: str | None, active_job_ids: list[str]) -> int:
    return recover_orphaned_running_jobs(db, worker_id, space_id, active_job_ids)


def _compact_choice_label(value: str, limit: int = 120) -> str:
    label = re.sub(r"^[`*_~\s]+|[`*_~\s]+$", "", " ".join(value.split()))
    return f"{label[: limit - 1]}…" if len(label) > limit else label


def _extract_plan_choices(result_text: str) -> list[dict[str, str]]:
    lines = result_text.splitlines()
    marker_index = next((index for index, line in enumerate(lines) if PLAN_OPTIONS_MARKER in line), -1)
    candidate_lines = lines[marker_index + 1 :] if marker_index >= 0 else []
    choices: list[dict[str, str]] = []
    for line in candidate_lines:
        if len(choices) >= 6:
            break
        match = PLAN_CHOICE_RE.match(line)
        if match is None:
            if choices and line.strip():
                break
            continue
        label = _compact_choice_label(match.group("label"))
        if not label:
            continue
        choices.append({"id": f"choice_{len(choices) + 1}", "label": label})
    return choices or [
        {"id": "execute", "label": "按这个计划执行"},
        {"id": "revise", "label": "调整计划"},
    ]


def _ensure_plan_result_timeline_item(db: DbSession, job: Job, session: AgentSession, result_text: str) -> None:
    if not result_text.strip():
        return
    payload = loads_json(job.payload_json, {})
    if not isinstance(payload, dict) or payload.get("reply_mode") != "plan":
        return
    existing = (
        db.query(AgentTimeline)
        .filter(AgentTimeline.space_id == session.space_id)
        .filter(AgentTimeline.session_id == session.session_id)
        .filter(AgentTimeline.item_type == "assistant_message")
        .filter(AgentTimeline.role == "assistant")
        .filter(AgentTimeline.text == result_text)
        .first()
    )
    if existing is not None:
        return
    upsert_timeline_items(
        db,
        session.session_id,
        [
            {
                "item_type": "assistant_message",
                "role": "assistant",
                "text": result_text,
                "payload": {
                    "source": "job_complete_plan_result",
                    "job_id": job.job_id,
                    "reply_mode": "plan",
                    "native_plan_mode": payload.get("native_plan_mode") is True,
                },
            }
        ],
        space_id=session.space_id,
    )
    sync_session_from_timeline(db, session)


def _create_plan_choice_permission(db: DbSession, job: Job, session: AgentSession, result_text: str) -> bool:
    payload = loads_json(job.payload_json, {})
    if not isinstance(payload, dict) or payload.get("reply_mode") != "plan":
        return False
    if payload.get("native_plan_mode") is True:
        permission = ensure_codex_plan_exit_permission(
            db,
            session,
            plan_text=result_text,
            source_type="job",
            job_id=job.job_id,
            raw_prompt=payload.get("raw_prompt") if isinstance(payload.get("raw_prompt"), str) else "",
        )
        return permission is not None and permission.status == "pending"
    permission = AgentPermission(
        space_id=session.space_id,
        session_id=session.session_id,
        worker_id=session.worker_id,
        backend=session.backend,
        kind="question",
        title="选择下一步执行方式",
        description="计划已生成，选择一个方向后 AgentHub 会继续投递到当前 session。",
        detail_json=dumps_json(
            {
                "source": "plan_result",
                "job_id": job.job_id,
                "raw_prompt": payload.get("raw_prompt") if isinstance(payload.get("raw_prompt"), str) else "",
            }
        ),
        actions_json=dumps_json({"choices": _extract_plan_choices(result_text)}),
        status="pending",
        response_json=dumps_json({}),
    )
    db.add(permission)
    db.flush()
    session.status = "needs_reply"
    _touch_session_activity(
        session,
        message=result_text or session.last_message,
        role="assistant",
        summary="等待你选择下一步执行方式",
    )
    write_event(
        db,
        space_id=session.space_id,
        actor_type="system",
        actor_id="plan-mode",
        source_type="permission",
        source_id=permission.permission_id,
        event_type="permission.request",
        payload={"session_id": session.session_id, "kind": permission.kind, "job_id": job.job_id},
    )
    return True


@router.post("/api/internal/jobs/claim")
def claim_job(
    payload: ClaimJobIn,
    response: Response,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    if worker.status == "offline":
        response.status_code = 204
        return None
    _enqueue_due_schedules(db, worker)
    _recover_stale_running_jobs(db, worker.worker_id, worker.space_id)
    candidates = (
        db.query(Job)
        .filter(Job.space_id == worker.space_id)
        .filter(Job.status == "queued")
        .filter((Job.worker_id == payload.worker_id) | (Job.worker_id.is_(None)))
        .order_by(Job.priority.asc(), Job.created_at.asc())
        .all()
    )
    job = next(
        (candidate for candidate in candidates if _job_is_claimable(db, candidate)),
        None,
    )
    if job is None:
        db.commit()
        response.status_code = 204
        return None
    job.worker_id = payload.worker_id
    job.status = "running"
    now = utcnow()
    job.claimed_at = now
    job.updated_at = now
    project_task_job_lifecycle(db, job, state="running", at=now)
    if job.target_session_id and _job_updates_target_session(job):
        session = db.query(AgentSession).filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id).one_or_none()
        if session:
            session.status = "running"
            _touch_session_activity(session, at=now, summary=session.activity_summary or "worker 已领取，正在运行")
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.claim",
        payload={"kind": job.kind},
    )
    db.commit()
    return {"job": job_out(job, include_private_payload=True)}


@router.post("/api/internal/jobs/{job_id}/complete")
def complete_job(
    job_id: str,
    payload: CompleteJobIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    job = db.query(Job).filter(Job.space_id == worker.space_id, Job.job_id == job_id).one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail={"message": "Job not found", "code": "JOB_NOT_FOUND"})
    if job.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Job is not claimed by this worker", "code": "JOB_WORKER_MISMATCH"})
    if job.status != "running":
        raise HTTPException(status_code=409, detail={"message": "Job is not running", "code": "JOB_STATE_INVALID"})
    job.status = "succeeded"
    job.result_text = payload.result_text
    now = utcnow()
    job.completed_at = now
    job.updated_at = now
    if job.target_session_id and job.kind == "session_btw":
        session = db.query(AgentSession).filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id).one_or_none()
        if session:
            preserved_status = session.status
            _attach_btw_result(db, job, session, payload.result_text or "")
            session.status = preserved_status
            _touch_session_activity(session, at=now)
    elif job.target_session_id and _job_updates_runtime_metadata(job):
        session = db.query(AgentSession).filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id).one_or_none()
        if session:
            _update_fast_mode_runtime_metadata(session, job, payload.result_text or "", at=now)
    elif job.target_session_id and _job_updates_target_session(job):
        session = db.query(AgentSession).filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id).one_or_none()
        if session:
            _ensure_plan_result_timeline_item(db, job, session, payload.result_text or "")
            _touch_session_activity(
                session,
                at=now,
                message=payload.result_text or session.last_message,
                role="assistant",
                summary=payload.result_text or session.activity_summary,
            )
            if not _create_plan_choice_permission(db, job, session, payload.result_text or ""):
                session.status = "ready"
    project_task_job_lifecycle(
        db,
        job,
        state="succeeded",
        at=now,
        detail_text=payload.result_text or "",
    )
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.complete",
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/internal/jobs/{job_id}/fail")
def fail_job(
    job_id: str,
    payload: FailJobIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    job = db.query(Job).filter(Job.space_id == worker.space_id, Job.job_id == job_id).one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail={"message": "Job not found", "code": "JOB_NOT_FOUND"})
    if job.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Job is not claimed by this worker", "code": "JOB_WORKER_MISMATCH"})
    if job.status != "running":
        raise HTTPException(status_code=409, detail={"message": "Job is not running", "code": "JOB_STATE_INVALID"})
    job.status = "failed"
    job.error_text = payload.error_text
    now = utcnow()
    job.completed_at = now
    job.updated_at = now
    if job.target_session_id and _job_updates_runtime_metadata(job):
        session = db.query(AgentSession).filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id).one_or_none()
        if session:
            _update_fast_mode_runtime_metadata(
                session,
                job,
                dumps_json(
                    {
                        "state": "unknown",
                        "service_tier": None,
                        "reasoning_effort": None,
                        "raw": {},
                        "error": payload.error_text,
                    }
                ),
                at=now,
            )
    if job.target_session_id and _job_updates_target_session(job):
        session = db.query(AgentSession).filter(AgentSession.space_id == job.space_id, AgentSession.session_id == job.target_session_id).one_or_none()
        if session:
            session.status = "failed"
            _touch_session_activity(
                session,
                at=now,
                message=payload.error_text or session.last_message,
                role="system",
                summary=payload.error_text or session.activity_summary,
            )
    project_task_job_lifecycle(
        db,
        job,
        state="failed",
        at=now,
        detail_text=payload.error_text or "",
    )
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="job",
        source_id=job.job_id,
        event_type="job.fail",
        level="warning",
        payload={"error": payload.error_text},
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/internal/sessions/discovered")
def discovered_sessions(
    payload: DiscoveredSessionsIn,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = _assert_worker_binding(actor, payload.worker_id)
    sessions = []
    unique_sessions = {}
    for item in payload.sessions:
        unique_sessions.setdefault(item.session_id, item)
    for item in unique_sessions.values():
        if item.worker_id != worker.worker_id:
            raise HTTPException(status_code=400, detail={"message": "Discovered session worker mismatch", "code": "SESSION_WORKER_MISMATCH"})
        sessions.append(upsert_session(db, item, space_id=worker.space_id))
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="session",
        source_id=worker.worker_id,
        event_type="session.discovery",
        payload={"count": len(sessions)},
    )
    db.commit()
    return {"items": [{"session_id": session.session_id} for session in sessions]}
