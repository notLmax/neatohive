# hive-releases-api

## Purpose

Public API for Hive release metadata, intended to sit behind Vercel rewrites and provide the current release payload for `hive update`.

## Database

Service reads from a Postgres `releases` table in the `hive_releases` database on the `neato-os-db` Cloud SQL instance. Schema changes are managed with Alembic and `/api/current` now reads the newest non-deprecated row from the database instead of the seed file.

### Schema

Single table `releases` with forward-flex columns: `id` (UUID primary key), `version` (unique), `tarball_url`, `checksum_sha256`, `released_at`, `changelog_url`, `release_notes_summary`, and `deprecated_at`. The partial index `releases_version_active_idx` on `released_at DESC` where `deprecated_at IS NULL` supports the current-release lookup.

### Migrations

```bash
cd services/hive-releases-api
alembic upgrade head
alembic revision -m "add foo"
```

Cloud Build runs `alembic upgrade head` automatically in the `migrate` step between `push` and `deploy`. Local migration runs need either Cloud SQL socket access or an explicit `DATABASE_URL`.

### Forward-flex

Future `users`, `installs`, and `skills` tables can land as additive Alembic migrations without changing the existing `releases` contract.

## Local dev

```bash
uvicorn main:app --reload --port 8080
```

## Test

```bash
python3 -m pytest tests/ -v
```

Tests use a mocked SQLAlchemy session, so Postgres is not required for routine test runs.

## Deploy

Provisioning (one-time, run via machine-level `glados@neato-os` gcloud auth):

```bash
bash infra/v1.5.0/04-cloud-run.sh
bash infra/v1.5.0/05-cloud-build-trigger.sh
```

After provisioning, push to `main` on the framework repo auto-fires `hive-releases-api-deploy`, which:
1. Builds the Docker image
2. Pushes it to Artifact Registry (`us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api`)
3. Deploys the service to Cloud Run (`us-central1`)
4. Binds `allUsers` to `roles/run.invoker` as the Neato org-policy workaround

Secret Manager placeholders created by `04-cloud-run.sh`:
- `hive-releases-db-password` for A.5 DB wiring
- `hive-releases-clerk-secret-key` for future Clerk activation
- `hive-releases-clerk-webhook-secret` for future Clerk webhook activation

The Cloud SQL connector is wired preemptively in `cloudbuild.yaml` with `--add-cloudsql-instances=neato-os:us-central1:neato-os-db`, so A.5 can rotate secrets and add DB reads without reworking deploy plumbing.

## Auth model

The Cloud Run service is public for v1.5.0 and can be reached through Vercel rewrites. Clerk activation in v1.5.x reuses the existing middleware insertion point in `middleware/auth.py`.
