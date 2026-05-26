# v1.5.0 D.4 — Backups + Tasks + Runner-Events Endpoints + Dashboard CLI

**Status:** LOCKED — house-md dispatches Bob via fresh-turn one-shot cron once spec lands.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** D — Dashboard backend (5 PRs)
**Leaf:** D.4 (5 of 5 in Phase D — closing leaf, completes Phase D)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** D.0a (`693f24b`), D.1 (`9ca2824`), D.2 (`6a5581e`), D.3 (`ea96618`). Phase D 4/5.
**Successor:** Phase E — Dashboard frontend (E.0–E.7). After D.4 merges, **Phase D is closed**.

---

## Goal

D.4 closes Phase D by shipping four read-only data-surface endpoints + two CLI subcommands. Each endpoint feeds an E.x page; each CLI subcommand is owner-facing tooling for managing the dashboard auth token.

**Endpoints (mount post-auth):**

```
GET /api/sessions/active             — open task lifecycles (owner-directive primary surface)
GET /api/tasks?limit=N&offset=M      — task history per Decision E schema
GET /api/runner-events?limit=N&offset=M — paginated raw runner-events.log
GET /api/backups                     — list of available rollback shadows
```

**CLI subcommands (in `bin/hive`):**

```
hive dashboard token            — prints HIVE_DASHBOARD_TOKEN; generates if missing
hive dashboard rotate-token     — regenerates token, writes to .env, prints PM2-reload banner
```

**Owner directive lock (carried from MEMORY):** *"active spinning sessions" must be a primary surface.* `/api/sessions/active` is that surface. It reads `data/runner-events.log` and returns every task with an `discovered`/`spawned` event but no matching `exit`/`error`/`timeout` close (per the D.2 amendment closer set). The Overview page (E.1) consumes this for the "Active sessions" panel; the Tasks page (E.6) consumes it as the "live now" filter on top of the historical task table.

**Decision E schema lock for `/api/tasks`:** each row is `{ taskId, agent, kind, cmd_excerpt, started_at, elapsed_ms, status, last_runner_event }`. Sort by `elapsed_ms` desc by default. Auto-refresh 5s is a frontend concern (E.6); D.4 ships the data.

**PM2-ban for cmd_dashboard:** `hive dashboard rotate-token` MUST NOT call `pm2 restart` / `pm2 reload` etc. Instead, after writing the new token to `.env`, print a banner instructing the owner to run `pm2 restart hive-dashboard` themselves. Same pattern as C.7's migration banner. The dashboard process won't honor the rotated token until it's restarted — that's the owner's loop to close, not the worker's.

---

## Architectural givens (carried)

### `dashboard/lib/sessions.js` — open-lifecycle scan

Extracted from D.2's `lib/activity.js` algorithm. Pure function; same closer set (post-amendment): `discovered`/`spawned` opens, `exit`/`error`/`timeout` closes. Reused by `/api/sessions/active`.

```js
'use strict';

/**
 * findOpenLifecycles(events) — scan runner-events for tasks with an open
 * lifecycle (open without matching close). Returns one record per open task.
 *
 * Closer set matches D.2 amendment: exit | error | timeout.
 * Opens by discovered or spawned.
 */
function findOpenLifecycles(events) {
  const open = new Map();  // taskId → { event, agent, kind }
  for (const e of events) {
    if (!e.taskId) continue;
    switch (e.event) {
      case 'discovered':
      case 'spawned':
        open.set(e.taskId, e);
        break;
      case 'exit':
      case 'error':
      case 'timeout':
        open.delete(e.taskId);
        break;
    }
  }
  return Array.from(open.values());
}

module.exports = { findOpenLifecycles };
```

**Why a new module instead of importing from `activity.js`:** `activity.js`'s `deriveActivity` is per-agent and returns a single state record. `findOpenLifecycles` is global (across all agents) and returns multiple records. Different shape, different consumer. Sharing is contemplated in D.2's forward link, but extraction-into-shared-helper is cleaner here than coupling to the per-agent function.

### `dashboard/lib/tasks.js` — task history derivation

Builds the Decision E row schema from runner-events. For each `taskId` seen in the events stream:

1. Find the opening event (first `discovered` or `spawned` for that `taskId`)
2. Find the closing event (first `exit`/`error`/`timeout` for that `taskId`, if any)
3. Find the most recent event for that `taskId` (regardless of kind) — `last_runner_event`
4. Compute `elapsed_ms`:
   - If closed: `close.ts - open.ts`
   - If open: `Date.now() - open.ts`
5. Compute `status`:
   - Open: `running`
   - Closed by `exit`: `completed`
   - Closed by `error`: `errored`
   - Closed by `timeout`: `timed_out`
   - Open without an opening event but observed via other events: `unknown` (defensive)
6. Extract `cmd_excerpt`: first 200 chars of `discovered.detail.cmd` or `spawned.detail.cmd` if present, else `null`
7. Sort by `elapsed_ms` desc

```js
'use strict';

const STATUS_BY_CLOSER = {
  exit: 'completed',
  error: 'errored',
  timeout: 'timed_out',
};

function buildTaskHistory(events, { limit = 100, offset = 0 } = {}) {
  const tasks = new Map();
  for (const e of events) {
    if (!e.taskId) continue;
    if (!tasks.has(e.taskId)) {
      tasks.set(e.taskId, {
        taskId: e.taskId,
        agent: e.agent || null,
        kind: e.kind || null,
        cmd_excerpt: null,
        opened_at_ms: null,
        closed_at_ms: null,
        status: 'unknown',
        last_event: null,
        last_event_ts: null,
      });
    }
    const t = tasks.get(e.taskId);

    // Opening event
    if ((e.event === 'discovered' || e.event === 'spawned') && t.opened_at_ms === null) {
      t.opened_at_ms = Date.parse(e.ts) || null;
      // capture cmd_excerpt
      if (e.detail && typeof e.detail.cmd === 'string') {
        t.cmd_excerpt = e.detail.cmd.slice(0, 200);
      }
      // capture kind if not already set
      if (!t.kind && e.kind) t.kind = e.kind;
      // capture agent if not already set
      if (!t.agent && e.agent) t.agent = e.agent;
      if (t.status === 'unknown') t.status = 'running';
    }

    // Closing event
    if (STATUS_BY_CLOSER[e.event] && t.closed_at_ms === null) {
      t.closed_at_ms = Date.parse(e.ts) || null;
      t.status = STATUS_BY_CLOSER[e.event];
    }

    // Always update last_event
    t.last_event = e.event;
    t.last_event_ts = e.ts;
  }

  const rows = [];
  const now = Date.now();
  for (const t of tasks.values()) {
    const elapsed_ms = t.closed_at_ms !== null && t.opened_at_ms !== null
      ? t.closed_at_ms - t.opened_at_ms
      : t.opened_at_ms !== null
        ? now - t.opened_at_ms
        : null;
    rows.push({
      taskId: t.taskId,
      agent: t.agent,
      kind: t.kind,
      cmd_excerpt: t.cmd_excerpt,
      started_at: t.opened_at_ms !== null ? new Date(t.opened_at_ms).toISOString() : null,
      elapsed_ms,
      status: t.status,
      last_runner_event: t.last_event,
    });
  }

  // Sort by elapsed_ms desc; tasks with null elapsed sink to the bottom
  rows.sort((a, b) => {
    if (a.elapsed_ms === null && b.elapsed_ms === null) return 0;
    if (a.elapsed_ms === null) return 1;
    if (b.elapsed_ms === null) return -1;
    return b.elapsed_ms - a.elapsed_ms;
  });

  const total = rows.length;
  const sliced = rows.slice(offset, offset + limit);
  return { tasks: sliced, total };
}

module.exports = { buildTaskHistory };
```

**Locked semantics:**
- Pure function. No I/O. Testable with synthetic event arrays.
- `cmd_excerpt` = first 200 chars (raw — no HTML escaping; frontend handles render-side escaping).
- Default `limit=100`, default `offset=0`. Hard cap `limit ≤ 1000` enforced at the route handler.
- Sort is stable and deterministic for snapshots in tests.

### `dashboard/lib/backups.js` — shadow scan

Reads `~/neato-hive/.<item>.old.<ts>` files (the C.2 atomic-overlay-swap shadows that exist for rollback). Groups by `<ts>`, counts items, sums sizes, marks the latest as `is_latest: true`.

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createBackupsClient({ installRoot, fs: fsStub = fs } = {}) {
  function listBackups() {
    if (!fsStub.existsSync(installRoot)) return { backups: [], total: 0 };

    const entries = fsStub.readdirSync(installRoot, { withFileTypes: true });
    const groups = new Map();  // ts → { items: [], total_size_bytes }

    const PATTERN = /^\.(.+)\.old\.(\d{8}-\d{6})$/;

    for (const entry of entries) {
      const m = entry.name.match(PATTERN);
      if (!m) continue;
      const [, item, ts] = m;
      if (!groups.has(ts)) groups.set(ts, { items: [], total_size_bytes: 0 });
      const group = groups.get(ts);
      const fullPath = path.join(installRoot, entry.name);
      let size = 0;
      try {
        const stat = fsStub.statSync(fullPath);
        size = stat.size;
      } catch {
        size = 0;
      }
      group.items.push({ name: entry.name, item, size });
      group.total_size_bytes += size;
    }

    // Sort timestamps desc — newest first
    const tsOrder = Array.from(groups.keys()).sort().reverse();

    const backups = tsOrder.map((ts, idx) => ({
      id: ts,
      created_at: parseTsToIso(ts),
      items_count: groups.get(ts).items.length,
      total_size_bytes: groups.get(ts).total_size_bytes,
      is_latest: idx === 0,
    }));

    return { backups, total: backups.length };
  }

  return { listBackups };
}

function parseTsToIso(ts) {
  // C.x shadow timestamp format: YYYYMMDD-HHMMSS (UTC by convention from C.2)
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, Y, M, D, h, m_, s] = m;
  return `${Y}-${M}-${D}T${h}:${m_}:${s}Z`;
}

module.exports = { createBackupsClient };
```

**Locked semantics:**
- Scans `installRoot` (the framework root) at depth 1 only — `.<item>.old.<ts>` files are top-level.
- Groups by `<ts>` (the shadow timestamp suffix). Multi-item shadows (overlay touched many files at once) collapse into one backup record per timestamp.
- `is_latest` on the newest. Frontend uses this to highlight the rollback target.
- Pre-flight #5 confirms the actual on-disk pattern matches this regex; **HALT and ping house-md** if the format differs.

### Endpoint envelope shapes (locked)

**`GET /api/sessions/active`:**
```json
{
  "version": "1",
  "ts": "2026-05-07T20:30:00.000Z",
  "sessions": [
    {
      "task_id": "t_2026-05-07_bob-the-builder_xxx",
      "agent": "bob-the-builder",
      "kind": "codex",
      "cmd_excerpt": "first 200 chars of detail.cmd",
      "started_at": "2026-05-07T20:00:00.000Z",
      "elapsed_ms": 1800000,
      "last_runner_event": "wake_turn_complete",
      "last_event_ts": "2026-05-07T20:25:00.000Z"
    }
  ],
  "total": 1
}
```

Uses `findOpenLifecycles()` to identify open tasks; for each, finds the most recent event of the same task to populate `last_runner_event` + `last_event_ts`. `cmd_excerpt` from the opening event.

**`GET /api/tasks?limit=N&offset=M`:**
```json
{
  "version": "1",
  "ts": "...",
  "tasks": [ { "taskId", "agent", "kind", "cmd_excerpt", "started_at", "elapsed_ms", "status", "last_runner_event" } ],
  "total": 42,
  "limit": 100,
  "offset": 0
}
```

`limit` 1..1000 (default 100); `offset` ≥ 0 (default 0). 400 on out-of-range.

**`GET /api/runner-events?limit=N&offset=M`:**
```json
{
  "version": "1",
  "ts": "...",
  "events": [ /* raw event objects */ ],
  "total": 12345,
  "limit": 100,
  "offset": 0
}
```

`limit` 1..1000 (default 100); `offset` ≥ 0 (default 0). Returned events are MOST-RECENT-FIRST (last event in file = first event in response). 400 on out-of-range.

**`GET /api/backups`:**
```json
{
  "version": "1",
  "ts": "...",
  "backups": [
    { "id": "20260507-200000", "created_at": "2026-05-07T20:00:00Z", "items_count": 14, "total_size_bytes": 1234567, "is_latest": true }
  ],
  "total": 1
}
```

### `cmd_dashboard` CLI subcommands (in `bin/hive`)

Two subcommands. PM2-ban applies — neither runs `pm2 restart`/`reload`. Both manipulate `.env`.

```bash
cmd_dashboard() {
  local sub="${1:-}"
  shift || true
  case "${sub}" in
    token)
      _dashboard_print_token "$@"
      return $?
      ;;
    rotate-token)
      _dashboard_rotate_token "$@"
      return $?
      ;;
    "")
      error "Usage: hive dashboard <token|rotate-token>"
      return 2
      ;;
    *)
      error "Unknown subcommand: ${sub}. Available: token, rotate-token"
      return 2
      ;;
  esac
}

_dashboard_env_file() {
  echo "${HIVE_INSTALL_ROOT:-$HOME/neato-hive}/.env"
}

_dashboard_print_token() {
  local env_file
  env_file="$(_dashboard_env_file)"
  if [ -f "${env_file}" ] && grep -qE '^HIVE_DASHBOARD_TOKEN=' "${env_file}"; then
    grep -E '^HIVE_DASHBOARD_TOKEN=' "${env_file}" | head -1 | sed 's/^HIVE_DASHBOARD_TOKEN=//'
    return 0
  fi
  # Generate if missing
  if [ ! -f "${env_file}" ]; then
    touch "${env_file}"
  fi
  local token
  if ! token="$(openssl rand -hex 32 2>/dev/null)" || [ -z "${token}" ]; then
    error "openssl rand -hex 32 failed — cannot generate token"
    return 1
  fi
  printf '\nHIVE_DASHBOARD_TOKEN=%s\n' "${token}" >> "${env_file}"
  echo "${token}"
  echo ""
  info "Token added to ${env_file}."
  info "Run 'pm2 restart hive-dashboard' to apply (the dashboard process must restart to read the new env var)."
  return 0
}

_dashboard_rotate_token() {
  local env_file
  env_file="$(_dashboard_env_file)"
  if [ ! -f "${env_file}" ]; then
    touch "${env_file}"
  fi
  local token
  if ! token="$(openssl rand -hex 32 2>/dev/null)" || [ -z "${token}" ]; then
    error "openssl rand -hex 32 failed — cannot rotate token"
    return 1
  fi
  if grep -qE '^HIVE_DASHBOARD_TOKEN=' "${env_file}"; then
    # Cross-platform sed -i: macOS BSD sed needs '' arg; GNU sed doesn't
    if [ "$(uname)" = "Darwin" ]; then
      sed -i '' "s|^HIVE_DASHBOARD_TOKEN=.*|HIVE_DASHBOARD_TOKEN=${token}|" "${env_file}"
    else
      sed -i "s|^HIVE_DASHBOARD_TOKEN=.*|HIVE_DASHBOARD_TOKEN=${token}|" "${env_file}"
    fi
  else
    printf '\nHIVE_DASHBOARD_TOKEN=%s\n' "${token}" >> "${env_file}"
  fi
  echo "${token}"
  echo ""
  echo "  ┌──────────────────────────────────────────────────────────────────┐"
  echo "  │  Token rotated.                                                  │"
  echo "  │                                                                  │"
  echo "  │  To apply, restart the dashboard process:                        │"
  echo "  │      pm2 restart hive-dashboard                                  │"
  echo "  │                                                                  │"
  echo "  │  Until you do, the running dashboard still honors the OLD token. │"
  echo "  │  Existing browser sessions using the old token will start        │"
  echo "  │  failing 401 once the restart completes.                         │"
  echo "  └──────────────────────────────────────────────────────────────────┘"
  return 0
}
```

**Locked semantics:**
- `hive dashboard token` is **idempotent**: existing token in `.env` is printed unchanged. Missing token triggers generation (matches C.7's behavior).
- `hive dashboard rotate-token` is **always destructive**: regenerates a new token regardless of whether one exists. **Old token is lost.** Owner is informed via banner that browser sessions using the old token will start 401-ing post-restart.
- Both write to the same `.env` PRESERVE_LIST file. Token is byte-exact 64-hex-char output of `openssl rand -hex 32`.
- **`cmd_dashboard` MUST NOT call any PM2 verbs.** Banner is the only PM2 reference. B.gate enforces.
- Wired into `bin/hive`'s main dispatcher case statement (around line 2998 per pre-flight #4).

---

## Pre-conditions

- Phase D 4/5: D.0a (`693f24b`), D.1 (`9ca2824`), D.2 (`6a5581e`), D.3 (`ea96618`) merged on framework main
- D.3 dashboard surface (`dashboard/lib/state-file.js`, `dashboard/lib/sse.js`, `dashboard/routes/doctor.js`, `dashboard/routes/update.js`) present
- `data/runner-events.log` exists (worker confirms; if empty, all task/sessions endpoints return empty arrays — that's the expected baseline)
- `cmd_dashboard` not yet defined in `bin/hive`
- `openssl` available (carried from C.7)

---

## Where state lives (D.4 conventions)

**New files (11):**
- `dashboard/lib/sessions.js`
- `dashboard/lib/tasks.js`
- `dashboard/lib/backups.js`
- `dashboard/routes/sessions.js`
- `dashboard/routes/tasks.js`
- `dashboard/routes/runner-events.js`
- `dashboard/routes/backups.js`
- `dashboard/test/sessions.test.js`
- `dashboard/test/tasks.test.js`
- `dashboard/test/backups.test.js`
- `dashboard/test/runner-events.routes.test.js` (filename amendment 2026-05-07 — disambiguates from D.2's `dashboard/test/runner-events.test.js` which holds the lib parser tests)

**Modified files (2):**
- `dashboard/app.js` — accept `sessions`, `tasks`, `backups` injection options; mount the 4 new routers
- `bin/hive` — add `cmd_dashboard` + helpers + register `dashboard)` in main dispatcher

**Total: 13 paths.**

**No new dependencies.** Implementation uses `express`, `dotenv` (carried), and Node built-ins.

---

## Pre-flight (worker MUST run all 7; outputs captured in PR body)

### 1. Framework repo current state (post-D.3)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `ea96618` (D.3 merge) plus D.4-spec commit.

### 2. D.3 dashboard surface present

```bash
test -f dashboard/lib/state-file.js && echo "state-file.js ✓"
test -f dashboard/lib/sse.js && echo "sse.js ✓"
test -f dashboard/routes/doctor.js && echo "routes/doctor.js ✓"
test -f dashboard/routes/update.js && echo "routes/update.js ✓"
```

**HALT and ping house-md** if any are missing.

### 3. D.4 target paths absent

```bash
for p in dashboard/lib/sessions.js dashboard/lib/tasks.js dashboard/lib/backups.js \
         dashboard/routes/sessions.js dashboard/routes/tasks.js \
         dashboard/routes/runner-events.js dashboard/routes/backups.js \
         dashboard/test/sessions.test.js dashboard/test/tasks.test.js \
         dashboard/test/backups.test.js dashboard/test/runner-events.routes.test.js; do
  test ! -f "$p" && echo "$p absent ✓" || { echo "FAIL: $p exists"; exit 1; }
done
# NOTE: dashboard/test/runner-events.test.js DOES exist (shipped by D.2 — lib parser tests).
# D.4 introduces a SEPARATE file at dashboard/test/runner-events.routes.test.js for route tests.
grep -nE '^cmd_dashboard\(\)|^_dashboard_(print_token|rotate_token|env_file)\(\)' bin/hive | head -5
# Expected: empty
```

**HALT and ping house-md** if any exist.

### 4. `bin/hive` main dispatcher location

```bash
sed -n '2995,3030p' bin/hive
```

Worker captures the dispatcher case statement around line 2998. Plans the surgery to add `dashboard) cmd_dashboard "$@" ;;`. **HALT and ping house-md** if the dispatcher shape is unrecognizable (e.g. the line drifted >50 lines in any direction).

### 5. Shadow file pattern verification

```bash
ls -la ~/neato-hive/.*.old.* 2>/dev/null | head -10 || echo "no shadows present (no recent updates)"
```

If shadows present, capture sample filenames. Worker confirms they match `^\.(.+)\.old\.(\d{8}-\d{6})$`. **HALT and ping house-md** if format differs from the lock.

If no shadows present, that's fine — `/api/backups` returns empty. Worker creates synthetic fixture shadows in tests.

### 6. Runner-events sample for task-history shape

```bash
test -f data/runner-events.log && echo "log present ✓ ($(wc -l < data/runner-events.log) lines)"
# Sample 3 events with detail.cmd
jq -c 'select(.detail.cmd != null) | {ts, taskId, agent, kind, event, cmd_len: (.detail.cmd | length)}' < data/runner-events.log 2>/dev/null | head -3
```

Worker captures sample to confirm the `detail.cmd` field shape used by `cmd_excerpt` extraction. Most events don't have `detail.cmd`; `discovered`/`spawned` events typically do.

### 7. Tooling

```bash
node --version && pnpm --version && which openssl && which sed && which jq
uname  # Darwin or Linux — affects sed -i syntax
```

Expected: Node ≥ 22, openssl present (for cmd_dashboard), sed present, jq present.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-D.4-backups-tasks-runner-events`.

**Diff lock: 13 paths exactly** (11 new + `dashboard/app.js` + `bin/hive` modified).

### A.1 — `dashboard/lib/sessions.js`

Per the §Architectural givens block. Locked exports: `findOpenLifecycles(events) → Array<openEvent>`.

### A.2 — `dashboard/lib/tasks.js`

Per the §Architectural givens block. Locked exports: `buildTaskHistory(events, { limit, offset }) → { tasks, total }`.

### A.3 — `dashboard/lib/backups.js`

Per the §Architectural givens block. Locked exports: `createBackupsClient({ installRoot, fs? }) → { listBackups() }`.

### A.4 — `dashboard/routes/sessions.js`

```javascript
'use strict';

const express = require('express');
const { findOpenLifecycles } = require('../lib/sessions');

const router = express.Router();

router.get('/active', async (req, res) => {
  const { runnerEvents } = req.app.locals;
  try {
    const events = await runnerEvents.readAll();
    const opens = findOpenLifecycles(events);
    const lastByTaskId = new Map();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e.taskId) continue;
      if (!lastByTaskId.has(e.taskId)) lastByTaskId.set(e.taskId, e);
    }
    const now = Date.now();
    const sessions = opens.map((open) => {
      const last = lastByTaskId.get(open.taskId) || open;
      const startedAt = Date.parse(open.ts);
      return {
        task_id: open.taskId,
        agent: open.agent || null,
        kind: open.kind || null,
        cmd_excerpt:
          open.detail && typeof open.detail.cmd === 'string'
            ? open.detail.cmd.slice(0, 200)
            : null,
        started_at: open.ts,
        elapsed_ms: Number.isFinite(startedAt) ? now - startedAt : null,
        last_runner_event: last.event,
        last_event_ts: last.ts,
      };
    });
    sessions.sort((a, b) => {
      if (a.elapsed_ms === null && b.elapsed_ms === null) return 0;
      if (a.elapsed_ms === null) return 1;
      if (b.elapsed_ms === null) return -1;
      return b.elapsed_ms - a.elapsed_ms;
    });
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      sessions,
      total: sessions.length,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/sessions/active error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

module.exports = router;
```

### A.5 — `dashboard/routes/tasks.js`

```javascript
'use strict';

const express = require('express');
const { buildTaskHistory } = require('../lib/tasks');

const router = express.Router();

router.get('/', async (req, res) => {
  const { runnerEvents } = req.app.locals;
  const limit = parseIntInRange(req.query.limit, 100, 1, 1000);
  const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (limit === null) return res.status(400).json({ error: 'bad_limit', detail: 'limit must be 1..1000' });
  if (offset === null) return res.status(400).json({ error: 'bad_offset', detail: 'offset must be ≥ 0' });
  try {
    const events = await runnerEvents.readAll();
    const { tasks, total } = buildTaskHistory(events, { limit, offset });
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      tasks,
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/tasks error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

function parseIntInRange(raw, def, min, max) {
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

module.exports = router;
```

### A.6 — `dashboard/routes/runner-events.js`

```javascript
'use strict';

const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { runnerEvents } = req.app.locals;
  const limit = parseIntInRange(req.query.limit, 100, 1, 1000);
  const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (limit === null) return res.status(400).json({ error: 'bad_limit', detail: 'limit must be 1..1000' });
  if (offset === null) return res.status(400).json({ error: 'bad_offset', detail: 'offset must be ≥ 0' });
  try {
    const all = await runnerEvents.readAll();
    // Most-recent-first
    const reversed = all.slice().reverse();
    const total = reversed.length;
    const sliced = reversed.slice(offset, offset + limit);
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      events: sliced,
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/runner-events error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

function parseIntInRange(raw, def, min, max) {
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

module.exports = router;
```

### A.7 — `dashboard/routes/backups.js`

```javascript
'use strict';

const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { backups } = req.app.locals;
  try {
    const result = backups.listBackups();
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      backups: result.backups,
      total: result.total,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/backups error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

module.exports = router;
```

### A.8 — `dashboard/app.js` modification

Update factory to accept `sessions`, `tasks`, `backups` (only `backups` is a DI-relevant module — `sessions` and `tasks` are pure functions imported directly from `lib/` by the route handlers). Mount 4 new routers.

```javascript
const sessionsRouter = require('./routes/sessions');
const tasksRouter = require('./routes/tasks');
const runnerEventsRouter = require('./routes/runner-events');
const backupsRouter = require('./routes/backups');
const { createBackupsClient } = require('./lib/backups');

function createApp({ token, pm2, runnerEvents, frameworkRoot, listAgents,
                     doctor, update, stateFile, backups } = {}) {
  // ... existing setup ...
  const backupsClient = backups || createBackupsClient({ installRoot: root });
  app.locals.backups = backupsClient;

  // ... existing mounts ...
  app.use('/api/sessions', sessionsRouter);    // D.4
  app.use('/api/tasks', tasksRouter);          // D.4
  app.use('/api/runner-events', runnerEventsRouter);  // D.4
  app.use('/api/backups', backupsRouter);      // D.4
}
```

### A.9 — `bin/hive` cmd_dashboard

Per the §Architectural givens block. Three new helpers (`_dashboard_env_file`, `_dashboard_print_token`, `_dashboard_rotate_token`) + `cmd_dashboard` dispatcher + register `dashboard)` in the main dispatcher case statement (line ~2998).

**Comment block above `cmd_dashboard`:**

```bash
# v1.5.0 D.4 — `hive dashboard <subcommand>` CLI for managing the dashboard
# auth token. Subcommands:
#
#   hive dashboard token         — print HIVE_DASHBOARD_TOKEN; generate if missing
#   hive dashboard rotate-token  — regenerate, write to .env, print PM2-reload banner
#
# PM2 ban: NEITHER subcommand calls `pm2 restart`/`pm2 reload`. Banner instructs
# the owner to run the restart manually. Same pattern as C.7's migration handler.
#
# See docs/v1.5.0-tasks/D.4-backups-tasks-runner-events.md for full contract.
```

### A.10 — `dashboard/test/sessions.test.js`

Locked test cases (6):
1. Empty events → empty sessions array, total=0
2. One open `discovered` (no close) → one session with `cmd_excerpt` from `detail.cmd`
3. `discovered` then `exit` → zero sessions
4. `discovered` then `error` → zero sessions (post-amendment closer set)
5. `discovered` then `timeout` → zero sessions
6. Multiple opens across agents → multiple sessions, sorted by `elapsed_ms` desc

### A.11 — `dashboard/test/tasks.test.js`

Locked test cases (8):
1. Empty events → empty tasks, total=0
2. Single open task → status="running", `closed_at_ms`=null, elapsed_ms ≈ now-open
3. Closed by `exit` → status="completed"
4. Closed by `error` → status="errored"
5. Closed by `timeout` → status="timed_out"
6. `cmd_excerpt` truncated at 200 chars
7. Sort by `elapsed_ms` desc; tasks with null elapsed sink to bottom
8. limit/offset slicing

### A.12 — `dashboard/test/backups.test.js`

Tests `createBackupsClient` with an injected `fs` stub.

Locked test cases (6):
1. Empty install root → backups empty
2. One shadow ts with multiple items → one backup record, items_count=N, total_size_bytes=sum
3. Multiple ts groups → sorted desc, latest has `is_latest: true`
4. Files NOT matching `.<item>.old.<ts>` are ignored
5. `created_at` correctly parsed from YYYYMMDD-HHMMSS to ISO 8601
6. Stat failures don't crash (zero-size fallback for unreadable shadow file)

### A.13 — `dashboard/test/runner-events.routes.test.js`

Tests `/api/runner-events` route via supertest-style fetch + ephemeral-port app.

**Filename amendment 2026-05-07:** D.2 already shipped `dashboard/test/runner-events.test.js` for lib-parser tests. D.4's route tests live at a separate path (`runner-events.routes.test.js`) to avoid collision. Both files coexist in `dashboard/test/`; the parser tests stay where D.2 put them.

Locked test cases (5):
1. Returns 200 + envelope with `version: "1"`, `events`, `total`, `limit`, `offset`
2. Most-recent-first ordering (last event in source = events[0])
3. Default limit=100, offset=0
4. limit=0 → 400
5. limit=1001 → 400

---

## B. Tests

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/D4-test.out
# Expected: 84 (D.0a/D.1/D.2/D.3 carry-over) + 6 (sessions) + 8 (tasks) +
#           6 (backups) + 5 (runner-events) = 109 tests passing
grep -E '✔|pass' /tmp/D4-test.out | wc -l
```

Worker captures the per-file count.

### B.2 — Lockfile reproducibility

```bash
cd ~/neato-hive/dashboard
rm -rf node_modules
pnpm install --frozen-lockfile
echo "lockfile reproducible ✓"
pnpm list --depth=0 --prod
# Expected: express + dotenv only — D.4 adds NO new prod deps
```

### B.3 — Live boot smoke

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=47777 \
  node dashboard/index.js > /tmp/D4-boot.out 2>&1 &
PID=$!
sleep 2
kill -0 $PID && echo "process alive ✓"

# /api/sessions/active
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47777/api/sessions/active | jq -c '{version, sessions_len: (.sessions | length), total}'

# /api/tasks
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47777/api/tasks | jq -c '{version, total, limit, offset, tasks_len: (.tasks | length)}'

# /api/runner-events?limit=5
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47777/api/runner-events?limit=5" | jq -c '{version, total, events_len: (.events | length)}'

# /api/backups
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47777/api/backups | jq -c '{version, total}'

# Auth gate (carries from D.1 — verify it still works)
RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47777/api/tasks)
test "$RC" = "401" && echo "/api/tasks unauth → 401 ✓"

# 400 on bad params
RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47777/api/tasks?limit=0")
test "$RC" = "400" && echo "/api/tasks?limit=0 → 400 ✓"

RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47777/api/runner-events?limit=1001")
test "$RC" = "400" && echo "/api/runner-events?limit=1001 → 400 ✓"

kill $PID
```

### B.4 — `cmd_dashboard token` smoke

```bash
TMPENV=$(mktemp -d)/.env-d4
HIVE_INSTALL_ROOT="$(dirname "$TMPENV")" bash bin/hive dashboard token > /tmp/D4-token-1.out 2>&1
RC=$?
echo "B.4.a: exit code: $RC"
TOKEN_1=$(head -1 /tmp/D4-token-1.out | tr -d '[:space:]')
echo "$TOKEN_1" | grep -qE '^[a-f0-9]{64}$' && echo "B.4.a: 64-hex token returned ✓"

# Idempotent: second call returns the SAME token (already in .env)
HIVE_INSTALL_ROOT="$(dirname "$TMPENV")" bash bin/hive dashboard token > /tmp/D4-token-2.out 2>&1
TOKEN_2=$(head -1 /tmp/D4-token-2.out | tr -d '[:space:]')
test "$TOKEN_1" = "$TOKEN_2" && echo "B.4.b: idempotent ✓"

rm -rf "$(dirname "$TMPENV")"
```

### B.5 — `cmd_dashboard rotate-token` smoke

```bash
TMPDIR=$(mktemp -d)
TMPENV="$TMPDIR/.env"
echo 'OTHER_VAR=preserve_me' > "$TMPENV"
echo 'HIVE_DASHBOARD_TOKEN=oldtokenoldtokenoldtokenoldtokenoldtokenoldtokenoldtokenoldtokenold' >> "$TMPENV"
echo 'TRAILING_VAR=preserve' >> "$TMPENV"

HIVE_INSTALL_ROOT="$TMPDIR" bash bin/hive dashboard rotate-token > /tmp/D4-rotate.out 2>&1
NEW=$(head -1 /tmp/D4-rotate.out | tr -d '[:space:]')
echo "$NEW" | grep -qE '^[a-f0-9]{64}$' && echo "B.5.a: new 64-hex token ✓"
test "$NEW" != "oldtokenoldtokenoldtokenoldtokenoldtokenoldtokenoldtokenoldtokenold" && echo "B.5.b: new != old ✓"

# .env preserved other vars
grep -q '^OTHER_VAR=preserve_me$' "$TMPENV" && echo "B.5.c: leading var preserved ✓"
grep -q '^TRAILING_VAR=preserve$' "$TMPENV" && echo "B.5.d: trailing var preserved ✓"

# Token line replaced (not duplicated)
test "$(grep -cE '^HIVE_DASHBOARD_TOKEN=' "$TMPENV")" = "1" && echo "B.5.e: token line not duplicated ✓"

# Banner present in output
grep -qE 'Token rotated|pm2 restart hive-dashboard' /tmp/D4-rotate.out && echo "B.5.f: PM2-restart banner printed ✓"

rm -rf "$TMPDIR"
```

### B.6 — PM2-ban gate against `cmd_dashboard`

```bash
# Confirm no `pm2 restart` etc. is actually invoked from cmd_dashboard
# (the banner reference is a string, not an exec)
git diff main...feat/v1.5.0-D.4-backups-tasks-runner-events -- bin/hive \
  | grep -E '^\+' \
  | grep -E '\bpm2 (restart|reload|start|delete|save|stop|kill|startOrReload)\b' \
  | grep -vE '^\+#|^\+\s*echo|^\+\s*info|^\+\s*error' \
  | head -5
# Expected: empty (matches only inside echo/info/error/banner strings, never as bare exec)
```

### B.7 — Dispatcher integration

```bash
# After surgery, `hive dashboard` (without subcommand) returns 2 + usage error
TMPDIR=$(mktemp -d)
HIVE_INSTALL_ROOT="$TMPDIR" bash bin/hive dashboard 2>/tmp/D4-disp.err
RC=$?
test "$RC" = "2" && echo "B.7.a: bare 'hive dashboard' rc=2 ✓"
grep -qE 'Usage: hive dashboard' /tmp/D4-disp.err && echo "B.7.b: usage error ✓"

HIVE_INSTALL_ROOT="$TMPDIR" bash bin/hive dashboard bogus-sub 2>/tmp/D4-disp2.err
RC=$?
test "$RC" = "2" && echo "B.7.c: unknown sub rc=2 ✓"

rm -rf "$TMPDIR"
```

### B.8 — Diff-lock confirmation

```bash
cd ~/neato-hive
git diff --stat main...feat/v1.5.0-D.4-backups-tasks-runner-events
# Expected: exactly 13 lines:
#   bin/hive (modified)
#   dashboard/app.js (modified)
#   dashboard/lib/sessions.js
#   dashboard/lib/tasks.js
#   dashboard/lib/backups.js
#   dashboard/routes/sessions.js
#   dashboard/routes/tasks.js
#   dashboard/routes/runner-events.js
#   dashboard/routes/backups.js
#   dashboard/test/sessions.test.js
#   dashboard/test/tasks.test.js
#   dashboard/test/backups.test.js
#   dashboard/test/runner-events.routes.test.js

# pnpm-lock.yaml MUST NOT change
git diff main...feat/v1.5.0-D.4-backups-tasks-runner-events -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.9 — Live install state untouched by worker

```bash
# Worker MUST NOT call `hive dashboard rotate-token` against the live ~/neato-hive/.env.
# All tests use TMPDIR-isolated .env files.
ls -la ~/neato-hive/.env 2>/dev/null
grep -E '^HIVE_DASHBOARD_TOKEN=' ~/neato-hive/.env 2>/dev/null | head -1 | sed 's/=.*/=<redacted>/'
# Worker captures BEFORE pre-flight + AFTER full test run. Token byte-content
# must NOT change.
```

### B.10 — Cleanup

```bash
rm -f /tmp/D4-*.out /tmp/D4-*.err
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 13 paths exactly (11 new + `dashboard/app.js` + `bin/hive` modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED (no new dependencies)
- [ ] B.1 test suite: 25 new tests pass (6 + 8 + 6 + 5 = 25); total ≥ 109 with carry-overs
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/api/sessions/active`, `/api/tasks`, `/api/runner-events`, `/api/backups` all return 200; auth gate works; bad-param 400 enforced
- [ ] B.4 `cmd_dashboard token` returns 64-hex token; idempotent on second call (same token)
- [ ] B.5 `cmd_dashboard rotate-token`: returns NEW 64-hex token (≠ old); preserves other env vars; doesn't duplicate the token line; prints PM2-restart banner
- [ ] B.6 PM2-ban gate: no `pm2 (restart|reload|...)` exec lines in `bin/hive` diff (only in echo/info/banner strings)
- [ ] B.7 dispatcher integration: bare `hive dashboard` rc=2; unknown sub rc=2
- [ ] B.8 diff-lock = 13 paths
- [ ] **Live `~/neato-hive/.env` HIVE_DASHBOARD_TOKEN value UNCHANGED** by worker — explicit DONE-block attestation
- [ ] **Live `~/.neato-hive/state/`, `~/.neato-hive/migrations/`, and shadow files UNCHANGED** by worker
- [ ] PR body: pre-flight 1-7 outputs verbatim, B.1-B.7 outputs verbatim, diff-lock confirmation, "live state untouched" attestations, sample envelope outputs (redacted of any tokens)

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 13 paths (11 new + dashboard/app.js modified + bin/hive modified)
Branch: feat/v1.5.0-D.4-backups-tasks-runner-events

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. D.3 dashboard surface present: ✓
  3. D.4 target paths absent: ✓
  4. dispatcher case statement: <captured at line ~2998>
  5. shadow file pattern: <captured or "no shadows present">
  6. runner-events sample with detail.cmd: <captured>
  7. tooling: node ≥22 ✓ pnpm ✓ openssl ✓ sed ✓ jq ✓
     uname: <captured> (affects sed -i syntax)

Tests:
  B.1 test suite (pnpm test):
    - dashboard/test/health.test.js (D.1): 4 passed
    - dashboard/test/auth.test.js (D.1): 8 passed
    - dashboard/test/pm2.test.js (D.2): 8 passed
    - dashboard/test/runner-events.test.js: 6 passed (D.2 — lib parser; carry-over)
    - dashboard/test/activity.test.js (D.2): 12 passed
    - dashboard/test/status.test.js (D.2): 5 passed
    - dashboard/test/agents.test.js (D.2): 12 passed
    - dashboard/test/doctor.test.js (D.3): 5 passed
    - dashboard/test/update.test.js (D.3): 10 passed
    - dashboard/test/state-file.test.js (D.3): 8 passed
    - dashboard/test/sse.test.js (D.3): 6 passed
    - dashboard/test/sessions.test.js (D.4): 6 passed
    - dashboard/test/tasks.test.js (D.4): 8 passed
    - dashboard/test/backups.test.js (D.4): 6 passed
    - dashboard/test/runner-events.routes.test.js: 5 passed (D.4 — route tests)
    Total: 109 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke: all 4 endpoints + auth + bad-param ✓
  B.4 dashboard token: 64-hex + idempotent ✓
  B.5 dashboard rotate-token: new token + preserved env + no duplication + banner ✓
  B.6 PM2-ban gate (cmd_dashboard): ✓
  B.7 dispatcher integration: rc=2 on bare/unknown ✓
  B.8 diff-lock = 13 paths ✓

Worker scope attestations:
  - Live ~/neato-hive/.env HIVE_DASHBOARD_TOKEN UNCHANGED
  - Live ~/.neato-hive/state/ UNCHANGED
  - Live ~/.neato-hive/migrations/ UNCHANGED
  - Live shadow files UNCHANGED
  - dashboard/pnpm-lock.yaml UNCHANGED
  - No PM2 verbs executed by worker

Sample responses (redacted):
  /api/sessions/active → <full JSON, redacted>
  /api/tasks → <full JSON>
  /api/runner-events?limit=5 → <full JSON>
  /api/backups → <full JSON>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-D.4-backups-tasks-runner-events
  <verbatim — exactly 13 lines>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
**Phase D closes when this PR merges. Phase E begins next.**
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full endpoint suite (sessions + tasks + runner-events + backups) + 3 lib + 2 CLI subcommands + 4 test files in single PR. Phase D closes here.
- **DO NOT MERGE** — house-md
- **DO NOT EXEC PM2 IN ANY PATH** — `cmd_dashboard rotate-token` MUST NOT call `pm2 restart`/`reload`/`startOrReload`/etc. Banner-only. B.6 enforces.
- **DO NOT TOUCH LIVE `.env`** — worker tests use TMPDIR-isolated `.env` files. Live `~/neato-hive/.env` HIVE_DASHBOARD_TOKEN baselined before/after.
- **DO NOT DELETE/MODIFY SHADOW FILES** — worker's `/api/backups` lib only READS the shadow directory. No mutating ops. Live shadow files baselined before/after.
- **DO NOT EXTEND DEPENDENCIES** — production deps remain `express` + `dotenv`. No new packages.
- **DO NOT BREAK D.0a/D.1/D.2/D.3 TESTS** — health + auth + pm2 + runner-events (lib) + activity + status + agents + doctor + update + state-file + sse must still pass at their previous counts.
- **CLOSER SET LOCKED** — `discovered`/`spawned` opens; `exit`/`error`/`timeout` closes. Same as D.2 amendment. Forward-protection HALT-and-ping rule for unknown lifecycle events carries.
- **SHADOW PATTERN LOCKED** — `^\.(.+)\.old\.(\d{8}-\d{6})$`. Pre-flight #5 verifies. **HALT and ping house-md** if format differs.
- **`hive dashboard rotate-token` IS DESTRUCTIVE** — old token is irretrievable. Banner makes this explicit. No `--force` flag needed since the operation is owner-initiated.
- **HALT-and-ping rule** — pre-flight surprises (D.3 surface missing, dispatcher shape unrecognizable, shadow format differs, openssl absent) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.
- **No new shell-tool deps** — node + pnpm + openssl + sed + jq + curl + hive (from D.x carry-overs).

---

## F. Forward links

- **Phase E (after D.4 closes):** Frontend pages consume the D.x endpoints:
  - E.1 Overview — `/api/status` + `/api/sessions/active` + recent_events embedded in `/api/status`
  - E.2 Agents — `/api/agents` + restart button posts `/api/agents/:name/restart`
  - E.3 Agent detail — `/api/agents/:name` + `/api/agents/:name/logs`
  - E.4 Doctor — `/api/doctor`
  - E.5 Updates — `/api/update/check` (button gate per owner directive: hide/disable when `update_available !== true`) + `/api/update/apply` + EventSource on `/api/update/progress/:id` + polling fallback `/api/update/status/:id`. C.7 migration banner rendered from `migration-pm2-reload-pending` event detail.
  - E.6 Tasks — `/api/tasks` (sort by `elapsed_ms` desc, auto-refresh 5s) + `/api/sessions/active` for "live now" filter
  - E.7 Backups — `/api/backups` (rollback CTA links out to a CLI snippet `hive update --rollback <id>`; in-app rollback POST is a future leaf)
  - E.8 Runner events — `/api/runner-events` (paginated table)
- **Future leaf — in-app rollback:** `POST /api/update/rollback` body `{ shadow_id }` calling `hive update --rollback <ts>`. Spec'd outside D.4.
- **Future leaf — `/api/runner-events` streaming-tail:** when log size grows beyond a few MB, full-read becomes expensive. Replace with tail-from-byte-offset.
- **Future leaf — `current_activity` extraction sharing:** D.2's `lib/activity.js` `deriveActivity` and D.4's `lib/sessions.js` `findOpenLifecycles` share core logic (open-tracking via taskId map). A future cleanup leaf may extract a single `findOpenLifecyclesByTaskId(events) → Map<taskId, openEvent>` shared by both. Not blocking — both work today.
