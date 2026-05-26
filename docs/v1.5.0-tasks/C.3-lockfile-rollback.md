# v1.5.0 C.3 — Lockfile + Rollback Path (full-flow orchestrator + `hive update --rollback`)

**Status:** LOCKED — Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.3 (3 of 7 in Phase C)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.2 ✅ merged 2026-05-07 16:14:10Z — PR #55 squash `a1cf5e5` (atomic-overlay swap + revert helpers + manifest)
**Successor:** C.4 — Doctor sweep + `.old.<ts>` cleanup on success + `pnpm install --frozen-lockfile` post-extract

---

## Goal

Compose C.1 (fetch+verify+stage) + C.2 (extract+apply-overlay) into a single coordinated full-flow orchestrator that:

1. Acquires the update lock (C.1 helper)
2. Sets up staging + disk-space pre-flight
3. Fetches metadata, downloads tarball, verifies checksum
4. Extracts tarball + applies overlay (C.2 helpers)
5. **On any mid-flow failure: auto-reverts via C.2's `_update_revert_overlay`, exits non-zero, leaves no half-applied state**
6. On success: hands off to C.4 (doctor sweep + cleanup) — for now C.3 leaves `.old.<ts>` shadows in place + prints rollback command

Ship the user-facing `hive update --rollback` command that wraps C.2's revert helper for the "I just updated and something's wrong, undo it" scenario.

**C.3 ships:**
- New helper `_update_run_full_flow_with_revert` — orchestrates C.1 + C.2 with auto-revert on failure
- New helper `_update_find_latest_shadow_ts` — finds the most-recent `.old.<ts>` timestamp in install root + locates the corresponding manifest
- New helper `_update_run_rollback` — composes find-latest-shadow + revert-overlay + cleanup
- Extension of `cmd_update`'s argument parsing — adds `--rollback` flag handling AT THE TOP, branches to rollback path if present, otherwise falls through to existing v1.4.9 git-pull behavior unchanged
- New hidden test subcommand `hive _update-full-flow [--inject-failure-after <step>] [--dry-run]` for testing auto-revert behavior

**C.3 does NOT ship:**
- Cut-over of `cmd_update` from v1.4.9 git-pull behavior to the new tarball pipeline (deferred to C.7 or a separate cut-over leaf — risky to flip until Cloud Run + DB owner-side pieces are live)
- Doctor sweep / `.old.<ts>` cleanup (C.4)
- `pnpm install --frozen-lockfile` post-extract (C.4)
- `--check --json` mode (C.5)
- State-file emission for SSE (C.6)
- v1.4.x → v1.5.0 implicit migration (C.7)

---

## Architectural givens (carried)

- **Lockfile (Q5):** `~/.neato-hive/.update.lock` via `flock -xn`. Already implemented in C.1 (`_update_acquire_lock`). C.3 just wraps it into the orchestrator.
- **Staging (Q3):** `~/neato-hive/.update-staging/<id>/`. Already implemented in C.1 (`_update_stage_setup` + `_update_stage_cleanup`).
- **Manifest format:** plain text, one REPLACE_LIST item per line, oldest-applied first. Path: `~/neato-hive/.update-staging/<id>/applied.list`. Implemented in C.2 (`_update_apply_overlay` writes; `_update_revert_overlay` reads).
- **Shadow naming:** `~/neato-hive/.<item>.old.<ts>` (leading dot, hidden). Already implemented in C.2.
- **Failure auto-revert contract:** if any step from "extract tarball" through "apply overlay" fails, the orchestrator calls `_update_revert_overlay` to undo any partial swaps. Exit non-zero. Stage cleanup may or may not happen depending on whether owner wants to inspect partial state — C.3 default = stage cleanup ON (clean exit), `--keep-staging` flag for debugging.
- **Rollback selection contract:** `hive update --rollback` finds the MOST RECENT `.old.<ts>` shadow in install root, locates the corresponding manifest under `.update-staging/`, walks revert. Single-shot — does NOT support "rollback to N updates ago" in v1.5.0 (could be future leaf if needed).
- **Doctor placeholder:** post-overlay-apply, C.3 prints "Doctor sweep deferred to C.4 — manually verify install integrity" message. C.4 wires actual `hive doctor --fix --yes` invocation.

---

## Pre-conditions

- C.2 ✅ merged (PR #55 squash `a1cf5e5`); C.1 + C.2 helpers all present in `bin/hive`
- v1.4.9 self-healing-bootstrap pattern intact: `cmd_update` + `cmd_bootstrap` from PR #43 (`0f0828e`)

---

## Where state lives (C.3 conventions)

- **`bin/hive` edits:** add 3 new helper functions + 1 new hidden test subcommand + extension to `cmd_update`'s argument parsing for `--rollback` flag
- **No edits to C.1 or C.2 helpers** — purely additive composition
- **No new files at framework repo root**

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-C.2)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at `a1cf5e5` (C.2 merge) or C.3-spec commit. C.3 implementation should NOT be in main yet.

### 2. C.1 + C.2 helpers present in `bin/hive`

```bash
grep -nE '^_update_(acquire_lock|stage_setup|fetch_current_metadata|download_tarball|verify_checksum|extract_tarball|apply_overlay|revert_overlay)\(\)' bin/hive | head -10
```

Expected: 8 functions listed. Verifies C.1 + C.2 merged cleanly. **HALT and ping house-md** if any are missing.

### 3. C.3 target functions absent

```bash
grep -nE '^(_update_(run_full_flow_with_revert|find_latest_shadow_ts|run_rollback))\(\)' bin/hive | head -10
```

Expected: empty. **HALT and ping house-md** if any C.3 helpers exist (out-of-band).

### 4. Existing `cmd_update` shape (for `--rollback` flag insertion point)

```bash
grep -nA 30 '^cmd_update\(\)' bin/hive | head -50
```

Expected: v1.4.9 cmd_update body visible. Worker reads it carefully — the `--rollback` flag insertion happens at the TOP of the function, before any git-pull logic, branching to `_update_run_rollback` if present, otherwise falling through unchanged.

### 5. Required tooling already verified in C.1/C.2

```bash
which flock && which find && which sort && which awk && echo "tooling: ✓"
```

Expected: all present (already used by C.1/C.2). Belt-and-suspenders verification.

### 6. Verify `~/neato-hive/.update-staging/` clean state

```bash
test -d ~/neato-hive/.update-staging && (ls -1 ~/neato-hive/.update-staging | head -5) || echo ".update-staging: not present (expected outside test runs)"
ls -la ~/neato-hive/.dist.old.* 2>/dev/null | head -3 || echo "no .dist.old.* shadows (expected)"
```

Expected: clean baseline — no leftover staging or shadow files from prior dev runs. Worker's tests use `HIVE_INSTALL_ROOT=/tmp/C3-sandbox-install` so live install is untouched, but worth capturing baseline.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-C.3-lockfile-rollback`.

**Diff lock: 1 path.**
- `bin/hive` (MODIFY — add C.3 helpers + 1 hidden subcommand + `--rollback` flag in `cmd_update`)

No edits elsewhere. No CHANGELOG bump.

### A.1 — `_update_run_full_flow_with_revert [--dry-run] [--inject-failure-after <step>]`

The full orchestrator. Composes C.1 + C.2 with mid-flow auto-revert. Returns 0 on success, non-zero on failure (after auto-revert). On success, prints summary + the `.old.<ts>` shadow location for the user.

```bash
_update_run_full_flow_with_revert() {
  local dry_run=0
  local inject_failure_after=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --inject-failure-after) inject_failure_after="$2"; shift 2 ;;
      *) echo "ERROR: unknown arg '$1'" >&2; return 2 ;;
    esac
  done

  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"

  echo "==> [full-flow] start"

  # 1. Acquire lock
  if ! _update_acquire_lock; then
    return 1
  fi
  echo "    lock acquired"

  # 2. Set up staging
  local staging_dir
  if ! staging_dir=$(_update_stage_setup); then
    return 1
  fi
  echo "    staging: ${staging_dir}"

  # Trap to clean up staging on exit, unless --keep-staging is set (future leaf)
  trap '_update_stage_cleanup "${staging_dir}" || true' EXIT

  # 3. Fetch metadata
  local metadata="${staging_dir}/current.json"
  if ! _update_fetch_current_metadata "${metadata}"; then
    return 1
  fi
  if [ "${inject_failure_after}" = "fetch" ]; then echo "INJECTED FAILURE after fetch" >&2; return 99; fi

  local remote_version remote_url remote_sha
  remote_version=$(jq -r '.version' "${metadata}")
  remote_url=$(jq -r '.tarball_url' "${metadata}")
  remote_sha=$(jq -r '.checksum_sha256' "${metadata}")

  # 4. Compare versions
  local local_version
  if local_version=$(_update_local_version 2>/dev/null); then
    if _update_compare_versions "${local_version}" "${remote_version}"; then
      echo "==> Already at v${local_version}; no update needed."
      return 0
    fi
    echo "==> Update available: v${local_version} → v${remote_version}"
  else
    echo "==> Update available: → v${remote_version}"
  fi

  if [ "${dry_run}" -eq 1 ]; then
    echo "==> --dry-run: not downloading. Exiting."
    return 0
  fi

  # 5. Disk-space pre-flight (200 MB upper bound)
  if ! _update_diskspace_check 209715200; then
    return 1
  fi

  # 6. Download tarball
  local tarball_path="${staging_dir}/$(basename "${remote_url}")"
  if ! _update_download_tarball "${remote_url}" "${tarball_path}"; then
    return 1
  fi
  if [ "${inject_failure_after}" = "download" ]; then echo "INJECTED FAILURE after download" >&2; return 99; fi

  # 7. Verify checksum
  if ! _update_verify_checksum "${tarball_path}" "${remote_sha}"; then
    return 1
  fi
  if [ "${inject_failure_after}" = "verify" ]; then echo "INJECTED FAILURE after verify" >&2; return 99; fi

  # 8. Extract tarball
  if ! _update_extract_tarball "${tarball_path}" "${staging_dir}"; then
    return 1
  fi
  if [ "${inject_failure_after}" = "extract" ]; then echo "INJECTED FAILURE after extract" >&2; return 99; fi

  # 9. Apply overlay (with built-in auto-revert on per-item failure from C.2)
  local ts
  if ! ts=$(_update_apply_overlay "${staging_dir}" | tail -1); then
    echo "==> overlay apply failed; revert handled internally by _update_apply_overlay"
    return 1
  fi

  if [ "${inject_failure_after}" = "apply" ]; then
    echo "INJECTED FAILURE after overlay apply — invoking revert via shadow ts ${ts}" >&2
    _update_revert_overlay "${ts}" "${staging_dir}/applied.list"
    return 99
  fi

  echo ""
  echo "==> [full-flow] success."
  echo "    Updated: ${local_version:-<none>} → ${remote_version}"
  echo "    Shadow files (recoverable): ${install_root}/.<item>.old.${ts}"
  echo "    Manifest: ${staging_dir}/applied.list"
  echo "    Doctor sweep deferred to C.4 — manually verify install integrity."
  echo ""
  echo "==> If something's wrong: hive update --rollback"
  echo "==> .old.<ts> cleanup deferred to C.4 (doctor success path)."
  return 0
}
```

### A.2 — `_update_find_latest_shadow_ts`

Finds the most recent `.old.<ts>` shadow in install root, locates its manifest. Outputs `<ts>` and `<manifest_path>` separated by tab on stdout. Returns non-zero if no shadow found.

```bash
_update_find_latest_shadow_ts() {
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"

  # Find all .old.<ts> shadows; extract the ts portion; sort desc; take first
  local latest_ts
  latest_ts=$(find "${install_root}" -maxdepth 1 -name '.*.old.*' 2>/dev/null \
    | sed -E 's|.*\.old\.||' \
    | sort -ru \
    | head -1)

  if [ -z "${latest_ts}" ]; then
    echo "ERROR: no .old.<ts> shadows found in ${install_root}" >&2
    echo "       (no rollback target)" >&2
    return 1
  fi

  # Find the corresponding manifest under .update-staging/
  local manifest
  manifest=$(grep -lr "" "${install_root}/.update-staging/"*"/applied.list" 2>/dev/null \
    | head -1)

  if [ -z "${manifest}" ]; then
    echo "ERROR: no applied.list manifest found under ${install_root}/.update-staging/" >&2
    echo "       (cannot determine REPLACE_LIST order for rollback)" >&2
    echo "       Manual recovery: walk ${install_root}/.<item>.old.${latest_ts} files yourself." >&2
    return 1
  fi

  printf '%s\t%s\n' "${latest_ts}" "${manifest}"
  return 0
}
```

**Note on manifest finding:** if multiple `.update-staging/<id>/` dirs exist (rare — usually staging cleans up post-flow), the first one returned by `grep -lr` is used. In practice, C.3's auto-revert and C.4's cleanup both clean staging, so post-success there's at most one orphan staging dir. If multiple exist, the user can pass an explicit manifest path via `--manifest <path>`.

### A.3 — `_update_run_rollback [--manifest <path>]`

User-facing rollback orchestrator. Acquires lock, finds latest shadow, runs revert, reports.

```bash
_update_run_rollback() {
  local explicit_manifest=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --manifest) explicit_manifest="$2"; shift 2 ;;
      *) echo "ERROR: unknown arg '$1'" >&2; return 2 ;;
    esac
  done

  echo "==> [rollback] start"

  if ! _update_acquire_lock; then
    return 1
  fi
  echo "    lock acquired"

  local ts manifest
  if [ -n "${explicit_manifest}" ]; then
    if [ ! -f "${explicit_manifest}" ]; then
      echo "ERROR: explicit manifest not found: ${explicit_manifest}" >&2
      return 1
    fi
    # ts must be inferrable from one of the shadow filenames; use the first one we find
    local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
    ts=$(find "${install_root}" -maxdepth 1 -name '.*.old.*' 2>/dev/null | sed -E 's|.*\.old\.||' | sort -ru | head -1)
    manifest="${explicit_manifest}"
  else
    local pair
    if ! pair=$(_update_find_latest_shadow_ts); then
      return 1
    fi
    ts=$(printf '%s' "${pair}" | cut -f1)
    manifest=$(printf '%s' "${pair}" | cut -f2)
  fi

  echo "    rollback target ts: ${ts}"
  echo "    manifest: ${manifest}"
  echo ""

  if ! _update_revert_overlay "${ts}" "${manifest}"; then
    echo "==> Rollback completed with errors. Manual recovery may be needed." >&2
    return 1
  fi

  echo ""
  echo "==> [rollback] complete."
  echo "    Restored from .old.${ts} shadows."
  echo "    Cleanup of staging dir + remaining shadow artifacts is C.4's job (run hive doctor --fix when available)."
  return 0
}
```

### A.4 — Hidden test subcommand `hive _update-full-flow [--dry-run] [--inject-failure-after <step>]`

Wraps `_update_run_full_flow_with_revert` for testing.

```bash
cmd_update_full_flow() {
  _update_run_full_flow_with_revert "$@"
}
```

### A.5 — Extension to `cmd_update` for `--rollback` flag

At the TOP of `cmd_update`, BEFORE any v1.4.9 git-pull logic:

```bash
cmd_update() {
  # C.3 — rollback path. Branches to _update_run_rollback if --rollback is the first arg.
  # If absent, falls through to v1.4.9 git-pull behavior (unchanged).
  if [ "${1:-}" = "--rollback" ]; then
    shift
    _update_run_rollback "$@"
    return $?
  fi

  # ... existing v1.4.9 cmd_update body unchanged ...
}
```

Worker captures the existing cmd_update body verbatim in the PR body's pre-flight #4 output, and confirms the diff is ONLY the prepended branch (no other changes to cmd_update logic).

### A.6 — Wire `_update-full-flow` into the case dispatcher

```bash
# In the main case dispatch block (alongside _update-fetch-stage from C.1, _update-overlay-apply/revert from C.2):
_update-full-flow)
  cmd_update_full_flow "$@"
  ;;
```

### A.7 — Add brief comment block above C.3 functions

```bash
# v1.5.0 C.3 — full-flow orchestrator + rollback path.
# - _update_run_full_flow_with_revert: composes C.1 fetch+verify+stage + C.2 extract+apply
#   with auto-revert on mid-flow failure. Hidden via _update-full-flow subcommand for testing.
# - _update_find_latest_shadow_ts: locates the most recent .old.<ts> + corresponding manifest
# - _update_run_rollback: user-facing rollback orchestrator. Wired via cmd_update --rollback.
# Cut-over of cmd_update from v1.4.9 git-pull to the new pipeline is C.7's job.
# Spec: docs/v1.5.0-tasks/C.3-lockfile-rollback.md
```

---

## B. Tests (run during the worker turn — sandbox-isolated)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Capture warning-count delta vs C.2 baseline; new code should add zero
```

### B.2 — Sandbox setup (mirrors C.2 pattern, plus pre-staged fixture tarball)

```bash
SANDBOX=/tmp/C3-sandbox-install
rm -rf "${SANDBOX}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"
echo "old-dist" > "${SANDBOX}/dist/index.js"

# Build a real tarball with the current package.json version using B.1 pipeline
cd ~/neato-hive
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -3

# Set up a synthetic API fixture — file:// pointing at a JSON describing the tarball
TARBALL_PATH="/tmp/neato-hive-v${CURRENT_VERSION}.tar.gz"
TARBALL_SHA=$(awk '{print $1}' "/tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt")
mkdir -p /tmp/C3-fixture
cat > /tmp/C3-fixture/current.json <<EOF
{
  "version": "${CURRENT_VERSION}",
  "tarball_url": "file://${TARBALL_PATH}",
  "checksum_sha256": "${TARBALL_SHA}",
  "released_at": "2026-05-07T00:00:00Z",
  "changelog_url": "http://localhost/changelog.html"
}
EOF
```

### B.3 — Test full-flow happy path (sandbox install starts at "old", overlay applies real tarball)

```bash
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_RELEASES_API=file:///tmp/C3-fixture/current.json \
HIVE_LOCK_FILE=/tmp/C3-test.lock \
  bash bin/hive _update-full-flow 2>&1 | tail -30

# Verify post-flow state
test "$(cat "${SANDBOX}/VERSION")" = "${CURRENT_VERSION}" && echo "VERSION: new content ✓" || echo "VERSION: FAIL"
ls "${SANDBOX}/.VERSION.old."* 2>&1 | head -1 && echo "shadow created: ✓" || echo "shadow created: FAIL"
ls "${SANDBOX}/.update-staging/"*"/applied.list" 2>&1 && echo "manifest exists: ✓"
```

### B.4 — Test rollback path

```bash
# Rollback the just-applied overlay
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_LOCK_FILE=/tmp/C3-test.lock \
  bash bin/hive update --rollback 2>&1 | tail -20

# Verify post-rollback state — back to "old"
test "$(cat "${SANDBOX}/VERSION")" = "old-version" && echo "VERSION restored: ✓" || echo "VERSION restored: FAIL"
test ! -e "${SANDBOX}/.VERSION.old."* 2>&1 && echo "shadow cleaned: ✓" || echo "shadow cleaned: FAIL"
```

### B.5 — Test mid-flow failure auto-revert (--inject-failure-after apply)

```bash
# Reset sandbox
rm -rf "${SANDBOX}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"
echo "old-dist" > "${SANDBOX}/dist/index.js"

# Inject failure after overlay apply — should auto-revert
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_RELEASES_API=file:///tmp/C3-fixture/current.json \
HIVE_LOCK_FILE=/tmp/C3-test.lock \
  bash bin/hive _update-full-flow --inject-failure-after apply 2>&1 | tail -20

# Verify post-failure state — auto-revert restored "old"
test "$(cat "${SANDBOX}/VERSION")" = "old-version" && echo "VERSION auto-reverted: ✓" || echo "VERSION auto-reverted: FAIL"
test ! -e "${SANDBOX}/.VERSION.old."* 2>&1 && echo "shadow cleaned by auto-revert: ✓" || echo "shadow cleaned by auto-revert: FAIL"
```

### B.6 — Test --dry-run path

```bash
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_RELEASES_API=file:///tmp/C3-fixture/current.json \
HIVE_LOCK_FILE=/tmp/C3-test.lock \
  bash bin/hive _update-full-flow --dry-run 2>&1 | tail -10

# Verify dry-run did NOT change sandbox state
test "$(cat "${SANDBOX}/VERSION")" = "old-version" && echo "dry-run no state change: ✓"
test ! -e "${SANDBOX}/.VERSION.old."* 2>&1 && echo "dry-run no shadow: ✓"
```

### B.7 — Confirm v1.4.9 cmd_update behavior unchanged when --rollback absent

```bash
# Inspect cmd_update with empty args
grep -nA 5 '^cmd_update\(\)' bin/hive | head -10
# Expect: --rollback branch at top, falls through to existing v1.4.9 logic if not present
# Worker eyeballs the diff to confirm zero changes to v1.4.9 git-pull body
```

### B.8 — Cleanup

```bash
rm -rf /tmp/C3-sandbox-install /tmp/C3-fixture /tmp/C3-test.lock
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` introduces ZERO new warnings (delta vs C.2 baseline)
- [ ] B.3 happy path: full-flow applies overlay, sandbox VERSION is the new content, shadow + manifest exist
- [ ] B.4 rollback: `hive update --rollback` restores VERSION to old content + cleans shadows
- [ ] B.5 auto-revert: `--inject-failure-after apply` triggers revert, sandbox state restored
- [ ] B.6 dry-run: no sandbox state change
- [ ] B.7 v1.4.9 cmd_update body unchanged when `--rollback` flag absent
- [ ] Live install untouched (verify `~/neato-hive/.dist.old.*` empty post-tests)
- [ ] PR body contains: pre-flight 1-6 outputs, B.3-B.7 outputs, shellcheck delta, diff-lock confirmation, "live install untouched" verification

---

## D. When done (DONE block template for Bob to fill)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. C.1+C.2 helpers present: 8 ✓
  3. C.3 helpers absent: ✓
  4. cmd_update existing body: <verbatim head — confirms no out-of-band edits>
  5. tooling: flock ✓ find ✓ sort ✓ awk ✓
  6. clean baseline: no leftover staging/shadows in live install

Tooling check:
  bash -n: ✓
  shellcheck delta vs C.2 baseline: 0 new warnings

Tests (sandbox at /tmp/C3-sandbox-install):
  B.3 happy-path full-flow:
    VERSION: new content ✓ / shadow ✓ / manifest exists ✓
  B.4 rollback:
    VERSION restored ✓ / shadow cleaned ✓
  B.5 auto-revert (--inject-failure-after apply):
    VERSION auto-reverted ✓ / shadow cleaned by auto-revert ✓
  B.6 dry-run:
    no state change ✓ / no shadow ✓
  B.7 v1.4.9 cmd_update body intact:
    diff confirms only --rollback branch prepended; v1.4.9 git-pull body unchanged

Live install verification:
  ls ~/neato-hive/.dist.old.* : <empty — confirmed untouched>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.3-lockfile-rollback
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — all 3 helpers + 1 hidden subcommand + cmd_update branch + comment block in single PR
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop
- **DO NOT TOUCH LIVE INSTALL** — all destructive tests use `HIVE_INSTALL_ROOT=/tmp/C3-sandbox-install`. Worker MUST verify `~/neato-hive/.dist.old.*` empty post-tests.
- **DO NOT CHANGE v1.4.9 cmd_update BEHAVIOR** when `--rollback` is absent. ONLY add the `--rollback` branch at the top. Verify via diff inspection.
- **DO NOT CUT OVER cmd_update to new pipeline** — that's C.7's job (or a separate cut-over leaf). C.3 keeps git-pull behavior for `hive update` with no flag.
- **HALT-and-ping rule** — pre-flight surprises (existing C.3 helpers, missing C.1/C.2 helpers, cmd_update structure unexpected) stop the worker; ping house-md via SendMessage with kind=delegation
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup
- **on-complete prompt is bob-aimed** — tells Bob what to verify (sandbox tests, live install untouched, shellcheck delta zero, diff lock 1 path, cmd_update body intact), then ping house-md via SendMessage with kind=delegation
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift OK pre-flight (matches v1.4.9 + C.1/C.2 pattern)
- **No new shell-tool deps** — C.3 uses only flock/find/sort/awk/sed (all standard, all already used by C.1/C.2). Wizard-dep-rule clean.

---

## F. Forward links

- C.4 — Doctor sweep + `.old.<ts>` cleanup. Wires `hive doctor --fix --yes` post-overlay-apply. On doctor success: deletes `.<item>.old.<ts>` shadows + the staging dir + the manifest. On failure: leaves shadows in place, surfaces `hive update --rollback` command in error message. Folds in `pnpm install --frozen-lockfile` post-extract per Q2.
- C.5 — `hive update --check --json` mode. Calls `_update_fetch_current_metadata` + `_update_compare_versions`, emits structured JSON for dashboard `/api/update/check`.
- C.6 — State-file emission to `~/.neato-hive/state/update-<id>.jsonl` for SSE relay (Q1 architecture). Per-event types `start | step | step_done | error | done`. Each step in `_update_run_full_flow_with_revert` emits a `step` event; on success/failure emits `done`.
- C.7 — v1.4.x → v1.5.0 implicit migration handler. Detects first-v1.5.0 update, generates dashboard token, adds `hive-dashboard` to PM2 ecosystem. **May also be the cut-over leaf** that flips `cmd_update` to call `_update_run_full_flow_with_revert` instead of git-pull. Or a separate leaf does that.
