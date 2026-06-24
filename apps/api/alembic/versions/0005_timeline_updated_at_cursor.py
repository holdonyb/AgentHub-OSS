"""timeline updated_at cursor support

Revision ID: 0005_timeline_updated_at_cursor
Revises: 0004_session_archive
Create Date: 2026-06-24
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0005_timeline_updated_at_cursor"
down_revision = "0004_session_archive"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("agent_timeline") as batch:
        batch.add_column(sa.Column("updated_at", sa.DateTime(), nullable=True))
    op.execute("UPDATE agent_timeline SET updated_at = created_at WHERE updated_at IS NULL")
    with op.batch_alter_table("agent_timeline") as batch:
        batch.alter_column("updated_at", existing_type=sa.DateTime(), nullable=False)
        batch.create_index("ix_agent_timeline_updated_at", ["updated_at"])
        batch.create_index("ix_agent_timeline_space_session_updated_id", ["space_id", "session_id", "updated_at", "seq"])


def downgrade() -> None:
    with op.batch_alter_table("agent_timeline") as batch:
        batch.drop_index("ix_agent_timeline_space_session_updated_id")
        batch.drop_index("ix_agent_timeline_updated_at")
        batch.drop_column("updated_at")
