"""session archive flag

Revision ID: 0004_session_archive
Revises: 0003_agent_secrets
Create Date: 2026-05-14
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0004_session_archive"
down_revision = "0003_agent_secrets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_sessions", sa.Column("archived_at", sa.DateTime(), nullable=True))
    op.create_index("ix_agent_sessions_archived_at", "agent_sessions", ["archived_at"])


def downgrade() -> None:
    op.drop_index("ix_agent_sessions_archived_at", table_name="agent_sessions")
    op.drop_column("agent_sessions", "archived_at")
