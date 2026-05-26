# v1.5.0 A.3 — Cloud Run Deploy + Cloud Build Trigger + IAM + Secret Manager

**Status:** DRAFT — glados-drafted, awaiting house-md review/counter/greenlight before Bob dispatch
**Project:** v1.5.0-website-installer-dashboard
**Phase:** A — Site repo + Cloud Run backend skeleton
**Leaf:** A.3 (3 of 6 in Phase A)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop — owner directive 2026-05-06 via task `t-mouojpd4000i`: "you don't need glados to review these you and bob can work between each other")
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** A.2 ✅ merged 2026-05-06 — PR #46 squash `d52a9b7` (00:23:43Z)
**Successor:** A.4 — Vercel deploy + `vercel.json` rewrites + smoke (Vercel rewrites `/api/*` to Cloud Run per Decision A2)

---

## Goal

Deploy `hive-releases-api` (FastAPI service from A.2) to Cloud Run on `neato-os` GCP project. Wire the full deploy pipeline:
- Cloud Run service provisioning + IAM bindings + Cloud SQL connector (forward-flex prep for A.5)
- Cloud Build trigger on push-to-main (framework repo) — auto-builds + pushes + deploys
- Secret Manager placeholders for `hive-releases-db-password` (A.5 will populate) + `hive-releases-clerk-secret-key` + `hive-releases-clerk-webhook-secret` (v1.5.x will populate)
- Runtime SA + Cloud Build SA IAM grants

**Pattern mirrors lore C.0 (`infra/04-cloud-run.sh`) + D.3 (`infra/05-cloud-build-trigger.sh`).** Where lore had `lore-api`, A.3 has `hive-releases-api`. Where lore had `lore-postgres-prod` (later retired), A.3 wires `neato-os-db` (shared instance hosting `lore` already + future `hive_releases` from A.5).

**Forward-flex preemption:** A.3 wires the Cloud SQL connector (`--add-cloudsql-instances=neato-os:us-central1:neato-os-db`) and `--set-secrets=` references for all expected secrets (DB_PASSWORD, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET) at A.3 time — even though A.2's static-seed handler doesn't read them. v1.5.0 runtime ignores them; A.5 + v1.5.x just rotate secret values via `gcloud secrets versions add`, no cloudbuild.yaml change, no redeploy plumbing required.

---

## Pre-conditions

- A.2 ✅ merged (PR #46 squash `d52a9b7` on framework `main`); `services/hive-releases-api/` exists with FastAPI app + Dockerfile
- v1.4.x fleet on machine; Bob has machine-level `glados@neato-os` gcloud auth (Decision A2 — no per-agent SA, no SA-prep blocker)
- Cloud SQL instance `neato-os-db` exists in `neato-os:us-central1` (lore-v2 verified live)
- Artifact Registry repo `us-central1-docker.pkg.dev/neato-os/neato-os/` exists (lore-api uses it; verified live)
- GitHub→Cloud Build connection at GCP-org level for `Daniel-Neato/lore` was just installed via Part F.0 (D.3 Part F ceremony) — **the framework repo `anthonyconnelly/neato-hive` may need its OWN GitHub App install if Bob's pre-flight surfaces no connection** (similar to lore D.3 pre-flight #2 surfacing F.0 was a real owner step, not ceremonial)

---

## Where state lives (A.3 conventions)

- **Provisioning scripts:** `infra/v1.5.0/04-cloud-run.sh` and `infra/v1.5.0/05-cloud-build-trigger.sh` (NEW directory `infra/v1.5.0/` to keep lore's `infra/` patterns and v1.5.0's separate)
- **Build pipeline:** `services/hive-releases-api/cloudbuild.yaml` (lives alongside the service code)
- **Runtime SA:** `hive-releases-api@neato-os.iam.gserviceaccount.com` (created by `04-cloud-run.sh`)
- **Cloud Run service:** `hive-releases-api` in `us-central1`
- **Cloud Build trigger:** `hive-releases-api-deploy` in `global` region (Cloud Build triggers are global; build steps run in `us-central1` per `cloudbuild.yaml options`)
- **Secrets in Secret Manager (`neato-os` project):**
  - `hive-releases-db-password` — placeholder value at A.3, A.5 rotates with real value
  - `hive-releases-clerk-secret-key` — placeholder, v1.5.x rotates
  - `hive-releases-clerk-webhook-secret` — placeholder, v1.5.x rotates

---

## Pre-flight (verify before drafting the diff)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: `d52a9b7` at HEAD or close (A.2 merge + any housekeeping commits). If A.3 is being run before A.2 has actually merged, HALT and ping house-md.

### 2. Verify `services/hive-releases-api/` exists post-A.2

```bash
ls services/hive-releases-api/
test -f services/hive-releases-api/main.py && echo "main.py: ✓" || echo "main.py: ✗"
test -f services/hive-releases-api/Dockerfile && echo "Dockerfile: ✓" || echo "Dockerfile: ✗"
test -f services/hive-releases-api/requirements.txt && echo "requirements.txt: ✓" || echo "requirements.txt: ✗"
```

Expected: all ✓. If any ✗, HALT — A.2 didn't ship correctly.

### 3. GitHub→Cloud Build connection check (CRITICAL — same shape as lore D.3 pre-flight #2)

```bash
gcloud builds connections list --region=us-central1 --project=neato-os 2>&1 | head -20
gcloud builds triggers list --project=neato-os --filter='github.owner=anthonyconnelly OR github.name=neato-hive' 2>&1 | head -10
```

Expected: at least one connection or trigger referencing `anthonyconnelly/neato-hive`. **If empty, worker NOTES the absence in PR body — F.0-equivalent owner-console step required before A.3 trigger can be created.** Worker continues with `services/hive-releases-api/cloudbuild.yaml` + `infra/v1.5.0/04-cloud-run.sh` deliverables which don't depend on the trigger existing yet. Trigger creation in `infra/v1.5.0/05-cloud-build-trigger.sh` either succeeds (if connection exists) or is deferred to an A.3 follow-up ceremony similar to lore D.3 Part F.

### 4. Confirm no existing `hive-releases-api` Cloud Run service or trigger

```bash
gcloud run services list --filter='metadata.name=hive-releases-api' --project=neato-os --region=us-central1 2>&1 | head -5
gcloud builds triggers describe hive-releases-api-deploy --project=neato-os --region=global 2>&1 | head -5
```

Expected: empty service list, "NOT_FOUND" trigger error. If either exists, HALT — investigate before proceeding (out-of-band provisioning happened).

### 5. Confirm Cloud SQL instance + Artifact Registry repo exist

```bash
gcloud sql instances describe neato-os-db --project=neato-os --format='value(state,connectionName)' 2>&1 | head -3
gcloud artifacts repositories describe neato-os --location=us-central1 --project=neato-os --format='value(name)' 2>&1 | head -3
```

Expected: Cloud SQL state `RUNNABLE`, connection name `neato-os:us-central1:neato-os-db`. AR repo exists. Both verified live in lore — these are pre-existing.

### 6. Confirm Cloud Build SA exists + capture project number

```bash
gcloud projects describe neato-os --format='value(projectNumber)'
```

Expected: numeric project number (used for Cloud Build SA: `<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com`).

### 7. Existing IAM bindings for Cloud Build SA (baseline before A.3 IAM grants)

```bash
PROJECT_NUMBER=$(gcloud projects describe neato-os --format='value(projectNumber)')
gcloud projects get-iam-policy neato-os --flatten='bindings[].members' \
  --filter="bindings.members:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --format='value(bindings.role)' 2>&1
```

Expected (post-D.3): includes `roles/cloudsql.client` (granted in D.3 for lore migrate step). A.3 adds `roles/run.admin` and `roles/iam.serviceAccountUser` if not already present — both idempotent via `add-iam-policy-binding`.

### 8. Local build test (Bob runs to confirm Dockerfile builds before pushing trigger setup)

```bash
cd ~/neato-hive/services/hive-releases-api
docker build -t hive-releases-api:preflight-test . 2>&1 | tail -10
```

Expected: "Successfully tagged" or equivalent. Confirms A.2's Dockerfile is sound before A.3 invests in deploy pipeline.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-A.3-cloud-run-deploy`.

**Diff is LOCKED to exactly 4 paths:**
1. `services/hive-releases-api/cloudbuild.yaml` (NEW — build pipeline)
2. `infra/v1.5.0/04-cloud-run.sh` (NEW — Cloud Run service + IAM + runtime SA + Cloud SQL connector)
3. `infra/v1.5.0/05-cloud-build-trigger.sh` (NEW — Cloud Build trigger + Cloud Build SA IAM grants + Secret Manager placeholders)
4. `services/hive-releases-api/README.md` (MODIFY — add "Deploy" section pointing at infra/v1.5.0/ scripts + cloudbuild.yaml; replace the "Future deploy" placeholder from A.2)

No other paths touched. No edits to `main.py` / `Dockerfile` / tests / requirements.

### A.1 — `services/hive-releases-api/cloudbuild.yaml`

Mirrors lore's `cloudbuild.yaml` structure. 4 steps for v1.5.0 (no migrate step yet — A.5 will insert one between push and deploy when DB schema lands):

```yaml
# Cloud Build pipeline for hive-releases-api (FastAPI on Cloud Run, neato-os).
#
# Trigger: push-to-main on anthonyconnelly/neato-hive (auto-fired by hive-releases-api-deploy).
#
# Steps:
#   1. Build Docker image from services/hive-releases-api/, tag with $COMMIT_SHA + latest.
#   2. Push both tags to Artifact Registry.
#   3. Deploy Cloud Run service hive-releases-api in us-central1.
#   4. Bind allUsers → run.invoker (Neato GCP org policy strips --allow-unauthenticated; explicit binding required).
#
# Future leaves:
#   - A.5: insert migrate step (alembic upgrade head) between push and deploy when DB schema lands.
#   - v1.5.x: add CLERK_SECRET_KEY + CLERK_WEBHOOK_SECRET to --set-secrets when middleware activates.

steps:
  - id: build
    name: 'gcr.io/cloud-builders/docker'
    args:
      - build
      - -t
      - 'us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api:$COMMIT_SHA'
      - -t
      - 'us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api:latest'
      - services/hive-releases-api

  - id: push
    name: 'gcr.io/cloud-builders/docker'
    args:
      - push
      - --all-tags
      - 'us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api'

  - id: deploy
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - run
      - deploy
      - hive-releases-api
      - '--image=us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api:$COMMIT_SHA'
      - '--region=us-central1'
      - '--platform=managed'
      - '--allow-unauthenticated'
      - '--port=8080'
      - '--memory=512Mi'
      - '--cpu=1'
      - '--min-instances=0'
      - '--max-instances=3'
      - '--service-account=hive-releases-api@neato-os.iam.gserviceaccount.com'
      - '--add-cloudsql-instances=neato-os:us-central1:neato-os-db'
      - '--set-env-vars=APP_ENV=production,DB_NAME=hive_releases,CLOUD_SQL_CONNECTION_NAME=neato-os:us-central1:neato-os-db,CLOUD_SQL_SOCKET_DIR=/cloudsql'
      - '--set-secrets=DB_PASSWORD=hive-releases-db-password:latest'

  # Workaround for Neato GCP org policy: --allow-unauthenticated above is silently
  # stripped, leaving the service with empty IAM bindings. Bind allUsers → run.invoker
  # explicitly post-deploy. Mirrors lore C.0 / D.3 pattern.
  - id: bind-public-invoker
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - run
      - services
      - add-iam-policy-binding
      - hive-releases-api
      - '--region=us-central1'
      - '--member=allUsers'
      - '--role=roles/run.invoker'

images:
  - 'us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api:$COMMIT_SHA'
  - 'us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api:latest'

options:
  logging: CLOUD_LOGGING_ONLY

availableSecrets:
  secretManager:
    - versionName: projects/neato-os/secrets/hive-releases-db-password/versions/latest
      env: DB_PASSWORD
```

**Note on `--set-secrets=DB_PASSWORD`:** placeholder value at A.3 time; A.2's static-seed handler doesn't read DB_PASSWORD so service starts cleanly. A.5 rotates via `gcloud secrets versions add hive-releases-db-password --data-file=-` AND swaps routers/current.py source from seed file to DB query. No cloudbuild.yaml change needed at A.5.

**Note on Clerk secrets (CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET):** NOT in `--set-secrets` at A.3. v1.5.x will edit cloudbuild.yaml to add them when middleware activates. Reason: Cloud Run will fail to start if `--set-secrets` references a non-existent secret-version (placeholder values are fine; missing secrets are not). A.3 creates the secret containers + grants IAM, but doesn't reference Clerk env vars in deploy yet.

### A.2 — `infra/v1.5.0/04-cloud-run.sh`

Single-shot idempotent reconciler for Cloud Run service + runtime SA + IAM + Secret Manager placeholders. Mirrors lore C.0 `infra/04-cloud-run.sh`. Pattern:
- Create runtime SA `hive-releases-api@` if not exists
- Grant runtime SA: `roles/cloudsql.client` (for A.5 DB query path), `roles/secretmanager.secretAccessor` on the 3 hive-releases-* secrets
- Create Secret Manager placeholders: `hive-releases-db-password`, `hive-releases-clerk-secret-key`, `hive-releases-clerk-webhook-secret` (each with placeholder value `placeholder-replace-at-A.5-or-v1.5.x`)
- Cloud Run service creation deferred to first cloudbuild.yaml deploy step (which is run by `infra/v1.5.0/05-...sh` first manual invocation OR by the Cloud Build trigger first push)

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT=neato-os
REGION=us-central1
RUNTIME_SA_NAME=hive-releases-api
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRETS=(hive-releases-db-password hive-releases-clerk-secret-key hive-releases-clerk-webhook-secret)
PLACEHOLDER_VALUE='placeholder-replace-at-A.5-or-v1.5.x'

# 1. Create runtime SA if not exists (idempotent)
echo "==> Verifying runtime SA ${RUNTIME_SA_EMAIL}..."
if gcloud iam service-accounts describe "${RUNTIME_SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "==> Runtime SA already exists. Skipping."
else
  echo "==> Creating runtime SA..."
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
    --display-name='hive-releases-api runtime SA (Cloud Run)' \
    --project="${PROJECT}"
fi

# 2. Grant runtime SA: roles/cloudsql.client (idempotent)
echo "==> Granting roles/cloudsql.client to runtime SA (idempotent)..."
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role='roles/cloudsql.client' \
  --condition=None \
  --quiet

# 3. Create Secret Manager placeholders + grant runtime SA accessor on each
for SECRET in "${SECRETS[@]}"; do
  echo "==> Verifying Secret Manager placeholder ${SECRET}..."
  if gcloud secrets describe "${SECRET}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "==> Secret ${SECRET} already exists. Skipping creation."
  else
    echo "==> Creating placeholder secret ${SECRET}..."
    echo -n "${PLACEHOLDER_VALUE}" | gcloud secrets create "${SECRET}" \
      --data-file=- \
      --replication-policy='automatic' \
      --project="${PROJECT}"
  fi

  echo "==> Granting roles/secretmanager.secretAccessor to runtime SA on ${SECRET} (idempotent)..."
  gcloud secrets add-iam-policy-binding "${SECRET}" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role='roles/secretmanager.secretAccessor' \
    --condition=None \
    --project="${PROJECT}" \
    --quiet
done

echo "==> 04-cloud-run.sh complete."
echo "    Runtime SA: ${RUNTIME_SA_EMAIL}"
echo "    Secrets: ${SECRETS[*]}"
echo "    Cloud Run service will be created on first cloudbuild.yaml deploy run."
```

### A.3 — `infra/v1.5.0/05-cloud-build-trigger.sh`

Single-shot idempotent reconciler for Cloud Build trigger + Cloud Build SA IAM grants. Mirrors lore D.3 `infra/05-cloud-build-trigger.sh`. Pattern:
- Trigger create-or-skip via `gcloud builds triggers describe`
- Cloud Build SA IAM grants: `roles/run.admin` (deploy step), `roles/iam.serviceAccountUser` (deploy as runtime SA), `roles/cloudsql.client` (already granted in lore D.3 — idempotent re-grant is no-op)

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT=neato-os
TRIGGER_NAME=hive-releases-api-deploy
REPO_OWNER=anthonyconnelly
REPO_NAME=neato-hive
BRANCH_PATTERN='^main$'
BUILD_CONFIG=services/hive-releases-api/cloudbuild.yaml
REGION=global

# Part 1 — Trigger create-or-skip
echo "==> Verifying Cloud Build trigger '${TRIGGER_NAME}'..."
if gcloud builds triggers describe "${TRIGGER_NAME}" --project="${PROJECT}" --region="${REGION}" >/dev/null 2>&1; then
  echo "==> Trigger '${TRIGGER_NAME}' already configured. Skipping."
else
  echo "==> Creating trigger '${TRIGGER_NAME}'..."
  gcloud builds triggers create github \
    --name="${TRIGGER_NAME}" \
    --repo-name="${REPO_NAME}" \
    --repo-owner="${REPO_OWNER}" \
    --branch-pattern="${BRANCH_PATTERN}" \
    --build-config="${BUILD_CONFIG}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --include-logs-with-status
fi

# Part 2 — Cloud Build SA IAM grants
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

for ROLE in roles/run.admin roles/iam.serviceAccountUser; do
  echo "==> Granting ${ROLE} to ${CLOUDBUILD_SA} (idempotent)..."
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${CLOUDBUILD_SA}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
done

# Note: roles/cloudsql.client was already granted in lore D.3. Re-granting is a no-op.

echo "==> 05-cloud-build-trigger.sh complete."
echo "    Trigger: ${TRIGGER_NAME} (push-to-main on ${REPO_OWNER}/${REPO_NAME})"
echo "    Cloud Build SA: ${CLOUDBUILD_SA}"
```

### A.4 — `services/hive-releases-api/README.md` modify

Replace the "Future deploy" placeholder section from A.2 with a real "Deploy" section pointing at infra/v1.5.0/ scripts + cloudbuild.yaml. Add Cloud Build trigger info + secret placeholder explanation.

```markdown
## Deploy

Provisioning (one-time, run by Bob via `glados@neato-os` gcloud auth):

\`\`\`bash
bash infra/v1.5.0/04-cloud-run.sh           # runtime SA + IAM + Secret Manager placeholders
bash infra/v1.5.0/05-cloud-build-trigger.sh # Cloud Build trigger + Cloud Build SA IAM grants
\`\`\`

After provisioning, push to `main` on the framework repo auto-fires `hive-releases-api-deploy` Cloud Build trigger which:
1. Builds Docker image
2. Pushes to Artifact Registry (us-central1-docker.pkg.dev/neato-os/neato-os/hive-releases-api)
3. Deploys to Cloud Run (us-central1)
4. Binds allUsers → run.invoker (Neato GCP org policy workaround)

**Secret Manager placeholders** (created by `04-cloud-run.sh`, populated later):
- `hive-releases-db-password` — A.5 rotates with real DB password when `hive_releases` database lands
- `hive-releases-clerk-secret-key` — v1.5.x rotates when middleware activates Clerk
- `hive-releases-clerk-webhook-secret` — v1.5.x rotates with Clerk webhook ceremony

**Cloud SQL connector** is wired preemptively (`--add-cloudsql-instances=neato-os:us-central1:neato-os-db` in cloudbuild.yaml deploy step) so A.5 doesn't need to redeploy the service.
```

---

## B. Tests (run during the worker turn)

```bash
# Pre-flight outputs captured (Bob fills PR body):
bash infra/v1.5.0/04-cloud-run.sh         # creates SA + secrets + IAM
bash infra/v1.5.0/05-cloud-build-trigger.sh  # creates trigger + Cloud Build SA IAM (or HALT if F.0-equivalent needed)

# Trigger first build manually (proves the pipeline end-to-end before relying on push-to-deploy):
gcloud builds submit --config=services/hive-releases-api/cloudbuild.yaml --substitutions=COMMIT_SHA=$(git rev-parse HEAD) .

# After build completes (~3-5min), verify Cloud Run service is live + serving:
SERVICE_URL=$(gcloud run services describe hive-releases-api --region=us-central1 --project=neato-os --format='value(status.url)')
curl -s "${SERVICE_URL}/api/current" | python3 -m json.tool
```

Expected: build succeeds, Cloud Run service `hive-releases-api` rev `hive-releases-api-00001-XXX` Ready, `/api/current` returns the static-seed JSON from A.2.

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY 4 paths (cloudbuild.yaml, 04-cloud-run.sh, 05-cloud-build-trigger.sh, services/hive-releases-api/README.md). No edits elsewhere.
- [ ] `bash infra/v1.5.0/04-cloud-run.sh` exits 0 idempotently (re-run MUST be no-op)
- [ ] `bash infra/v1.5.0/05-cloud-build-trigger.sh` exits 0 idempotently (re-run MUST be no-op) — UNLESS F.0-equivalent GitHub App install is missing, in which case worker captures the failure mode in PR body and defers trigger creation
- [ ] Manual `gcloud builds submit` completes successfully end-to-end (build → push → deploy → bind-public-invoker all green)
- [ ] Cloud Run service `hive-releases-api` reaches `Ready` state with `latestReadyRevisionName` set
- [ ] `curl ${SERVICE_URL}/api/current` returns valid JSON with all 5 fields (matches A.2 contract)
- [ ] Secret Manager has 3 placeholder secrets (`hive-releases-db-password`, `hive-releases-clerk-secret-key`, `hive-releases-clerk-webhook-secret`) with placeholder values
- [ ] Runtime SA `hive-releases-api@neato-os.iam.gserviceaccount.com` exists with `roles/cloudsql.client` + `roles/secretmanager.secretAccessor` on the 3 secrets
- [ ] Cloud Build SA has `roles/run.admin` + `roles/iam.serviceAccountUser` on the project
- [ ] `gcloud builds triggers describe hive-releases-api-deploy` succeeds (OR F.0-equivalent absence noted in PR body)
- [ ] PR body contains: pre-flight 1-8 outputs verbatim, manual build URL, Cloud Run service URL, curl /api/current output, IAM verification, secret list verification, diff-lock confirmation

---

## D. When done (DONE block template for Bob to fill)

```text
PR URL: <gh url>
Diff: 4 files (cloudbuild.yaml +N, 04-cloud-run.sh +N, 05-cloud-build-trigger.sh +N, README.md +N)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. services/hive-releases-api/ check: main.py ✓ Dockerfile ✓ requirements.txt ✓
  3. GitHub→Cloud Build connection check: <results — if empty, F.0-equivalent NOTED below>
  4. No existing service/trigger: <verified>
  5. Cloud SQL + AR repo: RUNNABLE / exists
  6. Project number: <number>
  7. Cloud Build SA baseline IAM: <roles list>
  8. Local docker build: SUCCESS

Provisioning runs:
  bash infra/v1.5.0/04-cloud-run.sh: <last 5 lines, exit 0>
  bash infra/v1.5.0/05-cloud-build-trigger.sh: <last 5 lines, exit 0 OR deferred-with-F.0-equivalent-note>

Manual build:
  gcloud builds submit --config=services/hive-releases-api/cloudbuild.yaml ...
  Build URL: <link>
  Status: SUCCESS, build-time: <duration>

Cloud Run:
  Service URL: <https://hive-releases-api-xxx-uc.a.run.app>
  Latest rev: hive-releases-api-00001-XXX (Ready)

Smoke:
  curl -s ${SERVICE_URL}/api/current
  <verbatim JSON output, expecting 5 fields from A.2>

Secret Manager (post-04-cloud-run.sh):
  hive-releases-db-password ✓ (placeholder)
  hive-releases-clerk-secret-key ✓ (placeholder)
  hive-releases-clerk-webhook-secret ✓ (placeholder)

IAM verification:
  Runtime SA roles/cloudsql.client ✓
  Runtime SA roles/secretmanager.secretAccessor on 3 secrets ✓
  Cloud Build SA roles/run.admin ✓
  Cloud Build SA roles/iam.serviceAccountUser ✓

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-A.3-cloud-run-deploy
  <verbatim — exactly 4 lines>

F.0-equivalent owner-side TODO (if surfaced by pre-flight 3):
  <description of needed GitHub App install on anthonyconnelly/neato-hive at GCP-org level, OR "N/A — connection already exists">

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## Standing rules

- **DON'T HALF-SHIP** — all 4 files in single PR. If pre-flight reveals scope expansion (e.g. existing Cloud Run service or trigger), HALT and ping house-md via SendMessage with kind=delegation. No silent workarounds.
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop.
- **HALT-on-F.0-equivalent** — if pre-flight #3 surfaces no GitHub→Cloud Build connection for `anthonyconnelly/neato-hive`, worker DOES NOT silently fail trigger creation. Worker completes the other 3 deliverables (cloudbuild.yaml, 04-cloud-run.sh, 05-cloud-build-trigger.sh — script will gracefully fail at create-trigger step) AND captures the F.0-equivalent owner-side TODO in PR body. Trigger creation deferred to a small follow-up ceremony (similar to lore D.3 Part F).
- **`gh repo clone` not SSH** when cloning fresh; remote-URL check before any cleanup, never blanket `rm -rf`.
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (diff lock, provisioning runs, manual build, Cloud Run smoke, IAM verification), then ping house-md via SendMessage with kind=delegation.
- **HALT-and-ping rule (C.2-v1 lesson, carried from lore)** — pre-flight surprises stop the worker; no improvising past the spec.

---

## Forward links

- A.4 spec — Vercel deploy + `vercel.json` rewrites + smoke. Wires `/api/*` proxy from `https://neato-hive-site.vercel.app/api/current` → `https://hive-releases-api-xxx-uc.a.run.app/api/current` per Q6 recommendation (same-origin, no CORS, mirrors lore C.1). Will need the Cloud Run URL from A.3's deploy.
- A.5 spec — DB schema (Alembic migration creating `releases` table per Decision D), seed-file → DB-query swap in `routers/current.py`, rotate `hive-releases-db-password` secret with real DB user password. Cloudbuild.yaml will gain a migrate step between push and deploy (mirroring lore D.3 pattern).
- v1.5.x — Clerk activation: rotate `hive-releases-clerk-secret-key` + `hive-releases-clerk-webhook-secret` with real Clerk values, edit cloudbuild.yaml to add them to `--set-secrets`, activate the auth_middleware insertion point shipped in A.2.
