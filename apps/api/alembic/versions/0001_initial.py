"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-26
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "session_tokens",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.String(length=64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("csrf_hash", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_session_tokens_token_hash", "session_tokens", ["token_hash"], unique=True)

    op.create_table(
        "invites",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(length=64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_invites_email", "invites", ["email"])
    op.create_index("ix_invites_token_hash", "invites", ["token_hash"], unique=True)

    op.create_table(
        "access_tokens",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.String(length=64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("scopes_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_access_tokens_user_id", "access_tokens", ["user_id"])
    op.create_index("ix_access_tokens_token_hash", "access_tokens", ["token_hash"], unique=True)

    op.create_table(
        "workers",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("worker_id", sa.String(length=160), nullable=False),
        sa.Column("machine_name", sa.String(length=240), nullable=False),
        sa.Column("os", sa.String(length=64), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("reachable_backends_json", sa.Text(), nullable=False),
        sa.Column("workspace_roots_json", sa.Text(), nullable=False),
        sa.Column("capabilities_json", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("last_heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_workers_worker_id", "workers", ["worker_id"], unique=True)

    op.create_table(
        "agent_sessions",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("session_id", sa.String(length=180), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("worker_id", sa.String(length=160), nullable=False),
        sa.Column("workspace_root", sa.Text(), nullable=False),
        sa.Column("project_name", sa.String(length=240), nullable=False),
        sa.Column("namespace", sa.String(length=120), nullable=False),
        sa.Column("mode", sa.String(length=64), nullable=False),
        sa.Column("runtime_session_ref", sa.String(length=240), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("last_message", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_agent_sessions_session_id", "agent_sessions", ["session_id"], unique=True)
    op.create_index("ix_agent_sessions_worker_id", "agent_sessions", ["worker_id"])

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("job_id", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=80), nullable=False),
        sa.Column("target_session_id", sa.String(length=180), nullable=True),
        sa.Column("worker_id", sa.String(length=160), nullable=True),
        sa.Column("backend", sa.String(length=64), nullable=True),
        sa.Column("workspace_root", sa.Text(), nullable=True),
        sa.Column("namespace", sa.String(length=120), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("result_text", sa.Text(), nullable=True),
        sa.Column("error_text", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("claimed_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_jobs_job_id", "jobs", ["job_id"], unique=True)
    op.create_index("ix_jobs_kind", "jobs", ["kind"])
    op.create_index("ix_jobs_status", "jobs", ["status"])
    op.create_index("ix_jobs_worker_id", "jobs", ["worker_id"])
    op.create_index("ix_jobs_target_session_id", "jobs", ["target_session_id"])

    op.create_table(
        "events",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("event_id", sa.String(length=64), nullable=False),
        sa.Column("actor_type", sa.String(length=32), nullable=False),
        sa.Column("actor_id", sa.String(length=160), nullable=False),
        sa.Column("source_type", sa.String(length=64), nullable=False),
        sa.Column("source_id", sa.String(length=180), nullable=False),
        sa.Column("event_type", sa.String(length=120), nullable=False),
        sa.Column("level", sa.String(length=32), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_events_event_id", "events", ["event_id"], unique=True)
    op.create_index("ix_events_event_type", "events", ["event_type"])

    op.create_table(
        "memories",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("namespace", sa.String(length=120), nullable=False),
        sa.Column("observation", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=240), nullable=False),
        sa.Column("project_name", sa.String(length=240), nullable=True),
        sa.Column("backend", sa.String(length=64), nullable=True),
        sa.Column("created_by", sa.String(length=160), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("namespace", "observation", "source", name="uq_memory_entry"),
    )
    op.create_index("ix_memories_namespace", "memories", ["namespace"])


def downgrade() -> None:
    op.drop_table("memories")
    op.drop_table("events")
    op.drop_table("jobs")
    op.drop_table("agent_sessions")
    op.drop_table("workers")
    op.drop_table("access_tokens")
    op.drop_table("invites")
    op.drop_table("session_tokens")
    op.drop_table("users")
