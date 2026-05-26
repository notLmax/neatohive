# v1.5.0 B.2 — Site-Repo Push Automation (Phase B closing leaf)

**Status:** LOCKED — Phase B cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** B — Tarball release pipeline
**Leaf:** B.2 (2 of 2 in Phase B — Phase B closes on B.2 merge)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop — owner directive 2026-05-06 via task `t-mouojpd4000i`)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** B.1 ✅ merged 2026-05-07 14:39:08Z — PR #50 squash `079b0dc` (`scripts/release.sh` + `scripts/release-audit.sh` shipped)
**Successor:** Phase C — `hive update` rewrite (consumes the tarball this pipeline ships)

---

## Goal

Wire the publish half of the release pipeline. After B.1's `release.sh` produces `/tmp/neato-hive-v<version>.tar.gz` + `/tmp/neato-hive-v<version>.checksums.txt`, B.2 ships `scripts/release-publish.sh` which:

1. Clones (or refreshes) the site repo `Daniel-Neato/neato-hive-site` to a worktree under `/tmp/`
2. Copies the tarball + checksums sidecar into `releases/v<version>/`
3. Optionally copies a CHANGELOG snippet into `releases/v<version>/changelog.md`
4. Updates `releases/current.json` with the new release metadata
5. Updates `releases/index.json` (prepends new entry, sorted desc by `released_at`)
6. Commits + pushes to site repo `main` (Vercel auto-deploys via the GitHub App owner installed at A.0)

After B.2 merges, the full release pipeline is end-to-end: `bash scripts/release.sh <version> && bash scripts/release-publish.sh <version>` ships a release without manual git ops.

**Phase B closes on B.2 merge.** Phase C (`hive update` rewrite) opens, with this pipeline as the upstream producer.

**B.2 does NOT tag the framework repo.** Tagging (`git tag v<version> && git push --tags`) is owner-paced J.2 release ceremony (separate concern from the publish pipeline). B.2 keeps that discipline so dry-runs / test versions don't pollute git tags.

---

## Architectural givens (carried from prior decisions)

- **Site repo:** `Daniel-Neato/neato-hive-site` (private; owner-controlled)
- **Auth:** Bob's `gh` CLI is ambient-authenticated as `Daniel-Neato` (active account); no per-script auth setup needed. `gh repo clone` (NOT SSH) avoids host-key prompts.
- **Vercel auto-deploy:** Vercel GitHub App was installed by owner during A.0/A.4 for `Daniel-Neato/neato-hive-site`. Push to site repo `main` auto-fires deploy. No CLI auth required from B.2.
- **Tarball location:** input is `/tmp/neato-hive-v<version>.tar.gz` + `/tmp/neato-hive-v<version>.checksums.txt` (B.1 outputs)
- **Site repo target paths:**
  - `releases/v<version>/neato-hive-v<version>.tar.gz`
  - `releases/v<version>/neato-hive-v<version>.checksums.txt`
  - `releases/v<version>/changelog.md` (optional — extracted from framework `CHANGELOG.md` for that version)
  - `releases/current.json` (overwritten with new release metadata)
  - `releases/index.json` (prepended with new entry, sorted desc)
- **`current.json` shape** (5 fields, locked from canonical v1.5.0 spec):
  ```json
  {
    "version": "1.5.0",
    "tarball_url": "https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz",
    "checksum_sha256": "<sha>",
    "released_at": "<ISO 8601 UTC timestamp>",
    "changelog_url": "https://neato-hive-site.vercel.app/changelog.html"
  }
  ```
- **`index.json` shape** (array of release-summary entries, sorted desc by `released_at`):
  ```json
  [
    {"version": "1.5.0", "released_at": "2026-05-07T..."},
    {"version": "1.4.10", "released_at": "..."}
  ]
  ```
- **Vercel-default URL:** `https://neato-hive-site.vercel.app` (project ID `prj_W6rhgODPR0B1Dq5nOcRhl2NTSvzj` per A.0). Custom domain is a v1.5.x or post-v1.5.0 concern.
- **Dry-run support:** script ships with `--dry-run` flag. Worker uses dry-run during smoke tests to avoid polluting site repo with test commits. Live-smoke is owner-paced (or J.2 release ceremony).

---

## Pre-conditions

- B.1 ✅ merged (PR #50 squash `079b0dc`); `scripts/release.sh` + `scripts/release-audit.sh` present and working
- Bob has `gh` CLI ambient-authenticated as `Daniel-Neato` (verified earlier in v1.5.0 work)
- Site repo `Daniel-Neato/neato-hive-site` exists and is the live Vercel target
- Vercel GitHub App on site repo: ✅ installed (owner did this at A.0/A.4; verified via Vercel API)

---

## Where state lives (B.2 conventions)

- **Script:** `scripts/release-publish.sh` (NEW) at framework repo root
- **Worker scratch:** `/tmp/neato-hive-site-publish-<id>/` — where the script clones the site repo for the publish operation. Cleaned up on script exit (success or failure).
- **No new staging directory in framework repo** — `release-publish.sh` reads `/tmp/neato-hive-v<version>.{tar.gz,checksums.txt}` (B.1 outputs) directly; no intermediate staging.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-B.1)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
ls scripts/
```

Expected: HEAD at `079b0dc` (B.1 merge) or later. `scripts/` contains `release.sh`, `release-audit.sh`, `provision-v1.5.0.sh`, possibly other prior helpers. **HALT and ping house-md** if `release-publish.sh` already exists (out-of-band).

### 2. B.1 outputs sanity (release.sh runnable)

```bash
node -e "console.log('package.json version:', require('./package.json').version)"
bash -n scripts/release.sh && echo "release.sh syntactically valid: ✓"
bash -n scripts/release-audit.sh && echo "release-audit.sh syntactically valid: ✓"
```

Expected: Node prints version, both scripts pass `bash -n`. Confirms B.1 deliverables present and runnable.

### 3. gh CLI ambient auth state

```bash
gh auth status 2>&1 | head -10
gh api user --jq '.login' 2>&1
```

Expected: `Daniel-Neato` is the active account. **HALT and ping house-md** if active account is `glados-daniel-lorena` or anything else — the publish step will push under whichever account gh is active for, and `Daniel-Neato` is the canonical owner of the site repo.

### 4. Site repo accessible from current auth

```bash
gh repo view Daniel-Neato/neato-hive-site --json name,visibility,defaultBranchRef --jq '.'
```

Expected: returns repo metadata (private, default branch `main`). **HALT and ping house-md** if 404 / 403 — auth scope insufficient or repo path wrong.

### 5. Existing `releases/` structure on site repo (informational — captures baseline before B.2 first run)

```bash
gh repo clone Daniel-Neato/neato-hive-site /tmp/B.2-preflight-site-clone
ls /tmp/B.2-preflight-site-clone/releases/ 2>&1 || echo "releases/ does not exist yet (expected if no prior published release)"
test -f /tmp/B.2-preflight-site-clone/releases/current.json && cat /tmp/B.2-preflight-site-clone/releases/current.json || echo "current.json does not exist yet"
test -f /tmp/B.2-preflight-site-clone/releases/index.json && cat /tmp/B.2-preflight-site-clone/releases/index.json || echo "index.json does not exist yet"
rm -rf /tmp/B.2-preflight-site-clone
```

Expected: `releases/` directory may or may not exist (first run). Worker captures existing state — script must handle both "directory absent" and "directory present with prior content."

### 6. CHANGELOG.md sanity (used by script for snippet extraction)

```bash
test -f CHANGELOG.md && echo "CHANGELOG.md: ✓" || echo "CHANGELOG.md: ✗"
grep -nE '^## \[' CHANGELOG.md | head -5
```

Expected: CHANGELOG.md exists with `## [<version>]` entries. The script extracts the section for the current release version into `releases/v<version>/changelog.md` (markdown snippet).

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-B.2-site-repo-push-automation`.

**Diff lock: 1 path.**
- `scripts/release-publish.sh` (NEW)

No other files touched. No README updates (separate documentation leaf if needed). No edits to existing `release.sh`.

### A.1 — `scripts/release-publish.sh`

Bash script. Reads B.1's tarball outputs, clones site repo, updates metadata, commits + pushes. Idempotent within reason — re-runs overwrite existing release files (same SHA = no diff = no commit; new SHA = updated commit). Handles first-ever-release case (creates `releases/`, `current.json`, `index.json` from scratch).

```bash
#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/release-publish.sh — Publish a built tarball to the site repo.
#
# Usage:  ./scripts/release-publish.sh <version> [--dry-run]
#         e.g.  ./scripts/release-publish.sh 1.5.0
#         e.g.  ./scripts/release-publish.sh 1.5.0 --dry-run
#
# Reads:  /tmp/neato-hive-v<version>.tar.gz       (B.1 output)
#         /tmp/neato-hive-v<version>.checksums.txt (B.1 output)
#
# Pushes to:  Daniel-Neato/neato-hive-site main
#   releases/v<version>/neato-hive-v<version>.tar.gz
#   releases/v<version>/neato-hive-v<version>.checksums.txt
#   releases/v<version>/changelog.md (extracted from framework CHANGELOG)
#   releases/current.json (overwritten with new metadata)
#   releases/index.json (prepended with new entry, sorted desc)
#
# Push triggers Vercel auto-deploy on the site repo (Vercel GitHub App
# was installed by owner during A.0/A.4).
#
# Does NOT tag the framework repo. Tagging is owner-paced J.2 ceremony.
#-----------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

#-- Argument parsing -----------------------------------------------------
DRY_RUN=0
VERSION=""
for ARG in "$@"; do
  case "${ARG}" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: $0 <version> [--dry-run]"
      exit 0
      ;;
    *)
      if [ -z "${VERSION}" ]; then
        VERSION="${ARG}"
      else
        echo "ERROR: unexpected arg '${ARG}'"
        exit 2
      fi
      ;;
  esac
done

if [ -z "${VERSION}" ]; then
  echo "Usage: $0 <version> [--dry-run]"
  echo "  e.g. $0 1.5.0"
  echo "  e.g. $0 1.5.0 --dry-run"
  exit 2
fi

TARBALL="/tmp/neato-hive-v${VERSION}.tar.gz"
CHECKSUMS="/tmp/neato-hive-v${VERSION}.checksums.txt"
SITE_REPO="Daniel-Neato/neato-hive-site"
SITE_URL="https://neato-hive-site.vercel.app"
WORK_DIR="/tmp/neato-hive-site-publish-$$"

#-- Pre-flight checks ----------------------------------------------------
echo "==> Verifying B.1 outputs exist..."
for FILE in "${TARBALL}" "${CHECKSUMS}"; do
  if [ ! -f "${FILE}" ]; then
    echo "==> ERROR: ${FILE} not found. Run scripts/release.sh ${VERSION} first."
    exit 1
  fi
done
echo "    ${TARBALL}: ✓"
echo "    ${CHECKSUMS}: ✓"

echo "==> Verifying gh CLI active account is Daniel-Neato..."
GH_USER=$(gh api user --jq '.login' 2>/dev/null)
if [ "${GH_USER}" != "Daniel-Neato" ]; then
  echo "==> ERROR: gh CLI active account is '${GH_USER}', expected 'Daniel-Neato'."
  echo "==> Switch with: gh auth switch --user Daniel-Neato"
  exit 1
fi
echo "    Active GitHub account: ${GH_USER}"

echo "==> Verifying site repo accessible..."
if ! gh repo view "${SITE_REPO}" --json name >/dev/null 2>&1; then
  echo "==> ERROR: cannot access ${SITE_REPO} with current gh auth."
  exit 1
fi

#-- Extract checksum from sidecar ----------------------------------------
SHA=$(awk '{print $1; exit}' "${CHECKSUMS}")
if [ -z "${SHA}" ] || [ "${#SHA}" -ne 64 ]; then
  echo "==> ERROR: SHA-256 from ${CHECKSUMS} is malformed: '${SHA}'"
  exit 1
fi
echo "==> SHA-256: ${SHA}"

#-- ISO 8601 UTC timestamp ----------------------------------------------
RELEASED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "==> released_at: ${RELEASED_AT}"

#-- Clone site repo to worker scratch -----------------------------------
echo "==> Cloning ${SITE_REPO} to ${WORK_DIR}..."
trap 'rm -rf "${WORK_DIR}"' EXIT
gh repo clone "${SITE_REPO}" "${WORK_DIR}" -- --depth=1 --quiet
cd "${WORK_DIR}"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "==> ERROR: site repo not on main branch."
  exit 1
fi

#-- Stage release files --------------------------------------------------
RELEASE_DIR="releases/v${VERSION}"
echo "==> Staging release files into ${RELEASE_DIR}/..."
mkdir -p "${RELEASE_DIR}"
cp -a "${TARBALL}" "${RELEASE_DIR}/$(basename "${TARBALL}")"
cp -a "${CHECKSUMS}" "${RELEASE_DIR}/$(basename "${CHECKSUMS}")"

#-- Extract CHANGELOG snippet for this version ---------------------------
if [ -f "${REPO_ROOT}/CHANGELOG.md" ]; then
  echo "==> Extracting CHANGELOG snippet for ${VERSION}..."
  awk -v ver="${VERSION}" '
    BEGIN { in_section = 0 }
    /^## \[/ {
      if (in_section) exit
      if ($0 ~ "\\[" ver "\\]") in_section = 1
    }
    in_section { print }
  ' "${REPO_ROOT}/CHANGELOG.md" > "${RELEASE_DIR}/changelog.md"

  if [ ! -s "${RELEASE_DIR}/changelog.md" ]; then
    echo "==> WARNING: no CHANGELOG entry found for ${VERSION}; writing placeholder."
    printf "## [%s]\n\n(no CHANGELOG entry)\n" "${VERSION}" > "${RELEASE_DIR}/changelog.md"
  fi
fi

#-- Update releases/current.json ----------------------------------------
mkdir -p releases
TARBALL_URL="${SITE_URL}/${RELEASE_DIR}/$(basename "${TARBALL}")"
CHANGELOG_URL="${SITE_URL}/changelog.html"

cat > releases/current.json <<EOF
{
  "version": "${VERSION}",
  "tarball_url": "${TARBALL_URL}",
  "checksum_sha256": "${SHA}",
  "released_at": "${RELEASED_AT}",
  "changelog_url": "${CHANGELOG_URL}"
}
EOF
echo "==> releases/current.json written."

#-- Update releases/index.json ------------------------------------------
INDEX_FILE="releases/index.json"
NEW_ENTRY=$(printf '{"version":"%s","released_at":"%s"}' "${VERSION}" "${RELEASED_AT}")

if [ -f "${INDEX_FILE}" ]; then
  # Prepend new entry to existing array; if version already present, replace.
  python3 - "${VERSION}" "${RELEASED_AT}" <<'PY'
import json, sys, os

version, released_at = sys.argv[1], sys.argv[2]
path = "releases/index.json"

with open(path) as f:
    data = json.load(f)

# Drop any prior entry for this version (re-publish case)
data = [e for e in data if e.get("version") != version]

# Prepend new entry
data.insert(0, {"version": version, "released_at": released_at})

# Sort desc by released_at (defensive — handles out-of-order pushes)
data.sort(key=lambda e: e.get("released_at", ""), reverse=True)

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
else
  printf '[\n  %s\n]\n' "${NEW_ENTRY}" > "${INDEX_FILE}"
fi
echo "==> releases/index.json updated."

#-- Commit ---------------------------------------------------------------
git config user.name 'glados-daniel-lorena'
git config user.email 'glados-daniel-lorena@neato.com'

git add releases/
if git diff --cached --quiet; then
  echo "==> No changes to commit (re-publish with identical content?). Exiting clean."
  exit 0
fi

COMMIT_MSG="release: v${VERSION} (${SHA:0:8})"
git commit -m "${COMMIT_MSG}"
echo "==> Committed: ${COMMIT_MSG}"

#-- Push (or dry-run) ---------------------------------------------------
if [ "${DRY_RUN}" -eq 1 ]; then
  echo ""
  echo "==> DRY RUN — would push to ${SITE_REPO} main:"
  git log -1 --oneline
  git diff HEAD~1 --stat
  echo ""
  echo "==> No push. Site repo unchanged. Worker scratch will be cleaned up."
  exit 0
fi

echo "==> Pushing to ${SITE_REPO} main..."
git push origin main

#-- Summary -------------------------------------------------------------
echo ""
echo "==> Release v${VERSION} published to ${SITE_REPO}."
echo "    tarball:    ${TARBALL_URL}"
echo "    checksums:  ${SITE_URL}/${RELEASE_DIR}/$(basename "${CHECKSUMS}")"
echo "    current:    ${SITE_URL}/releases/current.json"
echo "    Vercel will auto-deploy within ~30-60s."
echo ""
echo "==> Verify (after Vercel deploys):"
echo "    curl -s ${SITE_URL}/releases/current.json | python3 -m json.tool"
echo "    curl -sI ${TARBALL_URL} | head -3   # expect 200 OK"
```

**Notes on script discipline:**
- `set -euo pipefail` — fail fast
- `trap 'rm -rf ...' EXIT` — always clean up worker scratch dir on success or failure
- Python inline for `index.json` mutation — `jq`-free, portable across mac+linux. Single-shot no-state. (Alternative: `jq` if owner prefers; `jq` is on the system per lore-v2 work.)
- `--depth=1 --quiet` clone — fast, minimal output noise
- Version drift between B.1 + B.2: B.1 verified `package.json` matches `<version>` arg. B.2 trusts the tarball name pattern matches `<version>`. If owner ran B.1 with `1.5.0` then B.2 with `1.5.0-rc.1`, B.2 would fail at the "tarball not found" pre-flight (correct behavior).
- Re-publish handling: if `index.json` already has an entry for the version, `python3` block deduplicates. Same content → no diff → no commit → exit 0 cleanly.
- `git config` user.name/email set inline so `commit` works even if global config isn't aligned with the active gh account. The author identity matches the gh-active account convention.

---

## B. Tests (run during the worker turn — DRY-RUN ONLY, no live push)

```bash
cd ~/neato-hive

# Test 1: shellcheck + bash -n
shellcheck scripts/release-publish.sh && echo "shellcheck: ✓" || echo "shellcheck: FAIL"
bash -n scripts/release-publish.sh && echo "bash -n: ✓" || echo "bash -n: FAIL"

# Test 2: build a tarball with current package.json version (relies on B.1)
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -5

# Test 3: dry-run the publish (no live push to site repo)
bash scripts/release-publish.sh "${CURRENT_VERSION}" --dry-run 2>&1 | tail -30

# Test 4: verify dry-run output shape
# - Should print "DRY RUN — would push to Daniel-Neato/neato-hive-site main"
# - Should show 1 commit with the release message
# - Should show diff stat including releases/v<version>/<tarball>, releases/current.json, releases/index.json
# - Should NOT push (no network side-effect)
# - Should clean up /tmp/neato-hive-site-publish-* on exit
ls /tmp/neato-hive-site-publish-* 2>&1 || echo "scratch dir cleaned: ✓"

# Test 5: argument validation
bash scripts/release-publish.sh 2>&1 | head -3 && echo "no-arg usage: ✓"
bash scripts/release-publish.sh nonexistent-version 2>&1 | grep -q "not found" && echo "missing tarball detected: ✓"
```

Expected: all 5 tests pass. **Worker DOES NOT run a live publish** — that's owner-paced (or J.2 ceremony).

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `scripts/release-publish.sh` (1 file). No edits elsewhere.
- [ ] `shellcheck scripts/release-publish.sh` clean
- [ ] `bash -n scripts/release-publish.sh` clean
- [ ] Dry-run smoke test exits 0 and shows the diff that WOULD be pushed (3+ files: tarball, current.json, index.json, optionally changelog.md)
- [ ] Worker scratch dir `/tmp/neato-hive-site-publish-*` cleaned on script exit (verify via `ls`)
- [ ] Argument validation works (no-arg usage, missing tarball detection)
- [ ] PR body contains: pre-flight 1-6 outputs verbatim, dry-run smoke output, shellcheck result, diff-lock confirmation
- [ ] Worker did NOT push to site repo — confirmed via `gh repo view Daniel-Neato/neato-hive-site --json defaultBranchRef --jq '.defaultBranchRef.target'` showing same SHA before + after worker turn

---

## D. When done (DONE block template for Bob to fill)

```text
PR URL: <gh url>
Diff: 1 file (scripts/release-publish.sh)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. B.1 outputs sane: release.sh ✓ release-audit.sh ✓ package.json version=<x>
  3. gh CLI active account: Daniel-Neato ✓
  4. site repo accessible: Daniel-Neato/neato-hive-site (private, default=main) ✓
  5. existing releases/ on site repo: <captured baseline — present | absent>
  6. CHANGELOG.md: <head 5 entries verbatim>

Tooling check:
  shellcheck scripts/release-publish.sh: ✓
  bash -n scripts/release-publish.sh: ✓

Dry-run smoke:
  bash scripts/release.sh <CURRENT_VERSION>      # build artifacts
  bash scripts/release-publish.sh <CURRENT_VERSION> --dry-run

  <verbatim output, expecting:
    - "DRY RUN — would push to Daniel-Neato/neato-hive-site main"
    - 1 commit with "release: v<x> (<sha-prefix>)"
    - diff --stat showing releases/v<x>/<tarball>, releases/current.json, releases/index.json>

Cleanup verification:
  ls /tmp/neato-hive-site-publish-*: <expecting empty / "no such file or directory">

Argument validation:
  bash scripts/release-publish.sh: <usage shown>
  bash scripts/release-publish.sh nonexistent-version: <"not found" error>

Live-push verification:
  Site repo HEAD before worker turn: <sha>
  Site repo HEAD after worker turn: <same sha — confirms no push>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-B.2-site-repo-push-automation
  <verbatim — exactly 1 line: scripts/release-publish.sh>

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — single script in single PR; smoke test is dry-run
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop
- **DO NOT LIVE-PUSH** during worker turn — `--dry-run` only. Live push is owner-paced (or J.2 release ceremony). Worker enforces this by ONLY running `--dry-run` during the smoke test.
- **HALT-and-ping rule** — if pre-flight reveals scope expansion (existing `release-publish.sh`, gh CLI auth wrong account, site repo inaccessible, B.1 outputs missing despite running release.sh), HALT and ping house-md via SendMessage with kind=delegation
- **Worker MUST run shellcheck** — proves the script doesn't have portability or quoting bugs
- **`gh repo clone` not SSH** for cloning site repo (script enforces); remote-URL check before cleanup, never blanket `rm -rf` outside the trapped scratch dir
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (shellcheck clean, dry-run produces expected diff, no live push happened, scratch cleaned), then ping house-md via SendMessage with kind=delegation

---

## F. Owner-side considerations (pre/post-merge)

Worker doesn't touch these — owner runs when ready:

1. **Pre-publish (any time after B.2 merges):** verify the publish flow end-to-end with a live push. Recommended:
   ```bash
   # Build + publish a real release for the current version
   bash scripts/release.sh "$(node -e "console.log(require('./package.json').version)")"
   bash scripts/release-publish.sh "$(node -e "console.log(require('./package.json').version)")"

   # Verify Vercel auto-deploy fired
   curl -s https://neato-hive-site.vercel.app/releases/current.json | python3 -m json.tool

   # Verify tarball downloadable
   curl -sI https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz | head -3
   ```

2. **Independent of B.2 — pending owner-side TODOs from prior leaves (not blocking B.2):**
   - Cloud Build GitHub App on `anthonyconnelly/neato-hive` (gates A.4 smoke + A.5 live deploy + Cloud Run service first-deploy)
   - `hive_releases` DB + `hive_releases_user` + secret rotation (gates A.5 production migrate)
   
   Neither of these blocks B.2 ship — B.2 publishes to the SITE repo path; Cloud Run / DB are downstream consumer concerns of the published metadata.

3. **J.2 release ceremony** (owner-paced, post-Phase-J leaves): tag framework repo (`git tag v1.5.0 && git push --tags`), run the full pipeline with the real version, owner verifies `hive update` from a clone-of-prod before main install.

---

## G. Forward links

- Phase C — `hive update` rewrite. C.1 fetch+verify reads `<site>/releases/current.json` (B.2 produces this), downloads the tarball (B.1 produces, B.2 publishes), verifies SHA against the sidecar (B.1+B.2 ship the canonical SHA in 2 places: in-tarball-sidecar + current.json field). C.2 atomic-overlay swaps REPLACE_LIST items per the contract B.1 enforces.
- C.5 — `hive update --check --json` mode reads `<site>/releases/current.json` (B.2 produces), returns version diff to dashboard (D phase).
- J.2 — release ceremony. Tag + run full pipeline + owner verifies on clone-of-prod.
