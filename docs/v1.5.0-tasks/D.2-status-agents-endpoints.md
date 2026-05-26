# v1.5.0 D.2 — Status / Agents / Restart / Logs Endpoints + PM2 Cache + `current_activity`

**Status:** LOCKED — house-md dispatches Bob via SendMessage on this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** D — Dashboard backend (5 PRs)
**Leaf:** D.2 (3 of 5 in Phase D)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** D.0a ✅ merged 2026-05-07 (PR #63 squash `693f24b`), D.1 ✅ merged 2026-05-07 20:14:56Z (PR #64 squash `9ca2824`). Phase D 2/5.
**Successor:** D.3 — Doctor + update endpoints (depends on D.2's app skeleton + auth gate, but otherwise independent surface)

---

## Goal

Wire the dashboard backend to read framework state — PM2 process status, declared agents, runner-events log — and expose it via five endpoints behind D.1's bearer-token auth:

```
GET  /api/status                     — high-level health summary
GET  /api/agents                     — list of declared agents with rolled-up status
GET  /api/agents/:name               — single-agent detail
POST /api/agents/:name/restart       — restart an agent's PM2 process
GET  /api/agents/:name/logs?lines=N  — tail PM2 stdout+stderr logs
```

Plus three internal modules that future leaves (D.3, D.4) will reuse:

- **`dashboard/lib/pm2.js`** — PM2 client. Shells out to `pm2 jlist` (read-only) with a 1500ms in-process cache. Owns `restartProcess(name)` (calls `pm2 restart <name>`) which is the runtime mutating verb.
- **`dashboard/lib/runner-events.js`** — JSONL parser for `data/runner-events.log`. Streams the file backwards (tail-then-parse) so callers can ask for "last N events" without loading the entire log into memory.
- **`dashboard/lib/activity.js`** — derives a per-agent `current_activity` record from the runner-events stream. Locked state enum: `idle | turn | task`. Used by `/api/agents` and `/api/agents/:name`.

**Decision E carry-over:** every `/api/agents` and `/api/agents/:name` response includes a `current_activity` field. The Overview page (E.1) consumes `/api/status` which embeds a `recent_events` array (last N events from runner-events.log) so the "Recent runner events" subsection renders without a separate round-trip. The dedicated `/api/sessions/active` endpoint and `/api/runner-events` paginated endpoint stay in D.4 — D.2 ships only the rolled-up surfaces needed for the Overview + Agents pages.

---

## Architectural givens (carried)

### Dependency injection — testability is a first-class contract

`createApp({ token, pm2, runnerEvents, frameworkRoot })` accepts mocks for the PM2 client, the runner-events reader, and the framework root path. Tests pass deterministic stubs; production wiring uses real implementations. **No global module state inside route handlers** — every external call goes through `req.app.locals.pm2` / `req.app.locals.runnerEvents` (or equivalent injected accessor).

This pattern lets Bob test the restart endpoint without actually restarting anything, the logs endpoint without real PM2 logs on disk, and `current_activity` derivation against synthetic runner-event fixtures. The PM2-ban rule for worker scope is satisfied because tests never spawn `pm2` — they exercise the route handlers against stubs.

### PM2 client + 1500ms cache

```js
// dashboard/lib/pm2.js
const { spawnSync } = require('node:child_process');

function createPm2Client({ ttlMs = 1500, spawn = spawnSync } = {}) {
  let cache = null;        // { fetchedAt: number, processes: Pm2Process[] }
  let inflight = null;     // Promise|null — coalesce concurrent fetches

  async function listProcesses() {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < ttlMs) {
      return cache.processes;
    }
    if (inflight) return inflight;
    inflight = new Promise((resolve, reject) => {
      try {
        const result = spawn('pm2', ['jlist'], { encoding: 'utf8', timeout: 5000 });
        if (result.status !== 0) {
          reject(new Error(`pm2 jlist failed: rc=${result.status} stderr=${result.stderr || ''}`));
          return;
        }
        const parsed = JSON.parse(result.stdout || '[]');
        cache = { fetchedAt: Date.now(), processes: parsed };
        resolve(parsed);
      } catch (err) {
        reject(err);
      } finally {
        inflight = null;
      }
    });
    return inflight;
  }

  function restartProcess(name) {
    const result = spawn('pm2', ['restart', name], { encoding: 'utf8', timeout: 10000 });
    cache = null;  // invalidate
    if (result.status !== 0) {
      const err = new Error(`pm2 restart failed: rc=${result.status} stderr=${result.stderr || ''}`);
      err.code = 'PM2_RESTART_FAILED';
      throw err;
    }
    return { name, restarted: true };
  }

  function clearCache() { cache = null; }

  return { listProcesses, restartProcess, clearCache };
}

module.exports = { createPm2Client };
```

**Locked semantics:**
- `listProcesses()` returns the parsed `pm2 jlist` JSON array (each element has `name`, `pm_id`, `pid`, `pm2_env.status`, `monit.cpu`, `monit.memory`, etc.).
- Cache TTL is `1500ms` (centered in the 1-2s spec window). Configurable via `ttlMs` for tests.
- Concurrent fetches coalesce via the `inflight` promise — one spawn even if 100 requests arrive simultaneously.
- `restartProcess(name)` is the **only mutating PM2 verb** in the dashboard. Invalidates the cache so the next list call sees the post-restart state.
- `spawnSync` is injectable via `spawn` factory option — tests pass a fake.
- 5-second timeout on `pm2 jlist`, 10-second timeout on `pm2 restart`. Errors propagate as rejected promises (list) or thrown errors (restart).

### Runner-events parser

Locked event shape from live log inspection:

```jsonc
{
  "ts": "2026-05-07T19:47:54.095Z",
  "taskId": "t_2026-05-07_bob-the-builder_vdwt",
  "agent": "bob-the-builder",
  "kind": "codex",                        // optional — task type tag
  "event": "discovered",                  // top-level event name
  "detail": { /* event-specific */ }
}
```

**`event` is the top-level key. `kind` is the task TYPE classifier (codex/claude) and only appears on task-lifecycle events. Do not confuse them.**

Locked event vocabulary (from live log inspection — amendment 2026-05-07 folded Bob's pre-flight #4 catch):

**Activity-driving (task lifecycle):**
- `discovered` — task spec discovered by the runner; **opens** the task lifecycle
- `spawned` — task child process started; **opens** the task lifecycle (some task types emit only one or the other; treating either as the open is the correctness-favoring choice)
- `exit` — task child process exited cleanly; **closes** the task lifecycle
- `error` — task errored out (e.g. orphan recovery from runner restart per the v1.4.9 lesson); **closes** the task lifecycle
- `timeout` — task hit its budget and the runner killed the child; **closes** the task lifecycle

**Activity-driving (turn lifecycle):**
- `wake_turn_started` — agent's claude turn began; **opens** the turn lifecycle
- `wake_turn_complete` — agent's claude turn ended (regardless of success/error — `detail.status` carries the outcome); **closes** the turn lifecycle

**Lifecycle events (not activity-driving):**
- `wake_picked_up` — runner picked up a wake file for the agent
- `wake_enqueued` — runner enqueued a wake file (precursor to `wake_picked_up`)
- `wake_archived` — wake file moved to processed/
- `boot` — runner process boot beacon
- `boot_wake_enqueued` — runner queued a wake on its own boot
- `shutdown` — runner process shutdown signal

These events have no `taskId` (or task-irrelevant ones) and never open/close lifecycles. `deriveActivity` ignores them.

**Why `error` and `timeout` MUST close the task lifecycle (Class A correctness):** without these, a task that errored out or hit timeout stays in the `openTasks` map indefinitely. The agent then appears "still running a task" in `current_activity` even though the task is dead. The 2026-05-06 v1.4.9 orphan-recovery flow specifically emits `error` events on runner restart for tasks that didn't get a clean `exit` — `deriveActivity` must treat these as terminal.

Worker captures the actual event-vocabulary via pre-flight grep against the live log. If the discovered set introduces a kind not in the locked list above AND the kind appears lifecycle-related (e.g. a new `cancelled`, `crashed`, `aborted`), **HALT and ping house-md** rather than guessing whether it's a closer.

```js
// dashboard/lib/runner-events.js
const fs = require('node:fs');
const readline = require('node:readline');

function createRunnerEventsReader({ logPath, fs: fsStub = fs } = {}) {
  async function readLastN(limit = 100) {
    if (!fsStub.existsSync(logPath)) return [];
    // Read whole file (acceptable size — log is rotated by the runner) and parse.
    // For multi-MB logs this will need streaming-tail; for D.2 scope, full read
    // with per-line JSON.parse is the safest correctness choice.
    const raw = await fsStub.promises.readFile(logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const last = lines.slice(-limit);
    return last.map(parseLine).filter((e) => e !== null);
  }

  async function readAll() {
    return readLastN(Number.MAX_SAFE_INTEGER);
  }

  return { readLastN, readAll };
}

function parseLine(line) {
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== 'object' || obj === null) return null;
    if (typeof obj.ts !== 'string') return null;
    if (typeof obj.event !== 'string') return null;
    return obj;
  } catch {
    return null;  // malformed line — drop silently (parser is forgiving)
  }
}

module.exports = { createRunnerEventsReader, parseLine };
```

**Locked semantics:**
- `readLastN(limit)` reads the entire file, splits on newlines, and returns the last `limit` parsed events. Malformed lines are dropped silently (forward-compat — adding a new field never breaks the dashboard).
- `parseLine` exported separately for unit testing.
- `fs` is injectable for tests.
- **Full file read is the lock for D.2.** Streaming-tail optimization is a D.4 concern (when the dedicated `/api/runner-events` endpoint may need to handle larger logs). Today's logs are small enough.

### `current_activity` derivation

Locked state enum: `idle | turn | task`.

Algorithm (per agent):

1. Read all events from runner-events.log
2. For each task lifecycle: `discovered` / `spawned` opens, **`exit` / `error` / `timeout`** closes (matched by `taskId`). All three closers are terminal — task is dead, lifecycle closed.
3. For each turn lifecycle: `wake_turn_started` opens, `wake_turn_complete` closes (matched by `taskId`). `wake_turn_complete.detail.status` carries the outcome (ok/error) but the close itself is unconditional on the event kind.
4. For agent X, find:
   - **Open task lifecycle** for X (an open without a matching close): if any → state="task", `task_id` from the open event, `since` from the open event's `ts`
   - **Open turn lifecycle** for X (no `wake_turn_complete` after `wake_turn_started`): if any → state="turn", `task_id` if present, `since` from the open event's `ts`
   - **Both** open: task wins (a task can include multiple turns; the higher-level lifecycle is the surface)
   - Neither open → state="idle", `task_id` null, `since` null

```js
// dashboard/lib/activity.js
function deriveActivity(events, agentName) {
  const openTasks = new Map();   // taskId → opening event
  const openTurns = new Map();   // taskId → opening event

  for (const e of events) {
    if (e.agent !== agentName) continue;
    switch (e.event) {
      case 'discovered':
      case 'spawned':
        if (e.taskId) openTasks.set(e.taskId, e);
        break;
      case 'exit':
      case 'error':       // amendment: orphan-recovery + runtime errors are terminal
      case 'timeout':     // amendment: budget-exceeded is terminal
        if (e.taskId) openTasks.delete(e.taskId);
        break;
      case 'wake_turn_started':
        if (e.taskId) openTurns.set(e.taskId, e);
        break;
      case 'wake_turn_complete':
        if (e.taskId) openTurns.delete(e.taskId);
        break;
      // Lifecycle events (not activity-driving): wake_picked_up, wake_enqueued,
      // wake_archived, boot, boot_wake_enqueued, shutdown. They have no taskId
      // (or task-irrelevant ones) and never open/close lifecycles.
    }
  }

  // Task lifecycle wins over turn (turns are nested inside tasks)
  for (const [taskId, openEvent] of openTasks) {
    return { state: 'task', task_id: taskId, since: openEvent.ts };
  }
  for (const [taskId, openEvent] of openTurns) {
    return { state: 'turn', task_id: taskId, since: openEvent.ts };
  }
  return { state: 'idle', task_id: null, since: null };
}

module.exports = { deriveActivity };
```

**Locked semantics:**
- Pure function. No I/O. Easy to test with synthetic event arrays.
- `openTasks` / `openTurns` track unmatched opens. Iteration order yields the most-recently-opened (Map insertion order). Returning the first hit is "any open" — for typical workloads at most one is open per agent.
- Closes by `taskId` only. If a close arrives without a matching open, the open-tracking map silently no-ops the delete. Missing-open + open-only never accumulate.
- `discovered` and `spawned` BOTH open the task lifecycle (some task types emit one or the other; treating either as the open is the correctness-favoring choice).
- `exit`, `error`, and `timeout` ALL close the task lifecycle. They are treated identically — the dashboard does not surface "task ended via error" vs "via timeout" in `current_activity`. That distinction lives in the most-recent terminal event's `detail` for any consumer that cares (e.g. D.4's `/api/sessions/active` may surface terminal cause).

### Endpoint response shapes (locked)

**`GET /api/status`:**

```json
{
  "version": "1",
  "ts": "2026-05-07T20:30:00.000Z",
  "framework_version": "1.5.0",
  "dashboard": {
    "uptime_s": 12345,
    "node_version": "v22.11.0"
  },
  "agents": {
    "total": 5,
    "by_state": { "idle": 3, "turn": 1, "task": 1 }
  },
  "pm2": {
    "total": 6,
    "online": 6,
    "errored": 0
  },
  "recent_events": [
    { "ts": "...", "agent": "bob-the-builder", "event": "wake_turn_complete", "taskId": "..." }
  ]
}
```

`recent_events` returns the last 20 events. Locked count.

**`GET /api/agents`:**

```json
{
  "version": "1",
  "ts": "...",
  "agents": [
    {
      "name": "atlas",
      "pm2_status": "online",
      "current_activity": { "state": "idle", "task_id": null, "since": null },
      "last_event_ts": "2026-05-07T19:30:00.000Z",
      "last_event": "wake_archived"
    }
  ]
}
```

**`GET /api/agents/:name`:**

```json
{
  "version": "1",
  "ts": "...",
  "name": "atlas",
  "pm2": {
    "status": "online",
    "pid": 12345,
    "cpu_percent": 0.4,
    "memory_bytes": 78901234,
    "uptime_s": 9876,
    "restart_count": 2
  },
  "current_activity": { "state": "task", "task_id": "t_...", "since": "..." },
  "recent_events": [
    /* last 20 events for THIS agent only */
  ]
}
```

**`POST /api/agents/:name/restart`:**

```json
{ "version": "1", "ts": "...", "name": "atlas", "restarted": true }
```

Returns `200` on success. Returns `404` with `{ error: "agent_not_found" }` if the name isn't in PM2 (per `pm2 jlist`). Returns `500` with `{ error: "pm2_restart_failed", detail: "..." }` if the spawn fails.

**`GET /api/agents/:name/logs?lines=N`:**

```json
{
  "version": "1",
  "ts": "...",
  "name": "atlas",
  "lines_requested": 100,
  "stdout": [ "line 1", "line 2", "..." ],
  "stderr": [ "err 1", "..." ]
}
```

`lines` query param: integer, default 100, min 1, max 1000. Out-of-range → 400. Reads tail of `~/.pm2/logs/<name>-out.log` and `<name>-error.log` (paths from `pm2 jlist` `pm2_env.pm_out_log_path` / `pm_err_log_path`). If a log file doesn't exist, returns empty array for that stream (not an error).

---

## Pre-conditions

- Phase D 2/5: D.0a (`693f24b`) and D.1 (`9ca2824`) merged on framework main
- `dashboard/app.js`, `dashboard/middleware/auth.js`, `dashboard/routes/health.js` from D.1 present
- `data/runner-events.log` exists in framework root (worker confirms; if log file is empty/absent, all `current_activity` derivations return `idle` — that's the expected baseline behavior)
- `pm2` available on Bob's machine (already verified by D.1 pre-flight)
- Node ≥ 22 (carried from D.1)

---

## Where state lives (D.2 conventions)

**New files (10):**
- `dashboard/lib/pm2.js`
- `dashboard/lib/runner-events.js`
- `dashboard/lib/activity.js`
- `dashboard/routes/status.js`
- `dashboard/routes/agents.js`
- `dashboard/test/pm2.test.js`
- `dashboard/test/runner-events.test.js`
- `dashboard/test/activity.test.js`
- `dashboard/test/status.test.js`
- `dashboard/test/agents.test.js`

**Modified file (1):**
- `dashboard/app.js` — accept `{ token, pm2, runnerEvents, frameworkRoot }` options; mount the new routers; wire route handlers to access injected modules via `req.app.locals`

**Total: 11 paths.**

**No new dependencies.** Implementation uses only `express`, `dotenv` (carried from D.1), and Node built-ins (`node:child_process`, `node:fs`, `node:path`, `node:os`).

---

## Pre-flight (worker MUST run all 8; outputs captured in PR body)

### 1. Framework repo current state (post-D.1)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `9ca2824` (D.1 merge) + `693f24b` (D.0a merge) + D-spec commits.

### 2. D.1 dashboard skeleton present

```bash
test -d dashboard && echo "dashboard/ present ✓"
test -f dashboard/app.js && echo "app.js present ✓"
test -f dashboard/middleware/auth.js && echo "auth middleware present ✓"
test -f dashboard/routes/health.js && echo "health route present ✓"
test -f dashboard/package.json && echo "package.json present ✓"
test -f dashboard/pnpm-lock.yaml && echo "lockfile present ✓"
```

**HALT and ping house-md** if any are missing.

### 3. D.2 target paths absent

```bash
test ! -d dashboard/lib && echo "dashboard/lib/ absent ✓" || echo "FAIL"
test ! -f dashboard/routes/status.js && echo "status route absent ✓" || echo "FAIL"
test ! -f dashboard/routes/agents.js && echo "agents route absent ✓" || echo "FAIL"
ls dashboard/test/ 2>/dev/null
# Expected: only health.test.js + auth.test.js (D.1 tests). HALT if any D.2 tests exist.
```

### 4. Runner-events log shape (worker captures actual vocabulary)

```bash
test -f data/runner-events.log && echo "log present ✓" || echo "log absent (D.2 will read empty)"
if [ -f data/runner-events.log ]; then
  echo "--- distinct event vocabulary (top 20):"
  jq -r '.event' < data/runner-events.log 2>/dev/null | sort -u | head -20

  echo "--- top-level keys (sample first record):"
  head -1 data/runner-events.log | jq -r 'keys | sort | join(",")'

  echo "--- byte size:"
  wc -c < data/runner-events.log

  echo "--- line count:"
  wc -l < data/runner-events.log
fi
```

Expected vocabulary (subset of, not necessarily all): `wake_picked_up`, `wake_turn_started`, `wake_turn_complete`, `wake_archived`, `discovered`. Worker captures the actual set. **HALT and ping house-md** if a kind appears that isn't in the locked derivation algorithm AND looks lifecycle-related (e.g. `started`, `failed`, `crashed`).

### 5. PM2 jlist shape (worker captures process keys for the detail endpoint)

```bash
pm2 jlist 2>/dev/null | jq '.[0] | {name, pid, status: .pm2_env.status, restart_time: .pm2_env.restart_time, monit: {cpu: .monit.cpu, memory: .monit.memory}, log_paths: {out: .pm2_env.pm_out_log_path, err: .pm2_env.pm_err_log_path}}'
```

Expected: a sample process record with the listed fields populated. Worker confirms log paths point to `~/.pm2/logs/`.

### 6. `pm2 jlist` works without sudo + completes < 1s

```bash
time pm2 jlist > /dev/null
```

Expected: completes well under 1500ms cache TTL. Worker captures wall-clock.

### 7. Sibling pattern check (services/hive-releases-api shape)

```bash
ls dashboard/lib 2>/dev/null
ls services/hive-releases-api/middleware 2>/dev/null
```

Informational. D.2's `dashboard/lib/` directory introduction follows the existing repo pattern of grouping non-route helpers under a `lib/` subfolder.

### 8. Tooling

```bash
node --version && pnpm --version && which jq
```

Expected: Node ≥ 22, pnpm any, jq present.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-D.2-status-agents-endpoints`.

**Diff lock: 11 paths exactly** (10 new + 1 modified — `dashboard/app.js`).

### A.1 — `dashboard/lib/pm2.js`

Per the §Architectural givens block above. Locked exports: `createPm2Client({ ttlMs?, spawn? }) → { listProcesses(), restartProcess(name), clearCache() }`.

### A.2 — `dashboard/lib/runner-events.js`

Per the §Architectural givens block. Locked exports: `createRunnerEventsReader({ logPath, fs? }) → { readLastN(limit), readAll() }` and named export `parseLine(line)`.

### A.3 — `dashboard/lib/activity.js`

Per the §Architectural givens block. Locked exports: `deriveActivity(events, agentName) → { state, task_id, since }`. Pure function. State enum: `idle | turn | task`.

### A.4 — `dashboard/routes/status.js`

```javascript
'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const router = express.Router();

router.get('/', async (req, res) => {
  const { pm2, runnerEvents, frameworkRoot, listAgents } = req.app.locals;

  try {
    const [processes, recentEvents, allEvents, agents] = await Promise.all([
      pm2.listProcesses().catch((err) => ({ __error: err.message })),
      runnerEvents.readLastN(20),
      runnerEvents.readAll(),  // for activity rollup
      Promise.resolve(listAgents()),
    ]);

    if (processes && processes.__error) {
      // PM2 failure is a soft failure for /api/status — return what we have
      return res.status(200).json({
        version: '1',
        ts: new Date().toISOString(),
        framework_version: getFrameworkVersion(frameworkRoot),
        dashboard: { uptime_s: Math.floor(process.uptime()), node_version: process.version },
        agents: { total: agents.length, by_state: { idle: agents.length, turn: 0, task: 0 } },
        pm2: { total: 0, online: 0, errored: 0, error: processes.__error },
        recent_events: recentEvents,
      });
    }

    const { deriveActivity } = require('../lib/activity');
    const stateCounts = { idle: 0, turn: 0, task: 0 };
    for (const agentName of agents) {
      const activity = deriveActivity(allEvents, agentName);
      stateCounts[activity.state]++;
    }

    const onlineCount = (processes || []).filter((p) => p.pm2_env && p.pm2_env.status === 'online').length;
    const erroredCount = (processes || []).filter((p) => p.pm2_env && p.pm2_env.status === 'errored').length;

    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      framework_version: getFrameworkVersion(frameworkRoot),
      dashboard: {
        uptime_s: Math.floor(process.uptime()),
        node_version: process.version,
      },
      agents: {
        total: agents.length,
        by_state: stateCounts,
      },
      pm2: {
        total: (processes || []).length,
        online: onlineCount,
        errored: erroredCount,
      },
      recent_events: recentEvents,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/status error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

let cachedFrameworkVersion = null;
function getFrameworkVersion(frameworkRoot) {
  if (cachedFrameworkVersion) return cachedFrameworkVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(frameworkRoot, 'package.json'), 'utf8'));
    cachedFrameworkVersion = pkg.version || 'unknown';
  } catch {
    cachedFrameworkVersion = 'unknown';
  }
  return cachedFrameworkVersion;
}

module.exports = router;
```

### A.5 — `dashboard/routes/agents.js`

```javascript
'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { deriveActivity } = require('../lib/activity');

const router = express.Router();

// GET /api/agents
router.get('/', async (req, res) => {
  const { pm2, runnerEvents, listAgents } = req.app.locals;
  try {
    const [processes, allEvents] = await Promise.all([
      pm2.listProcesses().catch(() => []),
      runnerEvents.readAll(),
    ]);
    const agentNames = listAgents();
    const lastEventByAgent = new Map();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const e = allEvents[i];
      if (!e.agent) continue;
      if (!lastEventByAgent.has(e.agent)) lastEventByAgent.set(e.agent, e);
    }
    const agents = agentNames.map((name) => {
      const activity = deriveActivity(allEvents, name);
      const proc = (processes || []).find((p) => p.name === name);
      const lastEvt = lastEventByAgent.get(name);
      return {
        name,
        pm2_status: proc && proc.pm2_env ? proc.pm2_env.status : 'not_running',
        current_activity: activity,
        last_event_ts: lastEvt ? lastEvt.ts : null,
        last_event: lastEvt ? lastEvt.event : null,
      };
    });
    res.status(200).json({ version: '1', ts: new Date().toISOString(), agents });
  } catch (err) {
    console.error('[hive-dashboard] /api/agents error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// GET /api/agents/:name
router.get('/:name', async (req, res) => {
  const { name } = req.params;
  const { pm2, runnerEvents, listAgents } = req.app.locals;
  if (!listAgents().includes(name)) {
    return res.status(404).json({ error: 'agent_not_found', name });
  }
  try {
    const [processes, allEvents] = await Promise.all([
      pm2.listProcesses().catch(() => []),
      runnerEvents.readAll(),
    ]);
    const proc = (processes || []).find((p) => p.name === name);
    const activity = deriveActivity(allEvents, name);
    const recentForAgent = allEvents.filter((e) => e.agent === name).slice(-20);
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      name,
      pm2: proc
        ? {
            status: proc.pm2_env ? proc.pm2_env.status : 'unknown',
            pid: proc.pid,
            cpu_percent: proc.monit ? proc.monit.cpu : null,
            memory_bytes: proc.monit ? proc.monit.memory : null,
            uptime_s: proc.pm2_env && proc.pm2_env.pm_uptime
              ? Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000)
              : null,
            restart_count: proc.pm2_env ? proc.pm2_env.restart_time : null,
          }
        : null,
      current_activity: activity,
      recent_events: recentForAgent,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/agents/:name error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /api/agents/:name/restart
router.post('/:name/restart', async (req, res) => {
  const { name } = req.params;
  const { pm2, listAgents } = req.app.locals;
  if (!listAgents().includes(name)) {
    return res.status(404).json({ error: 'agent_not_found', name });
  }
  // Confirm the agent is in PM2
  try {
    const procs = await pm2.listProcesses();
    if (!procs.some((p) => p.name === name)) {
      return res.status(404).json({ error: 'agent_not_in_pm2', name });
    }
  } catch (err) {
    return res.status(500).json({ error: 'pm2_list_failed', detail: err.message });
  }
  try {
    pm2.restartProcess(name);
    res.status(200).json({ version: '1', ts: new Date().toISOString(), name, restarted: true });
  } catch (err) {
    res.status(500).json({ error: err.code || 'pm2_restart_failed', detail: err.message });
  }
});

// GET /api/agents/:name/logs
router.get('/:name/logs', async (req, res) => {
  const { name } = req.params;
  const { pm2, listAgents } = req.app.locals;
  if (!listAgents().includes(name)) {
    return res.status(404).json({ error: 'agent_not_found', name });
  }
  let lines = parseInt(req.query.lines || '100', 10);
  if (!Number.isFinite(lines) || lines < 1 || lines > 1000) {
    return res.status(400).json({ error: 'bad_lines', detail: 'lines must be 1..1000' });
  }
  try {
    const procs = await pm2.listProcesses();
    const proc = procs.find((p) => p.name === name);
    if (!proc) {
      return res.status(404).json({ error: 'agent_not_in_pm2', name });
    }
    const outPath = proc.pm2_env && proc.pm2_env.pm_out_log_path;
    const errPath = proc.pm2_env && proc.pm2_env.pm_err_log_path;
    const stdout = await tailFile(outPath, lines);
    const stderr = await tailFile(errPath, lines);
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      name,
      lines_requested: lines,
      stdout,
      stderr,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/agents/:name/logs error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

async function tailFile(filePath, lines) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const all = raw.split('\n');
  // Drop trailing empty line from a trailing newline
  if (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-lines);
}

module.exports = router;
```

### A.6 — `dashboard/app.js` (modified)

Update the app factory to accept the injection map. Existing health route + auth wiring stays.

```javascript
'use strict';

const express = require('express');
const path = require('node:path');
const { createAuthMiddleware } = require('./middleware/auth');
const healthRouter = require('./routes/health');
const statusRouter = require('./routes/status');
const agentsRouter = require('./routes/agents');
const { createPm2Client } = require('./lib/pm2');
const { createRunnerEventsReader } = require('./lib/runner-events');
const fs = require('node:fs');

/**
 * createApp({ token, pm2?, runnerEvents?, frameworkRoot?, listAgents? })
 *
 * Defaults wire production implementations. Tests pass stubs for pm2 /
 * runnerEvents / listAgents so route handlers are exercised against
 * deterministic fixtures.
 */
function createApp({ token, pm2, runnerEvents, frameworkRoot, listAgents } = {}) {
  if (!token) throw new Error('createApp: token is required');

  const root = frameworkRoot || process.cwd();
  const pm2Client = pm2 || createPm2Client();
  const runnerEventsReader =
    runnerEvents ||
    createRunnerEventsReader({ logPath: path.join(root, 'data', 'runner-events.log') });
  const agentsLister = listAgents || (() => listDeclaredAgents(root));

  const app = express();
  app.locals.pm2 = pm2Client;
  app.locals.runnerEvents = runnerEventsReader;
  app.locals.frameworkRoot = root;
  app.locals.listAgents = agentsLister;

  app.use(express.json({ limit: '1mb' }));

  // Public health probe — bypasses auth so PM2 / Tailscale healthchecks work.
  app.use('/api/health', healthRouter);

  // Auth middleware applies to every route below this line.
  app.use(createAuthMiddleware(token));

  // D.2 routes
  app.use('/api/status', statusRouter);
  app.use('/api/agents', agentsRouter);

  // 404 fallback
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[hive-dashboard] error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/**
 * Default implementation of listAgents() — reads agent names from
 * <frameworkRoot>/agents/<name>/ directories. Each agent is a subdirectory.
 */
function listDeclaredAgents(frameworkRoot) {
  const dir = path.join(frameworkRoot, 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'));
}

module.exports = { createApp };
```

### A.7 — `dashboard/test/pm2.test.js`

Tests the PM2 client with an injected `spawn` stub. No real PM2 invocation.

Locked test cases (8):
1. `listProcesses` returns parsed JSON when spawn returns valid output
2. `listProcesses` caches within TTL (second call doesn't re-spawn)
3. `listProcesses` re-fetches after TTL expires
4. Concurrent `listProcesses` calls coalesce to one spawn
5. `listProcesses` rejects when spawn returns non-zero exit
6. `restartProcess` invokes spawn with `[pm2, restart, name]`
7. `restartProcess` invalidates the cache (next list re-spawns)
8. `restartProcess` throws with `code: PM2_RESTART_FAILED` on non-zero exit

### A.8 — `dashboard/test/runner-events.test.js`

Tests the events reader with an injected `fs` stub.

Locked test cases (6):
1. `parseLine` returns parsed object for valid JSON with `ts`+`event`
2. `parseLine` returns null for malformed JSON
3. `parseLine` returns null for valid JSON missing `ts` or `event`
4. `readLastN(5)` returns last 5 of 10 events
5. `readLastN` returns `[]` when log file doesn't exist
6. `readLastN` skips malformed lines (forgiving parser)

### A.9 — `dashboard/test/activity.test.js`

Pure function tests. No I/O.

Locked test cases (12):
1. Empty events array → state="idle"
2. `discovered` without `exit` → state="task"
3. `discovered` then `exit` (matched taskId) → state="idle"
4. `wake_turn_started` without `wake_turn_complete` → state="turn"
5. `wake_turn_started` then `wake_turn_complete` → state="idle"
6. Open task + open turn → state="task" (task wins)
7. Different agents are isolated (one agent's open doesn't leak to another)
8. `exit` for unknown taskId is silently ignored (no crash)
9. `spawned` opens task lifecycle the same as `discovered`
10. `since` is the open event's `ts`
11. **`discovered` then `error` (matched taskId) → state="idle"** (amendment — error is terminal)
12. **`discovered` then `timeout` (matched taskId) → state="idle"** (amendment — timeout is terminal)

### A.10 — `dashboard/test/status.test.js`

Tests `/api/status` with all dependencies stubbed.

Locked test cases (5):
1. Returns 200 + envelope shape with `version: "1"`, `agents.by_state`, `pm2.online`, `recent_events`
2. Recent events limited to 20
3. PM2 failure is soft (200 with `pm2.error` field)
4. Unauthenticated request → 401
5. Authenticated request → 200

### A.11 — `dashboard/test/agents.test.js`

Tests all four `/api/agents*` endpoints with stubs.

Locked test cases (12):
1. `GET /api/agents` returns array with `current_activity` per agent
2. `GET /api/agents/:name` returns 404 if not declared
3. `GET /api/agents/:name` returns detail with `pm2`, `current_activity`, `recent_events`
4. `GET /api/agents/:name` `recent_events` filtered to that agent only
5. `POST /api/agents/:name/restart` returns 200 + `restarted: true` on success
6. `POST /api/agents/:name/restart` calls `pm2.restartProcess(name)` exactly once
7. `POST /api/agents/:name/restart` returns 404 if not declared
8. `POST /api/agents/:name/restart` returns 404 if declared but not in PM2
9. `POST /api/agents/:name/restart` returns 500 with `pm2_restart_failed` if spawn errors
10. `GET /api/agents/:name/logs` returns 200 + `stdout`/`stderr` arrays
11. `GET /api/agents/:name/logs?lines=0` returns 400 (out of range)
12. `GET /api/agents/:name/logs?lines=1001` returns 400 (out of range)

---

## B. Tests

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/D2-test.out
# Expected: 4 (D.1 health) + 8 (D.1 auth) + 8 (pm2) + 6 (events) + 12 (activity) + 5 (status) + 12 (agents) = 55 tests passing
grep -E '✔|pass' /tmp/D2-test.out | wc -l
```

Worker captures the test count and per-file passing summary.

### B.2 — Lockfile reproducibility

```bash
cd ~/neato-hive/dashboard
rm -rf node_modules
pnpm install --frozen-lockfile
echo "B.2: lockfile reproducible ✓"
pnpm list --depth=0 --prod
# Expected: express + dotenv only — D.2 adds NO new prod deps
```

### B.3 — Live boot smoke (read-only verification)

```bash
TOKEN=$(printf 'b%.0s' {1..64})
# Cannot use real .env (would need HIVE_DASHBOARD_TOKEN populated).
# Boot directly with env var, ephemeral port.
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=27777 \
  node dashboard/index.js > /tmp/D2-boot.out 2>&1 &
PID=$!
sleep 2
kill -0 $PID && echo "B.3: process alive ✓"

# /api/status (auth required)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27777/api/status | jq . | tee /tmp/D2-status.json
# Validate shape
test "$(jq -r .version < /tmp/D2-status.json)" = "1" && echo "B.3: status version=1 ✓"
test "$(jq -r '.agents.by_state | keys | sort | join(",")' < /tmp/D2-status.json)" = "idle,task,turn" \
  && echo "B.3: agents.by_state keys ✓"

# /api/agents
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27777/api/agents | jq . | tee /tmp/D2-agents.json
test "$(jq -r '.agents | length > 0' < /tmp/D2-agents.json)" = "true" && echo "B.3: agents non-empty ✓"

# /api/agents/<unknown>
RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27777/api/agents/nonexistent)
test "$RC" = "404" && echo "B.3: unknown agent → 404 ✓"

# /api/agents/<name>/logs?lines=10 (use first agent)
FIRST_AGENT=$(jq -r '.agents[0].name' < /tmp/D2-agents.json)
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:27777/api/agents/$FIRST_AGENT/logs?lines=10" | jq -c '{stdout_len: (.stdout | length), stderr_len: (.stderr | length)}'

# Auth gate
RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:27777/api/status)
test "$RC" = "401" && echo "B.3: /api/status unauth → 401 ✓"

kill $PID
```

### B.4 — Cache TTL behavior (live, against running dashboard)

```bash
TOKEN=$(printf 'c%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=27778 node dashboard/index.js > /tmp/D2-cache.out 2>&1 &
PID=$!
sleep 2

# Hit /api/agents 50 times in rapid succession; the dashboard SHOULD spawn pm2 jlist
# at most ~5 times (50 calls / 1500ms TTL ≈ 1 spawn per 1.5s, but coalesced)
for i in {1..50}; do
  curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27778/api/agents > /dev/null &
done
wait
sleep 2

# Approximate verification — log-line count for "pm2 jlist" wouldn't be present,
# instead count the dashboard process's children. This test is informational
# (correctness is enforced by unit test B.1's pm2 cache test).
echo "B.4: 50 concurrent calls completed without errors"
kill $PID
```

### B.5 — Restart endpoint is gated, never auto-fired

```bash
# B.5 is a CODE-INSPECTION gate, not a live test. Worker captures the diff
# and confirms NO call site in the worker scope (tests, scripts, CI) invokes
# `pm2.restartProcess(...)` against a real PM2 process.
git diff main...feat/v1.5.0-D.2-status-agents-endpoints | grep -E '^\+.*pm2 (start|restart|reload|delete|save)' | grep -v "node:child_process" | head -10
# Expected: matches ONLY inside lib/pm2.js (production code) — not inside test files or build scripts.

# Also confirm the worker's machine PM2 state was NOT mutated by any test:
pm2 jlist | jq '[.[] | select(.name | startswith("hive-")) | {name, status: .pm2_env.status, restart_time: .pm2_env.restart_time}]'
# Worker captures this BEFORE running any tests AND AFTER. restart_time per-agent must not change.
```

### B.6 — Diff-lock confirmation

```bash
cd ~/neato-hive
git diff --stat main...feat/v1.5.0-D.2-status-agents-endpoints
# Expected: exactly 11 lines:
#   dashboard/app.js (modified)
#   dashboard/lib/pm2.js
#   dashboard/lib/runner-events.js
#   dashboard/lib/activity.js
#   dashboard/routes/status.js
#   dashboard/routes/agents.js
#   dashboard/test/pm2.test.js
#   dashboard/test/runner-events.test.js
#   dashboard/test/activity.test.js
#   dashboard/test/status.test.js
#   dashboard/test/agents.test.js

# pnpm-lock.yaml MUST NOT change (no new deps)
git diff main...feat/v1.5.0-D.2-status-agents-endpoints -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.7 — No PM2 verbs in non-production-code

```bash
# Worker scope = any code path other than dashboard/lib/pm2.js.
# Tests must NEVER spawn pm2.
git diff main...feat/v1.5.0-D.2-status-agents-endpoints -- 'dashboard/test/**' | grep -E "(spawn|exec|require).*['\"]pm2" | head -5
# Expected: empty.
```

### B.8 — Cleanup

```bash
rm -f /tmp/D2-*.out /tmp/D2-*.json
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 11 paths exactly (10 new + `dashboard/app.js` modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED (no new dependencies)
- [ ] B.1 test suite: 43 new tests pass (8 + 6 + 12 + 5 + 12 = 43 — amendment 2026-05-07 added 2 activity tests for error/timeout closes; total suite ≥ 55 with D.1 carry-over)
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/api/status`, `/api/agents`, `/api/agents/:name/logs` all return 200 against authenticated requests; unauth returns 401; unknown agent returns 404
- [ ] B.4 cache: 50 concurrent calls complete without errors (coalescing works)
- [ ] B.5 restart gate: no auto-restart in worker scope; `pm2 jlist` `restart_time` for hive-* agents unchanged before/after worker turn
- [ ] B.6 diff-lock exactly 11 paths
- [ ] B.7 no PM2 verbs in test code (only in `dashboard/lib/pm2.js`)
- [ ] **No live agent restarts triggered by worker turn** — explicit DONE-block attestation
- [ ] **Worker's `~/.pm2` directory unchanged** by tests (other than possible log file growth from the dashboard's own boot smoke; agents not touched)
- [ ] PR body: pre-flight 1-8 outputs verbatim, B.1-B.7 outputs verbatim, diff-lock confirmation, "no agent restart in worker scope" attestation, sample envelope outputs from B.3 (redacted of any tokens)

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 11 paths (10 new + dashboard/app.js modified)
Branch: feat/v1.5.0-D.2-status-agents-endpoints

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. dashboard/ skeleton present: ✓
  3. D.2 target paths absent: ✓
  4. runner-events vocabulary: <captured set>
     log present: <yes/no>
     line count: <N>
  5. pm2 jlist sample shape: <captured>
  6. pm2 jlist wall-clock: <Nms> (< 1500ms TTL)
  7. sibling pattern check: ✓
  8. tooling: node ≥22 ✓ pnpm ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - dashboard/test/health.test.js (D.1): 4 passed
    - dashboard/test/auth.test.js (D.1): 8 passed
    - dashboard/test/pm2.test.js: 8 passed
    - dashboard/test/runner-events.test.js: 6 passed
    - dashboard/test/activity.test.js: 12 passed
    - dashboard/test/status.test.js: 5 passed
    - dashboard/test/agents.test.js: 12 passed
    Total: 55 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - /api/status 200 envelope shape ✓
    - /api/agents 200 ✓
    - /api/agents/<unknown> 404 ✓
    - /api/agents/<name>/logs 200 ✓
    - /api/status unauth 401 ✓
  B.4 50-concurrent cache test: completed without errors ✓
  B.5 restart gate:
    - no PM2 verbs outside lib/pm2.js: ✓
    - hive-* restart_time unchanged before/after: ✓
  B.6 diff-lock = 11 paths: ✓
  B.7 no PM2 verbs in test code: ✓

Worker scope attestations:
  - No live agent restart was triggered by the worker turn
  - Live ~/.pm2/* state unchanged from worker turn (other than log growth from boot smoke)
  - dashboard/pnpm-lock.yaml unchanged

Sample responses (redacted):
  /api/status → <full JSON, redacted>
  /api/agents → <full JSON, redacted>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-D.2-status-agents-endpoints
  <verbatim — exactly 11 lines>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full endpoint suite (status + agents + agent-detail + restart + logs) + 3 lib modules + 5 test files in single PR.
- **DO NOT MERGE** — house-md
- **DO NOT EXEC PM2 IN TESTS** — `dashboard/test/**` files MUST stub the spawn factory. Production code (`dashboard/lib/pm2.js`) IS the only path that touches `pm2`. B.7 enforces.
- **DO NOT TRIGGER LIVE AGENT RESTARTS** — Worker tests MUST NOT call `/api/agents/:name/restart` against a real running dashboard (B.3 boot smoke uses an ephemeral port + only GETs). B.5 captures `restart_time` for hive-* agents before AND after to prove no mutation.
- **DO NOT EXTEND DEPENDENCIES** — production deps remain `express` + `dotenv`. No new packages.
- **DO NOT BREAK D.1 TESTS** — health + auth tests must still pass at the previous count (4 + 8). Use D.1's `createApp` factory shape with the new options additively.
- **STATE ENUM IS LOCKED** — `idle | turn | task`. New states require a `version: "2"` bump on response envelopes.
- **CACHE TTL LOCKED** — 1500ms. Configurable for tests, but the production default is 1500ms exactly.
- **`current_activity` DERIVATION IS PURE** — no I/O inside `deriveActivity`. Tests pass synthetic event arrays.
- **HALT-and-ping rule** — pre-flight surprises (D.1 skeleton missing, runner-events vocabulary unmapped to a lifecycle pair, pm2 jlist > 1500ms wall-clock, dashboard/lib/ already exists) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/`, `data/`, `docs/TASK.md`, `pnpm-lock.yaml`, `skills/`, `dashboard/node_modules/` (carried from D.0a/D.1).
- **No new shell-tool deps** — pm2 + jq + curl already verified by D.1.

---

## F. Forward links

- **D.3** — Doctor + update endpoints. `/api/doctor` shells out to `hive doctor --json` (D.0a contract). Update endpoints (apply, check, progress SSE relay tail-following the C.6 state file, status from state file). Reuses the auth + error-handler patterns from D.1+D.2.
- **D.4** — Backups + tasks + runner-events endpoints. The locked owner-directive `/api/sessions/active` reads runner-events.log and returns tasks with open lifecycles (this is a SUBSET of what `deriveActivity` already computes — D.4 may extract the open-lifecycle scan from `lib/activity.js` into a reusable helper). `/api/runner-events?limit=N&offset=M` for paginated history. Plus the `hive dashboard token` and `hive dashboard rotate-token` CLI subcommands.
- **E.1** — Overview page consumes `/api/status`. Renders agents grouped by `by_state`, plus the `recent_events` array as the "Recent runner events" subsection.
- **E.2** — Agents page consumes `/api/agents`. Per-row: avatar, status pill (`pm2_status`), activity pill (`current_activity.state`), restart button (POSTs `/api/agents/:name/restart` with confirm dialog).
- **E.3** — Agent-detail drawer consumes `/api/agents/:name` plus `/api/agents/:name/logs`. Logs tail with auto-refresh (poll every 2s).
- **PM2 cache TTL knob:** D.2 locks `1500ms`. If E.x performance testing reveals contention (e.g. 100 concurrent overview-renders hitting the dashboard), revisit the TTL window in a maintenance leaf rather than as part of E.
- **Streaming-tail upgrade:** D.4's `/api/runner-events` endpoint will introduce streaming-tail for the runner-events log to handle multi-MB logs. D.2's full-read approach is the lock for this leaf.
