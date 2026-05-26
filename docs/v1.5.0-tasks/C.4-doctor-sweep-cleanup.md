# v1.5.0 C.4 — Doctor Sweep + Cleanup + PRESERVE_LIST Verification

**Status:** LOCKED — Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.4 (4 of 7 in Phase C)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.3 ✅ merged 2026-05-07 16:36:23Z — PR #56 squash `166d22a` (full-flow orchestrator + rollback)
**Successor:** C.5 — `hive update --check --json` mode (consumes C.1's `_update_fetch_current_metadata`)

---

## Goal

Close the success-and-failure paths of the post-overlay finalize sequence:

1. **`pnpm install --frozen-lockfile`** post-extract per Q2 (no pre-built node_modules in tarball; consumer installs)
2. **PRESERVE_LIST byte-identical verification gate** — hash-diff every file under `agents/`, `data/`, `config/*.local.yaml`, `.env`, `~/.neato-hive/skills/` pre/post overlay; HALT (revert) on any drift. Hard guarantee: agent files are NEVER touched by `hive update`.
3. **Doctor sweep** — call `cmd_doctor --fix --yes` post-overlay
4. **On success:** delete all `.<item>.old.<ts>` shadows + delete the staging dir + cleanup any orphaned empty `.update-staging/<id>/` directories from prior aborted runs
5. **On failure:** preserve `.<item>.old.<ts>` shadows for recovery + surface `hive update --rollback` instruction (composition check with C.3)

C.4 extends C.3's `_update_run_full_flow_with_revert` to call a new `_update_post_overlay_finalize` step after `_update_apply_overlay`. The orchestrator becomes:

```
acquire_lock → stage_setup → fetch → compare → diskspace → download → verify
  → preserve_list_hash_capture (NEW C.4)
  → extract → apply_overlay
  → post_overlay_finalize (NEW C.4 — pnpm install → preserve verify → doctor → cleanup-or-rollback)
```

Phase C closes after C.5 (`--check --json`), C.6 (state-file SSE), C.7 (migration). After C.4 the success path leaves a clean install with no shadow artifacts; the failure path preserves recoverable state.

---

## Architectural givens (carried)

- **Q2 — `pnpm install --frozen-lockfile`:** runs against `~/neato-hive/` after overlay applies new `package.json` + `pnpm-lock.yaml`. Tarball ships without `node_modules/`. ABI-safe across Node 18/20/22.
- **PRESERVE_LIST canonical** (from C.2):
  - `agents/` (recursively)
  - `data/` (recursively)
  - `config/*.local.yaml`
  - `.env`, `.env.local`, `*.local.*`
  - `~/.neato-hive/skills/` (recursively — Q10 forward-flex for skill-shop)
- **Hash strategy:** SHA-256 per file. Output: tab-separated `<sha256>\t<relative-path>` per line. Manifest at `<staging_dir>/preserve.baseline` (pre-overlay) + `<staging_dir>/preserve.verify` (post-overlay). Diff via `diff -q`.
- **Shadow cleanup contract:** after doctor success, remove ALL `.<item>.old.<ts>` files where `<ts>` matches the current update's timestamp. Don't touch shadows from earlier runs (preserves recovery for prior updates).
- **Staging residue cleanup:** find `~/neato-hive/.update-staging/<id>/` directories older than 7 days OR with no `applied.list` file (aborted partial runs); remove. Idempotent, no-op if clean.
- **Doctor sweep:** calls existing `cmd_doctor --fix --yes` (v1.4.9 self-healing-bootstrap shipped this). C.4 just wraps + checks exit code.
- **`HIVE_UPDATE_SKIP_DOCTOR=1`** env var override — for sandbox tests where doctor would fail against fixture install. Worker tests use this flag.

---

## Pre-conditions

- C.3 ✅ merged (PR #56 squash `166d22a`); C.1 + C.2 + C.3 helpers all present in `bin/hive`
- `cmd_doctor` exists from v1.4.9 (verified via `grep -nE '^cmd_doctor\(\)' bin/hive`)

---

## Where state lives (C.4 conventions)

- **`bin/hive` edits:** add 7 new helper functions + extend `_update_run_full_flow_with_revert` (small additive — capture baseline before overlay, call finalize after)
- **PRESERVE_LIST baseline manifest:** `<staging_dir>/preserve.baseline` (pre-overlay state)
- **PRESERVE_LIST verification manifest:** `<staging_dir>/preserve.verify` (post-overlay state)

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-C.3)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at C.3 merge (`166d22a`) or C.4-spec commit.

### 2. C.1+C.2+C.3 helpers present + `cmd_doctor` present

```bash
grep -nE '^(_update_(acquire_lock|stage_setup|fetch_current_metadata|download_tarball|verify_checksum|extract_tarball|apply_overlay|revert_overlay|run_full_flow_with_revert|find_latest_shadow_ts|run_rollback)|cmd_doctor)\(\)' bin/hive | head -15
```

Expected: 11 C-leaf functions + cmd_doctor. **HALT and ping house-md** if any are missing.

### 3. C.4 target functions absent

```bash
grep -nE '^_update_(pnpm_install_post_extract|doctor_sweep|preserve_list_hash_capture|preserve_list_hash_verify|cleanup_shadows|cleanup_staging_residue|post_overlay_finalize)\(\)' bin/hive | head -10
```

Expected: empty.

### 4. Tooling check

```bash
which pnpm && pnpm --version
which shasum && echo "shasum: ✓"
which sort && echo "sort: ✓"
which diff && echo "diff: ✓"
which find && echo "find: ✓"
```

Expected: all present.

### 5. Existing `_update_run_full_flow_with_revert` shape (for clean extension)

```bash
grep -nA 60 '^_update_run_full_flow_with_revert\(\)' bin/hive | head -80
```

Expected: C.3 orchestrator visible. Worker reads carefully — extension adds `preserve_list_hash_capture` BEFORE `_update_apply_overlay` and `_update_post_overlay_finalize` AFTER. No edits to existing logic.

### 6. Sandbox state clean

```bash
test -d /tmp/C4-sandbox-install && echo "C4-sandbox-install EXISTS — clean before tests" || echo "/tmp/C4-sandbox-install: not present"
ls ~/neato-hive/.dist.old.* 2>&1 | head -3 || echo "no live-install shadows (expected)"
```

Expected: clean baseline.

---

## A. Deliverables

Single PR. Branch: `feat/v1.5.0-C.4-doctor-sweep-cleanup`.

**Diff lock: 1 path (`bin/hive`).**

### A.1 — `_update_pnpm_install_post_extract`

Runs `pnpm install --frozen-lockfile` in install root. Returns non-zero on failure.

```bash
_update_pnpm_install_post_extract() {
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"

  if [ ! -f "${install_root}/package.json" ] || [ ! -f "${install_root}/pnpm-lock.yaml" ]; then
    echo "ERROR: package.json or pnpm-lock.yaml missing in ${install_root}" >&2
    return 1
  fi

  echo "==> Running pnpm install --frozen-lockfile in ${install_root}..."
  if ! (cd "${install_root}" && pnpm install --frozen-lockfile 2>&1 | tail -10); then
    echo "ERROR: pnpm install --frozen-lockfile failed" >&2
    return 1
  fi
  return 0
}
```

### A.2 — `_update_preserve_list_hash_capture <output_manifest>`

Captures SHA-256 of every PRESERVE_LIST file. Output format: tab-separated `<sha256>\t<absolute-path>` per line, sorted by path for deterministic diff.

```bash
_update_preserve_list_hash_capture() {
  local out="$1"
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
  local hive_state="${HIVE_STATE_ROOT:-$HOME/.neato-hive}"

  : > "${out}"

  # Collect candidate paths
  local -a sources=()
  [ -d "${install_root}/agents" ] && sources+=("${install_root}/agents")
  [ -d "${install_root}/data" ] && sources+=("${install_root}/data")
  [ -d "${install_root}/config" ] && sources+=("${install_root}/config")
  [ -d "${hive_state}/skills" ] && sources+=("${hive_state}/skills")

  if [ "${#sources[@]}" -gt 0 ]; then
    find "${sources[@]}" -type f 2>/dev/null \
      | sort \
      | while IFS= read -r f; do
          local sha
          sha=$(shasum -a 256 "${f}" | awk '{print $1}')
          printf '%s\t%s\n' "${sha}" "${f}"
        done >> "${out}"
  fi

  # Glob top-level files
  for f in "${install_root}/.env" "${install_root}/.env.local" "${install_root}/config/agents.local.yaml" "${install_root}/config/users.local.yaml"; do
    if [ -f "${f}" ]; then
      local sha
      sha=$(shasum -a 256 "${f}" | awk '{print $1}')
      printf '%s\t%s\n' "${sha}" "${f}"
    fi
  done >> "${out}"

  # Sort final manifest for deterministic diff
  sort -o "${out}" "${out}"
  return 0
}
```

### A.3 — `_update_preserve_list_hash_verify <baseline_file>`

Captures current state and compares to baseline. Returns 0 if byte-identical, non-zero if any drift.

```bash
_update_preserve_list_hash_verify() {
  local baseline="$1"
  if [ ! -f "${baseline}" ]; then
    echo "ERROR: baseline manifest not found: ${baseline}" >&2
    return 1
  fi

  local verify_file="${baseline%.baseline}.verify"
  _update_preserve_list_hash_capture "${verify_file}"

  if ! diff -q "${baseline}" "${verify_file}" >/dev/null 2>&1; then
    echo "ERROR: PRESERVE_LIST drift detected — overlay touched protected files" >&2
    echo "       baseline: ${baseline}" >&2
    echo "       verify:   ${verify_file}" >&2
    diff "${baseline}" "${verify_file}" | head -20 >&2
    return 1
  fi
  return 0
}
```

### A.4 — `_update_doctor_sweep`

Calls `cmd_doctor --fix --yes`. Honors `HIVE_UPDATE_SKIP_DOCTOR=1` env override for sandbox tests.

```bash
_update_doctor_sweep() {
  if [ "${HIVE_UPDATE_SKIP_DOCTOR:-0}" = "1" ]; then
    echo "==> Doctor sweep SKIPPED (HIVE_UPDATE_SKIP_DOCTOR=1)"
    return 0
  fi

  echo "==> Running cmd_doctor --fix --yes..."
  if ! cmd_doctor --fix --yes 2>&1 | tail -20; then
    echo "ERROR: doctor sweep returned non-zero" >&2
    return 1
  fi
  echo "==> Doctor sweep clean."
  return 0
}
```

### A.5 — `_update_cleanup_shadows <ts>`

Removes all `.<item>.old.<ts>` shadows in install root for the given timestamp.

```bash
_update_cleanup_shadows() {
  local ts="$1"
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
  if [ -z "${ts}" ]; then
    echo "ERROR: _update_cleanup_shadows requires <ts>" >&2
    return 1
  fi

  local count=0
  while IFS= read -r shadow; do
    [ -z "${shadow}" ] && continue
    rm -rf "${shadow}"
    count=$((count + 1))
  done < <(find "${install_root}" -maxdepth 1 -name ".*.old.${ts}" 2>/dev/null)

  echo "==> Removed ${count} shadow(s) matching ts=${ts}"
  return 0
}
```

### A.6 — `_update_cleanup_staging_residue`

Removes `.update-staging/<id>/` directories older than 7 days OR missing `applied.list` (aborted/orphaned).

```bash
_update_cleanup_staging_residue() {
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
  local staging_root="${install_root}/.update-staging"

  if [ ! -d "${staging_root}" ]; then
    return 0
  fi

  local count=0
  while IFS= read -r dir; do
    [ -z "${dir}" ] && continue
    # Remove if older than 7 days OR no applied.list (aborted run)
    if find "${dir}" -maxdepth 0 -mtime +7 2>/dev/null | grep -q . \
       || [ ! -f "${dir}/applied.list" ]; then
      rm -rf "${dir}"
      count=$((count + 1))
    fi
  done < <(find "${staging_root}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)

  if [ "${count}" -gt 0 ]; then
    echo "==> Cleaned up ${count} staging residue dir(s)"
  fi
  return 0
}
```

### A.7 — `_update_post_overlay_finalize <ts> <staging_dir> <preserve_baseline>`

Orchestrator. On success: cleanup. On failure: revert via C.2 helper, return non-zero. Caller surfaces rollback hint via existing C.3 messaging.

```bash
_update_post_overlay_finalize() {
  local ts="$1"
  local staging_dir="$2"
  local preserve_baseline="$3"

  echo "==> [post-overlay-finalize] start (ts=${ts})"

  # Step 1: pnpm install --frozen-lockfile
  if ! _update_pnpm_install_post_extract; then
    echo "==> finalize: pnpm install failed → reverting"
    _update_revert_overlay "${ts}" "${staging_dir}/applied.list"
    return 1
  fi

  # Step 2: PRESERVE_LIST byte-identical verification
  if ! _update_preserve_list_hash_verify "${preserve_baseline}"; then
    echo "==> finalize: PRESERVE_LIST drift detected → reverting"
    _update_revert_overlay "${ts}" "${staging_dir}/applied.list"
    return 1
  fi
  echo "    PRESERVE_LIST byte-identical ✓"

  # Step 3: Doctor sweep
  if ! _update_doctor_sweep; then
    echo "==> finalize: doctor sweep failed — preserving shadows for rollback"
    echo "    Recovery: hive update --rollback"
    return 1
  fi

  # Step 4: Cleanup shadows + staging
  _update_cleanup_shadows "${ts}"
  _update_stage_cleanup "${staging_dir}"
  _update_cleanup_staging_residue

  echo "==> [post-overlay-finalize] success — install clean."
  return 0
}
```

### A.8 — Extension to `_update_run_full_flow_with_revert`

Two small additions (purely additive — no edits to existing logic):

**Before `_update_apply_overlay` call**, add baseline capture:
```bash
local preserve_baseline="${staging_dir}/preserve.baseline"
echo "==> Capturing PRESERVE_LIST baseline..."
_update_preserve_list_hash_capture "${preserve_baseline}"
```

**Replace the closing success message** with a call to finalize:
```bash
# Replace the existing closing block:
#   echo "==> [full-flow] success."
#   echo "    Updated: ..."
#   echo "    Shadow files (recoverable): ..."
#   echo "    Manifest: ..."
#   echo "    Doctor sweep deferred to C.4 — manually verify install integrity."
#   echo "    If something's wrong: hive update --rollback"
#   return 0
# WITH:
if ! _update_post_overlay_finalize "${ts}" "${staging_dir}" "${preserve_baseline}"; then
  echo "==> [full-flow] finalize failed — install state reverted OR shadows preserved for rollback"
  return 1
fi

# Update trap to NOT clean staging on success (finalize already did it)
trap - EXIT

echo ""
echo "==> [full-flow] complete."
echo "    Updated: ${local_version:-<none>} → ${remote_version}"
echo "    Install verified (doctor green) and clean (shadows removed)."
return 0
```

### A.9 — Brief comment block above C.4 functions

```bash
# v1.5.0 C.4 — doctor sweep + cleanup + PRESERVE_LIST verification.
# - _update_pnpm_install_post_extract: pnpm install --frozen-lockfile (Q2)
# - _update_preserve_list_hash_capture / _verify: byte-identical guarantee (HARD GATE)
# - _update_doctor_sweep: cmd_doctor --fix --yes wrapper (HIVE_UPDATE_SKIP_DOCTOR=1 to skip in sandbox)
# - _update_cleanup_shadows: rm .<item>.old.<ts> on doctor success
# - _update_cleanup_staging_residue: rm orphan .update-staging/<id>/ from aborted runs
# - _update_post_overlay_finalize: orchestrator — install → preserve verify → doctor → cleanup OR revert
# Spec: docs/v1.5.0-tasks/C.4-doctor-sweep-cleanup.md
```

---

## B. Tests (sandbox-isolated, live install untouched)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20  # zero new warnings vs C.3 baseline
```

### B.2 — Sandbox setup with PRESERVE_LIST fixture content

```bash
SANDBOX=/tmp/C4-sandbox-install
HIVE_STATE=/tmp/C4-sandbox-state
rm -rf "${SANDBOX}" "${HIVE_STATE}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
mkdir -p "${SANDBOX}/agents/atlas" "${SANDBOX}/data" "${SANDBOX}/config" "${HIVE_STATE}/skills"

# REPLACE_LIST fixture (will be overlaid)
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"
cp ~/neato-hive/pnpm-lock.yaml "${SANDBOX}/pnpm-lock.yaml"

# PRESERVE_LIST fixture (must NOT be touched)
echo "atlas-memory" > "${SANDBOX}/agents/atlas/memory.md"
echo "data-blob" > "${SANDBOX}/data/state.json"
echo "config-local" > "${SANDBOX}/config/agents.local.yaml"
echo "secret" > "${SANDBOX}/.env"
echo "user-skill" > "${HIVE_STATE}/skills/my-custom-skill.md"

# Build a real tarball for fixture
cd ~/neato-hive
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -3
TARBALL_SHA=$(awk '{print $1}' "/tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt")

mkdir -p /tmp/C4-fixture
cat > /tmp/C4-fixture/current.json <<EOF
{"version":"${CURRENT_VERSION}","tarball_url":"file:///tmp/neato-hive-v${CURRENT_VERSION}.tar.gz","checksum_sha256":"${TARBALL_SHA}","released_at":"2026-05-07T00:00:00Z","changelog_url":"http://localhost/x"}
EOF
```

### B.3 — Happy path: full-flow + finalize

```bash
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_STATE_ROOT="${HIVE_STATE}" \
HIVE_RELEASES_API="file:///tmp/C4-fixture/current.json" \
HIVE_LOCK_FILE=/tmp/C4-test.lock \
HIVE_UPDATE_SKIP_DOCTOR=1 \
  bash bin/hive _update-full-flow 2>&1 | tail -30

# Post-conditions:
test "$(cat "${SANDBOX}/VERSION")" = "${CURRENT_VERSION}" && echo "VERSION new ✓"
test ! -e "${SANDBOX}/.VERSION.old."* 2>&1 && echo "shadows cleaned ✓"
test ! -d "${SANDBOX}/.update-staging/"* 2>&1 && echo "staging cleaned ✓" || ls "${SANDBOX}/.update-staging/"
# PRESERVE_LIST untouched
test "$(cat "${SANDBOX}/agents/atlas/memory.md")" = "atlas-memory" && echo "agents/ preserved ✓"
test "$(cat "${SANDBOX}/.env")" = "secret" && echo ".env preserved ✓"
test "$(cat "${HIVE_STATE}/skills/my-custom-skill.md")" = "user-skill" && echo "user-skills preserved ✓"
```

### B.4 — PRESERVE_LIST drift detection

```bash
# Reset sandbox
rm -rf "${SANDBOX}"
# (rebuild fixture as in B.2)

# Inject a synthetic file-touch DURING overlay by patching _update_apply_overlay
# (advanced — worker may skip if hard to inject; direct test:)

# Direct test of just the verify function:
mkdir -p /tmp/C4-verify-test
echo "original" > /tmp/C4-verify-test/.env
HIVE_INSTALL_ROOT=/tmp/C4-verify-test HIVE_STATE_ROOT=/tmp/C4-verify-test \
  bash -c 'source ~/neato-hive/bin/hive && _update_preserve_list_hash_capture /tmp/C4-baseline.txt'

# Now corrupt the file
echo "corrupted" > /tmp/C4-verify-test/.env
HIVE_INSTALL_ROOT=/tmp/C4-verify-test HIVE_STATE_ROOT=/tmp/C4-verify-test \
  bash -c 'source ~/neato-hive/bin/hive && _update_preserve_list_hash_verify /tmp/C4-baseline.txt' 2>&1
# Expected: drift detected, non-zero return

rm -rf /tmp/C4-verify-test /tmp/C4-baseline.txt /tmp/C4-baseline.verify
```

### B.5 — Doctor-fail path preserves shadows

```bash
# Run full-flow with HIVE_UPDATE_SKIP_DOCTOR=0 in sandbox (doctor will fail since sandbox isn't a real Hive)
# Expected behavior: shadows + staging preserved, "hive update --rollback" surfaced

# Reset sandbox per B.2
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_STATE_ROOT="${HIVE_STATE}" \
HIVE_RELEASES_API="file:///tmp/C4-fixture/current.json" \
HIVE_LOCK_FILE=/tmp/C4-test.lock \
  bash bin/hive _update-full-flow 2>&1 | tail -30
# Expected: doctor sweep fails, finalize returns non-zero, shadows + staging present

ls "${SANDBOX}/.VERSION.old."* 2>&1 | head -1 && echo "shadow preserved on doctor-fail ✓"
ls "${SANDBOX}/.update-staging/" 2>&1 | head -3 && echo "staging preserved ✓"

# Verify rollback works
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_LOCK_FILE=/tmp/C4-test.lock \
  bash bin/hive update --rollback 2>&1 | tail -10
test "$(cat "${SANDBOX}/VERSION")" = "old-version" && echo "rollback restored old ✓"
```

### B.6 — Staging residue cleanup

```bash
# Set up an orphaned aborted-run staging dir
mkdir -p "${SANDBOX}/.update-staging/orphan-id-aborted"
# No applied.list = aborted

HIVE_INSTALL_ROOT="${SANDBOX}" \
  bash -c 'source ~/neato-hive/bin/hive && _update_cleanup_staging_residue' 2>&1 | head -3
test ! -d "${SANDBOX}/.update-staging/orphan-id-aborted" && echo "orphan cleaned ✓"
```

### B.7 — Cleanup

```bash
rm -rf "${SANDBOX}" "${HIVE_STATE}" /tmp/C4-fixture /tmp/C4-test.lock
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` zero new warnings vs C.3 baseline
- [ ] B.3 happy path: shadows + staging cleaned, REPLACE_LIST swapped, PRESERVE_LIST byte-identical
- [ ] B.4 drift detection: corrupted PRESERVE_LIST file detected by hash-verify
- [ ] B.5 doctor-fail path: shadows + staging preserved, rollback restores old state
- [ ] B.6 residue cleanup: orphan staging dir without applied.list removed
- [ ] **Live install untouched** (verify `~/neato-hive/.dist.old.*` empty post-tests)
- [ ] PR body: pre-flight 1-6 + B.3-B.6 outputs verbatim, shellcheck delta, diff-lock confirmation, "live install untouched" verification

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. C.1+C.2+C.3 helpers + cmd_doctor present: 11 ✓
  3. C.4 helpers absent: ✓
  4. tooling: pnpm ✓ shasum ✓ sort ✓ diff ✓ find ✓
  5. existing _update_run_full_flow_with_revert shape: <captured>
  6. sandbox baseline clean

Tooling check:
  bash -n: ✓
  shellcheck delta: 0 new warnings

Tests (sandbox at /tmp/C4-sandbox-install):
  B.3 happy path: VERSION new ✓ shadows cleaned ✓ staging cleaned ✓ PRESERVE_LIST preserved ✓
  B.4 drift detection: corrupted file detected ✓
  B.5 doctor-fail path: shadow preserved ✓ rollback restored ✓
  B.6 staging residue cleanup: orphan removed ✓

Live install verification:
  ls ~/neato-hive/.dist.old.* : <empty>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.4-doctor-sweep-cleanup
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — all 7 helpers + orchestrator extension + comment block in single PR
- **DO NOT MERGE** — house-md
- **DO NOT TOUCH LIVE INSTALL** — `HIVE_INSTALL_ROOT=/tmp/C4-sandbox-install`
- **DO NOT CHANGE C.1/C.2/C.3 helpers** — purely additive composition
- **HIVE_UPDATE_SKIP_DOCTOR=1** in B.3 (sandbox can't run real doctor); B.5 explicitly tests doctor-fail path
- **HALT-and-ping rule** — pre-flight surprises stop the worker
- **on-complete prompt is bob-aimed** — pings house-md kind=delegation
- **No new shell-tool deps** — pnpm + shasum + sort + diff + find all standard. Wizard-dep-rule clean.

---

## F. Forward links

- C.5 — `hive update --check --json` mode. Calls `_update_fetch_current_metadata` + `_update_compare_versions`, emits structured JSON for dashboard `/api/update/check`.
- C.6 — State-file emission to `~/.neato-hive/state/update-<id>.jsonl` for SSE relay (Q1 architecture). C.4's finalize step naturally produces sub-events (`pnpm-install-start`, `pnpm-install-done`, `preserve-verify-start`, `preserve-verify-done`, `doctor-start`, `doctor-done`, `cleanup-done`) that map cleanly to C.6's event stream.
- C.7 — v1.4.x → v1.5.0 implicit migration handler + cut-over of `cmd_update` from git-pull to the new pipeline.
