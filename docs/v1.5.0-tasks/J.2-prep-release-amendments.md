# v1.5.0 J.2-prep — Release Amendments (release-publish.sh + package.json + CHANGELOG)

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`. **Dispatch is BLOCKED until J.1 (smoke test) merges.**
**Project:** v1.5.0-website-installer-dashboard
**Phase:** J — End-to-end + release ceremony
**Leaf:** J.2-prep (between J.1 and J.2 — bundles three small amendments needed before the release ceremony)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** J.1 ✅ (smoke test merged — DO NOT dispatch this leaf until J.1 is on main).
**Successor:** J.2 — release ceremony (raymond-holt runs: tag v1.5.0, release.sh, release-publish.sh).

---

## Goal

Three small amendments that the J.2 release ceremony depends on:

1. **`scripts/release-publish.sh` amendment** — currently pushes tarball + checksums + changelog + current.json + index.json under `releases/v<version>/`, but does NOT push `install.sh` to the site repo root. Amendment: copy framework's `install.sh` to the site repo root as part of the publish flow. Without this, `https://neato-hive-site.vercel.app/install.sh` will 404 even after a release publish.

2. **`package.json` version bump** — currently `1.4.9`. `scripts/release.sh 1.5.0` checks that `package.json.version === "1.5.0"` and aborts otherwise. Bump required before J.2 can run.

3. **`CHANGELOG.md` entry for v1.5.0** — `scripts/release.sh 1.5.0` checks `^## \[1.5.0\]` is present in `CHANGELOG.md` and aborts otherwise. New entry required before J.2 can run.

**Owner directive (2026-05-09):** Daniel authorized raymond-holt to "get to the point of pushing it to github so it goes live on the vercel site." J.2-prep is the prerequisite to make J.2 actually publish a working `install.sh` URL.

**Non-goals (explicit drops):**
- No `pnpm install` re-run (the version bump in `package.json` is a metadata change; `pnpm-lock.yaml` does not require a corresponding update for the package's own version field).
- No npm publish, no Cloud Run deploy, no other release-side mutations. J.2-prep stays in the framework repo.
- No real `release-publish.sh` invocation in worker scope (it would push to the live site repo).

---

## Architectural givens (carried)

### Existing `scripts/release-publish.sh` shape (read before editing)

`scripts/release-publish.sh <version> [--dry-run]`. Mirror the existing structure:

- Reads `/tmp/neato-hive-v<version>.tar.gz` + `/tmp/neato-hive-v<version>.checksums.txt` (built by `release.sh`).
- Clones the site repo (`Daniel-Neato/neato-hive-site`) to a `mktemp` work dir.
- Stages files under `releases/v<version>/` (tarball + checksums + changelog).
- Writes `releases/current.json` + `releases/index.json` at site repo root.
- `git -C "${WORK_DIR}" add releases/` then commits + pushes.
- `--dry-run` prints all the staged file paths but skips the final `git push`.

The amendment adds ONE step: copy framework's `install.sh` to `${WORK_DIR}/install.sh` and `git add install.sh` BEFORE the commit.

### Locked release-publish.sh amendment

Insert AFTER the existing changelog write block and BEFORE `git -C "${WORK_DIR}" add releases/` (around line ~205):

```bash
# J.2-prep — push install.sh to site repo root for `curl ... | bash` UX.
# install.sh is the user-facing bootstrap; it lives at framework root and
# must be served from site root (https://<site>/install.sh).
INSTALL_SH_SRC="${REPO_ROOT}/install.sh"
INSTALL_SH_DST="${WORK_DIR}/install.sh"
if [ ! -f "${INSTALL_SH_SRC}" ]; then
  echo "==> ERROR: framework install.sh missing at ${INSTALL_SH_SRC}." >&2
  echo "==> Publish aborted; restore install.sh and re-run." >&2
  exit 1
fi
cp "${INSTALL_SH_SRC}" "${INSTALL_SH_DST}"
chmod 0755 "${INSTALL_SH_DST}"
echo "==> Copied install.sh to site repo root (mode 0755)."
git -C "${WORK_DIR}" add install.sh
```

The existing `git add releases/` line stays. The commit message stays as-is (or worker may amend the comment block to reflect the install.sh inclusion — diff lock allows up to 3 paths if needed).

### Locked package.json amendment

Single-line change:

```diff
-  "version": "1.4.9",
+  "version": "1.5.0",
```

No other fields touched. `pnpm-lock.yaml` is NOT modified (the version field of the package itself does not appear in the lockfile's resolution graph for a private package).

**Worker MUST verify after the bump:** `pnpm install --frozen-lockfile` succeeds against the new `package.json`. If it fails (lockfile mismatch), HALT-and-ping — implies a deeper packaging issue.

### Locked CHANGELOG.md amendment

Insert a new entry at the TOP of the changelog (after the `# Changelog` heading + intro block, before the existing `## [1.4.9]` entry). Format:

```markdown
## [1.5.0] — 2026-05-09

**Website distribution + local dashboard.** End users no longer install via
`git pull` from GitHub. The new flow:

```
curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
```

…fetches the tarball from the website, verifies SHA-256, extracts to
`~/neato-hive`, generates a dashboard token, prints the dashboard URL. A
new local dashboard (port 7777, Tailscale-friendly) provides Overview,
Agents, Doctor, and Updates pages with token auth.

### Added

- **`install.sh`** at framework root — fresh-install bootstrap for the
  `curl … | bash` UX. Auto-installs missing prereqs (Node ≥ 18, pnpm,
  pm2, tar) via Homebrew (macOS) or apt-get (Ubuntu) by default;
  `--no-install-prereqs` opt-out and `--interactive-prereqs` per-prompt
  also supported.
- **`scripts/install-prereqs.sh`** — standalone prereq detection
  (`--check-only` / `--install` / `--auto`) with JSON envelope (v1) for
  consumption by future GUI installers.
- **`hive update`** rewrite: tarball-based with atomic-overlay swap,
  rollback (`hive update --rollback`), state-file emission for SSE
  progress (`~/.neato-hive/state/update-<id>.jsonl`), v1.4.x → v1.5.0
  implicit migration handler.
- **`hive update --check --json`** mode for dashboard + CLI scripting.
- **`hive doctor --json`** mode for dashboard consumption.
- **`hive dashboard token` / `rotate-token`** subcommands.
- **Local dashboard** (`hive-dashboard` PM2 process, port 7777,
  `0.0.0.0`): Express backend + vanilla-MPA frontend.
  - Endpoints: `/api/health`, `/api/status`, `/api/agents`,
    `/api/agents/:name`, `/api/doctor`, `/api/update/check`,
    `/api/update/apply`, `/api/update/status/:id`,
    `/api/update/progress/:id` (SSE), `/api/backups`, `/api/tasks`,
    `/api/runner-events`, `/api/sessions/active`.
  - Token auth via `Authorization: Bearer` header OR `?token=` query
    param (the latter for native `EventSource` SSE).
  - Pages: `/login.html`, `/` (Overview), `/agents.html`, `/doctor.html`,
    `/updates.html`. Tasks + Backups pages deferred to v1.5.x.
- **Cloud Run + Cloud SQL backend** (`hive-releases-api`): FastAPI service
  serving `/api/current` from a `releases` table in `neato-os-db`.
  Deployed via Vercel rewrites at `https://neato-hive-site.vercel.app/api/current`.
- **`scripts/release.sh`** + **`scripts/release-audit.sh`** +
  **`scripts/release-publish.sh`**: tarball release pipeline. The publish
  script pushes tarball + checksums + changelog + current.json +
  index.json + install.sh to the site repo, triggering a Vercel rebuild.
- **`setup.sh --post-install`** flag + auto-detection
  (`detect_post_install_state`): post-fresh-install handoff banner.

### Changed

- `hive update` body cuts over from git-pull to the new tarball flow
  (`_update_run_full_flow_with_revert`). `--rollback` (C.3) and
  `--check` (C.5) branches preserved at the top.
- `dashboard/middleware/auth.js` extracted `tokenFromRequest()` helper:
  header-first, query-param fallback. Constant-time compare preserved.
- Dashboard token auto-ensured during agent bootstrap (via
  `cmd_bootstrap`) when missing.

### Deprecated

- `hive update --internal-post-pull` — v1.4.x self-exec relic; tarball
  install has no `.git/` directory so post-pull self-exec is impossible.
  Flag is now silently stripped with a deprecation warning.

### Removed

- The git-based `hive update --check` block (lines 1447-1487 in
  pre-v1.5.0 `bin/hive`) is replaced by the API-based `_update_check`
  (C.5). Tarball installs have no `.git/` to fetch from.

### Fixed

- `scripts/provision-v1.5.0.sh`'s `ensure_project_link()` correctly
  parses Vercel's "already connected" output and treats it as success
  (was: incorrectly aborting on idempotent re-runs).

```

The exact text above is a STARTING POINT. Worker may polish wording but MUST preserve:

- The header line `## [1.5.0] — 2026-05-09` (the regex `^## \[1.5.0\]` is what `release.sh` looks for).
- The 5 sections (Added / Changed / Deprecated / Removed / Fixed) — Keep-a-Changelog convention.
- Mention of `install.sh`, `dashboard`, `hive update` rewrite, Cloud Run backend, `release-publish.sh`.

Worker must NOT modify the `# Changelog` top heading or the intro block. Only the new entry is added between them.

### Locked worker-scope safety

- **DO NOT run `release-publish.sh` against the live site repo.** The amendment is verified via dry-run only:
  ```bash
  bash scripts/release-publish.sh <fixture-version> --dry-run
  ```
  Worker uses a fixture version (e.g., `0.0.0-test`) to avoid colliding with any real published versions.
- **DO NOT tag the framework repo.** No `git tag` calls. raymond-holt does that during J.2.
- **DO NOT push to the site repo.** Worker scope ends at the dry-run output.
- **DO NOT modify `pnpm-lock.yaml`** — package.json version field doesn't propagate.
- **DO NOT modify any other files** beyond the locked 3.

---

## Pre-conditions

- J.1 ✅ merged on framework `main` (the smoke test PASSED).
- All Phase F merged (F.1 b1d7b5c, F.2 92e4e54, F.3 bce8282).
- `scripts/release.sh`, `scripts/release-publish.sh`, `scripts/release-audit.sh` all 0755 on origin/main.
- `package.json` currently at version `1.4.9` (worker confirms in pre-flight #2).
- `CHANGELOG.md` does NOT have a `## [1.5.0]` entry yet (worker confirms in pre-flight #3).

---

## Where state lives (J.2-prep conventions)

**Modified files (3):**
- `scripts/release-publish.sh` — install.sh push amendment (~15 LOC inserted).
- `package.json` — version field bump (1 LOC change).
- `CHANGELOG.md` — new top entry (~70-100 lines inserted).

**Total: 3 paths.**

**No new files. No new dependencies.**

---

## Pre-flight (worker MUST run all 5; outputs captured in PR body)

### 1. Framework repo current state + J.1 merged

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes J.1's merge commit (the smoke test PR landed) plus this J.2-prep spec commit.

**HALT and ping raymond-holt** if J.1 hasn't merged yet. J.2-prep is BLOCKED until J.1 is on main.

### 2. Current package.json version

```bash
node -e "console.log(require('./package.json').version)"
```

Expected: `1.4.9`. **HALT and ping raymond-holt** if it's already `1.5.0` (out-of-band drift) or anything else unexpected.

### 3. CHANGELOG.md does NOT yet have a v1.5.0 entry

```bash
grep -nE '^## \[1\.5\.0\]' CHANGELOG.md | head -3
```

Expected: empty (no match). **HALT and ping raymond-holt** if a `## [1.5.0]` entry already exists.

### 4. release-publish.sh shape unchanged

```bash
grep -nE 'install\.sh|releases/' scripts/release-publish.sh | head -10
```

Expected: existing references match what the spec captured (tarball + checksums + current.json + index.json paths under `releases/`, NO `install.sh` reference yet). **HALT and ping raymond-holt** if `install.sh` is already referenced — out-of-band drift.

### 5. Tooling

```bash
bash --version | head -1
shellcheck --version | head -2
which node jq awk sed grep
```

Expected: all present.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-J.2-prep-release-amendments`.

**Diff lock: 3 paths exactly** (all modifications, no new files).

### A.1 — `scripts/release-publish.sh` amendment

Insert the install.sh-push block per §"Locked release-publish.sh amendment" above. Position: AFTER the existing changelog write block, BEFORE `git -C "${WORK_DIR}" add releases/`. ~15 LOC added.

**Locked:**
- Block uses `${REPO_ROOT}` (already defined at script top) for the source path.
- File mode preserved at `0755` via explicit `chmod`.
- HALT-with-error-and-exit-1 if framework's `install.sh` is missing.
- `git add install.sh` (NOT under `releases/`) so the file lands at site repo root.

### A.2 — `package.json` version bump

```diff
-  "version": "1.4.9",
+  "version": "1.5.0",
```

Single-line change. No other fields touched.

### A.3 — `CHANGELOG.md` new entry

Insert a `## [1.5.0] — 2026-05-09` block at the top, between the intro block and the `## [1.4.9]` entry. Per the locked text in §"Locked CHANGELOG.md amendment" above.

**Worker may polish wording** but MUST preserve:
- Header `## [1.5.0] — 2026-05-09` (regex `^## \[1.5.0\]` matches)
- 5 Keep-a-Changelog sections (Added / Changed / Deprecated / Removed / Fixed)
- Mentions: install.sh, dashboard, hive update rewrite, Cloud Run backend, release-publish.sh

---

## B. Tests + verification

### B.1 — Bash syntax + shellcheck on release-publish.sh

```bash
bash -n scripts/release-publish.sh && echo "bash -n: ✓"
shellcheck scripts/release-publish.sh 2>&1 | tail -10
# Expected: zero NEW warnings vs baseline.
```

### B.2 — JSON syntax on package.json

```bash
node -e "JSON.parse(require('fs').readFileSync('./package.json', 'utf8'))" && echo "package.json valid JSON: ✓"
node -e "console.log(require('./package.json').version)"
# Expected: 1.5.0
```

### B.3 — pnpm-lock.yaml unchanged + frozen-lockfile install succeeds

```bash
git diff main...feat/v1.5.0-J.2-prep-release-amendments -- pnpm-lock.yaml
# Expected: empty (no changes to pnpm-lock.yaml)

pnpm install --frozen-lockfile 2>&1 | tail -5
# Expected: success (no lockfile drift; frozen-lockfile passes)
```

### B.4 — CHANGELOG.md regex check (release.sh's gate)

```bash
grep -nE '^## \[1\.5\.0\]' CHANGELOG.md
# Expected: 1 match — the new entry header.

# Also verify the new entry has all 5 sections
grep -nE '^### (Added|Changed|Deprecated|Removed|Fixed)' CHANGELOG.md | head -20
# Expected: at minimum, ONE occurrence of each section under the v1.5.0 entry
# (the existing v1.4.9 entry also has these — total ≥ 5 from v1.5.0 + carry-over from v1.4.9).
```

### B.5 — release.sh's pre-flight checks pass against the bumped state

```bash
# Don't actually build; just verify the pre-flight section passes.
# release.sh checks: package.json version == arg, CHANGELOG.md has the entry, packageManager field present.
node -e "
  const pkg = require('./package.json');
  const fs = require('fs');
  const changelog = fs.readFileSync('./CHANGELOG.md', 'utf8');
  console.log('version match:', pkg.version === '1.5.0');
  console.log('packageManager present:', !!pkg.packageManager);
  console.log('changelog entry:', /^## \\[1\\.5\\.0\\]/m.test(changelog));
"
# Expected: 3 trues
```

### B.6 — release-publish.sh dry-run shape (verify install.sh appears in the staging output)

```bash
# Build a fake fixture tarball + checksums (release-publish.sh requires them present)
mkdir -p /tmp/J2prep-fake
echo "fake-tarball-bytes" > /tmp/neato-hive-v0.0.0-test.tar.gz
SHA=$(shasum -a 256 /tmp/neato-hive-v0.0.0-test.tar.gz | awk '{print $1}')
printf "%s  neato-hive-v0.0.0-test.tar.gz\n" "${SHA}" > /tmp/neato-hive-v0.0.0-test.checksums.txt

# Run release-publish.sh in dry-run mode against fixture version
bash scripts/release-publish.sh 0.0.0-test --dry-run 2>&1 | tee /tmp/J2prep-publish-dry.out

# Verify install.sh was staged
grep -E '(Copied install\.sh|install\.sh.*site repo root|git add install\.sh)' /tmp/J2prep-publish-dry.out
# Expected: at least one match (the new echo line from the amendment).

# Verify dry-run did NOT actually push
grep -E 'git push' /tmp/J2prep-publish-dry.out | head -3
# Expected: dry-run mode should print "[dry-run]" before any push command, OR
# the push should be guarded behind --dry-run check. Worker captures the actual
# behavior and confirms NO push to live site repo occurred.

# Cleanup fixture
rm -rf /tmp/J2prep-fake /tmp/neato-hive-v0.0.0-test.tar.gz /tmp/neato-hive-v0.0.0-test.checksums.txt /tmp/J2prep-publish-dry.out
```

If `release-publish.sh` doesn't currently support `--dry-run` cleanly, worker captures the actual behavior and notes whether the push was blocked.

### B.7 — Worker scope: NO live site push

```bash
# Worker confirms: NO `git push` to Daniel-Neato/neato-hive-site occurred in this turn.
# Look at the `gh repo view Daniel-Neato/neato-hive-site --json pushedAt` BEFORE and AFTER.
gh repo view Daniel-Neato/neato-hive-site --json pushedAt 2>&1
# Capture this value at start of turn AND end of turn. They MUST be identical.
```

### B.8 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-J.2-prep-release-amendments
# Expected: 3 files (release-publish.sh, package.json, CHANGELOG.md)
```

### B.9 — File modes preserved

```bash
ls -l scripts/release-publish.sh
# Expected: -rwxr-xr-x (mode 0755 preserved)
```

### B.10 — Cleanup

```bash
rm -f /tmp/J2prep-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 3 paths exactly (`scripts/release-publish.sh`, `package.json`, `CHANGELOG.md` — all modified)
- [ ] B.1 `bash -n` clean on release-publish.sh; shellcheck zero NEW warnings
- [ ] B.2 package.json valid JSON; version === "1.5.0"
- [ ] B.3 pnpm-lock.yaml UNCHANGED; `pnpm install --frozen-lockfile` succeeds
- [ ] B.4 CHANGELOG.md has `^## \[1.5.0\]` entry with all 5 Keep-a-Changelog sections
- [ ] B.5 release.sh pre-flight checks would pass: version match + packageManager present + changelog entry
- [ ] B.6 release-publish.sh dry-run shows install.sh staging — `Copied install.sh to site repo root` log line OR equivalent
- [ ] B.7 NO live push to `Daniel-Neato/neato-hive-site` during worker turn (`pushedAt` UNCHANGED)
- [ ] B.8 diff-lock = 3 paths
- [ ] B.9 release-publish.sh mode 0755 preserved
- [ ] **`install.sh` push to site root** — the amendment correctly stages it OUTSIDE `releases/` (so it lands at `https://<site>/install.sh`)
- [ ] **NO modification to install.sh, setup.sh, scripts/install-prereqs.sh** — those leaves are sealed at F.1/F.2/F.3
- [ ] **NO `git tag` calls** — tagging is raymond-holt's J.2 ceremony
- [ ] **NO push to live site repo** during worker turn
- [ ] PR body: pre-flight 1-5 outputs + B.1-B.9 outputs verbatim, sample changelog entry, sample release-publish.sh amendment diff, diff-lock confirmation, "no live push" attestation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 3 paths (scripts/release-publish.sh + package.json + CHANGELOG.md — all modified)
Branch: feat/v1.5.0-J.2-prep-release-amendments

Pre-flight outputs:
  1. framework HEAD: <sha — includes J.1 merge>
  2. package.json version BEFORE: 1.4.9 ✓
  3. CHANGELOG.md no v1.5.0 entry yet: ✓
  4. release-publish.sh shape: <captured>
  5. tooling: bash ≥ 3.2 ✓ shellcheck ≥ 0.7 ✓ node ✓ jq ✓

Tooling check:
  bash -n scripts/release-publish.sh: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 package.json: valid JSON, version === "1.5.0" ✓
  B.3 pnpm-lock.yaml UNCHANGED + frozen-lockfile install: ✓
  B.4 CHANGELOG.md entry + 5 sections: ✓
  B.5 release.sh pre-flight would pass: 3 trues ✓
  B.6 release-publish.sh dry-run shows install.sh push: ✓
  B.7 site repo pushedAt UNCHANGED: <BEFORE/AFTER captured>
  B.8 diff-lock = 3 paths: ✓
  B.9 release-publish.sh mode 0755: ✓

Worker scope attestations:
  - NO live `release-publish.sh` invoked (only --dry-run with fixture version)
  - NO `git tag` calls
  - NO push to Daniel-Neato/neato-hive-site
  - NO modifications to install.sh, setup.sh, install-prereqs.sh, or any
    other v1.5.0 leaf code

Sample release-publish.sh amendment diff:
  <verbatim hunk showing the install.sh-push insertion>

Sample CHANGELOG.md new entry (first 30 lines):
  <verbatim>

Sample package.json diff:
  <verbatim 1-line diff>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-J.2-prep-release-amendments
  <verbatim — exactly 3 lines>

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
After merge, raymond-holt runs J.2 ceremony (tag + release.sh + release-publish.sh).
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — all 3 amendments in single PR.
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT INVOKE `release-publish.sh` IN NON-DRY-RUN MODE** — would push to live site repo. B.6 uses `--dry-run` against a fixture version.
- **DO NOT TAG** the framework repo. raymond-holt does that during J.2.
- **DO NOT PUSH** to `Daniel-Neato/neato-hive-site`. B.7 verifies pushedAt unchanged.
- **DO NOT MODIFY** install.sh, setup.sh, scripts/install-prereqs.sh, bin/hive, or any other v1.5.0 leaf code. Diff lock is 3 paths exactly.
- **DO NOT TOUCH `pnpm-lock.yaml`** — version bump in package.json doesn't require lockfile changes.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises stop the worker. Halt means halt. Do not fix-and-proceed inline.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation`.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **J.2 — Release ceremony.** raymond-holt runs after this leaf merges:
  1. `cd ~/neato-hive && git checkout main && git pull origin main`
  2. `git tag v1.5.0 && git push origin v1.5.0`
  3. `bash scripts/release.sh 1.5.0` — builds tarball at `/tmp/neato-hive-v1.5.0.tar.gz` (release.sh's pre-flights now PASS thanks to J.2-prep).
  4. `bash scripts/release-publish.sh 1.5.0` — pushes tarball + checksums + changelog + current.json + index.json + **install.sh** to site repo. Vercel auto-builds.
  5. Wait ~30-60s for Vercel deploy.
  6. `curl -fsSL https://neato-hive-site.vercel.app/install.sh | head -3` — verify shebang + first lines match framework's install.sh.
  7. `curl -fsS https://neato-hive-site.vercel.app/releases/current.json | jq .` — verify version=1.5.0 + tarball_url + checksum.
  8. Brief Daniel — ready for testing.
- **Future leaf — automated release pipeline** — currently J.2 is manual. A v1.5.x leaf could wire GitHub Actions to auto-tag + auto-publish on `main` PR merges. Out of v1.5.0 scope.
- **Future leaf — release notes generation from PR titles** — could auto-generate the CHANGELOG entry from merged PR titles since the last tag. Out of v1.5.0 scope.
