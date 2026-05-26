# v1.5.0 D-followup — Auto-generate `HIVE_DASHBOARD_TOKEN` in `cmd_bootstrap`

**Status:** LOCKED — house-md dispatches Bob via fresh-turn cron once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** D-followup (additive Phase D leaf, after D.4 closure)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** Phase D complete (D.0a/D.1/D.2/D.3/D.4 all merged)
**Parallel:** Independent of E.1 (different file scope: `bin/hive` vs `dashboard/`). Both can dispatch separately.

---

## Goal

Owner ran `pm2 startOrReload ecosystem.config.cjs && pm2 save` against a v1.4.x install (post-D.1, pre-v1.5.0-tarball). The dashboard process started with no `HIVE_DASHBOARD_TOKEN` in `.env` → D.1's fail-loud guard fired (process exits 1) → PM2 autorestart loop until `max_restarts: 10` exhausted → every authed endpoint 401s.

**Owner directive 2026-05-07:** *"the token should be auto-generated and things should just work functionally no matter what."*

This leaf hooks token auto-generation into `cmd_bootstrap` (the v1.4.9 self-healing entry point) so any path that reaches bootstrap — manual `hive bootstrap`, post-install setup wizard, future fresh-installer flows — auto-ensures the dashboard token exists before PM2 starts the dashboard process.

**Why bootstrap is the right hook:**
- It's already the v1.4.9 self-healing entry. Anyone with a broken/incomplete Hive runs `hive bootstrap` to fix it.
- Fresh-install setup wizards call `hive bootstrap` post-install (per the existing setup.sh design).
- C.7's first-run migration will continue to handle the v1.4.x → v1.5.0 update path (it generates the token via the migration handler). This leaf covers the **bootstrap-without-update path** that C.7 doesn't reach.
- One change here covers all bootstrap paths.

**Why not relax D.1's "exit 1 on missing token" guard:** considered + rejected. That would let the dashboard come up with NO auth, which is a worse failure mode than a 401-loop. **Fail-loud-but-fixable beats fail-soft-but-insecure.** Bootstrap auto-generates → dashboard always has a real token → security model preserved.

---

## Architectural givens

### Insertion order: ensure-token BEFORE `pm2 startOrReload`

The fix MUST insert `_dashboard_ensure_token` **before** the existing `pm2 startOrReload ecosystem.config.cjs --update-env` call in `cmd_bootstrap`. Rationale:

- If ensure-token runs **before**: token is in `.env` → pm2 starts hive-dashboard fresh → dashboard's dotenv reads `.env` → token present → boots clean. No restart loop. No PM2 thrashing.
- If ensure-token runs **after**: pm2 starts hive-dashboard with no token → process exits 1 → autorestart loop consumes some of the `max_restarts: 10` budget. Then ensure-token runs. Then we'd need `pm2 restart hive-dashboard` to reboot it cleanly. Two-step recovery, more surface area, more chances to fail. Strictly worse.

Going with **before**. Single-step recovery.

### Helper extraction: `_dashboard_ensure_token`

D.4's `_dashboard_print_token` already does the right thing for the user-facing `hive dashboard token` CLI: idempotent generate-if-missing + print + info banner. But that helper has TWO behaviors — generation AND user-facing output (echo of token + info banner suggesting `pm2 restart hive-dashboard`).

For the bootstrap path, we want **only the generation behavior** — no echo (security: bootstrap output may be in logs, terminal scrollback, log shipping pipelines), no info banner (we're about to start the dashboard fresh, not asking the user to restart it manually).

Refactor approach: extract the silent token-ensure logic into a new helper `_dashboard_ensure_token`, then have D.4's `_dashboard_print_token` delegate to it.

```bash
_dashboard_ensure_token() {
  local env_file
  env_file="$(_dashboard_env_file)"

  # Idempotent: if token already present, no-op
  if [ -f "${env_file}" ] && grep -qE '^HIVE_DASHBOARD_TOKEN=' "${env_file}"; then
    return 0
  fi

  # Ensure .env exists
  if [ ! -f "${env_file}" ]; then
    touch "${env_file}"
  fi

  # Generate via openssl rand -hex 32 (locked from C.7)
  local token
  if ! token="$(openssl rand -hex 32 2>/dev/null)" || [ -z "${token}" ]; then
    error "openssl rand -hex 32 failed — cannot ensure dashboard token"
    return 1
  fi

  # Append on its own line, never modify existing lines
  printf '\nHIVE_DASHBOARD_TOKEN=%s\n' "${token}" >> "${env_file}"

  return 0
}
```

**Locked semantics:**
- **Silent** — no `echo`, no `info`, no `warn`. Errors only on hard failure (openssl absent / .env unwriteable). The only output is the bootstrap caller's own banner about what happened.
- **Idempotent** — if token already present, no-op. Re-running bootstrap with token present writes nothing.
- **No duplicate lines** — the `grep -qE` check guards against appending a second `HIVE_DASHBOARD_TOKEN=` line on subsequent runs.
- **Token never appears in stdout, stderr, or any log line** — this is the security hardening over D.4's helper.

### `_dashboard_print_token` refactor (D.4 carry-over)

Update D.4's `_dashboard_print_token` to delegate to `_dashboard_ensure_token`:

```bash
_dashboard_print_token() {
  local env_file
  env_file="$(_dashboard_env_file)"

  # Already-present path: just print
  if [ -f "${env_file}" ] && grep -qE '^HIVE_DASHBOARD_TOKEN=' "${env_file}"; then
    grep -E '^HIVE_DASHBOARD_TOKEN=' "${env_file}" | head -1 | sed 's/^HIVE_DASHBOARD_TOKEN=//'
    return 0
  fi

  # Generate via the silent helper
  if ! _dashboard_ensure_token; then
    return 1
  fi

  # Read back + print (single source of truth for the token bytes)
  grep -E '^HIVE_DASHBOARD_TOKEN=' "${env_file}" | head -1 | sed 's/^HIVE_DASHBOARD_TOKEN=//'
  echo ""
  info "Token added to ${env_file}."
  info "Run 'pm2 restart hive-dashboard' to apply (the dashboard process must restart to read the new env var)."
  return 0
}
```

**Locked semantics:**
- The user-facing CLI behavior (`hive dashboard token`) is **unchanged from D.4**. Same stdout output, same info banner, same exit codes. Pure refactor.
- The token-generation logic is now centralized in `_dashboard_ensure_token` so future leaves can reuse it.
- `_dashboard_rotate_token` (D.4) stays as-is — it's deliberately destructive (replaces, doesn't ensure-or-no-op). Different concern, separate codepath.

### `cmd_bootstrap` modification

Insert `_dashboard_ensure_token` BEFORE the existing `pm2 startOrReload ecosystem.config.cjs --update-env` block:

```bash
cmd_bootstrap() {
  cd "$HIVE_ROOT" || exit 1

  # v1.5.0 D-followup — ensure HIVE_DASHBOARD_TOKEN exists in .env BEFORE
  # starting/reloading PM2 daemons. Without this, hive-dashboard would boot
  # with no token in env, hit D.1's fail-loud guard, exit 1, and consume
  # the autorestart budget. Inserting before pm2 startOrReload means the
  # dashboard sees the token on its first boot.
  if ! _dashboard_ensure_token; then
    warn "Could not auto-ensure dashboard token. The dashboard will fail to start."
    warn "Manual recovery: run 'hive dashboard token' to set HIVE_DASHBOARD_TOKEN."
  fi

  # Reconcile ecosystem-defined daemons. startOrReload is idempotent —
  # starts new procs, reloads existing ones from latest config.
  if [ -f ecosystem.config.cjs ]; then
    info "Bootstrapping ecosystem-defined daemons..."
    if pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null 2>&1; then
      pm2 save --force >/dev/null 2>&1
      success "Ecosystem daemons reconciled."
    else
      error "pm2 startOrReload ecosystem.config.cjs failed."
      error "Manual recovery: cd $HIVE_ROOT && pm2 startOrReload ecosystem.config.cjs && pm2 save"
      return 1
    fi
  else
    info "No ecosystem.config.cjs — skipping daemon reconcile."
  fi

  # Future hooks: bootstrap any other framework-required state here.
  return 0
}
```

**Locked semantics:**
- Single new call (`_dashboard_ensure_token`) before the existing pm2 block. No reordering of any existing lines.
- Failure-tolerant: if `_dashboard_ensure_token` returns 1 (openssl absent on bootstrap host?), we `warn` and proceed. Bootstrap should never hard-fail because a security-side dependency is missing — the dashboard simply won't boot, and the user gets a clear recovery message.
- The existing `pm2 startOrReload` block is byte-identical. No edits.
- `pm2 startOrReload --update-env` already does the right thing for the freshly-written `.env` — when the dashboard process starts, dotenv reads `.env` at boot time and finds the token.

### PM2 ban (still applies)

D.x's PM2-ban rule is **for worker test code, not production code**. `cmd_bootstrap` IS production code by design — it's the recovery/setup path that runs `pm2 startOrReload` already. This leaf adds zero new PM2 verbs to `cmd_bootstrap` (the existing `startOrReload` covers it). Worker tests for `_dashboard_ensure_token` use TMPDIR-isolated `.env` files; no PM2 invocations from test scope.

§B grep gate enforces: any `+` line in the diff that adds a `pm2 (start|restart|reload|delete|save|kill|stop)` verb that's NOT already in cmd_bootstrap's existing block triggers HALT. The new code adds zero PM2 verbs.

---

## Pre-conditions

- Phase D complete: D.0a (`693f24b`), D.1 (`9ca2824`), D.2 (`6a5581e`), D.3 (`ea96618`), D.4 (`31d2ea6`) all merged
- `_dashboard_env_file`, `_dashboard_print_token`, `_dashboard_rotate_token`, `cmd_dashboard` from D.4 all present in `bin/hive` (verified at lines 2860, 2864, 2891, 2930 on current main)
- `cmd_bootstrap` present at line 1747 with current shape (8-line body — single pm2 startOrReload + save block)
- `_dashboard_ensure_token` not yet defined
- `openssl` available (carried from C.7 + D.4)

---

## Where state lives

**Modified file (1):** `bin/hive`

- New helper inserted: `_dashboard_ensure_token` (positioned alongside `_dashboard_env_file` / `_dashboard_print_token` for cohesion — likely between lines 2860 and 2864 OR between 2862 and 2864)
- `_dashboard_print_token` body refactored to delegate to `_dashboard_ensure_token`
- `cmd_bootstrap` body adds 1 new `if ! _dashboard_ensure_token` block + 4-line warn fallback BEFORE the existing pm2 startOrReload block

**Total: 1 path. Diff lock: `bin/hive` only.**

**Estimated diff size:** ~25-35 net additions (15 for `_dashboard_ensure_token`, ~5 net change in `_dashboard_print_token` from refactor, ~5 in `cmd_bootstrap`).

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body)

### 1. Framework repo current state (post-Phase D)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `31d2ea6` (D.4 merge) + post-D spec commits. **HALT and ping house-md** if Phase D incomplete.

### 2. D.4 dashboard helpers present

```bash
grep -nE '^_dashboard_(env_file|print_token|rotate_token)\(\)|^cmd_dashboard\(\)' bin/hive | head -10
```

Expected: 4 matches at lines `2860, 2864, 2891, 2930` (or close — line numbers may have drifted since spec was written). **HALT and ping house-md** if any helper is missing or shape is unrecognizable.

### 3. `_dashboard_ensure_token` does NOT yet exist

```bash
grep -nE '^_dashboard_ensure_token\(\)' bin/hive
```

Expected: empty. **HALT and ping house-md** if the helper exists.

### 4. `cmd_bootstrap` body shape unchanged

```bash
sed -n '/^cmd_bootstrap\(\) {/,/^}/p' bin/hive
```

Expected: single pm2 startOrReload + pm2 save block + return 0 + future-hooks comment. Body length should be ~25 lines. **HALT and ping house-md** if the body has been amended in unexpected ways (e.g. additional pm2 verbs, additional helper calls).

### 5. Tooling

```bash
which openssl && which grep && which sed
```

Expected: all present. `openssl` is the carried dependency from C.7 + D.4.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-D-followup-bootstrap-auto-token`.

**Diff lock: 1 path (`bin/hive`).**

### A.1 — `_dashboard_ensure_token` new helper

Per the §Architectural givens block. Locked location: alongside the existing `_dashboard_*` helpers (between `_dashboard_env_file` and `_dashboard_print_token`, OR immediately before `_dashboard_print_token`). Worker picks the cohesive insertion point.

### A.2 — `_dashboard_print_token` refactor

Replace D.4's body with the delegating version per §Architectural givens. **User-facing CLI behavior is unchanged byte-for-byte:**
- Same stdout: token bytes on the first line, blank line on the second, info banner on the third+.
- Same exit codes: 0 on success, 1 on openssl failure.
- Same idempotency: existing-token path doesn't generate.

§B.4 hard gate verifies the CLI behavior is preserved by sandboxed comparison.

### A.3 — `cmd_bootstrap` insertion

Per the §Architectural givens block. Single new `if ! _dashboard_ensure_token` block + warn fallback inserted BEFORE the existing pm2 startOrReload block. The pm2 block itself is byte-identical.

### A.4 — Brief comment block above `_dashboard_ensure_token`

```bash
# v1.5.0 D-followup — silent token-ensure helper. Used by:
#   - cmd_bootstrap (auto-generates if missing, before pm2 startOrReload)
#   - _dashboard_print_token (delegates to this for the generate path)
#
# Idempotent: no-op when token already present in .env.
# Silent: no echo, no info, no warn on success. Token never written to stdout/logs.
# Returns 0 on success (already present OR newly generated), 1 on openssl failure.
#
# See docs/v1.5.0-tasks/D-followup-bootstrap-auto-token.md for full contract.
```

---

## B. Tests (sandbox-isolated where applicable)

### B.1 — Bash syntax + shellcheck delta

```bash
bash -n bin/hive && echo "bash -n: ✓"
shellcheck -x bin/hive 2>&1 | tail -20
# Expected: zero new warnings vs D.4 baseline
```

### B.2 — `_dashboard_ensure_token` unit tests

```bash
TMPDIR=$(mktemp -d)
TMPENV="${TMPDIR}/.env"

# B.2.a — token absent: helper generates, no stdout
HIVE_INSTALL_ROOT="${TMPDIR}" bash -c '
  source ~/neato-hive/bin/hive
  _dashboard_ensure_token
' > /tmp/D-followup-b2a.out 2>&1
RC=$?
test "$RC" = "0" && echo "B.2.a: rc=0 ✓"
test ! -s /tmp/D-followup-b2a.out && echo "B.2.a: silent (no stdout/stderr) ✓"
grep -qE '^HIVE_DASHBOARD_TOKEN=[a-f0-9]{64}$' "${TMPENV}" && echo "B.2.a: 64-hex token in .env ✓"

# B.2.b — idempotent: re-run with token present is no-op
TOKEN_BEFORE=$(grep -E '^HIVE_DASHBOARD_TOKEN=' "${TMPENV}" | head -1)
HIVE_INSTALL_ROOT="${TMPDIR}" bash -c '
  source ~/neato-hive/bin/hive
  _dashboard_ensure_token
'
TOKEN_AFTER=$(grep -E '^HIVE_DASHBOARD_TOKEN=' "${TMPENV}" | head -1)
test "${TOKEN_BEFORE}" = "${TOKEN_AFTER}" && echo "B.2.b: token unchanged on second run ✓"

# B.2.c — no duplicate lines
test "$(grep -cE '^HIVE_DASHBOARD_TOKEN=' "${TMPENV}")" = "1" && echo "B.2.c: no duplicate token line ✓"

# B.2.d — token never appears in stdout/stderr
HIVE_INSTALL_ROOT="$(mktemp -d)" bash -c '
  source ~/neato-hive/bin/hive
  _dashboard_ensure_token
' 2>&1 | grep -qE '[a-f0-9]{64}' && echo "B.2.d: FAIL — token leaked to stdout/stderr" || echo "B.2.d: token NOT in output ✓"

rm -rf "${TMPDIR}"
```

### B.3 — `_dashboard_print_token` user-facing CLI behavior unchanged

```bash
TMPDIR=$(mktemp -d)
TMPENV="${TMPDIR}/.env"

# Existing-token path: print only, no info banner regenerated
echo 'HIVE_DASHBOARD_TOKEN=abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' > "${TMPENV}"
HIVE_INSTALL_ROOT="${TMPDIR}" bash bin/hive dashboard token > /tmp/D-followup-b3a.out 2>&1
RC=$?
test "$RC" = "0" && echo "B.3.a: rc=0 ✓"
TOKEN_LINE=$(head -1 /tmp/D-followup-b3a.out | tr -d '[:space:]')
test "${TOKEN_LINE}" = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" && echo "B.3.a: existing token printed verbatim ✓"

# Missing-token path: generate + print + info banner
TMPENV2="${TMPDIR}/.env-fresh"
HIVE_INSTALL_ROOT="$(dirname ${TMPENV2})" bash -c "
  rm -f '${TMPENV2}'
  bash ~/neato-hive/bin/hive dashboard token > /tmp/D-followup-b3b.out 2>&1
"
NEW_TOKEN=$(head -1 /tmp/D-followup-b3b.out | tr -d '[:space:]')
echo "${NEW_TOKEN}" | grep -qE '^[a-f0-9]{64}$' && echo "B.3.b: 64-hex token printed ✓"
grep -qE 'Token added to|pm2 restart hive-dashboard' /tmp/D-followup-b3b.out && echo "B.3.b: info banner present ✓"

rm -rf "${TMPDIR}" /tmp/D-followup-b3*.out
```

### B.4 — `_dashboard_print_token` byte-equivalence with D.4 baseline

```bash
# Snapshot the user-facing CLI output structure pre-merge (against current main)
# and post-refactor (against the worker branch). They must produce identical
# stdout shape (token line + blank line + info banner).

TMPDIR=$(mktemp -d)
HIVE_INSTALL_ROOT="${TMPDIR}" bash bin/hive dashboard token 2>&1 | tee /tmp/D-followup-b4-post.out

# Expected shape (validated by structure, not by token-content):
#   Line 1: 64 hex chars (the token)
#   Line 2: empty (the trailing echo "")
#   Line 3+: info messages

LINE_1=$(sed -n '1p' /tmp/D-followup-b4-post.out)
LINE_2=$(sed -n '2p' /tmp/D-followup-b4-post.out)
echo "${LINE_1}" | grep -qE '^[a-f0-9]{64}$' && echo "B.4: line 1 = 64-hex token ✓"
test -z "${LINE_2}" && echo "B.4: line 2 = empty ✓"
grep -qE 'Token added to|pm2 restart hive-dashboard' /tmp/D-followup-b4-post.out && echo "B.4: info banner present ✓"

rm -rf "${TMPDIR}" /tmp/D-followup-b4*.out
```

### B.5 — `cmd_bootstrap` insertion + behavior

```bash
TMPDIR=$(mktemp -d)
mkdir -p "${TMPDIR}/neato-hive"
# Empty .env in the install root
touch "${TMPDIR}/neato-hive/.env"

# Cannot run cmd_bootstrap end-to-end (it tries pm2 startOrReload). Instead,
# isolate the new insertion: source the helper and call it directly.
HIVE_INSTALL_ROOT="${TMPDIR}/neato-hive" bash -c '
  source ~/neato-hive/bin/hive
  _dashboard_ensure_token
'

grep -qE '^HIVE_DASHBOARD_TOKEN=[a-f0-9]{64}$' "${TMPDIR}/neato-hive/.env" \
  && echo "B.5: token populated by isolated ensure call ✓"

# Verify cmd_bootstrap itself contains the new ensure call BEFORE the pm2 block
sed -n '/^cmd_bootstrap\(\) {/,/^}/p' bin/hive | tee /tmp/D-followup-b5-cmd.out
grep -nE '_dashboard_ensure_token' /tmp/D-followup-b5-cmd.out | head -1
grep -nE 'pm2 startOrReload' /tmp/D-followup-b5-cmd.out | head -1
# Expected: the _dashboard_ensure_token line number is LESS than the pm2 startOrReload line number

ENSURE_LINE=$(grep -nE '_dashboard_ensure_token' /tmp/D-followup-b5-cmd.out | head -1 | cut -d: -f1)
PM2_LINE=$(grep -nE 'pm2 startOrReload' /tmp/D-followup-b5-cmd.out | head -1 | cut -d: -f1)
test "${ENSURE_LINE}" -lt "${PM2_LINE}" && echo "B.5: ensure-token call BEFORE pm2 startOrReload ✓"

rm -rf "${TMPDIR}" /tmp/D-followup-b5*.out
```

### B.6 — PM2 ban (worker scope)

```bash
# Confirm no NEW pm2 verbs added to bin/hive outside the existing cmd_bootstrap pm2 block
git diff main...feat/v1.5.0-D-followup-bootstrap-auto-token -- bin/hive \
  | grep -E '^\+' \
  | grep -E '\bpm2 (start|restart|reload|delete|save|stop|kill|startOrReload)\b' \
  | head -10
# Expected: empty (all PM2 verbs in the diff are unchanged context lines from cmd_bootstrap)
```

### B.7 — Logic preservation gate

```bash
# Diff inspection: existing _dashboard_print_token, cmd_bootstrap pm2 block,
# and other helpers should be byte-preserved aside from the locked refactor.

# Specifically:
#   - cmd_bootstrap's pm2 startOrReload + pm2 save + error/info/success messages: byte-identical
#   - _dashboard_rotate_token: untouched (D.4 lock)
#   - cmd_dashboard dispatcher: untouched (D.4 lock)
#   - _dashboard_env_file: untouched

git diff main...feat/v1.5.0-D-followup-bootstrap-auto-token -- bin/hive \
  | grep -E '^\-' \
  | grep -vE '^\-\-\-' \
  | head -40

# Worker captures verbatim. The only - lines should be inside the
# _dashboard_print_token body (the parts being replaced by the delegate
# version) AND inside cmd_bootstrap (zero — only additions, no removals).
# If any other helper has - lines, HALT and report.
```

### B.8 — Live install state untouched

```bash
# Worker's actual ~/neato-hive/.env HIVE_DASHBOARD_TOKEN — captured BEFORE pre-flight
# AND AFTER full test run. Must be byte-identical (no test wrote to live .env).
test -f ~/neato-hive/.env && grep -E '^HIVE_DASHBOARD_TOKEN=' ~/neato-hive/.env \
  | sed 's/=.*/=<redacted>/' || echo "no token (acceptable — bootstrap will generate)"
```

### B.9 — Cleanup

```bash
rm -f /tmp/D-followup-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 1 path exactly (`bin/hive`)
- [ ] `bash -n bin/hive` clean
- [ ] `shellcheck -x bin/hive` zero new warnings vs D.4 baseline
- [ ] B.2 unit tests: `_dashboard_ensure_token` generates 64-hex token silently, idempotent on second run, no duplicate `.env` lines, token never in stdout/stderr
- [ ] B.3 user-facing CLI unchanged: `hive dashboard token` prints existing token verbatim; missing-token path generates + prints + info banner (D.4 byte-equivalence)
- [ ] B.4 byte-equivalence: line 1 = 64-hex, line 2 = empty, line 3+ = info banner
- [ ] B.5 cmd_bootstrap insertion: `_dashboard_ensure_token` call line appears BEFORE `pm2 startOrReload` line in cmd_bootstrap body
- [ ] B.6 PM2 ban: no new PM2 verbs added outside the existing cmd_bootstrap pm2 block
- [ ] B.7 logic preservation: `_dashboard_rotate_token`, `cmd_dashboard`, `_dashboard_env_file`, and cmd_bootstrap's pm2 block all byte-preserved (only allowed `-` lines are inside `_dashboard_print_token` refactor body)
- [ ] B.8 live `~/neato-hive/.env` HIVE_DASHBOARD_TOKEN UNCHANGED by worker
- [ ] **No new dependencies** — diff includes only `bin/hive`. No `dashboard/`, `package.json`, `pnpm-lock.yaml` changes.
- [ ] PR body: pre-flight 1-5 outputs verbatim, B.1-B.8 outputs verbatim, diff-lock confirmation, "live install untouched" attestations

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (bin/hive)
Branch: feat/v1.5.0-D-followup-bootstrap-auto-token

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. D.4 dashboard helpers present at lines: <captured>
  3. _dashboard_ensure_token absent: ✓
  4. cmd_bootstrap body shape: <captured>
  5. tooling: openssl ✓ grep ✓ sed ✓

Tooling check:
  bash -n: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 _dashboard_ensure_token units:
    - B.2.a: token absent → 64-hex generated, silent ✓
    - B.2.b: token present → no-op ✓
    - B.2.c: no duplicate .env lines ✓
    - B.2.d: token NOT in stdout/stderr ✓
  B.3 _dashboard_print_token user-facing:
    - B.3.a: existing token printed verbatim ✓
    - B.3.b: missing-token path generates + prints + info banner ✓
  B.4 byte-equivalence: line 1 = 64-hex, line 2 = empty, line 3+ = info banner ✓
  B.5 cmd_bootstrap insertion: ensure-token line BEFORE pm2 startOrReload line ✓
  B.6 PM2 ban: zero new pm2 verbs outside existing block ✓
  B.7 logic preservation: only allowed - lines are inside _dashboard_print_token refactor ✓
  B.8 live .env unchanged: ✓

Worker scope attestations:
  - Live ~/neato-hive/.env HIVE_DASHBOARD_TOKEN UNCHANGED
  - No live PM2 verbs executed
  - No new dependencies (diff is bin/hive only)

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-D-followup-bootstrap-auto-token
  <verbatim — exactly 1 line: bin/hive>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.

Recovery for owner post-merge:
  cd ~/neato-hive && hive bootstrap
  → ensure-token populates .env if missing
  → pm2 startOrReload picks up the new env, dashboard boots clean
  → /api/* now serves with the auto-generated token
  → owner runs `hive dashboard token` to read the token for browser localStorage
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full helper extraction + `_dashboard_print_token` refactor + `cmd_bootstrap` insertion in single PR.
- **DO NOT MERGE** — house-md
- **TOKEN NEVER IN LOGS** — `_dashboard_ensure_token` MUST NOT echo, info, warn, or otherwise leak the generated token to stdout/stderr/structured logs. B.2.d enforces.
- **`_dashboard_ensure_token` IS SILENT-ON-SUCCESS** — return value (0/1) is the only signal. Caller emits any user-facing banner.
- **`_dashboard_print_token` USER-FACING SHAPE LOCKED** — line 1 = token, line 2 = empty, line 3+ = info. Pure refactor; behavior must match D.4 byte-for-byte. B.3 + B.4 enforce.
- **INSERTION ORDER LOCKED** — `_dashboard_ensure_token` call MUST appear BEFORE the existing `pm2 startOrReload` line in `cmd_bootstrap`. B.5 enforces.
- **NO NEW PM2 VERBS** — the existing `pm2 startOrReload --update-env` already handles the dashboard process. We do NOT add `pm2 restart hive-dashboard` or any other PM2 verb. B.6 enforces.
- **DO NOT TOUCH `_dashboard_rotate_token`, `cmd_dashboard`, `_dashboard_env_file`** — D.4 lock. B.7 enforces.
- **DO NOT MODIFY THE EXISTING cmd_bootstrap pm2 BLOCK** — byte-identical preservation. B.7 enforces.
- **DO NOT EXTEND DEPENDENCIES** — `bin/hive`-only diff. No package changes. No `dashboard/` files.
- **HALT-and-ping rule** — pre-flight surprises (D.4 helpers absent, cmd_bootstrap body unrecognizable, openssl absent) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.
- **No new shell-tool deps** — openssl + grep + sed all carry-over.

---

## F. Forward links

- **F.2 (installer wizard install flow):** the wizard's post-install step should call `hive bootstrap`, which now auto-ensures the token. Wizard can then call `hive dashboard token` to print the token for the user to copy. F.2's existing flow already plans to write the token to `~/.config/neato-hive/dashboard-token` for the GUI install convenience — that's compatible (the wizard reads from .env after bootstrap-ensure, then mirrors to the convenience location).
- **C.7 migration handler:** unchanged. The migration path also generates the token via its own logic. Two independent generation paths is OK (both are idempotent + check before write). A future cleanup leaf could converge them by having C.7's migration call `_dashboard_ensure_token` instead of duplicating the logic.
- **D.4 `cmd_dashboard rotate-token`:** unchanged. Rotation is a separate (destructive) operation.
- **Owner recovery RIGHT NOW** (post-merge): `cd ~/neato-hive && hive bootstrap` will auto-populate `.env` with a fresh token and start the dashboard clean. Owner then runs `hive dashboard token` to read the token for the browser localStorage paste.
- **Future leaf — token rotation ceremony:** a future maintenance leaf may add `hive dashboard rotate-token` invocation to a defined rotation cadence (90-day annual, etc.). Out of D-followup scope.
