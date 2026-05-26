# v1.5.0 D.3 — Doctor + Update Endpoints (Apply, Check, Status, SSE Progress)

**Status:** LOCKED — house-md dispatches Bob via SendMessage on this commit landing on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** D — Dashboard backend (5 PRs)
**Leaf:** D.3 (4 of 5 in Phase D)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** D.0a ✅ merged 2026-05-07 (`693f24b`), D.1 ✅ merged 2026-05-07 (`9ca2824`), D.2 ✅ merged 2026-05-07 (`6a5581e`). Phase D 3/5.
**Successor:** D.4 — Backups + tasks + runner-events endpoints + `/api/sessions/active` + `hive dashboard token` CLI

---

## Goal

D.3 is the bridge between Phase C's tarball update pipeline and Phase E's Updates page. It exposes five new endpoints behind D.1's bearer-token auth:

```
GET  /api/doctor                       — pass-through of `hive doctor --json` (D.0a) with 5s cache
GET  /api/update/check                 — pass-through of `hive update --check --json` (C.5) with 30s cache
POST /api/update/apply                 — spawns `hive update --yes` detached, returns the discovered update_id
GET  /api/update/status/:id            — polling fallback: reads the last line of ~/.neato-hive/state/update-<id>.jsonl
GET  /api/update/progress/:id          — SSE stream: tails the state file, emits each JSONL event as a `data:` event
```

Plus four internal modules:

- **`dashboard/lib/doctor.js`** — wraps `hive doctor --json` invocation with 5s in-process TTL cache + concurrent-fetch coalescing (mirrors D.2's PM2 client pattern)
- **`dashboard/lib/update.js`** — wraps `hive update --check --json` (cached 30s) + `hive update --yes` apply (detached spawn, returns discovered update_id)
- **`dashboard/lib/state-file.js`** — reads from `~/.neato-hive/state/update-<id>.jsonl`: last line, all lines, discover-newest by mtime
- **`dashboard/lib/sse.js`** — SSE response writer + polling-tail helper (250ms interval — deterministic across platforms; not `fs.watch` which has cross-platform reliability issues)

**Owner directive lock (carried from house-md MEMORY):** the `/api/update/check` response **MUST** drive the E.5 "Update Now" button gate. Specifically, when the response carries `update_available === false` (or `null` on error), the frontend MUST render the button as hidden/disabled. The contract is: D.3 ships the data shape unchanged from C.5; E.5 implements the UI gate. This spec calls out the contract explicitly so any future-leaf or refactor doesn't accidentally collapse the `null` and `false` cases (they have different UX implications — `false` = current, `null` = error).

**SSE tear-down resilience (per Q1 architecture):** the state file at `~/.neato-hive/state/update-<id>.jsonl` is the source of truth. SSE relay tails it for live enrichment; polling fallback reads it on EventSource error. When `hive update` swaps `dashboard/` and PM2-restarts `hive-dashboard` mid-flow, the SSE connection drops; the browser's `EventSource.onerror` triggers a fall-back to polling `/api/update/status/:id` until the dashboard process is back and SSE recovers. The state file's append-only JSONL design means polling and SSE always agree on the current phase.

---

## Architectural givens (carried)

### Doctor endpoint

`GET /api/doctor` shells out to `hive doctor --json` (D.0a-locked envelope, version `"1"`). Response shape passes through verbatim — D.3 adds a 5-second in-process TTL cache (concurrent-fetch coalescing via shared inflight promise, same pattern as D.2's PM2 client).

**Why 5s:** the doctor flow runs ~25 checks including a `git fetch` and a `pm2 jlist` call. Wall-clock is typically 1-3 seconds. A 5s cache means the dashboard's overview-render polling (every 30s) does not re-spawn doctor on every tick, but on-demand "refresh now" from a Doctor page sees fresh-enough data within the cache window.

**Cache is invalidated on:**
- `clearCache()` explicit call (used by tests + the `/api/update/apply` endpoint, which clears doctor cache so post-update doctor reflects the new install)
- TTL expiry (5000ms)

**Spawn pattern:**
```js
const result = spawn('hive', ['doctor', '--json'], { encoding: 'utf8', timeout: 30000 });
if (result.status !== 0 && !result.stdout) throw new Error(`hive doctor --json failed: rc=${result.status}`);
const parsed = JSON.parse(result.stdout);
```

Note: `hive doctor` exits non-zero when there are issues. We DO NOT treat non-zero exit as a failure to parse — the JSON envelope is still emitted with `summary.exit_code` reflecting the doctor's view. Only treat the spawn as failed if `stdout` is empty AND status is non-zero (meaning the command itself crashed).

### Update check endpoint

`GET /api/update/check` shells out to `hive update --check --json` (C.5-locked envelope). Response shape passes through verbatim.

**Cache: 30 seconds.** Releases land at human pace; 30s freshness is more than enough. Configurable via `ttlMs` for tests.

**Three-state response (locked in C.5):**
- `{ update_available: true, local_version, remote_version, tarball_url, checksum_sha256, released_at, changelog_url }` — update available
- `{ update_available: false, local_version, remote_version, released_at }` — already current
- `{ update_available: null, error, local_version }` — remote unreachable / malformed response

**HTTP status:** 200 in all three cases. Frontend distinguishes via the envelope. 500 only on dashboard-internal errors (e.g. spawn failure with no usable stdout).

**Cache key includes the boolean state.** When the response transitions from `true` to `false` (someone ran `hive update` outside the dashboard), the next poll past TTL picks it up.

### Update apply endpoint

`POST /api/update/apply` spawns `hive update --yes` as a **detached** child and returns the discovered `update_id` so the frontend can subscribe to SSE.

**Spawn pattern:**
```js
const child = spawn('hive', ['update', '--yes'], {
  detached: true,
  stdio: 'ignore',
  cwd: frameworkRoot,
});
child.unref();  // dashboard process does not wait for child
```

**`update_id` discovery:** after spawning, the endpoint polls `~/.neato-hive/state/` every 100ms for up to 5 seconds, looking for an `update-*.jsonl` file with `mtime > beforeSpawnTs`. Returns its id (basename minus `update-` prefix and `.jsonl` suffix).

**Race-window timeout:** if no new state file appears within 5 seconds, return `502 { error: "update_id_not_discovered", detail: "hive update did not create a state file within 5s" }`. This catches cases where `hive update` failed before the orchestrator even ran (e.g. lock contention with another in-flight update).

**Body `{}` accepted (or empty) — no input parameters.** Future leaf may add `{ dry_run: true }` or `{ skip_doctor: true }` flags; D.3 ships no-input shape only.

**Returns:** `200 { update_id, started_at }` on success.

**Cache invalidation:** the `/apply` handler invalidates doctor + update-check caches before returning (the frontend will likely re-render after the call).

**Worker-PM2-ban relevance:** the live `hive update` will, post-C.7, print a "PM2 reload pending" banner if migration runs. The dashboard's `/apply` endpoint does NOT capture the banner (child stdio is ignored). The frontend receives `migration-pm2-reload-pending` via the SSE stream and renders the banner contents from the event detail. Worker tests stub the spawn entirely — no real `hive update` runs.

### Update status endpoint

`GET /api/update/status/:id` reads the last line of `~/.neato-hive/state/update-<id>.jsonl` and returns it as the parsed JSON envelope.

**Response:**
```json
{
  "version": "1",
  "ts": "2026-05-07T20:30:00.000Z",
  "update_id": "20260507-abc123",
  "current": {
    "phase": "download-complete",
    "ts": "2026-05-07T20:29:55.123Z",
    "sequence": 8,
    "detail": { "tarball_path": "...", "size_bytes": 1234567 }
  },
  "is_done": false,
  "success": null
}
```

When the last event is `done`, `is_done: true` and `success` reflects `detail.success`. Otherwise `is_done: false`, `success: null`.

**404 if state file missing:** `{ error: "update_not_found", update_id: "..." }`.

**Open contract:** the status endpoint does NOT do file watching or caching. Each call reads disk fresh. Polling is the consumer pattern (browser polls every 1-2s when SSE is unavailable).

### Update progress (SSE) endpoint

`GET /api/update/progress/:id` opens an SSE stream that:
1. **On connect:** reads the existing state file and emits each existing line as a `data:` event (replay so the client sees the full history)
2. **Polling-tail loop:** every 250ms, checks if the state file has grown. If so, reads the new bytes and emits each new line as a `data:` event
3. **Heartbeat:** every 15s, writes `: heartbeat\n\n` (SSE comment, ignored by EventSource) to keep proxies + the connection alive
4. **Auto-close on `done`:** when a `done` event is observed in the stream, closes the response after a 500ms grace period (lets the client receive the final event)

**Why polling-tail not `fs.watch`:** `fs.watch` has cross-platform reliability issues (returns inconsistent events on macOS APFS, may miss events on Linux when the file is rewritten). Polling at 250ms is deterministic, cheap (one stat call per file per agent per 250ms), and good enough for human perception.

**Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no   (nginx hint; harmless if no proxy)
```

`res.flushHeaders()` is called immediately so the client sees a 200 OK + headers without waiting for the first event.

**404 if state file missing.** Returned as a regular HTTP 404, not as an SSE event.

**Disconnect handling:** `req.on('close', () => { ... })` clears the polling interval and the heartbeat interval. No leaked timers.

### State file reader (`dashboard/lib/state-file.js`)

```js
const fs = require('node:fs');
const path = require('node:path');

function createStateFileReader({ stateRoot, fs: fsStub = fs } = {}) {
  function pathFor(updateId) {
    return path.join(stateRoot, 'state', `update-${updateId}.jsonl`);
  }

  function readLast(updateId) {
    const filePath = pathFor(updateId);
    if (!fsStub.existsSync(filePath)) return null;
    const raw = fsStub.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    try {
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;  // malformed last line — drop
    }
  }

  function readAll(updateId) {
    const filePath = pathFor(updateId);
    if (!fsStub.existsSync(filePath)) return [];
    const raw = fsStub.readFileSync(filePath, 'utf8');
    return raw.split('\n')
      .filter((l) => l.length > 0)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e !== null);
  }

  function findNewerThan(beforeTs) {
    const dir = path.join(stateRoot, 'state');
    if (!fsStub.existsSync(dir)) return null;
    const entries = fsStub.readdirSync(dir);
    let candidate = null;
    let candidateMtime = 0;
    for (const name of entries) {
      const m = name.match(/^update-(.+)\.jsonl$/);
      if (!m) continue;
      const stat = fsStub.statSync(path.join(dir, name));
      const mtime = stat.mtimeMs;
      if (mtime > beforeTs && mtime > candidateMtime) {
        candidate = m[1];
        candidateMtime = mtime;
      }
    }
    return candidate;
  }

  return { readLast, readAll, findNewerThan, pathFor };
}

module.exports = { createStateFileReader };
```

**Locked semantics:**
- `readLast(updateId)` returns the parsed last event or null (file missing OR empty OR malformed last line)
- `readAll(updateId)` returns every parsed event (drops malformed lines silently)
- `findNewerThan(beforeTs)` scans the state directory and returns the update_id with the most-recently-modified file whose mtime > beforeTs (or null if none). Used by `/api/update/apply` for update_id discovery.
- `pathFor(updateId)` returns the absolute path — used by SSE for tailing.
- `fs` injectable for tests.

### Endpoint envelope shapes (locked summary)

**`GET /api/doctor`:**
```json
{ "version": "1", "ts": "...", "summary": {...}, "checks": [...], "agents": [...] }
```
(Pass-through of D.0a output verbatim.)

**`GET /api/update/check`:**
```json
{ "update_available": true|false|null, ... }
```
(Pass-through of C.5 output verbatim. HTTP 200 in all three cases.)

**`POST /api/update/apply`:**
```json
{ "version": "1", "ts": "...", "update_id": "20260507-abc123", "started_at": "..." }
```

**`GET /api/update/status/:id`:**
```json
{ "version": "1", "ts": "...", "update_id": "...", "current": {...}, "is_done": false, "success": null }
```

**`GET /api/update/progress/:id`:** SSE stream — `data: {phase event JSON}\n\n` for each line in the state file, plus `: heartbeat\n\n` every 15s.

---

## Pre-conditions

- Phase D 3/5: D.0a (`693f24b`), D.1 (`9ca2824`), D.2 (`6a5581e`) merged on framework main
- D.2 dashboard skeleton (`dashboard/app.js`, `dashboard/lib/pm2.js`, `dashboard/lib/runner-events.js`, `dashboard/lib/activity.js`, `dashboard/routes/status.js`, `dashboard/routes/agents.js`) present
- `hive doctor --json` (D.0a) and `hive update --check --json` (C.5) both work on Bob's machine — pre-flight #5 + #6 verify
- `~/.neato-hive/state/` exists or can be created (C.6's emit_progress helper creates it; pre-flight #7 captures the baseline)
- Node ≥ 22 with native `fetch` (carried from D.1)

---

## Where state lives (D.3 conventions)

**New files (10):**
- `dashboard/lib/doctor.js`
- `dashboard/lib/update.js`
- `dashboard/lib/state-file.js`
- `dashboard/lib/sse.js`
- `dashboard/routes/doctor.js`
- `dashboard/routes/update.js`
- `dashboard/test/doctor.test.js`
- `dashboard/test/update.test.js`
- `dashboard/test/state-file.test.js`
- `dashboard/test/sse.test.js`

**Modified file (1):**
- `dashboard/app.js` — mount `/api/doctor` + `/api/update` routers; extend DI options to accept `doctor`, `update`, `stateFile` modules

**Total: 11 paths.**

**No new dependencies.** D.3 uses `express`, `dotenv` (carried), and Node built-ins (`node:child_process`, `node:fs`, `node:path`, `node:os`).

---

## Pre-flight (worker MUST run all 8; outputs captured in PR body)

### 1. Framework repo current state (post-D.2)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `6a5581e` (D.2 merge) plus D-spec commits.

### 2. D.2 dashboard surface present

```bash
test -f dashboard/lib/pm2.js && echo "pm2.js ✓"
test -f dashboard/lib/runner-events.js && echo "runner-events.js ✓"
test -f dashboard/lib/activity.js && echo "activity.js ✓"
test -f dashboard/routes/status.js && echo "routes/status.js ✓"
test -f dashboard/routes/agents.js && echo "routes/agents.js ✓"
```

**HALT and ping house-md** if any are missing.

### 3. D.3 target paths absent

```bash
test ! -f dashboard/lib/doctor.js && echo "doctor.js absent ✓"
test ! -f dashboard/lib/update.js && echo "update.js absent ✓"
test ! -f dashboard/lib/state-file.js && echo "state-file.js absent ✓"
test ! -f dashboard/lib/sse.js && echo "sse.js absent ✓"
test ! -f dashboard/routes/doctor.js && echo "routes/doctor.js absent ✓"
test ! -f dashboard/routes/update.js && echo "routes/update.js absent ✓"
```

**HALT and ping house-md** if any exist.

### 4. `hive doctor --json` works + envelope shape

```bash
hive doctor --json > /tmp/D3-doctor-pre.json 2>&1
RC=$?
echo "exit code: $RC (expected 0 or 1)"
jq -r 'keys | sort | join(",")' < /tmp/D3-doctor-pre.json
# Expected: "agents,checks,summary,ts,version"
test "$(jq -r .version < /tmp/D3-doctor-pre.json)" = "1" && echo "version locked at 1 ✓"
```

**HALT and ping house-md** if envelope keys differ from D.0a's lock.

### 5. `hive update --check --json` works + envelope shape

```bash
hive update --check --json > /tmp/D3-check-pre.json 2>&1
RC=$?
echo "exit code: $RC (expected 0)"
echo "--- envelope:"
jq . < /tmp/D3-check-pre.json
echo "--- update_available type:"
jq -r '.update_available | type' < /tmp/D3-check-pre.json
# Expected: "boolean" (or "null" if API unreachable)
```

If `update_available` is `null` on Bob's machine, that's acceptable — pass-through behavior is exercised by the unit tests against synthetic fixtures.

### 6. `~/.neato-hive/state/` directory baseline

```bash
test -d ~/.neato-hive/state && ls -la ~/.neato-hive/state/ | head -10 \
  || echo "~/.neato-hive/state/ does not exist (will be created on first hive update)"
```

Informational. The state directory is created by C.6's emit-progress helper.

### 7. PM2 entry for hive-dashboard exists in ecosystem (D.1 carry-over)

```bash
node -e 'const c = require("./ecosystem.config.cjs"); const dash = c.apps.find(a => a.name === "hive-dashboard"); if (!dash) { console.error("FAIL: hive-dashboard missing"); process.exit(1); } console.log("hive-dashboard PM2 entry ✓");'
```

### 8. Tooling

```bash
node --version
pnpm --version
which hive
which jq
```

Expected: Node ≥ 22, `hive` resolvable on PATH (worker invokes it from spawned children).

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-D.3-doctor-update-endpoints`.

**Diff lock: 11 paths exactly** (10 new + `dashboard/app.js` modified).

### A.1 — `dashboard/lib/doctor.js`

```javascript
'use strict';

const { spawnSync } = require('node:child_process');

function createDoctorClient({ ttlMs = 5000, spawn = spawnSync } = {}) {
  let cache = null;        // { fetchedAt: number, envelope: object }
  let inflight = null;     // Promise|null

  async function getJson() {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < ttlMs) return cache.envelope;
    if (inflight) return inflight;
    inflight = new Promise((resolve, reject) => {
      try {
        const result = spawn('hive', ['doctor', '--json'], {
          encoding: 'utf8',
          timeout: 30000,
        });
        // hive doctor exits non-zero when checks fail, but still emits the
        // envelope. Only treat as failure if stdout is empty AND non-zero exit.
        if (result.status !== 0 && (!result.stdout || result.stdout.trim() === '')) {
          reject(new Error(`hive doctor --json failed: rc=${result.status} stderr=${result.stderr || ''}`));
          return;
        }
        let envelope;
        try {
          envelope = JSON.parse(result.stdout);
        } catch (parseErr) {
          reject(new Error(`hive doctor --json output not valid JSON: ${parseErr.message}`));
          return;
        }
        cache = { fetchedAt: Date.now(), envelope };
        resolve(envelope);
      } catch (err) {
        reject(err);
      } finally {
        inflight = null;
      }
    });
    return inflight;
  }

  function clearCache() { cache = null; }

  return { getJson, clearCache };
}

module.exports = { createDoctorClient };
```

### A.2 — `dashboard/lib/update.js`

```javascript
'use strict';

const { spawnSync, spawn: spawnNonSync } = require('node:child_process');

function createUpdateClient({
  ttlMs = 30000,
  spawnSyncFn = spawnSync,
  spawnFn = spawnNonSync,
  stateFile,
  cwd,
} = {}) {
  let checkCache = null;
  let checkInflight = null;

  async function check() {
    const now = Date.now();
    if (checkCache && now - checkCache.fetchedAt < ttlMs) return checkCache.envelope;
    if (checkInflight) return checkInflight;
    checkInflight = new Promise((resolve, reject) => {
      try {
        const result = spawnSyncFn('hive', ['update', '--check', '--json'], {
          encoding: 'utf8',
          timeout: 30000,
          cwd,
        });
        if (result.status !== 0 && (!result.stdout || result.stdout.trim() === '')) {
          reject(new Error(`hive update --check --json failed: rc=${result.status}`));
          return;
        }
        const envelope = JSON.parse(result.stdout);
        checkCache = { fetchedAt: Date.now(), envelope };
        resolve(envelope);
      } catch (err) {
        reject(err);
      } finally {
        checkInflight = null;
      }
    });
    return checkInflight;
  }

  function clearCheckCache() { checkCache = null; }

  /**
   * apply() — spawns `hive update --yes` detached and discovers the
   * update_id created by C.6's state-file emit-progress.
   *
   * Returns { update_id, started_at } on success.
   * Throws if no state file is created within 5s (race-window timeout).
   */
  async function apply() {
    if (!stateFile) {
      throw new Error('apply: stateFile reader required (DI contract)');
    }
    const startedAt = Date.now();
    const child = spawnFn('hive', ['update', '--yes'], {
      detached: true,
      stdio: 'ignore',
      cwd,
    });
    child.unref();

    // Poll for new state file every 100ms, up to 5s
    const deadline = startedAt + 5000;
    while (Date.now() < deadline) {
      const updateId = stateFile.findNewerThan(startedAt);
      if (updateId) {
        return { update_id: updateId, started_at: new Date(startedAt).toISOString() };
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const err = new Error('hive update did not create a state file within 5s');
    err.code = 'UPDATE_ID_NOT_DISCOVERED';
    throw err;
  }

  return { check, clearCheckCache, apply };
}

module.exports = { createUpdateClient };
```

### A.3 — `dashboard/lib/state-file.js`

Per the §Architectural givens block above. Locked exports: `createStateFileReader({ stateRoot, fs? }) → { readLast, readAll, findNewerThan, pathFor }`.

### A.4 — `dashboard/lib/sse.js`

```javascript
'use strict';

const fs = require('node:fs');

/**
 * createSseStream(req, res, { filePath, doneEventName, intervalMs, heartbeatMs })
 *
 * Opens an SSE stream that:
 *   1. On connect, reads existing file contents and emits each line as a `data:` event
 *   2. Every intervalMs (default 250ms), checks the file size — if grown, reads new bytes and emits new lines
 *   3. Every heartbeatMs (default 15000ms), emits a `: heartbeat` SSE comment
 *   4. Auto-closes the response after observing a line whose parsed JSON event === doneEventName
 *      (default "done") with a 500ms grace period to flush the final event
 *
 * Cleanup: req.on('close') clears both intervals.
 *
 * Caller is responsible for 404-handling if filePath doesn't exist BEFORE
 * calling this helper. createSseStream assumes filePath is readable.
 */
function createSseStream(req, res, opts) {
  const {
    filePath,
    doneEventName = 'done',
    intervalMs = 250,
    heartbeatMs = 15000,
    fs: fsStub = fs,
  } = opts;

  res.set('Content-Type', 'text/event-stream');
  res.set('Cache-Control', 'no-cache, no-transform');
  res.set('Connection', 'keep-alive');
  res.set('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let pos = 0;
  let closed = false;

  // Initial replay: read existing content
  try {
    const stat = fsStub.statSync(filePath);
    const raw = fsStub.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      res.write(`data: ${line}\n\n`);
      maybeAutoClose(line);
    }
    pos = stat.size;
  } catch (err) {
    // File disappeared between handler check and here — close gracefully
    res.end();
    return;
  }

  const tailInterval = setInterval(() => {
    if (closed) return;
    try {
      const stat = fsStub.statSync(filePath);
      if (stat.size > pos) {
        const fd = fsStub.openSync(filePath, 'r');
        const buf = Buffer.alloc(stat.size - pos);
        fsStub.readSync(fd, buf, 0, buf.length, pos);
        fsStub.closeSync(fd);
        pos = stat.size;
        const newContent = buf.toString('utf8');
        const lines = newContent.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          res.write(`data: ${line}\n\n`);
          maybeAutoClose(line);
        }
      }
    } catch (err) {
      // File rotated or removed — silently continue; next iteration may recover
    }
  }, intervalMs);

  const heartbeatInterval = setInterval(() => {
    if (closed) return;
    res.write(`: heartbeat\n\n`);
  }, heartbeatMs);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(tailInterval);
    clearInterval(heartbeatInterval);
    try { res.end(); } catch { /* already closed */ }
  }

  function maybeAutoClose(line) {
    try {
      const evt = JSON.parse(line);
      if (evt && evt.phase === doneEventName) {
        // Grace period so the client receives the final event
        setTimeout(cleanup, 500);
      }
    } catch {
      // malformed — ignore
    }
  }

  req.on('close', cleanup);
  res.on('error', cleanup);
}

module.exports = { createSseStream };
```

### A.5 — `dashboard/routes/doctor.js`

```javascript
'use strict';

const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { doctor } = req.app.locals;
  try {
    const envelope = await doctor.getJson();
    res.status(200).json(envelope);
  } catch (err) {
    console.error('[hive-dashboard] /api/doctor error:', err);
    res.status(500).json({ error: 'doctor_failed', detail: err.message });
  }
});

module.exports = router;
```

### A.6 — `dashboard/routes/update.js`

```javascript
'use strict';

const express = require('express');
const { createSseStream } = require('../lib/sse');

const router = express.Router();

// GET /api/update/check
router.get('/check', async (req, res) => {
  const { update } = req.app.locals;
  try {
    const envelope = await update.check();
    res.status(200).json(envelope);
  } catch (err) {
    console.error('[hive-dashboard] /api/update/check error:', err);
    res.status(500).json({ error: 'check_failed', detail: err.message });
  }
});

// POST /api/update/apply
router.post('/apply', async (req, res) => {
  const { update, doctor } = req.app.locals;
  try {
    const result = await update.apply();
    // Invalidate caches — post-apply state will be different
    if (doctor && doctor.clearCache) doctor.clearCache();
    if (update.clearCheckCache) update.clearCheckCache();
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      update_id: result.update_id,
      started_at: result.started_at,
    });
  } catch (err) {
    if (err.code === 'UPDATE_ID_NOT_DISCOVERED') {
      return res.status(502).json({ error: 'update_id_not_discovered', detail: err.message });
    }
    console.error('[hive-dashboard] /api/update/apply error:', err);
    res.status(500).json({ error: 'apply_failed', detail: err.message });
  }
});

// GET /api/update/status/:id
router.get('/status/:id', async (req, res) => {
  const { stateFile } = req.app.locals;
  const { id } = req.params;
  if (!isValidUpdateId(id)) {
    return res.status(400).json({ error: 'bad_update_id' });
  }
  try {
    const last = stateFile.readLast(id);
    if (last === null) {
      return res.status(404).json({ error: 'update_not_found', update_id: id });
    }
    const isDone = last.phase === 'done';
    const success = isDone && last.detail ? !!last.detail.success : null;
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      update_id: id,
      current: last,
      is_done: isDone,
      success,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/update/status/:id error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// GET /api/update/progress/:id  (SSE)
router.get('/progress/:id', (req, res) => {
  const { stateFile } = req.app.locals;
  const { id } = req.params;
  if (!isValidUpdateId(id)) {
    return res.status(400).json({ error: 'bad_update_id' });
  }
  const filePath = stateFile.pathFor(id);
  // Pre-check existence so we can return a real 404 (SSE can't carry 404 mid-stream)
  const fs = require('node:fs');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'update_not_found', update_id: id });
  }
  createSseStream(req, res, { filePath });
});

function isValidUpdateId(id) {
  // C.6 contract: update_id is the staging dir basename. Conservative pattern:
  // alphanumeric + dashes + underscores only. Rejects path traversal ("..", "/", etc).
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length < 200;
}

module.exports = router;
```

### A.7 — `dashboard/app.js` modification

Update the app factory to accept `doctor`, `update`, `stateFile` injection options. Mount `/api/doctor` + `/api/update` after auth.

```javascript
'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { createAuthMiddleware } = require('./middleware/auth');
const healthRouter = require('./routes/health');
const statusRouter = require('./routes/status');
const agentsRouter = require('./routes/agents');
const doctorRouter = require('./routes/doctor');                // D.3
const updateRouter = require('./routes/update');                // D.3
const { createPm2Client } = require('./lib/pm2');
const { createRunnerEventsReader } = require('./lib/runner-events');
const { createDoctorClient } = require('./lib/doctor');         // D.3
const { createUpdateClient } = require('./lib/update');         // D.3
const { createStateFileReader } = require('./lib/state-file');  // D.3

function createApp({ token, pm2, runnerEvents, frameworkRoot, listAgents, doctor, update, stateFile } = {}) {
  if (!token) throw new Error('createApp: token is required');

  const root = frameworkRoot || process.cwd();
  const stateRoot = process.env.HIVE_STATE_ROOT || path.join(require('node:os').homedir(), '.neato-hive');

  const pm2Client = pm2 || createPm2Client();
  const runnerEventsReader =
    runnerEvents ||
    createRunnerEventsReader({ logPath: path.join(root, 'data', 'runner-events.log') });
  const agentsLister = listAgents || (() => listDeclaredAgents(root));
  const stateFileReader = stateFile || createStateFileReader({ stateRoot });
  const doctorClient = doctor || createDoctorClient();
  const updateClient = update || createUpdateClient({ stateFile: stateFileReader, cwd: root });

  const app = express();
  app.locals.pm2 = pm2Client;
  app.locals.runnerEvents = runnerEventsReader;
  app.locals.frameworkRoot = root;
  app.locals.listAgents = agentsLister;
  app.locals.stateFile = stateFileReader;
  app.locals.doctor = doctorClient;
  app.locals.update = updateClient;

  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRouter);
  app.use(createAuthMiddleware(token));

  app.use('/api/status', statusRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/doctor', doctorRouter);    // D.3
  app.use('/api/update', updateRouter);    // D.3

  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[hive-dashboard] error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

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

### A.8 — `dashboard/test/doctor.test.js`

Tests `createDoctorClient` with an injected `spawn` stub. No real `hive doctor` execution.

Locked test cases (5):
1. `getJson()` returns parsed envelope when spawn returns valid JSON
2. Cache hit within TTL avoids re-spawn
3. Cache miss after TTL re-spawns
4. Spawn returning empty stdout AND non-zero exit → rejects
5. Non-zero exit BUT stdout has valid envelope → resolves (doctor exit 1 is normal when checks fail)

### A.9 — `dashboard/test/update.test.js`

Tests `createUpdateClient` for both `check()` and `apply()` paths.

Locked test cases (10):
1. `check()` returns parsed envelope (update_available: true)
2. `check()` returns parsed envelope (update_available: false)
3. `check()` returns parsed envelope (update_available: null with error)
4. `check()` cache hit within TTL avoids re-spawn
5. `check()` cache miss after TTL re-spawns
6. `clearCheckCache()` invalidates the cache
7. `apply()` spawns `hive update --yes` detached
8. `apply()` returns { update_id, started_at } when stateFile.findNewerThan finds a new file
9. `apply()` polls every 100ms, up to 5s
10. `apply()` throws with `code: UPDATE_ID_NOT_DISCOVERED` when no new state file appears within 5s

### A.10 — `dashboard/test/state-file.test.js`

Tests `createStateFileReader` with an injected `fs` stub.

Locked test cases (8):
1. `readLast` returns parsed last event
2. `readLast` returns null when file missing
3. `readLast` returns null when file empty
4. `readLast` returns null when last line is malformed JSON (skip-and-fall-through behavior)
5. `readAll` returns all parsed events, dropping malformed lines
6. `findNewerThan` returns the update_id of the newest update-*.jsonl file
7. `findNewerThan` returns null when no file is newer than `beforeTs`
8. `findNewerThan` ignores files that don't match the `update-<id>.jsonl` pattern

### A.11 — `dashboard/test/sse.test.js`

Tests `createSseStream` end-to-end against a live ephemeral-port app + temp state files.

Locked test cases (6):
1. SSE response has the locked headers (`Content-Type: text/event-stream`, etc.)
2. Initial replay: existing N lines of the file are emitted as N `data:` events
3. New lines appended to the file are emitted as new `data:` events within ~500ms (tail-poll responsiveness)
4. Heartbeat (`: heartbeat\n\n`) is emitted within heartbeatMs
5. `done` event triggers stream auto-close after 500ms grace
6. Client disconnect (close request stream) clears polling + heartbeat intervals (no leaked timers)

---

## B. Tests

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/D3-test.out
# Expected: 4 (D.1 health) + 8 (D.1 auth) + 8 (D.2 pm2) + 6 (D.2 events) + 12 (D.2 activity) +
#           5 (D.2 status) + 12 (D.2 agents) + 5 (D.3 doctor) + 10 (D.3 update) + 8 (D.3 state-file) +
#           6 (D.3 sse) = 84 tests passing
grep -E '✔|pass' /tmp/D3-test.out | wc -l
```

Worker captures the per-file count.

### B.2 — Lockfile reproducibility

```bash
cd ~/neato-hive/dashboard
rm -rf node_modules
pnpm install --frozen-lockfile
echo "lockfile reproducible ✓"
pnpm list --depth=0 --prod
# Expected: express + dotenv only — D.3 adds NO new prod deps
```

### B.3 — Live boot smoke (read-only endpoints)

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=37777 \
  node dashboard/index.js > /tmp/D3-boot.out 2>&1 &
PID=$!
sleep 2
kill -0 $PID && echo "process alive ✓"

# /api/doctor — pass-through
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37777/api/doctor | jq -c '{version, summary_keys: (.summary | keys | sort)}'
# Expected: version=1, summary_keys includes exit_code,fail,pass,skip,total,warn

# /api/update/check — pass-through
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37777/api/update/check | jq -c '{update_available_type: (.update_available | type)}'
# Expected: update_available_type: boolean or null

# /api/update/status/<bogus> → 404
RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37777/api/update/status/nonexistent)
test "$RC" = "404" && echo "/api/update/status/<unknown> 404 ✓"

# /api/update/status/<bad chars> → 400
RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:37777/api/update/status/bad..id")
test "$RC" = "400" && echo "/api/update/status/<bad> 400 ✓"

# Auth gate
RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:37777/api/doctor)
test "$RC" = "401" && echo "/api/doctor unauth → 401 ✓"

kill $PID
```

### B.4 — SSE live smoke (pre-write fixture state file)

```bash
TOKEN=$(printf 'c%.0s' {1..64})
TMP_STATE=/tmp/D3-sse-state-$$
mkdir -p "$TMP_STATE/state"
echo '{"phase":"start","ts":"2026-05-07T20:00:00Z","sequence":0,"detail":{}}' > "$TMP_STATE/state/update-test123.jsonl"
echo '{"phase":"download-start","ts":"2026-05-07T20:00:01Z","sequence":1,"detail":{}}' >> "$TMP_STATE/state/update-test123.jsonl"

HIVE_STATE_ROOT="$TMP_STATE" HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=37778 \
  node dashboard/index.js > /tmp/D3-sse-boot.out 2>&1 &
PID=$!
sleep 2

# Open SSE stream and read the first ~200 bytes
curl -fsS -N -H "Authorization: Bearer $TOKEN" --max-time 2 \
  http://127.0.0.1:37778/api/update/progress/test123 | head -c 400 | tee /tmp/D3-sse.out
echo ""
grep -c 'data: {"phase":' /tmp/D3-sse.out
# Expected: ≥ 2 (the two pre-written lines)

# Append a new line and verify it shows up
echo '{"phase":"download-complete","ts":"2026-05-07T20:00:05Z","sequence":2,"detail":{"size_bytes":12345}}' \
  >> "$TMP_STATE/state/update-test123.jsonl"

# Re-open stream (curl --max-time bounds the read; production browser keeps open)
sleep 1
curl -fsS -N -H "Authorization: Bearer $TOKEN" --max-time 2 \
  http://127.0.0.1:37778/api/update/progress/test123 | head -c 600 | grep -c 'download-complete'
# Expected: ≥ 1 (the appended line is replayed on every reconnect)

# Polling fallback
curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:37778/api/update/status/test123 | jq -c '{update_id, current_phase: .current.phase, is_done}'
# Expected: update_id=test123, current_phase=download-complete, is_done=false

# Append a `done` event
echo '{"phase":"done","ts":"2026-05-07T20:00:10Z","sequence":3,"detail":{"success":true}}' \
  >> "$TMP_STATE/state/update-test123.jsonl"

curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:37778/api/update/status/test123 | jq -c '{is_done, success}'
# Expected: is_done=true, success=true

kill $PID
rm -rf "$TMP_STATE"
```

### B.5 — apply() does NOT actually run hive update in worker scope

```bash
# B.5 is a CODE-INSPECTION + LIVE-STATE gate. Worker confirms:
# 1. Tests stub spawn — no real `hive update` invocation in test code.
git diff main...feat/v1.5.0-D.3-doctor-update-endpoints -- 'dashboard/test/**' \
  | grep -E "spawn.*\['hive'.*'update'.*'--yes'" | head -5
# Expected: empty.

# 2. Live state directory unchanged from worker turn (no new update-*.jsonl files
#    created with mtime within the worker run window).
ls -la ~/.neato-hive/state/ 2>/dev/null | head -10
# Worker captures BEFORE pre-flight + AFTER full test run. No new update-*.jsonl files
# should appear with timestamps in the worker turn window.

# 3. ~/.neato-hive/migrations/v1_5_0_completed unchanged (worker did not trigger migration)
ls -la ~/.neato-hive/migrations/ 2>/dev/null
```

### B.6 — Diff-lock confirmation

```bash
cd ~/neato-hive
git diff --stat main...feat/v1.5.0-D.3-doctor-update-endpoints
# Expected: exactly 11 lines:
#   dashboard/app.js (modified)
#   dashboard/lib/doctor.js
#   dashboard/lib/update.js
#   dashboard/lib/state-file.js
#   dashboard/lib/sse.js
#   dashboard/routes/doctor.js
#   dashboard/routes/update.js
#   dashboard/test/doctor.test.js
#   dashboard/test/update.test.js
#   dashboard/test/state-file.test.js
#   dashboard/test/sse.test.js

# pnpm-lock.yaml MUST NOT change
git diff main...feat/v1.5.0-D.3-doctor-update-endpoints -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.7 — No PM2 verbs in any code path

```bash
# Carry-over from D.2 — D.3 does not introduce PM2 calls.
git diff main...feat/v1.5.0-D.3-doctor-update-endpoints | grep -E '^\+.*pm2 (start|restart|reload|delete|save|stop|kill)' | head -5
# Expected: empty.
```

### B.8 — No `hive update` spawns from test code

```bash
git diff main...feat/v1.5.0-D.3-doctor-update-endpoints -- 'dashboard/test/**' \
  | grep -E "spawn.*hive.*['\"]update['\"]" | head -5
# Expected: empty.
```

### B.9 — Cleanup

```bash
rm -f /tmp/D3-*.out /tmp/D3-*.json
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 11 paths exactly (10 new + `dashboard/app.js` modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED (no new dependencies)
- [ ] B.1 test suite: 29 new tests pass (5 + 10 + 8 + 6 = 29 new); total suite ≥ 84 with D.0a/D.1/D.2 carry-over
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/api/doctor`, `/api/update/check`, `/api/update/status/<bogus>` (404), `/api/update/status/<bad-chars>` (400), unauth (401) all behave per spec
- [ ] B.4 SSE smoke: existing fixture lines emitted as `data:` events; appended lines visible on reconnect; polling fallback returns current state; `done` event closes stream
- [ ] B.5 apply gate: no `spawn(hive, [update, --yes])` in test code; live state directory unchanged from worker turn; live migrations marker unchanged
- [ ] B.6 diff-lock exactly 11 paths
- [ ] B.7 no PM2 verbs in any non-production-code path
- [ ] B.8 no `hive update` spawns in test code
- [ ] **No live `hive update` triggered by worker turn** — explicit DONE-block attestation
- [ ] **Live `~/.neato-hive/state/`, `~/.neato-hive/migrations/`, and `~/neato-hive/.env` unchanged** by worker
- [ ] PR body: pre-flight 1-8 outputs verbatim, B.1-B.8 outputs verbatim, diff-lock confirmation, "no live update / PM2 verbs in worker scope" attestation, sample SSE replay output (redacted of any tokens)

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 11 paths (10 new + dashboard/app.js modified)
Branch: feat/v1.5.0-D.3-doctor-update-endpoints

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. D.2 dashboard surface present: ✓
  3. D.3 target paths absent: ✓
  4. hive doctor --json envelope keys: agents,checks,summary,ts,version ✓
  5. hive update --check --json envelope: <captured sample>
  6. ~/.neato-hive/state/ baseline: <captured>
  7. hive-dashboard PM2 entry: ✓
  8. tooling: node ≥22 ✓ pnpm ✓ hive ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - dashboard/test/health.test.js (D.1): 4 passed
    - dashboard/test/auth.test.js (D.1): 8 passed
    - dashboard/test/pm2.test.js (D.2): 8 passed
    - dashboard/test/runner-events.test.js (D.2): 6 passed
    - dashboard/test/activity.test.js (D.2): 12 passed
    - dashboard/test/status.test.js (D.2): 5 passed
    - dashboard/test/agents.test.js (D.2): 12 passed
    - dashboard/test/doctor.test.js (D.3): 5 passed
    - dashboard/test/update.test.js (D.3): 10 passed
    - dashboard/test/state-file.test.js (D.3): 8 passed
    - dashboard/test/sse.test.js (D.3): 6 passed
    Total: 84 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - /api/doctor 200 envelope ✓
    - /api/update/check 200 envelope ✓
    - /api/update/status/<bogus> 404 ✓
    - /api/update/status/<bad-chars> 400 ✓
    - /api/doctor unauth 401 ✓
  B.4 SSE smoke:
    - existing fixture lines replayed: ✓
    - appended line visible on reconnect: ✓
    - polling fallback /api/update/status/:id ✓
    - done event closes stream: ✓
  B.5 apply gate:
    - no `spawn(hive, [update, --yes])` in test code ✓
    - ~/.neato-hive/state/ unchanged from worker turn ✓
    - ~/.neato-hive/migrations/ unchanged ✓
  B.6 diff-lock = 11 paths: ✓
  B.7 no PM2 verbs in code: ✓
  B.8 no hive-update spawns in test code: ✓

Worker scope attestations:
  - No live `hive update` was triggered by the worker turn
  - No live PM2 verbs executed
  - Live ~/.neato-hive/state/ unchanged
  - Live ~/.neato-hive/migrations/ unchanged
  - Live ~/neato-hive/.env unchanged
  - dashboard/pnpm-lock.yaml unchanged

Sample responses (redacted):
  /api/doctor → <full JSON, redacted>
  /api/update/check → <full JSON>
  /api/update/status/test123 (with fixture) → <full JSON>
  SSE first chunk (with fixture) → <stream excerpt>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-D.3-doctor-update-endpoints
  <verbatim — exactly 11 lines>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full endpoint suite (doctor + update check + apply + status + SSE progress) + 4 lib modules + 4 test files in single PR.
- **DO NOT MERGE** — house-md
- **DO NOT EXEC `hive update` IN TESTS** — `dashboard/test/**` MUST stub the spawn factory. Production code (`dashboard/lib/update.js`) IS the only path that touches `hive update`. B.8 enforces.
- **DO NOT TRIGGER LIVE UPDATES** — Worker tests MUST NOT call `/api/update/apply` against a real running dashboard with real `hive update` enabled. B.5 captures `~/.neato-hive/state/` + `~/.neato-hive/migrations/` baselines and re-checks post-test.
- **DO NOT EXEC PM2 IN ANY PATH** — D.3 does not introduce PM2 calls (carries from D.2). B.7 enforces.
- **DO NOT EXTEND DEPENDENCIES** — production deps remain `express` + `dotenv`. No new packages.
- **DO NOT BREAK D.0a/D.1/D.2 TESTS** — health + auth + pm2 + runner-events + activity + status + agents tests must still pass. 55 → 84 (29 added). Use the existing `createApp` factory shape additively.
- **`update_available` IS THREE-STATE** — `true | false | null`. Never collapse `null` to `false`. Frontend distinguishes "currently up-to-date" from "could not check"; D.3 ships the data unchanged.
- **OWNER DIRECTIVE LOCK** — `/api/update/check` response **MUST** drive the E.5 "Update Now" button gate. When `update_available !== true`, the frontend hides/disables the button. D.3 surfaces the data; E.5 enforces the UI gate. This contract is documented at the top of `routes/update.js`'s comment block.
- **STATE FILE IS SOURCE OF TRUTH** — SSE relay tails it; polling fallback reads it; both always agree. The state file is append-only JSONL emitted by C.6's `_update_emit_progress`. D.3 reads only — never writes.
- **SSE TEAR-DOWN RESILIENCE** — when `hive update` swaps `dashboard/` and PM2-restarts `hive-dashboard` mid-flow, the SSE drops. The browser falls back to polling `/api/update/status/:id` until the dashboard is back. The state file's persistence across the dashboard restart guarantees no event loss.
- **POLLING-TAIL NOT `fs.watch`** — 250ms polling interval. Cross-platform deterministic. Documented rationale.
- **`updateId` VALIDATION** — `^[a-zA-Z0-9_-]+$` only, length 1..200. Rejects path traversal. `routes/update.js`'s `isValidUpdateId()` is the gate.
- **HALT-and-ping rule** — pre-flight surprises (D.2 surface missing, doctor envelope keys differ from D.0a lock, update --check not found, hive-dashboard PM2 entry missing, ecosystem corrupted) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/` (carries from D.0a/D.1/D.2).
- **Forward-protection HALT-and-ping rule for unknown C.6 phases** — if a phase string appears in the live state file that is NOT in C.6's locked phase vocabulary AND it appears terminal-like (e.g. a new `aborted`, `crashed`), the SSE auto-close detection will not fire. This is forward-compat-tolerant (the stream just stays open until the client disconnects), but the worker should report unexpected phases in DONE block.
- **No new shell-tool deps** — node + pnpm + curl + jq + hive (from D.0a + C.5) all standard.

---

## F. Forward links

- **D.4** — Backups + tasks + runner-events endpoints + `/api/sessions/active` (locked owner directive) + `hive dashboard token` + `hive dashboard rotate-token` CLI subcommands. May reuse `dashboard/lib/state-file.js` for any state-file-backed surfaces.
- **E.4 (Doctor page)** — consumes `/api/doctor`. Renders by `category` per the D.0a envelope. On-demand "Refresh" button calls `?nocache=1` (a future leaf may add this) or just re-polls (within the 5s cache TTL, the second poll is fast).
- **E.5 (Updates page)** — consumes `/api/update/check` for the "Update Now" button gate (CONTRACT: hide/disable button when `update_available !== true`); calls `POST /api/update/apply` on click; opens EventSource on `/api/update/progress/:update_id`; falls back to polling `/api/update/status/:update_id` on `EventSource.onerror`. Renders C.6's locked phase vocabulary as a step-by-step progress bar; renders C.7's migration-* events as a "Post-update setup" subsection; renders the `migration-pm2-reload-pending` event's banner from `detail.ecosystem_path`.
- **Future leaf — server-sent doctor refresh:** if E.4's polling pattern proves expensive, a future D-leaf may add `/api/doctor/stream` SSE that pushes new doctor envelopes whenever the cache TTL refreshes. Out of D.3 scope.
- **Future leaf — apply with options:** the body of `POST /api/update/apply` is currently empty. Future leaves may accept `{ dry_run: true }` or `{ skip_doctor: true }` flags. D.3 ships no-input shape only.
