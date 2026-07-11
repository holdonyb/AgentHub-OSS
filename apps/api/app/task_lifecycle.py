from __future__ import annotations

import re
from datetime import datetime
from hashlib import sha256
from typing import Literal

from sqlalchemy.orm import Session

from app.core.json import loads_json
from app.models import AgentArtifact, AgentTask, AgentTaskExecution, Job

TaskJobState = Literal["running", "succeeded", "failed", "cancelled"]

_CREATED_SESSION_MARKER = re.compile(
    r"\Acreated_session_id=(?P<session_id>[^\s\r\n]+)(?:\r?\n|\Z)"
)
_PROTECTED_TASK_STATUSES = frozenset({"accepted", "rejected", "archived", "cancelled"})
_TASK_STATUS_BY_JOB_STATE: dict[TaskJobState, str] = {
    "running": "working",
    "succeeded": "ready_to_review",
    "failed": "failed",
    "cancelled": "cancelled",
}


def _task_id_from_job(job: Job) -> str:
    payload = loads_json(job.payload_json, {})
    return str(payload.get("task_id") or "").strip() if isinstance(payload, dict) else ""


def _created_session_id(job: Job, detail_text: str) -> str | None:
    if job.kind != "session_start":
        return None
    match = _CREATED_SESSION_MARKER.match(detail_text)
    return match.group("session_id") if match is not None else None


def _task_execution_for_job(
    db: Session,
    job: Job,
    task_id: str,
) -> AgentTaskExecution | None:
    return (
        db.query(AgentTaskExecution)
        .filter(
            AgentTaskExecution.space_id == job.space_id,
            AgentTaskExecution.task_id == task_id,
            AgentTaskExecution.job_id == job.job_id,
        )
        .one_or_none()
    )


def _ensure_terminal_artifact(
    db: Session,
    job: Job,
    task: AgentTask,
    *,
    state: TaskJobState,
    detail_text: str,
) -> None:
    if state == "running":
        return
    artifact_key = f"{job.job_id}:{state}".encode("utf-8")
    artifact_id = f"art_{sha256(artifact_key).hexdigest()[:32]}"
    if db.query(AgentArtifact.id).filter(AgentArtifact.artifact_id == artifact_id).first() is not None:
        return
    if state == "succeeded":
        title = "交付报告"
        content = detail_text or "任务已完成，但没有返回文本报告。"
        created_by = "agent"
        kind = "report"
    elif state == "cancelled":
        title = "取消日志"
        content = detail_text or "任务已取消，但没有提供取消原因。"
        created_by = "system"
        kind = "log"
    else:
        title = "失败日志"
        content = detail_text or "任务失败，但没有返回错误信息。"
        created_by = "system"
        kind = "log"
    db.add(
        AgentArtifact(
            artifact_id=artifact_id,
            space_id=job.space_id,
            task_id=task.task_id,
            kind=kind,
            title=title,
            content_markdown=content,
            mime_type="text/markdown",
            created_by=created_by,
        )
    )


def project_task_job_lifecycle(
    db: Session,
    job: Job,
    *,
    state: TaskJobState,
    at: datetime,
    detail_text: str = "",
) -> bool:
    """Project a job transition onto its linked Workbench task, if any."""
    task_id = _task_id_from_job(job)
    if not task_id:
        return False
    task = (
        db.query(AgentTask)
        .filter(AgentTask.space_id == job.space_id, AgentTask.task_id == task_id)
        .one_or_none()
    )
    if task is None:
        return False

    if state == "succeeded":
        session_id = _created_session_id(job, detail_text)
        if session_id is not None:
            job.target_session_id = session_id

    execution = _task_execution_for_job(db, job, task.task_id)
    if execution is not None:
        execution.status = state
        if job.target_session_id:
            execution.session_id = job.target_session_id
        execution.updated_at = at

    _ensure_terminal_artifact(
        db,
        job,
        task,
        state=state,
        detail_text=detail_text,
    )

    is_current_attempt = task.latest_job_id == job.job_id
    if is_current_attempt and task.status not in _PROTECTED_TASK_STATUSES:
        task.status = _TASK_STATUS_BY_JOB_STATE[state]
        if job.target_session_id:
            task.latest_session_id = job.target_session_id
        task.updated_at = at
    return True
