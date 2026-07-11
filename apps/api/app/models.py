from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def utcnow() -> datetime:
    return datetime.utcnow()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("usr"))
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="viewer")
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    tokens: Mapped[list["AccessToken"]] = relationship(back_populates="user")
    memberships: Mapped[list["SpaceMembership"]] = relationship(back_populates="user")


class Space(Base):
    __tablename__ = "spaces"

    space_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("spc"))
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    slug: Mapped[str] = mapped_column(String(160), unique=True, index=True, nullable=False)
    mode: Mapped[str] = mapped_column(String(32), default="private", nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    memberships: Mapped[list["SpaceMembership"]] = relationship(back_populates="space")


class SpaceMembership(Base):
    __tablename__ = "space_memberships"
    __table_args__ = (UniqueConstraint("space_id", "user_id", name="uq_space_membership_space_user"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("spm"))
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.space_id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="viewer")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    space: Mapped[Space] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships")


class SettingEntry(Base):
    __tablename__ = "setting_entries"
    __table_args__ = (UniqueConstraint("scope_type", "scope_id", "key", name="uq_setting_scope_key"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("set"))
    scope_type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    scope_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    value_json: Mapped[str] = mapped_column(Text, default="null", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class WorkerEnrollment(Base):
    __tablename__ = "worker_enrollments"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("wen"))
    enrollment_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("wen"))
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.space_id"), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SessionToken(Base):
    __tablename__ = "session_tokens"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("st"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    csrf_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("inv"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AccessToken(Base):
    __tablename__ = "access_tokens"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("tok"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    scopes_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship(back_populates="tokens")


class Worker(Base):
    __tablename__ = "workers"
    __table_args__ = (UniqueConstraint("space_id", "worker_id", name="uq_workers_space_worker_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("wrk"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    worker_id: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    machine_name: Mapped[str] = mapped_column(String(240), nullable=False)
    os: Mapped[str] = mapped_column(String(64), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    connection_mode: Mapped[str] = mapped_column(String(32), default="private", nullable=False)
    transport_state: Mapped[str] = mapped_column(String(64), default="polling", nullable=False)
    worker_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reachable_backends_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    workspace_roots_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    capabilities_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    max_concurrent_jobs: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    job_poll_interval_seconds: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    heartbeat_interval_seconds: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="registered", nullable=False)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentSession(Base):
    __tablename__ = "agent_sessions"
    __table_args__ = (UniqueConstraint("space_id", "session_id", name="uq_agent_sessions_space_session_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("ses"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(180), index=True, nullable=False)
    backend: Mapped[str] = mapped_column(String(64), nullable=False)
    worker_id: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    workspace_root: Mapped[str] = mapped_column(Text, nullable=False)
    project_name: Mapped[str] = mapped_column(String(240), nullable=False)
    namespace: Mapped[str] = mapped_column(String(120), default="default", nullable=False)
    mode: Mapped[str] = mapped_column(String(64), default="handoff_required", nullable=False)
    runtime_session_ref: Mapped[str] = mapped_column(String(240), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="ready", nullable=False)
    title: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    display_title: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    custom_title: Mapped[str | None] = mapped_column(String(240), nullable=True)
    heuristic_title: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    llm_title: Mapped[str | None] = mapped_column(String(240), nullable=True)
    activity_summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    last_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    last_role: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    controls_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    runtime_metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentTask(Base):
    __tablename__ = "agent_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("atk"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    task_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("tsk"))
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    brief_markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    success_criteria_markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    target_worker_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    backend: Mapped[str | None] = mapped_column(String(64), nullable=True)
    workspace_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    namespace: Mapped[str] = mapped_column(String(120), default="default", nullable=False)
    latest_job_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    latest_session_id: Mapped[str | None] = mapped_column(String(180), nullable=True, index=True)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentTaskExecution(Base):
    __tablename__ = "agent_task_executions"
    __table_args__ = (
        UniqueConstraint(
            "space_id",
            "task_id",
            "attempt_number",
            name="uq_agent_task_executions_space_task_attempt",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("ate"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    execution_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("tex"))
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    session_id: Mapped[str | None] = mapped_column(String(180), nullable=True, index=True)
    attempt_number: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    kind: Mapped[str] = mapped_column(String(80), default="session_start", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentArtifact(Base):
    __tablename__ = "agent_artifacts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("art"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    artifact_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("art"))
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(40), default="report", index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    path: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by: Mapped[str] = mapped_column(String(32), default="system", nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentTimeline(Base):
    __tablename__ = "agent_timeline"
    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_agent_timeline_session_seq"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("tli"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(180), index=True, nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    item_type: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    tool_call_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    tool_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)


class AgentPermission(Base):
    __tablename__ = "agent_permissions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("prm"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    permission_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("prm"))
    session_id: Mapped[str] = mapped_column(String(180), index=True, nullable=False)
    worker_id: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    backend: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    detail_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    actions_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ProviderSnapshot(Base):
    __tablename__ = "provider_snapshots"
    __table_args__ = (UniqueConstraint("space_id", "worker_id", "backend", name="uq_provider_snapshot_space_worker_backend"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("prv"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    worker_id: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    backend: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="unavailable", nullable=False)
    models_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    modes_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    features_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    diagnostics_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("job"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    job_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("job"))
    kind: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    target_session_id: Mapped[str | None] = mapped_column(String(180), nullable=True, index=True)
    worker_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    backend: Mapped[str | None] = mapped_column(String(64), nullable=True)
    workspace_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    namespace: Mapped[str] = mapped_column(String(120), default="default", nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    result_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("evt"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("evt"))
    actor_type: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(160), nullable=False)
    source_type: Mapped[str] = mapped_column(String(64), nullable=False)
    source_id: Mapped[str] = mapped_column(String(180), nullable=False)
    event_type: Mapped[str] = mapped_column(String(120), index=True, nullable=False)
    level: Mapped[str] = mapped_column(String(32), default="info", nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Memory(Base):
    __tablename__ = "memories"
    __table_args__ = (UniqueConstraint("space_id", "namespace", "observation", "source", name="uq_memory_entry"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("mem"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    namespace: Mapped[str] = mapped_column(String(120), index=True, nullable=False)
    observation: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(240), nullable=False)
    project_name: Mapped[str | None] = mapped_column(String(240), nullable=True)
    backend: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AgentSecret(Base):
    __tablename__ = "agent_secrets"
    __table_args__ = (
        UniqueConstraint("space_id", "namespace", "environment", "name", name="uq_agent_secret_scope_name"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("sec"))
    secret_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("sec"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    namespace: Mapped[str] = mapped_column(String(120), default="default", nullable=False, index=True)
    environment: Mapped[str] = mapped_column(String(80), default="default", nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    value_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    value_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("sch"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.space_id"), nullable=True, index=True)
    schedule_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("sch"))
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    job_kind: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    interval_seconds: Mapped[int] = mapped_column(Integer, default=300, nullable=False)
    target_worker_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    backend: Mapped[str | None] = mapped_column(String(64), nullable=True)
    namespace: Mapped[str] = mapped_column(String(120), default="default", nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
