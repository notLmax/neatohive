# v1.5.0 J.1 — Full End-to-End Smoke Test

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** J — End-to-end + release ceremony
**Leaf:** J.1 (1 of 2 in Phase J)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** Phases A/B/C/D ✅, E.1–E.5 ✅, F.1 ✅ `b1d7b5c`, F.2 ✅ `92e4e54`, F.3 ✅ `bce8282`. **Phase F closed.**
**Successor:** J.2 (tag v1.5.0, build tarball, push tarball + install.sh to site repo, write release notes — owner-paced ceremony).

---

## Goal

Run the complete v1.5.0 packaging path end-to-end in a worker-scope sandbox and capture a verbatim transcript proving:

1. **`install.sh` works** — fixture `current.json` + tarball → install.sh → sandbox install completes successfully.
2. **Dashboard boots** — the just-installed dashboard process starts, listens on a non-default port, accepts the install-time-generated token.
3. **Dashboard endpoints respond** — `/api/health`, `/api/status`, `/api/agents`, `/api/doctor`, `/api/update/check` all return per spec.
4. **`hive update --check --json`** — works against the same fixture API.
5. **`setup.sh --post-install`** — the post-install banner detection fires correctly; `--help` shows the new flag (the wizard itself is NOT run end-to-end since it's interactive).

This is the **smoke test that gates J.2.** If J.1 fails, J.2 is blocked. If J.1 passes, the packaging path is green-lit for the release ceremony.

**Worker-scope safety (CRITICAL):**
- All actions in `/tmp/J1-*` sandboxes. Host's `~/neato-hive/`, `~/.config/neato-hive/`, and `~/.neato-hive/` are READ-ONLY references — must remain unchanged before/after.
- No real `pm2 start`, no real `hive update --yes`, no real Discord setup, no real Claude auth.
- Dashboard process bound to ephemeral port (37990) and torn down at end.
- Fixture tarball + fixture current.json built via `scripts/release.sh` against the worker's framework checkout. **Built-in framework version may be 1.4.9 (per F.2 transparency note) — that's fine for the smoke; the version mismatch with `install.sh`'s `SCRIPT_VERSION="1.5.0"` is a known cosmetic gap that resolves at J.2's package.json bump. J.1 just needs install.sh to succeed against ANY valid tarball.**

**Deliverable:**
- A single new file: `docs/v1.5.0-tasks/J.1-smoke-test-report.md` containing the verbatim transcript of the full smoke run, with each step's stdout/stderr captured. This file lives in the framework repo as the audit-trail artifact.

**No code changes.** J.1 is a test-only leaf. Diff lock: 1 path (the report file).

---

## Architectural givens (carried)

- F.1 `scripts/install-prereqs.sh` ✅
- F.2 `install.sh` at framework root ✅
- F.3 `setup.sh --post-install` flag + `detect_post_install_state` function ✅
- B.1 `scripts/release.sh` ✅ (builds tarball)
- C.5 `hive update --check --json` ✅
- D.x dashboard backend endpoints ✅
- E.1–E.5 dashboard frontend ✅

The F.2 install.sh's `--target-dir=<path>` and `--api-url=<url>` and `HIVE_TOKEN_MIRROR_DIR` env override all exist (per F.2 spec lock). J.1 uses these to sandbox the install.

### Locked test plan

```
Step 1: framework HEAD verification
  cd ~/neato-hive
  git checkout main && git pull origin main
  Expected HEAD includes bce8282 (F.3 merge) plus this J.1 spec commit.

Step 2: fixture build
  CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
  bash scripts/release.sh "${CURRENT_VERSION}"
  Expected:
    - /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz produced
    - /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt produced

Step 3: hand-write fixture current.json
  TARBALL_SHA=$(awk '{print $1}' "/tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt")
  mkdir -p /tmp/J1-fixture
  cat > /tmp/J1-fixture/current.json <<EOF
  {
    "version": "${CURRENT_VERSION}",
    "tarball_url": "file:///tmp/neato-hive-v${CURRENT_VERSION}.tar.gz",
    "checksum_sha256": "${TARBALL_SHA}",
    "released_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "changelog_url": "file:///tmp/J1-fixture/changelog.html"
  }
  EOF

Step 4: pre-install host snapshot (worker-scope baseline)
  ls -la ~/neato-hive/.env 2>/dev/null
  ls -la ~/.config/neato-hive/ 2>/dev/null
  ls -la ~/.neato-hive/migrations/ 2>/dev/null
  Captured for diff post-test.

Step 5: install.sh fresh-install in sandbox
  SANDBOX=/tmp/J1-sandbox
  rm -rf "$SANDBOX"
  HIVE_TOKEN_MIRROR_DIR=/tmp/J1-mirror \
    bash install.sh \
      --target-dir="$SANDBOX" \
      --api-url="file:///tmp/J1-fixture/current.json" 2>&1 | tee /tmp/J1-install.out

  Expected:
    - exit 0
    - sandbox dir created
    - dist/, bin/, dashboard/, package.json all extracted
    - .env contains HIVE_DASHBOARD_TOKEN=<64 hex>
    - /tmp/J1-mirror/dashboard-token (mode 0600) contains the same token
    - host's ~/neato-hive/.env mtime UNCHANGED (pre vs post)
    - host's ~/.config/neato-hive/ UNCHANGED
    - host's ~/.neato-hive/migrations/ UNCHANGED

Step 6: dashboard process boot in sandbox
  TOKEN=$(grep -E '^HIVE_DASHBOARD_TOKEN=' "$SANDBOX/.env" | cut -d= -f2)
  cd "$SANDBOX/dashboard"
  pnpm install --frozen-lockfile  # worker may skip if pnpm install was already run by install.sh
  HIVE_DASHBOARD_TOKEN="$TOKEN" HIVE_DASHBOARD_PORT=37990 \
    node index.js > /tmp/J1-dashboard.out 2>&1 &
  PID=$!
  sleep 3
  kill -0 $PID && echo "dashboard process alive ✓"

  Expected: process alive after 3s, HTTP listening on 127.0.0.1:37990.

Step 7: dashboard endpoint smoke
  # /api/health (no auth)
  curl -fsS http://127.0.0.1:37990/api/health | jq -c '{version, ok}'
  # /api/status (auth required)
  curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37990/api/status | jq -c '{ok}'
  # /api/agents
  curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37990/api/agents | jq -c '{count: (.agents | length)}'
  # /api/doctor
  curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37990/api/doctor | jq -c '{has_summary: (.summary != null)}'
  # /api/update/check
  curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37990/api/update/check | jq -c '{has_update_available: (.update_available != null)}'
  # query-param auth (E.5 SSE pattern)
  curl -fsS "http://127.0.0.1:37990/api/status?token=$TOKEN" | jq -c '{ok}'

  Expected: all return 200 with valid JSON.

Step 8: hive update --check --json (against the same fixture)
  cd "$SANDBOX"
  HIVE_RELEASES_API="file:///tmp/J1-fixture/current.json" \
    HIVE_INSTALL_ROOT="$SANDBOX" \
    bash bin/hive update --check --json | jq -c '{update_available: .update_available, local_version: .local_version}'

  Expected: update_available is false (since fixture matches local) OR
            true if local package.json doesn't match fixture exactly.
            Either way: valid JSON, exit 0.

Step 9: setup.sh --post-install --help
  cd "$SANDBOX"
  bash setup.sh --post-install --help 2>&1 | head -20

  Expected: usage block printed, --post-install line present, exit 0.
  Worker DOES NOT run setup.sh end-to-end (interactive wizard).

Step 10: setup.sh banner detection (function-isolation test)
  # In post_fresh_install state (HIVE_DASHBOARD_TOKEN in .env, no .setup-state)
  cd "$SANDBOX"
  test -f .env && echo "env present"
  test ! -f .setup-state && echo ".setup-state absent (post_fresh_install state expected)"

  # Run setup.sh in a way that prints the banner without proceeding to interactive prompts.
  # Easiest: tail-pipe to head -20 and timeout. setup.sh prints opening banner
  # very early; we capture the first ~20 lines.
  timeout 5 bash setup.sh </dev/null 2>&1 | head -25 || true

  Expected: banner shows "Detected fresh install. Welcome..." (the post_fresh_install variant).

Step 11: dashboard process teardown
  kill $PID 2>/dev/null || true
  wait $PID 2>/dev/null || true
  echo "dashboard PID $PID stopped"

Step 12: post-test host snapshot diff
  ls -la ~/neato-hive/.env 2>/dev/null  # mtime must match Step 4 snapshot
  ls -la ~/.config/neato-hive/ 2>/dev/null  # absent or unchanged
  ls -la ~/.neato-hive/migrations/ 2>/dev/null  # unchanged
  Verify: NO mutations to host state.

Step 13: cleanup
  rm -rf "$SANDBOX" /tmp/J1-fixture /tmp/J1-mirror
  rm -f /tmp/J1-install.out /tmp/J1-dashboard.out
  rm -f /tmp/neato-hive-v${CURRENT_VERSION}.tar.gz /tmp/neato-hive-v${CURRENT_VERSION}.checksums.txt
```

---

## Pre-conditions

- All Phase F merged (F.1 b1d7b5c, F.2 92e4e54, F.3 bce8282)
- Phase E.5 merged (7c4ba55) — dashboard backend + frontend including Updates page
- macOS test environment with bash, curl, tar, node ≥ 18, pnpm, pm2, openssl, jq, shasum
- `scripts/release.sh` and friends present and executable
- Host has all 6 prereqs already installed (worker MUST NOT trigger install.sh's auto-install path)

---

## Where state lives (J.1 conventions)

**New file (1):**
- `docs/v1.5.0-tasks/J.1-smoke-test-report.md` — verbatim transcript of all 13 steps with stdout/stderr captured. This IS the deliverable.

**Modified files (0):**
- (none — pure test, no code changes)

**Total: 1 path.**

**No new dependencies.**

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body AND in the report file)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `bce8282` (F.3 merge) plus this J.1 spec commit.

### 2. Phase F surface present

```bash
test -f install.sh && test -x install.sh && echo "install.sh ready ✓"
test -f scripts/install-prereqs.sh && test -x scripts/install-prereqs.sh && echo "install-prereqs.sh ready ✓"
test -f setup.sh && test -x setup.sh && echo "setup.sh ready ✓"
grep -nE 'detect_post_install_state|--post-install' setup.sh | head -3
```

**HALT and ping raymond-holt** if any are missing or the F.3 markers absent in setup.sh.

### 3. Host has all 6 prereqs (per F.1's check)

```bash
bash scripts/install-prereqs.sh --json | jq -c '.summary'
```

Expected: `{"total":6,"satisfied":6,"missing":0,"too_old":0}` or equivalent (all satisfied). **HALT and ping raymond-holt** if any prereq is missing or too old — install.sh's auto-install path would then run on the worker host, which is forbidden.

### 4. Host install state baseline (informational)

```bash
ls -la ~/neato-hive/.env 2>/dev/null | head -2
test -d ~/.config/neato-hive && ls -la ~/.config/neato-hive/ | head -5 || echo "(~/.config/neato-hive absent — clean)"
test -d ~/.neato-hive/migrations && ls -la ~/.neato-hive/migrations/ | head -5 || echo "(~/.neato-hive/migrations absent — clean)"
```

Worker captures verbatim. Used for Step 12 post-test diff verification.

### 5. Tooling

```bash
node --version && pnpm --version && which curl jq tar shasum
which openssl
```

Expected: all present.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-J.1-e2e-smoke-test`.

**Diff lock: 1 path exactly** (`docs/v1.5.0-tasks/J.1-smoke-test-report.md` new, no mode changes).

### A.1 — `docs/v1.5.0-tasks/J.1-smoke-test-report.md`

The smoke-test report. Locked sections:

```markdown
# v1.5.0 J.1 — End-to-End Smoke Test Report

**Date:** YYYY-MM-DD
**Worker:** t_<datestamp>_bob-the-builder_<id>
**Framework HEAD at start:** <sha>
**Spec:** docs/v1.5.0-tasks/J.1-e2e-smoke-test.md
**Outcome:** PASS | FAIL

---

## Pre-flight

### 1. Framework HEAD
\`\`\`
<verbatim git log -5 output>
\`\`\`

### 2. Phase F surface present
\`\`\`
<verbatim test outputs>
\`\`\`

### 3. Host prereqs (all 6 satisfied)
\`\`\`
<verbatim install-prereqs.sh --json | jq output>
\`\`\`

### 4. Host install baseline
\`\`\`
<verbatim ls outputs for ~/neato-hive/.env, ~/.config/neato-hive/, ~/.neato-hive/migrations/>
\`\`\`

### 5. Tooling
\`\`\`
<verbatim version outputs>
\`\`\`

---

## Steps 1-13 (verbatim transcripts)

### Step 1: framework HEAD verification
\`\`\`
<verbatim>
\`\`\`

### Step 2: fixture build
\`\`\`
<verbatim release.sh output, tarball + checksums file paths captured>
\`\`\`

### Step 3: fixture current.json
\`\`\`
<verbatim cat /tmp/J1-fixture/current.json>
\`\`\`

### Step 4: pre-install host snapshot
\`\`\`
<verbatim ls outputs>
\`\`\`

### Step 5: install.sh fresh-install in sandbox
\`\`\`
<verbatim install.sh transcript — REDACT TOKEN if it appears>
\`\`\`

### Step 5 verification
\`\`\`
sandbox dir contents:
<verbatim ls -la $SANDBOX | head -20>

.env content (token redacted):
<verbatim cat $SANDBOX/.env with token replaced by <REDACTED>>

token mirror file mode:
<verbatim ls -la /tmp/J1-mirror/dashboard-token>

token regex match: ^[a-f0-9]{64}$
\`\`\`

\`\`\`bash
# Step 5 amendment (J.1.0.5 lock) — verify post-extract REPLACE_LIST completeness.
# Without these, F.3's setup.sh handoff fails AND PM2 cannot bootstrap.
test -f "$SANDBOX/setup.sh" && echo "setup.sh extracted ✓" || { echo "FAIL — setup.sh missing"; SMOKE_FAIL=1; }
test -f "$SANDBOX/ecosystem.config.cjs" && echo "ecosystem.config.cjs extracted ✓" || { echo "FAIL — ecosystem.config.cjs missing"; SMOKE_FAIL=1; }
test -f "$SANDBOX/.env.example" && echo ".env.example extracted ✓" || { echo "FAIL — .env.example missing"; SMOKE_FAIL=1; }
test -f "$SANDBOX/config/config.yaml" && echo "config/config.yaml extracted ✓" || { echo "FAIL — config/config.yaml missing"; SMOKE_FAIL=1; }
\`\`\`

### Step 6: dashboard process boot
\`\`\`
<verbatim node startup output, PID captured>
\`\`\`

### Step 7: dashboard endpoint smoke (token redacted in URL paths)
\`\`\`
/api/health: <captured>
/api/status: <captured>
/api/agents: <captured>
/api/doctor: <captured>
/api/update/check: <captured>
query-param auth: <captured>
\`\`\`

### Step 8: hive update --check --json
\`\`\`
<verbatim>
\`\`\`

### Step 9: setup.sh --post-install --help
\`\`\`
<verbatim — usage block with --post-install line highlighted>
\`\`\`

### Step 10: setup.sh banner detection
\`\`\`
<verbatim head -25 output showing the post_fresh_install banner variant>
\`\`\`

### Step 11: dashboard process teardown
\`\`\`
<verbatim kill output>
\`\`\`

### Step 12: post-test host snapshot diff
\`\`\`
~/neato-hive/.env mtime BEFORE: <captured at Step 4>
~/neato-hive/.env mtime AFTER:  <captured here>
DIFF: IDENTICAL ✓

~/.config/neato-hive/ BEFORE: <captured at Step 4>
~/.config/neato-hive/ AFTER:  <captured here>
DIFF: IDENTICAL ✓ (both absent or same content)

~/.neato-hive/migrations/ BEFORE: <captured at Step 4>
~/.neato-hive/migrations/ AFTER:  <captured here>
DIFF: IDENTICAL ✓
\`\`\`

### Step 13: cleanup
\`\`\`
<verbatim rm output>
\`\`\`

---

## Outcome summary

- **Install path:** PASS / FAIL
- **Dashboard boot:** PASS / FAIL
- **Endpoint smoke:** PASS / FAIL (per-endpoint counts)
- **`hive update --check --json`:** PASS / FAIL
- **`setup.sh --post-install` flag + banner detection:** PASS / FAIL
- **Worker scope (host state preserved):** PASS / FAIL

**Overall:** PASS — packaging path is green-lit for J.2 release ceremony.

OR

**Overall:** FAIL — see Step <N>; J.2 BLOCKED until issue resolved.

---

## Anomalies

(any non-fatal observations worth recording — slow boot, unexpected log lines, etc.)
```

The worker fills in every `<...>` placeholder with the actual captured output. Token values MUST be redacted (replace with `<REDACTED>` literal) anywhere they would otherwise appear.

---

## B. Tests + verification

J.1 IS the test. The B-section verifies the report file's structure + the diff lock + the worker-scope attestation.

### B.1 — Report file exists and is well-formed

```bash
test -f docs/v1.5.0-tasks/J.1-smoke-test-report.md && echo "report file present ✓"
wc -l docs/v1.5.0-tasks/J.1-smoke-test-report.md
# Expected: ≥ 100 lines (the report has 13 steps + pre-flight + outcome summary)
```

### B.2 — Report contains all 13 step transcripts

```bash
grep -cE '^### Step [0-9]+:' docs/v1.5.0-tasks/J.1-smoke-test-report.md
# Expected: 13
```

### B.3 — Report's "Outcome" section is filled

```bash
grep -E '^\*\*Overall:\*\*' docs/v1.5.0-tasks/J.1-smoke-test-report.md
# Expected: 1 match — either "PASS — packaging path is green-lit..." or "FAIL — see Step..."
```

### B.4 — Token redaction sanity check

```bash
# Token regex: 64 hex chars at exactly that length. The report file
# MUST NOT contain any 64-hex-char string outside the literal placeholder.
grep -oE '[a-f0-9]{64}' docs/v1.5.0-tasks/J.1-smoke-test-report.md | head -3
# Expected: empty (or any matches must be intentional like the SHA-256 of the tarball,
# which has 64 hex chars too — worker confirms each match is a tarball SHA, not a token).
```

### B.5 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-J.1-e2e-smoke-test
# Expected: 1 file (docs/v1.5.0-tasks/J.1-smoke-test-report.md)
```

### B.6 — Worker-scope attestation

The report's Step 12 section confirms host state preservation. B.6 just sanity-checks that section is present and shows IDENTICAL.

```bash
grep -A 2 'DIFF: IDENTICAL' docs/v1.5.0-tasks/J.1-smoke-test-report.md | head -10
# Expected: 3 IDENTICAL markers (one per host-state path).
```

### B.7 — Cleanup

```bash
# All /tmp/J1-* paths cleaned in Step 13.
ls /tmp/J1-* 2>&1 | head -3
# Expected: ls error / no such file
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 1 path exactly (`docs/v1.5.0-tasks/J.1-smoke-test-report.md` new)
- [ ] B.1 report file present, ≥ 100 lines
- [ ] B.2 report contains all 13 step transcripts
- [ ] B.3 outcome marker present
- [ ] B.4 no leaked tokens (any 64-hex matches are SHA-256s of the tarball, not the dashboard token)
- [ ] B.5 diff-lock = 1 path
- [ ] B.6 host-state preservation verified (3 IDENTICAL markers)
- [ ] **Step 5 (install.sh fresh-install) succeeded**: sandbox dir created, dist/bin/dashboard extracted, .env with valid token written, mirror file mode 0600
- [ ] **Step 6 (dashboard boot) succeeded**: node process alive, port 37990 listening
- [ ] **Step 7 (endpoint smoke)**: `/api/health` 200, `/api/status` 200 with token, `/api/agents` 200, `/api/doctor` 200, `/api/update/check` 200, query-param auth 200
- [ ] **Step 8 (`hive update --check --json`)** returned valid JSON, exit 0
- [ ] **Step 9 (`setup.sh --post-install --help`)** shows the new flag, exit 0
- [ ] **Step 10 (banner detection)** captured the `post_fresh_install` banner variant
- [ ] **Step 12 (host scope preserved)**: `~/neato-hive/.env`, `~/.config/neato-hive/`, `~/.neato-hive/migrations/` all UNCHANGED
- [ ] **Outcome: PASS** — every step succeeded
- [ ] **Worker MUST NOT run setup.sh end-to-end** (interactive wizard); only `--help` + brief banner-detection check
- [ ] **Worker MUST NOT trigger install.sh's auto-install path** (host already has all prereqs per pre-flight #3)
- [ ] **Worker MUST NOT POST `/api/update/apply`** anywhere (would trigger real `hive update --yes`)
- [ ] **Worker MUST NOT call `pm2` directly** — dashboard boot is via `node index.js`, not pm2
- [ ] PR body: pre-flight 1-5 outputs + B.1-B.7 outputs verbatim, link to the J.1 report file, "host state preserved" attestation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 1 file (docs/v1.5.0-tasks/J.1-smoke-test-report.md new)
Branch: feat/v1.5.0-J.1-e2e-smoke-test

Pre-flight outputs:
  1. framework HEAD: <sha — includes bce8282>
  2. Phase F surface present: ✓
  3. host prereqs all satisfied: 6/6 ✓
  4. host install baseline: <captured>
  5. tooling: node ≥ 22 ✓ pnpm ✓ curl ✓ jq ✓ tar ✓ shasum ✓ openssl ✓

Tests:
  B.1 report file ≥ 100 lines: ✓
  B.2 13 step transcripts present: ✓
  B.3 outcome marker: PASS ✓
  B.4 no leaked tokens (only tarball SHAs match 64-hex): ✓
  B.5 diff-lock = 1 path: ✓
  B.6 host-state preservation: 3 IDENTICAL markers ✓
  B.7 /tmp/J1-* cleanup: ✓

Smoke test outcomes:
  Step 5 install.sh: PASS — sandbox install complete, .env written, mirror at 0600
  Step 6 dashboard boot: PASS — node process alive on :37990
  Step 7 endpoints: PASS — all 6 endpoints 200
  Step 8 hive update --check --json: PASS — exit 0, valid JSON
  Step 9 setup.sh --post-install --help: PASS — flag shown
  Step 10 banner detection: PASS — post_fresh_install variant rendered
  Step 12 host scope preserved: PASS — 3 IDENTICAL diffs

OVERALL: PASS — packaging path green-lit for J.2.

Worker scope attestations:
  - All install actions ran in /tmp/J1-* sandboxes
  - HIVE_TOKEN_MIRROR_DIR=/tmp/J1-mirror held throughout
  - No real `pm2 start` / `pm2 reload` / `pm2 startOrReload` invoked
  - No real `hive update --yes` triggered
  - No real `setup.sh` end-to-end run
  - No real `/api/update/apply` POST issued
  - Host's ~/neato-hive/, ~/.config/neato-hive/, ~/.neato-hive/migrations/ UNCHANGED

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-J.1-e2e-smoke-test
  <verbatim — exactly 1 line: docs/v1.5.0-tasks/J.1-smoke-test-report.md>

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full 13-step transcript in the report file. No "we'll add Step 8 in a follow-up."
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT TOUCH HOST `~/neato-hive`, `~/.config/neato-hive`, OR `~/.neato-hive/migrations`** — all install actions go to `/tmp/J1-*` sandboxes; `HIVE_TOKEN_MIRROR_DIR=/tmp/J1-mirror` overrides token mirror path. Step 4 + Step 12 capture before/after; B.6 verifies IDENTICAL.
- **DO NOT TRIGGER install.sh's AUTO-INSTALL PATH** — host has all prereqs per pre-flight #3. If pre-flight #3 fails (any prereq missing), HALT and ping raymond-holt. Do NOT auto-install on worker host.
- **DO NOT RUN `hive update --yes`** — only `hive update --check --json` (read-only) is in worker scope.
- **DO NOT RUN setup.sh END-TO-END** — only `--help` + brief banner-detection capture (timeout-piped). The interactive wizard is owner ceremony.
- **DO NOT POST `/api/update/apply`** anywhere.
- **DO NOT CALL `pm2` DIRECTLY** — dashboard boot is via `node index.js`, not `pm2 start`.
- **REDACT TOKENS** — any time the dashboard token would appear in the report, replace with `<REDACTED>`. Tarball SHA-256 (also 64 hex chars) is fine to keep — it's not a secret.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises (Phase F surface missing, host prereq missing, tooling absent) stop the worker. Halt means halt — do not fix-and-proceed inline.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **J.2 — Release ceremony.** raymond-holt runs (per 2026-05-09 Daniel autonomy directive). Steps:
  1. Bob amends `release-publish.sh` to also push `install.sh` to the site repo root (small leaf, separate dispatch — call it J.2-prep).
  2. Bob bumps `package.json` 1.4.9 → 1.5.0 + adds CHANGELOG.md entry for v1.5.0 (folded into J.2-prep).
  3. raymond-holt: `git tag v1.5.0` in framework + `git push origin v1.5.0`.
  4. raymond-holt: `bash scripts/release.sh 1.5.0` (builds tarball).
  5. raymond-holt: `bash scripts/release-publish.sh 1.5.0` (pushes tarball + install.sh to site repo, triggers Vercel auto-deploy).
  6. raymond-holt: verify `https://neato-hive-site.vercel.app/install.sh` resolves and matches the framework's install.sh.
  7. raymond-holt: brief Daniel — ready for testing.
- **E.6, E.7** — Backups + Tasks dashboard pages. Deferred to v1.5.x or later per 2026-05-09 priority shift.
- **G.1, H.1** — Mac + Ubuntu GUI installer wrappers. Deferred per same priority shift.
- **I.1** — Ubuntu support audit. Deferred per same priority shift.
