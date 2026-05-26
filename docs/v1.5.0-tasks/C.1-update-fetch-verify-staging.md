# v1.5.0 C.1 — `hive update` Fetch + Verify + Staging

**Status:** LOCKED — Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.1 (1 of 7 in Phase C)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop — owner directive 2026-05-06 via task `t-mouojpd4000i`)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** B.2 ✅ merged 2026-05-07 — PR #51 squash `273c9e8` (release pipeline end-to-end functional)
**Successor:** C.2 — Atomic-overlay swap (REPLACE_LIST per-item `.old.<ts>` rename, new content in place)

---

## Goal

Ship the FOUNDATION layer of the v1.5.0 `hive update` flow: fetch latest release metadata from the public API, download the tarball, verify SHA-256 against the published checksum, set up the staging directory + lockfile + disk-space pre-flight. C.1 lands the **functions and contracts** that subsequent C leaves consume; the user-facing `hive update` command keeps its v1.4.x git-pull behavior intact for now (the cut-over to the new mechanism happens in a later C leaf when the full pipeline is validated end-to-end).

**C.1 ships:**
- New helper functions in `bin/hive` for fetch / verify / stage / lock / diskspace-check
- A hidden test subcommand `hive _update-fetch-stage <version-or-current>` exercising the C.1 functions end-to-end without touching the live install (no swap, no overwrite — staging only)
- Test fixtures + smoke verification by Bob during the worker turn

**C.1 does NOT ship:**
- The atomic overlay swap (C.2)
- Rollback (C.3)
- Doctor sweep (C.4)
- `--check --json` mode (C.5)
- State-file emission for SSE relay (C.6)
- v1.4.x → v1.5.0 implicit migration handler (C.7)
- Cut-over of user-facing `hive update` from git-pull to tarball mechanism (deferred to a later C leaf — likely C.7 or a separate cut-over leaf)

---

## Architectural givens (carried from prior decisions)

- **API endpoint:** `https://neato-hive-site.vercel.app/api/current` returns the 5-field JSON shape from B.2 (`{version, tarball_url, checksum_sha256, released_at, changelog_url}`). Configurable via env var `HIVE_RELEASES_API` (default = the Vercel URL above) so test environments can point at a synthetic API.
- **Q3 — staging directory:** `~/neato-hive/.update-staging/<id>/` (same FS as install target — avoids cross-FS `mv` non-atomicity). NOT `/tmp/`. The `<id>` is a unique per-invocation token (timestamp + version + pid hash).
- **Q5 — lockfile:** `~/.neato-hive/.update.lock` via `flock` (macOS + Linux compatible). Second concurrent invocation fails with clear message + non-zero exit. Lock auto-releases on script exit.
- **Q6 — disk-space pre-flight:** require ≥ 3× tarball size free in `~/neato-hive/` partition (download + extract + `.old.*` shadow during swap). Use `df -k` portable across mac+linux. Abort with clear message if insufficient.
- **Q2 — node_modules:** tarball excludes `node_modules/`; consumer runs `pnpm install --frozen-lockfile` post-extract. C.1 doesn't yet run install — that's C.4 / cut-over leaf.
- **Q4 — checksum source-of-truth:** `current.json`'s `checksum_sha256` field is the canonical. Sidecar `.checksums.txt` shipped at `releases/v<version>/<tarball>.checksums.txt` is for human-eyeball verification. C.1 verifies against the JSON field.
- **REPLACE_LIST / PRESERVE_LIST contracts:** documented in B.1 `release-audit.sh`. C.1 doesn't enforce them yet (no swap); just records them so C.2 has a stable reference. **Add `~/.neato-hive/skills/` to PRESERVE_LIST** per Q10 forward-compat reservation (skill-shop registry; Glados hasn't yet shipped this in any leaf).
- **`bin/hive` is bash, no TypeScript.** Per v1.4.9 convention. C.1 adds bash functions + extends the case dispatcher.

---

## Pre-conditions

- B.2 ✅ merged — release pipeline functional (`scripts/release.sh` + `scripts/release-publish.sh`)
- Framework `main` HEAD includes B.2 + C.1 spec
- `bin/hive` exists with `cmd_update` + `cmd_bootstrap` from v1.4.9 self-healing bootstrap (PR #43 squash `0f0828e`)
- `jq` + `curl` + `shasum` + `flock` + `df` all present (verified across mac+linux per lore-v2 work)
- Live API endpoint may NOT yet be returning real data (Cloud Run service first-deploy gated on owner-side Cloud Build GitHub App install). C.1 worker uses **a local-file fixture** for smoke testing — see §B Tests.

---

## Where state lives (C.1 conventions)

- **`bin/hive` edits:** add new internal functions + the hidden `_update-fetch-stage` test subcommand. No edits to existing v1.4.9 `cmd_update` (intact for backwards compat).
- **Lockfile:** `~/.neato-hive/.update.lock` — created if not exists
- **Staging root:** `~/neato-hive/.update-staging/` — per-invocation `<id>/` subdirs created and cleaned up by C.1 functions
- **Local version source:** `~/neato-hive/package.json` `version` field (already present — `bin/hive --version` reads from there per v1.4.9)

---

## Pre-flight (worker MUST run all 7; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at B.2 merge (`273c9e8`) or C.1-spec commit. Should NOT include any C-leaf implementation commits yet.

### 2. `bin/hive` shape (verify v1.4.9 bootstrap functions present, no C.1 functions yet)

```bash
grep -nE '^(cmd_update|cmd_bootstrap|_update_)' bin/hive | head -20
test -f bin/hive && echo "bin/hive: ✓"
```

Expected: `cmd_update` + `cmd_bootstrap` present (v1.4.9). NO `_update_` prefix functions yet (C.1 introduces them). **HALT and ping house-md** if any `_update_` helper already exists (out-of-band).

### 3. Verify required tooling

```bash
which jq && jq --version
which curl && curl --version | head -1
which shasum && echo "shasum: ✓"
which flock && echo "flock: ✓"
which df && echo "df: ✓"
```

Expected: all five present. `flock` is Linux-stdlib + macOS-via-homebrew/util-linux; if missing, **HALT and ping house-md** with an alternative mechanism (pidfile fallback if flock unavailable — but proven solution is flock).

### 4. Verify API endpoint reachable (informational — C.1 doesn't require live data)

```bash
curl -sI https://neato-hive-site.vercel.app/api/current | head -3
```

Expected: HTTP response — status 200 if Cloud Run is live, 404/500/etc. if not yet. Worker captures status without HALTing (C.1 uses fixture for testing).

### 5. Verify `~/.neato-hive/` directory state

```bash
ls -la ~/.neato-hive/ 2>&1 | head -10
test -f ~/.neato-hive/.update.lock && echo "update.lock EXISTS — captured for cleanup" || echo "update.lock: not present (expected pre-C.1)"
```

Expected: `~/.neato-hive/` exists (created by prior leaves for state files); no `.update.lock` present yet. If lock present, **investigate** — could be stale from a prior dev run.

### 6. Verify `~/neato-hive/` install state (target for staging)

```bash
ls -la ~/neato-hive/ | head -10
test -d ~/neato-hive/.update-staging && echo ".update-staging EXISTS — cleanup or investigate" || echo ".update-staging: not present (expected pre-C.1)"
df -k ~/neato-hive/ | tail -2
```

Expected: install dir exists; `.update-staging/` not present yet. `df` output captured for disk-space context (worker confirms ≥ 3× expected tarball size — at v1.5.0 with current build content the tarball is ~50-100MB so ~500MB free is plenty).

### 7. Sanity-test source-safe pattern in current `bin/hive`

```bash
bash -c 'source ~/neato-hive/bin/hive && type cmd_update' 2>&1 | head -5
```

Expected: prints `cmd_update is a function`. Confirms `bin/hive` can be sourced without running `main` (worker uses sourcing for smoke tests). **HALT and ping house-md** if sourcing runs the main dispatcher (means bin/hive is structured non-source-safe and C.1 needs a refactor).

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-C.1-update-fetch-verify-staging`.

**Diff lock: 1 path.**
- `bin/hive` (MODIFY — add C.1 helper functions + hidden test subcommand)

No edits to other files. No CHANGELOG bump in C.1 (PR-level CHANGELOG churn happens at phase-close). No new files at framework repo root.

### A.1 — New helper functions in `bin/hive`

All functions prefixed `_update_` (underscore = internal/private convention). Each function is small, single-responsibility, exits non-zero on failure with a clear message. All operate idempotently within reason — re-runs handle prior partial state.

#### `_update_default_api_url`

Returns the API URL — env var `HIVE_RELEASES_API` if set, otherwise `https://neato-hive-site.vercel.app/api/current`.

```bash
_update_default_api_url() {
  echo "${HIVE_RELEASES_API:-https://neato-hive-site.vercel.app/api/current}"
}
```

#### `_update_local_version`

Reads `~/neato-hive/package.json` `version` field via `node -e`. Output to stdout. Returns non-zero if package.json missing.

```bash
_update_local_version() {
  local pkg="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}/package.json"
  if [ ! -f "${pkg}" ]; then
    echo "ERROR: ${pkg} not found" >&2
    return 1
  fi
  node -e "console.log(require('${pkg}').version)"
}
```

`HIVE_INSTALL_ROOT` env var override for testing in non-default install paths.

#### `_update_fetch_current_metadata <output_file>`

Calls the API, writes raw JSON to `<output_file>`. Verifies the JSON has all 5 required fields. Returns non-zero on network failure or shape mismatch.

```bash
_update_fetch_current_metadata() {
  local out="$1"
  local url
  url="$(_update_default_api_url)"
  if ! curl -fsSL "${url}" -o "${out}"; then
    echo "ERROR: failed to fetch ${url}" >&2
    return 1
  fi
  # Verify shape
  local missing
  missing=$(jq -r 'select(.version == null or .tarball_url == null or .checksum_sha256 == null or .released_at == null or .changelog_url == null) | "shape_invalid"' "${out}" 2>/dev/null)
  if [ "${missing}" = "shape_invalid" ]; then
    echo "ERROR: ${url} returned malformed JSON (missing required fields)" >&2
    cat "${out}" >&2
    return 1
  fi
  return 0
}
```

#### `_update_compare_versions <local> <remote>`

Returns 0 if local matches remote (no update needed). Returns 1 if remote is "newer" (different — semantic versioning compare deferred to future leaf if needed; for C.1 string-equality is sufficient since we just need "is this a new release?").

```bash
_update_compare_versions() {
  local local_v="$1"
  local remote_v="$2"
  if [ "${local_v}" = "${remote_v}" ]; then
    return 0  # match — no update
  fi
  return 1    # different — update available
}
```

(Future leaf may extend with semver comparison. C.1 just flags "they differ.")

#### `_update_acquire_lock`

Acquires exclusive lock on `~/.neato-hive/.update.lock` via `flock -xn` (non-blocking). Returns 0 on acquire, non-zero if another invocation holds it. The lock auto-releases when the calling shell exits.

```bash
_update_acquire_lock() {
  local lockfile="${HIVE_LOCK_FILE:-$HOME/.neato-hive/.update.lock}"
  mkdir -p "$(dirname "${lockfile}")"
  exec 9>"${lockfile}"
  if ! flock -xn 9; then
    echo "ERROR: another hive update invocation holds ${lockfile}" >&2
    echo "       (lock holder PID: $(lsof -t "${lockfile}" 2>/dev/null | head -1 || echo unknown))" >&2
    return 1
  fi
  return 0
}
```

#### `_update_diskspace_check <expected_tarball_bytes>`

Verifies `~/neato-hive/` partition has ≥ 3× the expected tarball size free. Uses `df -k` (portable). Returns 0 if sufficient, non-zero otherwise.

```bash
_update_diskspace_check() {
  local expected_bytes="$1"
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
  local required=$((expected_bytes * 3))
  local available_kb
  available_kb=$(df -k "${install_root}" | awk 'NR==2 {print $4}')
  local available_bytes=$((available_kb * 1024))
  if [ "${available_bytes}" -lt "${required}" ]; then
    echo "ERROR: insufficient disk space" >&2
    echo "  Required (3× tarball): $((required / 1024 / 1024)) MiB" >&2
    echo "  Available:             $((available_bytes / 1024 / 1024)) MiB" >&2
    echo "  Free up space and retry." >&2
    return 1
  fi
  return 0
}
```

#### `_update_stage_setup`

Creates a fresh staging directory under `~/neato-hive/.update-staging/<id>/`. The `<id>` is `$(date -u +%Y%m%dT%H%M%SZ)-$$-$(uuidgen 2>/dev/null | head -c8 || echo $RANDOM$RANDOM)`. Outputs the staging path on stdout. Returns non-zero if creation fails.

```bash
_update_stage_setup() {
  local staging_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}/.update-staging"
  local id
  id="$(date -u +%Y%m%dT%H%M%SZ)-$$-$(uuidgen 2>/dev/null | head -c8 | tr -d '-' || echo "${RANDOM}${RANDOM}")"
  local staging_dir="${staging_root}/${id}"
  if ! mkdir -p "${staging_dir}"; then
    echo "ERROR: failed to create staging dir ${staging_dir}" >&2
    return 1
  fi
  echo "${staging_dir}"
  return 0
}
```

#### `_update_stage_cleanup <staging_dir>`

Removes a staging dir. Defensive: only removes paths under `~/neato-hive/.update-staging/`. Refuses to remove anything else.

```bash
_update_stage_cleanup() {
  local staging_dir="$1"
  local staging_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}/.update-staging"
  case "${staging_dir}" in
    "${staging_root}/"*)
      rm -rf "${staging_dir}"
      ;;
    *)
      echo "ERROR: refusing to remove ${staging_dir} (not under ${staging_root})" >&2
      return 1
      ;;
  esac
  return 0
}
```

#### `_update_download_tarball <url> <output_path>`

Downloads tarball via curl. Returns non-zero on failure.

```bash
_update_download_tarball() {
  local url="$1"
  local out="$2"
  if ! curl -fsSL "${url}" -o "${out}"; then
    echo "ERROR: failed to download ${url}" >&2
    return 1
  fi
  return 0
}
```

#### `_update_verify_checksum <tarball_path> <expected_sha256>`

Computes SHA-256 of the tarball, compares to expected. Returns 0 on match, non-zero on mismatch.

```bash
_update_verify_checksum() {
  local tarball="$1"
  local expected="$2"
  local actual
  actual=$(shasum -a 256 "${tarball}" | awk '{print $1}')
  if [ "${actual}" != "${expected}" ]; then
    echo "ERROR: checksum mismatch" >&2
    echo "  Expected: ${expected}" >&2
    echo "  Actual:   ${actual}" >&2
    echo "  Aborting (potential tampering or corrupt download)." >&2
    return 1
  fi
  return 0
}
```

### A.2 — Hidden test subcommand `hive _update-fetch-stage [--version <v>] [--dry-run]`

Exercises the C.1 functions end-to-end without touching the live install. Stages a fresh tarball into `~/neato-hive/.update-staging/<id>/` and reports success. Cleanup is automatic on exit.

```bash
cmd_update_fetch_stage() {
  local target_version=""
  local dry_run=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) target_version="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) echo "ERROR: unknown arg '$1'" >&2; return 2 ;;
    esac
  done

  echo "==> [_update-fetch-stage] start"

  # 1. Acquire lock
  if ! _update_acquire_lock; then
    echo "==> [_update-fetch-stage] aborting (lock failure)"
    return 1
  fi
  echo "==> Lock acquired"

  # 2. Set up staging
  local staging_dir
  if ! staging_dir=$(_update_stage_setup); then
    echo "==> [_update-fetch-stage] aborting (staging setup failure)"
    return 1
  fi
  echo "==> Staging dir: ${staging_dir}"
  trap '_update_stage_cleanup "${staging_dir}" || true' EXIT

  # 3. Fetch metadata
  local metadata="${staging_dir}/current.json"
  if ! _update_fetch_current_metadata "${metadata}"; then
    echo "==> [_update-fetch-stage] aborting (metadata fetch failure)"
    return 1
  fi
  echo "==> Metadata fetched: ${metadata}"

  local remote_version remote_url remote_sha
  remote_version=$(jq -r '.version' "${metadata}")
  remote_url=$(jq -r '.tarball_url' "${metadata}")
  remote_sha=$(jq -r '.checksum_sha256' "${metadata}")

  # If --version was specified, verify it matches the API response
  if [ -n "${target_version}" ] && [ "${target_version}" != "${remote_version}" ]; then
    echo "ERROR: target version '${target_version}' does not match API current '${remote_version}'" >&2
    return 1
  fi

  # 4. Compare to local
  local local_version
  if local_version=$(_update_local_version 2>/dev/null); then
    echo "==> Local version: ${local_version}"
    if _update_compare_versions "${local_version}" "${remote_version}"; then
      echo "==> Already at v${local_version}; no update needed."
      return 0
    fi
    echo "==> Update available: v${local_version} → v${remote_version}"
  else
    echo "==> Local version: (none)"
    echo "==> Update available: → v${remote_version}"
  fi

  if [ "${dry_run}" -eq 1 ]; then
    echo "==> --dry-run: not downloading. Exiting."
    return 0
  fi

  # 5. Disk-space pre-flight (estimate 200 MB tarball as upper bound — safe over-estimate)
  if ! _update_diskspace_check 209715200; then
    return 1
  fi
  echo "==> Disk-space pre-flight: ✓"

  # 6. Download tarball
  local tarball_path="${staging_dir}/$(basename "${remote_url}")"
  if ! _update_download_tarball "${remote_url}" "${tarball_path}"; then
    return 1
  fi
  echo "==> Tarball downloaded: ${tarball_path}"

  # 7. Verify checksum
  if ! _update_verify_checksum "${tarball_path}" "${remote_sha}"; then
    return 1
  fi
  echo "==> Checksum verified: ${remote_sha}"

  # 8. C.1 stops here — extraction + atomic-overlay swap is C.2's job
  echo ""
  echo "==> [_update-fetch-stage] complete (C.1 boundary)."
  echo "    Tarball staged at: ${tarball_path}"
  echo "    Next leaf C.2 implements atomic-overlay swap."
  return 0
}
```

### A.3 — Wire `_update-fetch-stage` into `bin/hive`'s case dispatcher

Add a hidden case branch (underscore-prefixed = not in main `--help` output, but accessible for testing):

```bash
# In the main case dispatch block:
_update-fetch-stage)
  cmd_update_fetch_stage "$@"
  ;;
```

Subcommand isn't documented in `hive --help` (underscore-prefix convention). Mentioned in spec for human awareness only.

### A.4 — Add brief comment block to `bin/hive` referencing the C.1 spec

Single `#` comment block above the new helper functions:

```bash
# v1.5.0 C.1 — fetch + verify + staging helpers for the new tarball-based update flow.
# These functions are consumed by C.2 (atomic-overlay swap), C.3 (rollback),
# C.4 (doctor sweep), C.5 (--check --json), C.6 (state-file emission), C.7 (migration).
# The user-facing `hive update` command keeps v1.4.9 git-pull behavior until the
# cut-over leaf flips it to use this pipeline.
#
# Spec: docs/v1.5.0-tasks/C.1-update-fetch-verify-staging.md
```

---

## B. Tests (run during the worker turn)

### B.1 — Bash syntax + shellcheck

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20  # may produce existing warnings; new code should not add any
```

Expected: `bash -n` clean. `shellcheck` may surface pre-existing warnings that aren't C.1's problem; new functions should not add new warnings (worker captures shellcheck output verbatim, flags any new warnings introduced by C.1).

### B.2 — Source-safe pattern verified

```bash
bash -c 'source bin/hive && type _update_acquire_lock' 2>&1 | head -5
```

Expected: prints `_update_acquire_lock is a function`. Confirms the new functions are accessible after sourcing without `main` running.

### B.3 — Unit-test individual helpers

```bash
# Lock acquire/release
HIVE_LOCK_FILE=/tmp/C1-test.lock bash -c '
  source ~/neato-hive/bin/hive
  _update_acquire_lock && echo "lock 1: acquired"
  # In a subshell, attempt second acquire (should fail)
  bash -c "
    source ~/neato-hive/bin/hive
    HIVE_LOCK_FILE=/tmp/C1-test.lock _update_acquire_lock && echo \"lock 2: acquired (BUG)\" || echo \"lock 2: blocked (expected)\"
  "
'

# Disk-space check (large impossible value — should fail)
bash -c 'source ~/neato-hive/bin/hive && _update_diskspace_check 99999999999999 && echo "FAIL: should have rejected" || echo "diskspace pre-flight: ✓ (large value rejected)"'

# Disk-space check (small value — should pass)
bash -c 'source ~/neato-hive/bin/hive && _update_diskspace_check 1024 && echo "diskspace pre-flight: ✓ (small value accepted)"'

# Staging dir setup + cleanup
bash -c '
  source ~/neato-hive/bin/hive
  staging=$(_update_stage_setup) || exit 1
  echo "staging: ${staging}"
  test -d "${staging}" && echo "staging exists: ✓"
  _update_stage_cleanup "${staging}" && echo "cleanup: ✓"
  test ! -d "${staging}" && echo "staging removed: ✓"
'

# Local version reader (uses framework repo's package.json)
bash -c 'source ~/neato-hive/bin/hive && HIVE_INSTALL_ROOT=~/neato-hive _update_local_version'

# Checksum verifier — match case
echo "test-content" > /tmp/C1-test.bin
expected=$(shasum -a 256 /tmp/C1-test.bin | awk '{print $1}')
bash -c "source ~/neato-hive/bin/hive && _update_verify_checksum /tmp/C1-test.bin ${expected} && echo \"checksum match: ✓\""

# Checksum verifier — mismatch case
bash -c 'source ~/neato-hive/bin/hive && _update_verify_checksum /tmp/C1-test.bin 0000000000000000000000000000000000000000000000000000000000000000 && echo "FAIL: should have rejected" || echo "checksum mismatch: ✓ (rejected)"'
rm -f /tmp/C1-test.bin
```

### B.4 — End-to-end smoke via hidden subcommand

Use a synthetic JSON fixture (since live API may not be returning real data yet — Cloud Run gated on owner-side install):

```bash
# Set up a fixture HTTP server using python -m http.server pointing at a fixture dir
mkdir -p /tmp/C1-fixture
echo "fixture tarball content" > /tmp/C1-fixture/neato-hive-v9.9.9-test.tar.gz
SHA=$(shasum -a 256 /tmp/C1-fixture/neato-hive-v9.9.9-test.tar.gz | awk '{print $1}')
cat > /tmp/C1-fixture/api-current.json <<EOF
{
  "version": "9.9.9-test",
  "tarball_url": "http://localhost:18999/neato-hive-v9.9.9-test.tar.gz",
  "checksum_sha256": "${SHA}",
  "released_at": "2026-05-07T00:00:00Z",
  "changelog_url": "http://localhost:18999/changelog.html"
}
EOF
mv /tmp/C1-fixture/api-current.json /tmp/C1-fixture/api/current
mkdir -p /tmp/C1-fixture/api && mv /tmp/C1-fixture/api/current /tmp/C1-fixture/api/current.json
# Actually simpler: serve the file directly at /api/current path via python http.server is awkward.
# Worker can use a simpler approach: HIVE_RELEASES_API=file:///tmp/C1-fixture/current.json with curl
# (curl supports file:// URLs). Avoids the http.server dance entirely.
cat > /tmp/C1-fixture/current.json <<EOF
{
  "version": "9.9.9-test",
  "tarball_url": "file:///tmp/C1-fixture/neato-hive-v9.9.9-test.tar.gz",
  "checksum_sha256": "${SHA}",
  "released_at": "2026-05-07T00:00:00Z",
  "changelog_url": "http://localhost:18999/changelog.html"
}
EOF

HIVE_RELEASES_API=file:///tmp/C1-fixture/current.json \
HIVE_INSTALL_ROOT=$HOME/neato-hive \
  ~/neato-hive/bin/hive _update-fetch-stage --dry-run 2>&1 | head -20
# Expected: prints metadata fetch + version compare. Dry-run skips download.

HIVE_RELEASES_API=file:///tmp/C1-fixture/current.json \
HIVE_INSTALL_ROOT=$HOME/neato-hive \
  ~/neato-hive/bin/hive _update-fetch-stage 2>&1 | tail -20
# Expected: full flow — metadata → compare → diskspace → download → checksum verify → C.1 boundary message
# Cleanup happens automatically via trap

rm -rf /tmp/C1-fixture
```

If `file://` URLs aren't supported by the system curl, worker falls back to a tmp `python3 -m http.server 18999 --directory /tmp/C1-fixture` for the smoke (note: requires PATH=/tmp/py313-shim:/opt/homebrew/bin:$PATH per house-md's tweak). Either approach works — pick whichever is cleaner.

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file). Worker confirms via `git diff --stat main...feat/v1.5.0-C.1-update-fetch-verify-staging`
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` introduces ZERO new warnings (pre-existing warnings OK; capture the count delta)
- [ ] Source-safe pattern confirmed: `source bin/hive` does not run `main`
- [ ] All 6 unit-test helpers pass per §B.3 (lock contention detected, diskspace check works both directions, staging setup+cleanup roundtrip, local version reads, checksum match + mismatch detected correctly)
- [ ] End-to-end smoke via hidden subcommand passes per §B.4 (synthetic fixture exercise)
- [ ] No live-API dependency — worker uses synthetic fixture; live API may or may not be live (Cloud Run gated)
- [ ] PR body contains: pre-flight 1-7 outputs verbatim, all 6 unit-test outputs, smoke test output, shellcheck delta, diff-lock confirmation

---

## D. When done (DONE block template for Bob to fill)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. bin/hive shape: cmd_update ✓ cmd_bootstrap ✓ no _update_ helpers (expected)
  3. tooling: jq ✓ curl ✓ shasum ✓ flock ✓ df ✓
  4. API endpoint reachable: <status code — 404/500 expected if Cloud Run not yet live; informational only>
  5. ~/.neato-hive/ state: <captured>
  6. ~/neato-hive/ state: no .update-staging (expected); df shows <free>
  7. Source-safe pattern confirmed: ✓

Tooling check:
  bash -n bin/hive: ✓
  shellcheck -x bin/hive: <new warnings introduced — expecting 0>

Unit tests (§B.3):
  Lock contention test: ✓ (second invocation blocked)
  Disk-space large-value reject: ✓
  Disk-space small-value accept: ✓
  Staging setup + cleanup roundtrip: ✓
  Local version reader: <captured value>
  Checksum match + mismatch: ✓

End-to-end smoke (§B.4):
  Synthetic fixture: file:///tmp/C1-fixture/current.json with SHA <captured>
  Dry-run output: <last 20 lines>
  Full flow output: <last 20 lines, expecting C.1 boundary message>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.1-update-fetch-verify-staging
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — all helpers + the hidden test subcommand + the case dispatch wiring all in single PR
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop
- **DO NOT TOUCH `cmd_update` (v1.4.9)** — C.1 is purely additive. The user-facing `hive update` command keeps git-pull behavior until a later C leaf cuts over.
- **DO NOT WIRE INTO MAIN COMMAND DISPATCH (visible)** — the new functions are accessible only via the hidden `_update-fetch-stage` subcommand. Not in `hive --help`. Underscore prefix is the convention.
- **HALT-and-ping rule** — pre-flight surprises (existing `_update_` helpers, missing `flock`, non-source-safe `bin/hive`) stop the worker; ping house-md via SendMessage with kind=delegation.
- **Worker MUST run shellcheck** — and MUST report new-warning delta (zero is the target)
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before any cleanup, never blanket `rm -rf` outside trapped paths
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (bash -n + shellcheck delta + 6 unit tests + smoke + diff lock), then ping house-md via SendMessage with kind=delegation
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift is OK pre-flight; worker should not abort on those (matches v1.4.9 self-healing bootstrap pattern)

---

## F. Forward links

- C.2 — Atomic-overlay swap. Consumes the staging dir from `_update_stage_setup`, applies REPLACE_LIST per-item rename to `.old.<ts>`, new content in place. PRESERVE_LIST audit before swap.
- C.3 — Lockfile (already in C.1) + rollback path (`hive update --rollback` automated command). Mid-update failure auto-reverts; doctor-fail-post-update preserves `.old.*` and surfaces rollback command.
- C.4 — Doctor sweep + cleanup of `.old.*` on success. Runs `hive doctor --fix --yes` post-swap. Fold in the `pnpm install --frozen-lockfile` step here per Q2.
- C.5 — `hive update --check --json` mode: invokes `_update_fetch_current_metadata` + `_update_compare_versions`, emits structured JSON for dashboard `/api/update/check`.
- C.6 — State-file emission to `~/.neato-hive/state/update-<id>.jsonl` for SSE relay (Q1 architecture). Per-event types `start | step | step_done | error | done`.
- C.7 — v1.4.x → v1.5.0 implicit migration handler. Detects first-v1.5.0 update, generates dashboard token, adds `hive-dashboard` to PM2 ecosystem, first-start. May also be the cut-over leaf that flips `cmd_update` to use the new pipeline.
