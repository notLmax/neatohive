# v1.5.0 D.0a — `hive doctor --json` Mode (Structured Output)

**Status:** LOCKED — Phase D cron-driver auto-dispatches Bob within 5 min of this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** D — Dashboard backend (5 PRs)
**Leaf:** D.0a (1 of 5 in Phase D — small, blocks D.3)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessor:** C.7 ✅ merged 2026-05-07 19:32:26Z — squash `45509d1` (migration handler + cmd_update cut-over). Phase C complete.
**Successor:** D.1 (Express skeleton + token auth + PM2 hive-dashboard entry)

---

## Goal

Add a `--json` flag to `cmd_doctor` so the dashboard backend (D.3 doctor endpoint) can consume structured doctor output instead of scraping ANSI text.

**Design constraint: existing text-mode output is preserved verbatim.** Users running `hive doctor` see exactly the same printf/echo output they see today. JSON mode is additive — instrumented in parallel with the existing text rendering via a single `_doctor_record` helper that pushes structured records into a buffer. At end of run, if `--json` was passed, emit the JSON envelope to stdout (suppressing the text-mode trailing summary); otherwise fall through to the existing text summary.

This pattern keeps the diff small (~60-100 lines added, zero existing lines removed) and eliminates drift risk between the two modes — text and JSON share the exact same check logic and are decided at the moment-of-status, not by a parallel re-implementation.

**Locked envelope shape (consumer contract — D.3 + frontend depend on this):**

```json
{
  "version": "1",
  "ts": "2026-05-08T00:00:00Z",
  "summary": {
    "total": 23,
    "pass": 20,
    "warn": 1,
    "fail": 2,
    "skip": 0,
    "exit_code": 1
  },
  "checks": [
    {
      "id": "hive-version",
      "label": "Hive version",
      "category": "core",
      "status": "pass",
      "detail": "v1.5.0",
      "fix_hint": null
    }
  ],
  "agents": [
    {
      "name": "atlas",
      "status": "pass",
      "checks": [
        {
          "id": "bot-token",
          "label": "Bot token (DISCORD_BOT_TOKEN_ATLAS)",
          "category": "agent",
          "status": "pass",
          "detail": null,
          "fix_hint": null
        }
      ]
    }
  ]
}
```

**Locked status enum:** `pass` | `warn` | `fail` | `skip`. Maps from existing text labels:
- `pass` ← `OK`, `SET`, `ONLINE`
- `warn` ← `WARN`, `STALE`, `INFO` (advisory)
- `fail` ← `FAIL`, `CONFLICT`, `MISMATCH`, `MISSING`, `NOT RUNNING`, error-y states
- `skip` ← `SKIP`

**Locked category enum:** `core` | `deps` | `auth` | `build` | `config` | `agent` | `strategic`. Categories group related checks for the dashboard renderer. Mapping:
- `core` ← hive-version, up-to-date-with-origin
- `deps` ← node-installed, pm2-installed, claude-cli-installed
- `auth` ← claude-cli-authenticated, claude-auth-type, anthropic-api-key-conflict
- `build` ← typescript-compiled, build-current
- `config` ← env-file-exists, discord-owner-id-set, install-dir-allowed-paths
- `agent` ← all per-agent checks (bot-token, behavior-directory, IDENTITY.md, etc.)
- `strategic` ← S1 fleet-drift, S2 runner-drift, S3+ (any strategic checks)

Stable kebab-case `id` strings are the dashboard's stable handles. Adding new checks in future leaves grows the enum but never renames an `id`.

---

## Architectural givens (carried)

- **Existing text rendering is the source of truth.** The `_doctor_record` helper is invoked AFTER each check's status is determined, capturing the same status that text mode just emitted. Both modes always agree.
- **JSON mode suppresses text rendering entirely.** When `--json` is passed, `cmd_doctor` redirects all the existing printf/echo to `/dev/null` (or a captured-and-discarded buffer) so the user sees ONLY the JSON envelope on stdout. Stderr is still available for hard errors (e.g. malformed jq invocation).
- **Status enum is the contract — never extend without bumping `version`.** If a future leaf adds a 5th status (e.g. `unknown`), it MUST also bump `version` to `"2"` so the dashboard knows to handle it. D.0a is `version: "1"` and the four-status enum.
- **Exit code semantics preserved.** `cmd_doctor --json` returns the same exit code as `cmd_doctor` (0 if all pass, 1 if any fail, including pre-existing text-mode `--fix` summary).
- **`--json` is incompatible with `--fix`.** `--fix` invokes interactive prompts and PM2 reconciliation; emitting JSON during interactive flows is meaningless. If both flags are passed, the worker errors with `Error: --json cannot be combined with --fix or --fix-setup` and returns 2.
- **`--json` skips the trailing newline summary block.** The existing "Issues: N. Fixes: M." footer is text-mode only. JSON mode replaces it with the `summary` object inside the envelope.
- **No new shell tooling.** `jq` is already a confirmed dep (used in C.6/C.7).

---

## Pre-conditions

- Phase C complete (C.7 merged at `45509d1`); `cmd_doctor` body present in `bin/hive` at line ~1827
- `cmd_doctor` body shape unchanged from current `main` (worker confirms via line-count + grep in pre-flight)
- `jq` available (already verified in C.6/C.7)
- `_doctor_record` and `_doctor_emit_json_envelope` not already defined (worker confirms in pre-flight)

---

## Where state lives (D.0a conventions)

- **`bin/hive` edits:** add 2 new helpers (`_doctor_record`, `_doctor_emit_json_envelope`) + flag parsing in `cmd_doctor` + ~25 instrumentation insertions (one `_doctor_record` call after each existing check) + 1 envelope-emit at end of `cmd_doctor` + brief comment block. ALL existing text rendering preserved.
- **No new top-level files.** Single-file diff.
- **JSON buffer:** in-memory shell-array `DOCTOR_RECORDS` (top-level) + `DOCTOR_AGENTS` (per-agent group). Cleared on each `cmd_doctor` invocation.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-C.7)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -3
```

Expected: HEAD at `45509d1` (C.7 merge) or D.0a-spec commit.

### 2. `cmd_doctor` body present + line count

```bash
grep -nE '^cmd_doctor\(\) \{' bin/hive | head -3
awk '/^cmd_doctor\(\) \{/,/^}/' bin/hive | wc -l
```

Expected: 1 match for the function start. Line count typically 250-350 (existing text-mode body). Worker captures both.

### 3. D.0a target functions absent

```bash
grep -nE '^_doctor_record\(\)|^_doctor_emit_json_envelope\(\)' bin/hive | head -3
```

Expected: empty. **HALT and ping house-md** if either exists.

### 4. Status-label inventory in current `cmd_doctor`

```bash
awk '/^cmd_doctor\(\) \{/,/^}/' bin/hive \
  | grep -oE '\$\{(GREEN|YELLOW|RED|CYAN|DIM)\}[A-Z][A-Z]+\$\{RESET\}' \
  | sort -u
```

Expected: Worker captures the unique set of status labels emitted today. Maps to the 4-status enum per the §Goal mapping table. **HALT and ping house-md** if any status label is unmapped (e.g. an unanticipated one like `PARTIAL` or `RETRY`).

### 5. Existing flag handling (worker reads to plan parser surgery)

```bash
sed -n '/^cmd_doctor\(\) \{/,/done/p' bin/hive | head -25
```

Worker captures the existing flag-parser block (the `for arg in "$@"; do case "$arg" in ...` lines). Plans how to add `--json` to the same parser without disturbing `--fix`, `--fix-setup`, `--yes`, `-y`.

### 6. Tooling check

```bash
which jq && which printf && which date && echo "tooling: ✓"
```

Expected: all present. No new deps.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-D.0a-doctor-json`.

**Diff lock: 1 path (`bin/hive`).**

### A.1 — `_doctor_record <id> <label> <category> <status> [<detail>] [<fix_hint>]`

Pushes one structured record into the global `DOCTOR_RECORDS` array (or `DOCTOR_AGENTS` if context is per-agent — see A.4). Pure function aside from the array append. Idempotent re-invocation is safe (each call appends a new record).

```bash
_doctor_record() {
  local id="$1"
  local label="$2"
  local category="$3"
  local status="$4"
  local detail="${5:-}"
  local fix_hint="${6:-}"

  # Validate status enum at record time — bug catcher
  case "${status}" in
    pass|warn|fail|skip) ;;
    *)
      # Stderr only — never break JSON output
      echo "WARN: _doctor_record received invalid status '${status}' for id '${id}'" >&2
      status="warn"
      ;;
  esac

  # Build the record via jq for safe escaping (no string-concat of user-provided strings)
  local record
  record=$(jq -n -c \
    --arg id "${id}" \
    --arg label "${label}" \
    --arg category "${category}" \
    --arg status "${status}" \
    --arg detail "${detail}" \
    --arg fix_hint "${fix_hint}" \
    '{
       id: $id,
       label: $label,
       category: $category,
       status: $status,
       detail: (if $detail == "" then null else $detail end),
       fix_hint: (if $fix_hint == "" then null else $fix_hint end)
     }')

  # Bucket per current per-agent context if set
  if [ -n "${DOCTOR_CURRENT_AGENT:-}" ]; then
    DOCTOR_AGENT_RECORDS+=("${record}")
  else
    DOCTOR_RECORDS+=("${record}")
  fi
}
```

### A.2 — `--json` flag handling in `cmd_doctor`

Add `--json` to the existing flag parser. Validate incompatibility with `--fix` and `--fix-setup`.

```bash
cmd_doctor() {
  local fix=false
  local auto_yes=false
  local fix_setup=false
  local json_mode=false  # D.0a

  for arg in "$@"; do
    case "$arg" in
      --fix-setup) fix_setup=true ;;
      --fix) fix=true ;;
      --yes|-y) auto_yes=true ;;
      --json) json_mode=true ;;  # D.0a
      *) error "Unknown flag: $arg"; return 1 ;;
    esac
  done

  # D.0a — --json incompatible with mutating flags
  if [ "$json_mode" = true ] && { [ "$fix" = true ] || [ "$fix_setup" = true ]; }; then
    echo "Error: --json cannot be combined with --fix or --fix-setup" >&2
    return 2
  fi

  # D.0a — initialize JSON buffers (always, cheap)
  DOCTOR_RECORDS=()
  DOCTOR_AGENTS=()
  DOCTOR_AGENT_RECORDS=()
  DOCTOR_CURRENT_AGENT=""

  # D.0a — in JSON mode, redirect text to /dev/null but keep exec resolution
  if [ "$json_mode" = true ]; then
    exec 3>&1  # save stdout
    exec 1>/dev/null
  fi

  # ... existing function body unchanged ...
```

### A.3 — Instrumentation insertions (top-level checks)

After EACH existing check's status is emitted (the printf+echo block), insert a single `_doctor_record` call. Worker inserts ALL of the following — order matches the existing text-mode flow.

**The insertions (representative — Bob inserts the matching ones for each existing check):**

```bash
# 0a. Hive version
printf "  %-35s" "Hive version"
echo -e "${GREEN}OK${RESET} (v$(get_version))"
_doctor_record "hive-version" "Hive version" "core" "pass" "v$(get_version)" ""  # D.0a

# 0b. Up to date with origin/main
printf "  %-35s" "Up to date with origin/main"
if (cd "$HIVE_ROOT" && git fetch origin main 2>/dev/null); then
  local behind
  behind=$(cd "$HIVE_ROOT" && git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
  if [ "$behind" = "0" ]; then
    echo -e "${GREEN}OK${RESET}"
    _doctor_record "up-to-date-with-origin" "Up to date with origin/main" "core" "pass" "" ""  # D.0a
  elif [ "$behind" = "?" ]; then
    echo -e "${YELLOW}WARN${RESET} (couldn't determine)"
    _doctor_record "up-to-date-with-origin" "Up to date with origin/main" "core" "warn" "couldn't determine" ""  # D.0a
  else
    echo -e "${YELLOW}WARN${RESET} (behind by $behind commit(s) — run 'hive update --check')"
    _doctor_record "up-to-date-with-origin" "Up to date with origin/main" "core" "warn" "behind by $behind commit(s)" "hive update --check"  # D.0a
  fi
else
  echo -e "${YELLOW}WARN${RESET} (offline / no git remote access)"
  _doctor_record "up-to-date-with-origin" "Up to date with origin/main" "core" "warn" "offline / no git remote access" ""  # D.0a
fi

# 1. Node.js installed → _doctor_record id="node-installed" category="deps"
# 2. PM2 installed → id="pm2-installed" category="deps"
# 3. Claude CLI installed → id="claude-cli-installed" category="deps"
# 4. Claude CLI authenticated → id="claude-cli-authenticated" category="auth"
# 4a. Claude auth type → id="claude-auth-type" category="auth"
# 4b. ANTHROPIC_API_KEY conflict → id="anthropic-api-key-conflict" category="auth"
# 5. TypeScript compiled → id="typescript-compiled" category="build"
# 6. Build current → id="build-current" category="build" (status="skip" if no build to check)
# 7. .env exists → id="env-file-exists" category="config"
# 8. DISCORD_OWNER_ID set → id="discord-owner-id-set" category="config"
# 9. Install dir in allowed_paths → id="install-dir-allowed-paths" category="config"
```

**Locked id list (top-level checks):** Worker uses these exact IDs verbatim. The dashboard frontend will route per-id rendering, so name stability matters.

### A.4 — Per-agent instrumentation

Per-agent checks live inside the `for agent in $(list_agents); do ... done` loop. Strategy:
- At loop iteration entry, set `DOCTOR_CURRENT_AGENT="$agent"` and reset `DOCTOR_AGENT_RECORDS=()`
- Inside the loop body, every `_doctor_record` call buckets into `DOCTOR_AGENT_RECORDS` (per A.1's branch)
- At loop iteration exit, append a per-agent envelope to `DOCTOR_AGENTS` array, computing the per-agent rollup status

```bash
for agent in $(list_agents); do
  echo ""
  echo -e "  ${CYAN}$agent${RESET}"

  # D.0a — start per-agent record bucket
  DOCTOR_CURRENT_AGENT="$agent"
  DOCTOR_AGENT_RECORDS=()

  # ... existing per-agent checks unchanged, each followed by _doctor_record ...
  # bot-token → id="bot-token" category="agent"
  # behavior-directory → id="behavior-directory" category="agent"
  # required-file-IDENTITY-md → id="behavior-file-identity" category="agent"
  # required-file-CRITICAL-RULES-md → id="behavior-file-critical-rules" category="agent"
  # required-file-AGENTS-md → id="behavior-file-agents" category="agent"
  # required-file-SOUL-md → id="behavior-file-soul" category="agent"
  # required-file-TOOLS-md → id="behavior-file-tools" category="agent"
  # advisory-LESSONS-md → id="behavior-file-lessons" category="agent" (status=warn if missing, "INFO (optional)")
  # advisory-MEMORY-md → id="behavior-file-memory" category="agent"
  # memory-directory → id="memory-directory" category="agent"
  # pm2-process → id="pm2-process" category="agent"

  # D.0a — close out per-agent envelope
  local agent_status="pass"
  for record in "${DOCTOR_AGENT_RECORDS[@]}"; do
    local rstatus
    rstatus=$(echo "$record" | jq -r '.status')
    case "$rstatus" in
      fail) agent_status="fail"; break ;;
      warn) [ "$agent_status" = "pass" ] && agent_status="warn" ;;
    esac
  done

  local agent_envelope
  agent_envelope=$(jq -n -c \
    --arg name "$agent" \
    --arg status "$agent_status" \
    --argjson checks "$(printf '%s\n' "${DOCTOR_AGENT_RECORDS[@]}" | jq -s '.')" \
    '{name: $name, status: $status, checks: $checks}')
  DOCTOR_AGENTS+=("$agent_envelope")

  DOCTOR_CURRENT_AGENT=""
done
```

### A.5 — Strategic checks instrumentation

The Strategic Checks section (S1 fleet-drift, S2 runner-drift, S3+) gets `_doctor_record` calls with `category="strategic"`. IDs locked:
- S1 fleet → `fleet-drift`
- S2 runner → `runner-drift`
- S3+ → worker captures the exact id from the existing label, kebab-cased

(Worker reads through the rest of `cmd_doctor` and instruments every remaining check the same way. Each check gets exactly one `_doctor_record` call.)

### A.6 — `_doctor_emit_json_envelope` + emit at end of `cmd_doctor`

After all checks complete and BEFORE the existing text-mode trailing summary block, emit the JSON envelope (in `--json` mode only):

```bash
_doctor_emit_json_envelope() {
  local exit_code="$1"
  local total=${#DOCTOR_RECORDS[@]}
  local pass_count=0 warn_count=0 fail_count=0 skip_count=0

  for record in "${DOCTOR_RECORDS[@]}"; do
    local rstatus
    rstatus=$(echo "$record" | jq -r '.status')
    case "$rstatus" in
      pass) pass_count=$((pass_count + 1)) ;;
      warn) warn_count=$((warn_count + 1)) ;;
      fail) fail_count=$((fail_count + 1)) ;;
      skip) skip_count=$((skip_count + 1)) ;;
    esac
  done

  # Include per-agent records in the totals as well
  for agent_env in "${DOCTOR_AGENTS[@]}"; do
    local count
    count=$(echo "$agent_env" | jq '.checks | length')
    local apass awarn afail askip
    apass=$(echo "$agent_env" | jq '[.checks[] | select(.status == "pass")] | length')
    awarn=$(echo "$agent_env" | jq '[.checks[] | select(.status == "warn")] | length')
    afail=$(echo "$agent_env" | jq '[.checks[] | select(.status == "fail")] | length')
    askip=$(echo "$agent_env" | jq '[.checks[] | select(.status == "skip")] | length')
    total=$((total + count))
    pass_count=$((pass_count + apass))
    warn_count=$((warn_count + awarn))
    fail_count=$((fail_count + afail))
    skip_count=$((skip_count + askip))
  done

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local checks_json agents_json
  checks_json=$(printf '%s\n' "${DOCTOR_RECORDS[@]}" | jq -s '.')
  agents_json=$(printf '%s\n' "${DOCTOR_AGENTS[@]}" | jq -s '.')

  jq -n -c \
    --arg ts "$ts" \
    --argjson summary "$(jq -n \
      --argjson total "$total" --argjson pass "$pass_count" \
      --argjson warn "$warn_count" --argjson fail "$fail_count" \
      --argjson skip "$skip_count" --argjson exit_code "$exit_code" \
      '{total: $total, pass: $pass, warn: $warn, fail: $fail, skip: $skip, exit_code: $exit_code}')" \
    --argjson checks "$checks_json" \
    --argjson agents "$agents_json" \
    '{
       version: "1",
       ts: $ts,
       summary: $summary,
       checks: $checks,
       agents: $agents
     }'
}
```

At the very end of `cmd_doctor`, before `return $?`:

```bash
  # D.0a — emit JSON envelope and restore stdout if --json was set
  local final_exit=0
  [ "$issues" -gt 0 ] && final_exit=1

  if [ "$json_mode" = true ]; then
    exec 1>&3  # restore stdout
    exec 3>&-
    _doctor_emit_json_envelope "$final_exit"
    return $final_exit
  fi

  # ... existing text-mode trailing summary unchanged ...
  return $final_exit
```

### A.7 — Comment block above `_doctor_record`

```bash
# v1.5.0 D.0a — structured doctor output for dashboard consumption.
# `cmd_doctor --json` runs the same checks as text mode but additionally
# captures each check's outcome via _doctor_record into an in-memory buffer,
# then emits a JSON envelope to stdout instead of the trailing text summary.
#
# Locked envelope shape: see docs/v1.5.0-tasks/D.0a-doctor-json.md §Goal.
# Locked status enum: pass | warn | fail | skip
# Locked category enum: core | deps | auth | build | config | agent | strategic
#
# Existing text rendering is unchanged — _doctor_record runs in parallel,
# called immediately after the printf/echo block so both modes always agree.
#
# `--json` is incompatible with `--fix` and `--fix-setup` (returns 2).
```

---

## B. Tests (sandbox-isolated where applicable)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Expected: zero new warnings vs C.7 baseline
```

### B.2 — `_doctor_record` unit tests

```bash
# Test the helper in isolation
bash -c '
  source ~/neato-hive/bin/hive
  DOCTOR_RECORDS=()
  DOCTOR_AGENT_RECORDS=()
  DOCTOR_CURRENT_AGENT=""

  _doctor_record "test-1" "Test 1" "core" "pass" "all good" ""
  _doctor_record "test-2" "Test 2" "deps" "fail" "missing tool" "install with brew"
  _doctor_record "test-3" "Test 3" "auth" "warn" "" ""
  _doctor_record "test-4" "Test 4" "build" "skip" "" ""

  # Bad status falls back to warn
  _doctor_record "test-5" "Test 5" "config" "exploded" "what" "" 2>/dev/null

  echo "=== Records ==="
  printf "%s\n" "${DOCTOR_RECORDS[@]}" | jq -c .
'
# Expected: 5 records, last one has status="warn" (fallback)
# detail: empty strings emit as null

# Per-agent bucket test
bash -c '
  source ~/neato-hive/bin/hive
  DOCTOR_RECORDS=()
  DOCTOR_AGENT_RECORDS=()
  DOCTOR_CURRENT_AGENT="atlas"

  _doctor_record "bot-token" "Bot token" "agent" "pass" "" ""
  _doctor_record "behavior-directory" "Behavior directory" "agent" "fail" "" ""

  echo "=== Agent records (DOCTOR_AGENT_RECORDS) ==="
  printf "%s\n" "${DOCTOR_AGENT_RECORDS[@]}" | jq -c .
  echo "=== Top-level (DOCTOR_RECORDS, should be empty) ==="
  printf "%s\n" "${DOCTOR_RECORDS[@]}" | wc -l
'
# Expected: 2 records in DOCTOR_AGENT_RECORDS, 0 in DOCTOR_RECORDS
```

### B.3 — `cmd_doctor --json` smoke test (worker's actual install)

```bash
# Run --json against worker's install. Capture, parse, validate shape.
hive doctor --json > /tmp/D0a-doctor.json 2> /tmp/D0a-doctor.err
RC=$?
echo "Exit code: $RC"

# Validate JSON parses
jq empty < /tmp/D0a-doctor.json && echo "B.3: valid JSON ✓"

# Required top-level keys
jq -r 'keys | sort | join(",")' < /tmp/D0a-doctor.json
# Expected: "agents,checks,summary,ts,version"

# Version locked at "1"
test "$(jq -r .version < /tmp/D0a-doctor.json)" = "1" && echo "B.3: version=1 ✓"

# Summary shape
jq '.summary | keys | sort | join(",")' < /tmp/D0a-doctor.json
# Expected: "exit_code,fail,pass,skip,total,warn"

# Locked check IDs present (spot-check core ones)
for id in hive-version up-to-date-with-origin node-installed pm2-installed claude-cli-installed env-file-exists discord-owner-id-set install-dir-allowed-paths; do
  if jq -e --arg id "$id" 'any(.checks[]; .id == $id)' < /tmp/D0a-doctor.json > /dev/null; then
    echo "B.3: check id '$id' present ✓"
  else
    echo "B.3: FAIL — check id '$id' missing"; exit 1
  fi
done

# Status enum locked
jq -r '.checks[].status' < /tmp/D0a-doctor.json | sort -u
# Expected: subset of pass, warn, fail, skip — no other values

# Category enum locked
jq -r '.checks[].category' < /tmp/D0a-doctor.json | sort -u
# Expected: subset of core, deps, auth, build, config, strategic

# Per-agent envelope shape
jq '.agents[0] | keys | sort | join(",")' < /tmp/D0a-doctor.json
# Expected: "checks,name,status"

# Per-agent check category
jq -r '.agents[0].checks[0].category' < /tmp/D0a-doctor.json
# Expected: "agent"

# stderr is empty (no warnings, no errors leaked through redirection)
test ! -s /tmp/D0a-doctor.err && echo "B.3: stderr clean ✓" \
  || { echo "B.3: WARN — stderr non-empty"; cat /tmp/D0a-doctor.err; }

# Cleanup
rm -f /tmp/D0a-doctor.json /tmp/D0a-doctor.err
```

### B.4 — Text mode unchanged (regression gate)

```bash
# Capture text-mode output before D.0a (from main HEAD pre-merge — SKIP if can't get)
# Actually: just confirm text-mode output is non-trivial and DOES NOT contain JSON
hive doctor > /tmp/D0a-text.out 2>/tmp/D0a-text.err
RC=$?
echo "Text-mode exit code: $RC"

# Must contain at least one expected text-mode label
grep -E '\bHive Doctor\b' /tmp/D0a-text.out > /dev/null && echo "B.4: text header present ✓"
grep -E '^\s+Hive version\s+' /tmp/D0a-text.out > /dev/null && echo "B.4: text-mode check rendering preserved ✓"

# Must NOT contain JSON envelope (no leaked --json output)
grep -qE '"version":\s*"1"' /tmp/D0a-text.out && { echo "B.4: FAIL — JSON leaked into text mode"; exit 1; }
echo "B.4: no JSON in text output ✓"

# Cleanup
rm -f /tmp/D0a-text.out /tmp/D0a-text.err
```

### B.5 — `--json --fix` rejection

```bash
hive doctor --json --fix 2>/tmp/D0a-conflict.err
RC=$?
echo "Exit code: $RC (expected 2)"
test "$RC" = "2" && echo "B.5: rejected with rc=2 ✓"
grep -E '\-\-json cannot be combined with \-\-fix' /tmp/D0a-conflict.err && echo "B.5: error message correct ✓"

hive doctor --json --fix-setup 2>/tmp/D0a-conflict2.err
RC=$?
test "$RC" = "2" && echo "B.5: --fix-setup also rejected ✓"

# Cleanup
rm -f /tmp/D0a-conflict.err /tmp/D0a-conflict2.err
```

### B.6 — Exit code parity (text mode vs JSON mode)

```bash
hive doctor > /dev/null 2>&1
TEXT_RC=$?
hive doctor --json > /dev/null 2>&1
JSON_RC=$?
echo "Text rc: $TEXT_RC, JSON rc: $JSON_RC"
test "$TEXT_RC" = "$JSON_RC" && echo "B.6: exit codes parity ✓" \
  || { echo "B.6: FAIL — text rc=$TEXT_RC, json rc=$JSON_RC"; exit 1; }

# Verify summary.exit_code matches process exit
hive doctor --json > /tmp/D0a-rc.json 2>/dev/null
PROC_RC=$?
SUM_RC=$(jq -r '.summary.exit_code' < /tmp/D0a-rc.json)
test "$PROC_RC" = "$SUM_RC" && echo "B.6: summary.exit_code matches process rc ✓"

rm -f /tmp/D0a-rc.json
```

### B.7 — Status enum mapping spot-checks

```bash
# Run --json and confirm at least one of each status enum value appears (or skip if N/A)
hive doctor --json > /tmp/D0a-statuses.json 2>/dev/null

# At minimum, expect pass to appear (most installs have several pass checks)
jq -e '[.checks[] | select(.status == "pass")] | length > 0' < /tmp/D0a-statuses.json > /dev/null \
  && echo "B.7: at least one pass ✓"

# All status values are in the locked enum
jq -r '.checks[].status' < /tmp/D0a-statuses.json | sort -u | while read -r s; do
  case "$s" in
    pass|warn|fail|skip) echo "B.7: status '$s' is in enum ✓" ;;
    *) echo "B.7: FAIL — status '$s' is NOT in locked enum"; exit 1 ;;
  esac
done

rm -f /tmp/D0a-statuses.json
```

### B.8 — Logic preservation gate

```bash
# Diff inspection: the only allowed additions are the new helpers, the JSON-mode flag
# parser branch, and the _doctor_record / _doctor_emit_json_envelope insertions.
# Existing text-rendering printf/echo lines should NOT have been deleted or modified.

git diff main...feat/v1.5.0-D.0a-doctor-json -- bin/hive \
  | grep -E '^\-' \
  | grep -vE '^\-\-\-' \
  | head -30

# Expected: empty (or only whitespace-only line removals if shellfmt nudged formatting).
# Worker captures verbatim; if any actual logic line was REMOVED (a printf, an echo with
# status-label, a status-determining if/elif), HALT and report.
```

### B.9 — Cleanup

```bash
rm -f /tmp/D0a-*.json /tmp/D0a-*.err /tmp/D0a-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: ONLY `bin/hive` (1 file)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` zero new warnings vs C.7 baseline
- [ ] B.2 unit tests: `_doctor_record` populates `DOCTOR_RECORDS` / `DOCTOR_AGENT_RECORDS` correctly; bad status falls back to `warn` with stderr warning
- [ ] B.3 smoke test: `hive doctor --json` parses as valid JSON; envelope has `version`, `ts`, `summary`, `checks`, `agents` keys; `version` = `"1"`; locked check IDs present; status + category enums respected; stderr empty
- [ ] B.4 regression gate: `hive doctor` (no flag) text output still includes `Hive Doctor` header and per-check rendering; NO JSON appears in text output
- [ ] B.5 rejection: `--json --fix` and `--json --fix-setup` both return exit 2 with stderr message
- [ ] B.6 exit-code parity: text mode and JSON mode return the same process exit code; `summary.exit_code` matches process exit
- [ ] B.7 status enum: every emitted `.status` is in `pass|warn|fail|skip`
- [ ] B.8 logic preservation: diff-grep shows ZERO line removals (only additions). Existing text-mode rendering preserved verbatim
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.2-B.8 outputs verbatim, shellcheck delta, diff-lock confirmation, "live install untouched" verification, locked envelope sample (one full JSON output redacted of any tokens/secrets)

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)
Branch: feat/v1.5.0-D.0a-doctor-json

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. cmd_doctor body present: ✓ (line count: <N>)
  3. _doctor_record / _doctor_emit_json_envelope absent: ✓
  4. status-label inventory: <captured set, all in enum>
  5. flag parser shape: <captured>
  6. tooling: jq ✓ printf ✓ date ✓

Tooling check:
  bash -n: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 _doctor_record units:
    - 5 records appended to DOCTOR_RECORDS ✓
    - Bad status falls back to warn ✓
    - Per-agent bucket isolates correctly ✓
  B.3 cmd_doctor --json smoke:
    - valid JSON ✓
    - top-level keys: agents,checks,summary,ts,version ✓
    - version=1 ✓
    - summary shape correct ✓
    - 8 locked check IDs present ✓
    - status enum: <captured, subset of pass|warn|fail|skip> ✓
    - category enum: <captured, subset of core|deps|auth|build|config|agent|strategic> ✓
    - per-agent envelope shape correct ✓
    - stderr clean ✓
  B.4 text mode regression:
    - text-mode header + per-check rendering preserved ✓
    - no JSON leaked into text output ✓
  B.5 conflict rejection:
    - --json --fix → rc=2 ✓
    - --json --fix-setup → rc=2 ✓
  B.6 exit-code parity:
    - text rc == json rc: ✓
    - summary.exit_code matches process rc ✓
  B.7 status enum:
    - all emitted statuses in enum ✓
  B.8 logic preservation:
    - zero line removals in diff (only additions) ✓

Sample envelope (redacted):
  <one full JSON output from `hive doctor --json` on worker's install,
   secrets/tokens redacted manually>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-D.0a-doctor-json
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full structured envelope + every existing check instrumented in single PR. No "instrument the rest in a follow-up."
- **DO NOT MERGE** — house-md
- **DO NOT MODIFY EXISTING TEXT-MODE RENDERING** — every printf/echo block in `cmd_doctor` stays byte-identical. Only ADDITIONS allowed (the `_doctor_record` calls + flag parser branch + envelope emit). B.8 enforces.
- **DO NOT EXTEND THE STATUS ENUM** — locked at `pass|warn|fail|skip`. New status values require a `version: "2"` bump in a future leaf. D.0a is `version: "1"`.
- **DO NOT EXTEND THE CATEGORY ENUM** — locked at the 7 values. Future categories require explicit spec amendment.
- **`--json` IS READ-ONLY** — incompatible with `--fix` and `--fix-setup`; rejection at flag-parse time with rc=2.
- **`_doctor_record` USES `jq -n` FOR ESCAPING** — never string-concat user-provided detail/fix-hint into JSON output.
- **HALT-and-ping rule** — pre-flight surprises (existing helpers present, status labels unmapped, cmd_doctor body shape unexpected) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — agents/, runtime, data/, docs/TASK.md drift OK pre-flight.
- **No new shell-tool deps** — jq + printf + date + standard. Wizard-dep-rule clean.

---

## F. Forward links

- **D.1** — Express skeleton + token auth middleware. Independent of D.0a (no schema dependency).
- **D.3** — Doctor endpoint at `/api/doctor` returns the JSON envelope verbatim. Optionally caches with short TTL (1-2s) since checks themselves are slow (network + PM2 jlist + git fetch).
- **E.x** — Frontend Doctor page consumes the envelope directly. Renders by `category` (grouped sections), per-check rendering keyed by stable `id`. Per-agent rollup status drives the agents section.
- **Future:** `version: "2"` if the schema gains a 5th status, a new top-level key (e.g. `recommendations`), or a category-renaming change. Stable `id` strings are the most-stable contract — never rename, only add new ones.
