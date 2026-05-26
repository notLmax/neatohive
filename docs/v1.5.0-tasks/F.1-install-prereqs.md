# v1.5.0 F.1 — Install Prereqs Detection + Auto-Install

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** F — Install script (3 PRs)
**Leaf:** F.1 (1 of 3 in Phase F)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** Phases A, B, C, D ✅; E.1–E.5 ✅. Phase E.5 merged at `7c4ba55`.
**Successors:** F.2 (fresh-install flow — download tarball from website, verify, extract, generate dashboard token); F.3 (setup-wizard integration).

---

## Goal

Ship a standalone, idempotent prereq-detection script at `scripts/install-prereqs.sh` that:

1. **Detects** the six prereqs Neato Hive requires: `node` (≥ 18), `pnpm`, `pm2`, `git`, `curl`, `tar`.
2. **Reports** their state in human-readable form on stdout, OR machine-readable JSON via `--json`.
3. **Installs** missing prereqs via the platform's native package manager (Homebrew on macOS, `apt-get` on Ubuntu) with per-prereq confirmation (`--install`) or unconditionally (`--auto`).
4. **Refuses** to upgrade prereqs that are present-but-too-old. Reports the version mismatch and instructs the user to upgrade manually. Auto-upgrade across major Node versions is too risky cross-platform for v1.5.0.

This script is the foundation F.2's install.sh consumes (run prereqs check before downloading the tarball; abort with clear message if any missing). F.3's setup-wizard integration also calls this in `--auto` mode during fresh-install.

The script is **non-destructive** in `--check-only` mode (default): it only inspects the system. Installation requires explicit `--install` or `--auto`. No flag means check-and-report only.

**End-user goal:** a non-technical user can run `bash scripts/install-prereqs.sh --auto` on a fresh Mac or Ubuntu install and end up with all six prereqs ready, no terminal back-and-forth required.

---

## Architectural givens (carried)

- **Bash strict mode:** `set -euo pipefail`. Mirrors `scripts/release.sh` (B.1) discipline.
- **Shellcheck clean.** Worker confirms zero new warnings via `shellcheck -x scripts/install-prereqs.sh`.
- **OS detection:**
  - macOS → `[ "$(uname)" = "Darwin" ]`. Package manager: Homebrew (`brew`).
  - Linux/Ubuntu → `[ "$(uname)" = "Linux" ]` AND `command -v apt-get` exists. Package manager: `apt-get` (with `sudo` if not root).
  - Anything else → unsupported, exit 1 with clear message.
- **Homebrew is a prereq-of-the-prereq on macOS.** If `brew` is not installed and the user is on macOS, the script reports the issue and instructs the user to install Homebrew manually (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`) — the script does NOT auto-install Homebrew, because that's a system-altering chained shell call and the user should consent to it explicitly.
- **`sudo` handling on Ubuntu.** If running as root: invoke `apt-get` directly. Else: prefix `sudo` and let the OS prompt for the password. The script never caches or stores the sudo password.
- **`pnpm` and `pm2` install via `npm install -g`** (cross-platform), NOT `brew install`. Reasons: (a) brew's `pnpm` and `pm2` formulae lag npm; (b) using npm-global keeps both platforms aligned; (c) the npm path requires Node already present, so install order is enforced naturally.
- **Idempotency.** Running the script multiple times is safe. Already-installed prereqs are detected and skipped. The interactive confirm only prompts for the missing ones.
- **Exit codes:**
  - `0` — all prereqs satisfied (after install attempts in `--install`/`--auto` mode)
  - `1` — one or more prereqs missing AND user declined install (or auto-install failed)
  - `2` — bad arguments / unsupported OS / Homebrew missing on macOS
- **No new dependencies.** The script uses only POSIX shell + `command`, `uname`, `awk`, `sed`, `grep`, `cat`. All present on stock Mac and Ubuntu.

---

## Locked prereq vocabulary (the six)

The order below is the locked detection AND install order. `node` is first because `pnpm` and `pm2` install via `npm`, which requires Node.

| Index | Name | Min version | Detect command | Install command (macOS) | Install command (Ubuntu) |
|---|---|---|---|---|---|
| 1 | `node` | `18.0.0` | `node --version` (output `vMAJOR.MINOR.PATCH`) | `brew install node` | `apt-get install -y nodejs npm` |
| 2 | `pnpm` | (any) | `pnpm --version` | `npm install -g pnpm` | `npm install -g pnpm` |
| 3 | `pm2` | (any) | `pm2 --version` | `npm install -g pm2` | `npm install -g pm2` |
| 4 | `git` | (any) | `git --version` | `brew install git` | `apt-get install -y git` |
| 5 | `curl` | (any) | `curl --version` (first line first token) | `brew install curl` | `apt-get install -y curl` |
| 6 | `tar` | (any) | `tar --version` (first line first token, BSD or GNU) | (preinstalled on macOS) | `apt-get install -y tar` |

For prereqs marked `(any)`, presence alone satisfies the check — version is reported but not gated.

For Node specifically, the version check parses `node --version` output (e.g. `v20.10.0`) and compares the major version to `18`. If the major version is less than `18`, the prereq is flagged as `present-but-too-old` with the message `"Node ${found} is too old; need ≥ ${min}. Upgrade manually via brew (\`brew upgrade node\`) or NodeSource (\`https://github.com/nodesource/distributions\`)."`. The script does NOT attempt to upgrade.

---

## CLI shape (locked)

```
Usage: bash scripts/install-prereqs.sh [--check-only|--install|--auto] [--json] [--help]

Modes (mutually exclusive — pick at most one; default is --check-only):
  --check-only    Detect prereqs and report. Do NOT install. (default)
  --install       Detect prereqs. For each missing, prompt y/N and install if confirmed.
  --auto          Detect prereqs. Install all missing without prompting.

Output:
  --json          Emit machine-readable JSON instead of human-readable text.
                  Compatible with --check-only, --install, --auto modes (in install
                  modes, JSON is emitted only after the run completes).

  --help          Print this usage text and exit 0.

Exit codes:
  0 — all prereqs satisfied
  1 — one or more prereqs missing AND not installed (e.g. --check-only with missing,
      or --install with user-declined, or auto-install failure)
  2 — bad arguments, unsupported OS, or Homebrew missing on macOS
```

---

## Output formats (locked)

### Human-readable

```
Checking prereqs for Neato Hive install...

  ✓ node    v20.10.0    (≥ 18.0.0)
  ✓ pnpm    9.0.6
  ✗ pm2                 NOT INSTALLED — install with: npm install -g pm2
  ✓ git     2.50.0
  ✓ curl    8.7.1
  ✓ tar     bsdtar 3.5.3

5 of 6 prereqs satisfied. 1 missing.

Run `bash scripts/install-prereqs.sh --install` to install missing prereqs interactively.
Run `bash scripts/install-prereqs.sh --auto` to install missing prereqs unattended.
```

In `--install` mode, after the report:

```
Install pm2 via `npm install -g pm2`? [y/N]: y
==> Running: npm install -g pm2
... (npm output) ...
✓ pm2 installed: 5.4.1

All 6 prereqs satisfied.
```

In `--auto` mode, no prompt — same `==> Running:` line and post-install verify.

### JSON (`--json`)

```json
{
  "version": "1",
  "ts": "2026-05-09T03:00:00Z",
  "os": "darwin",
  "package_manager": "brew",
  "all_satisfied": false,
  "prereqs": [
    { "name": "node", "satisfied": true, "found_version": "20.10.0", "min_version": "18.0.0", "install_command": null },
    { "name": "pnpm", "satisfied": true, "found_version": "9.0.6", "min_version": null, "install_command": null },
    { "name": "pm2",  "satisfied": false, "found_version": null,    "min_version": null, "install_command": "npm install -g pm2" },
    { "name": "git",  "satisfied": true, "found_version": "2.50.0", "min_version": null, "install_command": null },
    { "name": "curl", "satisfied": true, "found_version": "8.7.1",  "min_version": null, "install_command": null },
    { "name": "tar",  "satisfied": true, "found_version": "bsdtar 3.5.3", "min_version": null, "install_command": null }
  ]
}
```

In `--install` or `--auto` mode with `--json`, the JSON is emitted ONCE at the end of the run, with `all_satisfied` reflecting the post-install state. No mid-run progress output to stdout in JSON mode (the install commands themselves print to stdout, but they're prefixed with `==> Running:` and don't break JSON parsing — the final JSON is emitted on a single line via `printf` after any install steps complete).

The JSON envelope is locked at `version: "1"` for forward-compatibility. F.2 and F.3 read this envelope and gate accordingly.

`os` values: `"darwin"` or `"linux"`. `package_manager` values: `"brew"`, `"apt-get"`, or `"none"` (when the OS is unsupported — though in that case the script exits 2 BEFORE emitting JSON, so consumers should not see `"none"` in practice).

---

## Pre-conditions

- E.1–E.5 ✅ on framework `main`. Phase E partial-ship sufficient.
- `bash`, `awk`, `sed`, `grep`, `cat` present (POSIX). Verified by pre-flight #5.
- Repo HEAD includes the F.1 spec commit before dispatch.

---

## Where state lives (F.1 conventions)

**New file (1):**
- `scripts/install-prereqs.sh` — executable bash script (mode 0755).

**Total: 1 path.**

**No modifications to existing files.** This is a brand-new scripts/ entry that other phases (F.2, F.3) will consume.

**No new dependencies.** No npm, no Brew formulae touched at the repo level. The script self-contains all detection logic and shells out to the platform package manager only at install time.

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `7c4ba55` (E.5 merge) plus this F.1 spec commit.

### 2. F.1 target path absent

```bash
test ! -f scripts/install-prereqs.sh && echo "scripts/install-prereqs.sh absent ✓"
```

**HALT and ping raymond-holt** if the path exists.

### 3. Platform inspection (capture for PR body)

```bash
uname -a
which brew && brew --version | head -1 || echo "(brew not present)"
which apt-get || echo "(apt-get not present — expected on macOS)"
```

Bob runs on macOS — `brew` is expected to be present, `apt-get` is expected to be absent. Worker captures both for the audit trail.

### 4. Existing prereq snapshot on host (informational)

```bash
node --version 2>&1 || echo "node not installed"
pnpm --version 2>&1 || echo "pnpm not installed"
pm2 --version 2>&1 || echo "pm2 not installed"
git --version 2>&1 || echo "git not installed"
curl --version 2>&1 | head -1 || echo "curl not installed"
tar --version 2>&1 | head -1 || echo "tar not installed"
```

Captures the host's current state. The post-implementation `--check-only` smoke test should reflect this same state (the script is non-destructive).

### 5. Tooling

```bash
bash --version | head -1
shellcheck --version | head -2
which awk sed grep cat
```

Expected: bash ≥ 3.2, shellcheck ≥ 0.7. **HALT and ping raymond-holt** if shellcheck is missing — Worker cannot verify B.1 without it.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-F.1-install-prereqs`.

**Diff lock: 1 path exactly** (`scripts/install-prereqs.sh`, new file, mode 0755).

### A.1 — `scripts/install-prereqs.sh`

The script. Locked structure (in this order):

1. `#!/usr/bin/env bash` shebang
2. `set -euo pipefail`
3. Comment block: purpose, usage, exit codes, contract reference
4. Constants: `MIN_NODE_MAJOR=18`, prereq array order
5. Argument parsing: `--check-only`, `--install`, `--auto`, `--json`, `--help`
6. OS detection function `detect_os()` → echoes `darwin` or `linux`; `detect_package_manager()` → echoes `brew`, `apt-get`, or exits 2
7. Per-prereq detection functions: `_check_node`, `_check_pnpm`, `_check_pm2`, `_check_git`, `_check_curl`, `_check_tar`. Each returns 0 (satisfied) or non-zero, and echoes the found version (or empty if not installed) to stdout, and the failure-detail (e.g. version-too-old message) to FD 3 if applicable.
8. Per-prereq install command builder: `_install_command_for <name> <os>` → echoes the install command string (e.g. `brew install node`, `npm install -g pm2`, `apt-get install -y git`). Includes `sudo` prefix if Linux and not root.
9. Main flow:
   - Parse args
   - Detect OS + package manager (HALT-with-2 on unsupported)
   - On macOS: verify `brew` is present (HALT-with-2 with manual-install instructions if not)
   - For each prereq in order: detect; record result
   - Print human-readable report (or accumulate JSON object)
   - If `--check-only`: emit JSON if requested, exit 0/1 based on satisfaction
   - If `--install` or `--auto`: for each unsatisfied prereq:
     - In `--install`: prompt `y/N`. Skip if user declines.
     - In `--auto`: skip prompt.
     - Run the install command. Re-detect. Update result.
   - Print final report (human or JSON)
   - Exit 0 if all satisfied; 1 otherwise

10. Function bodies kept under 30 lines each where possible. Use comments to mark section boundaries.

**Locked semantics:**

- **Argument order does not matter.** `--json --auto` and `--auto --json` are equivalent.
- **Conflicting modes return exit 2.** E.g. `--check-only --install` exits 2 with `"ERROR: --check-only and --install are mutually exclusive"`.
- **Unknown args return exit 2.** E.g. `--foo` exits 2 with `"ERROR: unknown argument '--foo'"`.
- **No `--force-os` flag** in v1.5.0. Worker may add a hidden test hook (`HIVE_INSTALL_PREREQS_FORCE_OS=linux`) for shellcheck-via-grep verification of the Ubuntu code path, but it must be undocumented and gated by env var, not a CLI flag.
- **`tar` detection** must work for both BSD tar (macOS) and GNU tar (Ubuntu). Both respond to `--version`. Capture the first line, first non-empty token via `awk`.
- **Color output** — keep it simple. Use ANSI green/red for ✓/✗ when stdout is a TTY (`[ -t 1 ]`); plain text otherwise. NO color libraries; just `\033[32m` / `\033[31m` / `\033[0m` literals.

### A.2 — Inline comment block at the top of the script

```bash
#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/install-prereqs.sh — Detect and (optionally) install Neato
# Hive's six prereqs: node (≥ 18), pnpm, pm2, git, curl, tar.
#
# Usage:  bash scripts/install-prereqs.sh [--check-only|--install|--auto] [--json] [--help]
#
# Default mode: --check-only (no installs, just detect-and-report).
#
# v1.5.0 F.1 — Spec: docs/v1.5.0-tasks/F.1-install-prereqs.md
# Consumers: F.2 install.sh fresh-install flow; F.3 setup-wizard integration.
#-----------------------------------------------------------------------
```

---

## B. Tests + verification

### B.1 — Bash syntax + shellcheck

```bash
bash -n scripts/install-prereqs.sh && echo "bash -n: ✓"
shellcheck -x scripts/install-prereqs.sh 2>&1 | tail -20
# Expected: zero warnings or only style/info-level (SC2034, SC2155 if needed). No errors or warnings on critical levels.
```

### B.2 — `--help` output

```bash
bash scripts/install-prereqs.sh --help 2>&1 | head -30
echo "exit code: $?"
# Expected: usage block as specified in §CLI shape; exit 0
```

### B.3 — `--check-only` on host (default mode)

```bash
bash scripts/install-prereqs.sh 2>&1 | tee /tmp/F1-check.out
echo "exit code: $?"
# Expected: human-readable report listing all 6 prereqs with ✓ or ✗.
# On Bob's host (macOS with everything installed): 6/6 satisfied, exit 0.
```

### B.4 — `--check-only --json`

```bash
bash scripts/install-prereqs.sh --json 2>&1 | tee /tmp/F1-check-json.out
echo "exit code: $?"
# Expected: single-line valid JSON conforming to §Output formats schema.
# Verify with jq:
bash scripts/install-prereqs.sh --json | jq -e '.version == "1" and .all_satisfied == true and (.prereqs | length) == 6' \
  && echo "B.4: JSON envelope valid + all_satisfied + 6 prereqs ✓"
```

### B.5 — Unknown-argument error path

```bash
bash scripts/install-prereqs.sh --bad-flag 2>&1 | head -3
echo "exit code: $?"
# Expected: ERROR message on stderr; exit 2
```

### B.6 — Mutually exclusive modes

```bash
bash scripts/install-prereqs.sh --check-only --install 2>&1 | head -3
echo "exit code: $?"
# Expected: ERROR message about mutual exclusion; exit 2
```

### B.7 — Ubuntu code-path verification (grep, no execution)

```bash
# Worker captures the relevant Ubuntu install commands by grep.
grep -n -E 'apt-get|sudo apt-get' scripts/install-prereqs.sh | head -10
# Expected: ≥ 1 match for nodejs, git, curl, tar entries — confirms Ubuntu code path is wired.
# Spec-author reviews; worker need not execute on Ubuntu.

# Forced-OS env-var smoke (if implemented) — verify dry-run shape:
HIVE_INSTALL_PREREQS_FORCE_OS=linux bash scripts/install-prereqs.sh --json 2>&1 | jq -c '{os, package_manager}' || echo "(env-var force not implemented — verify by code review only)"
```

### B.8 — Idempotency — run --check-only twice, output identical

```bash
bash scripts/install-prereqs.sh --json > /tmp/F1-run1.json
bash scripts/install-prereqs.sh --json > /tmp/F1-run2.json
diff <(jq -S 'del(.ts)' /tmp/F1-run1.json) <(jq -S 'del(.ts)' /tmp/F1-run2.json) && echo "B.8: idempotent (modulo timestamp) ✓"
```

### B.9 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-F.1-install-prereqs
# Expected: exactly 1 line: scripts/install-prereqs.sh
```

### B.10 — File mode

```bash
ls -la scripts/install-prereqs.sh
# Expected: -rwxr-xr-x (mode 0755)
```

### B.11 — No live install attempted by worker

```bash
# Worker MUST NOT run `--install` or `--auto` against the host. Only `--check-only`.
# This is a worker-scope attestation in the DONE block. The check is grep-based:
git diff main...feat/v1.5.0-F.1-install-prereqs -- 'scripts/install-prereqs.sh' \
  | grep -E '^\+.*(brew install|apt-get install|npm install -g)' | head -5
# These lines appear ONLY inside the install command builder. They are CONTENT (string emission),
# not direct execution. Worker confirms by reading the surrounding code that these strings
# are emitted via `echo` or `printf`, not directly executed by `eval`/`bash -c` from the worker run.
```

### B.12 — Cleanup

```bash
rm -f /tmp/F1-*.out /tmp/F1-*.json
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 1 path exactly (`scripts/install-prereqs.sh` new, mode 0755)
- [ ] `bash -n` clean
- [ ] `shellcheck -x` zero new warnings vs C.7 baseline (or comparable established baseline)
- [ ] B.2 `--help` output matches §CLI shape
- [ ] B.3 `--check-only` on host detects 6/6 prereqs (Bob's host has them all), exit 0
- [ ] B.4 `--json` output is valid JSON, `version: "1"`, `all_satisfied: true`, 6 prereqs in array
- [ ] B.5 unknown argument → exit 2 with clear stderr message
- [ ] B.6 mutually exclusive modes → exit 2
- [ ] B.7 Ubuntu code path present (grep finds `apt-get` for at least nodejs, git, curl, tar)
- [ ] B.8 idempotent (running twice with same args produces identical JSON modulo timestamp)
- [ ] B.9 diff-lock = 1 path
- [ ] B.10 file mode is 0755
- [ ] B.11 no live install commands executed in worker turn (no new packages installed on host)
- [ ] **OS detection** locked to `darwin` and `linux`. Anything else exits 2.
- [ ] **Homebrew gate on macOS** — script exits 2 with manual-install instructions if `brew` not present (the script does NOT auto-install Homebrew).
- [ ] **Three locked modes** — `--check-only` (default), `--install`, `--auto`. Mutually exclusive.
- [ ] **Six locked prereqs in locked order** — node, pnpm, pm2, git, curl, tar. Node ≥ 18 enforced.
- [ ] **JSON envelope schema** — version, ts, os, package_manager, all_satisfied, prereqs[].
- [ ] **No live install attempts by worker** — explicit DONE-block attestation
- [ ] PR body: pre-flight 1-5 outputs verbatim, B.1-B.10 outputs verbatim, diff-lock confirmation, "no live install" attestation, sample `--check-only` and `--json` output captured

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 path (scripts/install-prereqs.sh new, mode 0755)
Branch: feat/v1.5.0-F.1-install-prereqs

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. F.1 target path absent: ✓
  3. platform: macOS, brew present, apt-get absent (expected) ✓
  4. host prereq snapshot: <captured for all 6 — node version, pnpm version, etc.>
  5. tooling: bash ≥ 3.2 ✓ shellcheck ≥ 0.7 ✓ awk ✓ sed ✓ grep ✓ cat ✓

Tests:
  B.1 bash -n: ✓ / shellcheck: 0 new warnings ✓
  B.2 --help output: <captured>
  B.3 --check-only on host: 6/6 satisfied, exit 0 ✓
  B.4 --json envelope: <captured single-line JSON>
       jq validation: version=1 + all_satisfied=true + 6 prereqs ✓
  B.5 unknown arg → exit 2 ✓
  B.6 conflicting modes → exit 2 ✓
  B.7 Ubuntu code-path grep: <captured matches for apt-get usage>
  B.8 idempotency: identical JSON modulo timestamp ✓
  B.9 diff-lock = 1 path: ✓
  B.10 file mode 0755: ✓

Worker scope attestations:
  - No live `--install` or `--auto` invocation in worker turn
  - No new packages installed on host
  - All install command strings are emitted via echo/printf, never eval'd or executed
  - Live ~/.neato-hive/ unchanged
  - Live system PATH state unchanged (verified by `which node pnpm pm2 git curl tar` before and after)

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full prereq detection + all three modes (--check-only, --install, --auto) + --json output + --help in single PR. No "we'll add --auto in a follow-up."
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT INSTALL ANY PREREQS DURING WORKER TURN** — the worker runs only `--check-only` against the host. `--install` and `--auto` are tested via shellcheck + code review at the spec-author level. B.11 enforces.
- **DO NOT AUTO-INSTALL HOMEBREW** — if `brew` is missing on macOS, exit 2 with manual-install instructions. Auto-installing Homebrew is a system-altering chained shell call that requires explicit user consent outside this script's scope.
- **DO NOT ATTEMPT NODE UPGRADE** — if Node is present but `< 18`, report and exit 1 with manual upgrade instructions. Auto-upgrading across major Node versions is too risky cross-platform.
- **DO NOT EVAL UNTRUSTED STRINGS** — install commands are emitted via `echo`/`printf` for logging, then run via direct invocation (e.g. `brew install node`, NOT `eval "${INSTALL_CMD}"`). String-based eval is a wedge for command injection and is forbidden.
- **DO NOT USE GUI INSTALLER LIBRARIES** — F.1 is plain bash. GUI dialogs (osascript on Mac, zenity on Ubuntu) belong to G/H. F.1's CLI prompts are stdin-based only.
- **DO NOT SKIP `set -euo pipefail`** — strict mode mirrors `scripts/release.sh` (B.1) and prevents silent failures.
- **OS DETECTION IS LOCKED** — `darwin` and `linux` only. Anything else exits 2 with `"ERROR: unsupported OS '${uname}'. Neato Hive supports macOS and Ubuntu Linux."`.
- **PNPM AND PM2 INSTALL VIA NPM** — never `brew install pnpm` or `brew install pm2`. The npm-global path is cross-platform consistent and stays close to upstream.
- **SUDO ONLY ON UBUNTU NOT-AS-ROOT** — never on macOS (Homebrew explicitly prohibits running as root).
- **EXIT CODES LOCKED** — 0 / 1 / 2 with the meanings in §CLI shape. F.2 and F.3 will branch on these codes; do not rearrange.
- **JSON ENVELOPE LOCKED AT `version: "1"`** — F.2 and F.3 read this envelope. Any future schema change requires a major-version bump, not a silent mutation.
- **HALT-and-ping rule** — pre-flight surprises (target path already exists, shellcheck missing on host, brew unexpectedly absent on macOS host) stop the worker. **HALT MEANS HALT — do not fix-and-proceed inline.**
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **F.2 install.sh** — fresh-install flow. Calls `bash scripts/install-prereqs.sh --check-only --json` first; aborts cleanly if `all_satisfied: false`. Then calls `--auto` if user opted-in via the install.sh CLI flag (`bash install.sh --install-prereqs`). Then proceeds to download tarball, verify checksum, extract, generate dashboard token.
- **F.3 setup-wizard integration** — the existing `setup.sh` wizard amends to call `bash scripts/install-prereqs.sh --auto --json` early in the flow, parses the JSON to render its own progress UI, and ABORTS the wizard if any prereq install fails.
- **G.1 Mac GUI installer** — uses `osascript` dialogs to wrap `bash scripts/install-prereqs.sh --auto` with platform-native confirms. Reads JSON to render dialog content.
- **H.1 Ubuntu GUI installer** — uses `zenity` to wrap the same script with platform-native confirms.
- **Future leaf — Node version auto-upgrade.** If owner ever wants the script to auto-upgrade Node across major versions (e.g. via `nvm` or NodeSource), add a `--upgrade-node` flag in a future leaf. Out of F.1 scope.
- **Future leaf — Windows / WSL support.** v1.5.0 ships macOS + Ubuntu only per Phase I scope. WSL detection (`grep -qi microsoft /proc/version`) and PowerShell wrappers can land in a v1.6.x leaf if owner expands platform scope.
- **Future leaf — telemetry.** A `--report-to <url>` flag could emit the JSON envelope to a remote endpoint for install-base analytics. Out of v1.5.0 scope (Phase A's `installs` table is forward-flex but not yet wired).
