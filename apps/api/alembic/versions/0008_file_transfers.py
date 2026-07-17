"""ephemeral workspace file transfers

Revision ID: 0008_file_transfers
Revises: 0007_per_device_push_delivery
Create Date: 2026-07-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0008_file_transfers"
down_revision = "0007_per_device_push_delivery"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Older self-host installs may have created the model table through the
    # compatibility bootstrap before Alembic advances to this revision.
    if "file_transfers" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "file_transfers",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("transfer_id", sa.String(length=64), nullable=False),
        sa.Column("space_id", sa.String(length=64), nullable=True),
        sa.Column("worker_id", sa.String(length=160), nullable=False),
        sa.Column("workspace_root", sa.Text(), nullable=False),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("direction", sa.String(length=24), nullable=False, server_default="download"),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="queued"),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("filename", sa.String(length=240), nullable=False, server_default=""),
        sa.Column("content_type", sa.String(length=160), nullable=False, server_default="application/octet-stream"),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("source_modified_at", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("overwrite", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("temp_path", sa.Text(), nullable=False, server_default=""),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["space_id"], ["spaces.space_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("transfer_id"),
    )
    op.create_index("ix_file_transfers_transfer_id", "file_transfers", ["transfer_id"], unique=True)
    op.create_index("ix_file_transfers_space_id", "file_transfers", ["space_id"])
    op.create_index("ix_file_transfers_worker_id", "file_transfers", ["worker_id"])
    op.create_index("ix_file_transfers_status", "file_transfers", ["status"])
    op.create_index("ix_file_transfers_created_by", "file_transfers", ["created_by"])
    op.create_index("ix_file_transfers_expires_at", "file_transfers", ["expires_at"])


def downgrade() -> None:
    op.drop_table("file_transfers")
