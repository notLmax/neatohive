# v1.5.0 C.2 — Atomic-Overlay Swap (REPLACE_LIST per-item rename + new content in place)

**Status:** LOCKED — Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.2 (2 of 7 in Phase C)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.1 ✅ merged 2026-05-07 ~15:59Z — PR #54 squash `f4ac3cc` (fetch + verify + staging functions + hidden test subcommand)
**Successor:** C.3 — Lockfile (already in C.1) + rollback path (`hive update --rollback` automated command, wraps C.2's revert function)

---

## Goal

Ship the atomic-overlay swap step. After C.1's `_update_stage_setup` produces a staging dir with a verified tarball, C.2 extracts the tarball and applies REPLACE_LIST per-item swaps:

1. Rename existing `~/neato-hive/<item>` to `~/neato-hive/.<item>.old.<ts>` (hidden, recoverable)
2. Move new content from staging into `~/neato-hive/<item>`
3. On ANY mid-overlay failure: revert all already-applied swaps in reverse order, exit non-zero
4. Track applied swaps via a manifest file at `~/neato-hive/.update-staging/<id>/applied.list` (survives script crash for post-mortem recovery)

**`.old.<ts>` cleanup is C.4's job** (doctor sweep success path). C.2 leaves them in place — recoverable artifacts for rollback.

**`hive update --rollback` user-facing command is C.3's job.** C.2 ships the underlying revert function that C.3 wraps.

**C.2 ships:**
- New helper functions in `bin/hive` for extract / apply-overlay / revert-overlay / manifest-write / manifest-read
- Hidden test subcommands `hive _update-overlay-apply <staging_dir>` and `hive _update-overlay-revert <ts>` for isolated testing
- Test fixtures using `HIVE_INSTALL_ROOT` env var to point at a sandbox install dir (no risk to live install during worker turn)

**C.2 does NOT ship:**
- The user-facing `hive update --rollback` command (C.3)
- Doctor sweep / `.old.*` cleanup (C.4)
- `pnpm install --frozen-lockfile` post-extract (C.4)
- Anything from C.5/C.6/C.7

---

## Architectural givens (carried)

- **REPLACE_LIST** (per B.1's `release.sh` + canonical v1.5.0 spec):
  - Directories: `dist/`, `bin/`, `templates/`, `shared/`, `skills/`, `dashboard/` (placeholder — only swap if present in staging)
  - Files: `package.json`, `pnpm-lock.yaml`, `VERSION`
  - ~~`CHECKSUM`~~ — vestigial per Q4 resolution; B.1's release.sh does NOT include it. C.2 ignores `CHECKSUM` if it appears (defensive — old tarballs won't have it; new tarballs won't either).
- **PRESERVE_LIST** (NEVER touched by overlay):
  - Application state: `agents/`, `data/`, `config/*.local.yaml`, `.env`, `.env.local`, `*.local.*`
  - Build/dev artifacts: `node_modules/`, `.git/`, `src/`, `tsconfig.json`, `pnpm-workspace.yaml`, `dist-pkg/`, `.update-staging/`
  - Forward-flex per Q10: `~/.neato-hive/skills/` (user-installed skills, future skill-shop registry)
- **`.old.<ts>` naming convention:** leading-dot hidden, e.g. `~/neato-hive/.dist.old.20260507T160000Z`. Timestamp is UTC ISO-compact. Files (e.g. `package.json`) become `.package.json.old.<ts>`. The leading dot makes them invisible to default `ls` (less alarming for users) and prevents the new framework code from globbing them accidentally.
- **Tarball shape (from B.1):** extracts to `dist-pkg/` directory (i.e. tarball top-level is `dist-pkg/`). C.2 extracts under the staging dir, so contents end up at `~/neato-hive/.update-staging/<id>/dist-pkg/<item>`.
- **Manifest format:** plain text, one path per line, oldest-applied first. Path is the REPLACE_LIST item name (e.g. `dist`, `bin`, `package.json`). Revert walks the manifest in reverse order.
- **Same-FS guarantee:** staging dir is under `~/neato-hive/.update-staging/<id>/` (per Q3, set up in C.1). All `mv` operations stay on the same filesystem → atomic rename via inode-rename, not copy+delete.

---

## Pre-conditions

- C.1 ✅ merged (PR #54 squash `f4ac3cc`); `_update_stage_setup` + `_update_acquire_lock` + `_update_diskspace_check` + `_update_fetch_current_metadata` + `_update_download_tarball` + `_update_verify_checksum` + `_update_local_version` all present in `bin/hive`
- Hidden test subcommand `hive _update-fetch-stage` from C.1 produces a staged tarball at `<staging_dir>/<tarball-name>.tar.gz`
- B.1 release pipeline functional (Bob can produce a synthetic tarball for fixture-based testing)

---

## Where state lives (C.2 conventions)

- **`bin/hive` edits:** add new internal functions + 2 hidden test subcommands. Continue underscore-prefix `_update_*` convention from C.1.
- **Manifest file:** `~/neato-hive/.update-staging/<id>/applied.list` — created by `_update_apply_overlay` during the swap loop. Read by `_update_revert_overlay`.
- **Per-item `.old.<ts>` shadows:** `~/neato-hive/.<item>.old.<ts>` (hidden, recoverable). Cleaned up in C.4 on doctor success.
- **No new top-level files in framework repo.** Pure `bin/hive` edits.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-C.1)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at C.1 merge (`f4ac3cc`) or C.2-spec commit. C.2 implementation should NOT be in main yet.

### 2. C.1 functions present in `bin/hive`

```bash
grep -nE '^_update_(default_api_url|local_version|fetch_current_metadata|compare_versions|acquire_lock|diskspace_check|stage_setup|stage_cleanup|download_tarball|verify_checksum)\(\)' bin/hive | head -20
```

Expected: all 10 C.1 functions present. Verifies C.1 merged cleanly + provides foundation for C.2 to build on. **HALT and ping house-md** if any are missing.

### 3. C.2 target functions absent (no out-of-band)

```bash
grep -nE '^_update_(extract_tarball|apply_overlay|revert_overlay|write_manifest|read_manifest)\(\)' bin/hive | head -10
```

Expected: empty output. **HALT and ping house-md** if any C.2 helpers exist (out-of-band edit).

### 4. Verify required tooling

```bash
which tar && tar --version | head -1
which mv && echo "mv: ✓"
which mktemp && echo "mktemp: ✓"
which awk && echo "awk: ✓"
which find && echo "find: ✓"
```

Expected: all present (standard mac+linux). **HALT and ping house-md** if any missing.

### 5. Confirm safe sandbox path for testing

```bash
test -d /tmp/C2-sandbox-install && echo "C2-sandbox-install EXISTS — investigate or clean" || echo "/tmp/C2-sandbox-install: not present (will be created by tests)"
test -d ~/neato-hive/.update-staging && echo "update-staging EXISTS — investigate" || echo "update-staging: not present (expected outside test runs)"
```

Expected: no leftover sandbox or staging dirs from prior runs. Worker uses `HIVE_INSTALL_ROOT=/tmp/C2-sandbox-install` for all destructive tests; the live `~/neato-hive/` install is NEVER touched during the worker turn.

### 6. Verify test fixture creation works (synthetic tarball with REPLACE_LIST contents)

```bash
# Verify scripts/release.sh from B.1 still works (worker uses it to produce a fixture tarball)
test -x scripts/release.sh && echo "scripts/release.sh: executable ✓"
node -e "console.log(require('./package.json').version)"
```

Expected: scripts/release.sh present + executable. Worker uses `bash scripts/release.sh <current-version>` to produce a real tarball for fixture-based overlay testing (saves writing fake tarball-builder; reuses the canonical pipeline).

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-C.2-atomic-overlay-swap`.

**Diff lock: 1 path.**
- `bin/hive` (MODIFY — add C.2 helper functions + 2 hidden test subcommands)

No edits elsewhere. No CHANGELOG bump. No new files at framework repo root.

### A.1 — `_update_extract_tarball <tarball_path> <staging_dir>`

Extracts the tarball into the staging dir. Verifies the extracted top-level is `dist-pkg/`. Returns non-zero on failure.

```bash
_update_extract_tarball() {
  local tarball="$1"
  local staging_dir="$2"

  if [ ! -f "${tarball}" ]; then
    echo "ERROR: tarball not found: ${tarball}" >&2
    return 1
  fi
  if [ ! -d "${staging_dir}" ]; then
    echo "ERROR: staging dir not found: ${staging_dir}" >&2
    return 1
  fi

  echo "==> Extracting ${tarball} into ${staging_dir}/..."
  if ! tar -xzf "${tarball}" -C "${staging_dir}"; then
    echo "ERROR: tar extraction failed" >&2
    return 1
  fi

  if [ ! -d "${staging_dir}/dist-pkg" ]; then
    echo "ERROR: extracted tarball does not contain expected dist-pkg/ directory" >&2
    echo "       contents:" >&2
    ls -1 "${staging_dir}" >&2
    return 1
  fi

  echo "==> Extracted contents:"
  ls -1 "${staging_dir}/dist-pkg" | head -20

  return 0
}
```

### A.2 — `_update_apply_overlay <staging_dir>`

Applies the REPLACE_LIST per-item swap. Outputs the timestamp on success (so caller can pass to revert/cleanup later). On any mid-overlay failure, calls `_update_revert_overlay` internally and returns non-zero.

```bash
_update_apply_overlay() {
  local staging_dir="$1"
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
  local extracted="${staging_dir}/dist-pkg"

  if [ ! -d "${extracted}" ]; then
    echo "ERROR: ${extracted}/ not found (run _update_extract_tarball first)" >&2
    return 1
  fi

  # REPLACE_LIST canonical
  local -a REPLACE_LIST=(
    "dist" "bin" "templates" "shared" "skills" "dashboard"
    "package.json" "pnpm-lock.yaml" "VERSION"
  )

  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local manifest="${staging_dir}/applied.list"
  : > "${manifest}"  # truncate / create empty

  echo "==> Applying overlay swap (ts=${ts})..."
  for ITEM in "${REPLACE_LIST[@]}"; do
    local src="${extracted}/${ITEM}"
    local dst="${install_root}/${ITEM}"
    local shadow="${install_root}/.${ITEM}.old.${ts}"

    # If item not in staging, skip (allowed for placeholder items like dashboard/)
    if [ ! -e "${src}" ]; then
      echo "    - ${ITEM} (not in tarball — skipped)"
      continue
    fi

    # If existing item, rename to shadow
    if [ -e "${dst}" ]; then
      if ! mv "${dst}" "${shadow}"; then
        echo "ERROR: failed to rename ${dst} → ${shadow}" >&2
        echo "       reverting prior swaps..." >&2
        _update_revert_overlay "${ts}" "${manifest}"
        return 1
      fi
    fi

    # Move new content into place
    if ! mv "${src}" "${dst}"; then
      echo "ERROR: failed to move ${src} → ${dst}" >&2
      # Restore shadow if we created one
      if [ -e "${shadow}" ]; then
        mv "${shadow}" "${dst}" 2>/dev/null || true
      fi
      echo "       reverting prior swaps..." >&2
      _update_revert_overlay "${ts}" "${manifest}"
      return 1
    fi

    # Record applied (manifest line = item name only; shadow path is reconstructable from ts)
    echo "${ITEM}" >> "${manifest}"
    echo "    ✓ ${ITEM}"
  done

  echo "==> Overlay applied. Manifest: ${manifest}"
  echo "==> Timestamp: ${ts}"
  echo "==> Shadow files (recoverable): ${install_root}/.<item>.old.${ts}"
  echo "${ts}"
  return 0
}
```

### A.3 — `_update_revert_overlay <ts> [<manifest_path>]`

Undoes overlay swaps. If `<manifest_path>` provided, reads from it; otherwise infers from default staging path (best-effort). Walks manifest in reverse, restores each item from `.old.<ts>` shadow. On per-item failure, continues to next (best-effort revert) but flags failures.

```bash
_update_revert_overlay() {
  local ts="$1"
  local manifest_path="${2:-}"
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"

  if [ -z "${ts}" ]; then
    echo "ERROR: _update_revert_overlay requires <ts> arg" >&2
    return 1
  fi

  # If manifest_path not provided, try to find it under .update-staging/
  if [ -z "${manifest_path}" ]; then
    local found
    found=$(find "${install_root}/.update-staging" -name 'applied.list' 2>/dev/null | head -1)
    if [ -z "${found}" ]; then
      echo "ERROR: no manifest found and no path provided" >&2
      return 1
    fi
    manifest_path="${found}"
    echo "==> Inferred manifest: ${manifest_path}"
  fi

  if [ ! -f "${manifest_path}" ]; then
    echo "ERROR: manifest not found: ${manifest_path}" >&2
    return 1
  fi

  echo "==> Reverting overlay (ts=${ts}) from ${manifest_path}..."

  # Walk manifest in REVERSE order (LIFO undo)
  local -a items=()
  while IFS= read -r line; do
    items+=("${line}")
  done < "${manifest_path}"

  local failures=0
  local i=${#items[@]}
  while [ "${i}" -gt 0 ]; do
    i=$((i - 1))
    local ITEM="${items[$i]}"
    local current="${install_root}/${ITEM}"
    local shadow="${install_root}/.${ITEM}.old.${ts}"

    # Remove the (partially-applied) new content
    if [ -e "${current}" ]; then
      if ! rm -rf "${current}"; then
        echo "ERROR: failed to rm ${current} (continuing)" >&2
        failures=$((failures + 1))
        continue
      fi
    fi

    # Restore shadow if it exists
    if [ -e "${shadow}" ]; then
      if ! mv "${shadow}" "${current}"; then
        echo "ERROR: failed to restore ${shadow} → ${current} (continuing)" >&2
        failures=$((failures + 1))
        continue
      fi
      echo "    ↩ ${ITEM}"
    else
      echo "    - ${ITEM} (no shadow — was a fresh add, removed)"
    fi
  done

  if [ "${failures}" -gt 0 ]; then
    echo "==> Revert completed with ${failures} failure(s). Manual recovery may be needed." >&2
    return 1
  fi

  echo "==> Revert clean."
  return 0
}
```

### A.4 — Hidden test subcommand `hive _update-overlay-apply <staging_dir>`

Wraps `_update_extract_tarball` + `_update_apply_overlay`. Used by Bob's smoke test.

```bash
cmd_update_overlay_apply() {
  local staging_dir="$1"
  if [ -z "${staging_dir}" ]; then
    echo "Usage: hive _update-overlay-apply <staging_dir>"
    return 2
  fi
  if [ ! -d "${staging_dir}" ]; then
    echo "ERROR: staging dir not found: ${staging_dir}" >&2
    return 1
  fi

  # Find the tarball in staging
  local tarball
  tarball=$(find "${staging_dir}" -maxdepth 1 -name '*.tar.gz' | head -1)
  if [ -z "${tarball}" ]; then
    echo "ERROR: no tarball found in ${staging_dir}" >&2
    return 1
  fi
  echo "==> Tarball: ${tarball}"

  # Extract
  if ! _update_extract_tarball "${tarball}" "${staging_dir}"; then
    return 1
  fi

  # Apply overlay (captures ts on success)
  local ts
  if ! ts=$(_update_apply_overlay "${staging_dir}" | tail -1); then
    echo "ERROR: overlay apply failed" >&2
    return 1
  fi

  echo ""
  echo "==> _update-overlay-apply complete."
  echo "    Timestamp: ${ts}"
  echo "    To revert: hive _update-overlay-revert ${ts} ${staging_dir}/applied.list"
  return 0
}
```

### A.5 — Hidden test subcommand `hive _update-overlay-revert <ts> [<manifest>]`

Wraps `_update_revert_overlay`. Used by Bob's smoke test + future C.3 rollback command.

```bash
cmd_update_overlay_revert() {
  local ts="$1"
  local manifest="${2:-}"
  if [ -z "${ts}" ]; then
    echo "Usage: hive _update-overlay-revert <ts> [<manifest>]"
    return 2
  fi
  _update_revert_overlay "${ts}" "${manifest}"
}
```

### A.6 — Wire both subcommands into `bin/hive` case dispatcher

```bash
# In the main case dispatch block (alongside _update-fetch-stage from C.1):
_update-overlay-apply)
  cmd_update_overlay_apply "$@"
  ;;
_update-overlay-revert)
  cmd_update_overlay_revert "$@"
  ;;
```

Both underscore-prefixed → not in `hive --help` output.

### A.7 — Add brief comment block above the new functions

```bash
# v1.5.0 C.2 — atomic-overlay swap helpers.
# - _update_extract_tarball: extracts tarball into staging
# - _update_apply_overlay: REPLACE_LIST per-item rename to .old.<ts>, new content in place
# - _update_revert_overlay: walks applied.list manifest in reverse, restores from shadow
# Manifest at staging_dir/applied.list survives crashes for post-mortem recovery.
# .old.<ts> cleanup is C.4's job (doctor success path).
# Spec: docs/v1.5.0-tasks/C.2-atomic-overlay-swap.md
```

---

## B. Tests (run during the worker turn — sandbox-isolated; live install untouched)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Worker captures shellcheck output; new C.2 code should add zero new warnings
```

### B.2 — Build a fixture tarball

```bash
# Use B.1's pipeline to produce a real tarball with current package.json version
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -3
ls -la /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz
```

### B.3 — Set up sandbox install

```bash
# Sandbox install: a directory with the same structure as ~/neato-hive/ but disposable.
# Worker overlays into this sandbox, leaving the live install untouched.
SANDBOX=/tmp/C2-sandbox-install
rm -rf "${SANDBOX}"
mkdir -p "${SANDBOX}"

# Populate with fixture content matching REPLACE_LIST shape
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
echo "old-dist-content" > "${SANDBOX}/dist/index.js"
echo "old-bin-content" > "${SANDBOX}/bin/hive"
echo '{"version": "0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"

# Set up a sandbox staging dir with the real tarball
mkdir -p "${SANDBOX}/.update-staging/c2-test"
cp /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz "${SANDBOX}/.update-staging/c2-test/"

ls -la "${SANDBOX}/"
```

### B.4 — Test apply-overlay against sandbox

```bash
HIVE_INSTALL_ROOT="${SANDBOX}" \
  bash bin/hive _update-overlay-apply "${SANDBOX}/.update-staging/c2-test" 2>&1 | tail -20

# Verify post-overlay state
echo "--- AFTER OVERLAY:"
ls -la "${SANDBOX}/" | head -20
ls -la "${SANDBOX}/.dist.old."* 2>&1 | head -3
cat "${SANDBOX}/.update-staging/c2-test/applied.list"

# Confirm: NEW content present at known paths, OLD content shadowed
test "$(cat "${SANDBOX}/VERSION")" = "${CURRENT_VERSION}" && echo "VERSION: new ✓" || echo "VERSION: FAIL"
test -e "${SANDBOX}/.VERSION.old."* && echo "VERSION.old shadow: ✓" || echo "VERSION.old shadow: FAIL"
test "$(cat "${SANDBOX}/.VERSION.old."*)" = "old-version" && echo "VERSION old content preserved: ✓" || echo "VERSION old content preserved: FAIL"

# Capture timestamp for revert test
TS=$(ls "${SANDBOX}/.VERSION.old."* | sed 's|.*\.VERSION\.old\.||')
echo "TS=${TS}"
```

### B.5 — Test revert-overlay against sandbox

```bash
HIVE_INSTALL_ROOT="${SANDBOX}" \
  bash bin/hive _update-overlay-revert "${TS}" "${SANDBOX}/.update-staging/c2-test/applied.list" 2>&1 | tail -10

# Verify post-revert state — back to original
echo "--- AFTER REVERT:"
ls -la "${SANDBOX}/" | head -20
test "$(cat "${SANDBOX}/VERSION")" = "old-version" && echo "VERSION restored: ✓" || echo "VERSION restored: FAIL"
test ! -e "${SANDBOX}/.VERSION.old."* && echo "shadow cleaned: ✓" || echo "shadow cleaned: FAIL"
test "$(cat "${SANDBOX}/package.json" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).version)')" = "0.0.0-fixture-old" && echo "package.json restored: ✓" || echo "package.json restored: FAIL"
```

### B.6 — Test failure-mid-overlay rollback (synthetic injection)

```bash
# Simulate a permission-denied failure mid-overlay by creating a read-only target on one of the REPLACE_LIST items
SANDBOX=/tmp/C2-sandbox-install-fail
rm -rf "${SANDBOX}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
echo "old-dist" > "${SANDBOX}/dist/x"
echo "old-bin" > "${SANDBOX}/bin/x"
echo '{"version":"0.0.0"}' > "${SANDBOX}/package.json"

# Make .update-staging untouchable for the worker's mv (force a failure)
mkdir -p "${SANDBOX}/.update-staging/c2-test-fail"
cp /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz "${SANDBOX}/.update-staging/c2-test-fail/"

# Easiest synthetic failure: pre-create one of the destination paths as a read-only file the swap can't overwrite.
# E.g. delete dst BUT leave a directory at the same name post-swap so mv succeeds part-way then fails on next item.
# (Simpler approach: chmod -w one of the parent directories after first 2 swaps land. Skip this in worker turn
#  if it requires sudo or env quirks; just run B.4+B.5 and document that synthetic-failure-injection is future leaf.)

# If failure-injection test is impractical without root, worker SKIPS B.6 with a note in PR body
echo "B.6 failure-injection deferred to future leaf (requires elevated permissions or platform-specific quirks)"
```

B.6 is OPTIONAL — if skip-with-note. The revert function is exercised in B.5; B.6 is gravy.

### B.7 — Cleanup

```bash
rm -rf /tmp/C2-sandbox-install /tmp/C2-sandbox-install-fail
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` introduces ZERO new warnings (delta = 0 vs C.1 baseline)
- [ ] B.4 apply-overlay test passes: REPLACE_LIST items swapped, `.old.<ts>` shadows present, manifest written, old content recoverable from shadows
- [ ] B.5 revert-overlay test passes: original content restored, shadows cleaned, no residue
- [ ] B.6 failure-injection: PASSED OR explicitly skipped-with-note (acceptable either way)
- [ ] **Live install untouched** — confirmed by `ls ~/neato-hive/.dist.old.*` returning empty (worker uses `HIVE_INSTALL_ROOT=/tmp/C2-sandbox-install*` for all destructive tests)
- [ ] PR body contains: pre-flight 1-6 outputs verbatim, B.1-B.5 outputs verbatim, shellcheck delta, diff-lock confirmation, "live install untouched" verification

---

## D. When done (DONE block template for Bob to fill)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. C.1 functions present: 10 ✓
  3. C.2 helpers absent: ✓
  4. tooling: tar ✓ mv ✓ mktemp ✓ awk ✓ find ✓
  5. sandbox path clean: ✓
  6. release.sh executable + version readable: ✓

Tooling check:
  bash -n bin/hive: ✓
  shellcheck delta vs C.1 baseline: 0 new warnings

Tests (sandbox at /tmp/C2-sandbox-install):
  B.2 fixture tarball: /tmp/neato-hive-v<x>.tar.gz (size: <y>)
  B.3 sandbox setup: ✓
  B.4 apply-overlay:
    - VERSION new ✓ / shadow ✓ / old content preserved ✓
    - package.json new ✓ / shadow ✓
    - manifest content: <verbatim — REPLACE_LIST items in apply order>
  B.5 revert-overlay:
    - VERSION restored ✓ / shadow cleaned ✓
    - package.json restored ✓
  B.6 failure-injection: <PASSED | skipped-with-note "deferred to future leaf">

Live install verification:
  ls ~/neato-hive/.dist.old.* : <empty — confirmed untouched>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.2-atomic-overlay-swap
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md reviews and merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — all 5 helpers + 2 hidden subcommands + dispatch wiring + comment block in single PR
- **DO NOT MERGE** — house-md reviews + merges per adjusted v1.5.0 loop
- **DO NOT TOUCH LIVE INSTALL** — all destructive tests use `HIVE_INSTALL_ROOT=/tmp/C2-sandbox-install*`. Worker MUST verify post-test that `~/neato-hive/.dist.old.*` returns empty.
- **DO NOT TOUCH C.1 FUNCTIONS** — purely additive
- **HALT-and-ping rule** — pre-flight surprises (existing C.2 helpers, missing tooling, C.1 functions absent) stop the worker; ping house-md via SendMessage with kind=delegation
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup, never blanket `rm -rf` outside trapped paths
- **on-complete prompt is bob-aimed** — tells Bob what to verify at completion (sandbox tests pass, live install untouched, shellcheck delta zero, diff lock 1 path), then ping house-md via SendMessage with kind=delegation
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift OK pre-flight (matches v1.4.9 + C.1 pattern)
- **No new shell-tool deps** — C.2 uses only `mv`, `cp`, `tar`, `find`, `awk`, `mktemp`, `date`, all standard. Confirms house-md's wizard-dep-rule check.

---

## F. Forward links

- C.3 — Lockfile (already in C.1) + rollback path. Wraps `_update_revert_overlay` into a user-facing `hive update --rollback` command. Detects `.old.<ts>` shadows in `~/neato-hive/`, picks the most recent ts, walks revert. Owner-paced "I just updated and something's wrong, undo it" command.
- C.4 — Doctor sweep + `.old.<ts>` cleanup on success. Runs `hive doctor --fix --yes` post-overlay; if green, walks `.old.*` shadows and removes them. Folds in `pnpm install --frozen-lockfile` post-extract per Q2.
- C.5 — `hive update --check --json` mode (consumes C.1's `_update_fetch_current_metadata`).
- C.6 — State-file emission for SSE relay (Q1 architecture).
- C.7 — v1.4.x → v1.5.0 implicit migration handler. May also be the cut-over leaf that flips `cmd_update` to use the C.1+C.2+C.3+C.4 pipeline.
