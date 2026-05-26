# v1.5.0 F.2 — Fresh-Install Flow (`install.sh`)

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** F — Install script (3 PRs)
**Leaf:** F.2 (2 of 3 in Phase F)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** F.1 ✅ `b1d7b5c` (`scripts/install-prereqs.sh`), Phases A/B/C/D ✅, E.1–E.5 ✅.
**Successors:** F.3 (setup-wizard integration); J.1 (full E2E on a clone); J.2 (tag + tarball push — the moment "downloadable from the website" becomes true for end users).

---

## Goal

Ship `install.sh` at the framework repo root. This is the script that the eventual end-user runs as:

```
curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
```

…and ends up with a working Hive on a fresh Mac or Ubuntu machine, no manual prereq juggling required.

Per the **2026-05-09 owner directive** (Daniel): "make sure that the installer is built to install any dependencies that are required to properly operate." F.2 owns this end-to-end path. Default behavior is **auto-install missing prereqs**, then download the tarball, verify it, extract it, generate a dashboard token. Power-users who want manual control over prereq install can pass `--no-install-prereqs` to abort instead.

The script is the user-facing artifact. The user-experience contract:

1. **Single command.** `curl ... | bash` is the canonical invocation. No multi-step setup before it.
2. **Self-contained.** install.sh embeds the minimum prereq detection logic INLINE (mirrors F.1's logic but does not depend on it being already-installed — chicken-and-egg). After tarball extract, the in-tarball `scripts/install-prereqs.sh` (F.1) is the source-of-truth for future runs (`hive update`, `hive doctor`, etc.).
3. **Idempotent on re-run.** Running install.sh against a system where Hive is already installed → abort cleanly with "use `hive update` instead." No data loss.
4. **Auto-install prereqs by default.** Missing Node ≥ 18, pnpm, pm2, git, tar are installed via Homebrew (macOS) or apt-get (Ubuntu) without prompting. User can opt out with `--no-install-prereqs` (abort if any missing) or downgrade to interactive prompts with `--interactive-prereqs`.
5. **Verify everything.** SHA-256 checksum match required before extract. Tarball staged on same filesystem as target before atomic rename.
6. **Generate a fresh dashboard token.** 256-bit hex via `openssl rand -hex 32`. Written to `.env` and mirrored to `~/.config/neato-hive/dashboard-token` with mode 0600.
7. **Print clear next steps.** After install, the user sees the literal command to start Hive (`cd ~/neato-hive && pm2 startOrReload ecosystem.config.cjs && pm2 save`) and the dashboard URL + token.
8. **No automatic PM2 reload.** install.sh prints the command; the user runs it. (Same pattern as C.7's migration banner.) F.3 may amend this if owner wants the wizard to auto-start.

**Owner directive lock:** the installer MUST attempt to install missing prereqs by default — not just detect-and-fail. The existing `scripts/install-prereqs.sh` (F.1) already supports this via `--auto`; F.2 wires the equivalent inline logic for the bootstrap moment, then defers to F.1 for any post-install upgrades.

**Non-goals (explicit drops):**
- No `--upgrade` mode. Updates use `hive update` (post-install). install.sh is fresh-install only.
- No GUI prompts. F.2 is plain CLI. G.1 / H.1 wrap install.sh with osascript / zenity.
- No setup-wizard integration. F.3 owns that.
- No auto-start of PM2. User runs `pm2 startOrReload` themselves. (See "non-goals" above.)
- No multi-tenant install (v1.5.0 ships single-Hive per machine).
- No `--upgrade-node` for present-but-too-old Node. install.sh aborts in that case with a clear message; user runs `brew upgrade node` themselves.
- No telemetry / install-base reporting (Phase A's `installs` table is forward-flex, not yet wired).
- No Windows / WSL. Phase I confirms Ubuntu only; F.2 inherits.

---

## Architectural givens (carried)

### File location

`install.sh` at framework repo ROOT. Mirrors the convention of homebrew-install, nvm install, etc. The site repo serves this file at `https://neato-hive-site.vercel.app/install.sh` (B.2's site-publish or future J.2 release-ceremony amends to copy this file alongside the tarball).

**Framework root, NOT `scripts/install.sh`.** Reasons:
- It's the user-facing artifact (they'll see it on the website, may inspect via `curl ... | less`)
- It's NOT meant to be invoked from inside an existing install (that's `hive update`)
- Convention.

### Existing scripts to defer to / not duplicate

- `scripts/install-prereqs.sh` (F.1, b1d7b5c) — POST-extract, the in-tarball copy is available. install.sh's INLINE prereq-detection is intentionally simpler and is only used during the bootstrap window. After install, future operations use the in-tarball script.
- `setup.sh` (existing) — wizard-tier setup (Discord, Claude CLI, agent config). install.sh does NOT call setup.sh. F.3 (later leaf) wires that integration.
- `scripts/release.sh` / `scripts/release-publish.sh` — release pipeline. install.sh is the consumer end of that pipeline.

### Locked CLI surface

```
Usage: bash install.sh [OPTIONS]
  curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
  curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --check-only

Options:
  --check-only             Dry run. Detect OS + prereqs + existing install; report; exit 0/1.
                           No tarball download, no install actions, no token generation.
  --no-install-prereqs     Abort with exit 1 if any required prereq is missing.
                           Skip the auto-install step.
  --interactive-prereqs    Prompt [Y/n] before installing each missing prereq.
                           Default behavior is auto-install without prompts.
  --yes, -y                Explicit acknowledgment of default auto-install behavior.
                           No-op when already default; reserved for future safety prompts.
  --target-dir=<path>      Override the install location. Default: $HOME/neato-hive.
                           For testing; production users do not pass this.
  --api-url=<url>          Override the release-metadata URL.
                           Default: $HIVE_RELEASES_API or https://neato-hive-site.vercel.app/api/current.
                           For testing.
  --skip-checksum          DO NOT USE. Disables SHA-256 verification of the tarball.
                           For testing only. Worker MUST flag if used in production.
  -h, --help               Show this help and exit 0.
  --version                Show script version and exit 0.

Exit codes:
  0   Install succeeded; dashboard token generated; next-steps printed.
  1   Install aborted (existing install detected, prereq missing with --no-install-prereqs,
      checksum mismatch, download failure, extract failure, post-install verification failure).
  2   Bad args, unsupported OS, or fatal pre-condition.
```

### Locked OS detection

Identical contract to F.1: `darwin` (uname Darwin), `linux` (uname Linux + apt-get present), anything else exits 2. The detection logic is inline — install.sh does NOT depend on F.1 being already-installed at this point.

### Locked prereq vocabulary (the bootstrap subset)

install.sh's inline prereq check covers the SAME six prereqs as F.1, but the bootstrap version may relax `tar` since it's required to extract the tarball (chicken-and-egg). The check order is:

| Index | Name | Min version | Bootstrap detection | Post-bootstrap notes |
|---|---|---|---|---|
| 1 | `bash` | (any 3.2+) | Implicit — install.sh runs in bash | install-prereqs.sh enforces |
| 2 | `curl` | (any) | Implicit — user used curl to fetch install.sh | Re-checked by install-prereqs.sh post-install |
| 3 | `tar` | (any) | Required for tarball extract; checked first | Re-checked by install-prereqs.sh |
| 4 | `node` | `≥ 18` | Required for JSON parse + post-install pnpm | Auto-installed via brew or apt-get |
| 5 | `pnpm` | (any) | Required for `pnpm install --frozen-lockfile` | Auto-installed via npm install -g pnpm |
| 6 | `pm2` | (any) | Required to start hive-dashboard | Auto-installed via npm install -g pm2 |
| 7 | `git` | (any) | NOT required for fresh tarball install (no clone). install-prereqs.sh checks at upgrade time. | Skipped at bootstrap; install-prereqs.sh handles |
| 8 | `openssl` | (any) | Required for token generation (`openssl rand -hex 32`) | Pre-installed on Mac + Ubuntu; check anyway |

**Lock:** install.sh prereq-check order is `bash, curl, tar, node, pnpm, pm2, openssl`. `git` is NOT in the bootstrap list — fresh tarball install does not need git; install-prereqs.sh re-checks it when invoked post-install. This is a deliberate scope reduction for the bootstrap moment.

If `--no-install-prereqs` is passed, install.sh exits 1 if any are missing. Default behavior installs them.

### Locked install actions (per OS)

| OS | Package manager | Node | pnpm | pm2 | tar | openssl | git (skipped) |
|---|---|---|---|---|---|---|---|
| `darwin` | brew | `brew install node` | `npm install -g pnpm` | `npm install -g pm2` | preinstalled | preinstalled | (not at bootstrap) |
| `linux` (apt-get) | apt-get | `curl ... NodeSource ... \| sudo bash; sudo apt-get install -y nodejs` | `npm install -g pnpm` | `npm install -g pm2` | `sudo apt-get install -y tar` | preinstalled | (not at bootstrap) |

**Homebrew gate (macOS):** install.sh checks `command -v brew`; if absent, prints the manual-install instruction (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`) and exits 2. install.sh does NOT auto-install Homebrew — user must consent explicitly to running an upstream install script.

**`sudo` handling on Linux:** if running as root, no `sudo`. Else, prefix `sudo`. install.sh does not cache or store the sudo password.

### Locked existing-install detection

```bash
TARGET_DIR="${HIVE_INSTALL_TARGET:-$HOME/neato-hive}"
# Treat any of these as "existing install" — abort to protect user data
if [ -d "${TARGET_DIR}/agents" ] \
   || [ -f "${TARGET_DIR}/package.json" ] \
   || [ -f "${TARGET_DIR}/.env" ] \
   || [ -d "${TARGET_DIR}/.git" ]; then
  abort_existing_install
fi
```

`abort_existing_install` prints:
```
A Neato Hive install was detected at ${TARGET_DIR}.

This script does NOT update existing installs (it would replace your data).

To update: run `hive update` from the existing install.
To start fresh: back up ${TARGET_DIR} first, remove it, then re-run this script.
```

Exit code 1.

### Locked download / verify / extract

```
1. Fetch ${HIVE_RELEASES_API:-https://neato-hive-site.vercel.app/api/current} via curl.
   Save to /tmp/neato-hive-current-${UID}.json.
   Fail-clear on HTTP 4xx/5xx or empty body.

2. Parse current.json via node:
     TARBALL_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).tarball_url)" /tmp/...)
     CHECKSUM=$(... .checksum_sha256)
     VERSION=$(... .version)
   Fail-clear if any field is missing or malformed.

3. Download tarball to /tmp/neato-hive-v${VERSION}.tar.gz via curl.
   Fail-clear on HTTP error or zero-byte download.

4. Verify SHA-256:
   - macOS: COMPUTED=$(shasum -a 256 /tmp/neato-hive-v${VERSION}.tar.gz | awk '{print $1}')
   - Linux: COMPUTED=$(sha256sum /tmp/neato-hive-v${VERSION}.tar.gz | awk '{print $1}')
   - if [ "${COMPUTED}" != "${CHECKSUM}" ]; then abort_checksum_mismatch; fi
   --skip-checksum bypasses this for testing only; install.sh prints WARNING in red.

5. Stage to same FS as TARGET_DIR:
     STAGING="${TARGET_DIR}.staging-${PID}"
     mkdir -p "${STAGING}"
     tar -xzf /tmp/neato-hive-v${VERSION}.tar.gz -C "${STAGING}"
   Tarball contents are under dist-pkg/ (per release.sh B.1 contract).
   Validate: test -d "${STAGING}/dist-pkg/dist", "${STAGING}/dist-pkg/bin", etc.

6. Atomic-rename: mv "${STAGING}/dist-pkg" "${TARGET_DIR}".
   On failure (cross-FS mv falls back to copy+delete which is non-atomic), print
   the diagnostic and exit 1 with cleanup of staging and tarball.

7. Cleanup:
     rm -rf "${STAGING}"
     rm -f /tmp/neato-hive-v${VERSION}.tar.gz
     rm -f /tmp/neato-hive-current-${UID}.json
```

### Locked post-install setup

```
1. cd ${TARGET_DIR}
2. pnpm install --frozen-lockfile
   - Fails fast if lockfile drift (would indicate tarball corruption).
3. Generate token: TOKEN=$(openssl rand -hex 32)
4. Write to .env (append-mode, never touch existing lines):
     printf '\nHIVE_DASHBOARD_TOKEN=%s\n' "${TOKEN}" >> .env
   Note: .env may not exist on a fresh install. install.sh creates it.
5. Mirror token to ~/.config/neato-hive/dashboard-token:
     mkdir -p ~/.config/neato-hive
     printf '%s' "${TOKEN}" > ~/.config/neato-hive/dashboard-token
     chmod 600 ~/.config/neato-hive/dashboard-token
6. Print success block (see §Locked output).
```

### Locked output (human-readable)

```
==> Neato Hive Installer (v1.5.0)

  ✓ macOS (darwin)
  ✓ Homebrew installed
  ✓ tar (preinstalled)
  ✓ curl (preinstalled — used to fetch this installer)
  ✓ openssl (preinstalled)
  ✗ node (missing) — auto-installing via `brew install node`...
    ✓ node 22.5.0 installed
  ✗ pnpm (missing) — auto-installing via `npm install -g pnpm`...
    ✓ pnpm 9.0.6 installed
  ✗ pm2 (missing) — auto-installing via `npm install -g pm2`...
    ✓ pm2 5.4.1 installed

==> Fetching release metadata from https://neato-hive-site.vercel.app/api/current
  Latest version: 1.5.0
  Tarball:        https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz
  Checksum:       a1b2c3d4...

==> Downloading tarball (~5 MB)
  ✓ Saved to /tmp/neato-hive-v1.5.0.tar.gz
  ✓ SHA-256 verified

==> Extracting to /Users/glados/neato-hive
  ✓ Extracted dist-pkg/ to staging
  ✓ Atomic-rename to /Users/glados/neato-hive
  ✓ Cleanup complete

==> Post-install setup
  ✓ pnpm install --frozen-lockfile
  ✓ Generated dashboard token
  ✓ Wrote .env
  ✓ Mirrored token to ~/.config/neato-hive/dashboard-token

==> ✓ Install complete!

Next steps to start Hive:

  cd /Users/glados/neato-hive
  pm2 startOrReload ecosystem.config.cjs
  pm2 save

Then visit the dashboard at:

  http://localhost:7777/login.html

Your dashboard token (save it — you'll paste it on the login page):

  9f3a8e7d6c5b4a3...

Token also saved at: /Users/glados/.config/neato-hive/dashboard-token

For setup beyond the dashboard (Discord bot, agents, Claude CLI):

  cd /Users/glados/neato-hive
  ./setup.sh

Spec / docs: https://github.com/anthonyconnelly/neato-hive
```

### Output discipline

- Default mode: human-readable colored output to stdout. ANSI codes when `[ -t 1 ]`.
- `--check-only` mode: same output but stops after prereq + existing-install checks; no tarball action; exit code reflects state (0 = ready, 1 = blocked).
- All install-progress (brew/apt-get/npm output) goes to stdout for the user to follow.
- Errors go to stderr.

---

## Pre-conditions

- F.1 ✅ merged at `b1d7b5c` (`scripts/install-prereqs.sh` exists in framework — install.sh does NOT depend on it pre-install but the in-tarball copy is the source-of-truth post-install for the consumer)
- Phases A + B + C + D ✅ — site, release script, hive update, dashboard backend all live
- E.1–E.5 ✅ — dashboard frontend up to and including Updates page
- macOS test environment available to Bob; the worker runs in `~/neato-hive` on the host
- `bash` ≥ 3.2, standard Unix surface (`curl`, `awk`, `sed`, `grep`, `tar`, `shasum`/`sha256sum`, `mktemp`)
- A test fixture for the API + tarball must be produced for B.7 (a synthetic `current.json` + tarball pair, hosted via `file://` URL or a local HTTP server)

---

## Where state lives (F.2 conventions)

**New files (1):**
- `install.sh` — the script, at framework repo ROOT (mode 0755).

**Modified files (0):**
- (none — `setup.sh`, `scripts/install-prereqs.sh`, `package.json`, etc. all UNCHANGED)

**Total: 1 path.**

**No new dependencies.** install.sh uses bash + standard Unix surface (`curl`, `tar`, `awk`, `sed`, `grep`, `mktemp`, `openssl`, `shasum`/`sha256sum`, `node` post-prereq-check).

---

## Pre-flight (worker MUST run all 7; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `b1d7b5c` (F.1 merge) plus this F.2 spec commit.

### 2. F.2 target path absent

```bash
test ! -f install.sh && echo "install.sh absent ✓"
```

**HALT and ping raymond-holt** if `install.sh` already exists at framework root.

### 3. F.1 surface present (in-tarball reference; install.sh does NOT depend on it pre-install)

```bash
test -f scripts/install-prereqs.sh && echo "scripts/install-prereqs.sh present ✓"
test -x scripts/install-prereqs.sh && echo "  executable ✓"
```

### 4. Existing-install detection signals on host (informational)

```bash
ls -la ~/neato-hive 2>&1 | head -5
test -d ~/neato-hive/agents && echo "agents/ present (host has existing install — TARGET_DIR override REQUIRED for tests)"
```

Worker captures the host state. **Crucial for testing:** the worker MUST use `--target-dir=/tmp/F2-sandbox` for all install-actually-runs tests so the host's real `~/neato-hive` is NOT touched.

### 5. Tooling

```bash
bash --version | head -1
which curl awk sed grep tar mktemp openssl
which shasum sha256sum 2>&1 | head -2
shellcheck --version | head -2
```

Expected: bash ≥ 3.2, all standard utilities present, shellcheck ≥ 0.7. **HALT and ping raymond-holt** if shellcheck is missing.

### 6. Site is reachable (informational; B.7 tests use a fixture, not the live site)

```bash
curl -sI https://neato-hive-site.vercel.app/api/current 2>&1 | head -3
```

Captures the HTTP response header. Live site may be 4xx until J.2 publishes a real release; that's fine. B.7 uses a fixture.

### 7. Release tarball can be built locally for B.7 fixture

```bash
test -x scripts/release.sh && echo "release.sh present ✓"
node -e "console.log(require('./package.json').version)"
```

Worker uses `scripts/release.sh <current-version>` in B.7 to build a fixture tarball, then serves it via `file://` URL with a hand-written `current.json`.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-F.2-fresh-install`.

**Diff lock: 1 path exactly** (`install.sh` new, mode 0755).

### A.1 — `install.sh` (framework root, mode 0755)

The script. Locked structure (in this order):

1. `#!/usr/bin/env bash` shebang
2. `set -euo pipefail`
3. Comment block: purpose, usage, exit codes, contract reference
4. Constants: `SCRIPT_VERSION="1.5.0"`, `MIN_NODE_MAJOR=18`, default `HIVE_RELEASES_API`, default `TARGET_DIR=$HOME/neato-hive`, prereq order
5. Color helpers (suppressed on non-TTY): `print_step`, `print_success`, `print_warning`, `print_error`
6. Argument parsing — `--check-only`, `--no-install-prereqs`, `--interactive-prereqs`, `--yes`/`-y`, `--target-dir=`, `--api-url=`, `--skip-checksum`, `-h`/`--help`, `--version`. Mode flags are mutually exclusive (`--check-only` vs `--no-install-prereqs` vs `--interactive-prereqs` vs default).
7. OS detection: `detect_os()` → `darwin` or `linux`; `detect_package_manager()` → `brew` or `apt-get`; HALT with exit 2 on unsupported.
8. Per-prereq inline detection: `_check_bash`, `_check_curl`, `_check_tar`, `_check_node`, `_check_pnpm`, `_check_pm2`, `_check_openssl`. Each echoes detected version on stdout (or empty), returns 0 (satisfied) or 1 (missing/too-old).
9. Per-prereq inline install: `_install_node`, `_install_pnpm`, `_install_pm2`, `_install_tar`. Functions shell out to `brew` / `apt-get` / `npm` directly (NOT via `eval`).
10. Existing-install detection: `_check_existing_install` — returns 0 if existing install detected (caller aborts), 1 if clean.
11. Tarball download: `_fetch_metadata`, `_parse_metadata` (via node), `_download_tarball`, `_verify_checksum`.
12. Extract: `_stage_extract`, `_atomic_swap`, `_cleanup_staging_and_tarball`.
13. Post-install: `_run_pnpm_install`, `_generate_token`, `_write_env`, `_mirror_token`.
14. Print success block + next-steps.
15. Main flow:
    - Parse args
    - Print banner
    - Detect OS + package manager (HALT on unsupported)
    - Existing-install check (ABORT with exit 1 if detected; print clear message)
    - Prereq detection (every prereq, accumulate state)
    - If `--check-only`: print report, exit 0/1 based on state
    - If `--no-install-prereqs` AND any missing: ABORT with exit 1
    - Else: install missing prereqs (default: auto; `--interactive-prereqs`: prompt each)
    - Re-check prereqs after install; ABORT with exit 1 if any still missing
    - Fetch metadata, parse, download tarball, verify checksum
    - Stage + extract + atomic-swap to TARGET_DIR
    - cd TARGET_DIR; pnpm install --frozen-lockfile
    - Generate token; write .env; mirror to ~/.config/neato-hive/dashboard-token (mode 0600)
    - Print success + next-steps + token
    - exit 0
16. Function bodies kept under 40 lines each where possible.

**Locked semantics:**

- **Argument order does not matter.** `--target-dir=/tmp/x --check-only` and `--check-only --target-dir=/tmp/x` are equivalent.
- **Conflicting modes return exit 2.** E.g. `--check-only --no-install-prereqs` exits 2 with `"ERROR: --check-only and --no-install-prereqs are mutually exclusive"`.
- **Unknown args return exit 2.** E.g. `--foo` exits 2 with `"ERROR: unknown argument '--foo'"`.
- **`--target-dir=<path>`** is a mandatory override for any test invocation that actually runs installs. Worker MUST use this for B.7. Production users do not pass it (they get the default `$HOME/neato-hive`).
- **`--api-url=<url>`** override is for B.7 fixture testing. Production users do not pass it.
- **`--skip-checksum`** bypasses SHA-256 verification. Worker uses it ONLY in B.7 tests where the fixture's checksum is the verification target. Production users MUST NOT use this; install.sh prints a WARNING in red when invoked.
- **`set -euo pipefail`** mandatory. Strict mode mirrors `scripts/release.sh` discipline.
- **`tar -xzf` extraction is constrained:** tarball contents must be under `dist-pkg/` (per release.sh B.1 contract). install.sh validates by testing `[ -d "${STAGING}/dist-pkg/dist" ]` post-extract.
- **Atomic rename ON SAME FS:** staging is `${TARGET_DIR}.staging-${PID}` (sibling of TARGET_DIR), so `mv` is a rename, not a copy.
- **Token format:** `openssl rand -hex 32` produces 64 hex characters (256 bits). install.sh validates length and rejects malformed output.
- **`.env` write is APPEND-ONLY.** install.sh `>>` appends `\nHIVE_DASHBOARD_TOKEN=<token>\n` — never edits or deletes existing lines. On a fresh install, .env doesn't exist; the append creates it.

### A.2 — Top-of-file comment block

```bash
#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# install.sh — Neato Hive fresh-install bootstrap.
#
# Usage:
#   curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
#   curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --check-only
#   bash install.sh [OPTIONS]
#
# Default mode: auto-install missing prereqs (Node, pnpm, pm2, tar) via
# the platform package manager (Homebrew on macOS, apt-get on Ubuntu),
# then download the latest release tarball, verify its checksum, extract
# it to $HOME/neato-hive, generate a dashboard token, write .env.
#
# Power users can opt out with --no-install-prereqs (abort if any missing)
# or --interactive-prereqs (prompt before each install).
#
# Existing installs are detected and aborted — use `hive update` instead.
#
# v1.5.0 F.2 — Spec: docs/v1.5.0-tasks/F.2-fresh-install.md
# Consumes:
#   - F.1 scripts/install-prereqs.sh (post-install, in-tarball)
#   - C.5 hive update --check --json (post-install)
#   - D.x dashboard endpoints (post-install)
# Produces:
#   - $HOME/neato-hive (the install)
#   - $HOME/neato-hive/.env (HIVE_DASHBOARD_TOKEN)
#   - $HOME/.config/neato-hive/dashboard-token (mode 0600)
#-----------------------------------------------------------------------
```

---

## B. Tests + verification

### B.1 — Bash syntax + shellcheck

```bash
bash -n install.sh && echo "bash -n: ✓"
shellcheck install.sh 2>&1 | tee /tmp/F2-shellcheck.out | tail -20
# Expected: zero warnings (or only inline-disabled with rationale).
# Info-level SC2329 acceptable (mirrors F.1 precedent).
```

### B.2 — `--help` and `--version`

```bash
bash install.sh --help 2>&1 | head -30
echo "exit code: $?"
# Expected: usage block per §Locked CLI surface; exit 0

bash install.sh --version 2>&1
# Expected: "1.5.0", exit 0
```

### B.3 — `--check-only` on host (no install actions, no tarball download)

```bash
# Host has existing install at ~/neato-hive — --check-only must abort with that signal.
bash install.sh --check-only 2>&1 | head -20
EC=$?
echo "exit code: $EC"
# Expected: existing-install detected at ~/neato-hive; exit 1 (cleanly, NOT exit 2 — exit 2 is for bad args)
```

### B.4 — `--check-only --target-dir=<empty-tmp>` against a clean dir

```bash
SANDBOX=/tmp/F2-check-empty-$$
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"

bash install.sh --check-only --target-dir="$SANDBOX" 2>&1 | tee /tmp/F2-check.out
EC=$?
echo "exit code: $EC"
# Expected: prereq detection reports state of host's prereqs; existing-install check passes (sandbox is clean);
# dry run reports "ready to install"; exit 0 (since prereqs are present + sandbox clean).
# No tarball download or install actions actually performed.

rm -rf "$SANDBOX"
```

### B.5 — Bad args + mutually-exclusive modes

```bash
bash install.sh --not-a-real-flag 2>&1 | head -3
echo "exit code: $?"
# Expected: ERROR + exit 2

bash install.sh --check-only --no-install-prereqs 2>&1 | head -3
echo "exit code: $?"
# Expected: mutually-exclusive ERROR + exit 2
```

### B.6 — Existing-install detection (synthetic)

```bash
SANDBOX=/tmp/F2-existing-$$
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/agents/atlas"
echo "fixture" > "$SANDBOX/agents/atlas/IDENTITY.md"

bash install.sh --check-only --target-dir="$SANDBOX" 2>&1 | head -10
EC=$?
echo "exit code: $EC"
# Expected: "A Neato Hive install was detected at /tmp/F2-existing-...", exit 1

rm -rf "$SANDBOX"
```

Repeat with `package.json` instead of `agents/`:
```bash
SANDBOX=/tmp/F2-existing2-$$
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
echo '{"name":"existing"}' > "$SANDBOX/package.json"

bash install.sh --check-only --target-dir="$SANDBOX" 2>&1 | head -10
EC=$?
echo "exit code: $EC (expected 1)"

rm -rf "$SANDBOX"
```

### B.7 — Full install against a fixture (worker-scope sandbox)

This is the critical end-to-end test. Worker builds a fixture tarball using `scripts/release.sh`, hand-writes a `current.json`, serves both via `file://` URL, then runs install.sh against a temp target-dir.

```bash
# Build fixture tarball
cd ~/neato-hive
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
bash scripts/release.sh "${CURRENT_VERSION}" 2>&1 | tail -3
TARBALL_SHA=$(awk '{print $1}' "/tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt")

# Hand-write current.json with file:// tarball URL
mkdir -p /tmp/F2-fixture
cat > /tmp/F2-fixture/current.json <<EOF
{
  "version": "${CURRENT_VERSION}",
  "tarball_url": "file:///tmp/neato-hive-v${CURRENT_VERSION}.tar.gz",
  "checksum_sha256": "${TARBALL_SHA}",
  "released_at": "2026-05-09T00:00:00Z",
  "changelog_url": "file:///tmp/F2-fixture/changelog.html"
}
EOF

# Run install.sh against sandbox target dir, fixture API URL
SANDBOX=/tmp/F2-install-$$
rm -rf "$SANDBOX"

bash install.sh \
  --target-dir="$SANDBOX" \
  --api-url="file:///tmp/F2-fixture/current.json" 2>&1 | tee /tmp/F2-install.out

EC=$?
echo "exit code: $EC"

# Expected: full install succeeds against sandbox.
test -d "$SANDBOX" && echo "sandbox dir created ✓"
test -d "$SANDBOX/dist" && echo "dist/ extracted ✓"
test -d "$SANDBOX/bin" && echo "bin/ extracted ✓"
test -f "$SANDBOX/package.json" && echo "package.json extracted ✓"
test -f "$SANDBOX/.env" && echo ".env created ✓"
grep -E '^HIVE_DASHBOARD_TOKEN=[a-f0-9]{64}$' "$SANDBOX/.env" && echo "token written 64 hex chars ✓"

# Token mirror
TOKEN_MIRROR_PATH="${HOME}/.config/neato-hive/dashboard-token"
# WORKER NOTE: this path is the user's real ~/.config/. Worker MUST verify
# AFTER B.7 that the mirror path is unchanged from before (since --target-dir
# does NOT redirect the token mirror). If install.sh writes to the user's
# real ~/.config/, that's a worker-scope leak — HALT and ping raymond-holt.
# Spec amendment: install.sh ALSO honors HIVE_TOKEN_MIRROR_DIR env var
# for testing. Worker exports HIVE_TOKEN_MIRROR_DIR=/tmp/F2-mirror-$$ for B.7.

# Cleanup
rm -rf "$SANDBOX" /tmp/F2-fixture /tmp/F2-install.out
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

**Spec amendment captured inline:** install.sh MUST honor `HIVE_TOKEN_MIRROR_DIR` env var for the token-mirror path (default `$HOME/.config/neato-hive`). Worker exports this for B.7 to avoid touching the host's real `~/.config/`.

### B.8 — Token format verification

```bash
# After B.7 install:
test -f "$SANDBOX/.env" || echo "FAIL — no .env"
TOKEN=$(grep -E '^HIVE_DASHBOARD_TOKEN=' "$SANDBOX/.env" | cut -d= -f2)
echo "Token length: ${#TOKEN}"
echo "Token regex: $(echo "$TOKEN" | grep -E '^[a-f0-9]{64}$' >/dev/null && echo MATCH || echo MISMATCH)"
# Expected: length 64, regex MATCH
```

### B.9 — Checksum mismatch aborts cleanly

```bash
# Re-run B.7 setup but with a deliberately-wrong checksum
cat > /tmp/F2-fixture/current.json <<EOF
{
  "version": "${CURRENT_VERSION}",
  "tarball_url": "file:///tmp/neato-hive-v${CURRENT_VERSION}.tar.gz",
  "checksum_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "released_at": "2026-05-09T00:00:00Z",
  "changelog_url": "file:///tmp/F2-fixture/changelog.html"
}
EOF

SANDBOX=/tmp/F2-mismatch-$$
rm -rf "$SANDBOX"

bash install.sh --target-dir="$SANDBOX" --api-url="file:///tmp/F2-fixture/current.json" 2>&1 | tail -10
EC=$?
echo "exit code: $EC (expected 1)"

# Verify abort cleaned up — sandbox should NOT have a partial install
test ! -d "$SANDBOX/dist" && echo "no partial extract ✓"

rm -rf "$SANDBOX" /tmp/F2-fixture
rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

### B.10 — `--no-install-prereqs` aborts when prereqs missing (synthetic via stripped PATH)

```bash
# Strip pnpm from PATH; prove --no-install-prereqs aborts with exit 1
PNPM_DIR="$(command -v pnpm | sed 's|/pnpm$||')"
ORIGINAL_PATH="$PATH"
STRIPPED_PATH="$(echo "$PATH" | tr ':' '\n' | grep -v "^$PNPM_DIR$" | tr '\n' ':' | sed 's/:$//')"

PATH="$STRIPPED_PATH" bash install.sh --check-only --no-install-prereqs --target-dir=/tmp/F2-stripped-$$ 2>&1 | tail -10
EC=$?
echo "exit code: $EC (expected 1)"

PATH="$ORIGINAL_PATH"
```

### B.11 — Worker scope verification

```bash
# Capture host state BEFORE any tests
ls -la ~/neato-hive/.env 2>/dev/null | head -2
ls -la ~/.config/neato-hive/ 2>/dev/null

# Run all B.x tests (above)

# Re-check host state — must be unchanged
ls -la ~/neato-hive/.env 2>/dev/null | head -2
ls -la ~/.config/neato-hive/ 2>/dev/null
# Expected: identical to before. If worker accidentally hit the host's real
# install paths, HALT and report.
```

### B.12 — Diff-lock + file mode

```bash
git diff --stat main...feat/v1.5.0-F.2-fresh-install
# Expected: 1 file (install.sh)

ls -l install.sh
# Expected: -rwxr-xr-x or similar (mode 0755)

head -1 install.sh
# Expected: #!/usr/bin/env bash
```

### B.13 — Cleanup

```bash
rm -f /tmp/F2-*.out /tmp/F2-*.json
rm -rf /tmp/F2-fixture /tmp/F2-install-* /tmp/F2-existing*-* /tmp/F2-mismatch-* /tmp/F2-stripped-* /tmp/F2-check-empty-*
rm -f /tmp/neato-hive-v*.tar.gz /tmp/neato-hive-v*.checksums.txt
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 1 path exactly (`install.sh` new, mode 0755)
- [ ] B.1 `bash -n` clean; shellcheck zero new warnings (or only info-level `SC2329` acceptable per F.1 precedent)
- [ ] B.2 `--help` shows usage; `--version` echoes `1.5.0`; both exit 0
- [ ] B.3 `--check-only` on host detects existing install at `~/neato-hive`, aborts with exit 1
- [ ] B.4 `--check-only --target-dir=<clean>` reports prereqs + ready-state, exit 0
- [ ] B.5 bad args + mutually-exclusive modes return exit 2 with clear messages
- [ ] B.6 existing-install detection triggers on `agents/`, `package.json`, `.env`, `.git/`
- [ ] B.7 full install against fixture: sandbox dir created, tarball extracted, `.env` written with 64-hex token, post-install `pnpm install --frozen-lockfile` succeeded, exit 0
- [ ] B.8 token regex `^[a-f0-9]{64}$`, length 64
- [ ] B.9 checksum mismatch aborts with exit 1, NO partial extract left behind
- [ ] B.10 `--no-install-prereqs` aborts with exit 1 when prereqs missing
- [ ] B.11 worker-scope: host's `~/neato-hive/` and `~/.config/neato-hive/` unchanged before vs after the entire test run
- [ ] B.12 diff-lock = 1 path; file mode 0755; shebang `#!/usr/bin/env bash`
- [ ] **Owner directive lock — auto-install is the default behavior** (per 2026-05-09 Daniel directive). `--no-install-prereqs` is the explicit opt-out. `--interactive-prereqs` is the per-prereq prompt mode.
- [ ] **Existing-install detection covers `agents/`, `package.json`, `.env`, `.git/`** — protects user data from accidental wipe
- [ ] **`set -euo pipefail` mandatory** — mirrors release.sh discipline
- [ ] **Atomic rename uses same-FS staging** — `${TARGET_DIR}.staging-${PID}` is sibling of TARGET_DIR
- [ ] **Token written via append-only `>>`** — never edits existing .env lines
- [ ] **Token mirror at `~/.config/neato-hive/dashboard-token` mode 0600** — overridable via `HIVE_TOKEN_MIRROR_DIR` for testing
- [ ] **`HIVE_TOKEN_MIRROR_DIR` env override** for token mirror path — worker uses this in B.7
- [ ] **Worker MUST NOT touch host `~/neato-hive` or host `~/.config/neato-hive`** — all install actions go to `--target-dir=/tmp/F2-*` sandboxes; `HIVE_TOKEN_MIRROR_DIR=/tmp/F2-mirror-*` for token mirror
- [ ] **No PM2 verbs invoked by install.sh** — script prints the `pm2 startOrReload` instruction; user runs it
- [ ] **No setup.sh modification, no scripts/install-prereqs.sh modification** — F.2 ships standalone
- [ ] **No package.json or pnpm-lock.yaml changes**
- [ ] PR body: pre-flight 1-7 outputs verbatim, B.1-B.12 outputs verbatim, sample successful install transcript, sample checksum-mismatch abort, sample existing-install abort, diff-lock confirmation, "no host pollution" attestation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (install.sh new, mode 0755)
Branch: feat/v1.5.0-F.2-fresh-install

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. install.sh absent: ✓
  3. F.1 surface present: ✓
  4. host-install state: <captured — likely existing install at ~/neato-hive>
  5. tooling: bash ≥ 3.2 ✓ curl ✓ tar ✓ shasum/sha256sum ✓ openssl ✓ shellcheck ✓
  6. site reachable: <captured HTTP status>
  7. release.sh present + version: <captured>

Tooling check:
  bash -n: ✓
  shellcheck: 0 new warnings (info-only SC2329 acceptable)

Tests:
  B.2 --help / --version:
    --help: <captured first 10 lines>
    --version: 1.5.0 ✓
  B.3 --check-only on host:
    detected existing install at ~/neato-hive, exit 1 ✓
  B.4 --check-only --target-dir=<clean>:
    prereqs reported, ready-state, exit 0 ✓
  B.5 bad args / mutually-exclusive: exit 2 ✓
  B.6 existing-install detection:
    agents/ trigger: ✓
    package.json trigger: ✓
    (.env, .git/ — captured if tested separately)
  B.7 full fixture install:
    fixture tarball built: <path + sha>
    install.sh run with --target-dir=/tmp/F2-install-<pid> --api-url=file://...
    sandbox dir created: ✓
    dist/, bin/, package.json extracted: ✓
    .env written with 64-hex token: ✓
    pnpm install --frozen-lockfile: ✓
    exit 0 ✓
  B.8 token format: length 64, regex MATCH ✓
  B.9 checksum mismatch:
    abort with exit 1: ✓
    no partial extract left behind: ✓
  B.10 --no-install-prereqs aborts on missing: exit 1 ✓
  B.11 worker scope:
    host ~/neato-hive/.env BEFORE: <captured>
    host ~/neato-hive/.env AFTER: <captured — IDENTICAL>
    host ~/.config/neato-hive/ BEFORE: <captured>
    host ~/.config/neato-hive/ AFTER: <captured — IDENTICAL>
  B.12 diff-lock + file mode:
    1 path ✓
    mode 0755 ✓
    shebang ✓

Worker scope attestations:
  - All install actions ran against --target-dir=/tmp/F2-* sandboxes
  - HIVE_TOKEN_MIRROR_DIR=/tmp/F2-mirror-<pid> for token-mirror tests
  - Host's ~/neato-hive/ unchanged
  - Host's ~/.config/neato-hive/ unchanged
  - No real `pm2` invocations (script only prints the instruction)
  - No real `hive update` triggered
  - No real `setup.sh` invoked

Sample successful install transcript:
  <verbatim B.7 output, redacted of token>

Sample checksum-mismatch abort:
  <verbatim B.9 output>

Sample existing-install abort:
  <verbatim B.6 output>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-F.2-fresh-install
  <verbatim — exactly 1 line: install.sh>

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full installer (prereq detect + auto-install + tarball download + checksum verify + extract + atomic-swap + post-install setup + token + .env + mirror + success-print) in single PR.
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT TOUCH HOST `~/neato-hive` OR HOST `~/.config/neato-hive`** during testing. ALL install actions go to `--target-dir=/tmp/F2-*` sandboxes. `HIVE_TOKEN_MIRROR_DIR=/tmp/F2-mirror-*` overrides the token-mirror path. B.11 enforces.
- **DO NOT INVOKE `--install` ON THE HOST'S REAL HIVE** — even with a fresh sandbox, the prereq-install step (`brew install node`, `npm install -g pnpm`, etc.) DOES mutate the host's package state. Worker MUST verify host already has all prereqs (B.4 confirms) BEFORE running install.sh; if prereqs are present, install.sh skips the install step. If host is missing any, worker HALTs and pings raymond-holt — do NOT auto-install on the worker host without explicit raymond-holt + Daniel approval.
- **DO NOT EXEC PM2** — install.sh only PRINTS the `pm2 startOrReload` instruction. The user runs it. install.sh does NOT call `pm2` directly.
- **DO NOT INVOKE `setup.sh`** — F.3 wires the wizard. F.2 stops at "install complete + here's how to start."
- **DO NOT EXTEND DEPENDENCIES** — install.sh uses bash + standard Unix surface only.
- **DO NOT MODIFY F.1's `scripts/install-prereqs.sh`** — F.2 has its own inline prereq detection for the bootstrap moment. F.1's script is the source-of-truth for post-install operations (consumed by `hive doctor`, `hive update`, etc.).
- **DO NOT MODIFY `setup.sh`** — F.3 owns wizard integration. F.2 ships standalone.
- **DO NOT MODIFY `package.json` or `pnpm-lock.yaml`** — pure shell, no Node deps at the install.sh level.
- **AUTO-INSTALL IS THE DEFAULT (owner directive lock)** — per 2026-05-09 Daniel directive. `--no-install-prereqs` is the explicit opt-out. `--interactive-prereqs` is the per-prereq prompt mode. Default is unattended auto-install.
- **EXISTING-INSTALL DETECTION COVERS `agents/`, `package.json`, `.env`, `.git/`** — these all signal "this dir is already a Hive install." Protects user data from accidental wipe.
- **ATOMIC RENAME ON SAME FS** — `${TARGET_DIR}.staging-${PID}` is a sibling of TARGET_DIR. If TARGET_DIR's parent doesn't exist (`mkdir -p` it). If staging cross-FS, abort with diagnostic.
- **CHECKSUM VERIFY MANDATORY** — `--skip-checksum` exists for testing only and prints a red WARNING when used.
- **TOKEN MIRROR MODE 0600** — never world-readable.
- **`set -euo pipefail`** mandatory.
- **HALT-and-ping rule (L8 reinforcement) — halt means halt.** Pre-flight surprises (target path already exists, shellcheck missing, host has missing prereqs that would require auto-install on worker host) stop the worker. Do NOT fix-and-proceed inline. Transparency-after-the-fact is not equivalent to halting up-front. The judgment call is the PM's.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **F.3** — Setup-wizard integration. After F.2's fresh-install completes, F.3 wires `setup.sh` to run automatically (or via a clear next-step prompt) so the user can configure Discord + Claude + first agent. F.3 may also amend install.sh's success-print to chain into `setup.sh` directly when the user passes `--with-wizard`.
- **G.1** — macOS GUI installer wrapper. Calls `bash install.sh --interactive-prereqs` (or `--auto`) wrapped in osascript dialogs. Reads stdout to render dialog content.
- **H.1** — Ubuntu GUI installer wrapper. Same pattern with zenity dialogs.
- **B.x amendment / J.2 — release ceremony pushes install.sh to site root.** Currently `release-publish.sh` (B.2 merged) pushes the tarball + checksums. A small amendment will also copy `install.sh` to the site repo's root (`https://neato-hive-site.vercel.app/install.sh`). This may land as part of J.2 or as a B.3 follow-up. **THIS IS THE LAST STEP** before "downloadable from the website without GitHub" becomes the literal user experience.
- **J.1** — full E2E. Bob runs install.sh on a clone (or VM) end-to-end, then `pm2 startOrReload`, then opens dashboard, then runs `hive update` against a synthetic v1.5.1 to prove the upgrade flow.
- **J.2** — tag v1.5.0, build tarball, push to site, write release notes. Owner verifies on a clone before main install.
- **Future leaf — `--with-wizard` flag** — auto-chains into setup.sh after install. Out of F.2 scope; F.3 wires.
- **Future leaf — auto PM2 start** — currently the user runs `pm2 startOrReload ecosystem.config.cjs` themselves. A future leaf could auto-run this with explicit `--start-now` flag. Out of F.2 scope per "non-goals."
- **Future leaf — telemetry** — `--report-install` flag to POST to a `/api/installs` endpoint (Phase A's `installs` table is forward-flex but not yet wired). Out of v1.5.0 scope.
- **Future leaf — `--upgrade-node`** — auto-upgrade Node across major versions via nvm or NodeSource. Out of F.2 scope.
- **Future leaf — Windows / WSL** — Phase I confirms Ubuntu-only. WSL detection + PowerShell wrappers in v1.6.x.
