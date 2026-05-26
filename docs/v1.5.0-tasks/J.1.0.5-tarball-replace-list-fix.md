# v1.5.0 J.1.0.5 — Tarball REPLACE_LIST Hygiene Fix

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** J — End-to-end + release ceremony
**Leaf:** J.1.0.5 (hygiene leaf gating J.2 ceremony — fixes the packaging defect J.1's smoke test caught)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** J.1 ✅ `c92745a` (FAIL report — diagnosed setup.sh missing). All Phase F merged.
**Successors:** J.2-prep (release-publish + version + CHANGELOG); J.2 release ceremony.

---

## Goal

J.1's smoke test surfaced a release-blocking packaging defect: **`scripts/release.sh`'s REPLACE_LIST omits files needed by post-install operations.** Worker's transcript showed `setup.sh: No such file or directory` after install.sh extracted the tarball.

Wider analysis (raymond-holt's review of release.sh + bin/hive + setup.sh + install.sh's success-print) reveals the gap is broader than `setup.sh` alone. Four items are missing from REPLACE_LIST:

| # | Item | Type | Why needed post-install |
|---|---|---|---|
| 1 | `setup.sh` | file | F.3's `./setup.sh --post-install` handoff. Wizard for Discord, Claude auth, agent bootstrap. |
| 2 | `ecosystem.config.cjs` | file | PM2 daemon definitions. install.sh's success-print explicitly says `pm2 startOrReload ecosystem.config.cjs`. Without it: `cmd_bootstrap` skips daemon reconciliation with a warning. |
| 3 | `.env.example` | file | Template for users to know which env vars exist. Helpful reference. |
| 4 | `config/` | dir | `config/config.yaml` (master config — setup.sh modifies this at its line 1124 `if [ -f config/config.yaml ]`); `config/agents.local.example.yaml` + `config/users.local.yaml.example` (local-overlay templates). Without `config/`: setup.sh fails its config-edit step. |

**Critical second-order concern:** `bin/hive` has its OWN `REPLACE_LIST` array at line 939-942 that drives the C.2 atomic-overlay swap on `hive update`. It MUST mirror `scripts/release.sh`'s REPLACE_LIST exactly. Fixing only release.sh would mean the tarball ships these 4 items, but on subsequent updates (`hive update v1.5.0 → v1.5.1`), bin/hive's overlay would NOT touch them — users would be stuck at v1.5.0 versions of setup.sh, ecosystem.config.cjs, .env.example, config/ forever after first install.

So the fix is 2-path symmetric:
1. `scripts/release.sh` — extend the staging loops
2. `bin/hive` line 939-942 `REPLACE_LIST` array — extend with the same 4 items

Plus a 3rd path:
3. `docs/v1.5.0-tasks/J.1-e2e-smoke-test.md` — amend Step 5 verification to test post-extract presence of all 4 items (so the NEXT J.1 run catches any further packaging gaps before the release ceremony)

**Owner directive (2026-05-09):** "Yeah make sure smoke runs clean and elevate to me if you can figure it out... If you can't smoke test properly (which is very possible) you can have me smoke test. And if the test is more doable after pushing it to 'live' then testing, that's fine cause we're still in development and we can send it." — This loosens the gate: J.1 re-run is preferred but not blocking. raymond-holt may verify J.1.0.5 via local tarball content inspection (`tar -tzf`) and proceed to J.2 if the 4 items appear in the tarball. Daniel smoke-tests on live URL tomorrow.

**Non-goals:**
- No new features. Pure plumbing fix.
- No re-architecture of release.sh's staging logic.
- No re-architecture of bin/hive's overlay logic.
- No expansion of REPLACE_LIST beyond the 4 items above.
- No PRESERVE_LIST changes (config/*.local.* etc. are already correctly preserved by C.2's overlay logic).

---

## Architectural givens (carried)

### Locked REPLACE_LIST contents (post-fix)

`scripts/release.sh` directory loop (currently line 107):
```bash
for item in dist bin templates shared skills dashboard config; do
```

`scripts/release.sh` file loop (currently line 119):
```bash
for file in package.json pnpm-lock.yaml setup.sh ecosystem.config.cjs .env.example; do
```

`bin/hive` REPLACE_LIST array (currently line 939-942):
```bash
local -a REPLACE_LIST=(
  "dist" "bin" "templates" "shared" "skills" "dashboard" "config"
  "package.json" "pnpm-lock.yaml" "VERSION"
  "setup.sh" "ecosystem.config.cjs" ".env.example"
)
```

Order within each list does not matter functionally, but worker preserves the existing structure (directories first, then files) and APPENDS the new items rather than reshuffling.

### Why dirs vs files matters

`scripts/release.sh` has separate loops:
- Directory loop uses `cp -a "${REPO_ROOT}/${item}" "${STAGING}/${item}"` (recursive copy of entire dir)
- File loop uses `cp -a "${REPO_ROOT}/${file}" "${STAGING}/${file}"` (single file copy)

`bin/hive`'s REPLACE_LIST is a single array; the per-item rename + shadow logic (`_update_apply_overlay` at line 939+) handles both files and directories transparently via `[ -e "${src}" ]` existence checks.

### Locked smoke-test amendment

Add a Step 5 sub-check between current Step 5 (install.sh extract verification) and Step 6 (dashboard boot):

```bash
# Step 5 amendment — verify post-extract REPLACE_LIST completeness (J.1.0.5 lock).
# Without these, F.3's setup.sh --post-install handoff fails AND PM2 cannot start.
test -f "$SANDBOX/setup.sh" && echo "setup.sh extracted ✓" || echo "FAIL — setup.sh missing"
test -f "$SANDBOX/ecosystem.config.cjs" && echo "ecosystem.config.cjs extracted ✓" || echo "FAIL — ecosystem.config.cjs missing"
test -f "$SANDBOX/.env.example" && echo ".env.example extracted ✓" || echo "FAIL — .env.example missing"
test -f "$SANDBOX/config/config.yaml" && echo "config/config.yaml extracted ✓" || echo "FAIL — config/config.yaml missing"
```

Worker's smoke transcript captures these 4 checks. If any FAIL, the smoke-test outcome is FAIL.

### PRESERVE_LIST is unchanged

`config/*.local.yaml` and `config/users.local.yaml` are still PRESERVE_LIST per C.2 — the user's local customizations survive `hive update`. The framework ships the EXAMPLE templates (`*.local.example.yaml`, `*.local.yaml.example`); user creates the actual `.local.yaml` files via setup.sh.

This means: when a user with `config/agents.local.yaml` runs `hive update`, C.2's overlay replaces config/ with the new tarball's config/ contents — but C.2's PRESERVE_LIST step preserves user's `config/*.local.yaml` files in place. Verified by C.2's existing `preserve_list_hash_capture` / `preserve_list_hash_verify` gates (B.4/B.5 in C.2 spec).

**No change to C.2 logic in J.1.0.5.** Only the REPLACE_LIST data (in both release.sh and bin/hive) expands.

---

## Pre-conditions

- J.1 ✅ merged at `c92745a` (FAIL report on main as audit trail)
- All Phase F merged
- bin/hive has the C.2 overlay logic at lines ~939-942 (REPLACE_LIST array)
- scripts/release.sh has the staging loops at lines ~107 + ~119

---

## Where state lives (J.1.0.5 conventions)

**Modified files (3):**
- `scripts/release.sh` — extend directory loop with `config`; extend file loop with `setup.sh`, `ecosystem.config.cjs`, `.env.example`. Approximate diff: 2 lines changed.
- `bin/hive` — extend REPLACE_LIST array (line 939-942) with the same 4 items. Approximate diff: 1-2 lines changed.
- `docs/v1.5.0-tasks/J.1-e2e-smoke-test.md` — amend Step 5 verification block. Approximate diff: ~10 lines added.

**Total: 3 paths.**

**No new files.** No modifications to install.sh, scripts/install-prereqs.sh, setup.sh, dashboard/, package.json, or any other file.

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `c92745a` (J.1 FAIL report merge) plus this J.1.0.5 spec commit.

### 2. Current REPLACE_LIST baseline

```bash
sed -n '107,120p' scripts/release.sh
echo "---"
sed -n '935,945p' bin/hive
```

Expected:
- release.sh line 107 has `for item in dist bin templates shared skills dashboard; do`
- release.sh line 119 has `for file in package.json pnpm-lock.yaml; do`
- bin/hive line 939-942 has REPLACE_LIST array with 9 entries

**HALT and ping raymond-holt** if these lines have shifted unexpectedly or the array shape differs from baseline.

### 3. Files to be added all exist at framework root

```bash
test -f setup.sh && echo "setup.sh exists ✓"
test -f ecosystem.config.cjs && echo "ecosystem.config.cjs exists ✓"
test -f .env.example && echo ".env.example exists ✓"
test -d config && echo "config/ exists ✓"
ls -la config/ | head -10
```

**HALT and ping raymond-holt** if any item is missing from framework root.

### 4. J.1 spec present at expected path

```bash
test -f docs/v1.5.0-tasks/J.1-e2e-smoke-test.md && echo "J.1 spec ✓"
grep -nE '^### Step 5: install\.sh' docs/v1.5.0-tasks/J.1-e2e-smoke-test.md
```

**HALT and ping raymond-holt** if the spec is missing or Step 5 header has shifted.

### 5. Tooling

```bash
bash --version | head -1
shellcheck --version | head -2
```

Expected: bash ≥ 3.2, shellcheck ≥ 0.7.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-J.1.0.5-tarball-replace-list-fix`.

**Diff lock: 3 paths exactly.**
- `scripts/release.sh` (modified — 2 staging-loop lines extended)
- `bin/hive` (modified — 1-2 lines added to REPLACE_LIST array)
- `docs/v1.5.0-tasks/J.1-e2e-smoke-test.md` (modified — Step 5 verification block extended)

### A.1 — `scripts/release.sh` amendment

**Change 1 — directory loop (line 107):**
```diff
-for item in dist bin templates shared skills dashboard; do
+for item in dist bin templates shared skills dashboard config; do
```

**Change 2 — file loop (line 119):**
```diff
-for file in package.json pnpm-lock.yaml; do
+for file in package.json pnpm-lock.yaml setup.sh ecosystem.config.cjs .env.example; do
```

No other changes to release.sh.

### A.2 — `bin/hive` REPLACE_LIST amendment

**Change at line 939-942:**
```diff
   local -a REPLACE_LIST=(
-    "dist" "bin" "templates" "shared" "skills" "dashboard"
-    "package.json" "pnpm-lock.yaml" "VERSION"
+    "dist" "bin" "templates" "shared" "skills" "dashboard" "config"
+    "package.json" "pnpm-lock.yaml" "VERSION"
+    "setup.sh" "ecosystem.config.cjs" ".env.example"
   )
```

Order within the array preserves existing structure (dirs first, then primary files, then VERSION-and-additions). New `config` joins the dirs row; new files form a third row.

No other changes to bin/hive.

### A.3 — J.1 spec amendment

**Insert at the end of Step 5 (`### Step 5: install.sh fresh-install in sandbox`)** — the existing Step 5 ends with sandbox dir verification (`test -d` checks for dist, bin, dashboard, package.json, .env, token regex). Add a new sub-block immediately after, BEFORE Step 6:

```bash
# Step 5 amendment (J.1.0.5 lock) — verify post-extract REPLACE_LIST completeness.
# Without these, F.3's setup.sh handoff fails AND PM2 cannot bootstrap.
test -f "$SANDBOX/setup.sh" && echo "setup.sh extracted ✓" || { echo "FAIL — setup.sh missing"; SMOKE_FAIL=1; }
test -f "$SANDBOX/ecosystem.config.cjs" && echo "ecosystem.config.cjs extracted ✓" || { echo "FAIL — ecosystem.config.cjs missing"; SMOKE_FAIL=1; }
test -f "$SANDBOX/.env.example" && echo ".env.example extracted ✓" || { echo "FAIL — .env.example missing"; SMOKE_FAIL=1; }
test -f "$SANDBOX/config/config.yaml" && echo "config/config.yaml extracted ✓" || { echo "FAIL — config/config.yaml missing"; SMOKE_FAIL=1; }
```

Note the `SMOKE_FAIL=1` sentinel — if any of these fail, Bob's outcome rollup at the end of the smoke flips to FAIL.

Worker preserves the existing Step 5 content verbatim and APPENDS this block.

### A.4 — No other modifications

**Explicitly out of scope:**
- `install.sh` is unchanged.
- `setup.sh` is unchanged.
- `scripts/install-prereqs.sh` is unchanged.
- `dashboard/`, `bin/hive` outside of REPLACE_LIST line, are unchanged.
- `package.json` version stays `1.4.9` (J.2-prep handles the bump).
- `CHANGELOG.md` unchanged (J.2-prep handles the v1.5.0 entry).

---

## B. Tests + verification

### B.1 — Bash syntax + shellcheck

```bash
bash -n scripts/release.sh && echo "release.sh bash -n: ✓"
bash -n bin/hive && echo "bin/hive bash -n: ✓"
shellcheck scripts/release.sh 2>&1 | tee /tmp/J105-release-shellcheck.out | tail -10
shellcheck bin/hive 2>&1 | tee /tmp/J105-binhive-shellcheck.out | tail -10
# Expected: zero NEW warnings vs main baseline. Existing warnings preserved.
```

### B.2 — Diff inspection: only the 3 expected paths touched

```bash
git diff --stat main...feat/v1.5.0-J.1.0.5-tarball-replace-list-fix
# Expected: 3 files
#   scripts/release.sh
#   bin/hive
#   docs/v1.5.0-tasks/J.1-e2e-smoke-test.md
```

### B.3 — release.sh REPLACE_LIST extended correctly

```bash
grep -nE 'for item in.*config|for file in.*setup\.sh' scripts/release.sh | head -3
# Expected: 2 matches
#   line 107-ish: for item in dist bin templates shared skills dashboard config; do
#   line 119-ish: for file in package.json pnpm-lock.yaml setup.sh ecosystem.config.cjs .env.example; do
```

### B.4 — bin/hive REPLACE_LIST extended correctly

```bash
sed -n '935,950p' bin/hive
# Expected: REPLACE_LIST array now contains 12 entries:
#   "dist" "bin" "templates" "shared" "skills" "dashboard" "config"
#   "package.json" "pnpm-lock.yaml" "VERSION"
#   "setup.sh" "ecosystem.config.cjs" ".env.example"

grep -cE '"setup\.sh"|"ecosystem\.config\.cjs"|"\.env\.example"|"config"' bin/hive
# Expected: ≥ 4 (one match per new item; "config" might match other places, worker confirms by reading)
```

### B.5 — Build a tarball with the amended release.sh and inspect its contents

```bash
# Worker MUST NOT actually run pnpm install / pnpm build / pnpm test (release.sh does these).
# Instead: bypass release.sh's heavy steps by stubbing them, OR run release.sh in full.
# Both options have tradeoffs.

# Option A (preferred): worker amends a /tmp/release-stub.sh that mirrors release.sh's
# staging logic but skips pnpm install/build/test. Sources release.sh constants only.
# Then runs the stub to produce a tarball, inspects.

# Option B: run `bash scripts/release.sh <CURRENT_VERSION>` in full. Slow but realistic.
# Worker's call.

# Either way, end goal:
TARBALL=/tmp/neato-hive-v<version>.tar.gz
tar -tzf "$TARBALL" | grep -E '^dist-pkg/setup\.sh$|^dist-pkg/ecosystem\.config\.cjs$|^dist-pkg/\.env\.example$|^dist-pkg/config/config\.yaml$' | sort

# Expected: 4 lines, one per missing-item-now-present:
#   dist-pkg/.env.example
#   dist-pkg/config/config.yaml
#   dist-pkg/ecosystem.config.cjs
#   dist-pkg/setup.sh
```

If running release.sh in full is too heavy for worker scope, fallback: worker uses `tar -tzf` on a pre-built tarball OR builds a minimal stub. Worker's judgment.

### B.6 — bin/hive REPLACE_LIST is loadable

```bash
# Source the function declarations and inspect REPLACE_LIST contents
bash -c '
source <(awk "/^_update_apply_overlay/,/^}/" ~/neato-hive/bin/hive) 2>&1 | head -2
'
# This may or may not work cleanly depending on bin/hive's source-safety. If it doesn't:
# alternative — grep the array literal directly
sed -n '/^  local -a REPLACE_LIST=/,/^  )$/p' bin/hive | tail -10
# Expected: array body shows 12 entries across 3 lines (per A.2 layout)
```

### B.7 — J.1 smoke-test spec amendment is well-formed

```bash
grep -A 6 'Step 5 amendment (J.1.0.5 lock)' docs/v1.5.0-tasks/J.1-e2e-smoke-test.md | head -10
# Expected: the new block is present after Step 5's existing content, before Step 6
```

### B.8 — File modes preserved

```bash
ls -l scripts/release.sh bin/hive docs/v1.5.0-tasks/J.1-e2e-smoke-test.md
# Expected:
#   scripts/release.sh -rwxr-xr-x
#   bin/hive -rwxr-xr-x
#   docs/...md -rw-r--r--
```

### B.9 — Cleanup

```bash
rm -f /tmp/J105-*.out
# Tarball, if built, also removed.
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 3 paths exactly (scripts/release.sh, bin/hive, docs/v1.5.0-tasks/J.1-e2e-smoke-test.md)
- [ ] B.1 `bash -n` clean for both shell files; shellcheck zero NEW warnings
- [ ] B.2 diff stat = 3 paths
- [ ] B.3 release.sh dir loop includes `config`; file loop includes `setup.sh`, `ecosystem.config.cjs`, `.env.example`
- [ ] B.4 bin/hive REPLACE_LIST array contains the same 4 new items
- [ ] B.5 tarball inspection (built via release.sh OR stub): all 4 paths appear under `dist-pkg/`
- [ ] B.7 J.1 spec amendment block is present in correct location
- [ ] B.8 file modes preserved
- [ ] **NO modifications to install.sh, setup.sh, scripts/install-prereqs.sh, dashboard/, package.json, CHANGELOG.md, or any other file beyond the 3 locked paths**
- [ ] **NO PRESERVE_LIST changes** — config/*.local.* preservation is C.2's existing behavior, unchanged
- [ ] **NO new dependencies, no pnpm-lock.yaml changes**
- [ ] PR body: pre-flight 1-5 outputs + B.1-B.8 outputs verbatim, before/after diffs of release.sh + bin/hive + J.1 spec, tarball-content listing if Bob built one, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 3 paths (scripts/release.sh, bin/hive, docs/v1.5.0-tasks/J.1-e2e-smoke-test.md — all modified)
Branch: feat/v1.5.0-J.1.0.5-tarball-replace-list-fix

Pre-flight outputs:
  1. framework HEAD: <sha — includes c92745a J.1 FAIL report>
  2. baseline release.sh + bin/hive REPLACE_LIST shapes captured ✓
  3. files-to-add all present at framework root ✓
  4. J.1 spec present + Step 5 header at expected location ✓
  5. tooling: bash ≥ 3.2 ✓ shellcheck ≥ 0.7 ✓

Tooling check:
  bash -n release.sh: ✓
  bash -n bin/hive: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 diff stat: 3 paths ✓
  B.3 release.sh changes:
    dir loop (line ~107): config added ✓
    file loop (line ~119): setup.sh, ecosystem.config.cjs, .env.example added ✓
  B.4 bin/hive REPLACE_LIST: 12 entries (was 9), +config +setup.sh +ecosystem.config.cjs +.env.example ✓
  B.5 tarball inspection (verbatim tar -tzf output filtered to expected paths):
    <captured 4-line listing showing all items present under dist-pkg/>
  B.7 J.1 spec amendment present at correct location ✓
  B.8 file modes preserved ✓

Worker scope attestations:
  - install.sh, setup.sh, scripts/install-prereqs.sh UNCHANGED
  - dashboard/, package.json, CHANGELOG.md UNCHANGED
  - pnpm-lock.yaml UNCHANGED
  - bin/hive: ONLY the REPLACE_LIST array changed; all other code paths intact
  - scripts/release.sh: ONLY the two staging-loop lines changed
  - Live ~/neato-hive/, ~/.config/neato-hive/, ~/.neato-hive/ all UNCHANGED

Sample diffs:
  release.sh: <verbatim 2-line diff>
  bin/hive: <verbatim ~3-line diff>
  J.1 spec: <verbatim ~10-line diff>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-J.1.0.5-tarball-replace-list-fix
  <verbatim — exactly 3 lines>

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full 3-path fix in single PR. No "we'll add the bin/hive mirror in a follow-up." The two REPLACE_LISTs MUST stay in sync.
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT TOUCH install.sh, setup.sh, scripts/install-prereqs.sh, dashboard/, package.json, CHANGELOG.md** — strictly out of scope. Those are J.2-prep's job (or already merged).
- **DO NOT REGENERATE pnpm-lock.yaml** — no dep changes.
- **DO NOT MODIFY C.2 OVERLAY LOGIC OR PRESERVE_LIST** — only the REPLACE_LIST data expands. Existing PRESERVE_LIST handling for `config/*.local.*` is unchanged.
- **DO NOT REORDER existing REPLACE_LIST entries** — append the 4 new items, preserve the existing 9 entries' order in bin/hive (and the existing 6 dirs + 2 files in release.sh).
- **DO NOT RUN release.sh END-TO-END if it requires actually running pnpm install/build/test against worker host** — if Bob can't bypass those steps cleanly, fall back to a stub OR skip the tarball-content B.5 test and just rely on the diff inspection. Worker's call. raymond-holt verifies tarball content locally post-merge as a final check.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises (line numbers shifted unexpectedly, REPLACE_LIST already contains the items, files-to-add missing from framework root) stop the worker. Halt means halt — do not fix-and-proceed inline.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **Re-dispatch J.1** — after J.1.0.5 merges, raymond-holt may re-dispatch J.1 against the fixed packaging. Per Daniel's 2026-05-09 directive, the re-dispatch is OPTIONAL — raymond-holt may instead verify locally via `tar -tzf` inspection of a freshly-built tarball, then proceed directly to J.2-prep + J.2.
- **J.2-prep** — Bob amends `release-publish.sh` to push install.sh to site repo root + bumps `package.json` 1.4.9 → 1.5.0 + adds CHANGELOG.md v1.5.0 entry. Spec already on main at `ac4f0fa` (`docs/v1.5.0-tasks/J.2-prep-release-amendments.md`).
- **J.2 — Release ceremony.** raymond-holt runs: tag v1.5.0, `bash scripts/release.sh 1.5.0`, `bash scripts/release-publish.sh 1.5.0`, verify Vercel URL resolves. Daniel smoke-tests on live URL tomorrow.
- **Future leaf — REPLACE_LIST sync test.** A future hygiene leaf could add a CI/test that verifies `scripts/release.sh`'s loops and `bin/hive`'s REPLACE_LIST array are kept in sync. If they drift, packaging defects like J.1 surface again. Out of scope for v1.5.0 launch.
