from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator


Role = Literal["owner", "admin", "operator", "viewer"]
ConnectionMode = Literal["private", "public_relay"]
JobKind = Literal[
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
TimelineRole = Literal["user", "assistant", "system", "tool"]
RuntimeStatus = Literal["started", "running", "completed", "failed"]
PermissionKind = Literal["tool", "tool_approval", "command_approval", "plan", "plan_exit", "question", "mode", "other"]
PermissionAction = Literal["allow", "deny", "answer", "edit_and_allow"]
PermissionStatus = Literal["pending", "allowed", "denied", "answered", "expired"]


class UserOut(BaseModel):
    id: str
    email: str
    role: Role
    created_at: datetime


class SpaceOut(BaseModel):
    space_id: str
    name: str
    slug: str
    mode: str
    role: str | None = None


class WorkerEnrollmentCreateIn(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    expires_in_hours: int = Field(default=24, ge=1, le=24 * 30)


class WorkerEnrollmentOut(BaseModel):
    enrollment_id: str
    space_id: str
    label: str
    expires_at: datetime
    created_at: datetime


class WorkerEnrollmentCreatedOut(WorkerEnrollmentOut):
    enrollment_token: str


class BootstrapIn(BaseModel):
    bootstrap_token: str
    email: EmailStr
    password: str = Field(min_length=12)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class AuthOut(BaseModel):
    user: UserOut
    csrf_token: str
    space: SpaceOut | None = None


class InviteCreateIn(BaseModel):
    email: EmailStr
    role: Role
    expires_in_hours: int = 24


class InviteOut(BaseModel):
    invite_id: str
    invite_token: str
    email: str
    role: Role
    expires_at: datetime


class InviteAcceptIn(BaseModel):
    invite_token: str
    email: EmailStr
    password: str = Field(min_length=12)


class TokenCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    scopes: list[str] = Field(default_factory=list)


class TokenOut(BaseModel):
    token_id: str
    space_id: str | None
    name: str
    scopes: list[str]
    created_at: datetime
    revoked_at: datetime | None = None


class TokenCreatedOut(BaseModel):
    token_id: str
    token: str
    space_id: str | None = None


class WorkerRegisterIn(BaseModel):
    worker_id: str
    machine_name: str
    os: str
    connection_mode: ConnectionMode = "private"
    transport_state: str = "polling"
    worker_version: str | None = None
    reachable_backends: list[str] = Field(default_factory=list)
    workspace_roots: list[str] = Field(default_factory=list)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    worker_token: str | None = None


class WorkerEnrollIn(WorkerRegisterIn):
    enrollment_token: str


class WorkerRelayAuthIn(BaseModel):
    worker_id: str | None = None


class WorkerHeartbeatIn(BaseModel):
    status: Literal["online", "degraded"] = "online"
    transport_state: str | None = None
    worker_version: str | None = None
    reachable_backends: list[str] | None = None
    workspace_roots: list[str] | None = None
    capabilities: dict[str, Any] | None = None
    active_job_ids: list[str] | None = None


class WorkerRuntimeSettings(BaseModel):
    max_concurrent_jobs: int = Field(default=2, ge=1, le=32)
    job_poll_interval_seconds: int = Field(default=5, ge=1, le=300)
    heartbeat_interval_seconds: int = Field(default=30, ge=1, le=300)


class WorkerRuntimeSettingsPatchIn(BaseModel):
    max_concurrent_jobs: int | None = Field(default=None, ge=1, le=32)
    job_poll_interval_seconds: int | None = Field(default=None, ge=1, le=300)
    heartbeat_interval_seconds: int | None = Field(default=None, ge=1, le=300)


class WorkerOut(BaseModel):
    space_id: str | None
    worker_id: str
    machine_name: str
    os: str
    connection_mode: ConnectionMode
    transport_state: str
    worker_version: str | None = None
    reachable_backends: list[str]
    workspace_roots: list[str]
    capabilities: dict[str, Any]
    status: str
    last_heartbeat_at: datetime | None
    runtime_settings: WorkerRuntimeSettings


class WorkerRuntimeSettingsOut(BaseModel):
    max_concurrent_jobs: int = Field(ge=1, le=32)
    job_poll_interval_seconds: float = Field(ge=1, le=300)
    heartbeat_interval_seconds: float = Field(ge=1, le=300)


class UserPreferencesOut(BaseModel):
    locale: Literal["zh-CN", "zh-TW", "en-US"]
    theme_mode: Literal["dark", "light"]
    voice_mode: Literal["streaming", "standard"]
    voice_language: str = Field(min_length=2, max_length=20)
    quick_replies: list[str] = Field(default_factory=list, max_length=12)


class UserPreferencesIn(BaseModel):
    locale: Literal["zh-CN", "zh-TW", "en-US"] | None = None
    theme_mode: Literal["dark", "light"] | None = None
    voice_mode: Literal["streaming", "standard"] | None = None
    voice_language: str | None = Field(default=None, min_length=2, max_length=20)
    quick_replies: list[str] | None = Field(default=None, max_length=12)

    @field_validator("quick_replies")
    @classmethod
    def normalize_quick_replies(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        normalized: list[str] = []
        seen: set[str] = set()
        for item in value:
            text = item.strip()
            if not text:
                raise ValueError("quick replies cannot be empty")
            if len(text) > 80:
                raise ValueError("quick replies must be 80 characters or fewer")
            if text not in seen:
                normalized.append(text)
                seen.add(text)
        return normalized


class WorkerRuntimeSettingsIn(BaseModel):
    max_concurrent_jobs: int | None = Field(default=None, ge=1, le=32)
    job_poll_interval_seconds: float | None = Field(default=None, ge=1, le=300)
    heartbeat_interval_seconds: float | None = Field(default=None, ge=1, le=300)


class SettingsOut(BaseModel):
    preferences: UserPreferencesOut
    worker_runtime_defaults: WorkerRuntimeSettingsOut
    options: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, Any] = Field(default_factory=dict)


class WorkerRegisterOut(BaseModel):
    worker: WorkerOut
    worker_token: str | None = None
    runtime_settings: WorkerRuntimeSettingsOut | None = None


class SessionCreateIn(BaseModel):
    session_id: str
    backend: str
    worker_id: str
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


class SessionOut(BaseModel):
    space_id: str | None
    session_id: str
    backend: str
    worker_id: str
    workspace_root: str
    project_name: str
    namespace: str
    mode: str
    runtime_session_ref: str
    status: str
    title: str
    display_title: str
    custom_title: str | None
    heuristic_title: str
    llm_title: str | None
    activity_summary: str
    last_message: str
    last_activity_at: datetime | None
    last_role: str
    controls: dict[str, Any]
    runtime_metadata: dict[str, Any]
    metadata: dict[str, Any]
    archived_at: datetime | None
    updated_at: datetime


class AgentTimelineItemIn(BaseModel):
    seq: int | None = None
    item_type: TimelineItemType
    role: TimelineRole | None = None
    text: str = ""
    tool_call_id: str | None = None
    tool_name: str | None = None
    status: RuntimeStatus | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class AgentTimelineItemOut(BaseModel):
    space_id: str | None = None
    session_id: str
    seq: int
    item_type: str
    role: str | None
    text: str
    tool_call_id: str | None
    tool_name: str | None
    status: str | None
    payload: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class TimelinePublishIn(BaseModel):
    worker_id: str
    items: list[AgentTimelineItemIn]
    replace: bool = False


class SessionRenameIn(BaseModel):
    custom_title: str = Field(min_length=1, max_length=120)


class SessionControlsIn(BaseModel):
    model: str | None = None
    approval_mode: str | None = None
    sandbox_mode: str | None = None
    permission_mode: str | None = None
    interaction_bridge: str | None = None
    yolo: bool | None = None
    thinking: bool | None = None
    agent: str | None = None
    extra_workspace_dirs: list[str] | None = None
    secret_refs: list[str] | None = None
    secret_environment: str | None = None
    secret_namespace: str | None = None


class SessionFastToggleIn(BaseModel):
    enabled: bool


class SessionAttachmentIn(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content_type: str = Field(min_length=1, max_length=100)
    data_base64: str = Field(min_length=1)


class SessionInputIn(BaseModel):
    prompt: str = ""
    reply_mode: Literal["direct", "plan"] = "direct"
    attachments: list[SessionAttachmentIn] = Field(default_factory=list)


class SessionStartIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=160)
    backend: str = Field(min_length=1, max_length=64)
    workspace_root: str = Field(min_length=1)
    project_name: str | None = Field(default=None, max_length=240)
    namespace: str = Field(default="default", max_length=120)
    prompt: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=160)
    controls: dict[str, Any] = Field(default_factory=dict)


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


class TaskCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    brief_markdown: str = Field(min_length=1, max_length=80_000)
    success_criteria_markdown: str = Field(default="", max_length=40_000)
    target_worker_id: str | None = Field(default=None, max_length=160)
    backend: str | None = Field(default=None, max_length=64)
    workspace_root: str | None = None
    namespace: str = Field(default="default", max_length=120)
    priority: int = Field(default=100, ge=0, le=1000)
    controls: dict[str, Any] = Field(default_factory=dict)
    submit: bool = False


class TaskReviewIn(BaseModel):
    action: Literal["accept", "reject", "archive", "request_changes"]
    note_markdown: str = Field(default="", max_length=20_000)


class AgentTaskOut(BaseModel):
    space_id: str | None
    task_id: str
    title: str
    brief_markdown: str
    success_criteria_markdown: str
    status: str
    priority: int
    target_worker_id: str | None
    backend: str | None
    workspace_root: str | None
    namespace: str
    latest_job_id: str | None
    latest_session_id: str | None
    artifact_count: int
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    due_at: datetime | None
    archived_at: datetime | None
    metadata: dict[str, Any]


class AgentTaskExecutionOut(BaseModel):
    execution_id: str
    task_id: str
    job_id: str | None
    session_id: str | None
    kind: str
    status: str
    created_at: datetime
    updated_at: datetime


class AgentArtifactOut(BaseModel):
    artifact_id: str
    task_id: str
    kind: str
    title: str
    path: str | None
    content_markdown: str | None
    mime_type: str | None
    created_by: str
    created_at: datetime
    version: int


class SessionForkIn(BaseModel):
    worker_id: str | None = Field(default=None, max_length=160)
    backend: str | None = Field(default=None, max_length=64)
    workspace_root: str | None = None
    project_name: str | None = Field(default=None, max_length=240)
    namespace: str | None = Field(default=None, max_length=120)
    prompt: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=160)
    controls: dict[str, Any] | None = None


class SessionBtwIn(BaseModel):
    prompt: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=160)
    controls: dict[str, Any] | None = None


class SessionFileListIn(BaseModel):
    path: str = Field(default=".", min_length=1, max_length=1000)


class SessionFileReadIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    max_bytes: int = Field(default=200_000, ge=1, le=5_000_000)


class SessionFileWriteIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    text: str = Field(max_length=1_000_000)
    expected_modified_at: str | None = Field(default=None, max_length=80)


class SessionFileUploadIn(BaseModel):
    path: str = Field(default=".", min_length=1, max_length=1000)
    filename: str = Field(min_length=1, max_length=180)
    content_type: str = Field(min_length=1, max_length=120)
    data_base64: str = Field(min_length=1, max_length=24_000_000)
    overwrite: bool = False


class SessionFileCreateIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    text: str = Field(default="", max_length=1_000_000)
    overwrite: bool = False


class SessionFileMkdirIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class SessionFileRenameIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    new_path: str = Field(min_length=1, max_length=1000)
    expected_modified_at: str | None = Field(default=None, max_length=80)


class VoiceTranscribeIn(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content_type: str = Field(min_length=1, max_length=100)
    data_base64: str = Field(min_length=1)
    language: str | None = Field(default=None, max_length=20)
    duration_ms: int | None = Field(default=None, ge=0, le=60 * 60 * 1000)
    chunk_count: int | None = Field(default=None, ge=0, le=100_000)


class VoiceTranscribeDiagnostics(BaseModel):
    filename: str
    content_type: str
    input_format: str
    asr_format: str
    input_bytes: int
    prepared_bytes: int
    gain_applied_db: float | None = None
    duration_ms: int | None = None
    chunk_count: int | None = None


class VoiceTranscribeOut(BaseModel):
    text: str
    diagnostics: VoiceTranscribeDiagnostics


class VoiceStreamAuthOut(BaseModel):
    url: str
    auth: dict[str, str]
    config: dict[str, Any]
    expires_in_seconds: int


class VoiceTurnIn(BaseModel):
    session_id: str | None = Field(default=None, max_length=180)
    utterance: str = Field(min_length=1, max_length=6000)
    source: Literal["web", "android"] = "web"
    mode: Literal["assistant"] = "assistant"


class VoiceTurnOut(BaseModel):
    spoken_text: str
    actions: list[dict[str, Any]] = Field(default_factory=list)
    status: Literal["ok", "partial", "failed"]


class SyncStatusOut(BaseModel):
    archived: bool
    selected_session_id: str | None = None
    sessions_digest: str
    workers_digest: str
    jobs_digest: str
    schedules_digest: str
    providers_digest: str
    permissions_digest: str
    selected_timeline_digest: str
    generated_at: datetime


class InboxSyncOut(BaseModel):
    archived: bool
    cursor: str
    items: list[SessionOut]
    removed_session_ids: list[str] = Field(default_factory=list)


class SessionSyncOut(BaseModel):
    session: SessionOut
    items: list[AgentTimelineItemOut]
    jobs: list["JobOut"] = Field(default_factory=list)
    next_after_seq: int = 0
    next_after_cursor: str = ""
    has_more: bool = False


class PermissionSyncOut(BaseModel):
    cursor: str
    items: list[PermissionOut]


class JobCreateIn(BaseModel):
    kind: str
    target_session_id: str | None = None
    worker_id: str | None = None
    backend: str | None = None
    workspace_root: str | None = None
    namespace: str = "default"
    priority: int = 100
    payload: dict[str, Any] = Field(default_factory=dict)


class JobOut(BaseModel):
    space_id: str | None
    job_id: str
    kind: str
    target_session_id: str | None
    worker_id: str | None
    backend: str | None
    workspace_root: str | None
    namespace: str
    priority: int
    status: str
    queue_reason: str | None = None
    queue_reason_text: str | None = None
    payload: dict[str, Any]
    result_text: str | None
    error_text: str | None
    created_at: datetime
    updated_at: datetime


class EventOut(BaseModel):
    space_id: str | None
    event_id: str
    actor_type: str
    actor_id: str
    source_type: str
    source_id: str
    event_type: str
    level: str
    payload: dict[str, Any]
    created_at: datetime


class MemoryExtractIn(BaseModel):
    namespace: str = "default"
    observation: str = Field(min_length=1)
    source: str = "manual"
    project_name: str | None = None
    backend: str | None = None


class MemoryQueryIn(BaseModel):
    namespace: str = "default"
    query: str = ""


class MemoryOut(BaseModel):
    space_id: str | None
    namespace: str
    observation: str
    source: str
    project_name: str | None
    backend: str | None
    created_by: str
    created_at: datetime


class ClaimJobIn(BaseModel):
    worker_id: str


class CompleteJobIn(BaseModel):
    worker_id: str
    result_text: str = ""


class FailJobIn(BaseModel):
    worker_id: str
    error_text: str


class DiscoveredSessionsIn(BaseModel):
    worker_id: str
    sessions: list[SessionCreateIn]


class PermissionPayloadIn(BaseModel):
    permission_id: str | None = None
    session_id: str
    backend: str
    kind: PermissionKind
    title: str = Field(min_length=1, max_length=240)
    description: str = ""
    detail: dict[str, Any] = Field(default_factory=dict)
    actions: dict[str, Any] = Field(default_factory=dict)


class PermissionRequestedIn(BaseModel):
    worker_id: str
    permission: PermissionPayloadIn


class PermissionRespondIn(BaseModel):
    action: PermissionAction
    response: dict[str, Any] = Field(default_factory=dict)


class PermissionResolvedIn(BaseModel):
    worker_id: str
    status: PermissionStatus
    response: dict[str, Any] = Field(default_factory=dict)


class PermissionOut(BaseModel):
    space_id: str | None
    permission_id: str
    session_id: str
    worker_id: str
    backend: str
    kind: str
    title: str
    description: str
    detail: dict[str, Any]
    actions: dict[str, Any]
    status: str
    response: dict[str, Any]
    created_at: datetime
    resolved_at: datetime | None


class SecretCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    value: str = Field(min_length=1)
    namespace: str = Field(default="default", min_length=1, max_length=120)
    environment: str = Field(default="default", min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class SecretOut(BaseModel):
    secret_id: str
    namespace: str
    environment: str
    name: str
    description: str
    has_value: bool
    created_at: datetime
    updated_at: datetime
    revoked_at: datetime | None = None


class SecretResolveIn(BaseModel):
    worker_id: str
    job_id: str | None = Field(default=None, max_length=64)
    names: list[str] = Field(default_factory=list)
    namespace: str = Field(default="default", min_length=1, max_length=120)
    environment: str = Field(default="default", min_length=1, max_length=80)


class SecretResolveOut(BaseModel):
    secrets: dict[str, str]


class ProviderSnapshotItemIn(BaseModel):
    backend: str
    status: Literal["ready", "loading", "unavailable", "error"] = "unavailable"
    auth_status: Literal["ready", "auth_required", "handoff_required", "unknown"] = "unknown"
    models: list[dict[str, Any]] = Field(default_factory=list)
    modes: list[dict[str, Any]] = Field(default_factory=list)
    features: dict[str, Any] = Field(default_factory=dict)
    diagnostics: dict[str, Any] = Field(default_factory=dict)
    fetched_at: datetime | None = None


class ProviderSnapshotsIn(BaseModel):
    worker_id: str
    providers: list[ProviderSnapshotItemIn]


class ProviderSnapshotOut(BaseModel):
    space_id: str | None
    worker_id: str
    backend: str
    status: str
    auth_status: str
    models: list[dict[str, Any]]
    modes: list[dict[str, Any]]
    features: dict[str, Any]
    diagnostics: dict[str, Any]
    fetched_at: datetime
    updated_at: datetime


class ScheduleCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    job_kind: str
    enabled: bool = True
    interval_seconds: int = Field(ge=30)
    target_worker_id: str | None = None
    backend: str | None = None
    namespace: str = "default"
    payload: dict[str, Any] = Field(default_factory=dict)


class SchedulePatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    enabled: bool | None = None
    interval_seconds: int | None = Field(default=None, ge=30)
    target_worker_id: str | None = None
    backend: str | None = None
    namespace: str | None = None
    payload: dict[str, Any] | None = None


class ScheduleOut(BaseModel):
    space_id: str | None
    schedule_id: str
    name: str
    job_kind: str
    enabled: bool
    interval_seconds: int
    target_worker_id: str | None
    backend: str | None
    namespace: str
    payload: dict[str, Any]
    last_run_at: datetime | None
    next_run_at: datetime | None
    created_at: datetime
    updated_at: datetime
