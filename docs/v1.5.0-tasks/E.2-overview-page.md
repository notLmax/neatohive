# v1.5.0 E.2 — Overview Page (Status Banner + Agent List + Recent Events + Update Banner)

**Status:** LOCKED — house-md dispatches Bob via fresh-turn one-shot cron once spec lands.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** E — Dashboard frontend (7 PRs)
**Leaf:** E.2 (2 of 7 in Phase E — first real page)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** E.1 ✅ merged 2026-05-07 (squash `06da606`); D-followup auto-bootstrap-token ✅ merged (`1cc80dd`)
**Successors:** E.3 (Agent detail), E.4 (Doctor), E.5 (Updates), E.6 (Backups), E.7 (Tasks) — all build on E.1's shell + E.2's pattern

---

## Goal

Replace the E.1 placeholder content in `dashboard/public/index.html` with the real Overview render — a single page that gives the owner everything they need to see Hive health at a glance:

1. **Status banner** — top-of-page summary derived from `/api/status`. Green when all PM2 processes are online and no agents are errored, amber when warnings, red when failures.
2. **"Update available" banner** — only renders when `/api/update/check` returns `update_available === true`. Click-through to `/updates.html` (E.5). Silent on `false`. Subtle "couldn't check for updates" indicator on `null` (network/remote unreachable).
3. **Active sessions count** — prominent surface (owner directive: "active spinning sessions must be a primary surface"). Reads `/api/sessions/active`'s `total`. Click-through to `/tasks.html` (E.7).
4. **Agent list with status + activity pills** — table or card-grid of declared agents, each with a `pm2_status` pill (online/errored/stopped) and a `current_activity` pill (idle/turn/task) color-coded by the locked CSS tokens.
5. **Recent runner events subsection (last 10)** — `/api/status.recent_events` is the last 20; we slice 10 for the Overview to keep it tight. Shows event kind + agent + relative-time. Click-through to `/runner-events` (when E.x ships a dedicated page) or simply read-only for v1.
6. **Polls 5s** — every 5 seconds, refresh all four endpoints in parallel and re-render. Pause when tab is hidden (`document.visibilityState === 'hidden'`) — saves backend load and battery.

**MPA architecture (carried from E.1):** Overview lives at `/index.html`. Each page is its own HTML file with an inline `<script type="module">` that calls `requireToken()` + `renderShell()` + the page-specific render logic. NO SPA router. NO history-API push state. Each nav link is a hard navigation.

**Polling:** per-page interval, owned by the page's render module. `setInterval(refresh, 5000)`. On `visibilitychange` (page hidden), pause. On visibility return + immediate refresh + resume.

---

## Architectural givens (carried)

### Locked from E.1

- `dashboard/public/js/auth.js` — `requireToken()`, `getToken()`, `clearToken()`, `redirectToLogin()`
- `dashboard/public/js/api.js` — `apiFetch(path, opts)`, `apiJson(path, opts)`, `apiPing()` (auto-Bearer header + 401 → redirectToLogin)
- `dashboard/public/js/shell.js` — `renderShell({ activePage, title })` returns the `<main>` element for page-specific content; `setShellVersion(v)` updates the footer
- CSS tokens in `dashboard.css` (do NOT redefine — consume only):
  - Status: `--status-pass`, `--status-warn`, `--status-fail`, `--status-info`
  - Activity: `--activity-idle`, `--activity-turn`, `--activity-task`
  - Surfaces: `--surface`, `--surface-elevated`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-subtle`
- `index.html` is the Overview page (`activePage: '/'` matches the NAV_LINKS entry locked in `shell.js`)
- Static asset serving order in `dashboard/app.js`: `app.use(express.static(...))` BEFORE auth middleware (E.1's lock; static is public, API is gated)

### Module structure

E.2 introduces `dashboard/public/js/pages/` as the convention for page-specific logic. Each page module is an ES module exported from this directory. The inline `<script type="module">` in each page's HTML imports + invokes the page module.

E.2 ships:
- `dashboard/public/js/pages/overview.js` — DOM-rendering logic (impure: reads/writes DOM, manages polling timer, calls apiFetch)
- `dashboard/public/js/pages/overview-utils.js` — pure functions (status derivation, time formatting, event-row construction). Tested with `node --test`.

The split lets E.x leaves test the deterministic logic (status derivation, formatters) without jsdom while keeping the DOM-render logic strictly inline-tested via the live boot smoke.

### Endpoint usage

```js
const [statusRes, agentsRes, updateRes, sessionsRes] = await Promise.allSettled([
  apiJson('/api/status'),       // D.2 — agents.by_state + recent_events + pm2 totals
  apiJson('/api/agents'),       // D.2 — agents[].current_activity + pm2_status
  apiJson('/api/update/check'), // D.3 — three-state envelope (true|false|null)
  apiJson('/api/sessions/active'), // D.4 — total + sessions[]
]);
```

`Promise.allSettled` (NOT `.all`) so one endpoint failing (e.g. update check unreachable) doesn't tank the whole render. Each result is rendered independently with a per-section error placeholder if its promise rejected.

### Polling pattern

```js
const POLL_MS = 5000;
let pollHandle = null;

async function refresh() {
  // ... fetch + render ...
}

function startPolling() {
  refresh(); // immediate
  pollHandle = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopPolling();
  else if (!pollHandle) startPolling();
});

startPolling();
```

### Status banner derivation (locked)

From `/api/status`'s response:

```js
function deriveOverallStatus(status) {
  // status = parsed /api/status response
  if (!status) return { kind: 'fail', label: 'Cannot reach dashboard backend' };
  const pm2 = status.pm2 || {};
  const agents = status.agents || {};
  if (pm2.errored > 0) {
    return { kind: 'fail', label: `${pm2.errored} PM2 process${pm2.errored === 1 ? '' : 'es'} errored` };
  }
  if (pm2.online < pm2.total) {
    return { kind: 'warn', label: `${pm2.total - pm2.online} of ${pm2.total} PM2 processes not online` };
  }
  return { kind: 'pass', label: 'All systems nominal' };
}
```

**Three-tier:**
- `pass` (green via `--status-pass`) — pm2.online === pm2.total AND pm2.errored === 0
- `warn` (amber via `--status-warn`) — some PM2 processes not online but no errors
- `fail` (red via `--status-fail`) — any PM2 errored OR backend unreachable

### "Update available" banner gating (owner directive lock)

Three-state from `/api/update/check`:
- `update_available === true` → render banner with link to `/updates.html`. Show `local_version → remote_version`.
- `update_available === false` → silent. No banner.
- `update_available === null` → render a SUBTLE "Couldn't check for updates" indicator (small text, not a banner). Distinct from `false` so the user knows the check failed rather than that they're already current.

```js
function deriveUpdateBanner(check) {
  if (!check) return { kind: 'silent' };
  if (check.update_available === true) {
    return {
      kind: 'available',
      from: check.local_version,
      to: check.remote_version,
    };
  }
  if (check.update_available === null) {
    return { kind: 'check_failed', error: check.error || 'unknown' };
  }
  return { kind: 'silent' };
}
```

### Active sessions surface (owner directive lock)

From `/api/sessions/active.total`. Render as a card with:
- Big number (the total)
- Label "Active session(s)"
- If total > 0 → click-through link "View all" → `/tasks.html`
- If total === 0 → muted state, no link

### Agent list

From `/api/agents.agents[]`. For each agent:
- Name (`agent.name`) — bold
- PM2 status pill — `agent.pm2_status` value mapped to `--status-*` token via classname (`.pill-status-online`, `.pill-status-errored`, `.pill-status-stopped`, `.pill-status-not_running`)
- Activity pill — `agent.current_activity.state` value (idle/turn/task) mapped to `--activity-*` token via classname (`.pill-activity-idle`, `.pill-activity-turn`, `.pill-activity-task`)
- If `current_activity.task_id`, show as muted secondary text under the activity pill (truncated to first 24 chars + ellipsis)
- Last event ts → relative time ("2m ago"). Lock the formatter in `overview-utils.js`.
- Click-through → `/agents.html` (E.3) — for v1 just link to the agents listing page; deep-link to `/agents/<name>.html` is E.3's job.

### Recent runner events subsection

From `/api/status.recent_events.slice(0, 10)`. For each event:
- Time (relative)
- Event kind (e.g. `wake_turn_started`, `discovered`)
- Agent name (if present)
- Truncated `taskId` (first 12 chars + ellipsis)

Plain rows, monospace-style for the event kind to make the column scannable.

---

## Pre-conditions

- E.1 ✅ merged at `06da606` — `dashboard/public/`, `js/auth.js`, `js/api.js`, `js/shell.js`, `css/dashboard.css` all present
- D.2 + D.3 + D.4 endpoints all live: `/api/status`, `/api/agents`, `/api/update/check`, `/api/sessions/active` (carry-over from D.x merges)
- D-followup `1cc80dd` merged (cmd_bootstrap auto-ensures token) — owner's local install has a token for live boot smoke
- Node ≥ 22 (carried)

---

## Where state lives (E.2 conventions)

**New files (4):**
- `dashboard/public/js/pages/overview.js` — page render module + polling
- `dashboard/public/js/pages/overview-utils.js` — pure-function helpers (status derivation, banner gating, formatters)
- `dashboard/test/overview-utils.test.js` — `node --test` for the pure helpers
- `dashboard/public/js/pages/` — new directory; the convention root for E.3-E.7 pages

**Modified files (2):**
- `dashboard/public/index.html` — replace E.1's placeholder body with import-and-invoke of `overview.js`
- `dashboard/public/css/dashboard.css` — add Overview-specific styles (status banner, update banner, agent pills, recent-events table). Tokens-only — no new tokens defined.

**Total: 6 paths.**

**No backend changes.** All endpoints already shipped. No new prod deps. No new dev deps.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `06da606` (E.1) + `1cc80dd` (D-followup) + E.2-spec commit.

### 2. E.1 surface present

```bash
test -f dashboard/public/index.html && echo "index.html ✓"
test -f dashboard/public/login.html && echo "login.html ✓"
test -f dashboard/public/js/auth.js && echo "auth.js ✓"
test -f dashboard/public/js/api.js && echo "api.js ✓"
test -f dashboard/public/js/shell.js && echo "shell.js ✓"
test -f dashboard/public/css/dashboard.css && echo "dashboard.css ✓"
grep -E '^\s*--status-pass|^\s*--activity-idle' dashboard/public/css/dashboard.css | head -2
```

**HALT and ping house-md** if any E.1 surface is missing OR locked tokens are absent.

### 3. E.2 target paths absent

```bash
test ! -d dashboard/public/js/pages && echo "pages/ absent ✓"
test ! -f dashboard/public/js/pages/overview.js && echo "overview.js absent ✓"
test ! -f dashboard/public/js/pages/overview-utils.js && echo "overview-utils.js absent ✓"
test ! -f dashboard/test/overview-utils.test.js && echo "overview-utils.test.js absent ✓"
```

**HALT and ping house-md** if any exist.

### 4. Endpoint sample (live boot to confirm shapes match expectations)

```bash
TOKEN=$(printf 'a%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57776 \
  node dashboard/index.js > /tmp/E2-pre4.out 2>&1 &
PID=$!
sleep 2

# Sample the 4 envelopes worker will consume
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/status | jq -c '{version, has_recent_events: (.recent_events | type), agents_by_state_keys: (.agents.by_state | keys | sort), pm2_keys: (.pm2 | keys | sort)}'
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/agents | jq -c '{version, total: (.agents | length), first_keys: (.agents[0] | keys | sort // []), first_activity: (.agents[0].current_activity // null)}'
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/update/check | jq -c '{update_available, update_available_type: (.update_available | type)}'
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/sessions/active | jq -c '{version, total, has_sessions: (.sessions | type)}'

kill $PID
```

Expected: all 4 endpoints respond 200 with envelopes matching the documented shapes. **HALT and ping house-md** if any envelope's keys differ from the lock.

### 5. Existing test suite baseline

```bash
cd dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tail -5
```

Expected: 115 tests pass (109 D.x + 6 E.1 spa). Worker captures the count. Post-E.2 must still be 115 pass + new overview-utils tests.

### 6. Tooling

```bash
node --version && pnpm --version && which curl && which jq
```

Expected: Node ≥ 22.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-E.2-overview-page`.

**Diff lock: 6 paths exactly** (4 new + 2 modified).

### A.1 — `dashboard/public/js/pages/overview-utils.js`

Pure functions only. No DOM, no I/O. Each function is independently testable.

```javascript
'use strict';

// Derive overall system status from /api/status response
export function deriveOverallStatus(status) {
  if (!status) return { kind: 'fail', label: 'Cannot reach dashboard backend' };
  const pm2 = status.pm2 || {};
  if (pm2.errored && pm2.errored > 0) {
    return { kind: 'fail', label: `${pm2.errored} PM2 process${pm2.errored === 1 ? '' : 'es'} errored` };
  }
  if (typeof pm2.online === 'number' && typeof pm2.total === 'number' && pm2.online < pm2.total) {
    return { kind: 'warn', label: `${pm2.total - pm2.online} of ${pm2.total} PM2 processes not online` };
  }
  return { kind: 'pass', label: 'All systems nominal' };
}

// Derive update banner state from /api/update/check response
export function deriveUpdateBanner(check) {
  if (!check) return { kind: 'silent' };
  if (check.update_available === true) {
    return {
      kind: 'available',
      from: check.local_version || 'unknown',
      to: check.remote_version || 'unknown',
    };
  }
  if (check.update_available === null) {
    return {
      kind: 'check_failed',
      error: typeof check.error === 'string' ? check.error : 'unknown',
    };
  }
  return { kind: 'silent' };
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

// Truncate a string in the middle (for taskId display)
export function truncate(s, len = 12) {
  if (typeof s !== 'string' || s.length <= len) return s || '';
  return s.slice(0, len) + '…';
}

// Map a pm2_status value to a CSS class suffix (online, errored, stopped, not_running)
export function pm2StatusClass(s) {
  const v = typeof s === 'string' ? s.toLowerCase() : 'unknown';
  if (v === 'online') return 'online';
  if (v === 'errored') return 'errored';
  if (v === 'stopped') return 'stopped';
  if (v === 'not_running') return 'not_running';
  return 'unknown';
}

// Map a current_activity.state to a CSS class suffix (idle, turn, task)
export function activityClass(state) {
  if (state === 'idle' || state === 'turn' || state === 'task') return state;
  return 'idle';  // default — defensive against unexpected enum values
}
```

### A.2 — `dashboard/public/js/pages/overview.js`

DOM render + polling. Imports utils from A.1, apiJson from `js/api.js`, shell helpers from `js/shell.js`.

```javascript
'use strict';

import { apiJson } from '/js/api.js';
import {
  deriveOverallStatus,
  deriveUpdateBanner,
  relativeTime,
  truncate,
  pm2StatusClass,
  activityClass,
} from '/js/pages/overview-utils.js';

const POLL_MS = 5000;

export function renderOverview(main) {
  // Build static layout once
  main.innerHTML = `
    <div class="overview-status" id="overview-status"></div>
    <div class="overview-update" id="overview-update"></div>
    <div class="overview-grid">
      <section class="overview-card overview-sessions" id="overview-sessions"></section>
      <section class="overview-card overview-agents">
        <h2>Agents</h2>
        <div id="overview-agents-list" class="agents-list"></div>
      </section>
      <section class="overview-card overview-events">
        <h2>Recent runner events</h2>
        <ul id="overview-events-list" class="events-list"></ul>
      </section>
    </div>
  `;

  let pollHandle = null;
  let inFlight = false;

  async function refresh() {
    if (inFlight) return;  // de-dupe overlapping refreshes
    inFlight = true;
    try {
      const [statusR, agentsR, updateR, sessionsR] = await Promise.allSettled([
        apiJson('/api/status'),
        apiJson('/api/agents'),
        apiJson('/api/update/check'),
        apiJson('/api/sessions/active'),
      ]);

      renderStatusBanner(statusR.status === 'fulfilled' ? statusR.value : null);
      renderUpdateBanner(updateR.status === 'fulfilled' ? updateR.value : null);
      renderSessions(sessionsR.status === 'fulfilled' ? sessionsR.value : null);
      renderAgents(agentsR.status === 'fulfilled' ? agentsR.value : null);
      renderRecentEvents(statusR.status === 'fulfilled' ? statusR.value : null);
    } finally {
      inFlight = false;
    }
  }

  function renderStatusBanner(status) {
    const overall = deriveOverallStatus(status);
    const el = document.getElementById('overview-status');
    el.className = `overview-status banner-${overall.kind}`;
    el.textContent = overall.label;
  }

  function renderUpdateBanner(check) {
    const update = deriveUpdateBanner(check);
    const el = document.getElementById('overview-update');
    el.innerHTML = '';
    if (update.kind === 'available') {
      el.className = 'overview-update banner-update-available';
      el.innerHTML = `Update available: <strong>${escape(update.from)} → ${escape(update.to)}</strong> · <a href="/updates.html">Review</a>`;
    } else if (update.kind === 'check_failed') {
      el.className = 'overview-update update-check-failed';
      el.textContent = 'Couldn’t check for updates';
    } else {
      el.className = 'overview-update';
      // silent — no content
    }
  }

  function renderSessions(sessions) {
    const total = sessions && typeof sessions.total === 'number' ? sessions.total : null;
    const el = document.getElementById('overview-sessions');
    if (total === null) {
      el.innerHTML = `<p class="muted">Active sessions unavailable</p>`;
      return;
    }
    if (total === 0) {
      el.innerHTML = `<div class="sessions-count muted">0</div><div class="sessions-label muted">Active sessions</div>`;
      return;
    }
    el.innerHTML = `
      <div class="sessions-count">${total}</div>
      <div class="sessions-label">Active session${total === 1 ? '' : 's'}</div>
      <a class="sessions-link" href="/tasks.html">View all →</a>
    `;
  }

  function renderAgents(agents) {
    const list = document.getElementById('overview-agents-list');
    if (!agents || !Array.isArray(agents.agents)) {
      list.innerHTML = `<p class="muted">Agent list unavailable</p>`;
      return;
    }
    if (agents.agents.length === 0) {
      list.innerHTML = `<p class="muted">No agents declared</p>`;
      return;
    }
    list.innerHTML = agents.agents.map((a) => {
      const pm2Cls = pm2StatusClass(a.pm2_status);
      const act = a.current_activity || { state: 'idle', task_id: null, since: null };
      const actCls = activityClass(act.state);
      const taskHint = act.task_id ? `<div class="agent-taskid">${escape(truncate(act.task_id, 24))}</div>` : '';
      const lastEvt = a.last_event_ts ? `<div class="agent-last-event">${escape(a.last_event || '')} · ${escape(relativeTime(a.last_event_ts))}</div>` : '';
      return `
        <div class="agent-row">
          <div class="agent-name">${escape(a.name)}</div>
          <div class="agent-pills">
            <span class="pill pill-status-${pm2Cls}">${escape(a.pm2_status || 'unknown')}</span>
            <span class="pill pill-activity-${actCls}">${escape(act.state)}</span>
          </div>
          ${taskHint}
          ${lastEvt}
        </div>
      `;
    }).join('');
  }

  function renderRecentEvents(status) {
    const list = document.getElementById('overview-events-list');
    if (!status || !Array.isArray(status.recent_events)) {
      list.innerHTML = `<li class="muted">Recent events unavailable</li>`;
      return;
    }
    const events = status.recent_events.slice(0, 10);
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

  function startPolling() {
    refresh();
    pollHandle = setInterval(refresh, POLL_MS);
  }
  function stopPolling() {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPolling();
    else if (!pollHandle) startPolling();
  });

  startPolling();
}

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
```

**Locked semantics:**
- One `inFlight` flag — overlapping refreshes are de-duped (if the previous tick is still pending when 5s elapses, skip the new refresh).
- `Promise.allSettled` — one endpoint failing doesn't tank the page.
- Per-section graceful-degradation — each render function handles `null` (the endpoint failed) with a "unavailable" muted state.
- `escape()` is defensive — every dynamic string is HTML-escaped before injection. No `innerHTML` of unescaped data.
- `visibilitychange` pauses polling when tab hidden.

### A.3 — `dashboard/public/index.html` modification

Replace the E.1 placeholder body with import + invocation of `overview.js`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Overview - Hive Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body>
  <script type="module">
    import { requireToken } from '/js/auth.js';
    import { apiFetch, apiPing } from '/js/api.js';
    import { renderShell, setShellVersion } from '/js/shell.js';
    import { renderOverview } from '/js/pages/overview.js';

    if (!requireToken()) {
      // Redirected to login.
    } else {
      const isAuthorized = await apiPing();
      if (isAuthorized) {
        const main = renderShell({ activePage: '/', title: 'Overview' });
        renderOverview(main);

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

Diff is minimal — three lines change in the inline script: add `import { renderOverview } from ...`, replace the placeholder `main.innerHTML = ...` block with `renderOverview(main)`. `setShellVersion` wiring stays identical to E.1.

### A.4 — `dashboard/public/css/dashboard.css` additions

Append (do NOT redefine existing tokens). All styles use existing `--status-*` and `--activity-*` tokens.

```css
/* ---- Overview page ---- */

.overview-status {
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 12px;
  font-weight: 500;
  color: white;
}
.overview-status.banner-pass { background: var(--status-pass); }
.overview-status.banner-warn { background: var(--status-warn); }
.overview-status.banner-fail { background: var(--status-fail); }

.overview-update {
  /* default: silent — no padding, no content */
}
.overview-update.banner-update-available {
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  background: var(--accent-subtle);
  border: 1px solid var(--accent);
  color: var(--text-primary);
}
.overview-update.banner-update-available a {
  color: var(--text-primary);
  font-weight: 600;
}
.overview-update.update-check-failed {
  padding: 6px 10px;
  margin-bottom: 12px;
  font-size: 0.85em;
  color: var(--text-muted);
}

.overview-grid {
  display: grid;
  grid-template-columns: 1fr 2fr;
  grid-template-areas:
    "sessions agents"
    "events events";
  gap: 16px;
}
.overview-sessions { grid-area: sessions; }
.overview-agents { grid-area: agents; }
.overview-events { grid-area: events; }

.overview-card {
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.overview-card h2 {
  margin: 0 0 12px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.sessions-count {
  font-size: 2.5rem;
  font-weight: 700;
  line-height: 1;
  color: var(--text-primary);
}
.sessions-count.muted { color: var(--text-muted); }
.sessions-label {
  margin-top: 4px;
  font-size: 0.9em;
  color: var(--text-secondary);
}
.sessions-link {
  display: inline-block;
  margin-top: 8px;
  color: var(--text-primary);
  font-weight: 500;
  text-decoration: none;
}
.sessions-link:hover { text-decoration: underline; }

.agents-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: "name pills" "task task" "evt evt";
  row-gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.agent-name { grid-area: name; font-weight: 500; }
.agent-pills { grid-area: pills; display: flex; gap: 4px; }
.agent-taskid { grid-area: task; font-size: 0.8em; color: var(--text-muted); font-family: 'SF Mono', Menlo, monospace; }
.agent-last-event { grid-area: evt; font-size: 0.8em; color: var(--text-muted); }

.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75em;
  font-weight: 600;
  color: white;
  text-transform: lowercase;
}
.pill-status-online { background: var(--status-pass); }
.pill-status-errored { background: var(--status-fail); }
.pill-status-stopped { background: var(--text-muted); }
.pill-status-not_running { background: var(--text-muted); }
.pill-status-unknown { background: var(--text-muted); }

.pill-activity-idle { background: var(--activity-idle); }
.pill-activity-turn { background: var(--activity-turn); }
.pill-activity-task { background: var(--activity-task); }

.events-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.event-row {
  display: grid;
  grid-template-columns: 80px 220px 120px 1fr;
  gap: 8px;
  padding: 4px 0;
  font-size: 0.85em;
  border-bottom: 1px solid var(--border);
}
.event-time { color: var(--text-muted); }
.event-kind { font-family: 'SF Mono', Menlo, monospace; color: var(--text-primary); }
.event-agent { color: var(--text-secondary); }
.event-taskid { color: var(--text-muted); font-family: 'SF Mono', Menlo, monospace; }

.muted { color: var(--text-muted); }

@media (max-width: 720px) {
  .overview-grid {
    grid-template-columns: 1fr;
    grid-template-areas: "sessions" "agents" "events";
  }
  .event-row { grid-template-columns: 60px 1fr; }
  .event-row .event-agent, .event-row .event-taskid { display: none; }
}
```

**Locked:**
- All colors via existing tokens — no new hex values introduced.
- Mobile responsive: grid collapses to single column under 720px.
- Pill colors directly map status / activity to the locked tokens.
- No external font load; existing system stack (carried from E.1).

### A.5 — `dashboard/test/overview-utils.test.js`

`node --test` for the pure helpers in `overview-utils.js`. Locked test cases (10):

1. `deriveOverallStatus(null)` → `{ kind: 'fail', label: contains 'Cannot reach' }`
2. `deriveOverallStatus({ pm2: { errored: 2, online: 3, total: 5 } })` → `{ kind: 'fail', label: '2 PM2 processes errored' }`
3. `deriveOverallStatus({ pm2: { online: 2, total: 3, errored: 0 } })` → `{ kind: 'warn', label: '1 of 3 PM2 processes not online' }`
4. `deriveOverallStatus({ pm2: { online: 5, total: 5, errored: 0 } })` → `{ kind: 'pass', label: 'All systems nominal' }`
5. `deriveUpdateBanner({ update_available: true, local_version: '1.5.0', remote_version: '1.5.1' })` → `{ kind: 'available', from: '1.5.0', to: '1.5.1' }`
6. `deriveUpdateBanner({ update_available: false })` → `{ kind: 'silent' }`
7. `deriveUpdateBanner({ update_available: null, error: 'unreachable' })` → `{ kind: 'check_failed', error: 'unreachable' }`
8. `relativeTime` — values for now (just now), 30s ago, 5m ago, 3h ago, 2d ago
9. `truncate('long-string-value', 5)` → `'long-…'`; `truncate('short', 12)` → `'short'`
10. `pm2StatusClass('online')` → `'online'`; `pm2StatusClass('UNKNOWN_VAL')` → `'unknown'`; `activityClass('weird')` → `'idle'` (defensive default)

The test file imports the ESM helpers via Node's `import` (Node 22+ ESM-from-CJS works via `import()` dynamic, but since it's `node --test` with ESM, just use top-level imports if `package.json` has `"type": "module"`. Check the `dashboard/package.json` `"type"` field — it's likely `"commonjs"` per D.1. If so, the test file should be `.mjs` extension OR use dynamic `import()`).

Worker reads `dashboard/package.json` to confirm the `type` field and uses the appropriate import syntax.

---

## B. Tests + verification

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E2-test.out
# Expected: 115 (E.1 baseline) + 10 (overview-utils) = 125 tests passing
grep -E '✔|pass' /tmp/E2-test.out | wc -l
```

### B.2 — Lockfile + dep audit

```bash
cd ~/neato-hive/dashboard
pnpm install --frozen-lockfile
pnpm list --depth=0 --prod
# Expected: express + dotenv only — E.2 adds NO new prod deps
```

### B.3 — Live boot smoke (manual browser verification)

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57777 \
  node dashboard/index.js > /tmp/E2-boot.out 2>&1 &
PID=$!
sleep 2

# / serves shell + overview imports overview.js
curl -fsS http://127.0.0.1:57777/ | grep -q 'pages/overview.js' && echo "B.3.a: index.html imports overview.js ✓"
curl -fsS http://127.0.0.1:57777/js/pages/overview.js | head -3 | grep -q "use strict" && echo "B.3.b: overview.js loads ✓"
curl -fsS http://127.0.0.1:57777/js/pages/overview-utils.js | head -3 | grep -q "use strict" && echo "B.3.c: overview-utils.js loads ✓"

# Manual smoke: open http://127.0.0.1:57777/ in a browser → token entry → paste → Overview renders
echo "B.3.manual: open http://127.0.0.1:57777/ in browser; paste $TOKEN; verify"
echo "  - Status banner renders (pass/warn/fail)"
echo "  - Active sessions count visible"
echo "  - Agent list shows pills (status + activity, colored)"
echo "  - Recent events list shows last 10 events"
echo "  - 'Update available' banner ONLY if update_available === true"

kill $PID
```

### B.4 — Polling pause on tab-hidden (manual smoke)

```bash
echo "B.4.manual: open browser, watch network tab, hide tab → no fetches, restore tab → resumes"
```

### B.5 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-E.2-overview-page
# Expected: exactly 6 lines (4 new + 2 modified)
git diff main...feat/v1.5.0-E.2-overview-page -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.6 — No PM2 verbs, no live update, no destructive ops

```bash
git diff main...feat/v1.5.0-E.2-overview-page | grep -E '^\+.*pm2 (start|restart|reload|delete|save|stop|kill)' | head -5
# Expected: empty
```

### B.7 — Cleanup

```bash
rm -f /tmp/E2-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 6 paths exactly (4 new + 2 modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED (no new dependencies)
- [ ] B.1 test suite: 10 new tests pass; total ≥ 125 (115 E.1 baseline + 10 overview-utils)
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/` imports `overview.js`; `js/pages/overview.js` and `js/pages/overview-utils.js` both load with `Content-Type: application/javascript`; manual browser smoke documented in DONE block
- [ ] B.5 diff-lock = 6 paths; pnpm-lock.yaml unchanged
- [ ] B.6 no PM2 verbs in diff
- [ ] **All CSS uses existing tokens** — no new `--*` definitions in dashboard.css
- [ ] **All dynamic strings HTML-escaped** before innerHTML — `escape()` helper used everywhere
- [ ] **Polling pauses on `visibilitychange` hidden** — code path present + manual smoke confirms
- [ ] **Update banner gating** — present only when `update_available === true`; subtle "couldn't check" indicator on `null`; silent on `false`
- [ ] **No frontend unit tests added** — only the pure-function helpers in `overview-utils` get `node --test` coverage. DOM render not jsdom-tested.
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.6 outputs verbatim, manual browser smoke description, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 6 paths (4 new + 2 modified)
Branch: feat/v1.5.0-E.2-overview-page

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. E.1 surface present: ✓
  3. E.2 target paths absent: ✓
  4. endpoint sample: <captured 4 envelopes>
  5. test baseline: 115 passed
  6. tooling: node ≥22 ✓ pnpm ✓ curl ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - all 115 E.1 carry-over tests: passed
    - dashboard/test/overview-utils.test.js: 10 passed
    Total: 125 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - index.html imports overview.js ✓
    - overview.js loads ✓
    - overview-utils.js loads ✓
  B.3.manual:
    - <description: pasted token, saw status banner=pass, agent list w/ pills,
       recent events list with 10 entries, no update banner since up-to-date>
  B.4.manual polling pause: <observed in browser network tab>
  B.5 diff-lock = 6 paths: ✓
  B.6 no PM2 verbs: ✓

Worker scope attestations:
  - dashboard/pnpm-lock.yaml UNCHANGED
  - No new --* CSS tokens added (all consume existing E.1 tokens)
  - All dynamic strings HTML-escaped before innerHTML

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full Overview render (status banner + update banner + active sessions + agent list + recent events + polling) in single PR.
- **DO NOT MERGE** — house-md
- **DO NOT REDEFINE TOKENS** — `dashboard.css` additions consume the existing `--status-*` and `--activity-*` tokens. Any new token requires explicit spec amendment.
- **DO NOT ADD JSDOM/RTL** — locked from E.1. Pure-function helpers get `node --test`; DOM render is verified via live boot smoke.
- **DO NOT EXTEND DEPENDENCIES** — production stays at `express` + `dotenv`. Zero new dev deps.
- **DO NOT BREAK E.1 TESTS** — 115 baseline stays. E.2 adds 10 new tests; total 125.
- **POLLING IS LOCKED AT 5s** — `POLL_MS = 5000`. Pause on `visibilitychange` hidden. Resume on visible.
- **`Promise.allSettled` not `Promise.all`** — one endpoint failure must not tank the page.
- **HTML-ESCAPE EVERY DYNAMIC STRING** — `escape()` helper applied to every `innerHTML` interpolation. Defense against any backend response containing user-controlled text.
- **UPDATE BANNER IS THREE-STATE** — `true` (banner) / `null` (subtle "couldn't check") / `false` (silent). Never collapse.
- **MPA IS THE LOCK** — index.html is the Overview page. NO hash routing. NO history.pushState. Each nav link is a hard navigation.
- **HALT-and-ping rule** — pre-flight surprises (E.1 surface missing, endpoint envelope keys differ from D.x lock, locked tokens absent in dashboard.css) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/`, `data/`, `docs/TASK.md`, `pnpm-lock.yaml`, `skills/`, `dashboard/node_modules/`.

---

## F. Forward links

- **E.3 Agent detail** — `/agents.html` lists agents (basic table from `/api/agents`); `/agents/<name>.html` is the deep-link detail with logs tail, restart button, current_activity live-tail (1s polling). Reuses E.2's pill rendering helpers.
- **E.4 Doctor** — `/doctor.html` — reads `/api/doctor` (D.0a-locked envelope). Renders by category. Manual "Refresh" button.
- **E.5 Updates** — `/updates.html` — reads `/api/update/check` for the "Update Now" button gate (CONTRACT: hide/disable button when `update_available !== true`). On click, calls `/api/update/apply` + opens EventSource on `/api/update/progress/:id`. Polling fallback `/api/update/status/:id` on EventSource error. Renders C.6's locked phase vocabulary as a step-by-step progress bar; renders C.7's migration-* events as a "Post-update setup" subsection.
- **E.6 Backups** — `/backups.html` — `/api/backups` listing. Rollback CTA links to CLI snippet.
- **E.7 Tasks** — `/tasks.html` — Decision E row schema (`{taskId, agent, kind, cmd_excerpt, started_at, elapsed_ms, status, last_runner_event}`). Sort by elapsed desc. Auto-refresh 5s. Cancel button calls `hive task cancel <id>` (CLI link-out — in-app cancel POST is a future leaf).
- **Future leaf — pageworker pattern extraction:** if E.3-E.7 reproduce a lot of E.2's polling + Promise.allSettled boilerplate, a future cleanup leaf could extract a `createPageController({ endpoints, render, intervalMs })` helper into `js/pages/page-controller.js`. Out of E.2 scope.
- **Future leaf — runner events deep-link** — Overview's recent events currently has no click-through. A future leaf can add `/runner-events.html` (paginated raw events from `/api/runner-events`), and the recent-events rows become click-throughs.
