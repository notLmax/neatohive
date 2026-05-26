# v1.5.0 C.5 — `hive update --check --json` Mode

**Status:** LOCKED (amended 2026-05-07 per house-md task `t-movta9rc001c` — Path A: replaces existing git-based `--check` block at bin/hive lines 1447-1487 with API-based wiring). Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.5 (5 of 7 in Phase C)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.4 ✅ merged 2026-05-07 18:01:39Z — PR #57 squash `6b64cf0` (doctor sweep + cleanup + PRESERVE_LIST verify)
**Successor:** C.6 — State-file emission to `~/.neato-hive/state/update-<id>.jsonl` for SSE relay (Q1 architecture)

---

## Goal

Ship a read-only "check for updates" mode of `hive update`. New flag combination: `hive update --check [--json]`.

- Without `--json`: human-readable output ("v1.5.0 → v1.5.1 available", or "Already at v1.5.0")
- With `--json`: structured machine-readable JSON for dashboard consumption (Phase E `/api/update/check`) + CLI scripting

**C.5 is non-mutating.** No download, no extract, no overlay, no lock acquisition. It's a pure read of the published metadata + a comparison against the local version. Safe to run any time, idempotent, no side-effects on disk.

**Consumer contract** (locked — dashboard E.5 + CLI scripts depend on this shape):

When update available:
```json
{
  "update_available": true,
  "local_version": "1.5.0",
  "remote_version": "1.5.1",
  "tarball_url": "https://neato-hive-site.vercel.app/releases/v1.5.1/neato-hive-v1.5.1.tar.gz",
  "checksum_sha256": "ab12...",
  "released_at": "2026-05-08T12:34:56Z",
  "changelog_url": "https://neato-hive-site.vercel.app/changelog.html"
}
```

When already current:
```json
{
  "update_available": false,
  "local_version": "1.5.0",
  "remote_version": "1.5.0",
  "released_at": "2026-05-07T00:00:00Z"
}
```

When error (e.g. API unreachable, malformed response):
```json
{
  "update_available": null,
  "error": "failed to fetch metadata from https://neato-hive-site.vercel.app/api/current",
  "local_version": "1.5.0"
}
```
Exit code non-zero on error so CLI scripts can detect via `$?`. Exit code 0 on both update-available and no-update cases.

---

## Architectural givens (carried)

- **API endpoint:** `https://neato-hive-site.vercel.app/api/current` returns 5-field JSON (B.2 contract). Configurable via `HIVE_RELEASES_API` env var (already supported in C.1 — same env var).
- **Local version source:** `~/neato-hive/package.json` `version` field, read via `_update_local_version` from C.1.
- **Comparison:** string-equality via `_update_compare_versions` from C.1. (Future leaf may extend with semver comparison; v1.5.0 string-equality is sufficient.)
- **No lock acquisition.** Read-only operation; multiple `hive update --check` invocations concurrent are safe.
- **No staging dir setup.** No download. No extraction. Just an HTTP GET + version compare + JSON print.
- **Exit codes (C.5 contract):**
  - `0` — successful check (whether update available or not)
  - `1` — error (API unreachable, malformed JSON, missing local package.json, etc.)
  - `2` — argument error

---

## Pre-conditions

- C.4 ✅ merged (PR #57 squash `6b64cf0`); C.1+C.2+C.3+C.4 helpers present in `bin/hive`
- API endpoint may NOT yet be returning real data (Cloud Run service first-deploy gated on owner-side install). Worker uses synthetic fixture for smoke testing — same pattern as C.1.

---

## Where state lives (C.5 conventions)

- **`bin/hive` edits:** add 1 new helper function + extend `cmd_update`'s argument parsing for `--check` flag (with optional `--json`)
- **No edits to C.1/C.2/C.3/C.4 helpers** — purely additive
- **No new files at framework repo root**

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body)

### 1. Framework repo current state (post-C.4)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at `6b64cf0` (C.4 merge) or C.5-spec commit.

### 2. C.1 helpers present (C.5 depends on these)

```bash
grep -nE '^_update_(default_api_url|local_version|fetch_current_metadata|compare_versions)\(\)' bin/hive | head -10
```

Expected: 4 functions listed. **HALT and ping house-md** if any missing — C.5 cannot ship without them.

### 3. C.5 target function absent + verify existing git-based `--check` block

```bash
grep -nE '^_update_check\(\)' bin/hive | head -5
echo "---"
grep -nA 8 '^cmd_update\(\)' bin/hive | head -15
echo "---"
sed -n '1447,1487p' bin/hive
```

Expected:
- `_update_check` does NOT exist yet (C.5 introduces it).
- `cmd_update` shows the C.3 `--rollback` branch at top + v1.4.9 git-pull body below.
- **Lines 1447-1487 of `bin/hive` show an existing git-based `--check` inline block** (originally introduced in commit `5543c606`, lightly touched by v1.4.9 self-healing-bootstrap commit `0f0828e`). It checks for updates by `git fetch && git rev-list HEAD..origin/main` style logic. **This is dead code post-v1.5.0** — tarball installs have no `.git/` directory and the API-based `_update_check` (per A.1) replaces it cleanly. **Path A — replace** (locked by house-md, task `t-movta9rc001c`): C.5 removes lines 1447-1487 as part of this PR.

**HALT and ping house-md** if:
- `_update_check` already exists as a function (out-of-band edit)
- Lines 1447-1487 do NOT match the expected git-based `--check` block shape (someone amended cmd_update without telling us — investigate before proceeding)
- The line range has shifted (cmd_update has been edited and the git-based block is now at different line numbers — capture the actual range, ping house-md to confirm before deletion)

### 4. Required tooling

```bash
which jq && jq --version
which curl && echo "curl: ✓"
```

Expected: both present (already verified in C.1; belt-and-suspenders).

### 5. API endpoint reachable (informational)

```bash
curl -sI https://neato-hive-site.vercel.app/api/current 2>&1 | head -3
```

Expected: HTTP response — 200 if Cloud Run live, otherwise 4xx/5xx. Worker captures status without HALTing (fixture-based smoke covers the actual logic).

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-C.5-update-check-json`.

**Diff lock: 1 path.**
- `bin/hive` (MODIFY — add `_update_check` function + `--check` branch in `cmd_update`)

### A.1 — `_update_check [--json]`

The check orchestrator. Reads local + remote, compares, emits output. Returns 0 on successful check, 1 on error, 2 on bad args.

```bash
_update_check() {
  local emit_json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --json) emit_json=1; shift ;;
      *) echo "ERROR: unknown arg '$1'" >&2; return 2 ;;
    esac
  done

  # Read local version (best-effort — proceed with null if missing)
  local local_version
  local_version=$(_update_local_version 2>/dev/null) || local_version=""

  # Fetch remote metadata to a temp file
  local tmp_metadata
  tmp_metadata=$(mktemp -t hive-update-check.XXXXXX) || {
    echo "ERROR: failed to create temp file" >&2
    return 1
  }
  trap "rm -f '${tmp_metadata}'" EXIT

  if ! _update_fetch_current_metadata "${tmp_metadata}" 2>/dev/null; then
    local api_url
    api_url="$(_update_default_api_url)"
    if [ "${emit_json}" -eq 1 ]; then
      jq -n \
        --arg local "${local_version}" \
        --arg url "${api_url}" \
        '{update_available: null, error: ("failed to fetch metadata from " + $url), local_version: ($local // null)}' \
        | jq -c .
    else
      echo "ERROR: failed to fetch metadata from ${api_url}" >&2
      [ -n "${local_version}" ] && echo "Local: v${local_version}"
    fi
    return 1
  fi

  # Extract remote fields
  local remote_version remote_url remote_sha remote_released_at remote_changelog_url
  remote_version=$(jq -r '.version' "${tmp_metadata}")
  remote_url=$(jq -r '.tarball_url' "${tmp_metadata}")
  remote_sha=$(jq -r '.checksum_sha256' "${tmp_metadata}")
  remote_released_at=$(jq -r '.released_at' "${tmp_metadata}")
  remote_changelog_url=$(jq -r '.changelog_url' "${tmp_metadata}")

  # Determine update_available
  local update_available="false"
  if [ -z "${local_version}" ] || ! _update_compare_versions "${local_version}" "${remote_version}"; then
    update_available="true"
  fi

  # Emit
  if [ "${emit_json}" -eq 1 ]; then
    if [ "${update_available}" = "true" ]; then
      jq -n \
        --arg local "${local_version}" \
        --arg remote "${remote_version}" \
        --arg url "${remote_url}" \
        --arg sha "${remote_sha}" \
        --arg released "${remote_released_at}" \
        --arg changelog "${remote_changelog_url}" \
        '{update_available: true, local_version: ($local // null), remote_version: $remote, tarball_url: $url, checksum_sha256: $sha, released_at: $released, changelog_url: $changelog}' \
        | jq -c .
    else
      jq -n \
        --arg local "${local_version}" \
        --arg remote "${remote_version}" \
        --arg released "${remote_released_at}" \
        '{update_available: false, local_version: $local, remote_version: $remote, released_at: $released}' \
        | jq -c .
    fi
  else
    if [ "${update_available}" = "true" ]; then
      if [ -n "${local_version}" ]; then
        echo "Update available: v${local_version} → v${remote_version}"
      else
        echo "Update available: → v${remote_version} (no local version detected)"
      fi
      echo "  Tarball:   ${remote_url}"
      echo "  Checksum:  ${remote_sha}"
      echo "  Released:  ${remote_released_at}"
      echo "  Changelog: ${remote_changelog_url}"
    else
      echo "Already at v${local_version} (released ${remote_released_at}). No update needed."
    fi
  fi

  return 0
}
```

**Notes on shell discipline:**
- `mktemp -t` portable across mac+linux
- `trap "rm -f '${tmp_metadata}'" EXIT` cleanup on any exit path
- `jq -n --arg ... '<expr>' | jq -c .` builds JSON safely via jq's argument-interpolation (no string concatenation of user-controlled content into JSON), then `-c` compacts to single-line for predictable parsing
- Output format on success matches the §Goal contract exactly (5 fields when update available, 4 fields when no update, 3 fields when error)

### A.2 — Replace existing git-based `--check` block in `cmd_update` with API-based wiring

**Per Path A (house-md decision t-movta9rc001c): drop the existing git-based inline `--check` block (lines 1447-1487) and wire `--check` exclusively to the new `_update_check`.**

Two changes to `cmd_update`:

**Change 1 (REMOVE):** delete lines 1447-1487 of `bin/hive` — the existing git-based `--check` inline implementation (`git fetch` + `git rev-list HEAD..origin/main` style logic from commit `5543c606`, lightly modified by v1.4.9 commit `0f0828e`). Dead post-v1.5.0 because tarball installs have no `.git/`.

**Change 2 (ADD):** add the C.5 `--check` branch AFTER the C.3 `--rollback` branch, BEFORE the v1.4.9 git-pull body:

```bash
cmd_update() {
  # C.3 — rollback path
  if [ "${1:-}" = "--rollback" ]; then
    shift
    _update_run_rollback "$@"
    return $?
  fi

  # C.5 — API-based check-only mode (replaces git-based --check from 5543c606,
  # which is dead post-v1.5.0: tarball installs have no .git/ directory).
  # Read-only, no download/swap/lock.
  if [ "${1:-}" = "--check" ]; then
    shift
    _update_check "$@"
    return $?
  fi

  # ... existing v1.4.9 cmd_update git-pull body unchanged ...
}
```

**Net effect on cmd_update body:**
- Line count delta: subtract 41 (lines 1447-1487 removed) + add ~6 lines (new `--check` branch with comment) = net -35 lines
- Logical flow unchanged: `--rollback` (C.3) → `--check` (C.5, NEW API-based) → fall through to v1.4.9 git-pull
- v1.4.9 git-pull body untouched
- C.3 `--rollback` branch untouched
- The OLD git-based `--check` block is gone; the NEW API-based `--check` branch routes to `_update_check` from A.1

Worker confirms via diff inspection:
- Lines 1447-1487 (or whatever line range pre-flight #3 captured if shifted) are DELETED
- New `--check` branch is ADDED right after the `--rollback` branch
- No other edits to cmd_update or to v1.4.9 git-pull body

### A.3 — Brief comment block above `_update_check`

```bash
# v1.5.0 C.5 — hive update --check [--json] read-only mode.
# Calls C.1 _update_fetch_current_metadata, compares to local version, emits human-readable
# or JSON output. Used by dashboard /api/update/check (Phase E.5) + CLI scripting.
# Non-mutating: no download, no extract, no overlay, no lock. Safe to run concurrently.
# Spec: docs/v1.5.0-tasks/C.5-update-check-json.md
```

---

## B. Tests (sandbox-isolated where applicable)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Capture warning-count delta vs C.4 baseline; new code should add zero
```

### B.2 — Synthetic fixture for update-available case

```bash
mkdir -p /tmp/C5-fixture
cat > /tmp/C5-fixture/current.json <<'EOF'
{
  "version": "9.9.9-test-newer",
  "tarball_url": "https://example.com/neato-hive-v9.9.9-test-newer.tar.gz",
  "checksum_sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "released_at": "2026-05-08T00:00:00Z",
  "changelog_url": "https://example.com/changelog.html"
}
EOF

# JSON output
HIVE_RELEASES_API=file:///tmp/C5-fixture/current.json \
  bash bin/hive update --check --json 2>&1 | head -3
# Expected: single-line compact JSON with update_available: true + all 6 fields populated

# Human-readable output
HIVE_RELEASES_API=file:///tmp/C5-fixture/current.json \
  bash bin/hive update --check 2>&1 | head -10
# Expected: "Update available: v<x> → v9.9.9-test-newer" + tarball/checksum/released/changelog
```

### B.3 — Synthetic fixture for no-update case

```bash
# Use the actual current package.json version
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
cat > /tmp/C5-fixture/current.json <<EOF
{
  "version": "${CURRENT_VERSION}",
  "tarball_url": "https://example.com/neato-hive-v${CURRENT_VERSION}.tar.gz",
  "checksum_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "released_at": "2026-05-07T00:00:00Z",
  "changelog_url": "https://example.com/changelog.html"
}
EOF

HIVE_RELEASES_API=file:///tmp/C5-fixture/current.json \
  bash bin/hive update --check --json 2>&1 | head -3
# Expected: single-line JSON with update_available: false + 4 fields (no tarball/checksum)

HIVE_RELEASES_API=file:///tmp/C5-fixture/current.json \
  bash bin/hive update --check 2>&1 | head -3
# Expected: "Already at v<CURRENT_VERSION> (released 2026-05-07T00:00:00Z). No update needed."
```

### B.4 — Error case (unreachable API)

```bash
HIVE_RELEASES_API=file:///tmp/nonexistent-fixture-path/current.json \
  bash bin/hive update --check --json 2>&1 | tail -3
echo "exit code: $?"
# Expected: JSON with update_available: null + error field, exit code 1

HIVE_RELEASES_API=file:///tmp/nonexistent-fixture-path/current.json \
  bash bin/hive update --check 2>&1 | tail -3
echo "exit code: $?"
# Expected: "ERROR: failed to fetch metadata from ..." on stderr, exit code 1
```

### B.5 — Argument validation

```bash
bash bin/hive update --check --invalid-flag 2>&1 | head -3
echo "exit code: $?"
# Expected: "ERROR: unknown arg '--invalid-flag'", exit code 2
```

### B.6 — Verify v1.4.9 cmd_update body unchanged when neither --rollback nor --check present

```bash
grep -nA 12 '^cmd_update\(\)' bin/hive | head -20
# Expected: --rollback branch first (C.3), --check branch second (C.5), then v1.4.9 git-pull body
# Worker confirms diff inspection shows ONLY the --check branch added
```

### B.7 — Cleanup

```bash
rm -rf /tmp/C5-fixture
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` zero new warnings vs C.4 baseline
- [ ] **Git-based `--check` block REMOVED** (lines 1447-1487 of pre-PR `bin/hive`, or whatever range pre-flight #3 captured if shifted). Worker confirms via diff that the OLD `git fetch` / `git rev-list HEAD..origin/main` style block is gone.
- [ ] **API-based `--check` branch ADDED** in `cmd_update` after the C.3 `--rollback` branch, routing to `_update_check`.
- [ ] B.2 update-available JSON shape matches §Goal contract exactly (6 fields: update_available, local_version, remote_version, tarball_url, checksum_sha256, released_at, changelog_url)
- [ ] B.2 human-readable output present + readable
- [ ] B.3 no-update JSON shape matches §Goal contract (4 fields: update_available, local_version, remote_version, released_at)
- [ ] B.4 error case: JSON has `update_available: null` + `error` + `local_version`, exit code 1
- [ ] B.5 argument validation: unknown flag exits 2 with clear message
- [ ] B.6 v1.4.9 cmd_update git-pull body unchanged (only the OLD git-based `--check` block removed + the NEW API-based `--check` branch added; no edits to `--rollback` branch or git-pull body)
- [ ] PR body: pre-flight 1-5 outputs + B.2-B.6 outputs verbatim, shellcheck delta, diff-lock confirmation, **explicit before/after line numbers showing lines 1447-1487 removed + new branch location**

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. C.1 helpers present: 4 ✓
  3. _update_check absent ✓ / cmd_update structure: <captured>
  4. tooling: jq ✓ curl ✓
  5. API reachable: <status — informational only>

Tooling check:
  bash -n: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 update-available:
    JSON: <verbatim single-line>
    Human: <verbatim "Update available: ..." block>
  B.3 no-update:
    JSON: <verbatim>
    Human: <verbatim "Already at v..." line>
  B.4 error case:
    JSON: <verbatim — null + error fields>
    Human stderr: <verbatim>
    Exit code: 1 ✓
  B.5 argument validation:
    Output: <verbatim>
    Exit code: 2 ✓
  B.6 cmd_update body integrity: <diff inspection — only --check branch added>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.5-update-check-json
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — function + cmd_update branch + comment block in single PR
- **DO NOT MERGE** — house-md
- **DO NOT WIRE INTO MAIN COMMAND DISPATCH BEYOND `--check`** — purely a flag extension. No new subcommand. No `hive check-update` or similar — `hive update --check` is the canonical syntax.
- **DO NOT CHANGE C.1/C.2/C.3/C.4 HELPERS** — purely additive composition
- **DO NOT TOUCH v1.4.9 GIT-PULL BEHAVIOR** when neither `--rollback` nor `--check` is present
- **HALT-and-ping rule** — pre-flight surprises stop the worker
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup
- **on-complete prompt is bob-aimed** — pings house-md kind=delegation
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift OK pre-flight
- **No new shell-tool deps** — only `mktemp` + `jq` + `curl`, all already used in earlier C-leaves. Wizard-dep-rule clean.

---

## F. Forward links

- C.6 — State-file emission to `~/.neato-hive/state/update-<id>.jsonl`. C.5's `_update_check` is read-only and emits NO state events; only the full-flow update path (C.3's orchestrator extended in C.6) emits events. C.5 is a sibling not a state-file producer.
- E.5 — Dashboard Updates page consumes `/api/update/check` which calls `hive update --check --json` server-side and surfaces the JSON to frontend. Polling cadence on Updates page TBD by E.5; the C.5 endpoint is non-mutating so polling at any cadence is safe.
- CLI scripting — third-party scripts can integrate `hive update --check --json | jq '.update_available'` into cron jobs, monitoring, etc.
