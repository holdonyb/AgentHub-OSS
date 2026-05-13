"""agent runtime surface

Revision ID: 0002_agent_runtime_surface
Revises: 0001_initial
Create Date: 2026-04-27
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0002_agent_runtime_surface"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_timeline",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("session_id", sa.String(length=180), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("item_type", sa.String(length=64), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("tool_call_id", sa.String(length=160), nullable=True),
        sa.Column("tool_name", sa.String(length=160), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=True),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("session_id", "seq", name="uq_agent_timeline_session_seq"),
    )
    op.create_index("ix_agent_timeline_session_id", "agent_timeline", ["session_id"])
    op.create_index("ix_agent_timeline_item_type", "agent_timeline", ["item_type"])

    op.create_table(
        "agent_permissions",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("permission_id", sa.String(length=64), nullable=False),
        sa.Column("session_id", sa.String(length=180), nullable=False),
        sa.Column("worker_id", sa.String(length=160), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("detail_json", sa.Text(), nullable=False),
        sa.Column("actions_json", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("response_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_agent_permissions_permission_id", "agent_permissions", ["permission_id"], unique=True)
    op.create_index("ix_agent_permissions_session_id", "agent_permissions", ["session_id"])
    op.create_index("ix_agent_permissions_worker_id", "agent_permissions", ["worker_id"])
    op.create_index("ix_agent_permissions_kind", "agent_permissions", ["kind"])
    op.create_index("ix_agent_permissions_status", "agent_permissions", ["status"])

    op.create_table(
        "provider_snapshots",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("worker_id", sa.String(length=160), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("models_json", sa.Text(), nullable=False),
        sa.Column("modes_json", sa.Text(), nullable=False),
        sa.Column("features_json", sa.Text(), nullable=False),
        sa.Column("diagnostics_json", sa.Text(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("worker_id", "backend", name="uq_provider_snapshot_worker_backend"),
    )
    op.create_index("ix_provider_snapshots_worker_id", "provider_snapshots", ["worker_id"])
    op.create_index("ix_provider_snapshots_backend", "provider_snapshots", ["backend"])


def downgrade() -> None:
    op.drop_table("provider_snapshots")
    op.drop_table("agent_permissions")
    op.drop_table("agent_timeline")
