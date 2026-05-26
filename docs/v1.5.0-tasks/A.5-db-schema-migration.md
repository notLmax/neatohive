# v1.5.0 A.5 — DB Schema + First Migration + DB-Backed Swap

**Status:** LOCKED — house-md's cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`. 5 open questions resolved (see §Resolved decisions below).
**Project:** v1.5.0-website-installer-dashboard
**Phase:** A — Site repo + Cloud Run backend skeleton (FINAL leaf — Phase A closes on A.5 merge)
**Leaf:** A.5 (5 of 5 in Phase A — A.0/A.1/A.2/A.3/A.4 all ✅ merged)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop — owner directive 2026-05-06 via task `t-mouojpd4000i`)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** A.4 ✅ merged 2026-05-06 — site PR `Daniel-Neato/neato-hive-site#2` + framework PR `#48` squash `ef706ce` (05:47Z)
**Successor:** Phase B — release script in framework repo

---

## Goal

Stand up the `hive_releases` Postgres database in `neato-os-db` Cloud SQL instance with the `releases` table per Decision D forward-flex schema. Wire Alembic for migrations. Swap `routers/current.py` source from `seed/releases.json` static file to live DB query. Add `migrate` step to `cloudbuild.yaml` between `push` and `deploy` (mirrors lore D.3 option α: cloud-sql-proxy + alembic upgrade head).

After A.5: `/api/current` returns the same 5-field JSON contract as A.2/A.4, but sourced from DB. Forward-flex placeholders for `users` / `installs` / `skills` documented but NOT created (those are v1.5.x or post-v1.5.0).

**Trigger context:** Cloud Build GitHub App still NOT installed on `anthonyconnelly/neato-hive` (owner-paced; F.0-equivalent gap surfaced in A.3). A.5 ships **code-only** — deploy fires automatically when owner installs the App + push lands. Migration runs locally against mocked test DB during worker turn; production migrate fires as part of the auto-deploy pipeline post-install.

---

## Resolved decisions (locked from §Open questions in PREP-SKETCH)

### Q1 — Test strategy: **mock** (not real DB)

Tests use `unittest.mock.patch` on the SQLAlchemy session. Matches A.2's lightweight test approach. Real-DB tests via `pytest-postgresql` would slow worker turn + add infra dependency. Future leaf can add real-DB integration tests.

Test count: 5 (one more than A.2's 4 — adds DB-query mock test):
1. `/api/current` returns 200
2. Response shape matches contract (5 fields)
3. Mocked DB query returns expected fields when row exists
4. Mocked DB returns 500 with structured error when no rows exist (deprecated_at filter excludes everything)
5. Auth middleware passthrough (unchanged from A.2)

### Q2 — Secret rotation timing: **embed in spec as owner-side step**

Single coherent A.5 close. Owner runs DB create + user create + secret rotate via gcloud BEFORE OR AFTER Bob's PR ships — not during worker turn. Worker doesn't generate or touch real secret values. See §F Owner-side steps.

### Q3 — DB user permissions scope: **single user with runtime + migration perms**

`hive_releases_user` gets `GRANT USAGE, CREATE ON SCHEMA public` + `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hive_releases_user` + `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hive_releases_user`. Single user runs both Alembic migrations + runtime queries. Future split (separate `hive_releases_admin` for migrations, narrow `hive_releases_user` for runtime) is a v1.6.x consideration if security model tightens.

### Q4 — Connection pooling: **SQLAlchemy defaults**

Pool size 5, max-instances 3 → up to 15 concurrent connections. neato-os-db default max_connections 100. Plenty of headroom even with lore-api also connecting. Revisit if metrics show contention.

### Q5 — Migration cloud-sql-proxy approach: **option α** (download at runtime)

Proven working from lore D.3. No extra image management. cloudbuild.yaml migrate step downloads cloud-sql-proxy v2.18.3 at runtime in a Python urllib bootstrap (matches D.3 pattern verbatim, including the socket-wait loop). Custom image with proxy baked in is future build-time optimization if needed.

---

## Pre-conditions

- A.4 ✅ merged (both PRs squash-merged)
- Framework `main` HEAD includes A.4 + A.5 spec landings (cron-driver picks up from latest)
- Bob has machine-level `glados@neato-os` gcloud auth (Decision A2)
- Cloud SQL instance `neato-os-db` accessible (verified live in lore-v2)
- `services/hive-releases-api/` shape per A.2 + A.3 (FastAPI app, Dockerfile, cloudbuild.yaml, requirements.txt, no Alembic yet)
- Cloud Build GitHub App on `anthonyconnelly/neato-hive`: NOT installed (owner-paced; A.5 codes against this — production deploy fires when install lands, no worker-side dependency)

---

## Where state lives (A.5 conventions)

- **Migrations directory:** `services/hive-releases-api/alembic/versions/` (NEW)
- **Alembic config:** `services/hive-releases-api/alembic.ini` + `services/hive-releases-api/alembic/env.py` + `services/hive-releases-api/alembic/script.py.mako`
- **DB connection module:** `services/hive-releases-api/db.py` (NEW — SQLAlchemy engine + session, reads `DB_PASSWORD` from env via Cloud Run `--set-secrets`)
- **ORM models:** `services/hive-releases-api/models.py` (NEW — `Release` model matching Decision D schema)
- **Database:** `hive_releases` (NEW database, cohabits with `lore` on `neato-os-db` instance)
- **DB user:** `hive_releases_user` (NEW user, scoped to `hive_releases` database only)
- **Existing files modified:** `routers/current.py`, `tests/test_current.py`, `cloudbuild.yaml`, `requirements.txt`, `README.md`
- **Existing files unchanged:** `main.py`, `middleware/auth.py`, `Dockerfile`, `seed/releases.json` (kept as backup for emergency rollback / local-dev seeding)

---

## Pre-flight (worker MUST run all 7; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: A.5 spec commit + A.4 merge commit + A.3 merge commit visible at top.

### 2. Service directory shape post-A.2/A.3/A.4

```bash
ls services/hive-releases-api/
test -f services/hive-releases-api/main.py && echo "main.py: ✓" || echo "main.py: ✗"
test -f services/hive-releases-api/Dockerfile && echo "Dockerfile: ✓" || echo "Dockerfile: ✗"
test -f services/hive-releases-api/cloudbuild.yaml && echo "cloudbuild.yaml: ✓" || echo "cloudbuild.yaml: ✗"
test -f services/hive-releases-api/seed/releases.json && echo "seed/releases.json: ✓" || echo "seed/releases.json: ✗"
test -d services/hive-releases-api/alembic && echo "alembic/ EXISTS: HALT — investigate" || echo "alembic/: not present (expected pre-A.5)"
test -f services/hive-releases-api/db.py && echo "db.py EXISTS: HALT — investigate" || echo "db.py: not present (expected pre-A.5)"
test -f services/hive-releases-api/models.py && echo "models.py EXISTS: HALT — investigate" || echo "models.py: not present (expected pre-A.5)"
```

Expected: A.2/A.3/A.4 files present, A.5 files absent. **HALT and ping house-md** if any A.5-target file already exists (out-of-band edit).

### 3. Cloud SQL instance + database listing

```bash
gcloud sql instances describe neato-os-db --project=neato-os --format='value(state,connectionName)' 2>&1
gcloud sql databases list --instance=neato-os-db --project=neato-os --format='value(name)' 2>&1 | head -10
```

Expected: state `RUNNABLE`. Databases list includes `lore` and `postgres` (default). Verify `hive_releases` is NOT in the list (owner-side step hasn't run yet — that's expected; A.5 ships code without requiring DB to exist).

### 4. Existing DB users

```bash
gcloud sql users list --instance=neato-os-db --project=neato-os --format='value(name)' 2>&1 | head -10
```

Expected: `lore_user` + `postgres` (default). `hive_releases_user` should NOT be in the list (owner-side step hasn't run; A.5 ships code without requiring user to exist).

### 5. Cloud Run service + Cloud Build trigger state

```bash
gcloud run services describe hive-releases-api --region=us-central1 --project=neato-os --format='value(status.url)' 2>&1 | head -3
gcloud builds triggers describe hive-releases-api-deploy --project=neato-os --region=global --format='value(name,github.name)' 2>&1 | head -3
```

Expected: BOTH return NOT_FOUND (Cloud Build GitHub App not installed on framework repo yet). If service or trigger exists, capture in PR body — A.5 still ships code regardless.

### 6. Current cloudbuild.yaml shape (worker reads to plan migrate-step insertion)

```bash
cat services/hive-releases-api/cloudbuild.yaml | head -80
```

Expected: 4 steps (build, push, deploy, bind-public-invoker) per A.3. Migrate step inserted between push and deploy.

### 7. Test + build baseline pre-changes

```bash
cd services/hive-releases-api
python3 -m venv .venv-preflight && source .venv-preflight/bin/activate
pip install -q -r requirements.txt
python3 -m pytest tests/ -v 2>&1 | tail -10
deactivate && rm -rf .venv-preflight
```

Expected: 4 tests pass per A.2. Worker confirms baseline before extending.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-A.5-db-schema-migration`.

**Diff is LOCKED to exactly 12 paths** (10 NEW + 5 MODIFY... wait that's 15 — see below for accurate accounting):

### Created (8 NEW files)
1. `services/hive-releases-api/alembic.ini`
2. `services/hive-releases-api/alembic/env.py`
3. `services/hive-releases-api/alembic/script.py.mako`
4. `services/hive-releases-api/alembic/versions/0001_create_releases_table.py`
5. `services/hive-releases-api/alembic/versions/0002_seed_v1_5_0_placeholder.py`
6. `services/hive-releases-api/alembic/__init__.py` (empty — Python package marker)
7. `services/hive-releases-api/db.py`
8. `services/hive-releases-api/models.py`

### Modified (5 files)
9. `services/hive-releases-api/routers/current.py` (replace seed-file read with DB query)
10. `services/hive-releases-api/tests/test_current.py` (adapt 4 → 5 tests with DB mock; existing seed-integrity test removed since seed-file is no longer the source)
11. `services/hive-releases-api/cloudbuild.yaml` (insert migrate step + add `migrate` to availableSecrets — mirrors lore D.3 option α)
12. `services/hive-releases-api/requirements.txt` (add SQLAlchemy + alembic + psycopg[binary])
13. `services/hive-releases-api/README.md` (add "Database" section explaining Alembic + DB-backed reads)

**Total: 13 path operations (8 new + 5 modify).** No edits outside `services/hive-releases-api/`.

### A.1 — `services/hive-releases-api/alembic.ini`

Standard Alembic config. Critical settings:
- `script_location = alembic`
- `sqlalchemy.url = ` (intentionally empty — `env.py` reads from env at runtime, NOT from alembic.ini)
- `file_template = %%(rev)s_%%(slug)s` (for migration file naming)

### A.2 — `services/hive-releases-api/alembic/env.py`

Reads connection URL from env (using `db.py`'s `make_database_url()`). Imports `Base` from `models.py` for `target_metadata`. Standard Alembic env.py pattern.

```python
from logging.config import fileConfig
from alembic import context
from sqlalchemy import engine_from_config, pool

from db import make_database_url
from models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", make_database_url())
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

### A.3 — `services/hive-releases-api/alembic/script.py.mako`

Standard Alembic template. Worker copies from `alembic init` output verbatim — no customization needed.

### A.4 — `services/hive-releases-api/alembic/versions/0001_create_releases_table.py`

Schema migration creating the `releases` table per Decision D forward-flex schema:

```python
"""create releases table

Revision ID: 0001
Revises: 
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"")
    op.create_table(
        "releases",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("version", sa.Text, nullable=False, unique=True),
        sa.Column("tarball_url", sa.Text, nullable=False),
        sa.Column("checksum_sha256", sa.Text, nullable=False),
        sa.Column("released_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("changelog_url", sa.Text, nullable=True),
        sa.Column("release_notes_summary", sa.Text, nullable=True),
        sa.Column("deprecated_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.execute("CREATE INDEX releases_version_active_idx ON releases (released_at DESC) WHERE deprecated_at IS NULL")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS releases_version_active_idx")
    op.drop_table("releases")
```

### A.5 — `services/hive-releases-api/alembic/versions/0002_seed_v1_5_0_placeholder.py`

Data migration inserting v1.5.0 placeholder row matching `seed/releases.json` content exactly:

```python
"""seed v1.5.0 placeholder release

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-06

"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO releases (version, tarball_url, checksum_sha256, released_at, changelog_url, release_notes_summary)
        VALUES (
            '1.5.0',
            'https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz',
            '0000000000000000000000000000000000000000000000000000000000000000',
            '2026-05-06T00:00:00Z'::timestamptz,
            'https://neato-hive-site.vercel.app/changelog.html',
            NULL
        )
        ON CONFLICT (version) DO NOTHING
    """)


def downgrade() -> None:
    op.execute("DELETE FROM releases WHERE version = '1.5.0'")
```

`ON CONFLICT (version) DO NOTHING` makes the data migration idempotent — re-runs are safe. Placeholder checksum (`0000…`) gets replaced at J.2 release-tagging via a separate `gcloud sql ... INSERT/UPDATE` ceremony (or a future spec-rev migration).

### A.6 — `services/hive-releases-api/db.py`

SQLAlchemy engine + session factory. Builds connection URL from env vars (matches lore D.3 deploy step env shape):

```python
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session


def make_database_url() -> str:
    """Build PostgreSQL connection URL from env vars set by Cloud Run --set-env-vars + --set-secrets."""
    db_user = os.environ.get("DB_USER", "hive_releases_user")
    db_password = os.environ.get("DB_PASSWORD", "")
    db_name = os.environ.get("DB_NAME", "hive_releases")
    socket_dir = os.environ.get("CLOUD_SQL_SOCKET_DIR", "/cloudsql")
    connection_name = os.environ.get("CLOUD_SQL_CONNECTION_NAME", "neato-os:us-central1:neato-os-db")
    return f"postgresql+psycopg://{db_user}:{db_password}@/{db_name}?host={socket_dir}/{connection_name}"


engine = create_engine(make_database_url(), pool_pre_ping=True)
SessionLocal = scoped_session(sessionmaker(autocommit=False, autoflush=False, bind=engine))


def get_session():
    """FastAPI dependency for per-request session."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
```

`pool_pre_ping=True` validates connections before reuse (catches stale Cloud SQL Connector sockets). Default pool size 5 (per Q4).

### A.7 — `services/hive-releases-api/models.py`

SQLAlchemy ORM model matching the schema:

```python
from sqlalchemy import Column, Text, TIMESTAMP, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Release(Base):
    __tablename__ = "releases"

    id = Column(UUID(as_uuid=True), server_default=text("gen_random_uuid()"), primary_key=True)
    version = Column(Text, nullable=False, unique=True)
    tarball_url = Column(Text, nullable=False)
    checksum_sha256 = Column(Text, nullable=False)
    released_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=text("NOW()"))
    changelog_url = Column(Text, nullable=True)
    release_notes_summary = Column(Text, nullable=True)
    deprecated_at = Column(TIMESTAMP(timezone=True), nullable=True)
```

Mirrors the migration schema. Used by `routers/current.py` for queries.

### A.8 — `services/hive-releases-api/routers/current.py` (MODIFY)

Replace seed-file read with DB query. Preserve the response contract (5 fields).

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select

from db import get_session
from models import Release

router = APIRouter()


@router.get("/current")
def get_current_release(session: Session = Depends(get_session)) -> dict:
    stmt = (
        select(Release)
        .where(Release.deprecated_at.is_(None))
        .order_by(Release.released_at.desc())
        .limit(1)
    )
    release = session.execute(stmt).scalar_one_or_none()
    if release is None:
        raise HTTPException(status_code=500, detail="no active release found")
    return {
        "version": release.version,
        "tarball_url": release.tarball_url,
        "checksum_sha256": release.checksum_sha256,
        "released_at": release.released_at.isoformat(),
        "changelog_url": release.changelog_url,
    }
```

### A.9 — `services/hive-releases-api/tests/test_current.py` (MODIFY)

Adapt 4 → 5 tests with mocked DB session. Drop the seed-file integrity test (A.2 leftover); add 2 DB-mock tests:

```python
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone
from httpx import AsyncClient, ASGITransport

from main import app
from models import Release


@pytest.fixture
def fake_release():
    return Release(
        version="1.5.0",
        tarball_url="https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz",
        checksum_sha256="0000000000000000000000000000000000000000000000000000000000000000",
        released_at=datetime(2026, 5, 6, tzinfo=timezone.utc),
        changelog_url="https://neato-hive-site.vercel.app/changelog.html",
        release_notes_summary=None,
        deprecated_at=None,
    )


def make_session_mock(returns):
    session = MagicMock()
    session.execute.return_value.scalar_one_or_none.return_value = returns
    return session


@pytest.mark.asyncio
async def test_api_current_returns_200(fake_release):
    with patch("routers.current.get_session", return_value=iter([make_session_mock(fake_release)])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/current")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_api_current_response_shape(fake_release):
    with patch("routers.current.get_session", return_value=iter([make_session_mock(fake_release)])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/current")
    body = response.json()
    assert set(body.keys()) == {"version", "tarball_url", "checksum_sha256", "released_at", "changelog_url"}


@pytest.mark.asyncio
async def test_api_current_returns_db_data(fake_release):
    """Mocked DB row content surfaces correctly through the route."""
    with patch("routers.current.get_session", return_value=iter([make_session_mock(fake_release)])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/current")
    body = response.json()
    assert body["version"] == "1.5.0"
    assert body["checksum_sha256"] == "0000000000000000000000000000000000000000000000000000000000000000"


@pytest.mark.asyncio
async def test_api_current_500_on_no_active_release():
    """When DB returns no rows, route returns 500 with structured error."""
    with patch("routers.current.get_session", return_value=iter([make_session_mock(None)])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/current")
    assert response.status_code == 500
    assert "no active release found" in response.text


@pytest.mark.asyncio
async def test_auth_middleware_passthrough(fake_release):
    """v1.5.0 no-op middleware passes all requests through unchanged."""
    with patch("routers.current.get_session", return_value=iter([make_session_mock(fake_release)])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/current")
    assert response.status_code == 200
```

5 tests total, all mocked. Exact mock-injection pattern may need adjustment depending on how FastAPI's `Depends` resolves with patching — worker tunes during implementation if needed; documents in PR body.

### A.10 — `services/hive-releases-api/cloudbuild.yaml` (MODIFY)

Insert `migrate` step between `push` and `deploy`, mirroring lore D.3 option α (cloud-sql-proxy downloaded at runtime + socket-wait + alembic upgrade head). Update `availableSecrets` block to include `DB_PASSWORD` reference for the migrate step.

Migrate step (insert between current `push` and current `deploy`):

```yaml
  - id: migrate
    name: 'us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api:$COMMIT_SHA'
    entrypoint: bash
    secretEnv: ['DB_PASSWORD']
    args:
      - -c
      - |
        set -euo pipefail
        mkdir -p /workspace/cloudsql /workspace/bin
        python - <<'PY'
        import os
        import stat
        import urllib.request

        target = "/workspace/bin/cloud-sql-proxy"
        if not os.path.exists(target):
            url = "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.18.3/cloud-sql-proxy.linux.amd64"
            urllib.request.urlretrieve(url, target)
            os.chmod(
                target,
                os.stat(target).st_mode
                | stat.S_IXUSR
                | stat.S_IXGRP
                | stat.S_IXOTH,
            )
        PY
        /workspace/bin/cloud-sql-proxy --unix-socket=/workspace/cloudsql neato-os:us-central1:neato-os-db &
        PROXY_PID=$$!
        cleanup() {
          kill "$$PROXY_PID" 2>/dev/null || true
        }
        trap cleanup EXIT
        for i in {1..20}; do
          [ -S /workspace/cloudsql/neato-os:us-central1:neato-os-db/.s.PGSQL.5432 ] && break
          sleep 0.5
        done
        [ -S /workspace/cloudsql/neato-os:us-central1:neato-os-db/.s.PGSQL.5432 ] || {
          echo "proxy socket never appeared"
          exit 1
        }
        cd /app
        APP_ENV=development \
        DB_USER=hive_releases_user \
        DB_NAME=hive_releases \
        DB_PASSWORD="$$DB_PASSWORD" \
        CLOUD_SQL_CONNECTION_NAME=neato-os:us-central1:neato-os-db \
        CLOUD_SQL_SOCKET_DIR=/workspace/cloudsql \
          alembic upgrade head
```

The `availableSecrets` block at the bottom of cloudbuild.yaml already references `hive-releases-db-password` per A.3 — no change needed there. Only the migrate step is added.

### A.11 — `services/hive-releases-api/requirements.txt` (MODIFY)

Add to the existing list:

```
sqlalchemy==2.0.36
alembic==1.13.3
psycopg[binary]==3.2.3
```

`psycopg[binary]` includes the C-extension build — no runtime compilation needed. Worker pins versions at point-in-time stable (matches A.2 pattern).

### A.12 — `services/hive-releases-api/README.md` (MODIFY)

Replace the existing "Local dev" / "Test" sections with updated versions that reflect DB-backed reads + add a "Database" section:

```markdown
## Database

Service reads from a Postgres `releases` table in the `hive_releases` database on `neato-os-db` Cloud SQL instance. Schema managed via Alembic.

### Schema
Single table `releases` with forward-flex columns: `id` (UUID PK), `version` (unique), `tarball_url`, `checksum_sha256`, `released_at`, `changelog_url`, `release_notes_summary`, `deprecated_at`. Index `releases_version_active_idx ON (released_at DESC) WHERE deprecated_at IS NULL` makes the "current release" query (`SELECT ... ORDER BY released_at DESC LIMIT 1`) constant-time.

### Migrations
\`\`\`bash
cd services/hive-releases-api
alembic upgrade head    # apply all pending migrations
alembic revision -m "add foo"  # create new migration scaffold
\`\`\`

Migrations run automatically on every Cloud Build deploy via the `migrate` step in `cloudbuild.yaml` (between `push` and `deploy`). Local dev migrations require `gcloud sql connect` or cloud-sql-proxy running.

### Forward-flex
Future tables (`users`, `installs`, `skills`) for v1.5.x Clerk activation, install telemetry, and skill-shop registry will land as additive Alembic migrations without touching the existing `releases` schema. See `docs/v1.5.0-tasks/A.5-db-schema-migration.md` Decision D.

### Local test
\`\`\`bash
python3 -m pytest tests/ -v
\`\`\`

Tests use mocked DB session (no Postgres required for test runs).
```

---

## B. Tests (run during the worker turn)

```bash
cd services/hive-releases-api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m pytest tests/ -v
```

Expected: `5 passed in <2s` (4 → 5 tests, DB-mocked).

Local Alembic offline-mode validation (proves migrations are syntactically valid):

```bash
cd services/hive-releases-api
DB_USER=test DB_PASSWORD=test DB_NAME=test alembic upgrade head --sql > /tmp/A.5-alembic-offline.sql
head -30 /tmp/A.5-alembic-offline.sql
```

Expected: SQL DDL output containing `CREATE TABLE releases`, `CREATE INDEX releases_version_active_idx`, `INSERT INTO releases`. Confirms migrations parse + render without requiring live DB.

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY 13 files under `services/hive-releases-api/` (8 new + 5 modify). No edits elsewhere.
- [ ] `python3 -m pytest tests/ -v` → 5/5 pass
- [ ] `alembic upgrade head --sql` (offline mode) renders valid SQL (CREATE TABLE + CREATE INDEX + INSERT visible)
- [ ] `routers/current.py` no longer reads from `seed/releases.json` (grep returns empty for `seed`/`releases.json`)
- [ ] `seed/releases.json` UNCHANGED (kept as backup; verify file content matches A.2 byte-for-byte)
- [ ] `models.py` `Release` columns match migration columns exactly (column types, nullable, defaults)
- [ ] `cloudbuild.yaml` has `migrate` step between `push` and `deploy` (verifiable by `yq` or `grep`)
- [ ] `cloudbuild.yaml` `availableSecrets` block references `hive-releases-db-password` (already there per A.3 — confirm no regression)
- [ ] Dockerfile UNCHANGED (verifiable by hash comparison vs `main`)
- [ ] PR body contains: pre-flight 1-7 outputs, alembic offline-mode SQL render head, test count, diff-lock confirmation

---

## D. When done (DONE block template for Bob to fill)

```text
PR URL: <gh url>
Diff: 13 files (8 new + 5 modify) under services/hive-releases-api/

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. service directory shape: A.2/A.3/A.4 ✓, A.5 targets absent ✓
  3. Cloud SQL: RUNNABLE, databases: lore + postgres (no hive_releases yet — owner-side step pending)
  4. DB users: lore_user + postgres (no hive_releases_user yet — owner-side step pending)
  5. Cloud Run + trigger: NOT_FOUND (Cloud Build GitHub App install pending — expected)
  6. cloudbuild.yaml current shape: 4 steps (build, push, deploy, bind-public-invoker) ✓
  7. Test baseline: 4 passed (A.2 baseline) ✓

Alembic offline render:
  alembic upgrade head --sql | head -30
  <verbatim — expecting CREATE TABLE releases, CREATE INDEX, INSERT INTO releases>

Test results:
  python3 -m pytest tests/ -v
  <verbatim, expecting 5 passed>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-A.5-db-schema-migration
  <verbatim — every line must start with services/hive-releases-api/>

Production migrate status: DEFERRED — runs automatically on first Cloud Build deploy post-GitHub-App-install. Owner-side DB + user + secret steps required before migrate succeeds end-to-end (see §F in spec).

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — all 13 files in single PR. If pre-flight reveals scope expansion (existing alembic/, db.py, models.py — all listed in pre-flight #2 with HALT instruction), HALT and ping house-md via SendMessage with kind=delegation.
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop.
- **DO NOT RUN PRODUCTION MIGRATE** — worker DOES NOT attempt to run `alembic upgrade head` against production DB. Production migrate fires automatically on first Cloud Build deploy post-GitHub-App-install. Worker only validates Alembic syntax via offline mode (`--sql` flag).
- **DO NOT TOUCH SECRETS** — worker DOES NOT generate or touch real DB passwords. Secret rotation is owner-side step (§F).
- **`gh repo clone` not SSH** for fresh clones; remote-URL check before any cleanup, never blanket `rm -rf`.
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (diff lock, alembic offline render, 5 tests pass, PR body fields), then ping house-md via SendMessage with kind=delegation.
- **HALT-and-ping rule (C.2-v1 lesson, carried from lore)** — pre-flight surprises stop the worker; no improvising past the spec.

---

## F. Owner-side steps (run BEFORE OR AFTER Bob's PR ships, not during worker turn)

These three steps must happen before the migrate step succeeds end-to-end. Each is idempotent within reason — owner runs once. Order matters: DB → user → secret.

```bash
# 1. Create the hive_releases database on the existing neato-os-db instance
gcloud sql databases create hive_releases --instance=neato-os-db --project=neato-os

# 2. Generate a strong password and create the DB user
PASSWORD=$(openssl rand -base64 32)
gcloud sql users create hive_releases_user \
  --instance=neato-os-db \
  --password="${PASSWORD}" \
  --project=neato-os

# 3. Add the password as a new version of the placeholder secret
printf '%s' "${PASSWORD}" | gcloud secrets versions add hive-releases-db-password \
  --data-file=- \
  --project=neato-os

# 4. Verify
gcloud sql databases list --instance=neato-os-db --project=neato-os | grep hive_releases
gcloud sql users list --instance=neato-os-db --project=neato-os | grep hive_releases_user
gcloud secrets versions list hive-releases-db-password --project=neato-os | head -3
```

**After these steps + the Cloud Build GitHub App install on `anthonyconnelly/neato-hive`:** the next push to framework `main` fires the trigger → builds → migrates (creates `releases` table + seeds v1.5.0 row) → deploys hive-releases-api → bind-public-invoker → service live. From there, `curl ${SERVICE_URL}/api/current` returns the JSON sourced from DB. A.5 verifies end-to-end at that point.

**Phase A complete on A.5 merge.** Phase B (release script) opens.

---

## G. Forward links

- Phase B — Release script in framework repo (`scripts/release-hive-tarball.sh` or similar). Reads version from package.json or `bin/hive --version`, builds tarball, computes sha256, uploads to Vercel-hosted releases path, updates `releases` table via authenticated API call OR direct DB INSERT (Phase B leaf decides).
- v1.5.x — Clerk activation: rotates `hive-releases-clerk-secret-key` + `hive-releases-clerk-webhook-secret`, edits cloudbuild.yaml to add Clerk env vars to `--set-secrets`, activates `auth_middleware()` insertion point shipped in A.2 — middleware extracts Bearer token, verifies via Clerk JWKS, restricts to `@neato.com` email domain.
- v1.5.x post-Clerk — `users` table additive migration (Clerk identity), `installs` table (telemetry), `skills` table (skill-shop registry). Each as own Alembic migration, additive only, no touch to `releases` schema.
