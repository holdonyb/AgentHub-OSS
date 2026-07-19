from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


JobKind = Literal[
    "session_input",
    "session_start",
    "session_fork",
    "session_btw",
    "session_discovery",
    "observer",
    "reflector",
    "memory_extract",
    "health_check",
    "provider_login",
    "provider_logout",
    "file_list",
    "file_search",
    "file_read",
    "file_write",
    "file_upload",
    "file_create",
    "file_mkdir",
    "file_rename",
]
TimelineItemType = Literal[
    "user_message",
    "assistant_message",
    "reasoning",
    "tool_call",
    "todo",
    "goal",
    "error",
    "compaction",
]


class AgentTimelineItem(BaseModel):
    seq: int | None = None
    item_type: TimelineItemType
    role: str | None = None
    text: str = ""
    tool_call_id: str | None = None
    tool_name: str | None = None
    status: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class WorkerRegistration(BaseModel):
    worker_id: str
    machine_name: str
    os: str
    reachable_backends: list[str] = Field(default_factory=list)
    workspace_roots: list[str] = Field(default_factory=list)
    capabilities: dict[str, Any] = Field(default_factory=dict)


class WorkerRuntimeSettings(BaseModel):
    max_concurrent_jobs: int = Field(default=2, ge=1, le=32)
    job_poll_interval_seconds: float = Field(default=5.0, ge=1.0, le=300.0)
    heartbeat_interval_seconds: float = Field(default=30.0, ge=1.0, le=300.0)


class SessionSnapshot(BaseModel):
    session_id: str
    backend: Literal["codex", "claude", "kimi", "opencode"]
    worker_id: str = ""
    workspace_root: str
    project_name: str
    namespace: str = "default"
    mode: str = "handoff_required"
    runtime_session_ref: str
    status: str = "ready"
    title: str = ""
    display_title: str = ""
    custom_title: str | None = None
    heuristic_title: str = ""
    llm_title: str | None = None
    activity_summary: str = ""
    last_message: str = ""
    last_activity_at: datetime | None = None
    last_role: str = ""
    controls: dict[str, Any] = Field(default_factory=dict)
    runtime_metadata: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    timeline: list[AgentTimelineItem] = Field(default_factory=list)

    def model_post_init(self, __context: Any) -> None:
        if self.timeline:
            self.runtime_metadata["timeline"] = [item.model_dump(mode="json") for item in self.timeline]


class JobEnvelope(BaseModel):
    job_id: str
    kind: JobKind
    payload: dict[str, Any] = Field(default_factory=dict)
    target_session_id: str | None = None
    worker_id: str | None = None
    backend: str | None = None
    workspace_root: str | None = None
    namespace: str = "default"


class JobResult(BaseModel):
    job_id: str
    ok: bool
    result_text: str = ""
    error_text: str = ""


TaskStatus = Literal[
    "draft",
    "queued",
    "working",
    "blocked",
    "needs_approval",
    "ready_to_review",
    "accepted",
    "rejected",
    "archived",
    "cancelled",
    "failed",
]
ArtifactKind = Literal[
    "report",
    "diff",
    "test_result",
    "screenshot",
    "log",
    "document",
    "patch",
    "build_output",
    "review_note",
]
TaskTemplateKey = Literal["fix_bug", "implement_feature", "code_review", "release_assistant"]
TaskAuthorityPreset = Literal["read_only", "code_fix", "feature", "review_only"]


class TaskAuthorityBoundary(BaseModel):
    read_paths: list[str] = Field(default_factory=list)
    write_paths: list[str] = Field(default_factory=list)
    runtime_controls: dict[str, Any] = Field(default_factory=dict)
    enforcement: dict[str, Literal["mapped", "declared_only"]] = Field(default_factory=dict)


class TaskWorkspaceConfig(BaseModel):
    schema_version: int = 1
    task_id: str
    relative_path: str
    title: str
    brief_markdown: str
    success_criteria_markdown: str = ""
    template_key: TaskTemplateKey = "implement_feature"
    authority_preset: TaskAuthorityPreset = "feature"
    relevant_paths: list[str] = Field(default_factory=list)
    attempt_number: int = Field(default=1, ge=1)
    review_note: str = ""
    authority: TaskAuthorityBoundary


class AgentTask(BaseModel):
    task_id: str
    title: str
    brief_markdown: str
    success_criteria_markdown: str
    status: TaskStatus
    priority: int = 100
    target_worker_id: str | None = None
    backend: str | None = None
    workspace_root: str | None = None
    namespace: str = "default"
    latest_job_id: str | None = None
    latest_session_id: str | None = None
    artifact_count: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class AgentTaskExecution(BaseModel):
    execution_id: str
    task_id: str
    job_id: str | None = None
    session_id: str | None = None
    attempt_number: int = Field(default=1, ge=1)
    kind: str
    status: str
    created_at: datetime
    updated_at: datetime
