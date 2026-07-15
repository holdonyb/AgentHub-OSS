"""per-device push delivery

Revision ID: 0007_per_device_push_delivery
Revises: 0006_runtime_attention_notifications
Create Date: 2026-07-15
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0007_per_device_push_delivery"
down_revision = "0006_runtime_attention_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_devices",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("device_id", sa.String(length=160), nullable=False),
        sa.Column("space_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("platform", sa.String(length=16), nullable=False),
        sa.Column("transport", sa.String(length=16), nullable=False, server_default="expo"),
        sa.Column("push_token", sa.Text(), nullable=False),
        sa.Column("app_version", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["space_id"], ["spaces.space_id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_id"),
    )
    op.create_index("ix_push_devices_device_id", "push_devices", ["device_id"], unique=True)
    op.create_index("ix_push_devices_space_id", "push_devices", ["space_id"])
    op.create_index("ix_push_devices_user_id", "push_devices", ["user_id"])
    op.create_index("ix_push_devices_enabled", "push_devices", ["enabled"])

    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("delivery_id", sa.String(length=64), nullable=False),
        sa.Column("notification_record_id", sa.String(length=64), nullable=False),
        sa.Column("push_device_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("receipt_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("receipt_next_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("provider_ticket_id", sa.String(length=240), nullable=True),
        sa.Column("provider_receipt_id", sa.String(length=240), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("ticketed_at", sa.DateTime(), nullable=True),
        sa.Column("delivered_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["notification_record_id"], ["notification_records.id"]),
        sa.ForeignKeyConstraint(["push_device_id"], ["push_devices.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("delivery_id"),
        sa.UniqueConstraint(
            "notification_record_id",
            "push_device_id",
            name="uq_notification_delivery_record_device",
        ),
    )
    op.create_index("ix_notification_deliveries_delivery_id", "notification_deliveries", ["delivery_id"], unique=True)
    op.create_index("ix_notification_deliveries_notification_record_id", "notification_deliveries", ["notification_record_id"])
    op.create_index("ix_notification_deliveries_push_device_id", "notification_deliveries", ["push_device_id"])
    op.create_index("ix_notification_deliveries_status", "notification_deliveries", ["status"])
    op.create_index("ix_notification_deliveries_next_attempt_at", "notification_deliveries", ["next_attempt_at"])
    op.create_index(
        "ix_notification_deliveries_receipt_next_attempt_at",
        "notification_deliveries",
        ["receipt_next_attempt_at"],
    )
    op.create_index("ix_notification_deliveries_provider_ticket_id", "notification_deliveries", ["provider_ticket_id"])
    op.create_index(
        "ix_notification_delivery_dispatch",
        "notification_deliveries",
        ["status", "next_attempt_at", "created_at"],
    )
    op.create_index(
        "ix_notification_delivery_receipt_dispatch",
        "notification_deliveries",
        ["status", "receipt_next_attempt_at", "ticketed_at"],
    )


def downgrade() -> None:
    op.drop_table("notification_deliveries")
    op.drop_table("push_devices")
