# v1.5.0 A.4 — Vercel Deploy + `vercel.json` Rewrites + Smoke (DEFERRED)

**Status:** DRAFT — glados-drafted, awaiting house-md review/counter/greenlight before Bob dispatch
**Project:** v1.5.0-website-installer-dashboard
**Phase:** A — Site repo + Cloud Run backend skeleton
**Leaf:** A.4 (4 of 6 in Phase A)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop — owner directive 2026-05-06 via task `t-mouojpd4000i`)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** A.3 ✅ merged 2026-05-06 — PR #47 squash `a6ed66e` (03:30:54Z)
**Successor:** A.5 — DB schema + first migration + DB-backed swap

---

## Goal

Wire same-origin proxy from `https://neato-hive-site.vercel.app/api/*` → `https://hive-releases-api-xxx-uc.a.run.app/api/*` via Vercel rewrites in `vercel.json` (per Q6 / Decision A2 — mirrors lore C.1 pattern: no CORS, no mixed-content, single domain owner manages).

Plus fix the `scripts/provision-v1.5.0.sh` `ensure_project_link()` idempotent false-positive (the ~5-line edit captured in A.4 brief from earlier today: `vercel git connect` exits non-zero when link already exists; current script treats non-zero as failure and prints "Vercel GitHub integration is not installed" — incorrect when integration IS installed).

**Smoke is DEFERRED** — first end-to-end test of the proxy chain requires Cloud Run service to be live, which requires Cloud Build trigger to fire on push, which requires the Cloud Build GitHub App to be installed on `anthonyconnelly/neato-hive` (the F.0-equivalent gap captured in A.3 PR #47). Owner can't install right now per house-md t-mov1v5kn000m.

A.4 ships:
- (a) `vercel.json` rewrites in site repo with placeholder URL
- (b) provision script fix in framework repo
- (c) smoke runbook embedded in this spec for owner to fire manually after the GitHub App install

A.5 unblocks regardless — it's a framework-repo + Cloud Run leaf, doesn't depend on Vercel proxy being smoke-verified.

---

## Pre-conditions

- A.3 ✅ merged (PR #47 squash `a6ed66e` on framework `main`); `services/hive-releases-api/cloudbuild.yaml` + `infra/v1.5.0/04-cloud-run.sh` + `infra/v1.5.0/05-cloud-build-trigger.sh` shipped
- Site repo `Daniel-Neato/neato-hive-site` post-A.1 (HTML pages live; site rendering at https://neato-hive-site.vercel.app)
- Vercel GitHub App installed on `Daniel-Neato/neato-hive-site` (owner-installed earlier per house-md t-mounueu2000f, verified via Vercel API: `link.gitCredentialId=cred_3436a8af8...`)
- **Owner-side TODO surfaced post-A.3 (NOT blocking A.4 ship — only A.4 smoke):** Cloud Build GitHub App not yet installed on `anthonyconnelly/neato-hive`. Captured in v1.5.0 project file Owner-side TODOs section.

---

## Where state lives (A.4 conventions)

A.4 is a **multi-repo leaf** (two PRs):

- **Site repo PR (`Daniel-Neato/neato-hive-site`):** `vercel.json` at repo root. Branch: `feat/v1.5.0-A.4-vercel-rewrites`.
- **Framework repo PR (`anthonyconnelly/neato-hive`):** `scripts/provision-v1.5.0.sh` fix-up. Branch: `feat/v1.5.0-A.4-provision-script-fix`.

Two PRs mirror the A.1 multi-repo pattern (site PR `Daniel-Neato/neato-hive-site#1` + framework PR `#45`). Bob ships them sequentially in the same worker turn (single-executor Hard Rule #4 — but both are tiny, single-file changes; can be batched).

Smoke runbook lives in this spec (§E) — owner runs it manually after the Cloud Build GitHub App install lands.

---

## Pre-flight (verify before drafting the diff)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: `e8cd8a1` (A.3 spec) or `a6ed66e` (A.3 merge) at HEAD or close.

### 2. Site repo current state

```bash
gh repo clone Daniel-Neato/neato-hive-site /tmp/A.4-site-repo-checkout 2>/dev/null || (cd /tmp/A.4-site-repo-checkout && git checkout main && git pull origin main)
ls /tmp/A.4-site-repo-checkout/
test -f /tmp/A.4-site-repo-checkout/public/index.html && echo "A.1 site HTML: ✓" || echo "A.1 site HTML: ✗"
test -f /tmp/A.4-site-repo-checkout/vercel.json && echo "vercel.json EXISTS: HALT — investigate" || echo "vercel.json: not yet present (expected pre-A.4)"
```

Expected: `public/index.html` + `public/install.html` + `public/changelog.html` + `public/styles.css` from A.1. No `vercel.json` yet — A.4 creates it. **HALT and ping house-md if vercel.json already exists** (out-of-band edit).

### 3. Vercel project state

```bash
vercel project inspect neato-hive-site --yes 2>&1 | head -20
```

Expected: project `prj_W6rhgODPR0B1Dq5nOcRhl2NTSvzj`, framework `Other`, link healthy.

### 4. Cloud Run service state — should be NOT_FOUND (owner hasn't installed Cloud Build GitHub App yet)

```bash
gcloud run services describe hive-releases-api --region=us-central1 --project=neato-os --format='value(status.url)' 2>&1 | head -3
```

Expected: `ERROR: ... NOT_FOUND` (the service hasn't been first-deployed because the trigger hasn't fired). If it DOES exist (owner installed the GitHub App between A.3 close and A.4 dispatch), worker captures the URL in PR body and the smoke runbook can be made non-deferred.

### 5. Provision script current shape (confirm the `vercel git connect` false-positive bug)

```bash
cd ~/neato-hive
grep -nA 8 "ensure_project_link\(\)" scripts/provision-v1.5.0.sh 2>&1 | head -20
```

Expected: function definition where `vercel git connect` exit-non-zero is treated as error. Worker reads to confirm the fix surface before editing.

---

## A. Deliverables

### A.1 — Site repo PR: `vercel.json` rewrites

**Branch:** `feat/v1.5.0-A.4-vercel-rewrites` on `Daniel-Neato/neato-hive-site`.

**Diff lock:** ONLY `vercel.json` at repo root. No edits to `public/*`, README, or anything else.

**File content** (`vercel.json`):
```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://hive-releases-api-CLOUD_RUN_HASH_PLACEHOLDER-uc.a.run.app/api/:path*"
    }
  ]
}
```

**Placeholder explanation in README addition (NEW section, separate from `vercel.json` itself):**

A.4 ships `vercel.json` with a literal placeholder string `CLOUD_RUN_HASH_PLACEHOLDER` because the actual Cloud Run service URL hash is generated on first deploy and isn't human-predictable in advance. Owner-side post-deploy step (in §E smoke runbook) replaces the placeholder with the real hash from `gcloud run services describe hive-releases-api ... --format='value(status.url)'`.

**Why placeholder approach over Vercel env-var interpolation:**
- This site is plain static HTML — no Next.js / no SSR — Vercel `rewrites` `destination` field requires a literal URL string for static deployments. Env-var interpolation in `destination` is a Next.js-specific feature that doesn't apply here.
- The placeholder makes the un-substituted state obvious — anyone reviewing `vercel.json` post-A.4 sees `CLOUD_RUN_HASH_PLACEHOLDER` and immediately knows the smoke runbook hasn't been completed.
- A.5 doesn't require this URL to be live — A.5 swaps the seed-file source in `routers/current.py` to a DB query, which only affects backend behavior; the proxy URL is unchanged.

**Worker action:** create `vercel.json` exactly as shown above. Open PR with title `feat(v1.5.0): A.4 Vercel rewrites for /api/* proxy to Cloud Run`. PR body includes:
- Pre-flight outputs 1-5
- Diff: 1 file (`vercel.json`)
- Explicit note that placeholder must be replaced by owner per §E smoke runbook
- Smoke status: DEFERRED — explain Cloud Build GitHub App install on `anthonyconnelly/neato-hive` is the gating prerequisite

### A.2 — Framework repo PR: provision script fix

**Branch:** `feat/v1.5.0-A.4-provision-script-fix` on `anthonyconnelly/neato-hive`.

**Diff lock:** ONLY `scripts/provision-v1.5.0.sh`. No other edits.

**Fix shape** (~5-line edit per house-md's earlier estimate):

The `ensure_project_link()` function currently treats any non-zero exit from `vercel git connect` as an installation failure. But `vercel git connect` exits non-zero when the link already exists (idempotent re-run case). Fix: capture the command's stderr and parse for the "already connected" signal; treat that as success. Pseudocode pattern:

```bash
ensure_project_link() {
  local output
  output=$(vercel git connect "${REPO}" --yes 2>&1)
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then
    echo "==> Vercel git connection established."
    return 0
  fi
  # Idempotent re-run case: vercel CLI exits non-zero when link already exists.
  # Parse stderr for the "already connected" signal and treat as success.
  if echo "${output}" | grep -qiE "already (connected|linked|exists)"; then
    echo "==> Vercel git connection already established (idempotent re-run, treating as success)."
    return 0
  fi
  echo "==> ERROR: Vercel git connect failed:"
  echo "${output}" | head -10
  return $exit_code
}
```

**Worker action:** read existing `ensure_project_link()`, apply the parsing pattern above (exact strings may need adjustment based on actual `vercel git connect` output format — worker captures the actual output during pre-flight #5 and tunes the regex). Open PR with title `fix(v1.5.0): A.4 provision script idempotent vercel git connect`. PR body includes:
- Pre-flight #5 verbatim output (showing the bug)
- Diff: 1 file (`scripts/provision-v1.5.0.sh`)
- Re-run verification: run `bash scripts/provision-v1.5.0.sh` post-fix, capture output showing the function returns success on idempotent re-run

---

## B. Tests (run during the worker turn)

For Site repo PR (`vercel.json`):
- `cat vercel.json | python3 -m json.tool` — verifies valid JSON
- No deploy test in worker turn (deploy auto-fires when PR merges to main; verification is in §E smoke runbook)

For Framework repo PR (provision script fix):
- `bash scripts/provision-v1.5.0.sh` post-fix — must exit 0 (currently fails on idempotent re-run)
- `bash scripts/provision-v1.5.0.sh` second time — must exit 0 (idempotent re-confirmation)

---

## C. Acceptance / hard gates

**Site repo PR:**
- [ ] Diff lock: ONLY `vercel.json` (no other paths)
- [ ] `vercel.json` is valid JSON (parses via `python3 -m json.tool`)
- [ ] `destination` field contains exact placeholder `CLOUD_RUN_HASH_PLACEHOLDER` (so smoke runbook §E can grep-and-sed it)
- [ ] PR body contains pre-flight outputs + DEFERRED-smoke note + reference to §E

**Framework repo PR:**
- [ ] Diff lock: ONLY `scripts/provision-v1.5.0.sh`
- [ ] Re-run `bash scripts/provision-v1.5.0.sh` post-fix exits 0 (was failing on idempotent re-run)
- [ ] Second re-run also exits 0 (idempotency confirmed)
- [ ] PR body contains pre-flight #5 verbatim + post-fix verification output

---

## D. When done (DONE block template for Bob to fill)

```text
SITE REPO PR: <gh url>
FRAMEWORK REPO PR: <gh url>

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. site repo state: index/install/changelog/styles.css ✓, no vercel.json (expected)
  3. Vercel project: prj_W6rhgODPR0B1Dq5nOcRhl2NTSvzj, framework=Other, link healthy
  4. Cloud Run hive-releases-api: NOT_FOUND (expected — owner GitHub App install pending)
  5. Provision script ensure_project_link() current shape: <function body verbatim>

Site repo deliverable:
  vercel.json content: <verbatim>
  JSON valid: ✓

Framework repo deliverable:
  ensure_project_link() diff: <unified diff verbatim>
  Re-run #1 (idempotent): <output, exit 0>
  Re-run #2 (idempotent): <output, exit 0>

Smoke status: DEFERRED — see §E runbook in spec; owner fires manually after Cloud Build GitHub App install on anthonyconnelly/neato-hive.

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## E. Smoke runbook (owner-fires manually post-GitHub-App-install)

**Prerequisites:**
- A.3 PR #47 merged (✓ already done)
- A.4 site repo PR merged (`vercel.json` live with `CLOUD_RUN_HASH_PLACEHOLDER`)
- A.4 framework repo PR merged (provision script fixed)
- **Owner installs Cloud Build GitHub App on `anthonyconnelly/neato-hive`** at GCP console → Cloud Build → Triggers → Connect Repository → GitHub. Same UI as the lore F.0 ceremony.
- After GitHub App install, owner runs `bash infra/v1.5.0/05-cloud-build-trigger.sh` from local framework checkout (script is idempotent — re-run safe).

**Smoke steps:**

```bash
# Step 1: trigger the first Cloud Build deploy via no-op commit to framework main
cd ~/neato-hive
git checkout main && git pull origin main
git commit --allow-empty -m "chore: A.4 smoke trigger first Cloud Build deploy"
git push origin main

# Step 2: monitor build progress (~3-5min)
gcloud builds list --project=neato-os --limit=3 --format='table(id,status,createTime)'
# OR open: https://console.cloud.google.com/cloud-build/builds?project=neato-os

# Step 3: capture Cloud Run service URL (after build completes successfully)
SERVICE_URL=$(gcloud run services describe hive-releases-api --region=us-central1 --project=neato-os --format='value(status.url)')
echo "Cloud Run URL: ${SERVICE_URL}"
# Expected: https://hive-releases-api-XXXXXX-uc.a.run.app
HASH=$(echo "${SERVICE_URL}" | sed -E 's|https://hive-releases-api-([^-]+)-uc\.a\.run\.app|\1|')
echo "Hash: ${HASH}"

# Step 4: smoke-test Cloud Run directly (proves backend is live)
curl -s "${SERVICE_URL}/api/current" | python3 -m json.tool
# Expected: 5-field JSON from A.2 static-seed handler

# Step 5: update vercel.json placeholder with real hash
gh repo clone Daniel-Neato/neato-hive-site /tmp/A.4-smoke-site
cd /tmp/A.4-smoke-site
sed -i.bak "s/CLOUD_RUN_HASH_PLACEHOLDER/${HASH}/" vercel.json
rm vercel.json.bak
cat vercel.json  # confirm hash substituted

# Step 6: commit + push site repo (Vercel auto-deploys via the GitHub App owner installed earlier)
git add vercel.json
git commit -m "chore: A.4 smoke replace Cloud Run hash placeholder in vercel.json"
git push origin main

# Step 7: wait ~30-60s for Vercel deploy to complete
sleep 60

# Step 8: smoke-test through Vercel rewrite (proves end-to-end proxy chain)
curl -s https://neato-hive-site.vercel.app/api/current | python3 -m json.tool
# Expected: same 5-field JSON as Step 4 — proves rewrite chain works

# Step 9: verify by opening in browser
open https://neato-hive-site.vercel.app/api/current
# Should render 5-field JSON in browser
```

**Success criteria:**
- Cloud Build trigger fires on framework push to main
- Cloud Run service `hive-releases-api` reaches Ready state
- `${SERVICE_URL}/api/current` returns valid JSON directly
- After vercel.json hash substitution + Vercel auto-deploy, `https://neato-hive-site.vercel.app/api/current` returns the same JSON via the proxy chain
- No CORS errors, no mixed-content errors

**If smoke fails:**
- Cloud Build fails: check build logs, possibly missing IAM roles (run `bash infra/v1.5.0/04-cloud-run.sh` and `bash infra/v1.5.0/05-cloud-build-trigger.sh` to reconcile)
- Cloud Run not Ready: check service logs (`gcloud run services logs read hive-releases-api --region=us-central1 --project=neato-os --limit=50`)
- Direct curl to Cloud Run fails: verify the `bind-public-invoker` step in cloudbuild.yaml ran (Neato GCP org policy strips `--allow-unauthenticated` so explicit IAM binding is needed)
- Vercel proxy returns 404 / 500: check Vercel deployment logs at https://vercel.com/<owner>/neato-hive-site, verify `vercel.json` is present in deployed source and rewrite syntax is valid

---

## Standing rules

- **DON'T HALF-SHIP** — both PRs (site + framework) ship in the same worker turn. Worker doesn't end mid-leaf with one PR open and the other not started.
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop.
- **HALT-and-ping rule** — if pre-flight reveals scope expansion (existing `vercel.json`, framework script structure differs from spec), HALT and ping house-md via SendMessage with kind=delegation.
- **`gh repo clone` not SSH** for fresh clones; remote-URL check before any cleanup, never blanket `rm -rf`.
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (both PRs open, JSON valid, provision script idempotent re-run exits 0), then ping house-md via SendMessage with kind=delegation.
- **Smoke is DEFERRED** — worker DOES NOT attempt to fire the smoke runbook (§E). That's owner-paced after the Cloud Build GitHub App install lands. Worker captures the deferral status in PR body explicitly.

---

## Forward links

- A.5 spec — `hive_releases` database creation + Alembic migration for `releases` table per Decision D + `routers/current.py` swap from seed-file to DB query + cloudbuild.yaml migrate step + `hive-releases-db-password` secret rotation. A.5 doesn't depend on A.4 smoke being complete; it's framework-repo + Cloud Run only. Will land at `docs/v1.5.0-tasks/A.5-db-schema-migration.md` (prep sketch from glados drafted in parallel with A.4).
- v1.5.x Clerk — `auth_middleware()` activation, rotates `hive-releases-clerk-secret-key` + `hive-releases-clerk-webhook-secret`, updates cloudbuild.yaml `--set-secrets=` to add Clerk env vars.
