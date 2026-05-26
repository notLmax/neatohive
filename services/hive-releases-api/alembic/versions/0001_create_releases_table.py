"""create releases table

Revision ID: 0001
Revises:
Create Date: 2026-05-06

"""

from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    dialect_name = op.get_context().dialect.name

    if dialect_name == "postgresql":
        id_column = sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        )
        released_at_column = sa.Column(
            "released_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        )
        op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
    else:
        id_column = sa.Column("id", sa.String(length=36), primary_key=True, nullable=False)
        released_at_column = sa.Column(
            "released_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        )

    op.create_table(
        "releases",
        id_column,
        sa.Column("version", sa.Text(), nullable=False, unique=True),
        sa.Column("tarball_url", sa.Text(), nullable=False),
        sa.Column("checksum_sha256", sa.Text(), nullable=False),
        released_at_column,
        sa.Column("changelog_url", sa.Text(), nullable=True),
        sa.Column("release_notes_summary", sa.Text(), nullable=True),
        sa.Column("deprecated_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.execute(
        "CREATE INDEX releases_version_active_idx "
        "ON releases (released_at DESC) WHERE deprecated_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS releases_version_active_idx")
    op.drop_table("releases")
