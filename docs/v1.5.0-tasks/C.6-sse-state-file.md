# v1.5.0 C.6 — SSE State-File for `hive update` Progress Events

**Status:** LOCKED — Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.6 (6 of 7 in Phase C)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.5 ✅ merged 2026-05-07 18:32:58Z — PR #60 squash `7e5ac8f` (`hive update --check [--json]` mode + replaced existing git-based --check)
**Successor:** C.7 — v1.4.x → v1.5.0 implicit migration handler + likely cut-over of `cmd_update` from git-pull to the new pipeline

---

## Goal

Producer side of Q1's SSE state-file architecture. Emit append-only JSONL events to `~/.neato-hive/state/update-<id>.jsonl` at every phase boundary of the `hive update` full-flow + rollback paths.

Why this design (recap from Q1):
- Dashboard's E.5 Updates page needs to render real-time progress without WebSocket complexity
- `hive update` may itself swap `dashboard/` and PM2-restart `hive-dashboard` mid-flow → the SSE stream tears down, browser sees connection drop
- **State file on disk is the source of truth.** SSE relay (D.3) tail-follows it. Polling fallback (D.3 `/api/update/status/:id`) reads it at request time. Browser uses SSE for live enrichment + polls on `EventSource.onerror`.

C.6 is the **producer**: `_update_emit_progress` helper + insertion calls at phase boundaries in C.1-C.4 helpers + the orchestrator. D.3 ships the consumer endpoints in Phase D. E.5 ships the frontend SSE+polling pattern in Phase E.

**Locked event schema** (consumer contract — D.3 + E.5 depend on this shape):

```json
{"phase":"<name>","ts":"2026-05-07T18:34:56Z","sequence":0,"detail":{...}}
```

One event per line (JSONL). Ordering is by line number = `sequence` field (auto-increment from line count, monotonic per file). `detail` is an arbitrary JSON object — phase-specific keys (e.g. `{"path": "..."}` for `staging-setup-complete`, `{"version": "1.5.1"}` for `compare-complete`).

**Locked phase vocabulary** (~14 phases — minimal but covers the dashboard rendering needs):

| Phase | Emitted by | Detail keys |
|-------|------------|-------------|
| `start` | `_update_run_full_flow_with_revert` (orchestrator entry) | `{id, dry_run}` |
| `lock-acquired` | orchestrator (after `_update_acquire_lock`) | `{}` |
| `staging-setup-complete` | orchestrator (after `_update_stage_setup`) | `{path}` |
| `fetch-start` | `_update_fetch_current_metadata` (entry) | `{api_url}` |
| `fetch-complete` | `_update_fetch_current_metadata` (success) | `{remote_version}` |
| `compare-complete` | orchestrator (after version compare) | `{local_version, remote_version, update_available}` |
| `download-start` | `_update_download_tarball` (entry) | `{tarball_url}` |
| `download-complete` | `_update_download_tarball` (success) | `{tarball_path, size_bytes}` |
| `verify-complete` | `_update_verify_checksum` (success) | `{sha256}` |
| `extract-complete` | `_update_extract_tarball` (success) | `{extracted_path}` |
| `overlay-applied` | `_update_apply_overlay` (success) | `{ts, items_swapped}` |
| `finalize-start` | `_update_post_overlay_finalize` (entry) | `{}` |
| `finalize-complete` | `_update_post_overlay_finalize` (success) | `{}` |
| `finalize-failed` | `_update_post_overlay_finalize` (failure path before revert) | `{step, error}` |
| `rollback-start` | `_update_revert_overlay` (entry) | `{ts}` |
| `rollback-complete` | `_update_revert_overlay` (success) | `{items_reverted}` |
| `error` | any helper (terminal-failure case before revert) | `{step, error}` |
| `done` | orchestrator (always last event, success or failure) | `{success: bool, final_version}` |

D.3's `/api/update/status/:id` reads the LAST line of the state file to determine current state. If `done` is the last event, the update is complete. If not, it's in-flight (and `phase` indicates what step). E.5 uses this for the "Update in progress" banner + step indicator.

---

## Architectural givens (carried)

- **State directory:** `~/.neato-hive/state/` (NOT `~/neato-hive/data/` — that's framework-state, gets overwritten on update; state files MUST persist across updates so post-update dashboard can render the just-completed update).
- **Per-update file:** `~/.neato-hive/state/update-<id>.jsonl` where `<id>` is the staging directory basename (matches the staging dir id created by `_update_stage_setup` in C.1).
- **Append-only.** Helpers `>>` append, never rewrite.
- **JSON safety:** `jq -n -c --arg ... --argjson detail '...'` — never string-concat detail into the event line.
- **Sequence:** auto-derived from line count of state file at emit time (`wc -l`). Monotonic per file. Survives crashes (since file is on disk).
- **Wiring contract:** `_update_emit_progress` is called from inside C.1-C.4 helpers + the orchestrator. Helper bodies' EXISTING logic is NOT changed — only emit-call insertions at phase boundaries.
- **Env-var-driven state file path:** orchestrator sets `HIVE_UPDATE_STATE_FILE` before calling other helpers. Helpers read from env. When env var is unset (e.g. unit-test invocation without orchestrator wrapper), `_update_emit_progress` is a no-op (preserves backward compat for direct helper calls).

---

## Pre-conditions

- C.5 ✅ merged (PR #60 squash `7e5ac8f`); C.1+C.2+C.3+C.4+C.5 helpers all present in `bin/hive`
- `mkdir`, `wc`, `jq`, `date -u`, `basename` all present (verified across C.1-C.5)

---

## Where state lives (C.6 conventions)

- **`bin/hive` edits:** add 1 new helper (`_update_emit_progress`) + insert emit calls at phase boundaries inside C.1/C.2/C.3/C.4 helpers and the orchestrator. ALL existing helper logic preserved — only emit-call insertions.
- **State directory:** `~/.neato-hive/state/` (created by `_update_emit_progress` if missing — `mkdir -p`)
- **Per-update event log:** `~/.neato-hive/state/update-<id>.jsonl`
- **NO new top-level files in framework repo.**

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-C.5)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at `7e5ac8f` (C.5 merge) or C.6-spec commit.

### 2. C.1+C.2+C.3+C.4+C.5 helpers present

```bash
grep -nE '^_update_(acquire_lock|stage_setup|fetch_current_metadata|download_tarball|verify_checksum|extract_tarball|apply_overlay|revert_overlay|run_full_flow_with_revert|find_latest_shadow_ts|run_rollback|pnpm_install_post_extract|doctor_sweep|preserve_list_hash_capture|preserve_list_hash_verify|cleanup_shadows|cleanup_staging_residue|post_overlay_finalize|check)\(\)' bin/hive | head -25
```

Expected: 19 functions listed (10 from C.1, 3 from C.2, 3 from C.3, 7 from C.4, 1 from C.5 = 24 actually if counting orchestrator). Worker captures the actual list and verifies against the WBS. **HALT and ping house-md** if any are missing.

### 3. C.6 target function absent

```bash
grep -nE '^_update_emit_progress\(\)' bin/hive | head -3
```

Expected: empty. **HALT and ping house-md** if exists (out-of-band).

### 4. State directory baseline (informational — captures pre-state)

```bash
test -d ~/.neato-hive/state && ls -la ~/.neato-hive/state/ | head -5 || echo "~/.neato-hive/state/ does not exist (will be created by _update_emit_progress)"
```

Expected: directory may or may not exist. Worker captures baseline.

### 5. Tooling check

```bash
which jq && which wc && which mkdir && which basename && which date && echo "tooling: ✓"
```

Expected: all present (already verified in C.1-C.5).

### 6. Existing C.1-C.4 helper bodies (worker reads to plan emit-call insertions)

```bash
for FN in _update_run_full_flow_with_revert _update_fetch_current_metadata _update_download_tarball _update_verify_checksum _update_extract_tarball _update_apply_overlay _update_revert_overlay _update_post_overlay_finalize; do
  echo "=== ${FN} ==="
  grep -nA 40 "^${FN}\\(\\)" bin/hive | head -45
done
```

Worker captures verbatim. Plans emit-call insertions at the natural phase boundaries (function entry for `*-start`, function exit for `*-complete`). If any function body is unexpected (e.g. has been amended by a recent commit), HALT and ping house-md.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-C.6-sse-state-file`.

**Diff lock: 1 path (`bin/hive`).**

### A.1 — `_update_emit_progress <phase> [<detail_json>]`

The producer helper. Reads `HIVE_UPDATE_STATE_FILE` from env. Appends one JSONL event per call. No-op when env var unset (preserves backward compat for direct helper invocation in unit tests).

```bash
_update_emit_progress() {
  local phase="$1"
  local detail_json="${2:-{}}"
  local state_file="${HIVE_UPDATE_STATE_FILE:-}"

  # No-op when state file path not set (preserves direct-helper-call backward compat)
  [ -z "${state_file}" ] && return 0

  # Ensure parent dir exists (idempotent)
  mkdir -p "$(dirname "${state_file}")" 2>/dev/null || true

  # Sequence = current line count (file may not exist yet — count = 0)
  local seq=0
  [ -f "${state_file}" ] && seq=$(wc -l < "${state_file}" | tr -d ' ')

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Build the event via jq -n + --argjson for safety (no string-concat of detail)
  # Fallback: if jq fails (e.g. bad detail_json), emit a malformed-detail event with the raw string
  local event
  event=$(jq -n -c \
    --arg phase "${phase}" \
    --arg ts "${ts}" \
    --argjson seq "${seq}" \
    --argjson detail "${detail_json}" \
    '{phase: $phase, ts: $ts, sequence: $seq, detail: $detail}' 2>/dev/null) \
  || event=$(jq -n -c \
    --arg phase "${phase}" \
    --arg ts "${ts}" \
    --argjson seq "${seq}" \
    --arg raw "${detail_json}" \
    '{phase: $phase, ts: $ts, sequence: $seq, detail: {error: "malformed_detail_json", raw: $raw}}')

  echo "${event}" >> "${state_file}"
  return 0
}
```

**Notes:**
- `jq -n -c --argjson detail` parses `detail_json` as JSON. If caller passes invalid JSON (e.g. unbalanced quotes), the fallback branch emits a structured `malformed_detail_json` event so the SSE consumer doesn't break on a single bad emit.
- `wc -l < "${state_file}" | tr -d ' '` strips macOS's leading whitespace from `wc` output.
- `tee -a` is NOT used (potential SIGPIPE if SSE relay disconnects mid-write). Plain `>>` is the safer choice for atomic append on POSIX systems.
- Helper does NOT block on errors — file write failures fall through silently. Rationale: progress emission is enrichment, not source-of-truth. If `~/.neato-hive/state/` is read-only somehow, the update flow itself should still succeed; dashboard just won't see live progress.

### A.2 — Orchestrator integration in `_update_run_full_flow_with_revert`

Three insertions at the top of the function:

**Change 1 (after `_update_acquire_lock`):** set `HIVE_UPDATE_STATE_FILE` env + emit `start` + `lock-acquired`:

```bash
  if ! _update_acquire_lock; then
    return 1
  fi

  # C.6 — set up state file path + emit progress events
  local staging_dir
  if ! staging_dir=$(_update_stage_setup); then
    return 1
  fi

  local update_id
  update_id="$(basename "${staging_dir}")"
  local state_dir="${HIVE_STATE_ROOT:-$HOME/.neato-hive}/state"
  mkdir -p "${state_dir}"
  export HIVE_UPDATE_STATE_FILE="${state_dir}/update-${update_id}.jsonl"

  _update_emit_progress "start" "{\"id\":\"${update_id}\",\"dry_run\":${dry_run}}"
  _update_emit_progress "lock-acquired" "{}"
  _update_emit_progress "staging-setup-complete" "{\"path\":\"${staging_dir}\"}"
```

**Change 2 (around the version-compare block):**

```bash
  # ... existing local_version + remote_version reads ...

  local update_avail_str="false"
  if [ -z "${local_version}" ] || ! _update_compare_versions "${local_version}" "${remote_version}"; then
    update_avail_str="true"
  fi
  _update_emit_progress "compare-complete" "{\"local_version\":\"${local_version}\",\"remote_version\":\"${remote_version}\",\"update_available\":${update_avail_str}}"
```

**Change 3 (terminal events at function exit):**

Replace the existing `return 0` at successful end with:
```bash
  _update_emit_progress "done" "{\"success\":true,\"final_version\":\"${remote_version}\"}"
  return 0
```

Replace each error-path `return 1` (after auto-revert handled) with:
```bash
  _update_emit_progress "done" "{\"success\":false,\"final_version\":\"${local_version}\"}"
  return 1
```

### A.3 — Insertions in C.1-C.4 helpers (small touchups, no logic changes)

For each of the helpers listed below, insert `_update_emit_progress` calls at the natural phase boundaries. Worker confirms via diff that ONLY emit-call lines are added; existing logic is preserved.

**`_update_fetch_current_metadata`:**
```bash
_update_fetch_current_metadata() {
  local out="$1"
  local url
  url="$(_update_default_api_url)"
  _update_emit_progress "fetch-start" "{\"api_url\":\"${url}\"}"
  if ! curl -fsSL "${url}" -o "${out}"; then
    # ... existing error handling ...
    return 1
  fi
  # ... existing shape verification ...
  _update_emit_progress "fetch-complete" "{\"remote_version\":\"$(jq -r '.version' "${out}" 2>/dev/null)\"}"
  return 0
}
```

**`_update_download_tarball`:**
```bash
_update_download_tarball() {
  local url="$1"
  local out="$2"
  _update_emit_progress "download-start" "{\"tarball_url\":\"${url}\"}"
  if ! curl -fsSL "${url}" -o "${out}"; then
    # ... existing error ...
    return 1
  fi
  local size
  size=$(wc -c < "${out}" | tr -d ' ')
  _update_emit_progress "download-complete" "{\"tarball_path\":\"${out}\",\"size_bytes\":${size}}"
  return 0
}
```

**`_update_verify_checksum`:**
```bash
_update_verify_checksum() {
  # ... existing args + actual computation ...
  if [ "${actual}" != "${expected}" ]; then
    # ... existing error ...
    return 1
  fi
  _update_emit_progress "verify-complete" "{\"sha256\":\"${actual}\"}"
  return 0
}
```

**`_update_extract_tarball`:**
```bash
_update_extract_tarball() {
  # ... existing tar extraction ...
  if [ ! -d "${staging_dir}/dist-pkg" ]; then
    return 1
  fi
  _update_emit_progress "extract-complete" "{\"extracted_path\":\"${staging_dir}/dist-pkg\"}"
  return 0
}
```

**`_update_apply_overlay`:**
```bash
_update_apply_overlay() {
  # ... existing per-item swap loop ...
  # After the loop completes successfully:
  _update_emit_progress "overlay-applied" "{\"ts\":\"${ts}\",\"items_swapped\":${count}}"
  echo "${ts}"
  return 0
}
```

(`count` derived from the loop — worker may need to add a counter variable; that's a minimal logic change but acceptable since it's purely metric-tracking.)

**`_update_revert_overlay`:**
```bash
_update_revert_overlay() {
  # ... existing args + manifest read ...
  _update_emit_progress "rollback-start" "{\"ts\":\"${ts}\"}"
  # ... existing reverse-walk loop ...
  _update_emit_progress "rollback-complete" "{\"items_reverted\":$((${#items[@]} - failures))}"
  return 0  # or non-zero on failures, with a "rollback-failed" event TODO future leaf
}
```

**`_update_post_overlay_finalize`:**
```bash
_update_post_overlay_finalize() {
  # ... existing args ...
  _update_emit_progress "finalize-start" "{}"

  if ! _update_pnpm_install_post_extract; then
    _update_emit_progress "finalize-failed" "{\"step\":\"pnpm-install\",\"error\":\"pnpm install failed\"}"
    _update_revert_overlay "${ts}" "${staging_dir}/applied.list"
    return 1
  fi
  if ! _update_preserve_list_hash_verify "${preserve_baseline}"; then
    _update_emit_progress "finalize-failed" "{\"step\":\"preserve-verify\",\"error\":\"PRESERVE_LIST drift\"}"
    _update_revert_overlay "${ts}" "${staging_dir}/applied.list"
    return 1
  fi
  if ! _update_doctor_sweep; then
    _update_emit_progress "finalize-failed" "{\"step\":\"doctor\",\"error\":\"doctor sweep failed\"}"
    return 1
  fi
  _update_cleanup_shadows "${ts}"
  _update_stage_cleanup "${staging_dir}"
  _update_cleanup_staging_residue
  _update_emit_progress "finalize-complete" "{}"
  return 0
}
```

### A.4 — Brief comment block above `_update_emit_progress`

```bash
# v1.5.0 C.6 — SSE state-file producer for hive update progress.
# Appends JSONL events to ~/.neato-hive/state/update-<id>.jsonl at every
# phase boundary. D.3 SSE relay tail-follows + /api/update/status/:id
# polling fallback reads same file. E.5 frontend renders progress.
# Locked event schema: {phase, ts, sequence, detail} per line.
# Locked phase vocabulary: see docs/v1.5.0-tasks/C.6-sse-state-file.md §Goal.
# When HIVE_UPDATE_STATE_FILE env is unset, helper is a no-op (preserves
# backward compat for direct helper invocation in unit tests).
```

---

## B. Tests (sandbox-isolated where applicable)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Capture warning-count delta vs C.5 baseline; new code should add zero
```

### B.2 — `_update_emit_progress` direct unit tests

```bash
# Direct call with state file
HIVE_UPDATE_STATE_FILE=/tmp/C6-test.jsonl bash -c '
  source ~/neato-hive/bin/hive
  rm -f /tmp/C6-test.jsonl
  _update_emit_progress "start" "{\"id\":\"test-id-001\"}"
  _update_emit_progress "lock-acquired" "{}"
  _update_emit_progress "fetch-start" "{\"api_url\":\"http://example.com/api/current\"}"
  _update_emit_progress "fetch-complete" "{\"remote_version\":\"1.5.1\"}"
'
echo "--- Generated state file:"
cat /tmp/C6-test.jsonl
echo ""
echo "--- Sequence verification (each line.sequence increments):"
jq -c '.sequence' < /tmp/C6-test.jsonl
# Expected: 0, 1, 2, 3
echo ""
echo "--- Phase ordering:"
jq -c '.phase' < /tmp/C6-test.jsonl
# Expected: "start", "lock-acquired", "fetch-start", "fetch-complete"

# Direct call without state file (no-op)
unset HIVE_UPDATE_STATE_FILE
bash -c 'source ~/neato-hive/bin/hive && _update_emit_progress "test" "{}"' && echo "no-state-file: no-op as expected"

# Malformed detail_json fallback
HIVE_UPDATE_STATE_FILE=/tmp/C6-malformed.jsonl bash -c '
  source ~/neato-hive/bin/hive
  rm -f /tmp/C6-malformed.jsonl
  _update_emit_progress "test" "this-is-not-json"
'
cat /tmp/C6-malformed.jsonl
# Expected: detail field has {"error":"malformed_detail_json","raw":"this-is-not-json"}

# Cleanup
rm -f /tmp/C6-test.jsonl /tmp/C6-malformed.jsonl
```

### B.3 — Integration: full-flow against sandbox emits expected event sequence

Sandbox setup matching C.4's pattern:

```bash
SANDBOX=/tmp/C6-sandbox-install
HIVE_STATE=/tmp/C6-sandbox-hive-state
rm -rf "${SANDBOX}" "${HIVE_STATE}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
mkdir -p "${SANDBOX}/agents/atlas" "${SANDBOX}/data" "${SANDBOX}/config" "${HIVE_STATE}/skills"
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"
cp ~/neato-hive/pnpm-lock.yaml "${SANDBOX}/pnpm-lock.yaml"
echo "atlas-mem" > "${SANDBOX}/agents/atlas/memory.md"
echo "secret" > "${SANDBOX}/.env"
echo "user-skill" > "${HIVE_STATE}/skills/my.md"

# Build fixture tarball
cd ~/neato-hive
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -3
TARBALL_SHA=$(awk '{print $1}' "/tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt")
mkdir -p /tmp/C6-fixture
cat > /tmp/C6-fixture/current.json <<EOF
{"version":"${CURRENT_VERSION}","tarball_url":"file:///tmp/neato-hive-v${CURRENT_VERSION}.tar.gz","checksum_sha256":"${TARBALL_SHA}","released_at":"2026-05-07T00:00:00Z","changelog_url":"http://localhost/x"}
EOF

# Run full flow
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_STATE_ROOT="${HIVE_STATE}" \
HIVE_RELEASES_API="file:///tmp/C6-fixture/current.json" \
HIVE_LOCK_FILE=/tmp/C6-test.lock \
HIVE_UPDATE_SKIP_DOCTOR=1 \
  bash bin/hive _update-full-flow 2>&1 | tail -20

# Locate the state file (id derived from staging dir basename — find it)
STATE_FILE=$(ls "${HIVE_STATE}/state/"update-*.jsonl 2>/dev/null | head -1)
echo "State file: ${STATE_FILE}"
echo ""
echo "--- Full event log:"
cat "${STATE_FILE}"
echo ""
echo "--- Phase sequence verification:"
jq -c '.phase' < "${STATE_FILE}"
# Expected sequence (with HIVE_UPDATE_SKIP_DOCTOR=1):
#   start, lock-acquired, staging-setup-complete,
#   fetch-start, fetch-complete,
#   compare-complete,
#   download-start, download-complete,
#   verify-complete,
#   extract-complete,
#   overlay-applied,
#   finalize-start, finalize-complete,
#   done (with success: true)

echo ""
echo "--- Last event MUST be 'done' with success:true"
tail -1 "${STATE_FILE}" | jq '{phase, success: .detail.success}'
```

### B.4 — Failure-path event: failure-flow emits `finalize-failed` + `rollback-start` + `rollback-complete` + `done(success:false)`

```bash
# Reset sandbox
rm -rf "${SANDBOX}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"

# Run with --inject-failure-after apply (C.3 hook). C.6 should emit auto-revert events.
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_STATE_ROOT="${HIVE_STATE}" \
HIVE_RELEASES_API="file:///tmp/C6-fixture/current.json" \
HIVE_LOCK_FILE=/tmp/C6-test.lock \
HIVE_UPDATE_SKIP_DOCTOR=1 \
  bash bin/hive _update-full-flow --inject-failure-after apply 2>&1 | tail -10

STATE_FILE=$(ls "${HIVE_STATE}/state/"update-*.jsonl 2>/dev/null | tail -1)
echo "--- Failure-flow event log:"
cat "${STATE_FILE}"
# Expected: ... overlay-applied → rollback-start → rollback-complete → done(success: false)

echo ""
echo "--- done.success MUST be false"
tail -1 "${STATE_FILE}" | jq '{phase, success: .detail.success}'
```

### B.5 — Helper bodies' existing logic preserved

```bash
# Diff inspection: each amended helper should show ONLY emit-call additions, no logic edits.
# Worker captures 'git diff bin/hive' and grep for any non-emit-call line additions in C.1-C.4 helpers.
git diff bin/hive | grep -E '^\+' | grep -vE '_update_emit_progress|^\+#|^\+\+\+|^\s*$' | head -20
# Expected: empty (every '+ ' line is either an emit-call or context whitespace)
```

This is a strong gate. If any C.1-C.4 helper has a logic line added (not just emit-call), worker HALTs and reports.

### B.6 — Cleanup

```bash
rm -rf "${SANDBOX}" "${HIVE_STATE}" /tmp/C6-fixture /tmp/C6-test.lock
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` zero new warnings vs C.5 baseline
- [ ] B.2 unit: `_update_emit_progress` produces valid JSONL with monotonic sequence; no-op when env unset; malformed detail falls through to error event
- [ ] B.3 happy path: full-flow emits the locked phase sequence, terminal `done(success:true)`
- [ ] B.4 failure path: full-flow with `--inject-failure-after apply` emits `rollback-start` → `rollback-complete` → `done(success:false)`
- [ ] B.5 logic preservation: diff inspection confirms NO non-emit-call line additions in C.1-C.4 helpers (only emit calls + comment block)
- [ ] **Live install untouched** (sandbox-only)
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.2-B.5 outputs verbatim, shellcheck delta, diff-lock confirmation, "live install untouched" verification

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. C.1-C.5 helpers present: <count> ✓
  3. _update_emit_progress absent: ✓
  4. ~/.neato-hive/state/ baseline: <captured>
  5. tooling: jq ✓ wc ✓ mkdir ✓ basename ✓ date ✓
  6. existing helper bodies: <captured for each of 8 fns — verifies plan matches reality>

Tooling check:
  bash -n: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 _update_emit_progress unit:
    - state file with 4 events: monotonic sequence 0/1/2/3 ✓
    - no-op without state file: ✓
    - malformed detail fallback: emits error event ✓
  B.3 happy path full-flow:
    - phase sequence matches §Goal table ✓
    - last event = done(success:true) ✓
  B.4 failure path:
    - phase sequence emits rollback-start → rollback-complete ✓
    - last event = done(success:false) ✓
  B.5 logic preservation:
    - diff grep returns empty (only emit-calls added) ✓

Live install verification:
  ls ~/.neato-hive/state/update-*.jsonl from worker turn: <empty if sandbox-only ran>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.6-sse-state-file
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — helper + all C.1-C.4 emit-call insertions + orchestrator integration in single PR. No "we'll add the rest of the emit calls in a follow-up" — full vocabulary in this PR.
- **DO NOT MERGE** — house-md
- **DO NOT TOUCH C.1-C.5 HELPER LOGIC** — only emit-call insertions allowed. Worker enforces via diff-grep gate (B.5).
- **DO NOT TOUCH cmd_update or v1.4.9 git-pull body** — C.6 is purely producer-side state-file emission inside the new flow; cmd_update remains as C.5 left it (--rollback + --check branches + git-pull body)
- **DO NOT IMPLEMENT D.3 ENDPOINTS HERE** — `/api/update/status/:id` + SSE relay are D.3's job. C.6 only produces the events; D.3 consumes them in Phase D.
- **HALT-and-ping rule** — pre-flight surprises (C.1-C.5 helpers missing or shape unexpected) stop the worker
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup
- **on-complete prompt is bob-aimed** — pings house-md kind=delegation
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift OK pre-flight
- **No new shell-tool deps** — jq, wc, mkdir, basename, date all standard. Wizard-dep-rule clean.

---

## F. Forward links

- C.7 — v1.4.x → v1.5.0 implicit migration handler. Likely also the cut-over leaf that flips `cmd_update` from git-pull to call `_update_run_full_flow_with_revert` (which now emits C.6 progress events). C.7's first-time-v1.5.0-update flow itself can emit C.6 events for the migration steps (token-gen, PM2 ecosystem update, hive-dashboard first-start).
- D.3 — Dashboard backend `/api/update/progress/:id` SSE endpoint tail-follows the JSONL state file. `/api/update/status/:id` polling endpoint reads last line. Decision E `current_activity.kind="task"` includes update tasks; `current_activity.task_id` is the update id.
- E.5 — Updates page consumes both endpoints. EventSource for live progress + falls back to polling on `EventSource.onerror` (which fires when `hive update` self-restarts the dashboard). Renders phase-by-phase progress bar mapped from C.6's locked phase vocabulary.
