"""seed v1.5.0 placeholder release

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-06

"""

from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    dialect_name = op.get_context().dialect.name

    if dialect_name == "postgresql":
        op.execute(
            """
            INSERT INTO releases (
                version,
                tarball_url,
                checksum_sha256,
                released_at,
                changelog_url,
                release_notes_summary
            )
            VALUES (
                '1.5.0',
                'https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz',
                '0000000000000000000000000000000000000000000000000000000000000000',
                '2026-05-06T00:00:00Z'::timestamptz,
                'https://neato-hive-site.vercel.app/changelog.html',
                NULL
            )
            ON CONFLICT (version) DO NOTHING
            """
        )
        return

    releases = sa.table(
        "releases",
        sa.column("id", sa.String()),
        sa.column("version", sa.Text()),
        sa.column("tarball_url", sa.Text()),
        sa.column("checksum_sha256", sa.Text()),
        sa.column("released_at", sa.TIMESTAMP(timezone=True)),
        sa.column("changelog_url", sa.Text()),
        sa.column("release_notes_summary", sa.Text()),
    )
    bind = op.get_bind()
    existing = bind.execute(
        sa.text("SELECT 1 FROM releases WHERE version = :version"),
        {"version": "1.5.0"},
    ).scalar_one_or_none()
    if existing is None:
        op.bulk_insert(
            releases,
            [
                {
                    "id": "00000000-0000-0000-0000-000000000001",
                    "version": "1.5.0",
                    "tarball_url": (
                        "https://neato-hive-site.vercel.app/releases/v1.5.0/"
                        "neato-hive-v1.5.0.tar.gz"
                    ),
                    "checksum_sha256": (
                        "0000000000000000000000000000000000000000000000000000000000000000"
                    ),
                    "released_at": datetime(2026, 5, 6, tzinfo=timezone.utc),
                    "changelog_url": "https://neato-hive-site.vercel.app/changelog.html",
                    "release_notes_summary": None,
                }
            ],
        )


def downgrade() -> None:
    op.execute("DELETE FROM releases WHERE version = '1.5.0'")
