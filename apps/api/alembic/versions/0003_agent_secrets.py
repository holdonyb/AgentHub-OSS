"""agent secrets

Revision ID: 0003_agent_secrets
Revises: 0002_agent_runtime_surface
Create Date: 2026-05-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0003_agent_secrets"
down_revision = "0002_agent_runtime_surface"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_secrets",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("secret_id", sa.String(length=64), nullable=False),
        sa.Column("space_id", sa.String(length=64), nullable=True),
        sa.Column("namespace", sa.String(length=120), nullable=False),
        sa.Column("environment", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("value_ciphertext", sa.Text(), nullable=False),
        sa.Column("value_hash", sa.String(length=128), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["space_id"], ["spaces.space_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("space_id", "namespace", "environment", "name", name="uq_agent_secret_scope_name"),
    )
    op.create_index("ix_agent_secrets_secret_id", "agent_secrets", ["secret_id"], unique=True)
    op.create_index("ix_agent_secrets_space_id", "agent_secrets", ["space_id"])
    op.create_index("ix_agent_secrets_namespace", "agent_secrets", ["namespace"])
    op.create_index("ix_agent_secrets_environment", "agent_secrets", ["environment"])
    op.create_index("ix_agent_secrets_name", "agent_secrets", ["name"])


def downgrade() -> None:
    op.drop_index("ix_agent_secrets_name", table_name="agent_secrets")
    op.drop_index("ix_agent_secrets_environment", table_name="agent_secrets")
    op.drop_index("ix_agent_secrets_namespace", table_name="agent_secrets")
    op.drop_index("ix_agent_secrets_space_id", table_name="agent_secrets")
    op.drop_index("ix_agent_secrets_secret_id", table_name="agent_secrets")
    op.drop_table("agent_secrets")
