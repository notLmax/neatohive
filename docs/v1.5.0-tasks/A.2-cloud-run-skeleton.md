# v1.5.0 A.2 — Cloud Run Backend Service Skeleton

**Status:** DRAFT — glados-drafted, awaiting house-md review/counter/greenlight before Bob dispatch
**Project:** v1.5.0-website-installer-dashboard
**Phase:** A — Site repo + Cloud Run backend skeleton
**Leaf:** A.2 (2 of 6 in Phase A)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop — owner directive 2026-05-06 via task `t-mouojpd4000i`: "you don't need glados to review these you and bob can work between each other")
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** A.1 ✅ merged 2026-05-06 — Site PR `Daniel-Neato/neato-hive-site#1` squash `3c9db14` (23:19:14Z) + framework PR `#45` squash `100c409` (23:19:21Z, templates snapshot)
**Successor:** A.3 — Cloud Run deploy + Cloud Build trigger + IAM + Secret Manager (mirror lore C.0 + D.3 patterns)

---

## Goal

Stand up the FastAPI service skeleton for `hive-releases-api` in the framework repo (`anthonyconnelly/neato-hive`) at `services/hive-releases-api/`. Service exposes `GET /api/current` returning JSON with the current Hive release (version, tarball URL, checksum, released_at, changelog URL).

**v1.5.0 reads from a static-config seed file** (`seed/releases.json`) per Decision C — the DB-backed swap is deferred to A.5 to keep A.2 focused on FastAPI surface + container shape, decoupled from DB connection wiring.

**No deploy in A.2.** Service runs locally for tests + manual curl. A.3 wires Cloud Build trigger, IAM, Secret Manager, and live deploy.

**Auth-middleware insertion point ships in A.2** — no-op middleware at `middleware/auth.py` with explicit docstring documenting how Clerk `@neato.com` restriction wires in for v1.5.x. v1.5.0 endpoints are public; the middleware exists so future Clerk activation is a wiring task, not a refactor (Decision A2).

---

## Pre-conditions

- A.1 ✅ merged (verified — framework `main` at `100c409`)
- v1.4.9 fleet on the machine
- Bob has machine-level gcloud auth (no SA-prep blocker per Decision A2 audit-trail)
- No additional GCP provisioning needed at A.2 stage (deploy is A.3)
- Python 3.11+ toolchain present for local test (verify in pre-flight 3)

---

## Where state lives (A.2 conventions)

- **Code path:** `services/hive-releases-api/` in framework repo (NEW directory — first leaf to populate `services/`)
- **Seed file:** `services/hive-releases-api/seed/releases.json` — static config, A.5 swaps to DB query
- **Tests:** `services/hive-releases-api/tests/` — pytest, runs against the local FastAPI app via `httpx.AsyncClient`
- **Container:** `services/hive-releases-api/Dockerfile` — Python 3.11 slim base, uvicorn runner, multi-stage if size matters
- **Service-level README:** `services/hive-releases-api/README.md` — purpose, local dev, tests, future-deploy pointer to A.3 spec

The framework repo's existing root `package.json` / `pnpm-lock.yaml` / `bin/hive` are NOT touched. A.2 is a self-contained Python service alongside the existing TypeScript framework.

---

## Pre-flight (verify before drafting the diff)

### 1. Confirm framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: `100c409` at HEAD (A.1 framework templates snapshot), `35c1428` previous (A.1 spec), `936ca6e` (A.0).

### 2. Confirm `services/` directory does NOT yet exist

```bash
ls -la services/ 2>&1 | head -5
```

Expected: `ls: services/: No such file or directory` — A.2 creates it fresh. **HALT and ping glados** if `services/` already exists with content (means another leaf or out-of-band work already populated it; reconcile before proceeding).

### 3. Confirm Python toolchain available

```bash
python3 --version
python3 -m pip --version
```

Expected: Python ≥ 3.11. **HALT and ping glados** if older — A.2 spec assumes 3.11+ for FastAPI compatibility and modern type-hint syntax.

### 4. Confirm root `package.json` and `pnpm-lock.yaml` not affected

```bash
cd ~/neato-hive
git diff --stat HEAD -- package.json pnpm-lock.yaml
```

Expected: empty output (no changes). The Python service is a sibling under `services/`, not a JS-level dep.

### 5. Confirm `gh` auth works against framework repo

```bash
gh auth status
gh repo view anthonyconnelly/neato-hive --json name,visibility
```

Expected: active account `Daniel-Neato`, framework repo visible. (Note: `glados-daniel-lorena` PAT also in keychain; both work for fetch/clone.)

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-A.2-cloud-run-skeleton`.

**Diff is LOCKED to the `services/hive-releases-api/` directory.** No edits to root, agents/, docs/, bin/, or any other top-level path.

### A.1 — `services/hive-releases-api/main.py`

FastAPI app entry. Imports the `current` router. Mounts auth middleware. Exposes the FastAPI `app` for uvicorn.

```python
from fastapi import FastAPI
from .routers import current
from .middleware.auth import auth_middleware

app = FastAPI(
    title="hive-releases-api",
    description="Public API for the Neato Hive release pipeline. Returns current release metadata for `hive update`.",
    version="0.1.0",
)

app.middleware("http")(auth_middleware)
app.include_router(current.router, prefix="/api")
```

### A.2 — `services/hive-releases-api/routers/current.py`

Reads `seed/releases.json`, returns the `current` field as JSON. Pydantic model for response shape.

Response shape (locked contract for v1.5.0):
```json
{
  "version": "1.5.0",
  "tarball_url": "https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz",
  "checksum_sha256": "<sha256>",
  "released_at": "2026-05-06T00:00:00Z",
  "changelog_url": "https://neato-hive-site.vercel.app/changelog.html"
}
```

A.5 will swap the seed-file read for a Cloud SQL query against the `releases` table (per Decision D schema), preserving the same response contract.

### A.3 — `services/hive-releases-api/middleware/auth.py`

No-op auth middleware for v1.5.0. Docstring explicitly documents how Clerk `@neato.com` restriction wires in for v1.5.x — extracts Bearer token, verifies via Clerk JWKS, checks email domain ends with `@neato.com`, returns 401 on any failure. The middleware exists so v1.5.x activation is a wiring task, not a refactor (per Decision A2).

```python
from fastapi import Request

async def auth_middleware(request: Request, call_next):
    """No-op auth middleware for v1.5.0.
    
    INSERTION POINT for v1.5.x Clerk @neato.com restriction:
      1. Extract Bearer token from Authorization header
      2. Verify via Clerk JWKS endpoint (env: CLERK_JWKS_URL)
      3. Check decoded email domain ends with @neato.com
      4. On any failure: return JSONResponse(status_code=401, content={"error": "unauthenticated"})
    
    v1.5.0 passes all requests through unchanged. Public Cloud Run + future-Clerk-aware design.
    """
    return await call_next(request)
```

### A.4 — `services/hive-releases-api/seed/releases.json`

Static config seed. v1.5.0 placeholder content. A.5 swaps to DB query (file remains as backup for emergency rollback or local-dev seeding).

```json
{
  "current": {
    "version": "1.5.0",
    "tarball_url": "https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz",
    "checksum_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "released_at": "2026-05-06T00:00:00Z",
    "changelog_url": "https://neato-hive-site.vercel.app/changelog.html"
  },
  "history": []
}
```

The placeholder `0000…` checksum gets replaced at J.2 release-tagging ceremony. v1.5.0 ships with the placeholder; consumers calling `hive update` against this endpoint pre-J.2 see a checksum that won't match any real tarball, which is the correct safe-default state (refuse to update on checksum mismatch — already in C.1 verify-step contract).

### A.5 — `services/hive-releases-api/Dockerfile`

Multi-stage Python 3.11 slim. Production-ready. Listens on `:8080` (Cloud Run convention).

```dockerfile
FROM python:3.11-slim AS base
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

### A.6 — `services/hive-releases-api/requirements.txt`

```
fastapi==0.115.0
uvicorn[standard]==0.32.0
pydantic==2.9.0
httpx==0.27.0
pytest==8.3.0
pytest-asyncio==0.24.0
```

Versions pinned at point-in-time stable. A.3 deploy may further pin via `pip install --no-deps` if reproducibility matters (defer that decision to A.3).

### A.7 — `services/hive-releases-api/tests/test_current.py`

Pytest with `httpx.AsyncClient` for FastAPI testing. 4 tests minimum:

1. **`test_api_current_returns_200`** — `/api/current` returns 200
2. **`test_api_current_response_shape`** — response JSON has all 5 fields (version, tarball_url, checksum_sha256, released_at, changelog_url)
3. **`test_seed_file_integrity`** — `seed/releases.json` exists, parses as valid JSON, has `current` key with all required fields
4. **`test_auth_middleware_passthrough`** — mocked Request through `auth_middleware()` returns `await call_next(request)` unchanged (verifies no-op behavior in v1.5.0)

All 4 must pass via `python3 -m pytest services/hive-releases-api/tests/ -v`.

### A.8 — `services/hive-releases-api/README.md`

Service-level README. Sections:
- **Purpose** — public API for Hive release metadata, served via Vercel rewrites
- **Local dev** — `uvicorn main:app --reload --port 8080`
- **Test** — `python3 -m pytest tests/ -v`
- **Future deploy** — pointer to `docs/v1.5.0-tasks/A.3-cloud-run-deploy.md` (does not yet exist; create reference forward)
- **Auth model** — public Cloud Run + Vercel rewrites; Clerk activation in v1.5.x via the existing middleware insertion point

---

## B. Tests (run during the worker turn)

```bash
cd services/hive-releases-api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m pytest tests/ -v
```

Expected: `4 passed in <1s`.

Manual smoke (worker captures output for PR body):

```bash
cd services/hive-releases-api && uvicorn main:app --port 8080 &
sleep 2
curl -s http://localhost:8080/api/current | python3 -m json.tool
kill %1
```

Expected: valid JSON matching the response contract, 5 fields present, version "1.5.0".

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY files under `services/hive-releases-api/` (no root, no docs, no bin, no agents)
- [ ] `python3 -m pytest services/hive-releases-api/tests/ -v` → 4/4 pass
- [ ] Manual curl `localhost:8080/api/current` returns valid JSON with 5 fields
- [ ] Auth middleware docstring explicitly enumerates the 4-step Clerk insertion-point recipe
- [ ] Dockerfile builds cleanly: `docker build -t hive-releases-api:test services/hive-releases-api/` exits 0
- [ ] Seed file shape matches Decision D `releases` table contract (forward-flex with same field names so A.5 DB swap is transparent)
- [ ] PR body contains: pre-flight outputs (1-5), test count, manual curl output verbatim, Dockerfile build result, diff-lock confirmation

---

## D. When done (DONE block template for Bob to fill)

```
PR URL: <gh url>
Diff: 8 files, ~250-350 LOC under services/hive-releases-api/

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. services/ existed before A.2: <yes/no — should be no>
  3. python3 --version: <version>
  4. root package.json/pnpm-lock unchanged: <true>
  5. gh auth status: <active account>

Test results:
  python3 -m pytest services/hive-releases-api/tests/ -v
  <verbatim output, expecting 4 passed>

Manual smoke:
  curl -s http://localhost:8080/api/current
  <verbatim JSON output>

Dockerfile build:
  docker build -t hive-releases-api:test services/hive-releases-api/
  <last 5 lines of output, expecting "Successfully tagged">

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-A.2-cloud-run-skeleton
  <verbatim — every line must start with services/hive-releases-api/>

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## Standing rules

- **DON'T HALF-SHIP** — all 8 files in single PR. If pre-flight reveals scope expansion (e.g. existing `services/` directory needs reconciliation), HALT and ping glados via SendMessage with kind=delegation. No silent workarounds.
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop.
- **DO NOT DEPLOY** — A.3 handles Cloud Build + IAM + Secret Manager + live deploy. A.2 is local-test-only.
- **`gh repo clone` not SSH** when cloning fresh (avoids host-key prompts). If cleaning a stale local clone, check `git remote get-url origin` matches expected before any cleanup — never blanket `rm -rf`.
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (diff lock, test count, manual curl output, Dockerfile build), then ping house-md via SendMessage with kind=delegation.
- **HALT-and-ping rule (C.2-v1 lesson)** — pre-flight surprises stop the worker; no improvising past the spec.

---

## Forward links

- A.3 spec — house-md or glados drafts after A.2 merges; covers Cloud Run deploy + Cloud Build trigger + IAM + Secret Manager. Pattern mirrors lore C.0 (`infra/04-cloud-run.sh`) + D.3 (`infra/05-cloud-build-trigger.sh`).
- A.5 spec — DB schema migration (Alembic) + seed-file → DB-query swap in `routers/current.py`. Preserves response contract from A.2.
- v1.5.x — Clerk `@neato.com` activation, wiring through the `auth_middleware()` insertion point shipped here.
