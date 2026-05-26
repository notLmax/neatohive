# v1.5.0 F.3 — Setup-Wizard Handoff (`setup.sh` + `install.sh` polish)

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** F — Install script (3 PRs)
**Leaf:** F.3 (3 of 3 in Phase F — final F leaf)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** F.1 ✅ `b1d7b5c` (`scripts/install-prereqs.sh`), F.2 ✅ `92e4e54` (`install.sh`), Phases A/B/C/D ✅, E.1–E.5 ✅.
**Successors:** J.1 (full E2E on a clone); J.2 (tag v1.5.0, build tarball, push tarball + install.sh to site repo).

---

## Goal

Polish the handoff between `install.sh` (F.2) and `setup.sh` (existing wizard).

After F.2 merged, the user-flow is:

```
curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
  # ... installs prereqs + downloads tarball + extracts + writes .env ...
  # ==> ✓ Install complete!
  # Next steps: cd ~/neato-hive && pm2 startOrReload ecosystem.config.cjs && pm2 save
  # For setup beyond the dashboard: cd ~/neato-hive && ./setup.sh
```

The user opens a terminal, cd's to `~/neato-hive`, runs `./setup.sh`. setup.sh's existing logic Just Works™ — its state-machine handles re-runs, its prereq-checks (`command -v` everywhere) gracefully skip already-installed items, and its `env_upsert` function preserves existing keys (including `HIVE_DASHBOARD_TOKEN` written by install.sh).

So **F.3 is intentionally narrow.** No behavior changes. The leaf ships:

1. **Detection:** setup.sh recognizes a "post-fresh-install v1.5.0" state via the migration marker (`~/.neato-hive/migrations/v1_5_0_completed` from C.7) AND/OR the presence of `HIVE_DASHBOARD_TOKEN` in `.env` (from install.sh F.2). When detected, setup.sh prints a friendlier opening banner that acknowledges the install just happened, instead of the generic "fresh setup" banner.
2. **`--post-install` flag (optional alias).** Lets the user explicitly tell setup.sh "I just ran install.sh — go straight to the wizard." Functionally same as default mode (since setup.sh is idempotent), but sets the banner mode without relying on detection.
3. **install.sh polish:** the success-print is amended to suggest the explicit `--post-install` flag for the post-install path: `./setup.sh --post-install`. Cosmetic — works without the flag, but the flag's presence makes the intent legible.
4. **Test verification:** Bob runs `setup.sh --post-install` against a sandbox install.sh-installed dir (in worker scope), verifies the wizard reaches Step 4 (Claude Auth) without errors. Steps 1-3 (Node, brew tools, Claude CLI) gracefully detect already-installed and skip.

**Owner directive carry-over (2026-05-09 packaging priority):** F.3 closes Phase F. After F.3, the install path is end-to-end: user runs `curl ... | bash`, gets a working Hive + a clean handoff into wizard-tier setup. J.1 verifies the whole flow E2E. J.2 publishes.

**Non-goals (explicit drops):**
- No re-architecture of setup.sh's 10-step flow.
- No fancy `--post-install` semantics beyond banner-mode tweaks.
- No automatic `setup.sh` chain from install.sh in the same process (TTY/stdin issues with `curl | bash` make this fragile; the user opens a terminal manually).
- No GUI integration (G.1/H.1 are later phases).
- No setup.sh prereq deletion. All 10 steps stay; their idempotency is the answer.
- No HIVE_DASHBOARD_TOKEN regeneration. install.sh wrote it; setup.sh leaves it alone.
- No package.json / pnpm-lock.yaml changes.

---

## Architectural givens (carried)

### Existing setup.sh structure (DO NOT modify)

setup.sh is a 10-step state-machine wizard. From the code (heads-up for Bob — read setup.sh top to ~480 before editing):

- Bash strict-ish (`set -e`, no `-uo pipefail` — intentional for wizard tolerance).
- ANSI color helpers (`print_success`, `print_warning`, `print_error`).
- `env_upsert` for `.env` writes — replaces existing key in-place OR appends if absent. **Preserves all other keys.** install.sh's `HIVE_DASHBOARD_TOKEN=...` line survives.
- State machine: `state_load`, `state_save`, `step_done` — checkpoints at `./.setup-state` so failed/abandoned wizards resume.
- Args parsing at line ~354: `--fresh`, `--resume`, `--yes`/`-y`, `--help`/`-h`. F.3 adds `--post-install`.
- `run_preflight` at line ~121: OS check, Node ≥ 18, Homebrew (macOS), Claude CLI, Git. Account-prereq confirmations.
- `print_opening` at line ~89: the welcome screen (only shown on fresh starts, NOT on resumes).
- Steps 1-10 then each gated by `if ! step_done N; then ... fi`.

### Migration marker (C.7 lock)

`${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/v1_5_0_completed` — zero-byte file written by C.7's migration handler when `hive update` lands a v1.4.x → v1.5.0 transition. **Note for fresh installs (F.2 path):** the marker is NOT written by install.sh today — install.sh is fresh-install only and the migration handler runs as part of `hive update` (which doesn't run on fresh installs). So the marker is more reliable as a v1.4.x-upgrader detection than as a "user just ran install.sh" detection.

For F.3's purposes, the more reliable signal of "fresh install just happened" is **`HIVE_DASHBOARD_TOKEN` present in `.env` AND `.setup-state` absent**. install.sh writes the token; setup.sh hasn't written its state file yet. This combination is unique to "fresh install, never ran setup.sh."

**Locked detection logic (in setup.sh, before `run_preflight`):**

```bash
# F.3 — detect post-fresh-install state
detect_post_install_state() {
  local install_root token_present setup_state_present marker_present
  install_root="${HIVE_INSTALL_ROOT:-$(pwd)}"
  token_present=0
  setup_state_present=0
  marker_present=0

  if [ -f "${install_root}/.env" ] && grep -qE '^HIVE_DASHBOARD_TOKEN=' "${install_root}/.env"; then
    token_present=1
  fi
  if [ -f "${install_root}/.setup-state" ]; then
    setup_state_present=1
  fi
  if [ -f "${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/v1_5_0_completed" ]; then
    marker_present=1
  fi

  # Post-fresh-install: token present, setup-state absent
  if [ "${token_present}" -eq 1 ] && [ "${setup_state_present}" -eq 0 ]; then
    echo "post_fresh_install"
    return
  fi
  # Migrating from v1.4.x: marker present (set by C.7 during hive update)
  if [ "${marker_present}" -eq 1 ]; then
    echo "post_v15_migration"
    return
  fi
  # Default
  echo "fresh"
}
```

Returns one of three states:
- `post_fresh_install` — install.sh F.2 just ran, setup.sh hasn't yet
- `post_v15_migration` — user did `hive update` from v1.4.x to v1.5.0 (C.7 migration ran)
- `fresh` — neither signal; treat as a clean wizard run

### Locked banner-mode override

Per state, the opening banner adjusts:

| State | Banner |
|---|---|
| `post_fresh_install` (or `--post-install` flag) | "✓ Detected fresh install. Welcome — let's finish setting up Discord, Claude, and your first agent." |
| `post_v15_migration` | "✓ Detected v1.5.0 install (migrated from v1.4.x). Continuing wizard for any new setup steps." |
| `fresh` | (existing `print_opening` text — no change) |

### `--post-install` flag (locked)

```
Options (existing):
  --fresh, --restart    Force fresh start; clear state file.
  --resume              Auto-resume from saved state.
  --yes, -y             Auto-confirm prompts where safe.
  --help, -h            Show usage.

Options (F.3 NEW):
  --post-install        Treat this run as a post-fresh-install handoff from install.sh.
                        Adjusts banner; functionally equivalent to a normal run.
                        (Detection logic also auto-detects this state; flag is the explicit form.)
```

When `--post-install` is passed:
- `IS_POST_INSTALL=true`
- `IS_FRESH_START=true` (still triggers run_preflight + opening — wizard runs in full)
- `print_opening` shows the post-install variant (see banner table above)

When `--post-install` is NOT passed but `detect_post_install_state` returns `post_fresh_install`:
- Same effect as `--post-install`. The flag is just for explicit users.

### install.sh's success-print amendment (locked)

The existing block:
```
For setup beyond the dashboard (Discord bot, agents, Claude CLI):

  cd /Users/glados/neato-hive
  ./setup.sh
```

Amended to:
```
For setup beyond the dashboard (Discord bot, agents, Claude CLI):

  cd /Users/glados/neato-hive
  ./setup.sh --post-install

(setup.sh auto-detects the post-install state; --post-install is the explicit form.)
```

Single-block amendment in install.sh. Roughly 4 lines changed.

---

## Pre-conditions

- F.2 ✅ merged at `92e4e54` (install.sh present at framework root, mode 0755)
- F.1 ✅ merged at `b1d7b5c` (scripts/install-prereqs.sh present)
- setup.sh present at framework root (existing wizard, intact since v1.4.x)
- bash + standard Unix surface

---

## Where state lives (F.3 conventions)

**Modified files (2):**
- `setup.sh` — new `detect_post_install_state` function, new `--post-install` flag in arg parsing, banner-mode tweak in `print_opening`. Approximate diff: ~50-80 lines added/modified.
- `install.sh` — success-print block amended to include `--post-install`. Approximate diff: ~5 lines modified.

**Total: 2 paths.**

**No new files.** No modifications to scripts/install-prereqs.sh or any C.x / D.x / E.x files. No package.json or pnpm-lock.yaml changes.

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `92e4e54` (F.2 merge) plus this F.3 spec commit.

### 2. F.2 + F.1 surface present

```bash
test -f install.sh && echo "install.sh present ✓"
test -x install.sh && echo "  executable ✓"
test -f scripts/install-prereqs.sh && echo "scripts/install-prereqs.sh present ✓"
test -f setup.sh && echo "setup.sh present ✓"
```

**HALT and ping raymond-holt** if any are missing.

### 3. F.3 target functions absent in setup.sh

```bash
grep -nE '^detect_post_install_state\(\)' setup.sh | head -3
grep -nE '\-\-post-install' setup.sh | head -3
```

Expected: empty for both. **HALT and ping raymond-holt** if either match — out-of-band drift.

### 4. setup.sh shape unchanged from baseline

```bash
grep -nE '^run_preflight\(\)|^print_opening\(\)|^state_load\(\)|^state_save\(\)|^step_done\(\)|^env_upsert\(\)' setup.sh | head -10
grep -cE '^if ! step_done [0-9]+; then' setup.sh
# Expected: 10 (10 step gates)
```

**HALT and ping raymond-holt** if shape is unexpected (function names changed, step count differs).

### 5. Tooling

```bash
bash --version | head -1
shellcheck --version | head -2
which awk grep sed
```

Expected: bash ≥ 3.2, shellcheck ≥ 0.7 (already verified).

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-F.3-setup-wizard-integration`.

**Diff lock: 2 paths exactly.**
- `setup.sh` (MODIFIED — add detect_post_install_state, --post-install flag, banner-mode in print_opening)
- `install.sh` (MODIFIED — success-print block amended to suggest `--post-install`)

### A.1 — `setup.sh` modifications

**Three insertion points:**

#### A.1.1 — Add `detect_post_install_state` function

Insert AFTER `print_escape_footer()` (around line ~85, before `print_opening`):

```bash
# F.3 — detect post-fresh-install state. Returns one of:
#   post_fresh_install — install.sh F.2 wrote .env's HIVE_DASHBOARD_TOKEN; setup.sh
#                        hasn't run yet (.setup-state absent).
#   post_v15_migration — C.7 migration handler set the v1_5_0_completed marker
#                        (user upgraded from v1.4.x via `hive update`).
#   fresh              — neither signal; clean wizard run.
detect_post_install_state() {
  local install_root token_present setup_state_present marker_present
  install_root="${HIVE_INSTALL_ROOT:-$(pwd)}"
  token_present=0
  setup_state_present=0
  marker_present=0

  if [ -f "${install_root}/.env" ] && grep -qE '^HIVE_DASHBOARD_TOKEN=' "${install_root}/.env" 2>/dev/null; then
    token_present=1
  fi
  if [ -f "${install_root}/.setup-state" ]; then
    setup_state_present=1
  fi
  if [ -f "${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/v1_5_0_completed" ]; then
    marker_present=1
  fi

  if [ "${token_present}" -eq 1 ] && [ "${setup_state_present}" -eq 0 ]; then
    echo "post_fresh_install"
    return
  fi
  if [ "${marker_present}" -eq 1 ]; then
    echo "post_v15_migration"
    return
  fi
  echo "fresh"
}
```

#### A.1.2 — Amend `print_opening` for banner-mode

Modify the existing `print_opening()` body. Add a state-aware first block. Pseudocode:

```bash
print_opening() {
    local state="${POST_INSTALL_STATE:-fresh}"

    case "${state}" in
      post_fresh_install)
        echo -e "${BOLD}━━━ Detected fresh install ━━━${NC}"
        echo ""
        echo "Welcome — install.sh just set up the dashboard. Let's finish the wizard:"
        echo "  • Discord bot creation"
        echo "  • Claude Code authentication"
        echo "  • Your first agent (House MD) bootstrapping"
        echo ""
        echo "Time: ~10 minutes. Skip-able prereq steps will auto-skip (already-installed)."
        echo ""
        ;;
      post_v15_migration)
        echo -e "${BOLD}━━━ Detected v1.5.0 install (migrated from v1.4.x) ━━━${NC}"
        echo ""
        echo "Continuing wizard for any new setup steps."
        echo ""
        ;;
      *)
        # existing 'fresh' opening text — unchanged from current setup.sh
        echo -e "${BOLD}━━━ Before we start ━━━${NC}"
        echo ""
        echo "You're about to install Neato Hive — your personal AI agent runtime."
        echo "When this is done, you'll have:"
        # ... rest of existing print_opening body ...
        ;;
    esac
    # Common footer (already exists in current print_opening — keep verbatim):
    echo -e "  • Press ${CYAN}Ctrl-C${NC} to pause. Your progress is saved."
    # ... etc ...
    read -p "Press Enter to begin, or Ctrl-C to exit… "
    echo ""
}
```

**Worker discipline:** keep the EXISTING `print_opening` body verbatim under the `*)` case. Only ADD the two new cases. The common-footer block (Ctrl-C / Parsec / pkill) must remain after the case statement so all three banner variants share it.

#### A.1.3 — Amend arg parsing for `--post-install`

Modify the existing `for arg in "$@"; do ... case "$arg" in` block (around line ~354). Add ONE new case before the `*)` catch-all:

```bash
        --post-install)
            IS_POST_INSTALL=true
            ;;
```

Initialize `IS_POST_INSTALL=false` near the other arg-parsing variables (around line ~350-353).

#### A.1.4 — Wire detection into the main flow

Modify the section around line ~440-450 (where `IS_FRESH_START` is determined). Add:

```bash
# F.3 — auto-detect post-install state if --post-install not explicitly passed
if [ "${IS_POST_INSTALL}" = "false" ]; then
  POST_INSTALL_STATE="$(detect_post_install_state)"
  if [ "${POST_INSTALL_STATE}" = "post_fresh_install" ]; then
    IS_POST_INSTALL=true
  fi
else
  POST_INSTALL_STATE="post_fresh_install"
fi
export POST_INSTALL_STATE
```

`POST_INSTALL_STATE` is the variable that `print_opening` reads to choose the banner.

#### A.1.5 — Update `--help` text

In the existing `--help|-h)` case in arg parsing, amend the help message to include `--post-install`:

```
Usage: ./setup.sh [--fresh|--resume|--yes|--post-install|--help]

  --fresh         Force a fresh start; discard saved state.
  --resume        Resume from saved state.
  --yes, -y       Auto-confirm where safe.
  --post-install  Run as a post-install handoff from install.sh.
  --help, -h      Show this help.
```

#### A.1.6 — DO NOT modify Steps 1-10

The 10 wizard steps (Node, PM2 + brew tools, Claude CLI, Claude auth, Codex, Discord, GWS, Working Dir, Install & Build, Boot Persistence) are UNCHANGED. Their existing idempotency handles re-runs gracefully.

### A.2 — `install.sh` modifications

Single block amendment in the success-print near the end of the script. Find the existing block:

```bash
For setup beyond the dashboard (Discord bot, agents, Claude CLI):

  cd /Users/glados/neato-hive
  ./setup.sh
```

(The path is dynamic via `${TARGET_DIR}`.)

Replace with:

```bash
For setup beyond the dashboard (Discord bot, agents, Claude CLI):

  cd ${TARGET_DIR}
  ./setup.sh --post-install

(setup.sh auto-detects the post-install state; --post-install is the explicit form.)
```

**~5 lines changed in install.sh.** No other modifications.

---

## B. Tests + verification

### B.1 — Bash syntax + shellcheck

```bash
bash -n setup.sh && echo "setup.sh bash -n: ✓"
bash -n install.sh && echo "install.sh bash -n: ✓"
shellcheck setup.sh 2>&1 | tee /tmp/F3-setup-shellcheck.out | tail -10
shellcheck install.sh 2>&1 | tee /tmp/F3-install-shellcheck.out | tail -10
# Expected: zero NEW warnings vs F.2 baseline. setup.sh's existing shellcheck
# warnings (likely many — it's 49kB of wizard) are preserved; F.3's additions
# add zero new ones.
```

### B.2 — `--help` shows --post-install

```bash
bash setup.sh --help 2>&1 | head -20
echo "exit: $?"
# Expected: --post-install line present in output; exit 0
```

### B.3 — `--post-install` flag accepted

```bash
# Pass --post-install with --fresh to bypass interactive prompts in test
# (we can't actually run the full wizard in worker scope; just test arg-parsing).
# Use bash -c to source the arg parsing in isolation:
SETUP_TEST_MODE=1 bash -c '
  source <(awk "/^FORCE_FRESH=false/,/^done/" setup.sh)
  echo "IS_POST_INSTALL=${IS_POST_INSTALL:-unset}"
' --fresh --post-install --yes 2>&1 | head -3
```

If sourcing setup.sh in isolation is fragile, alternative test:

```bash
# Direct test: run setup.sh --post-install --help (the flag should be accepted before --help exits)
bash setup.sh --post-install --help 2>&1 | head -5
echo "exit: $?"
# Expected: usage block; exit 0; no "unknown argument" error
```

Worker captures whichever approach works.

### B.4 — `detect_post_install_state` function unit tests

Sandbox-isolated:

```bash
# Test 1: post_fresh_install (token present, .setup-state absent)
SANDBOX=/tmp/F3-detect-fresh-$$
mkdir -p "$SANDBOX"
echo "HIVE_DASHBOARD_TOKEN=abcdef" > "$SANDBOX/.env"

result=$(HIVE_INSTALL_ROOT="$SANDBOX" \
  HIVE_STATE_ROOT="$SANDBOX/state" \
  bash -c 'source setup.sh-shim.sh; detect_post_install_state' 2>/dev/null)

# If sourcing the function in isolation is fragile, alternative:
# Worker creates a tiny test harness file that sources only the function defs.

# Expected: result == "post_fresh_install"
echo "result: $result"
test "$result" = "post_fresh_install" && echo "B.4.1: post_fresh_install detected ✓"

rm -rf "$SANDBOX"
```

```bash
# Test 2: post_v15_migration (marker present)
SANDBOX_INSTALL=/tmp/F3-detect-mig-install-$$
SANDBOX_STATE=/tmp/F3-detect-mig-state-$$
mkdir -p "$SANDBOX_INSTALL" "$SANDBOX_STATE/migrations"
touch "$SANDBOX_STATE/migrations/v1_5_0_completed"

result=$(HIVE_INSTALL_ROOT="$SANDBOX_INSTALL" \
  HIVE_STATE_ROOT="$SANDBOX_STATE" \
  bash -c '<source the function>; detect_post_install_state' 2>/dev/null)

test "$result" = "post_v15_migration" && echo "B.4.2: post_v15_migration detected ✓"

rm -rf "$SANDBOX_INSTALL" "$SANDBOX_STATE"
```

```bash
# Test 3: fresh (neither signal)
SANDBOX=/tmp/F3-detect-fresh-empty-$$
mkdir -p "$SANDBOX"

result=$(HIVE_INSTALL_ROOT="$SANDBOX" \
  HIVE_STATE_ROOT="$SANDBOX/state" \
  bash -c '<source the function>; detect_post_install_state' 2>/dev/null)

test "$result" = "fresh" && echo "B.4.3: fresh detected ✓"

rm -rf "$SANDBOX"
```

**Worker harness pattern:** create a tiny `/tmp/F3-detect-test-harness.sh` that sources only the F.3-relevant additions from setup.sh. Then run the three sub-tests with appropriate env vars. Worker captures the harness file content + the test outputs in PR body.

If sourcing setup.sh's function isolation is too fragile, alternative: worker writes a simpler 30-line test harness that COPIES the `detect_post_install_state` function inline (with the same body) and invokes it directly. The point is to exercise the LOGIC, not to test setup.sh's full sourcing behavior.

### B.5 — install.sh success-print includes `--post-install`

```bash
grep -nE '\-\-post-install' install.sh
# Expected: at least 1 match in install.sh (the success-print amendment)
```

### B.6 — install.sh `--check-only` against sandbox: success-print mention

```bash
SANDBOX=/tmp/F3-install-check-$$
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"

# Run install.sh --check-only against an empty sandbox; verify the success-print
# block (or its dry-run equivalent) mentions --post-install.
bash install.sh --check-only --target-dir="$SANDBOX" 2>&1 | grep -A 5 'setup beyond the dashboard' | head -10

# Expected: the block now references './setup.sh --post-install' (was './setup.sh' alone).

rm -rf "$SANDBOX"
```

If `--check-only` doesn't reach the success-print block (because it exits before tarball download), worker EITHER:
- runs the full B.7-style fixture install in sandbox (per F.2's pattern) and captures the actual success-print
- OR greps install.sh source verbatim for the literal new text

```bash
grep -nE 'setup\.sh --post-install' install.sh
# Expected: 1 match (the amended success-print)
```

### B.7 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-F.3-setup-wizard-integration
# Expected: 2 files (setup.sh, install.sh) — both modified (no new files)
```

### B.8 — setup.sh existing tests still pass (smoke check that we didn't break anything)

setup.sh has no automated test suite (it's a manual wizard). Worker's smoke check is:

```bash
# bash -n already in B.1
bash -n setup.sh

# Validate state machine isn't disturbed
grep -cE '^if ! step_done [0-9]+; then' setup.sh
# Expected: 10 (unchanged)

grep -nE '^step_done\(\)|^state_load\(\)|^state_save\(\)|^state_clear\(\)' setup.sh
# Expected: existing function defs all present
```

### B.9 — No HIVE_DASHBOARD_TOKEN regeneration in setup.sh

```bash
# Verify F.3 didn't accidentally add a token-regen step to setup.sh
grep -nE 'HIVE_DASHBOARD_TOKEN|openssl rand' setup.sh
# Expected: only the read in detect_post_install_state's grep check; no write
# operations against HIVE_DASHBOARD_TOKEN.
```

### B.10 — File modes preserved

```bash
ls -l setup.sh install.sh
# Expected: both -rwxr-xr-x (mode 0755) — F.3 doesn't change modes.
```

### B.11 — Cleanup

```bash
rm -f /tmp/F3-*.out /tmp/F3-*.json
rm -rf /tmp/F3-detect-* /tmp/F3-install-*
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 2 paths exactly (setup.sh modified, install.sh modified)
- [ ] B.1 `bash -n` clean for both files; shellcheck zero NEW warnings (existing setup.sh warnings preserved)
- [ ] B.2 `--help` includes `--post-install` line
- [ ] B.3 `--post-install` flag accepted without "unknown argument" error
- [ ] B.4 `detect_post_install_state` function returns the correct state for all three test cases (post_fresh_install, post_v15_migration, fresh)
- [ ] B.5 install.sh contains the literal text `setup.sh --post-install` in the success-print block
- [ ] B.6 install.sh's success-print mentions `--post-install` (verified via grep or live render)
- [ ] B.7 diff-lock = 2 paths, no new files
- [ ] B.8 setup.sh state-machine intact: 10 step-gates, all existing functions present
- [ ] B.9 NO HIVE_DASHBOARD_TOKEN regeneration added to setup.sh — token machinery is install.sh / bin/hive's responsibility
- [ ] B.10 file modes preserved (both 0755)
- [ ] **Detection logic** uses `HIVE_DASHBOARD_TOKEN in .env AND .setup-state absent` for `post_fresh_install`; uses migration marker for `post_v15_migration`. Returns `fresh` otherwise.
- [ ] **No behavior changes to Steps 1-10** of setup.sh
- [ ] **No new dependencies** — F.3 uses existing bash + grep + standard Unix surface
- [ ] **No package.json or pnpm-lock.yaml changes**
- [ ] Worker MUST NOT run setup.sh end-to-end in worker scope (it would interactively prompt for Discord bot creation, Claude auth, etc. — wizard-tier interactions). Only `--help` and the function-isolation tests are in worker scope.
- [ ] PR body: pre-flight 1-5 outputs verbatim, B.1-B.10 outputs verbatim, sample diff of `print_opening` showing the three banner variants, sample diff of install.sh success-print showing the amendment, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 2 paths (setup.sh, install.sh — both modified)
Branch: feat/v1.5.0-F.3-setup-wizard-integration

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. F.1 + F.2 surface present: ✓
  3. F.3 target functions absent: ✓
  4. setup.sh shape unchanged: 10 step gates + existing functions ✓
  5. tooling: bash ≥ 3.2 ✓ shellcheck ≥ 0.7 ✓

Tooling check:
  bash -n setup.sh: ✓
  bash -n install.sh: ✓
  shellcheck setup.sh delta: 0 new warnings
  shellcheck install.sh delta: 0 new warnings

Tests:
  B.2 --help shows --post-install: ✓
  B.3 --post-install accepted: ✓
  B.4 detect_post_install_state:
    - post_fresh_install (token present, .setup-state absent): ✓
    - post_v15_migration (marker present): ✓
    - fresh (no signals): ✓
  B.5 install.sh contains 'setup.sh --post-install': ✓
  B.6 install.sh success-print rendered: <captured excerpt>
  B.7 diff-lock = 2 paths: ✓
  B.8 setup.sh state-machine intact: 10 step gates ✓
  B.9 no HIVE_DASHBOARD_TOKEN regen: ✓
  B.10 file modes 0755 both: ✓

Worker scope attestations:
  - Did NOT run setup.sh end-to-end (would require interactive wizard)
  - Function-isolation tests for detect_post_install_state used /tmp sandboxes
  - Host setup.sh state file ./.setup-state UNCHANGED from worker turn
  - Host install.sh UNCHANGED at framework root (file modified in PR branch only)

Sample print_opening diff (3 banner variants):
  <verbatim diff hunk>

Sample install.sh success-print amendment:
  <verbatim before/after of the 'setup beyond the dashboard' block>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-F.3-setup-wizard-integration
  <verbatim — exactly 2 lines: setup.sh, install.sh>

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full F.3 polish (detection function + --post-install flag + banner-mode + install.sh success-print) in single PR.
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT MODIFY setup.sh STEPS 1-10** — only banner-mode tweak in `print_opening`, new function `detect_post_install_state`, new `--post-install` arg case, wire-detection block. The 10 wizard steps STAY.
- **DO NOT TOUCH HIVE_DASHBOARD_TOKEN MACHINERY IN setup.sh** — install.sh writes it, bin/hive (C.7 + `hive dashboard token`) regenerates it. setup.sh leaves it alone. F.3 only READS the token's presence as a detection signal.
- **DO NOT MODIFY scripts/install-prereqs.sh** — F.1's leaf is independent. F.3 doesn't touch it.
- **DO NOT MODIFY package.json OR pnpm-lock.yaml** — pure shell changes.
- **DO NOT RUN setup.sh END-TO-END IN WORKER SCOPE** — it would interactively prompt for Discord bot creation, Claude auth, Codex install, etc. Worker scope is `--help` + function-isolation tests only.
- **DO NOT TOUCH HOST'S `./.setup-state` FILE** — that's Daniel's wizard state. Worker tests use sandbox dirs.
- **AUTO-DETECTION + EXPLICIT FLAG** — both paths supported. Auto-detection via `detect_post_install_state` runs in the main flow when `--post-install` is NOT explicitly passed. Explicit flag forces post_fresh_install state regardless of detection.
- **3 BANNER VARIANTS LOCKED** — `post_fresh_install`, `post_v15_migration`, `fresh`. The `fresh` case must preserve setup.sh's EXISTING `print_opening` body verbatim under its case branch.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises (target functions already exist, setup.sh shape changed unexpectedly, missing F.1/F.2 surface) stop the worker. Halt means halt — do not fix-and-proceed inline.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **J.1 — Full E2E on a clone.** Bob runs install.sh on a clone (or VM), verifies tarball download, extraction, token gen, dashboard boot, then runs setup.sh --post-install end-to-end (interactive — owner runs this part since Bob can't auto-confirm Discord bot creation etc.) and confirms the wizard reaches Discord setup without errors. Tests F.3's banner detection live.
- **J.2 — Tag v1.5.0, build tarball, push tarball + install.sh to site repo.** Owner verifies on a clone before main install. **THIS IS THE MOMENT downloadable from the website becomes literally true.** install.sh is published at `https://neato-hive-site.vercel.app/install.sh`; tarball at `https://neato-hive-site.vercel.app/releases/v1.5.0/...`.
- **G.1 / H.1 — GUI installer wrappers.** Wrap install.sh + setup.sh chain with osascript / zenity dialogs. Out of v1.5.0 packaging-priority scope per 2026-05-09 Daniel directive (deferred to v1.5.x or later).
- **Future leaf — `--post-install` chain in same process.** If owner ever wants install.sh to literally exec setup.sh in the same process (vs. printing the next-step), a future leaf can add this with TTY-detection guards. Out of F.3 scope; current pattern keeps the user in control.
- **Future leaf — wizard available in dashboard.** Per 2026-05-09 Daniel strategic vision, the dashboard eventually surfaces all CLI-doable operations. Setup-wizard surfaces (Discord setup, agent bootstrap) could be dashboard-rendered post-v1.5.0. Out of v1.5.0 scope.
