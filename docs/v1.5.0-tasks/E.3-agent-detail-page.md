# v1.5.0 E.3 — Agents Page (List + Detail Modes)

**Status:** LOCKED — glados dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** E — Dashboard frontend (7 PRs)
**Leaf:** E.3 (3 of 7 in Phase E)
**Author:** glados
**Reviewer/dispatcher:** glados (per 2026-05-08 owner-authorized handoff from house-md — glados owns spec → dispatch → review → merge end-to-end)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** E.1 ✅ merged 2026-05-07 (squash `06da606`); E.2 ✅ merged 2026-05-08 (squash `5ae35d8`); D-followup `1cc80dd`
**Successors:** E.4 (Doctor), E.5 (Updates), E.6 (Backups), E.7 (Tasks) — all reuse E.3's pill-rendering + polling-pair patterns

---

## Goal

Replace the placeholder navigation target `/agents.html` (referenced from `shell.js` NAV_LINKS but not yet shipped) with a real Agents page that operates in two modes:

1. **List mode** — `/agents.html` with no query string. Renders a full-page table of declared agents from `/api/agents` (D.2 envelope). Each row is click-through → `/agents.html?name=<n>` (detail mode).
2. **Detail mode** — `/agents.html?name=<n>`. Renders a deep-look at one agent: PM2 stats card, live current_activity, restart button (calls `POST /api/agents/:name/restart`), tail of stdout/stderr logs (`GET /api/agents/:name/logs`), recent runner-events for that agent (from `GET /api/agents/:name` envelope), and a "Recent tasks" section filtered client-side from `GET /api/tasks?limit=200`.

**MPA lock carry-over (from E.1 / E.2):** Single static HTML file (`agents.html`) with both render branches inside one inline `<script type="module">`. The script reads `URLSearchParams` to decide list-vs-detail at boot. NO hash routing. NO history.pushState. Click-through from list to detail is a hard navigation. Clicking "← Back to agents" is a hard navigation back to `/agents.html`.

**Architectural deviation from E.2 forward-link sketch:** E.2's "Forward links" section described detail as `/agents/<name>.html`. That URL shape is incompatible with the MPA static-files lock — agents are declared via `agents.local.yaml` at runtime, not at build time, so per-agent HTML files can't be materialized statically. E.3 lands on `/agents.html?name=<n>` instead. The shell nav still points at `/agents.html` (matches `NAV_LINKS` from `shell.js` which is unchanged). Documented here so the contract is explicit, not an inferred relaxation.

**Polling cadence:**
- List mode polls 5s (matches Overview cadence).
- Detail mode uses TWO timers:
  - **Fast** (1s) — `/api/agents/:name` only, for live current_activity / PM2 stats. Per Decision E lock: "Polls 1s on Detail."
  - **Slow** (5s) — `/api/agents/:name/logs` + `/api/tasks` together. Less time-critical; reduces backend load and human-visible jitter on logs scroll.
- Both timers pause on `document.visibilityState === 'hidden'` and resume on visible (matches E.2 pattern).

---

## Architectural givens (carried)

### Locked from E.1 + E.2

- `dashboard/public/js/auth.js` — `requireToken()`, `getToken()`, `clearToken()`, `redirectToLogin()`
- `dashboard/public/js/api.js` — `apiFetch(path, opts)`, `apiJson(path, opts)`, `apiPing()` (Bearer header + 401 redirect)
- `dashboard/public/js/shell.js` — `renderShell({ activePage, title })` returns `<main>`; `setShellVersion(v)` updates footer; NAV_LINKS includes `/agents.html` already
- `dashboard/public/js/pages/overview.js` + `overview-utils.js` — DO NOT modify; E.3 ships its OWN page module under the same `pages/` convention
- CSS tokens in `dashboard.css` (consume only — DO NOT redefine):
  - Status: `--status-pass`, `--status-warn`, `--status-fail`, `--status-info`
  - Activity: `--activity-idle`, `--activity-turn`, `--activity-task`
  - Surfaces: `--surface`, `--surface-elevated`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-subtle`
- Pill class convention from E.2 — DO NOT redefine `.pill`, `.pill-status-*`, `.pill-activity-*` in CSS. The classes already exist; reuse the same class strings to render PM2-status and activity pills exactly as Overview does. New CSS is for agent-page-specific layout (header, cards, tables, log viewer).
- Static asset serving order in `dashboard/app.js` (E.1 lock): `app.use(express.static(...))` BEFORE auth middleware. NO change needed — `agents.html` is just another static file.

### Module structure

E.3 ships into the existing `dashboard/public/js/pages/` directory introduced by E.2:

- `dashboard/public/js/pages/agents.js` — DOM-rendering + polling for both list and detail modes. Boot reads `URLSearchParams.get('name')` and dispatches.
- `dashboard/public/js/pages/agents-utils.js` — pure functions (formatters, agent-task filter, log-line truncation). Tested with `node --test`.

The split mirrors E.2's overview.js / overview-utils.js convention. The deterministic logic gets unit-tested without jsdom; the DOM-render logic stays inline-tested via the live boot smoke.

### Endpoint usage

**List mode (`/agents.html`):**

```js
const agentsR = await apiJson('/api/agents');  // D.2 envelope
```

Single endpoint. Renders the table. Polls 5s.

**Detail mode (`/agents.html?name=<n>`):**

```js
// Fast tick (1s)
const agentR = await apiJson(`/api/agents/${encodeURIComponent(name)}`);  // D.2

// Slow tick (5s)
const [logsR, tasksR] = await Promise.allSettled([
  apiJson(`/api/agents/${encodeURIComponent(name)}/logs?lines=200`),  // D.2
  apiJson(`/api/tasks?limit=200`),                                    // D.4
]);
```

Two cadences. Fast tick re-renders only the activity-card + PM2-stats-card so log scroll position isn't disturbed. Slow tick re-renders the logs viewer, the recent-tasks table, and the recent-runner-events list.

`Promise.allSettled` for the slow tick — one endpoint failing (e.g. `/api/tasks` unreachable) doesn't tank the page. The fast tick uses a plain `await apiJson(...)` wrapped in `try/catch` because there's only one endpoint; on rejection, render an "agent unavailable" inline banner without redirecting.

### Restart button (locked semantics)

- Visible only in detail mode. Top-right of the agent header.
- Click → opens a `window.confirm()` dialog: `Restart "<name>"? PM2 will kill the process and respawn it.`
- On confirm:
  1. Disable the button (`button.disabled = true`) and add a `.restart-pending` class for visual state.
  2. POST to `/api/agents/:name/restart` via `apiJson(...)`.
  3. On 200 → flash a transient success badge ("Restarted"), force-refresh the fast tick (immediate `await fastTick()`), and re-enable the button after 2s.
  4. On 4xx/5xx → render the error inline next to the button (red text, `--status-fail` token), re-enable the button immediately.
  5. The 401 path is already handled by `apiJson` (auto-redirect to login).
- The button uses native `<button type="button">`. Confirmation is `window.confirm()` for v1 — owner-acceptable interim per house-md handoff §"You've Got This" (architectural call; future leaf can swap for shadcn-style modal).

### URL parsing

```js
function parseQueryParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const agentName = parseQueryParam('name');
const isDetail = agentName !== null && agentName !== '';
```

Defensive — falsy-on-error means a malformed query string falls back to list mode rather than crashing the page boot.

### Polling pattern (twin-timer for detail)

```js
const POLL_FAST_MS = 1000;
const POLL_SLOW_MS = 5000;
let fastHandle = null;
let slowHandle = null;
let fastInFlight = false;
let slowInFlight = false;

async function fastTick() {
  if (fastInFlight) return;
  fastInFlight = true;
  try { /* fetch /api/agents/:name + render header + activity + pm2-stats */ }
  finally { fastInFlight = false; }
}

async function slowTick() {
  if (slowInFlight) return;
  slowInFlight = true;
  try { /* fetch /api/agents/:name/logs + /api/tasks; render logs + tasks + recent events */ }
  finally { slowInFlight = false; }
}

function startPolling() {
  fastTick(); slowTick();
  fastHandle = setInterval(fastTick, POLL_FAST_MS);
  slowHandle = setInterval(slowTick, POLL_SLOW_MS);
}
function stopPolling() {
  if (fastHandle) { clearInterval(fastHandle); fastHandle = null; }
  if (slowHandle) { clearInterval(slowHandle); slowHandle = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopPolling();
  else if (!fastHandle && !slowHandle) startPolling();
});
startPolling();
```

For list mode, only ONE timer at 5s. Same `inFlight` de-dupe pattern as E.2.

### Recent tasks filter (locked behavior)

`/api/tasks` returns ALL tasks paginated. E.3 fetches `?limit=200` and filters client-side:

```js
function selectRecentTasksForAgent(tasks, name, limit = 20) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && t.agent === name)
    .sort((a, b) => {
      // Sort by started_at descending; null started_at sinks to the bottom
      const aStart = a.started_at ? Date.parse(a.started_at) : -Infinity;
      const bStart = b.started_at ? Date.parse(b.started_at) : -Infinity;
      return bStart - aStart;
    })
    .slice(0, limit);
}
```

Pure function in `agents-utils.js`. Tested.

**Why client-side filter:** D.4's `/api/tasks` endpoint accepts `limit` + `offset` only — no agent filter (verified by inspecting `dashboard/routes/tasks.js` post-D.4 merge). Adding a server-side `?agent=` filter would be a D.4 amendment, out of E.3 scope. Client-side filter on 200 rows is cheap and avoids backend churn.

**Trade-off acknowledged:** if an agent has more than 200 historical tasks and the most recent ones are mid-page in the global ordering, this view could show stale "recent" tasks. For v1.5.0 this is acceptable — the runner-events.log keeps roughly the last few weeks of events, and 200 rows from that easily covers each agent's recent activity. If owner reports stale tasks surfacing, file as future leaf "add `?agent=` filter to `/api/tasks`."

### Logs viewer (locked rendering)

`/api/agents/:name/logs?lines=200` returns:

```json
{
  "version": "1",
  "ts": "...",
  "name": "atlas",
  "lines_requested": 200,
  "stdout": ["line 1", "line 2", "..."],
  "stderr": ["err 1", "..."]
}
```

E.3 renders TWO side-by-side `<pre>` blocks (stdout and stderr) inside a single `.logs-card` container. Each `<pre>` is a fixed-height (`max-height: 360px`), monospace, scrollable region. New content appends at bottom; auto-scroll-to-bottom only if the user is already near the bottom (within 24px). If the user has scrolled up to read older lines, do NOT auto-scroll on refresh — preserves the read position.

```js
function maybeAutoScroll(el, stickyDistance = 24) {
  if (!el) return false;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distanceFromBottom <= stickyDistance;
}

function renderLogStream(el, lines) {
  if (!el) return;
  const wasAtBottom = maybeAutoScroll(el);
  el.textContent = (lines || []).join('\n');
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}
```

Pure render. Each `<pre>` shows up to 200 lines (the requested cap from the endpoint). No client-side line truncation beyond what the endpoint returns.

**HTML escape:** `el.textContent = ...` (NOT `innerHTML`) — log lines may contain arbitrary chars including `<`, `>`, `&`. Using `textContent` is the canonical defense; never interpolate log lines into innerHTML.

### Header + activity card (locked layout)

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back to agents                                                │
│                                                                 │
│ atlas     [online]  [task]              [Restart]  [Restarted!] │
│                                                                 │
│ ┌──────────────────────┐  ┌────────────────────────────────────┐│
│ │ Current activity     │  │ PM2 stats                          ││
│ │ State:    task       │  │ Status:        online              ││
│ │ Task ID:  t_2026...  │  │ PID:           12345               ││
│ │ Since:    3m ago     │  │ Uptime:        2h 14m              ││
│ │                      │  │ CPU:           0.4 %               ││
│ │                      │  │ Memory:        78.9 MB             ││
│ │                      │  │ Restart count: 2                   ││
│ └──────────────────────┘  └────────────────────────────────────┘│
│                                                                 │
│ Logs                                                            │
│ ┌──────────────────────┐  ┌────────────────────────────────────┐│
│ │ stdout (200 lines)   │  │ stderr (200 lines)                 ││
│ │ ...                  │  │ ...                                ││
│ └──────────────────────┘  └────────────────────────────────────┘│
│                                                                 │
│ Recent tasks (this agent)                                       │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ taskId           kind   status       started     elapsed    │ │
│ │ t_2026-...       codex  completed    2h ago      4m 12s     │ │
│ │ ...                                                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ Recent runner events (this agent, last 20)                      │
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘
```

Below 720px the activity-card / pm2-stats-card collapse to single column, the logs-card stacks stdout above stderr, and the tasks/events tables become horizontally scrollable.

---

## Pre-conditions

- E.1 ✅ merged at `06da606` — `dashboard/public/`, `js/auth.js`, `js/api.js`, `js/shell.js`, `css/dashboard.css` all present
- E.2 ✅ merged at `5ae35d8` — `js/pages/` directory + `overview.js` + `overview-utils.js` + `dashboard.css` Overview-page CSS additions all present, including locked `.pill-*` classes
- D.2 + D.4 endpoints all live: `/api/agents`, `/api/agents/:name`, `/api/agents/:name/restart`, `/api/agents/:name/logs`, `/api/tasks`
- D-followup `1cc80dd` merged (cmd_bootstrap auto-ensures token) — owner's local install has a token for live boot smoke
- Node ≥ 22 (carried)

---

## Where state lives (E.3 conventions)

**New files (4):**
- `dashboard/public/agents.html` — single static HTML file hosting both list and detail modes
- `dashboard/public/js/pages/agents.js` — page render module (impure: DOM, polling, fetch)
- `dashboard/public/js/pages/agents-utils.js` — pure helpers (formatters, agent-task filter, scroll-stickiness predicate)
- `dashboard/test/agents-utils.test.js` — `node --test` for the pure helpers

**Modified file (1):**
- `dashboard/public/css/dashboard.css` — append agent-page-specific styles (header, cards layout, logs-card, tasks-table). Tokens-only — NO new tokens defined.

**Total: 5 paths.**

**No backend changes.** All endpoints already shipped. No new prod deps. No new dev deps.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `5ae35d8` (E.2 merge) + the E.3 spec commit you're about to receive notification on.

### 2. E.1 + E.2 surface present

```bash
test -f dashboard/public/index.html && echo "index.html ✓"
test -f dashboard/public/login.html && echo "login.html ✓"
test -f dashboard/public/js/auth.js && echo "auth.js ✓"
test -f dashboard/public/js/api.js && echo "api.js ✓"
test -f dashboard/public/js/shell.js && echo "shell.js ✓"
test -d dashboard/public/js/pages && echo "pages/ ✓"
test -f dashboard/public/js/pages/overview.js && echo "overview.js ✓"
test -f dashboard/public/js/pages/overview-utils.js && echo "overview-utils.js ✓"
test -f dashboard/public/css/dashboard.css && echo "dashboard.css ✓"
grep -E '\.pill-status-online|\.pill-activity-idle' dashboard/public/css/dashboard.css | head -2
```

**HALT and ping glados** if any E.1/E.2 surface is missing OR locked pill classes are absent.

### 3. E.3 target paths absent

```bash
test ! -f dashboard/public/agents.html && echo "agents.html absent ✓"
test ! -f dashboard/public/js/pages/agents.js && echo "agents.js absent ✓"
test ! -f dashboard/public/js/pages/agents-utils.js && echo "agents-utils.js absent ✓"
test ! -f dashboard/test/agents-utils.test.js && echo "agents-utils.test.js absent ✓"
```

**HALT and ping glados** if any exist.

### 4. Endpoint sample (live boot to confirm shapes match expectations)

Pick an agent name that exists in `pm2 jlist` (any of the declared agents in `agents.local.yaml`). Worker captures the chosen name in the PR body for the smoke trace.

```bash
TOKEN=$(printf 'a%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57776 \
  node dashboard/index.js > /tmp/E3-pre4.out 2>&1 &
PID=$!
sleep 2

# Pick the first declared agent from /api/agents response
AGENT=$(curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/agents | jq -r '.agents[0].name')
echo "Sampling endpoints for agent: $AGENT"

# Detail, logs, tasks (the three E.3 detail-mode reads)
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:57776/api/agents/$AGENT" | jq -c '{version, name, has_pm2: (.pm2 | type), has_activity: (.current_activity | type), recent_events_n: (.recent_events | length)}'
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:57776/api/agents/$AGENT/logs?lines=50" | jq -c '{version, name, lines_requested, stdout_n: (.stdout | length), stderr_n: (.stderr | length)}'
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:57776/api/tasks?limit=50" | jq -c '{version, total, returned: (.tasks | length), first_keys: (.tasks[0] | keys // [] | sort)}'

# 404 path — bogus agent name
curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:57776/api/agents/__nonexistent__"
echo

# Restart endpoint shape — DRY-RUN: do NOT execute against a real agent during pre-flight
echo "(Restart POST not exercised in pre-flight — would side-effect a real agent.)"

kill $PID
```

Expected:
- `/api/agents/$AGENT` → 200, envelope has `version, name, pm2, current_activity, recent_events`
- `/api/agents/$AGENT/logs?lines=50` → 200, envelope has `version, name, lines_requested, stdout, stderr` (arrays)
- `/api/tasks?limit=50` → 200, envelope has `version, total, tasks` (with row keys: `taskId, agent, kind, cmd_excerpt, started_at, elapsed_ms, status, last_runner_event`)
- `/api/agents/__nonexistent__` → 404

**HALT and ping glados** if any envelope's keys differ from the locked shapes.

### 5. Existing test suite baseline

```bash
cd dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E3-test.out | tail -10
grep -cE '✔|pass' /tmp/E3-test.out
```

Expected baseline: **125 tests pass** (115 D.x baseline + 10 from E.2's `overview-utils.test.js`). Worker captures the count in the PR body. Post-E.3 must still be 125 pre-existing pass + new agents-utils tests.

### 6. Tooling

```bash
node --version && pnpm --version && which curl && which jq
```

Expected: Node ≥ 22.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-E.3-agents-page`.

**Diff lock: 5 paths exactly** (4 new + 1 modified).

### A.1 — `dashboard/public/js/pages/agents-utils.js`

Pure functions only. No DOM. No I/O. Each function independently testable.

```javascript
'use strict';

// Filter + sort tasks for a given agent.
// Returns up to `limit` tasks, sorted by started_at descending (null sinks).
export function selectRecentTasksForAgent(tasks, name, limit = 20) {
  if (!Array.isArray(tasks) || typeof name !== 'string' || !name) return [];
  return tasks
    .filter((t) => t && t.agent === name)
    .sort((a, b) => {
      const aStart = a.started_at ? Date.parse(a.started_at) : -Infinity;
      const bStart = b.started_at ? Date.parse(b.started_at) : -Infinity;
      return bStart - aStart;
    })
    .slice(0, limit);
}

// Format a duration in milliseconds as "1h 23m" / "45s" / "12m 4s".
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr - day * 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

// Format bytes as KB/MB/GB with one decimal.
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Format a timestamp as relative ("just now", "5m ago", "2h ago", "3d ago")
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return '';
  const delta = Math.max(0, now - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  return day + 'd ago';
}

// Truncate a string with ellipsis. Used for taskId display.
export function truncate(s, len = 24) {
  if (typeof s !== 'string' || s.length <= len) return s || '';
  return s.slice(0, len) + '…';
}

// Map pm2_status to CSS class suffix (matches E.2's pillStatusClass for visual consistency)
export function pm2StatusClass(s) {
  const v = typeof s === 'string' ? s.toLowerCase() : 'unknown';
  if (v === 'online') return 'online';
  if (v === 'errored') return 'errored';
  if (v === 'stopped') return 'stopped';
  if (v === 'not_running') return 'not_running';
  return 'unknown';
}

// Map current_activity.state to CSS class suffix
export function activityClass(state) {
  if (state === 'idle' || state === 'turn' || state === 'task') return state;
  return 'idle';
}

// Auto-scroll predicate: was the element scrolled near the bottom before this update?
export function isNearBottom(el, stickyDistance = 24) {
  if (!el || typeof el.scrollHeight !== 'number') return false;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distanceFromBottom <= stickyDistance;
}

// Map task status to a CSS class suffix for status pills in the recent-tasks table.
// Inputs from D.4 buildTaskHistory: 'running' | 'completed' | 'errored' | 'timed_out' | 'unknown'.
export function taskStatusClass(s) {
  const v = typeof s === 'string' ? s : 'unknown';
  if (v === 'running') return 'running';
  if (v === 'completed') return 'completed';
  if (v === 'errored') return 'errored';
  if (v === 'timed_out') return 'timed_out';
  return 'unknown';
}
```

### A.2 — `dashboard/public/js/pages/agents.js`

DOM render + dual-mode dispatch + polling. Imports utils from A.1, `apiJson` / `apiFetch` from `js/api.js`, shell helpers from `js/shell.js`.

```javascript
'use strict';

import { apiJson, apiFetch } from '/js/api.js';
import {
  selectRecentTasksForAgent,
  formatDuration,
  formatBytes,
  relativeTime,
  truncate,
  pm2StatusClass,
  activityClass,
  isNearBottom,
  taskStatusClass,
} from '/js/pages/agents-utils.js';

const POLL_LIST_MS = 5000;
const POLL_FAST_MS = 1000;
const POLL_SLOW_MS = 5000;
const LOGS_TAIL_LINES = 200;
const TASKS_FETCH_LIMIT = 200;
const RESTART_FLASH_MS = 2000;

export function renderAgents(main) {
  const name = parseQueryParam('name');
  if (name) {
    renderAgentDetail(main, name);
  } else {
    renderAgentList(main);
  }
}

function parseQueryParam(key) {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

// ---------- LIST MODE ----------

function renderAgentList(main) {
  main.innerHTML = `
    <div class="agents-page-header">
      <h1>Agents</h1>
    </div>
    <section class="overview-card agents-list-card">
      <div id="agents-list-body"></div>
    </section>
  `;

  let listHandle = null;
  let inFlight = false;

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await apiJson('/api/agents').catch(() => null);
      renderListBody(r);
    } finally {
      inFlight = false;
    }
  }

  function renderListBody(payload) {
    const body = document.getElementById('agents-list-body');
    if (!payload || !Array.isArray(payload.agents)) {
      body.innerHTML = `<p class="muted">Agent list unavailable.</p>`;
      return;
    }
    if (payload.agents.length === 0) {
      body.innerHTML = `<p class="muted">No agents declared.</p>`;
      return;
    }
    body.innerHTML = `
      <table class="agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>PM2</th>
            <th>Activity</th>
            <th>Last event</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${payload.agents.map((a) => {
            const pm2Cls = pm2StatusClass(a.pm2_status);
            const act = a.current_activity || { state: 'idle', task_id: null, since: null };
            const actCls = activityClass(act.state);
            const lastEvtLabel = a.last_event_ts
              ? `${escape(a.last_event || '')} · ${escape(relativeTime(a.last_event_ts))}`
              : '—';
            const detailHref = `/agents.html?name=${encodeURIComponent(a.name)}`;
            return `
              <tr class="agents-row">
                <td class="agents-cell-name">${escape(a.name)}</td>
                <td><span class="pill pill-status-${pm2Cls}">${escape(a.pm2_status || 'unknown')}</span></td>
                <td><span class="pill pill-activity-${actCls}">${escape(act.state)}</span></td>
                <td class="agents-cell-last-event">${lastEvtLabel}</td>
                <td class="agents-cell-link"><a href="${detailHref}">Detail →</a></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function startPolling() {
    refresh();
    listHandle = setInterval(refresh, POLL_LIST_MS);
  }
  function stopPolling() {
    if (listHandle) { clearInterval(listHandle); listHandle = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPolling();
    else if (!listHandle) startPolling();
  });
  startPolling();
}

// ---------- DETAIL MODE ----------

function renderAgentDetail(main, name) {
  main.innerHTML = `
    <div class="agents-page-header">
      <a class="agents-back-link" href="/agents.html">← Back to agents</a>
    </div>
    <header class="agent-detail-header">
      <div class="agent-detail-title">
        <h1>${escape(name)}</h1>
        <div class="agent-detail-pills" id="agent-detail-pills"></div>
      </div>
      <div class="agent-detail-actions">
        <button type="button" id="agent-restart-btn" class="agent-restart-btn">Restart</button>
        <span id="agent-restart-status" class="agent-restart-status"></span>
      </div>
    </header>
    <div id="agent-detail-error" class="agent-detail-error"></div>
    <div class="overview-grid agent-detail-grid">
      <section class="overview-card agent-activity-card">
        <h2>Current activity</h2>
        <dl id="agent-activity-body" class="agent-kv"></dl>
      </section>
      <section class="overview-card agent-pm2-card">
        <h2>PM2 stats</h2>
        <dl id="agent-pm2-body" class="agent-kv"></dl>
      </section>
    </div>
    <section class="overview-card agent-logs-card">
      <h2>Logs <span class="muted agent-logs-hint">tail ${LOGS_TAIL_LINES} lines</span></h2>
      <div class="agent-logs-grid">
        <div class="agent-log-pane">
          <h3>stdout</h3>
          <pre id="agent-log-stdout" class="agent-log-pre"></pre>
        </div>
        <div class="agent-log-pane">
          <h3>stderr</h3>
          <pre id="agent-log-stderr" class="agent-log-pre"></pre>
        </div>
      </div>
    </section>
    <section class="overview-card agent-tasks-card">
      <h2>Recent tasks <span class="muted">(this agent)</span></h2>
      <div id="agent-tasks-body"></div>
    </section>
    <section class="overview-card agent-events-card">
      <h2>Recent runner events <span class="muted">(this agent, last 20)</span></h2>
      <ul id="agent-events-body" class="events-list"></ul>
    </section>
  `;

  let fastHandle = null;
  let slowHandle = null;
  let fastInFlight = false;
  let slowInFlight = false;
  let restartFlashTimer = null;

  // ---------- Restart button wiring ----------
  const restartBtn = document.getElementById('agent-restart-btn');
  restartBtn.addEventListener('click', async () => {
    const ok = window.confirm(`Restart "${name}"? PM2 will kill the process and respawn it.`);
    if (!ok) return;
    restartBtn.disabled = true;
    restartBtn.classList.add('restart-pending');
    setRestartStatus('Restarting…', 'pending');
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setRestartStatus(errBody.error || `Restart failed (HTTP ${res.status})`, 'fail');
        restartBtn.disabled = false;
        restartBtn.classList.remove('restart-pending');
        return;
      }
      setRestartStatus('Restarted', 'ok');
      // Force-refresh fast tick to show new uptime / activity
      await fastTick();
      if (restartFlashTimer) clearTimeout(restartFlashTimer);
      restartFlashTimer = setTimeout(() => {
        setRestartStatus('', '');
        restartBtn.disabled = false;
        restartBtn.classList.remove('restart-pending');
      }, RESTART_FLASH_MS);
    } catch (err) {
      setRestartStatus(err.message || 'Restart failed', 'fail');
      restartBtn.disabled = false;
      restartBtn.classList.remove('restart-pending');
    }
  });

  function setRestartStatus(text, kind) {
    const el = document.getElementById('agent-restart-status');
    el.textContent = text || '';
    el.className = `agent-restart-status ${kind ? 'restart-status-' + kind : ''}`.trim();
  }

  // ---------- Fast tick ----------
  async function fastTick() {
    if (fastInFlight) return;
    fastInFlight = true;
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(name)}`);
      if (res.status === 404) {
        renderNotFound();
        stopPolling();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      clearError();
      renderHeaderPills(payload);
      renderActivity(payload);
      renderPm2(payload);
      renderRecentEvents(payload);
    } catch (err) {
      renderError(err.message || 'Agent unavailable');
    } finally {
      fastInFlight = false;
    }
  }

  // ---------- Slow tick ----------
  async function slowTick() {
    if (slowInFlight) return;
    slowInFlight = true;
    try {
      const [logsR, tasksR] = await Promise.allSettled([
        apiJson(`/api/agents/${encodeURIComponent(name)}/logs?lines=${LOGS_TAIL_LINES}`),
        apiJson(`/api/tasks?limit=${TASKS_FETCH_LIMIT}`),
      ]);
      renderLogs(logsR.status === 'fulfilled' ? logsR.value : null);
      renderRecentTasks(tasksR.status === 'fulfilled' ? tasksR.value : null);
    } finally {
      slowInFlight = false;
    }
  }

  // ---------- Render functions ----------

  function renderHeaderPills(payload) {
    const el = document.getElementById('agent-detail-pills');
    const pm2 = payload.pm2 || {};
    const act = payload.current_activity || { state: 'idle' };
    const pm2Cls = pm2StatusClass(pm2.status);
    const actCls = activityClass(act.state);
    el.innerHTML = `
      <span class="pill pill-status-${pm2Cls}">${escape(pm2.status || 'unknown')}</span>
      <span class="pill pill-activity-${actCls}">${escape(act.state)}</span>
    `;
  }

  function renderActivity(payload) {
    const body = document.getElementById('agent-activity-body');
    const act = payload.current_activity || { state: 'idle', task_id: null, since: null };
    const sinceLabel = act.since ? relativeTime(act.since) : '—';
    const taskLabel = act.task_id
      ? `<a href="/tasks.html">${escape(truncate(act.task_id, 32))}</a>`
      : '—';
    body.innerHTML = `
      <dt>State</dt><dd><span class="pill pill-activity-${activityClass(act.state)}">${escape(act.state)}</span></dd>
      <dt>Task ID</dt><dd>${taskLabel}</dd>
      <dt>Since</dt><dd>${escape(sinceLabel)}</dd>
    `;
  }

  function renderPm2(payload) {
    const body = document.getElementById('agent-pm2-body');
    const pm2 = payload.pm2;
    if (!pm2) {
      body.innerHTML = `<dt>Status</dt><dd class="muted">Not in PM2</dd>`;
      return;
    }
    body.innerHTML = `
      <dt>Status</dt><dd><span class="pill pill-status-${pm2StatusClass(pm2.status)}">${escape(pm2.status || 'unknown')}</span></dd>
      <dt>PID</dt><dd>${escape(pm2.pid != null ? String(pm2.pid) : '—')}</dd>
      <dt>Uptime</dt><dd>${escape(pm2.uptime_s != null ? formatDuration(pm2.uptime_s * 1000) : '—')}</dd>
      <dt>CPU</dt><dd>${escape(pm2.cpu_percent != null ? pm2.cpu_percent.toFixed(1) + ' %' : '—')}</dd>
      <dt>Memory</dt><dd>${escape(pm2.memory_bytes != null ? formatBytes(pm2.memory_bytes) : '—')}</dd>
      <dt>Restart count</dt><dd>${escape(pm2.restart_count != null ? String(pm2.restart_count) : '—')}</dd>
    `;
  }

  function renderRecentEvents(payload) {
    const list = document.getElementById('agent-events-body');
    if (!payload || !Array.isArray(payload.recent_events)) {
      list.innerHTML = `<li class="muted">Recent events unavailable</li>`;
      return;
    }
    const events = payload.recent_events.slice(-20).reverse();  // newest first
    if (events.length === 0) {
      list.innerHTML = `<li class="muted">No recent events</li>`;
      return;
    }
    list.innerHTML = events.map((e) => `
      <li class="event-row">
        <span class="event-time">${escape(relativeTime(e.ts))}</span>
        <span class="event-kind">${escape(e.event)}</span>
        <span class="event-agent">${escape(e.agent || '')}</span>
        <span class="event-taskid">${escape(truncate(e.taskId || '', 12))}</span>
      </li>
    `).join('');
  }

  function renderLogs(logsPayload) {
    const stdoutEl = document.getElementById('agent-log-stdout');
    const stderrEl = document.getElementById('agent-log-stderr');
    if (!logsPayload) {
      stdoutEl.textContent = '(unavailable)';
      stderrEl.textContent = '(unavailable)';
      return;
    }
    appendLogStream(stdoutEl, logsPayload.stdout);
    appendLogStream(stderrEl, logsPayload.stderr);
  }

  function appendLogStream(el, lines) {
    const wasAtBottom = isNearBottom(el);
    el.textContent = (Array.isArray(lines) ? lines : []).join('\n');
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  }

  function renderRecentTasks(tasksPayload) {
    const body = document.getElementById('agent-tasks-body');
    if (!tasksPayload || !Array.isArray(tasksPayload.tasks)) {
      body.innerHTML = `<p class="muted">Tasks unavailable.</p>`;
      return;
    }
    const filtered = selectRecentTasksForAgent(tasksPayload.tasks, name, 20);
    if (filtered.length === 0) {
      body.innerHTML = `<p class="muted">No recent tasks for this agent.</p>`;
      return;
    }
    body.innerHTML = `
      <table class="agent-tasks-table">
        <thead>
          <tr>
            <th>Task ID</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Started</th>
            <th>Elapsed</th>
            <th>Last event</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((t) => `
            <tr>
              <td class="task-cell-id"><code>${escape(truncate(t.taskId || '', 28))}</code></td>
              <td>${escape(t.kind || '—')}</td>
              <td><span class="pill pill-task-${taskStatusClass(t.status)}">${escape(t.status || 'unknown')}</span></td>
              <td>${escape(t.started_at ? relativeTime(t.started_at) : '—')}</td>
              <td>${escape(t.elapsed_ms != null ? formatDuration(t.elapsed_ms) : '—')}</td>
              <td class="muted">${escape(t.last_runner_event || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderNotFound() {
    document.getElementById('agent-detail-error').innerHTML = `
      <p class="agent-detail-error-msg">Agent not found: <code>${escape(name)}</code></p>
      <p><a href="/agents.html">← Back to agents</a></p>
    `;
    // Hide the rest of the page
    document.querySelector('.agent-detail-header').style.display = 'none';
    document.querySelectorAll('.overview-card').forEach((c) => { c.style.display = 'none'; });
  }

  function renderError(msg) {
    const el = document.getElementById('agent-detail-error');
    el.textContent = msg;
    el.classList.add('agent-detail-error-active');
  }
  function clearError() {
    const el = document.getElementById('agent-detail-error');
    el.textContent = '';
    el.classList.remove('agent-detail-error-active');
  }

  // ---------- Polling lifecycle ----------
  function startPolling() {
    fastTick();
    slowTick();
    fastHandle = setInterval(fastTick, POLL_FAST_MS);
    slowHandle = setInterval(slowTick, POLL_SLOW_MS);
  }
  function stopPolling() {
    if (fastHandle) { clearInterval(fastHandle); fastHandle = null; }
    if (slowHandle) { clearInterval(slowHandle); slowHandle = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPolling();
    else if (!fastHandle && !slowHandle) startPolling();
  });

  startPolling();
}

// ---------- Defensive HTML escape ----------

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
```

**Locked semantics:**
- One `inFlight` flag PER timer (fast/slow) — neither overlaps with itself, but fast and slow can run concurrently. Acceptable; they touch disjoint DOM regions.
- `Promise.allSettled` for slow tick — one endpoint failing doesn't tank logs+tasks rendering.
- Fast tick uses raw `apiFetch` so it can detect 404 (agent not found) without a try/catch around `apiJson`.
- 404 from `/api/agents/:name` → render-not-found + stop polling. Permanent terminal state until user navigates away.
- All dynamic strings HTML-escaped. Log lines via `textContent` (not innerHTML).
- Restart button: `window.confirm()` gate, disabled-during-request, success flash, error inline.
- `visibilitychange` pauses BOTH timers; resumes both.
- `setRestartStatus('', '')` on flash-end clears all status classes.

### A.3 — `dashboard/public/agents.html`

Mirrors `index.html` from E.2. Bootstrap inline `<script type="module">` calls `requireToken()` + `renderShell()` + `renderAgents(main)`.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agents - Hive Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body>
  <script type="module">
    import { requireToken } from '/js/auth.js';
    import { apiFetch, apiPing } from '/js/api.js';
    import { renderShell, setShellVersion } from '/js/shell.js';
    import { renderAgents } from '/js/pages/agents.js';

    if (!requireToken()) {
      // Redirected to login.
    } else {
      const isAuthorized = await apiPing();
      if (isAuthorized) {
        const main = renderShell({ activePage: '/agents.html', title: 'Agents' });
        renderAgents(main);

        apiFetch('/api/health')
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => setShellVersion(payload ? payload.version : 'unknown'))
          .catch(() => setShellVersion('unknown'));
      }
    }
  </script>
</body>
</html>
```

`activePage: '/agents.html'` matches the `NAV_LINKS` entry from `shell.js` and renders the active-link aria-current state. No NAV_LINKS edits needed — the entry is already there from E.1.

### A.4 — `dashboard/public/css/dashboard.css` additions

Append (do NOT redefine existing tokens). All styles use existing tokens. No new color hex values.

```css
/* ---- Agents page ---- */

.agents-page-header {
  margin-bottom: 16px;
}
.agents-page-header h1 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--text-primary);
}
.agents-back-link {
  display: inline-block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 0.9em;
}
.agents-back-link:hover { color: var(--text-primary); text-decoration: underline; }

/* List mode */

.agents-list-card { padding: 0; }
.agents-table {
  width: 100%;
  border-collapse: collapse;
}
.agents-table th, .agents-table td {
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.agents-table th {
  font-size: 0.8em;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--surface);
}
.agents-table tbody tr:last-child td { border-bottom: none; }
.agents-cell-name { font-weight: 500; color: var(--text-primary); }
.agents-cell-last-event { font-size: 0.85em; color: var(--text-muted); }
.agents-cell-link a { color: var(--text-primary); font-weight: 500; text-decoration: none; }
.agents-cell-link a:hover { text-decoration: underline; }

/* Detail mode */

.agent-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.agent-detail-title { display: flex; flex-direction: column; gap: 6px; }
.agent-detail-title h1 { margin: 0; font-size: 1.5rem; color: var(--text-primary); }
.agent-detail-pills { display: flex; gap: 6px; }

.agent-detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-restart-btn {
  appearance: none;
  background: var(--accent-subtle);
  color: var(--text-primary);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 6px 14px;
  font-weight: 500;
  cursor: pointer;
}
.agent-restart-btn:hover:not(:disabled) { background: var(--accent); }
.agent-restart-btn:disabled,
.agent-restart-btn.restart-pending {
  opacity: 0.6;
  cursor: not-allowed;
}
.agent-restart-status {
  font-size: 0.85em;
  color: var(--text-secondary);
}
.agent-restart-status.restart-status-pending { color: var(--text-secondary); }
.agent-restart-status.restart-status-ok { color: var(--status-pass); font-weight: 600; }
.agent-restart-status.restart-status-fail { color: var(--status-fail); font-weight: 600; }

.agent-detail-error {
  padding: 0;
  margin-bottom: 12px;
}
.agent-detail-error-active {
  padding: 8px 12px;
  background: var(--surface-elevated);
  border: 1px solid var(--status-fail);
  border-radius: 8px;
  color: var(--status-fail);
  font-size: 0.9em;
}
.agent-detail-error-msg { color: var(--status-fail); font-weight: 600; }

.agent-detail-grid {
  grid-template-columns: 1fr 1fr;
  grid-template-areas: "activity pm2";
}
.agent-activity-card { grid-area: activity; }
.agent-pm2-card { grid-area: pm2; }

.agent-kv {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 12px;
}
.agent-kv dt { font-size: 0.85em; color: var(--text-secondary); }
.agent-kv dd { margin: 0; color: var(--text-primary); }

/* Logs */

.agent-logs-card { margin-top: 16px; }
.agent-logs-hint { font-weight: normal; font-size: 0.85em; }
.agent-logs-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.agent-log-pane h3 {
  margin: 0 0 6px;
  font-size: 0.9em;
  color: var(--text-secondary);
  font-weight: 500;
}
.agent-log-pre {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 0.8em;
  color: var(--text-primary);
  white-space: pre;
  line-height: 1.4;
}

/* Recent tasks */

.agent-tasks-card { margin-top: 16px; }
.agent-tasks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.agent-tasks-table th, .agent-tasks-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.agent-tasks-table th {
  font-size: 0.8em;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.agent-tasks-table tbody tr:last-child td { border-bottom: none; }
.task-cell-id code {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 0.85em;
  color: var(--text-muted);
}

.pill-task-running { background: var(--status-info); }
.pill-task-completed { background: var(--status-pass); }
.pill-task-errored { background: var(--status-fail); }
.pill-task-timed_out { background: var(--status-warn); }
.pill-task-unknown { background: var(--text-muted); }

.agent-events-card { margin-top: 16px; }

/* Mobile */

@media (max-width: 720px) {
  .agent-detail-header { flex-direction: column; align-items: stretch; }
  .agent-detail-actions { justify-content: flex-end; }
  .agent-detail-grid {
    grid-template-columns: 1fr;
    grid-template-areas: "activity" "pm2";
  }
  .agent-logs-grid { grid-template-columns: 1fr; }
  .agents-table th:nth-child(4), .agents-table td:nth-child(4) { display: none; }
  .agent-tasks-table { display: block; overflow-x: auto; }
}
```

**Locked:**
- All colors via existing tokens — no new hex values. Task-status pills reuse `--status-pass`, `--status-info`, `--status-fail`, `--status-warn` via the `.pill-task-*` mapping.
- The `.pill` base class is NOT redefined — it's reused from E.2's CSS.
- Mobile responsive at 720px (matches E.2 breakpoint).
- No external font load — same system stack.

### A.5 — `dashboard/test/agents-utils.test.js`

`node --test` for the pure helpers. Locked test cases (12):

1. `selectRecentTasksForAgent([], 'atlas')` → `[]`
2. `selectRecentTasksForAgent(null, 'atlas')` → `[]`
3. `selectRecentTasksForAgent([...], 'atlas', 5)` with 8 tasks (3 atlas, 5 bob) → only 3 returned, sorted by `started_at` desc
4. `selectRecentTasksForAgent` with one task having null `started_at` → that task sinks to the end
5. `formatDuration(45000)` → `'45s'`; `formatDuration(125000)` → `'2m 5s'`; `formatDuration(3725000)` → `'1h 2m'`; `formatDuration(86400000)` → `'1d'`; `formatDuration(NaN)` → `''`; `formatDuration(-1)` → `''`
6. `formatBytes(0)` → `'0 B'`; `formatBytes(2048)` → `'2.0 KB'`; `formatBytes(78901234)` → `'75.2 MB'`; `formatBytes(NaN)` → `''`
7. `relativeTime` — 30s ago, 5m ago, 3h ago, 2d ago (locked outputs)
8. `truncate('long-string-value', 5)` → `'long-…'`; `truncate('short', 12)` → `'short'`; `truncate(null, 5)` → `''`
9. `pm2StatusClass('online')` → `'online'`; `pm2StatusClass('UNKNOWN')` → `'unknown'`
10. `activityClass('weird')` → `'idle'`; `activityClass('task')` → `'task'`
11. `isNearBottom({scrollHeight: 1000, scrollTop: 970, clientHeight: 24})` → `true` (distance = 6, sticky default 24); `isNearBottom({scrollHeight: 1000, scrollTop: 100, clientHeight: 200})` → `false`; `isNearBottom(null)` → `false`
12. `taskStatusClass('running')` → `'running'`; `taskStatusClass('errored')` → `'errored'`; `taskStatusClass('timed_out')` → `'timed_out'`; `taskStatusClass('mystery')` → `'unknown'`; `taskStatusClass(null)` → `'unknown'`

The test file uses ESM imports. Per the E.2 amendment finding, `dashboard/package.json` has `"type": "commonjs"`, so the test file must use `.mjs` extension OR dynamic `import()`. Worker matches whatever convention E.2's `overview-utils.test.js` chose — read that file in pre-flight and mirror the pattern exactly.

---

## B. Tests + verification

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E3-test.out
# Expected: 125 (E.1+E.2 baseline) + 12 (agents-utils) = 137 tests passing
grep -E '✔|pass' /tmp/E3-test.out | wc -l
```

### B.2 — Lockfile + dep audit

```bash
cd ~/neato-hive/dashboard
pnpm install --frozen-lockfile
pnpm list --depth=0 --prod
# Expected: express + dotenv only — E.3 adds NO new prod deps
```

### B.3 — Live boot smoke (manual browser verification)

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57777 \
  node dashboard/index.js > /tmp/E3-boot.out 2>&1 &
PID=$!
sleep 2

# /agents.html serves shell + imports agents.js
curl -fsS http://127.0.0.1:57777/agents.html | grep -q 'pages/agents.js' && echo "B.3.a: agents.html imports agents.js ✓"
curl -fsS http://127.0.0.1:57777/js/pages/agents.js | head -3 | grep -q "use strict" && echo "B.3.b: agents.js loads ✓"
curl -fsS http://127.0.0.1:57777/js/pages/agents-utils.js | head -3 | grep -q "use strict" && echo "B.3.c: agents-utils.js loads ✓"

# Manual smoke: open http://127.0.0.1:57777/agents.html in a browser
echo "B.3.manual: open http://127.0.0.1:57777/agents.html in browser; paste $TOKEN; verify"
echo "  - List mode: agent table renders with PM2 + activity pills + 'Detail →' link"
echo "  - Click Detail → /agents.html?name=<n> renders detail mode"
echo "  - Detail: header pills, current activity card, PM2 stats card, logs (stdout + stderr) tail, recent tasks table, recent runner events list"
echo "  - Restart button: click → confirm → spinner → 'Restarted' flash"
echo "  - 404 path: /agents.html?name=__nope__ shows 'Agent not found'"
echo "  - Polling: dev tools network shows /api/agents/<n> at ~1s, /api/agents/<n>/logs + /api/tasks at ~5s"

kill $PID
```

### B.4 — Polling pause on tab-hidden (manual smoke)

```bash
echo "B.4.manual: open browser at /agents.html?name=<atlas-or-similar>"
echo "  - Watch network tab; both 1s and 5s polls fire"
echo "  - Hide tab (cmd+t to new tab) → both polls stop"
echo "  - Restore tab → both polls resume"
```

### B.5 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-E.3-agents-page
# Expected: exactly 5 files (4 new + 1 modified)
git diff main...feat/v1.5.0-E.3-agents-page -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.6 — No PM2 verbs in diff

```bash
git diff main...feat/v1.5.0-E.3-agents-page | grep -E '^\+.*pm2 (start|restart|reload|delete|save|stop|kill)' | head -5
# Expected: empty
```

The dashboard-server-side restart goes through the existing D.2 endpoint (`POST /api/agents/:name/restart`), which is the only sanctioned PM2 mutation in the project. Frontend calls the endpoint via fetch — no `pm2` shell invocations in the frontend.

### B.7 — No new CSS tokens

```bash
git diff main...feat/v1.5.0-E.3-agents-page -- dashboard/public/css/dashboard.css | grep -E '^\+\s*--[a-z]' | head -5
# Expected: empty (E.3 must consume existing tokens only)
```

### B.8 — No NAV_LINKS edits

```bash
git diff main...feat/v1.5.0-E.3-agents-page -- dashboard/public/js/shell.js
# Expected: empty (NAV_LINKS already includes /agents.html from E.1)
```

### B.9 — No `innerHTML` of unescaped data

Worker grep-checks the new files for any `innerHTML = `…interpolation that doesn't go through `escape(...)`:

```bash
grep -nE 'innerHTML.*\$\{' dashboard/public/js/pages/agents.js | grep -vE 'escape\(' | head -10
# Expected: only literal-template strings or strings that DO call escape() inside the interpolation.
# Lines that interpolate dynamic data MUST wrap in escape().
```

The expected pattern: every `${...}` inside an `innerHTML` string is one of:
- A literal already-known constant (e.g. CSS class name from a fixed enum lookup)
- An already-escaped output (a function whose body invokes `escape()`)
- A direct call to `escape(...)`

Worker reviews the grep output and confirms each line matches one of these patterns. If any line interpolates raw data without an `escape()` wrapper or known-safe value, **HALT and ping glados**.

### B.10 — Cleanup

```bash
rm -f /tmp/E3-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 5 paths exactly (4 new + 1 modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED (no new dependencies)
- [ ] B.1 test suite: 12 new tests pass; total ≥ 137 (125 baseline + 12 agents-utils)
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/agents.html` imports `agents.js`; both `pages/agents.js` and `pages/agents-utils.js` load with `Content-Type: application/javascript`; manual browser smoke documented in DONE block
- [ ] B.5 diff-lock = 5 paths; pnpm-lock.yaml unchanged
- [ ] B.6 no PM2 verbs in diff
- [ ] B.7 no new CSS tokens
- [ ] B.8 no NAV_LINKS edits in shell.js
- [ ] B.9 no unescaped `innerHTML` interpolation
- [ ] **All CSS uses existing tokens** — no new `--*` definitions in dashboard.css
- [ ] **All dynamic strings HTML-escaped** before innerHTML — `escape()` helper used everywhere; log lines via `textContent`
- [ ] **Polling pauses on `visibilitychange` hidden** — both fast (1s) and slow (5s) timers stop; resume on visible
- [ ] **List mode**: table renders all declared agents with PM2 + activity pills; each row click-through to `?name=<n>`
- [ ] **Detail mode**: header pills, current activity card, PM2 stats card, logs (stdout + stderr), recent tasks (filtered by agent), recent runner events (last 20)
- [ ] **Restart button**: `window.confirm()` gate, disabled-during-request, success flash with `setTimeout` re-enable, error inline
- [ ] **404 path**: `/agents.html?name=__nonexistent__` shows "Agent not found" + back-link; polling stops
- [ ] **Twin-timer cadence**: fast tick = 1s (`/api/agents/:name`), slow tick = 5s (`/api/agents/:name/logs` + `/api/tasks`)
- [ ] **Log auto-scroll stickiness**: if user scrolled up, refresh does NOT yank back to bottom
- [ ] **No frontend unit tests added beyond pure helpers** — only `agents-utils.js` gets `node --test`. DOM render not jsdom-tested.
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.10 outputs verbatim, manual browser smoke description, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 5 paths (4 new + 1 modified)
Branch: feat/v1.5.0-E.3-agents-page

Pre-flight outputs:
  1. framework HEAD: <sha>  (includes 5ae35d8 + E.3 spec)
  2. E.1+E.2 surface present: ✓
  3. E.3 target paths absent: ✓
  4. endpoint sample (agent=<chosen>): <captured 4 envelopes + 404 path>
  5. test baseline: 125 passed
  6. tooling: node ≥22 ✓ pnpm ✓ curl ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - all 125 carry-over tests: passed
    - dashboard/test/agents-utils.test.js: 12 passed
    Total: 137 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - agents.html imports agents.js ✓
    - agents.js loads ✓
    - agents-utils.js loads ✓
  B.3.manual:
    - <description: list-mode table renders, click → detail, restart button works,
       logs visible, recent tasks filter renders, 404 path renders not-found>
  B.4.manual polling pause: <observed both timers stop on tab-hidden, resume on visible>
  B.5 diff-lock = 5 paths: ✓
  B.6 no PM2 verbs in diff: ✓
  B.7 no new CSS tokens: ✓
  B.8 no NAV_LINKS edits: ✓
  B.9 no unescaped innerHTML: ✓

Worker scope attestations:
  - dashboard/pnpm-lock.yaml UNCHANGED
  - No new --* CSS tokens added (all consume existing E.1+E.2 tokens)
  - All dynamic strings HTML-escaped before innerHTML
  - Log lines rendered via textContent (NOT innerHTML)
  - shell.js NAV_LINKS unchanged

DO NOT MERGE. Glados merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full Agents page (list + detail) including restart wiring, logs viewer, recent tasks, recent runner events, and pure-helper tests in single PR.
- **DO NOT MERGE** — glados merges.
- **DO NOT REDEFINE TOKENS** — `dashboard.css` additions consume existing `--status-*`, `--activity-*`, surface, text, and accent tokens. Any new token requires explicit spec amendment.
- **DO NOT ADD JSDOM/RTL** — locked from E.1+E.2. Pure-function helpers get `node --test`; DOM render is verified via live boot smoke.
- **DO NOT EXTEND DEPENDENCIES** — production stays at `express` + `dotenv`. Zero new dev deps.
- **DO NOT BREAK E.1+E.2 TESTS** — 125 baseline stays. E.3 adds 12 new tests; total 137.
- **DO NOT TOUCH OVERVIEW** — `js/pages/overview.js` and `overview-utils.js` are read-only inputs to the architecture; modifying them is out of scope.
- **DO NOT EDIT NAV_LINKS** — `shell.js` already includes `/agents.html` from E.1.
- **DO NOT IMPLEMENT DISCORD DEEP-LINK** — house-md's WBS bullet mentioned a Discord deep-link; that's a future leaf (no D.2 endpoint surface for it). Out of E.3 scope.
- **DO NOT ADD A SERVER-SIDE `?agent=` FILTER TO `/api/tasks`** — D.4 amendment, out of E.3 scope. Filter client-side from `?limit=200` for v1.
- **TWIN-TIMER CADENCE IS LOCKED** — fast = 1s for `/api/agents/:name`; slow = 5s for logs + tasks. Pause both on `visibilitychange` hidden.
- **`Promise.allSettled` not `Promise.all`** for the slow tick — one endpoint failure must not tank logs+tasks rendering.
- **HTML-ESCAPE EVERY DYNAMIC STRING** — `escape()` for innerHTML interpolation. `textContent` for log lines.
- **404 IS A TERMINAL STATE** — agent-not-found shows the message + back-link and STOPS polling. No retry.
- **RESTART CONFIRMATION IS REQUIRED** — `window.confirm()` gate before POSTing. Disabled-during-request. Success flash. Error inline.
- **MPA IS THE LOCK** — `agents.html` is a single static file; mode dispatched by `?name=` query parameter. NO hash routing. NO history.pushState. Click-through is hard navigation.
- **HALT-and-ping rule** — pre-flight surprises (E.1/E.2 surface missing, locked pill classes absent in dashboard.css, endpoint envelope keys differ from D.2/D.4 lock, target paths already exist) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings glados `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/`, `data/`, `docs/TASK.md`, `pnpm-lock.yaml`, `skills/`, `dashboard/node_modules/`.

---

## F. Forward links

- **E.4 Doctor** — `/doctor.html` reads `/api/doctor` (D.0a + D.3 envelope). Categories rendered with status badges. Manual "Refresh" button. Reuses pill rendering from E.2/E.3.
- **E.5 Updates** — `/updates.html` reads `/api/update/check` for the "Update Now" button gate (CONTRACT: hide/disable button when `update_available !== true` per owner directive). On click, calls `/api/update/apply` + opens EventSource on `/api/update/progress/:id`. Polling fallback `/api/update/status/:id` on EventSource error.
- **E.6 Backups** — `/backups.html` consumes `/api/backups`. List + size + age. No restore UI in v1.5.0.
- **E.7 Tasks** — `/tasks.html` is the full paginated tasks view. Active sessions surfaced prominently per owner directive. Reuses `taskStatusClass` + pill rendering from E.3.
- **Future leaf — Discord deep-link** — agent detail header could include a Discord channel link. Requires backend support to read `agents.local.yaml` channel mapping. Not E.3 scope.
- **Future leaf — server-side `?agent=` filter on `/api/tasks`** — if E.3's client-side filter shows stale "recent tasks" for high-volume agents (>200 historical tasks), promote to D.4 amendment.
- **Future leaf — pageworker pattern extraction** — by E.7, the polling + Promise.allSettled boilerplate has reproduced in 4-5 page modules. A cleanup leaf can extract `createPageController({ endpoints, render, intervalMs })` into `js/pages/page-controller.js`. Out of E.3 scope.
- **Future leaf — log streaming via SSE** — E.3 polls logs at 5s. A future enhancement could stream logs via SSE for live tail. Adds complexity (D.x amendment for an SSE endpoint); not justified for v1.5.0 MVP.
