# v1.5.0 C.7 — v1.4.x → v1.5.0 Implicit Migration Handler + `cmd_update` Cut-Over

**Status:** LOCKED — Phase C cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** C — `hive update` rewrite (7 PRs)
**Leaf:** C.7 (7 of 7 in Phase C — final leaf)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.6 ✅ merged 2026-05-07 18:57:29Z — PR squash `f1e40f5` (SSE state-file producer)
**Successor:** Phase D — Dashboard backend (D.0a `hive doctor --json`, D.1-D.4)

---

## Goal

Two coupled changes that close out Phase C:

1. **Migration handler.** Detect "first `hive update` run after a v1.4.x → v1.5.0 jump" and idempotently perform the install-time setup that the v1.5.0 dashboard process needs but the v1.4.x install was never given:
   - Generate `HIVE_DASHBOARD_TOKEN` in `.env` (256-bit hex, `openssl rand -hex 32`) if absent
   - Emit a "PM2 reload pending" banner + state-file event so the owner knows to manually run `pm2 startOrReload ecosystem.config.cjs` (the migration helper itself **does not exec PM2** — see Standing rules)
   - Touch a persistent marker so subsequent updates skip the migration

2. **`cmd_update` cut-over.** Flip the main update path of `cmd_update` from the v1.4.9 git-pull body to call `_update_run_full_flow_with_revert` (the C.1-C.6 pipeline). Preserve the existing `--rollback`, `--check`, and `--check --json` branches verbatim. After this leaf merges, **the new tarball-based pipeline is the active update path.**

The leaf is intentionally narrow: pure additive helpers + a single body replacement in `cmd_update`. No new top-level files, no schema/API changes.

**Why these two land in the same leaf.** The migration handler is meaningless until `cmd_update` actually invokes the new flow — running `hive update` on a v1.4.x install today still does git-pull and never enters `_update_run_full_flow_with_revert`. Coupling them ensures the migration handler runs on the user's *next* `hive update` after this PR ships, rather than waiting for some future cut-over leaf that drifts.

---

## Architectural givens (carried)

- **Marker file path:** `${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/v1_5_0_completed`
  Lives under the **state root** (`~/.neato-hive/`), NOT the install root (`~/neato-hive/`), so it persists across overlay updates without needing PRESERVE_LIST inclusion. Marker is the single source of truth — no version-comparison heuristics.
- **Idempotency contract.** `_update_v1_5_0_run_first_run_migration` is safe to invoke any number of times. Token generation is conditional on `HIVE_DASHBOARD_TOKEN=` being absent from `.env`. Marker write is `mkdir -p` + `touch`. PM2 banner prints unconditionally if PM2 entry not yet active in the user's running daemons (which the worker cannot observe in sandbox — banner always prints when migration runs).
- **Token generation.** `openssl rand -hex 32` produces 64 hex chars (256-bit). Appends to `.env` as `HIVE_DASHBOARD_TOKEN=<token>` on its own line. Does NOT touch any existing line. If the user already has a token (regardless of value), migration leaves it alone.
- **PM2 ban.** Worker code MUST NOT call `pm2 startOrReload`, `pm2 restart`, `pm2 reload`, `pm2 delete`, `pm2 save`, or any other destructive PM2 verb inside the migration handler. Owner ceremony post-update. Helper *may* read `pm2 jlist` non-destructively if it adds value (it doesn't here — banner is unconditional, see above).
- **`cmd_update` body cut-over preserves all existing flag branches.** `--rollback`, `--check`, `--check --json`, and the `--yes`/`-y` skip-prompt flag survive. The `--internal-post-pull` flag is **deprecated** (v1.4.x self-exec relic; tarball install has no `.git/` so post-pull self-exec is impossible). When seen, print a one-line deprecation notice and ignore.
- **Migration runs INSIDE the orchestrator**, AFTER `finalize-complete` and BEFORE the terminal `done` event. This guarantees the freshly-overlaid `ecosystem.config.cjs` is in place when the migration banner tells the owner to reload PM2.

---

## Pre-conditions

- C.6 ✅ merged (squash `f1e40f5`); C.1-C.6 helpers all present in `bin/hive`
- `_update_run_full_flow_with_revert`, `_update_emit_progress`, `_update_post_overlay_finalize` all defined and emit C.6 events
- `cmd_update` body still on git-pull (worker confirms in pre-flight; HALT if it has already been cut over by a stray commit)
- `cmd_update_full_flow` exists as the thin wrapper around `_update_run_full_flow_with_revert` (line ~1605 of `bin/hive` post-C.6)
- `framework_paths` overlay set includes `ecosystem.config.cjs` (worker confirms in pre-flight; the overlay-applied event is the upstream source of the v1.5.0 ecosystem entry landing on the user's disk)
- `openssl` available (already used elsewhere in `bin/hive`; worker spot-checks)

---

## Where state lives (C.7 conventions)

- **`bin/hive` edits:** add 3 new helpers (`_update_v1_5_0_migration_marker_path`, `_update_v1_5_0_check_first_run_needed`, `_update_v1_5_0_run_first_run_migration`) + 1 orchestrator insertion + cut-over of `cmd_update` body + brief comment block. ALL existing helper logic preserved.
- **Marker directory:** `${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/` (created by migration helper if missing — `mkdir -p`)
- **Marker file:** `${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/v1_5_0_completed` (zero-byte; existence is the signal)
- **Token written to:** `${HIVE_INSTALL_ROOT:-$HOME/neato-hive}/.env` (appended; `.env` is in PRESERVE_LIST and survives overlay)
- **NO new top-level files in framework repo.**

---

## Pre-flight (worker MUST run all 7; outputs captured in PR body)

### 1. Framework repo current state (post-C.6)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at `f1e40f5` (C.6 merge) or C.7-spec commit.

### 2. C.1-C.6 helpers present + orchestrator emits all C.6 phases

```bash
grep -nE '^_update_(acquire_lock|stage_setup|fetch_current_metadata|download_tarball|verify_checksum|extract_tarball|apply_overlay|revert_overlay|run_full_flow_with_revert|find_latest_shadow_ts|run_rollback|pnpm_install_post_extract|doctor_sweep|preserve_list_hash_capture|preserve_list_hash_verify|cleanup_shadows|cleanup_staging_residue|post_overlay_finalize|check|emit_progress|compare_versions|default_api_url|stage_cleanup)\(\)' bin/hive | wc -l
```

Expected: ≥ 20. Worker captures the full list verbatim. **HALT and ping house-md** if any C.1-C.6 helper is missing or shape unexpected.

### 3. C.7 target functions absent

```bash
grep -nE '^_update_v1_5_0_(migration_marker_path|check_first_run_needed|run_first_run_migration)\(\)' bin/hive | head -3
```

Expected: empty. **HALT and ping house-md** if any exist (out-of-band drift).

### 4. `cmd_update` body still on git-pull (cut-over not yet applied)

```bash
sed -n '1609,1700p' bin/hive | grep -nE 'git pull|_update_run_full_flow_with_revert' | head -10
```

Expected: at least one `git pull` reference inside `cmd_update` body, ZERO calls to `_update_run_full_flow_with_revert` from inside `cmd_update`. **HALT and ping house-md** if `cmd_update` already calls `_update_run_full_flow_with_revert` (someone else cut over).

### 5. `framework_paths` overlay set includes `ecosystem.config.cjs`

```bash
sed -n '1730,1750p' bin/hive | grep -E 'ecosystem\.config\.cjs'
```

Expected: one match. The hive-dashboard PM2 entry rides into the user's install via the existing overlay step — C.7 does not need to construct or merge ecosystem.config.cjs itself. **HALT and ping house-md** if not found.

### 6. Marker directory baseline (informational — captures pre-state)

```bash
test -d ~/.neato-hive/migrations && ls -la ~/.neato-hive/migrations/ | head -5 \
  || echo "~/.neato-hive/migrations/ does not exist (will be created by migration helper)"
```

Expected: directory may or may not exist. Worker captures baseline.

### 7. Tooling check

```bash
which openssl && which mkdir && which touch && which grep && which date && echo "tooling: ✓"
```

Expected: all present. `openssl` is the new dep vs C.6's tooling check; verify it's there. **HALT and ping house-md** if any missing.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-C.7-migration-handler`.

**Diff lock: 1 path (`bin/hive`).**

### A.1 — `_update_v1_5_0_migration_marker_path`

Returns the absolute path. Pure function, no side effects.

```bash
_update_v1_5_0_migration_marker_path() {
  local state_root="${HIVE_STATE_ROOT:-$HOME/.neato-hive}"
  echo "${state_root}/migrations/v1_5_0_completed"
}
```

### A.2 — `_update_v1_5_0_check_first_run_needed`

Returns 0 (true / "migration needed") if marker absent, 1 (false / "already done") if marker present. Idempotent, read-only.

```bash
_update_v1_5_0_check_first_run_needed() {
  local marker
  marker="$(_update_v1_5_0_migration_marker_path)"
  [ ! -f "${marker}" ]
}
```

### A.3 — `_update_v1_5_0_run_first_run_migration <from_version> <to_version>`

The migration body. Idempotent: safe to invoke any number of times. Emits C.6 events. Does NOT exec PM2.

```bash
_update_v1_5_0_run_first_run_migration() {
  local from_version="${1:-unknown}"
  local to_version="${2:-unknown}"

  _update_emit_progress "migration-start" \
    "$(jq -cn --arg from "${from_version}" --arg to "${to_version}" \
      '{from_version: $from, to_version: $to}')"

  # --- Step 1: dashboard token ---------------------------------------------
  local install_root="${HIVE_INSTALL_ROOT:-$HOME/neato-hive}"
  local env_file="${install_root}/.env"

  # Create .env if it does not exist (PRESERVE_LIST already protects it on
  # subsequent updates, but a fresh-from-tarball install may lack one).
  [ ! -f "${env_file}" ] && touch "${env_file}"

  if grep -qE '^HIVE_DASHBOARD_TOKEN=' "${env_file}"; then
    _update_emit_progress "migration-token-already-present" "{}"
    info "    Dashboard token already present in .env — skipping token generation"
  else
    local token
    if ! token="$(openssl rand -hex 32 2>/dev/null)" || [ -z "${token}" ]; then
      _update_emit_progress "migration-failed" \
        "$(jq -cn --arg step "token-gen" --arg error "openssl rand -hex 32 failed" \
          '{step: $step, error: $error}')"
      error "Migration failed: openssl rand -hex 32 produced no output"
      return 1
    fi
    # Append on its own line — never touch existing lines.
    printf '\nHIVE_DASHBOARD_TOKEN=%s\n' "${token}" >> "${env_file}"
    _update_emit_progress "migration-token-generated" "{}"
    info "    Generated HIVE_DASHBOARD_TOKEN in .env (256-bit hex)"
  fi

  # --- Step 2: PM2 reload pending banner -----------------------------------
  # We do NOT exec PM2 ourselves — that is owner ceremony. Print the banner
  # and emit a state-file event so the dashboard (D.3 / E.5) can render the
  # "PM2 reload pending" hint after the user opens the Updates page.
  local ecosystem_path="${install_root}/ecosystem.config.cjs"
  _update_emit_progress "migration-pm2-reload-pending" \
    "$(jq -cn --arg path "${ecosystem_path}" '{ecosystem_path: $path}')"

  echo ""
  echo "  ┌─────────────────────────────────────────────────────────────────┐"
  echo "  │  v1.5.0 migration: PM2 reload required                          │"
  echo "  │                                                                 │"
  echo "  │  The v1.5.0 ecosystem.config.cjs adds a 'hive-dashboard'        │"
  echo "  │  process. To start it, run:                                     │"
  echo "  │                                                                 │"
  echo "  │      cd ${install_root}"
  echo "  │      pm2 startOrReload ecosystem.config.cjs"
  echo "  │      pm2 save"
  echo "  │                                                                 │"
  echo "  │  This is a one-time step. Subsequent updates will not show     │"
  echo "  │  this banner.                                                   │"
  echo "  └─────────────────────────────────────────────────────────────────┘"
  echo ""

  # --- Step 3: write marker ------------------------------------------------
  local marker
  marker="$(_update_v1_5_0_migration_marker_path)"
  mkdir -p "$(dirname "${marker}")" 2>/dev/null || true
  touch "${marker}" || {
    _update_emit_progress "migration-failed" \
      "$(jq -cn --arg step "marker-write" --arg error "touch ${marker} failed" \
        '{step: $step, error: $error}')"
    error "Migration failed: could not write marker file ${marker}"
    return 1
  }

  _update_emit_progress "migration-complete" \
    "$(jq -cn --arg from "${from_version}" --arg to "${to_version}" --arg marker "${marker}" \
      '{from_version: $from, to_version: $to, marker: $marker}')"
  info "    Migration complete (marker: ${marker})"
  return 0
}
```

**Notes:**
- Token generation is silent-on-success (only the `info "Generated ..."` line, no echo of the token itself). Token never appears in stdout, stderr, or state-file events. The state event is `{}` — no detail leakage.
- Banner is plain ASCII (no Unicode box-drawing) for portability across terminals. The `pm2 startOrReload` instruction is the literal command the owner runs.
- All failure paths emit a `migration-failed` C.6 event before returning non-zero. The orchestrator treats migration failure as a non-fatal warning (the update itself already succeeded — overlay+finalize are done — migration is enrichment). See A.4 for orchestrator integration semantics.

### A.4 — Orchestrator integration in `_update_run_full_flow_with_revert`

After `_update_post_overlay_finalize` returns success and BEFORE the terminal `done` event, insert:

```bash
  # C.7 — first-run v1.5.0 migration (idempotent; no-op once marker exists)
  if _update_v1_5_0_check_first_run_needed; then
    if ! _update_v1_5_0_run_first_run_migration "${local_version}" "${remote_version}"; then
      # Migration failure is non-fatal: the update overlay+finalize already succeeded.
      # The marker is NOT written, so migration retries on the next `hive update`.
      warn "v1.5.0 migration step failed — will retry on next update"
    fi
  fi

  _update_emit_progress "done" "{\"success\":true,\"final_version\":\"${remote_version}\"}"
  return 0
```

**Semantics:**
- Migration is invoked AFTER finalize-complete (overlay+pnpm-install+preserve-verify+doctor all clean), so the user's install is in a known-good v1.5.0 state when migration runs.
- Migration failure does NOT trigger rollback — the overlay is good, only the post-overlay enrichment failed. The next `hive update` retries (marker missing).
- Migration only runs in the SUCCESS path. Failure paths (`return 1` from finalize/overlay/etc.) skip migration entirely and proceed to their existing rollback + `done(success:false)` flow.

### A.5 — `cmd_update` body cut-over

Replace the entire "Phase 1: pre-pull checks + git pull + self-exec" block (the body that runs when `is_post_pull = false`) with a single call to `_update_run_full_flow_with_revert "$@"`. Remove the `is_post_pull` branching, the `--internal-post-pull` self-exec gymnastics, and the git-pull body.

**Preserved (verbatim — diff inspection in B.5 confirms):**
- `--rollback` branch at the top of `cmd_update` (added by C.3)
- `--check` and `--check --json` branches (added by C.5)
- `--yes` / `-y` flag passthrough to the new full-flow

**Replaced:**
- Everything under `# Phase 1: pre-pull checks + git pull + self-exec` through the end of `cmd_update`'s body

**New body shape:**

```bash
cmd_update() {
  # C.3 — rollback path
  if [ "${1:-}" = "--rollback" ]; then
    shift
    _update_run_rollback "$@"
    return $?
  fi

  # C.5 — API-based check-only mode
  if [ "${1:-}" = "--check" ]; then
    shift
    _update_check "$@"
    return $?
  fi

  # C.7 — deprecated v1.4.x self-exec flag (tarball install has no .git/, so
  # post-pull self-exec is impossible). Strip and warn if seen.
  local filtered_args=()
  for arg in "$@"; do
    case "$arg" in
      --internal-post-pull)
        warn "--internal-post-pull is deprecated (v1.4.x flag, ignored on v1.5.0+)"
        ;;
      *) filtered_args+=("$arg") ;;
    esac
  done

  # C.7 — main path: tarball-based full flow (replaces v1.4.9 git-pull body)
  _update_run_full_flow_with_revert "${filtered_args[@]}"
  return $?
}
```

**Out-of-scope explicitly:**
- `cmd_update_full_flow` (line ~1605) stays as the existing thin wrapper. NOT removed (other code paths or future leaves may invoke it).
- `cmd_update_overlay_apply`, `cmd_update_overlay_revert`, `cmd_update_fetch_stage` (lines 1442-1605) stay as is. They're the per-step CLI entry points used by the spec's sandbox tests.
- The auto-repair `framework_paths` block (lines ~1730+) stays. It's reachable from elsewhere; the cut-over only flips `cmd_update`'s main body.

### A.6 — Comment block above the new helpers

```bash
# v1.5.0 C.7 — implicit migration handler for v1.4.x → v1.5.0 jump.
# First-run after the cut-over (cmd_update now invokes the C.1-C.6 pipeline)
# performs idempotent setup: generate HIVE_DASHBOARD_TOKEN in .env if absent,
# emit a "PM2 reload pending" banner + state-file event, and write a persistent
# marker so subsequent updates skip migration. Marker lives under HIVE_STATE_ROOT
# (~/.neato-hive/migrations/v1_5_0_completed) — outside the install root, so
# overlay updates cannot touch it.
#
# Worker contract: this helper does NOT exec PM2. PM2 reload is owner ceremony.
# The banner instructs the owner; the state event lets the dashboard render
# the "reload pending" hint when the Updates page renders post-update.
#
# Idempotency: safe to call any number of times. Token generation is conditional
# on .env not already containing HIVE_DASHBOARD_TOKEN=. Marker write is mkdir+touch.
#
# See docs/v1.5.0-tasks/C.7-migration-handler.md for the full contract.
```

---

## B. Tests (sandbox-isolated where applicable)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Capture warning-count delta vs C.6 baseline; new code should add zero
```

### B.2 — Migration helper unit tests

```bash
# Setup
SANDBOX_STATE=/tmp/C7-state-root
SANDBOX_INSTALL=/tmp/C7-install-root
rm -rf "${SANDBOX_STATE}" "${SANDBOX_INSTALL}"
mkdir -p "${SANDBOX_STATE}" "${SANDBOX_INSTALL}"

# --- B.2.a check_first_run_needed: marker absent → "needed" (returns 0) ---
HIVE_STATE_ROOT="${SANDBOX_STATE}" bash -c '
  source ~/neato-hive/bin/hive
  if _update_v1_5_0_check_first_run_needed; then
    echo "B.2.a: needed (marker absent) ✓"
  else
    echo "B.2.a: FAIL — expected needed"; exit 1
  fi
'

# --- B.2.b run_first_run_migration: full flow (no token, no marker) ---
HIVE_STATE_ROOT="${SANDBOX_STATE}" \
HIVE_INSTALL_ROOT="${SANDBOX_INSTALL}" \
HIVE_UPDATE_STATE_FILE="${SANDBOX_STATE}/state/test-events.jsonl" \
  bash -c '
    source ~/neato-hive/bin/hive
    mkdir -p "$(dirname "$HIVE_UPDATE_STATE_FILE")"
    : > "$HIVE_UPDATE_STATE_FILE"
    _update_v1_5_0_run_first_run_migration "1.4.9" "1.5.0"
'

# Verify token in .env
grep -E '^HIVE_DASHBOARD_TOKEN=[a-f0-9]{64}$' "${SANDBOX_INSTALL}/.env" \
  && echo "B.2.b: token written, 64 hex chars ✓" \
  || { echo "B.2.b: FAIL — bad token"; exit 1; }

# Verify marker
test -f "${SANDBOX_STATE}/migrations/v1_5_0_completed" \
  && echo "B.2.b: marker written ✓" \
  || { echo "B.2.b: FAIL — marker missing"; exit 1; }

# Verify event sequence
echo "--- B.2.b emitted events:"
jq -c '.phase' < "${SANDBOX_STATE}/state/test-events.jsonl"
# Expected: "migration-start", "migration-token-generated", "migration-pm2-reload-pending", "migration-complete"

# --- B.2.c idempotency: second invocation = no double-token, no extra events ---
TOKEN_LINES_BEFORE=$(grep -cE '^HIVE_DASHBOARD_TOKEN=' "${SANDBOX_INSTALL}/.env")
EVENT_LINES_BEFORE=$(wc -l < "${SANDBOX_STATE}/state/test-events.jsonl" | tr -d ' ')

HIVE_STATE_ROOT="${SANDBOX_STATE}" \
HIVE_INSTALL_ROOT="${SANDBOX_INSTALL}" \
HIVE_UPDATE_STATE_FILE="${SANDBOX_STATE}/state/test-events.jsonl" \
  bash -c '
    source ~/neato-hive/bin/hive
    _update_v1_5_0_run_first_run_migration "1.4.9" "1.5.0"
'

TOKEN_LINES_AFTER=$(grep -cE '^HIVE_DASHBOARD_TOKEN=' "${SANDBOX_INSTALL}/.env")
EVENT_LINES_AFTER=$(wc -l < "${SANDBOX_STATE}/state/test-events.jsonl" | tr -d ' ')

[ "${TOKEN_LINES_BEFORE}" = "${TOKEN_LINES_AFTER}" ] && [ "${TOKEN_LINES_AFTER}" = "1" ] \
  && echo "B.2.c: token NOT duplicated (count: ${TOKEN_LINES_AFTER}) ✓" \
  || { echo "B.2.c: FAIL — token duplicated"; exit 1; }

echo "--- B.2.c second-run events (should include 'migration-token-already-present'):"
tail -n $((EVENT_LINES_AFTER - EVENT_LINES_BEFORE)) "${SANDBOX_STATE}/state/test-events.jsonl" | jq -c '.phase'

# --- B.2.d check_first_run_needed: marker present → "not needed" (returns 1) ---
HIVE_STATE_ROOT="${SANDBOX_STATE}" bash -c '
  source ~/neato-hive/bin/hive
  if ! _update_v1_5_0_check_first_run_needed; then
    echo "B.2.d: not needed (marker present) ✓"
  else
    echo "B.2.d: FAIL — expected not needed"; exit 1
  fi
'

# Cleanup
rm -rf "${SANDBOX_STATE}" "${SANDBOX_INSTALL}"
```

### B.3 — Full-flow integration: marker absent → migration events emitted

Sandbox setup mirrors C.6's B.3 with the marker explicitly absent.

```bash
SANDBOX=/tmp/C7-sandbox-install
HIVE_STATE=/tmp/C7-sandbox-hive-state
rm -rf "${SANDBOX}" "${HIVE_STATE}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
mkdir -p "${SANDBOX}/agents/atlas" "${SANDBOX}/data" "${SANDBOX}/config" "${HIVE_STATE}/skills"
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"
cp ~/neato-hive/pnpm-lock.yaml "${SANDBOX}/pnpm-lock.yaml"

# Build fixture tarball (same as C.6)
cd ~/neato-hive
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -3
TARBALL_SHA=$(awk '{print $1}' "/tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt")
mkdir -p /tmp/C7-fixture
cat > /tmp/C7-fixture/current.json <<EOF
{"version":"${CURRENT_VERSION}","tarball_url":"file:///tmp/neato-hive-v${CURRENT_VERSION}.tar.gz","checksum_sha256":"${TARBALL_SHA}","released_at":"2026-05-07T00:00:00Z","changelog_url":"http://localhost/x"}
EOF

# Verify marker absent BEFORE
test ! -f "${HIVE_STATE}/migrations/v1_5_0_completed" \
  && echo "Pre-flow: marker absent ✓" \
  || { echo "FAIL — marker pre-existed"; exit 1; }

# Run full flow
HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_STATE_ROOT="${HIVE_STATE}" \
HIVE_RELEASES_API="file:///tmp/C7-fixture/current.json" \
HIVE_LOCK_FILE=/tmp/C7-test.lock \
HIVE_UPDATE_SKIP_DOCTOR=1 \
  bash bin/hive _update-full-flow 2>&1 | tail -30

# Verify migration events in state file
STATE_FILE=$(ls "${HIVE_STATE}/state/"update-*.jsonl 2>/dev/null | head -1)
echo "--- Phase sequence (post-finalize section):"
jq -c '.phase' < "${STATE_FILE}" | tail -10
# Expected to include: ..., finalize-complete, migration-start, migration-token-generated,
#                      migration-pm2-reload-pending, migration-complete, done

echo ""
echo "--- migration-* events present:"
jq -c 'select(.phase | startswith("migration-"))' < "${STATE_FILE}"

# Verify marker written
test -f "${HIVE_STATE}/migrations/v1_5_0_completed" \
  && echo "Post-flow: marker written ✓" \
  || { echo "FAIL — marker not written"; exit 1; }

# Verify token in install .env
grep -E '^HIVE_DASHBOARD_TOKEN=[a-f0-9]{64}$' "${SANDBOX}/.env" \
  && echo "Post-flow: token in .env ✓" \
  || { echo "FAIL — token missing"; exit 1; }

# Verify done(success:true) terminal event
tail -1 "${STATE_FILE}" | jq '{phase, success: .detail.success}'
# Expected: {"phase":"done","success":true}
```

### B.4 — Full-flow integration: marker present → migration skipped

```bash
# Reset sandbox but pre-write the marker
rm -rf "${SANDBOX}"
mkdir -p "${SANDBOX}/dist" "${SANDBOX}/bin" "${SANDBOX}/templates" "${SANDBOX}/shared" "${SANDBOX}/skills"
echo '{"version":"0.0.0-fixture-old"}' > "${SANDBOX}/package.json"
echo "old-version" > "${SANDBOX}/VERSION"
# Marker remains from B.3 in HIVE_STATE — but reset state file dir to detect new run cleanly
rm -rf "${HIVE_STATE}/state"
test -f "${HIVE_STATE}/migrations/v1_5_0_completed" \
  && echo "Pre-flow: marker exists (from B.3) ✓"

HIVE_INSTALL_ROOT="${SANDBOX}" \
HIVE_STATE_ROOT="${HIVE_STATE}" \
HIVE_RELEASES_API="file:///tmp/C7-fixture/current.json" \
HIVE_LOCK_FILE=/tmp/C7-test.lock \
HIVE_UPDATE_SKIP_DOCTOR=1 \
  bash bin/hive _update-full-flow 2>&1 | tail -10

STATE_FILE=$(ls "${HIVE_STATE}/state/"update-*.jsonl 2>/dev/null | head -1)
echo "--- B.4 phase sequence (must NOT contain migration-*):"
jq -c '.phase' < "${STATE_FILE}"

# Assert no migration events
MIGRATION_EVENT_COUNT=$(jq -c 'select(.phase | startswith("migration-"))' < "${STATE_FILE}" | wc -l | tr -d ' ')
[ "${MIGRATION_EVENT_COUNT}" = "0" ] \
  && echo "B.4: zero migration events ✓ (skipped via marker)" \
  || { echo "B.4: FAIL — found ${MIGRATION_EVENT_COUNT} migration events"; exit 1; }
```

### B.5 — Logic preservation gate (B.5-equivalent for C.1-C.6)

```bash
# Diff inspection: confirm NO modifications to C.1-C.6 helper bodies.
# Only allowed additions: 3 new helpers, 1 orchestrator emit-call insertion + migration call,
# cmd_update body replacement, comment block.

git diff main...feat/v1.5.0-C.7-migration-handler -- bin/hive \
  | grep -E '^\+' \
  | grep -vE '^\+\+\+|^\+#|^\+\s*$' \
  | grep -vE '_update_v1_5_0_(migration_marker_path|check_first_run_needed|run_first_run_migration)' \
  | grep -vE '_update_emit_progress.*migration-' \
  | grep -vE 'cmd_update\(\)|filtered_args|--internal-post-pull|--rollback|--check|_update_run_full_flow_with_revert|_update_run_rollback|_update_check' \
  | head -30

# Expected: empty after the filters. Worker captures verbatim and confirms.
# If non-empty, those lines are unexpected logic edits → HALT and ping house-md.
```

### B.6 — `cmd_update` cut-over assertions

```bash
# B.6.a — git pull body removed
grep -nE 'git pull origin' bin/hive | head -3
# Expected: zero matches inside cmd_update body. May still appear in legacy comments
# elsewhere — worker confirms by examining each match.

# B.6.b — cmd_update calls _update_run_full_flow_with_revert
sed -n '/^cmd_update\(\) {/,/^}/p' bin/hive | grep -E '_update_run_full_flow_with_revert'
# Expected: ≥ 1 match.

# B.6.c — preserved branches
sed -n '/^cmd_update\(\) {/,/^}/p' bin/hive | grep -E '"--rollback"|"--check"' | head -5
# Expected: --rollback and --check branches still present.

# B.6.d — --internal-post-pull deprecation notice present
sed -n '/^cmd_update\(\) {/,/^}/p' bin/hive | grep -E '\-\-internal-post-pull|deprecated'
# Expected: ≥ 1 match (the deprecation warning line).

# B.6.e — bash -n still clean
bash -n bin/hive && echo "B.6.e: bash -n clean ✓"
```

### B.7 — Cleanup

```bash
rm -rf "${SANDBOX}" "${HIVE_STATE}" /tmp/C7-fixture /tmp/C7-test.lock
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` zero new warnings vs C.6 baseline
- [ ] B.2 unit tests: all four sub-cases pass (a needed, b full-flow with token+marker+events, c idempotency, d not-needed-when-marker-present)
- [ ] B.3 happy path: full-flow on a sandbox with no marker emits `migration-start` → `migration-token-generated` → `migration-pm2-reload-pending` → `migration-complete`, writes marker, writes token, terminal `done(success:true)`
- [ ] B.4 marker-present path: full-flow on a sandbox with pre-existing marker emits ZERO migration events, terminal `done(success:true)`
- [ ] B.5 logic preservation: diff filter produces empty output (only allowed additions present)
- [ ] B.6 cut-over: git-pull body removed, `_update_run_full_flow_with_revert` invoked, all flag branches preserved, `--internal-post-pull` deprecation notice present, `bash -n` clean
- [ ] **Live install untouched** (sandbox-only — worker confirms `~/.neato-hive/migrations/` and `~/neato-hive/.env` were not modified by the worker turn)
- [ ] **No PM2 commands executed by worker code** (grep `^[+] *pm2 ` against the diff returns zero matches)
- [ ] PR body: pre-flight 1-7 outputs verbatim, B.2-B.6 outputs verbatim, shellcheck delta, diff-lock confirmation, "live install untouched" verification, "no PM2 verbs in worker scope" attestation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)
Branch: feat/v1.5.0-C.7-migration-handler

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. C.1-C.6 helpers present: <count> ✓
  3. C.7 target functions absent: ✓
  4. cmd_update body still on git-pull: ✓
  5. framework_paths includes ecosystem.config.cjs: ✓
  6. ~/.neato-hive/migrations/ baseline: <captured>
  7. tooling: openssl ✓ mkdir ✓ touch ✓ grep ✓ date ✓

Tooling check:
  bash -n: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 migration helper units:
    - B.2.a needed (marker absent): ✓
    - B.2.b full-flow (token + marker + 4 events): ✓
    - B.2.c idempotency (token NOT duplicated, second run emits token-already-present): ✓
    - B.2.d not-needed (marker present): ✓
  B.3 full-flow happy path with no marker:
    - phase sequence includes migration-* events ✓
    - marker written ✓
    - token in .env ✓
    - done(success:true) ✓
  B.4 full-flow with marker present:
    - zero migration events ✓
    - done(success:true) ✓
  B.5 logic preservation:
    - filtered diff returns empty (only allowed additions) ✓
  B.6 cut-over:
    - git pull origin removed from cmd_update: ✓
    - cmd_update calls _update_run_full_flow_with_revert: ✓
    - --rollback / --check branches preserved: ✓
    - --internal-post-pull deprecation notice present: ✓
    - bash -n clean: ✓

Worker scope attestations:
  - No PM2 verbs (startOrReload/restart/reload/delete/save) in the diff
  - Live ~/.neato-hive/migrations/ unchanged from worker turn
  - Live ~/neato-hive/.env unchanged from worker turn

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-C.7-migration-handler
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — migration handler + cmd_update cut-over together in single PR. No "we'll cut over in a follow-up" — Phase C closes here.
- **DO NOT MERGE** — house-md
- **DO NOT EXEC PM2** — worker code MUST NOT invoke `pm2 startOrReload`, `pm2 restart`, `pm2 reload`, `pm2 delete`, `pm2 save`, or any other destructive PM2 verb. Banner + state event only. Owner ceremony for the actual reload.
- **DO NOT TOUCH C.1-C.6 HELPER BODIES** — only allowed additions are: 3 new C.7 helpers, 1 orchestrator emit-call/migration-call insertion, cmd_update body replacement, comment block. Diff-grep gate (B.5) enforces this.
- **DO NOT WRITE TO LIVE ~/.neato-hive/ or ~/neato-hive/.env FROM WORKER TURN** — all migration-helper exercises run against `${SANDBOX}` / `${HIVE_STATE}` paths. Worker attests in DONE block.
- **DO NOT CHANGE THE C.6 PHASE VOCABULARY** — C.7 introduces NEW phase strings (`migration-start`, `migration-token-generated`, `migration-token-already-present`, `migration-pm2-reload-pending`, `migration-complete`, `migration-failed`) but does not modify the existing 14 phases from C.6. Forward-compat with D.3/E.5.
- **TOKEN GENERATION USES `openssl rand -hex 32`** — no alternatives. The 64-hex-char format is the contract D.1 (Express auth middleware) reads.
- **MARKER LIVES UNDER `${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/`** — never under the install root. Survives overlay updates without PRESERVE_LIST inclusion.
- **HALT-and-ping rule** — pre-flight surprises (helpers missing, cmd_update already cut over, openssl absent, ecosystem.config.cjs not in framework_paths) stop the worker
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup
- **on-complete prompt is bob-aimed** — pings house-md kind=delegation when DONE block emitted
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift OK pre-flight
- **No new shell-tool deps** — openssl, mkdir, touch, grep, date all standard. Wizard-dep-rule clean.

---

## F. Forward links

- **D.1** — Express skeleton + token auth middleware reads `HIVE_DASHBOARD_TOKEN` from `.env`. C.7 ensures the token is present before D.1's process can boot. No further token coordination needed.
- **D.3** — Dashboard `/api/update/status/:id` polling + SSE relay tail-follow now see C.7's `migration-*` events. D.3 SHOULD render these as a discrete "Migration" section in the Updates page (or roll them into a single "Post-update setup" step). E.5 frontend pattern is unchanged from C.6.
- **D.4** — `hive dashboard rotate-token` CLI subcommand SHOULD reuse the token-generation logic (extract `openssl rand -hex 32` + `.env` append into a shared helper as part of D.4 if convenient; not required).
- **F.2** — Installer wizard's fresh-install path SHOULD also write the C.7 marker (after generating the dashboard token at install time), so a freshly-installed v1.5.0 user's first `hive update` skips migration. F.2 spec amends to call `_update_v1_5_0_run_first_run_migration` (idempotent) at the end of the installer flow, OR writes the marker directly. Whichever F.2 chooses, the contract is "marker exists at end of fresh install."
- **Phase C closing gate (deferred — not in this leaf)** — synthetic v1.5.0 → v1.5.0.1 update on a clone:
  - Run `hive update` on a v1.5.0 install with the marker pre-existing (skips migration)
  - Inject failure mid-flow → confirm rollback emits C.6 events through completion
  - Verify state file is valid JSONL through the entire run
  - Confirm PRESERVE_LIST untouched (C.4's hash gate)
  This requires a published v1.5.0.1 tarball — runs as the **closing owner ceremony** for Phase C, AFTER v1.5.0 ships and a v1.5.0.1 release exists. C.7's B.3+B.4 already cover the "synthetic v1.5.0 → vCURRENT" portion of this gate against a self-built fixture tarball, so the live-clone gate is incremental verification rather than a blocking dependency for the Phase D dispatch.
