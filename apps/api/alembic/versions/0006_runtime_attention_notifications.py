"""runtime attention state and notification ledger

Revision ID: 0006_runtime_attention_notifications
Revises: 0005_timeline_updated_at_cursor
Create Date: 2026-07-14
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0006_runtime_attention_notifications"
down_revision = "0005_timeline_updated_at_cursor"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("agent_sessions") as batch:
        batch.add_column(sa.Column("execution_status", sa.String(length=32), nullable=False, server_default="unknown"))
        batch.add_column(sa.Column("execution_status_source", sa.String(length=32), nullable=False, server_default="legacy"))
        batch.add_column(sa.Column("execution_status_seq", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("execution_status_observed_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("attention_status", sa.String(length=32), nullable=False, server_default="none"))
        batch.add_column(sa.Column("attention_reason", sa.String(length=32), nullable=False, server_default=""))
        batch.add_column(sa.Column("attention_revision", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("attention_changed_at", sa.DateTime(), nullable=True))

    op.execute(
        "UPDATE agent_sessions SET "
        "execution_status = CASE status "
        "WHEN 'ready' THEN 'idle' WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' "
        "WHEN 'needs_reply' THEN 'waiting_input' WHEN 'failed' THEN 'failed' "
        "WHEN 'terminated' THEN 'terminated' ELSE 'unknown' END, "
        "execution_status_seq = 1, "
        "execution_status_observed_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)"
    )
    op.execute(
        "UPDATE agent_sessions SET "
        "attention_status = 'unseen', attention_reason = 'approval', attention_revision = 1, "
        "attention_changed_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) "
        "WHERE status = 'needs_reply'"
    )

    op.create_table(
        "notification_records",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("notification_id", sa.String(length=64), nullable=False),
        sa.Column("space_id", sa.String(length=64), nullable=False),
        sa.Column("recipient_user_id", sa.String(length=64), nullable=False),
        sa.Column("transition_key", sa.String(length=240), nullable=False),
        sa.Column("notification_type", sa.String(length=32), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_id", sa.String(length=180), nullable=False),
        sa.Column("session_id", sa.String(length=180), nullable=True),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("severity", sa.String(length=16), nullable=False, server_default="info"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(), nullable=True),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["recipient_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["space_id"], ["spaces.space_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("notification_id"),
        sa.UniqueConstraint(
            "space_id",
            "recipient_user_id",
            "transition_key",
            name="uq_notification_recipient_transition",
        ),
    )
    op.create_index("ix_notification_records_notification_id", "notification_records", ["notification_id"], unique=True)
    op.create_index("ix_notification_records_space_id", "notification_records", ["space_id"])
    op.create_index("ix_notification_records_recipient_user_id", "notification_records", ["recipient_user_id"])
    op.create_index("ix_notification_records_session_id", "notification_records", ["session_id"])
    op.create_index("ix_notification_records_notification_type", "notification_records", ["notification_type"])
    op.create_index("ix_notification_records_status", "notification_records", ["status"])
    op.create_index("ix_notification_records_created_at", "notification_records", ["created_at"])
    op.create_index(
        "ix_notification_recipient_created",
        "notification_records",
        ["space_id", "recipient_user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_table("notification_records")
    with op.batch_alter_table("agent_sessions") as batch:
        batch.drop_column("attention_changed_at")
        batch.drop_column("attention_revision")
        batch.drop_column("attention_reason")
        batch.drop_column("attention_status")
        batch.drop_column("execution_status_observed_at")
        batch.drop_column("execution_status_seq")
        batch.drop_column("execution_status_source")
        batch.drop_column("execution_status")
