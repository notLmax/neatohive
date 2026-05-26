# v1.5.0 J.1.0.6 — Fresh-Install Bootstrap Completeness

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** J — End-to-end + release ceremony
**Leaf:** J.1.0.6 (second hygiene leaf — fixes two BLOCKER gaps J.1's design did NOT catch because it stopped at install.sh + dashboard boot, not at setup.sh's end-to-end wizard run)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** Phase F closed (F.1 b1d7b5c, F.2 92e4e54, F.3 bce8282); J.1 c92745a (FAIL report); J.1.0.5 3375a29 (REPLACE_LIST sync); J.2-prep 2334851; v1.5.0 LIVE on site (manually deployed via Vercel CLI).
**Successor:** v1.5.0.1 re-ship — raymond-holt rebuilds tarball + republishes.

---

## Goal

Fix the two BLOCKER gaps that prevent fresh installs from yielding a working Hive end-to-end:

1. **House MD behavior files do not ship in the tarball.** `agents/house-md/{AGENTS, BOOTSTRAP, IDENTITY, LESSONS, MEMORY, OUTPUT-LOG, SOUL, TASKS, USER}.md` are tracked in the framework repo but `agents/` is intentionally EXCLUDED from `REPLACE_LIST` (PRESERVE_LIST design — user data must survive `hive update`). On fresh install, `agents/house-md/` doesn't exist; setup.sh's Step 10 `pm2 start dist/index.js --name house-md -- --agent house-md` starts a process that finds no behavior files to load.

2. **setup.sh Step 10 does NOT start `hive-dashboard`.** Line 1182 reads `pm2 start ecosystem.config.cjs --only hive-runner` — the `--only hive-runner` filter excludes hive-dashboard. The dashboard is v1.5.0's flagship feature. End user runs `./setup.sh --post-install`, dashboard never boots, `http://localhost:7777/login.html` 404s.

**Architectural pattern adopted (template → agent materialization):**

- `templates/house-md/` ships in tarball (under REPLACE_LIST via existing `templates/` dir entry) — factory-default House MD behavior files.
- `agents/house-md/` is the user's working copy (PRESERVE_LIST — survives updates).
- setup.sh's NEW `materialize_house_md()` function: on fresh install (when `agents/house-md/` doesn't exist), copy `templates/house-md/` → `agents/house-md/`. Idempotent (skip if agents/house-md already exists).

This is the same pattern already in use for new-agent creation by House MD itself: when House MD scaffolds a new agent (e.g. "atlas"), it copies `templates/generalist/` → `agents/atlas/`. We're applying the same convention to the bootstrap agent.

**Pause/resume preserved:** setup.sh's existing state machine (`--fresh`, `--resume`, `--yes`, `.setup-state` checkpointing, Ctrl-C pause) is untouched. The materialize step is idempotent — re-runs are safe; `--resume` after a paused setup will see agents/house-md/ exists and skip materialization.

**Owner directive (2026-05-09):** "I need to make sure that anything that would be repo requirements by default gets handled in this installer right now. point out anything that could be missing as well, like the runner pm2 process or the dashboard pm2 process, those all need to be installed and started up on initial install as well." — J.1.0.6 addresses both: templates/house-md ships + setup.sh starts BOTH hive-runner AND hive-dashboard from ecosystem.config.cjs.

**Non-goals (explicit drops):**
- No removal or rename of existing `agents/house-md/` in the framework repo (it's raymond-holt-the-Daniel's dev-machine house-md; framework convention preserves dev agents under `agents/` and ships factory defaults under `templates/`). After this leaf, both coexist.
- No change to ecosystem.config.cjs (already correctly defines both daemons).
- No change to install.sh (F.2 is correct as-is).
- No change to scripts/release.sh (J.1.0.5 already includes templates/ in REPLACE_LIST — templates/house-md/ automatically ships).
- No change to bin/hive REPLACE_LIST array (templates/ already listed).
- No release-publish.sh public/ amendment (separate concern; future leaf).
- No re-architecture of `agents/` PRESERVE_LIST handling.

---

## Architectural givens (carried)

### Existing template pattern

`templates/` already contains factory defaults for agent creation:
- `templates/generalist/` — generic agent (IDENTITY.md, AGENTS.md, SOUL.md, MEMORY.md, USER.md, TASKS.md, LESSONS.md, OUTPUT-LOG.md)
- `templates/coding-agent/` — coding-flavored agent template
- `templates/site-skeleton/` — site repo template

J.1.0.6 adds `templates/house-md/` as the factory default for the bootstrap agent. Same shape as `templates/generalist/` but with House MD's specific identity + role.

### Existing setup.sh wizard structure (DO NOT modify outside scope)

setup.sh's 10-step state machine:
- Steps 1-3: prereqs (Node, brew tools, Claude CLI)
- Step 4: Claude auth
- Step 5: Codex CLI
- Step 6: Discord setup (writes `DISCORD_BOT_TOKEN_HOUSE_MD` to .env)
- Step 7: Google Workspace auth (optional)
- Step 8: Create Working Directory (mkdir + config.yaml patch) ← **materialize_house_md() inserts here**
- Step 9: Install & Build (npm install + npm run build + npm link)
- Step 10: Start agents + boot persistence ← **`--only hive-runner` filter dropped here**

J.1.0.6 modifies ONLY two spots: end of Step 8 (add materialize call) + the line 1182 area (drop --only filter).

### Locked materialize function

```bash
# J.1.0.6 — materialize House MD agent from template on fresh install.
#
# Why: v1.5.0 tarball installs do NOT ship `agents/` (PRESERVE_LIST design —
# user agent customizations must survive `hive update`). House MD's behavior
# files live in `templates/house-md/` as the factory default. This function
# copies the template to `agents/house-md/` on first run so PM2 can start
# the agent in Step 10.
#
# Idempotency: skip if `agents/house-md/IDENTITY.md` already exists. Safe
# on `--resume` re-runs and safe if the user already populated agents/
# manually (e.g. an upgrader from v1.4.x).
#
# Failure mode: if templates/house-md/ is missing (packaging defect),
# print clear error and exit 1. User should `hive update` to get the
# latest tarball.
materialize_house_md() {
    if [ -f agents/house-md/IDENTITY.md ]; then
        print_success "House MD agent files already present (skipping materialize)"
        return 0
    fi

    if [ ! -d templates/house-md ]; then
        print_error "templates/house-md/ missing from this install."
        echo "  Expected at: $(pwd)/templates/house-md/"
        echo "  This is a packaging defect. Fix:"
        echo "    1. Verify the install completed cleanly: ls $(pwd)/templates"
        echo "    2. If templates/ is incomplete, re-run: curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash"
        echo "    3. If problem persists, report at: https://github.com/anthonyconnelly/neato-hive/issues"
        return 1
    fi

    echo "Materializing House MD from templates/house-md/..."
    mkdir -p agents
    cp -R templates/house-md agents/house-md

    if [ ! -f agents/house-md/IDENTITY.md ]; then
        print_error "House MD materialize failed — agents/house-md/IDENTITY.md absent after cp."
        return 1
    fi

    print_success "House MD agent files materialized at agents/house-md/"
    return 0
}
```

**Locked semantics:**
- Idempotent: re-runs are no-ops if `agents/house-md/IDENTITY.md` exists.
- Conservative: uses `cp -R` (recursive, preserve mode bits — directory semantics matches templates/generalist precedent).
- Fail-clear: if templates/house-md/ is absent, prints actionable diagnostic + exit 1.
- Post-condition verify: confirms agents/house-md/IDENTITY.md exists after cp.

### Locked Step 10 amendment

Current setup.sh line ~1182:
```bash
# Register the hive-runner daemon (added in v1.3.0). Required for
# delegation, wake, and the agent-boot-announce mechanism.
if [ -f ecosystem.config.cjs ]; then
    echo "Starting hive-runner daemon..."
    pm2 start ecosystem.config.cjs --only hive-runner
    print_success "hive-runner registered"
fi
```

Changes to:
```bash
# Register ecosystem daemons. ecosystem.config.cjs defines:
#   - hive-runner   (delegation/wake/boot-announce — added v1.3.0)
#   - hive-dashboard (Express server on 0.0.0.0:7777 — added v1.5.0)
# Both must start on fresh install; pm2 startOrReload is idempotent.
if [ -f ecosystem.config.cjs ]; then
    echo "Starting ecosystem daemons (hive-runner + hive-dashboard)..."
    pm2 startOrReload ecosystem.config.cjs --update-env
    print_success "hive-runner + hive-dashboard registered"
fi
```

Net effect:
- `pm2 startOrReload ecosystem.config.cjs --update-env` replaces `pm2 start ecosystem.config.cjs --only hive-runner`
- Both daemons (hive-runner + hive-dashboard) start, per ecosystem.config.cjs.
- `--update-env` ensures changes to .env (e.g. HIVE_DASHBOARD_TOKEN written by install.sh) are picked up by the new processes.
- `pm2 startOrReload` is idempotent (vs `pm2 start` which would fail if already running). Safer on re-runs.

### Locked call site for materialize_house_md

Insert at END of Step 8 (Create Working Directory), AFTER the config.yaml patch, BEFORE `state_save 8`:

```bash
    if [ -f config/config.yaml ]; then
        sed -i.bak -E "s#^(    - )(~/neato-hive|~/hive)\$#\1${INSTALL_DIR_TILDE}#" config/config.yaml
        rm -f config/config.yaml.bak
        print_success "Patched config.yaml allowed_paths → $INSTALL_DIR_TILDE"
    fi

    # J.1.0.6 — materialize House MD from templates on fresh install
    if ! materialize_house_md; then
        print_error "House MD materialization failed — cannot continue."
        trap - INT TERM ERR
        exit 1
    fi

    state_save 8
```

Idempotent + fail-fast. If materialization fails, setup.sh exits 1 with a clear diagnostic; user can investigate, fix, and re-run.

---

## Pre-conditions

- J.1.0.5 ✅ merged at `3375a29` (REPLACE_LIST sync — templates/ already in both REPLACE_LISTs, so templates/house-md/ ships automatically once it exists)
- J.2-prep ✅ merged at `2334851` (package.json 1.5.0 + CHANGELOG + release-publish install.sh amendment)
- `agents/house-md/` exists in framework repo with 9 tracked .md files (source of factory defaults)
- `templates/house-md/` does NOT exist yet at framework root
- `setup.sh` has Step 8 (Create Working Directory) and Step 10's line 1182 region intact

---

## Where state lives (J.1.0.6 conventions)

**New files (9):**
- `templates/house-md/AGENTS.md`
- `templates/house-md/BOOTSTRAP.md`
- `templates/house-md/IDENTITY.md`
- `templates/house-md/LESSONS.md`
- `templates/house-md/MEMORY.md`
- `templates/house-md/OUTPUT-LOG.md`
- `templates/house-md/SOUL.md`
- `templates/house-md/TASKS.md`
- `templates/house-md/USER.md`

All 9 copied verbatim from current `agents/house-md/{file}.md` (340 total lines combined).

**Modified files (1):**
- `setup.sh` — add `materialize_house_md()` function (~30 LOC) + insertion in Step 8 (~5 LOC) + Step 10 line 1182 amendment (~5 LOC). Approximate total: 40-50 LOC modified.

**Total: 10 paths.**

**Untouched (explicitly out of scope):**
- `agents/house-md/` (NOT removed, NOT modified — preserves raymond-holt-the-Daniel's dev-machine house-md content)
- `scripts/release.sh` (templates/ already in REPLACE_LIST per J.1.0.5)
- `bin/hive` (templates/ already in REPLACE_LIST array per J.1.0.5)
- `install.sh` (F.2 is correct)
- `scripts/install-prereqs.sh` (F.1 is correct)
- `package.json`, `pnpm-lock.yaml`, `CHANGELOG.md`, `ecosystem.config.cjs` (no changes needed)

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `2334851` (J.2-prep merge) + later commits (J.1 FAIL report, J.1.0.5 merge) + this J.1.0.6 spec commit.

### 2. agents/house-md/ source files all tracked

```bash
git ls-files agents/house-md/ | wc -l
git ls-files agents/house-md/
```

Expected: 9 lines (the 9 .md files). **HALT and ping raymond-holt** if any are missing or if extras have been added.

### 3. templates/house-md/ does NOT yet exist

```bash
test ! -d templates/house-md && echo "templates/house-md/ absent ✓"
```

**HALT and ping raymond-holt** if it already exists.

### 4. setup.sh shape unchanged from baseline

```bash
grep -nE '^materialize_house_md\(\)' setup.sh | head -3
# Expected: empty (function not yet defined)

grep -nE 'pm2 start ecosystem\.config\.cjs --only hive-runner' setup.sh | head -3
# Expected: 1 match around line 1182

grep -nE '^# Step 8: Create Working Directory$' setup.sh | head -3
# Expected: 1 match (Step 8 header)

grep -cE '^if ! step_done [0-9]+; then' setup.sh
# Expected: 10 (10 step gates intact)
```

**HALT and ping raymond-holt** if any shape unexpected.

### 5. ecosystem.config.cjs has both daemons defined

```bash
grep -E '"hive-runner"|"hive-dashboard"' ecosystem.config.cjs
# Expected: 2 matches
```

Confirms `pm2 startOrReload ecosystem.config.cjs --update-env` will start BOTH processes.

### 6. Tooling

```bash
bash --version | head -1
shellcheck --version | head -2
which cp grep awk
```

Expected: bash ≥ 3.2, shellcheck ≥ 0.7, standard Unix surface.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-J.1.0.6-fresh-install-bootstrap-completeness`.

**Diff lock: 10 paths exactly.**
- 9 new files: `templates/house-md/{AGENTS,BOOTSTRAP,IDENTITY,LESSONS,MEMORY,OUTPUT-LOG,SOUL,TASKS,USER}.md`
- 1 modified file: `setup.sh`

### A.1 — `templates/house-md/` (9 new files)

Worker creates the directory and copies all 9 files verbatim from `agents/house-md/`:

```bash
mkdir -p templates/house-md
cp -R agents/house-md/. templates/house-md/
```

The 9 expected files:
- `templates/house-md/AGENTS.md`
- `templates/house-md/BOOTSTRAP.md`
- `templates/house-md/IDENTITY.md`
- `templates/house-md/LESSONS.md`
- `templates/house-md/MEMORY.md`
- `templates/house-md/OUTPUT-LOG.md`
- `templates/house-md/SOUL.md`
- `templates/house-md/TASKS.md`
- `templates/house-md/USER.md`

**Locked: NO content edits.** The files are byte-identical to `agents/house-md/{file}.md` at the time of this PR. The framework repo's existing `agents/house-md/` content IS the factory default; no re-writing needed for this leaf.

Worker verifies after copy:
```bash
diff -r agents/house-md/ templates/house-md/
# Expected: empty (identical content)
```

### A.2 — `setup.sh` amendments

**Three insertions:**

#### A.2.1 — Add `materialize_house_md()` function

Insert near the other helper functions (around line 80-90, after `print_escape_footer()` and `detect_post_install_state()`):

```bash
# J.1.0.6 — materialize House MD agent from template on fresh install.
#
# Why: v1.5.0 tarball installs do NOT ship `agents/` (PRESERVE_LIST design —
# user agent customizations must survive `hive update`). House MD's behavior
# files live in `templates/house-md/` as the factory default. This function
# copies the template to `agents/house-md/` on first run so PM2 can start
# the agent in Step 10.
#
# Idempotency: skip if `agents/house-md/IDENTITY.md` already exists. Safe
# on `--resume` re-runs and safe if the user already populated agents/
# manually (e.g. an upgrader from v1.4.x where agents/house-md/ was
# git-tracked at install time).
#
# Failure mode: if templates/house-md/ is missing (packaging defect),
# print clear error and return 1.
materialize_house_md() {
    if [ -f agents/house-md/IDENTITY.md ]; then
        print_success "House MD agent files already present (skipping materialize)"
        return 0
    fi

    if [ ! -d templates/house-md ]; then
        print_error "templates/house-md/ missing from this install."
        echo "  Expected at: $(pwd)/templates/house-md/"
        echo "  This is a packaging defect. Fix:"
        echo "    1. Verify the install completed cleanly: ls $(pwd)/templates"
        echo "    2. If templates/ is incomplete, re-run: curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash"
        echo "    3. If problem persists, report at: https://github.com/anthonyconnelly/neato-hive/issues"
        return 1
    fi

    echo "Materializing House MD from templates/house-md/..."
    mkdir -p agents
    cp -R templates/house-md agents/house-md

    if [ ! -f agents/house-md/IDENTITY.md ]; then
        print_error "House MD materialize failed — agents/house-md/IDENTITY.md absent after cp."
        return 1
    fi

    print_success "House MD agent files materialized at agents/house-md/"
    return 0
}
```

#### A.2.2 — Call materialize_house_md at end of Step 8

Find the existing block in Step 8 (around line 1115-1130):

```bash
    if [ -f config/config.yaml ]; then
        sed -i.bak -E "s#^(    - )(~/neato-hive|~/hive)\$#\1${INSTALL_DIR_TILDE}#" config/config.yaml
        rm -f config/config.yaml.bak
        print_success "Patched config.yaml allowed_paths → $INSTALL_DIR_TILDE"
    fi

    state_save 8
```

Insert materialize call between config.yaml patch and `state_save 8`:

```bash
    if [ -f config/config.yaml ]; then
        sed -i.bak -E "s#^(    - )(~/neato-hive|~/hive)\$#\1${INSTALL_DIR_TILDE}#" config/config.yaml
        rm -f config/config.yaml.bak
        print_success "Patched config.yaml allowed_paths → $INSTALL_DIR_TILDE"
    fi

    # J.1.0.6 — materialize House MD from templates on fresh install
    if ! materialize_house_md; then
        print_error "House MD materialization failed — cannot continue setup."
        trap - INT TERM ERR
        exit 1
    fi

    state_save 8
```

#### A.2.3 — Replace `--only hive-runner` with full ecosystem startOrReload

Find line ~1180-1186:
```bash
# Register the hive-runner daemon (added in v1.3.0). Required for
# delegation, wake, and the agent-boot-announce mechanism. Without
# this, fresh installs after v1.3.0 silently lacked hive-runner —
# delegation/wake/boot-announce all no-op'd because nothing was polling.
if [ -f ecosystem.config.cjs ]; then
    echo "Starting hive-runner daemon..."
    pm2 start ecosystem.config.cjs --only hive-runner
    print_success "hive-runner registered"
fi
```

Replace with:
```bash
# J.1.0.6 — Register ALL ecosystem daemons. ecosystem.config.cjs defines:
#   - hive-runner    (delegation/wake/boot-announce — added v1.3.0)
#   - hive-dashboard (Express server on 0.0.0.0:7777 — added v1.5.0)
# Both must start on fresh install. pm2 startOrReload is idempotent;
# --update-env picks up HIVE_DASHBOARD_TOKEN written to .env by install.sh.
if [ -f ecosystem.config.cjs ]; then
    echo "Starting ecosystem daemons (hive-runner + hive-dashboard)..."
    pm2 startOrReload ecosystem.config.cjs --update-env
    print_success "hive-runner + hive-dashboard registered"
fi
```

**Locked semantics:**
- `pm2 start ecosystem.config.cjs --only hive-runner` → `pm2 startOrReload ecosystem.config.cjs --update-env`
- Drops the `--only` filter (now starts ALL ecosystem apps)
- `startOrReload` is idempotent (handles re-runs safely)
- `--update-env` ensures HIVE_DASHBOARD_TOKEN is exported to the new process

### A.3 — DO NOT modify

- `agents/house-md/` — leave intact (raymond-holt's dev-machine house-md)
- `scripts/release.sh` — templates/ already in REPLACE_LIST
- `bin/hive` — templates/ already in REPLACE_LIST array
- `install.sh`, `scripts/install-prereqs.sh`, `ecosystem.config.cjs`, `package.json`, `pnpm-lock.yaml`, `CHANGELOG.md`, `docs/v1.5.0-tasks/J.1-e2e-smoke-test.md`

---

## B. Tests + verification

### B.1 — Bash syntax + shellcheck

```bash
bash -n setup.sh && echo "setup.sh bash -n: ✓"
shellcheck setup.sh 2>&1 | tee /tmp/J106-setup-shellcheck.out | tail -10
# Expected: zero NEW warnings vs main baseline.
```

### B.2 — templates/house-md/ has all 9 files, byte-identical to agents/house-md/

```bash
test -d templates/house-md && echo "templates/house-md/ dir present ✓"
ls templates/house-md/ | wc -l
# Expected: 9 files
diff -r agents/house-md/ templates/house-md/ && echo "byte-identical ✓"
# Expected: no output (identical)
ls -la templates/house-md/IDENTITY.md
# Expected: file exists, regular file
```

### B.3 — setup.sh `materialize_house_md` function defined + idempotency check

```bash
grep -nE '^materialize_house_md\(\)' setup.sh | head -3
# Expected: 1 match — the function definition
grep -nE 'materialize_house_md$' setup.sh | head -3
# Expected: ≥ 1 call site (inside Step 8)
```

Function-isolation idempotency test (sandbox):

```bash
SANDBOX=/tmp/J106-test-mat-$$
mkdir -p "$SANDBOX"
cd "$SANDBOX"
cp -R ~/neato-hive/templates .  # copies the templates/ dir with new templates/house-md/

# First invocation — materializes
bash -c "
source ~/neato-hive/setup.sh 2>/dev/null
cd $SANDBOX
materialize_house_md
ls agents/house-md/IDENTITY.md
"
# Expected: 'Materializing House MD...' + success + agents/house-md/IDENTITY.md path

# Second invocation — idempotent, skips
bash -c "
source ~/neato-hive/setup.sh 2>/dev/null
cd $SANDBOX
materialize_house_md
"
# Expected: 'House MD agent files already present (skipping materialize)'

cd /tmp && rm -rf "$SANDBOX"
```

Worker may use a stub harness if sourcing setup.sh in isolation is fragile (setup.sh has top-level code that runs on source). Acceptable alternative: copy the materialize_house_md function definition into a /tmp test script and exercise it standalone.

### B.4 — setup.sh Step 10 starts BOTH daemons (no --only filter)

```bash
grep -nE 'pm2 startOrReload ecosystem.config.cjs' setup.sh | head -3
# Expected: 1 match (the new amended line)
grep -nE 'pm2 start ecosystem.config.cjs --only hive-runner' setup.sh | head -3
# Expected: empty (old line removed)
grep -nE 'hive-runner \+ hive-dashboard registered' setup.sh | head -3
# Expected: 1 match (the new success message)
```

### B.5 — setup.sh state-machine intact

```bash
grep -cE '^if ! step_done [0-9]+; then' setup.sh
# Expected: 10
grep -nE '^state_save 8$' setup.sh
# Expected: 1 match (state_save 8 still present after the new materialize call)
```

### B.6 — Tarball build with new templates/house-md/

Worker builds a tarball using release.sh and verifies templates/house-md/ ships:

```bash
# Bypass release.sh's pnpm install/build/test by stub OR run full release.sh
# (the latter is heavier but provides realistic proof). Worker's judgment.

# Option A: full release.sh
node -e "console.log(require('./package.json').version)"  # capture VERSION
bash scripts/release.sh "<VERSION>" 2>&1 | tail -5

# Inspect tarball for templates/house-md/
tar -tzf "/tmp/neato-hive-v<VERSION>.tar.gz" | grep '^dist-pkg/templates/house-md/' | sort
# Expected: 10 lines (1 for the dir + 9 for the files):
#   dist-pkg/templates/house-md/
#   dist-pkg/templates/house-md/AGENTS.md
#   dist-pkg/templates/house-md/BOOTSTRAP.md
#   dist-pkg/templates/house-md/IDENTITY.md
#   dist-pkg/templates/house-md/LESSONS.md
#   dist-pkg/templates/house-md/MEMORY.md
#   dist-pkg/templates/house-md/OUTPUT-LOG.md
#   dist-pkg/templates/house-md/SOUL.md
#   dist-pkg/templates/house-md/TASKS.md
#   dist-pkg/templates/house-md/USER.md
```

If running release.sh is too heavy, worker may use a stub that just runs the staging loop manually:
```bash
mkdir -p /tmp/J106-stage/templates
cp -R templates/house-md /tmp/J106-stage/templates/
ls /tmp/J106-stage/templates/house-md/
# Expected: 9 files
```

### B.7 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-J.1.0.6-fresh-install-bootstrap-completeness
# Expected: 10 lines
#   templates/house-md/AGENTS.md         | NN +++
#   templates/house-md/BOOTSTRAP.md      | NN +++
#   templates/house-md/IDENTITY.md       | NN +++
#   templates/house-md/LESSONS.md        | NN +++
#   templates/house-md/MEMORY.md         | NN +++
#   templates/house-md/OUTPUT-LOG.md     | NN +++
#   templates/house-md/SOUL.md           | NN +++
#   templates/house-md/TASKS.md          | NN +++
#   templates/house-md/USER.md           | NN +++
#   setup.sh                              | NN +++/---
```

### B.8 — Worker scope — host's agents/ unchanged

```bash
# Before worker run, the host's agents/house-md/ exists at framework root.
# Worker MUST NOT modify it (only COPY content into templates/).
diff -r ~/neato-hive/agents/house-md/ ~/neato-hive/templates/house-md/
# Expected: no output (identical — proves copy succeeded AND host unchanged)
```

### B.9 — File modes preserved

```bash
ls -l setup.sh
# Expected: -rwxr-xr-x (mode 0755)
ls -la templates/house-md/IDENTITY.md
# Expected: -rw-r--r-- (mode 0644 — matches templates/generalist/IDENTITY.md)
```

### B.10 — Cleanup

```bash
rm -f /tmp/J106-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 10 paths exactly (9 new templates/house-md/ files + setup.sh modified)
- [ ] B.1 `bash -n setup.sh` clean; shellcheck zero NEW warnings (info-only SC-codes acceptable per F.1/F.2/F.3 precedent)
- [ ] B.2 templates/house-md/ has 9 .md files, byte-identical to agents/house-md/
- [ ] B.3 `materialize_house_md` function defined + idempotency verified (re-runs return 0 with skip message)
- [ ] B.4 Step 10 amendment: `pm2 startOrReload ecosystem.config.cjs --update-env` replaces `pm2 start ecosystem.config.cjs --only hive-runner`; success message says "hive-runner + hive-dashboard registered"
- [ ] B.5 setup.sh state machine intact: 10 step gates, state_save 8 still present
- [ ] B.6 tarball inspection: 9 templates/house-md/* paths present under dist-pkg/
- [ ] B.7 diff stat = 10 paths
- [ ] B.8 host's `~/neato-hive/agents/house-md/` UNCHANGED (worker's templates/ creation does not modify it)
- [ ] B.9 file modes preserved
- [ ] **NO modifications to:** install.sh, scripts/install-prereqs.sh, scripts/release.sh, scripts/release-publish.sh, bin/hive, ecosystem.config.cjs, package.json, pnpm-lock.yaml, CHANGELOG.md, dashboard/, agents/, docs/v1.5.0-tasks/J.1-*.md
- [ ] **No PRESERVE_LIST or REPLACE_LIST changes** — templates/ already in both REPLACE_LISTs (J.1.0.5)
- [ ] **DO NOT RUN setup.sh end-to-end** — interactive wizard. Worker scope is function-isolation tests + diff inspection + tarball inspection only
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.9 outputs verbatim, sample diff of setup.sh (materialize function + Step 8 insertion + Step 10 amendment), sample tarball listing showing templates/house-md/*, diff-lock confirmation, "host agents/house-md/ unchanged" attestation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 10 paths (9 new templates/house-md/* + setup.sh modified)
Branch: feat/v1.5.0-J.1.0.6-fresh-install-bootstrap-completeness

Pre-flight outputs:
  1. framework HEAD: <sha — includes J.2-prep 2334851 + J.1.0.5 3375a29>
  2. agents/house-md/ tracked files: 9 ✓
  3. templates/house-md/ absent: ✓
  4. setup.sh baseline: Step 8 + line 1182 + 10 step-gates ✓
  5. ecosystem.config.cjs has both daemons: ✓
  6. tooling: bash ≥ 3.2 ✓ shellcheck ≥ 0.7 ✓ cp ✓ grep ✓

Tooling check:
  bash -n setup.sh: ✓
  shellcheck delta: 0 new warnings

Tests:
  B.2 templates/house-md/: 9 files, byte-identical to agents/house-md/ ✓
  B.3 materialize_house_md:
    - function defined ✓
    - call site in Step 8 ✓
    - idempotency (re-run returns skip) ✓
  B.4 Step 10 amendment:
    - pm2 startOrReload ecosystem.config.cjs --update-env present ✓
    - --only hive-runner removed ✓
    - success message: 'hive-runner + hive-dashboard registered' ✓
  B.5 state machine: 10 step gates, state_save 8 intact ✓
  B.6 tarball inspection: <verbatim tar -tzf output showing 9 templates/house-md/* paths>
  B.7 diff-lock = 10 paths ✓
  B.8 host agents/house-md/ unchanged ✓
  B.9 file modes preserved ✓

Worker scope attestations:
  - install.sh, scripts/install-prereqs.sh, scripts/release.sh, scripts/release-publish.sh,
    bin/hive, ecosystem.config.cjs, package.json, pnpm-lock.yaml, CHANGELOG.md, dashboard/,
    docs/v1.5.0-tasks/J.1-*.md ALL UNCHANGED
  - Host's ~/neato-hive/agents/house-md/ UNCHANGED (worker only READS from it for cp source)
  - Did NOT run setup.sh end-to-end (interactive wizard)
  - Did NOT modify REPLACE_LIST or PRESERVE_LIST in either release.sh or bin/hive
  - Did NOT install or start any PM2 processes

Sample diffs:
  setup.sh materialize function: <verbatim>
  setup.sh Step 8 insertion: <verbatim>
  setup.sh Step 10 amendment: <verbatim before/after>

Sample tarball listing (templates/house-md/* under dist-pkg/):
  <verbatim 9-line listing>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-J.1.0.6-fresh-install-bootstrap-completeness
  <verbatim — exactly 10 lines>

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full 10-path fix in single PR. No "we'll add hive-dashboard start in a follow-up."
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT MODIFY agents/house-md/** — leave the existing framework-repo dev-machine house-md content intact. J.1.0.6 only COPIES content into templates/house-md/.
- **DO NOT MODIFY REPLACE_LIST OR PRESERVE_LIST** — templates/ already in both (J.1.0.5 ensures it ships). agents/ correctly stays excluded from REPLACE_LIST.
- **DO NOT RUN setup.sh END-TO-END** — interactive wizard. Worker scope is function-isolation tests, diff inspection, and tarball inspection only.
- **DO NOT START ANY PM2 PROCESSES** — Step 10 changes are CODE changes; do not execute the changed line during testing.
- **DO NOT MODIFY** install.sh, scripts/install-prereqs.sh, scripts/release.sh, scripts/release-publish.sh, bin/hive, ecosystem.config.cjs, package.json, pnpm-lock.yaml, CHANGELOG.md, dashboard/, or any other file beyond setup.sh + templates/house-md/.
- **DO NOT EDIT THE COPIED TEMPLATE CONTENT** — `templates/house-md/{file}.md` is byte-identical to `agents/house-md/{file}.md`. No re-wording, no improvements, no metadata changes. Worker verifies with `diff -r`.
- **materialize_house_md IS IDEMPOTENT** — re-runs MUST return 0 with skip message. Verified in B.3.
- **`pm2 startOrReload` REPLACES `pm2 start --only`** — drops the filter, picks up env updates. Idempotent.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises (agents/house-md/ shape changed, templates/house-md/ already exists, setup.sh shape unexpected, ecosystem.config.cjs missing daemons) stop the worker. Halt means halt — do not fix-and-proceed inline. Your 6-for-6 L8 discipline pattern is the standard — keep it.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **v1.5.0.1 re-ship.** After J.1.0.6 merges, raymond-holt:
  1. `bash scripts/release.sh 1.5.0` — rebuilds tarball with templates/house-md/ included AND setup.sh fix
  2. `bash scripts/release-publish.sh 1.5.0` — pushes to site repo (currently broken Vercel auto-deploy; manual `vercel --prod` from cloned site repo with public/ move still required until F-1 future leaf)
  3. Verifies `https://neato-hive-site.vercel.app/install.sh` HTTP 200 (should already be live from previous ceremony; update is for the underlying tarball)
  4. Verifies updated tarball at `https://neato-hive-site.vercel.app/releases/v1.5.0/neato-hive-v1.5.0.tar.gz` (new SHA-256)
  5. Updates `releases/current.json` checksum to match new tarball
  6. Briefs Daniel — fresh install end-to-end now yields working House MD + working dashboard
- **F-1 (future leaf) — release-publish.sh public/ amendment.** Currently release-publish.sh pushes install.sh + releases/ to site repo ROOT, but Vercel serves public/ as the output dir. Manual fix done for v1.5.0 ceremony; future leaf amends release-publish.sh to push to public/ automatically.
- **F-2 (future leaf, owner-side) — Vercel GitHub auto-deploy investigation.** Manual `vercel --prod` works; GitHub push-to-deploy fails with "Error" status and no actionable logs. Needs Vercel dashboard access (owner-side).
- **Future leaf — Phase E.6 (Backups page) + E.7 (Tasks page).** Deferred per 2026-05-09 owner priority shift.
- **Future leaf — Phase G/H GUI installers.** Deferred per same.
- **Future leaf — Dashboard chat-mirror feature.** Per 2026-05-09 Daniel directive in MEMORY.md. Bidirectional WebSocket Discord mirror, failover-capable. Likely v1.5.x or v1.6.0.
