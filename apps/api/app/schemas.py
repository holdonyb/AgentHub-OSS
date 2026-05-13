from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


Role = Literal["owner", "admin", "operator", "viewer"]
ConnectionMode = Literal["private", "public_relay"]
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
    "file_read",
]
TimelineItemType = Literal[
    "user_message",
    "assistant_message",
    "reasoning",
    "tool_call",
    "todo",
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


class WorkerRegisterOut(BaseModel):
    worker: WorkerOut
    worker_token: str | None = None


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
    yolo: bool | None = None
    thinking: bool | None = None
    agent: str | None = None
    extra_workspace_dirs: list[str] | None = None
    secret_refs: list[str] | None = None
    secret_environment: str | None = None
    secret_namespace: str | None = None


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
    max_bytes: int = Field(default=200_000, ge=1, le=1_000_000)


class VoiceTranscribeIn(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content_type: str = Field(min_length=1, max_length=100)
    data_base64: str = Field(min_length=1)
    language: str | None = Field(default=None, max_length=20)


class VoiceTranscribeOut(BaseModel):
    text: str


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
