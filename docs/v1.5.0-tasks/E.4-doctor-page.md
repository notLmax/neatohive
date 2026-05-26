# v1.5.0 E.4 — Doctor Page

**Status:** LOCKED — glados dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** E — Dashboard frontend (7 PRs)
**Leaf:** E.4 (4 of 7 in Phase E)
**Author:** glados
**Reviewer/dispatcher:** glados (per 2026-05-08 owner-authorized handoff from house-md)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** E.1 ✅ `06da606`; E.2 ✅ `5ae35d8`; E.3 ✅ `f002003`
**Successors:** E.5 (Updates) — owner-gated "Update Now" button; E.6 (Backups); E.7 (Tasks)

---

## Goal

Render `GET /api/doctor` (D.3 envelope, pass-through of `hive doctor --json` per D.0a lock) as a categorized health report:

1. **Summary banner** — top of page. Shows `summary.total / pass / warn / fail / skip` counts plus an overall status pill derived from `summary.exit_code` (0 → pass, ≥ 1 → warn or fail depending on counts).
2. **Top-level checks grouped by category** — core, deps, auth, build, config, strategic (per D.0a's locked category enum). Each category renders as a card with its rows of `{label, status pill, detail, fix_hint}`. Failed/warned checks are visually emphasized; passing checks are dimmed (still visible but de-prioritized).
3. **Per-agent checks section** — each agent that ships in the `agents[]` array gets its own card with their nested `checks[]` list. Agent name links to `/agents.html?name=<n>` (E.3 deep link) so failed agent checks are one click from the detail page that can act on them.
4. **Manual Refresh button** + slow background polling (30s). Backend caches at 5s TTL (D.3 lock), so manual Refresh during background-poll quiet is cheap. Pause on `visibilitychange` hidden.

**MPA carry-over:** `/doctor.html` lives at `dashboard/public/doctor.html`. Single static file, inline `<script type="module">` boots `requireToken()` + `renderShell({ activePage: '/doctor.html', title: 'Doctor' })` + `renderDoctor(main)`. NAV_LINKS already includes `/doctor.html` from E.1 — DO NOT edit `shell.js`.

**Polling cadence:** ONE timer at 30s (doctor checks change rarely; faster cadence wastes cycles + the 5s backend cache means concurrent dashboard tabs already see the same envelope). Manual Refresh button forces an immediate fetch, bypasses the in-flight de-dupe via a "force" flag (still respects the inFlight latch — one fetch at a time).

---

## Architectural givens (carried)

### Locked from E.1 + E.2 + E.3

- `dashboard/public/js/auth.js` — `requireToken()`, `getToken()`, `clearToken()`, `redirectToLogin()`
- `dashboard/public/js/api.js` — `apiFetch(path, opts)`, `apiJson(path, opts)`, `apiPing()`
- `dashboard/public/js/shell.js` — `renderShell({ activePage, title })`, `setShellVersion(v)`, NAV_LINKS includes `/doctor.html`
- `dashboard/public/js/pages/overview.js` + `overview-utils.js` (E.2) and `agents.js` + `agents-utils.js` (E.3) — DO NOT modify; E.4 ships its OWN page modules
- CSS tokens (consume only — DO NOT redefine):
  - Status: `--status-pass`, `--status-warn`, `--status-fail`, `--status-info`
  - Surfaces: `--surface`, `--surface-elevated`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-subtle`
- Pill class convention: `.pill` base class is reused; new `.pill-doctor-*` classes map to existing `--status-*` tokens (same pattern E.3 used for `.pill-task-*`)
- Static asset serving order (E.1 lock) — no change

### Module structure

E.4 ships into the existing `dashboard/public/js/pages/` directory:

- `dashboard/public/js/pages/doctor.js` — DOM-rendering + polling (impure: DOM, fetch, timer)
- `dashboard/public/js/pages/doctor-utils.js` — pure functions (status derivation, category grouping, formatters)

The split mirrors E.2/E.3 — pure logic gets `node --test` coverage, DOM render is verified via live boot smoke.

### Endpoint usage

```js
const r = await apiJson('/api/doctor');
```

Single endpoint per fetch tick. D.3 envelope shape (locked):

```json
{
  "version": "1",
  "ts": "...",
  "summary": { "total": 23, "pass": 20, "warn": 1, "fail": 2, "skip": 0, "exit_code": 1 },
  "checks": [
    { "id": "hive-version", "label": "Hive version", "category": "core", "status": "pass", "detail": "v1.5.0", "fix_hint": null }
  ],
  "agents": [
    {
      "name": "atlas",
      "status": "pass",
      "checks": [
        { "id": "bot-token", "label": "Bot token (DISCORD_BOT_TOKEN_ATLAS)", "category": "agent", "status": "pass", "detail": null, "fix_hint": null }
      ]
    }
  ]
}
```

D.3 may also surface error envelopes (e.g. `{ error: "doctor_spawn_failed", detail: "..." }`) when the backend can't run `hive doctor --json`. E.4 detects these via the absence of `version`/`summary` keys and renders an inline error banner without crashing the page.

### Status enum (locked from D.0a)

```
status: pass | warn | fail | skip
```

Mapped to CSS class via `doctorStatusClass(s)`:

| Status | CSS suffix | Token mapping |
|--------|------------|---------------|
| `pass` | `pass` | `--status-pass` |
| `warn` | `warn` | `--status-warn` |
| `fail` | `fail` | `--status-fail` |
| `skip` | `skip` | `--text-muted` |
| (other) | `unknown` | `--text-muted` |

### Category enum (locked from D.0a)

```
category: core | deps | auth | build | config | agent | strategic
```

`agent` is excluded from the top-level grouping (those checks belong to the per-agent card section). The remaining six render as top-level category cards in a fixed order.

`doctorCategoryLabel(category)` provides friendly labels:

| Category | Label |
|----------|-------|
| `core` | "Core" |
| `deps` | "Dependencies" |
| `auth` | "Authentication" |
| `build` | "Build" |
| `config` | "Configuration" |
| `strategic` | "Strategic" |
| (other) | the value verbatim |

Forward-flex: a future leaf adding a new category enum value gets the verbatim fallback rendering until `doctorCategoryLabel` is updated. No crash.

### Summary banner derivation (locked)

```js
function summarizeStatus(summary) {
  if (!summary) return { kind: 'fail', label: 'Doctor envelope unavailable' };
  const fail = Number(summary.fail) || 0;
  const warn = Number(summary.warn) || 0;
  const total = Number(summary.total) || 0;
  const pass = Number(summary.pass) || 0;
  if (fail > 0) {
    return { kind: 'fail', label: `${fail} failing check${fail === 1 ? '' : 's'}` };
  }
  if (warn > 0) {
    return { kind: 'warn', label: `${warn} warning${warn === 1 ? '' : 's'}` };
  }
  if (total > 0 && pass === total) {
    return { kind: 'pass', label: 'All checks passing' };
  }
  return { kind: 'pass', label: 'All checks passing' };
}
```

**Three-tier:**
- `fail` (red via `--status-fail`) — any `summary.fail > 0`
- `warn` (amber via `--status-warn`) — `fail === 0` AND `warn > 0`
- `pass` (green via `--status-pass`) — `fail === 0` AND `warn === 0`

`exit_code` is informational (worker may surface in PR body smoke notes); the visual derivation runs from `fail`/`warn` counts since they're the human-meaningful surface.

### Polling pattern

```js
const POLL_MS = 30000;
let pollHandle = null;
let inFlight = false;

async function refresh(force = false) {
  if (inFlight && !force) return;
  inFlight = true;
  try { /* fetch /api/doctor + render */ }
  finally { inFlight = false; }
}

function startPolling() {
  refresh();
  pollHandle = setInterval(refresh, POLL_MS);
}
function stopPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopPolling();
  else if (!pollHandle) startPolling();
});

document.getElementById('doctor-refresh-btn').addEventListener('click', () => refresh(true));

startPolling();
```

`force=true` from the manual button does NOT skip the inFlight latch (the latch protects against concurrent network calls); it just bypasses the early-return for "still in flight, ignore." If the user clicks Refresh while a fetch is mid-flight, the click is a no-op (button shows pending state until fetch resolves).

### Refresh button

- Native `<button type="button">` next to the summary banner.
- Disabled-during-request via `inFlight` flag observation. While disabled, button shows a subtle "Refreshing…" label.
- On click: forces immediate `refresh(true)`. Re-enables when fetch completes.
- No confirmation gate (Refresh is read-only; no destructive action).

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Doctor                                              [Refresh]   │
│                                                                 │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ [pass]  All checks passing                                  │ │
│ │ Total: 23  ·  Pass: 20  ·  Warn: 1  ·  Fail: 2  ·  Skip: 0 │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ Core                                                        │ │
│ │ [pass]  Hive version          v1.5.0                        │ │
│ │ [warn]  Up-to-date with origin  3 commits behind            │ │
│ └────────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ Dependencies                                                │ │
│ │ [pass]  Node installed                                      │ │
│ │ [pass]  pm2 installed                                       │ │
│ │ [fail]  Claude CLI installed   not found in PATH           │ │
│ │         Fix: brew install claude-cli                       │ │
│ └────────────────────────────────────────────────────────────┘ │
│ (... auth / build / config / strategic cards ...)              │
│                                                                 │
│ Per-agent                                                       │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ atlas → /agents.html?name=atlas                  [pass]     │ │
│ │ [pass] Bot token (DISCORD_BOT_TOKEN_ATLAS)                  │ │
│ │ [pass] Behavior directory                                   │ │
│ │ [pass] IDENTITY.md                                          │ │
│ └────────────────────────────────────────────────────────────┘ │
│ (... per-agent cards ...)                                       │
└─────────────────────────────────────────────────────────────────┘
```

Below 720px: cards collapse to single column; long detail/fix_hint text wraps; check rows stack the pill above the label/detail.

---

## Pre-conditions

- E.1 ✅ at `06da606`, E.2 ✅ at `5ae35d8`, E.3 ✅ at `f002003`
- D.3 endpoint live: `GET /api/doctor` returns envelope per D.0a + D.3 spec
- D.0a + C.7 backend pieces present: `hive doctor --json` works on the host
- D-followup `1cc80dd` merged (cmd_bootstrap auto-ensures token)
- Node ≥ 22

---

## Where state lives (E.4 conventions)

**New files (4):**
- `dashboard/public/doctor.html` — static page hosting the doctor render
- `dashboard/public/js/pages/doctor.js` — page render module + polling
- `dashboard/public/js/pages/doctor-utils.js` — pure helpers
- `dashboard/test/doctor-utils.test.js` — `node --test` for pure helpers (DISTINCT from existing `doctor.test.js` which is the D.3 backend route test)

**Modified file (1):**
- `dashboard/public/css/dashboard.css` — append doctor-page-specific styles. Tokens-only — NO new tokens defined.

**Total: 5 paths.**

**No backend changes.** D.3 already ships `/api/doctor`. No new prod deps. No new dev deps.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `f002003` (E.3 merge) plus this E.4 spec commit.

### 2. E.1 + E.2 + E.3 surface present

```bash
test -f dashboard/public/index.html && echo "index.html ✓"
test -f dashboard/public/login.html && echo "login.html ✓"
test -f dashboard/public/agents.html && echo "agents.html ✓"
test -f dashboard/public/js/auth.js && echo "auth.js ✓"
test -f dashboard/public/js/api.js && echo "api.js ✓"
test -f dashboard/public/js/shell.js && echo "shell.js ✓"
test -d dashboard/public/js/pages && echo "pages/ ✓"
test -f dashboard/public/js/pages/overview.js && echo "overview.js ✓"
test -f dashboard/public/js/pages/agents.js && echo "agents.js ✓"
test -f dashboard/public/css/dashboard.css && echo "dashboard.css ✓"
grep -E '\.pill-task-pass|\.pill-task-completed|\.pill-status-online|\.pill-activity-idle' dashboard/public/css/dashboard.css | head -3
```

**HALT and ping glados** if any E.1/E.2/E.3 surface is missing OR locked pill classes are absent.

### 3. E.4 target paths absent

```bash
test ! -f dashboard/public/doctor.html && echo "doctor.html absent ✓"
test ! -f dashboard/public/js/pages/doctor.js && echo "doctor.js absent ✓"
test ! -f dashboard/public/js/pages/doctor-utils.js && echo "doctor-utils.js absent ✓"
test ! -f dashboard/test/doctor-utils.test.js && echo "doctor-utils.test.js absent ✓"
test -f dashboard/test/doctor.test.js && echo "(existing D.3 backend doctor.test.js still present — distinct from new doctor-utils.test.js) ✓"
```

**HALT and ping glados** if any of the 4 NEW target paths exist OR if the existing `doctor.test.js` is missing.

### 4. Endpoint sample (live boot to confirm shape matches expectations)

```bash
TOKEN=$(printf 'a%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57776 \
  node dashboard/index.js > /tmp/E4-pre4.out 2>&1 &
PID=$!
sleep 2

# Capture envelope shape
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/doctor | jq -c '{version, has_summary: (.summary | type), summary_keys: (.summary | keys | sort), checks_n: (.checks | length), first_check_keys: (.checks[0] | keys // [] | sort), agents_n: (.agents | length // 0), first_agent_keys: (.agents[0] | keys // [] | sort)}'

# Distinct status values surfaced
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/doctor | jq -r '[.checks[].status, (.agents[]?.checks[]?.status // empty)] | unique | sort | join(",")'

# Distinct categories surfaced
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57776/api/doctor | jq -r '[.checks[].category] | unique | sort | join(",")'

kill $PID
```

Expected:
- `/api/doctor` → 200, envelope has `version, ts, summary, checks, agents`
- `summary` keys include `total, pass, warn, fail, skip, exit_code`
- Each check has `id, label, category, status, detail, fix_hint`
- Status values are subset of `pass | warn | fail | skip`
- Categories are subset of `core | deps | auth | build | config | agent | strategic`

**HALT and ping glados** if envelope keys differ from D.0a/D.3 lock OR if a status / category value appears that isn't in the locked enums (forward-compat handling is built into the renderer, but new enum values warrant a glados look before merging).

### 5. Existing test suite baseline

```bash
cd dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E4-test.out | tail -10
grep -cE '✔|pass' /tmp/E4-test.out
```

Expected baseline: **137 tests pass** (125 D.x + E.1 + E.2 baseline + 12 from E.3's `agents-utils.test.js`). Worker captures the count. Post-E.4 must still be 137 pre-existing pass + new doctor-utils tests.

### 6. Tooling

```bash
node --version && pnpm --version && which curl && which jq
```

Expected: Node ≥ 22.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-E.4-doctor-page`.

**Diff lock: 5 paths exactly** (4 new + 1 modified).

### A.1 — `dashboard/public/js/pages/doctor-utils.js`

Pure functions only. No DOM. No I/O.

```javascript
'use strict';

// Derive overall summary status from the doctor envelope's summary block.
export function summarizeStatus(summary) {
  if (!summary) return { kind: 'fail', label: 'Doctor envelope unavailable' };
  const fail = Number(summary.fail) || 0;
  const warn = Number(summary.warn) || 0;
  const total = Number(summary.total) || 0;
  const pass = Number(summary.pass) || 0;
  if (fail > 0) return { kind: 'fail', label: `${fail} failing check${fail === 1 ? '' : 's'}` };
  if (warn > 0) return { kind: 'warn', label: `${warn} warning${warn === 1 ? '' : 's'}` };
  if (total > 0 && pass === total) return { kind: 'pass', label: 'All checks passing' };
  return { kind: 'pass', label: 'All checks passing' };
}

// Bucket the top-level checks array by category.
// Returns an array of {category, checks[]} ordered by the locked sequence.
// Top-level checks with category === 'agent' are dropped (they live in the agents[] section).
export function groupChecksByCategory(checks) {
  if (!Array.isArray(checks)) return [];
  const order = ['core', 'deps', 'auth', 'build', 'config', 'strategic'];
  const buckets = new Map();
  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    const cat = typeof c.category === 'string' ? c.category : 'unknown';
    if (cat === 'agent') continue;  // belongs in agents[] section
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push(c);
  }
  // Emit in locked order first, then any unknown categories in insertion order
  const result = [];
  for (const cat of order) {
    if (buckets.has(cat)) {
      result.push({ category: cat, checks: buckets.get(cat) });
      buckets.delete(cat);
    }
  }
  for (const [cat, list] of buckets) {
    result.push({ category: cat, checks: list });
  }
  return result;
}

// Map status to CSS class suffix
export function doctorStatusClass(s) {
  if (s === 'pass' || s === 'warn' || s === 'fail' || s === 'skip') return s;
  return 'unknown';
}

// Friendly category labels
export function doctorCategoryLabel(category) {
  const map = {
    core: 'Core',
    deps: 'Dependencies',
    auth: 'Authentication',
    build: 'Build',
    config: 'Configuration',
    strategic: 'Strategic',
  };
  if (typeof category !== 'string') return '';
  return map[category] || category;
}

// Sort a checks array so failed → warned → passed → skipped (failed first).
// Stable within each tier by original order.
export function prioritizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  const tier = { fail: 0, warn: 1, pass: 2, skip: 3 };
  const indexed = checks.map((c, i) => ({ c, i, t: tier[c?.status] != null ? tier[c.status] : 4 }));
  indexed.sort((a, b) => (a.t - b.t) || (a.i - b.i));
  return indexed.map((x) => x.c);
}

// Determine overall status of an agent from its checks (highest-severity wins).
// Mirrors the per-agent .status field but lets the renderer derive defensively.
export function deriveAgentStatus(agent) {
  if (!agent) return 'unknown';
  if (typeof agent.status === 'string' && (agent.status === 'pass' || agent.status === 'warn' || agent.status === 'fail' || agent.status === 'skip')) {
    return agent.status;
  }
  const checks = Array.isArray(agent.checks) ? agent.checks : [];
  if (checks.some((c) => c?.status === 'fail')) return 'fail';
  if (checks.some((c) => c?.status === 'warn')) return 'warn';
  if (checks.length > 0 && checks.every((c) => c?.status === 'pass' || c?.status === 'skip')) return 'pass';
  return 'unknown';
}

// Detect an error envelope (D.3 may surface errors when the backend can't run hive doctor)
export function isErrorEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (typeof payload.error === 'string') return true;
  if (!payload.summary || !Array.isArray(payload.checks)) return true;
  return false;
}
```

### A.2 — `dashboard/public/js/pages/doctor.js`

DOM render + polling. Imports utils from A.1, `apiJson` from `js/api.js`.

```javascript
'use strict';

import { apiJson } from '/js/api.js';
import {
  summarizeStatus,
  groupChecksByCategory,
  doctorStatusClass,
  doctorCategoryLabel,
  prioritizeChecks,
  deriveAgentStatus,
  isErrorEnvelope,
} from '/js/pages/doctor-utils.js';

const POLL_MS = 30000;

export function renderDoctor(main) {
  main.innerHTML = `
    <div class="doctor-page-header">
      <h1>Doctor</h1>
      <div class="doctor-actions">
        <button type="button" id="doctor-refresh-btn" class="doctor-refresh-btn">Refresh</button>
        <span class="doctor-refresh-status" id="doctor-refresh-status"></span>
      </div>
    </div>
    <section class="overview-card doctor-summary-card" id="doctor-summary-card"></section>
    <div id="doctor-error" class="doctor-error"></div>
    <div id="doctor-categories" class="doctor-categories"></div>
    <div id="doctor-agents" class="doctor-agents"></div>
  `;

  let pollHandle = null;
  let inFlight = false;

  const refreshBtn = document.getElementById('doctor-refresh-btn');
  refreshBtn.addEventListener('click', () => refresh(true));

  async function refresh(force = false) {
    if (inFlight && !force) return;
    if (inFlight) return;  // even with force, don't overlap network calls
    inFlight = true;
    setRefreshPending(true);
    try {
      const payload = await apiJson('/api/doctor').catch((err) => ({ __fetchError: err.message || 'fetch failed' }));
      renderEnvelope(payload);
    } finally {
      inFlight = false;
      setRefreshPending(false);
    }
  }

  function setRefreshPending(pending) {
    refreshBtn.disabled = pending;
    document.getElementById('doctor-refresh-status').textContent = pending ? 'Refreshing…' : '';
  }

  function renderEnvelope(payload) {
    if (payload && payload.__fetchError) {
      renderError(`Failed to fetch /api/doctor: ${payload.__fetchError}`);
      return;
    }
    if (isErrorEnvelope(payload)) {
      const detail = payload && typeof payload.detail === 'string' ? payload.detail : 'Doctor envelope unavailable.';
      renderError(detail);
      return;
    }
    clearError();
    renderSummary(payload.summary);
    renderCategories(payload.checks);
    renderAgents(payload.agents);
  }

  function renderError(msg) {
    document.getElementById('doctor-error').innerHTML = `
      <div class="doctor-error-banner">
        <strong>Doctor unavailable.</strong> ${escape(msg)}
      </div>
    `;
    document.getElementById('doctor-summary-card').innerHTML = '';
    document.getElementById('doctor-categories').innerHTML = '';
    document.getElementById('doctor-agents').innerHTML = '';
  }
  function clearError() {
    document.getElementById('doctor-error').innerHTML = '';
  }

  function renderSummary(summary) {
    const overall = summarizeStatus(summary);
    const card = document.getElementById('doctor-summary-card');
    const counts = summary || {};
    card.className = `overview-card doctor-summary-card banner-${overall.kind}`;
    card.innerHTML = `
      <div class="doctor-summary-headline">
        <span class="pill pill-doctor-${overall.kind}">${escape(overall.kind)}</span>
        <span class="doctor-summary-label">${escape(overall.label)}</span>
      </div>
      <div class="doctor-summary-counts">
        <span class="doctor-count-item">Total: <strong>${escape(String(counts.total ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-pass">Pass: <strong>${escape(String(counts.pass ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-warn">Warn: <strong>${escape(String(counts.warn ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-fail">Fail: <strong>${escape(String(counts.fail ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-skip">Skip: <strong>${escape(String(counts.skip ?? 0))}</strong></span>
      </div>
    `;
  }

  function renderCategories(checks) {
    const container = document.getElementById('doctor-categories');
    const grouped = groupChecksByCategory(checks);
    if (grouped.length === 0) {
      container.innerHTML = `<p class="muted">No top-level checks.</p>`;
      return;
    }
    container.innerHTML = grouped.map((bucket) => {
      const sortedChecks = prioritizeChecks(bucket.checks);
      return `
        <section class="overview-card doctor-category-card">
          <h2>${escape(doctorCategoryLabel(bucket.category))}</h2>
          <ul class="doctor-check-list">
            ${sortedChecks.map(renderCheckRow).join('')}
          </ul>
        </section>
      `;
    }).join('');
  }

  function renderAgents(agents) {
    const container = document.getElementById('doctor-agents');
    if (!Array.isArray(agents) || agents.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `
      <h2 class="doctor-section-heading">Per-agent</h2>
      <div class="doctor-agent-grid">
        ${agents.map(renderAgentCard).join('')}
      </div>
    `;
  }

  function renderAgentCard(agent) {
    const status = deriveAgentStatus(agent);
    const statusCls = doctorStatusClass(status);
    const sortedChecks = prioritizeChecks(Array.isArray(agent.checks) ? agent.checks : []);
    const detailHref = `/agents.html?name=${encodeURIComponent(agent.name || '')}`;
    return `
      <section class="overview-card doctor-agent-card">
        <header class="doctor-agent-header">
          <a class="doctor-agent-name" href="${detailHref}">${escape(agent.name || '')}</a>
          <span class="pill pill-doctor-${statusCls}">${escape(status)}</span>
        </header>
        <ul class="doctor-check-list doctor-check-list-compact">
          ${sortedChecks.map(renderCheckRow).join('') || '<li class="muted">No checks reported.</li>'}
        </ul>
      </section>
    `;
  }

  function renderCheckRow(check) {
    if (!check || typeof check !== 'object') return '';
    const statusCls = doctorStatusClass(check.status);
    const detail = typeof check.detail === 'string' && check.detail ? `<div class="doctor-check-detail">${escape(check.detail)}</div>` : '';
    const fixHint = typeof check.fix_hint === 'string' && check.fix_hint
      ? `<div class="doctor-check-fix">Fix: <code>${escape(check.fix_hint)}</code></div>`
      : '';
    return `
      <li class="doctor-check-row doctor-check-${statusCls}">
        <span class="pill pill-doctor-${statusCls}">${escape(check.status || 'unknown')}</span>
        <div class="doctor-check-body">
          <div class="doctor-check-label">${escape(check.label || check.id || '')}</div>
          ${detail}
          ${fixHint}
        </div>
      </li>
    `;
  }

  function startPolling() {
    refresh();
    pollHandle = setInterval(() => refresh(false), POLL_MS);
  }
  function stopPolling() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
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
- Single-timer polling at 30s. Backend caches at 5s TTL → manual Refresh during quiet is cheap, multiple dashboard tabs don't multiply backend load.
- `inFlight` latch prevents concurrent fetches; manual Refresh respects the latch (no overlap).
- Refresh button shows "Refreshing…" status during fetch; auto-clears on completion.
- Error envelope detection via `isErrorEnvelope(payload)` — renders the inline banner WITHOUT crashing the page or stopping polling. Next tick may recover.
- Per-agent agent name links to `/agents.html?name=<encoded>` (E.3 deep link).
- Checks within each category and within each agent are sorted by status severity (fail → warn → pass → skip), stable within tier.
- Forward-compat for unknown status / category values (renders verbatim, no crash).

### A.3 — `dashboard/public/doctor.html`

Mirrors `agents.html` from E.3 — single static page, inline boot script.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Doctor - Hive Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body>
  <script type="module">
    import { requireToken } from '/js/auth.js';
    import { apiFetch, apiPing } from '/js/api.js';
    import { renderShell, setShellVersion } from '/js/shell.js';
    import { renderDoctor } from '/js/pages/doctor.js';

    if (!requireToken()) {
      // Redirected to login.
    } else {
      const isAuthorized = await apiPing();
      if (isAuthorized) {
        const main = renderShell({ activePage: '/doctor.html', title: 'Doctor' });
        renderDoctor(main);

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

`activePage: '/doctor.html'` matches the NAV_LINKS entry from `shell.js`. NO NAV_LINKS edits.

### A.4 — `dashboard/public/css/dashboard.css` additions

Append (do NOT redefine existing tokens). All styles use existing tokens.

```css
/* ---- Doctor page ---- */

.doctor-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 16px;
}
.doctor-page-header h1 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--text-primary);
}
.doctor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.doctor-refresh-btn {
  appearance: none;
  background: var(--accent-subtle);
  color: var(--text-primary);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 6px 14px;
  font-weight: 500;
  cursor: pointer;
}
.doctor-refresh-btn:hover:not(:disabled) { background: var(--accent); }
.doctor-refresh-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.doctor-refresh-status {
  font-size: 0.85em;
  color: var(--text-secondary);
}

/* Summary card */

.doctor-summary-card {
  margin-bottom: 16px;
  border-left: 4px solid var(--border);
}
.doctor-summary-card.banner-pass { border-left-color: var(--status-pass); }
.doctor-summary-card.banner-warn { border-left-color: var(--status-warn); }
.doctor-summary-card.banner-fail { border-left-color: var(--status-fail); }

.doctor-summary-headline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.doctor-summary-label {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.doctor-summary-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  font-size: 0.9em;
  color: var(--text-secondary);
}
.doctor-count-item strong { color: var(--text-primary); }
.doctor-count-pass strong { color: var(--status-pass); }
.doctor-count-warn strong { color: var(--status-warn); }
.doctor-count-fail strong { color: var(--status-fail); }
.doctor-count-skip strong { color: var(--text-muted); }

/* Error banner */

.doctor-error { margin-bottom: 16px; }
.doctor-error-banner {
  padding: 10px 14px;
  background: var(--surface-elevated);
  border: 1px solid var(--status-fail);
  border-left: 4px solid var(--status-fail);
  border-radius: 8px;
  color: var(--text-primary);
}

/* Categories */

.doctor-categories {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.doctor-category-card h2 {
  margin: 0 0 12px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.doctor-check-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.doctor-check-list-compact { gap: 4px; }

.doctor-check-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.doctor-check-row.doctor-check-pass { opacity: 0.78; }
.doctor-check-row.doctor-check-skip { opacity: 0.62; }
.doctor-check-row.doctor-check-warn { border-color: var(--status-warn); }
.doctor-check-row.doctor-check-fail { border-color: var(--status-fail); }

.doctor-check-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.doctor-check-label {
  font-weight: 500;
  color: var(--text-primary);
}
.doctor-check-detail {
  font-size: 0.85em;
  color: var(--text-secondary);
}
.doctor-check-fix {
  font-size: 0.85em;
  color: var(--text-secondary);
}
.doctor-check-fix code {
  font-family: 'SF Mono', Menlo, monospace;
  background: var(--surface-elevated);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-primary);
}

/* Per-agent section */

.doctor-section-heading {
  margin: 24px 0 12px;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.doctor-agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}
.doctor-agent-card { padding: 14px 16px; }
.doctor-agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.doctor-agent-name {
  font-weight: 600;
  color: var(--text-primary);
  text-decoration: none;
}
.doctor-agent-name:hover { text-decoration: underline; }

/* Doctor-specific pills (token-mapped) */

.pill-doctor-pass { background: var(--status-pass); }
.pill-doctor-warn { background: var(--status-warn); }
.pill-doctor-fail { background: var(--status-fail); }
.pill-doctor-skip { background: var(--text-muted); }
.pill-doctor-unknown { background: var(--text-muted); }

@media (max-width: 720px) {
  .doctor-page-header { flex-direction: column; align-items: stretch; }
  .doctor-actions { justify-content: flex-end; }
  .doctor-agent-grid { grid-template-columns: 1fr; }
  .doctor-summary-counts { gap: 8px 14px; }
}
```

**Locked:**
- All colors via existing tokens — zero new hex values.
- New `.pill-doctor-*` classes map status to existing `--status-*` tokens (same pattern E.3 used for `.pill-task-*`).
- Visual emphasis: failed/warned checks have colored borders; passed checks dim via opacity (still visible, de-prioritized).
- Mobile responsive at 720px.

### A.5 — `dashboard/test/doctor-utils.test.js`

`node --test` for the pure helpers. Locked test cases (10):

1. `summarizeStatus(null)` → `{ kind: 'fail', label: 'Doctor envelope unavailable' }`
2. `summarizeStatus({total: 5, pass: 5, warn: 0, fail: 0, skip: 0})` → `{ kind: 'pass', label: 'All checks passing' }`
3. `summarizeStatus({total: 5, pass: 3, warn: 2, fail: 0, skip: 0})` → `{ kind: 'warn', label: '2 warnings' }`
4. `summarizeStatus({total: 5, pass: 3, warn: 0, fail: 1, skip: 1})` → `{ kind: 'fail', label: '1 failing check' }`
5. `groupChecksByCategory` — input array of 5 checks across 3 categories (one being `agent`), returns 2 buckets in locked order, `agent`-category dropped
6. `groupChecksByCategory(null)` → `[]`; `groupChecksByCategory([])` → `[]`
7. `doctorStatusClass('pass'|'warn'|'fail'|'skip')` → maps verbatim; `doctorStatusClass('mystery')` → `'unknown'`
8. `doctorCategoryLabel('deps')` → `'Dependencies'`; `doctorCategoryLabel('mystery')` → `'mystery'` (verbatim fallback); `doctorCategoryLabel(null)` → `''`
9. `prioritizeChecks` — input array `[pass, fail, warn, skip, pass]` → returns `[fail, warn, pass, pass, skip]` (stable within tier)
10. `deriveAgentStatus({status: 'fail', checks: []})` → `'fail'`; `deriveAgentStatus({checks: [{status: 'pass'}, {status: 'fail'}]})` → `'fail'` (highest-severity wins when no top-level status); `deriveAgentStatus(null)` → `'unknown'`
11. `isErrorEnvelope(null)` → `true`; `isErrorEnvelope({error: 'foo'})` → `true`; `isErrorEnvelope({summary: {}, checks: []})` → `false`
12. `isErrorEnvelope({summary: {}, checks: 'not-array'})` → `true` (defensive against malformed envelope)

The test file uses ESM imports (matches E.2 / E.3 pattern). Worker reads `dashboard/package.json` `"type"` field and uses the appropriate import syntax — same as E.2/E.3 did.

---

## B. Tests + verification

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E4-test.out
# Expected: 137 (E.1+E.2+E.3 baseline) + 12 (doctor-utils) = 149 tests passing
grep -E '✔|pass' /tmp/E4-test.out | wc -l
```

### B.2 — Lockfile + dep audit

```bash
cd ~/neato-hive/dashboard
pnpm install --frozen-lockfile
pnpm list --depth=0 --prod
# Expected: express + dotenv only — E.4 adds NO new prod deps
```

### B.3 — Live boot smoke

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57777 \
  node dashboard/index.js > /tmp/E4-boot.out 2>&1 &
PID=$!
sleep 2

curl -fsS http://127.0.0.1:57777/doctor.html | grep -q 'pages/doctor.js' && echo "B.3.a: doctor.html imports doctor.js ✓"
curl -fsS http://127.0.0.1:57777/js/pages/doctor.js | head -3 | grep -q "use strict" && echo "B.3.b: doctor.js loads ✓"
curl -fsS http://127.0.0.1:57777/js/pages/doctor-utils.js | head -3 | grep -q "use strict" && echo "B.3.c: doctor-utils.js loads ✓"

echo "B.3.manual: open http://127.0.0.1:57777/doctor.html in browser; paste $TOKEN; verify"
echo "  - Summary banner renders with status pill + counts"
echo "  - Top-level checks grouped under Core / Dependencies / Authentication / Build / Configuration / Strategic cards"
echo "  - Failed/warned checks visually emphasized (colored borders); passed checks dimmed"
echo "  - Per-agent section renders one card per agent with status pill + checks list"
echo "  - Agent name click → /agents.html?name=<n>"
echo "  - Refresh button click forces immediate fetch + shows 'Refreshing…' until done"
echo "  - 30s polling visible in dev tools network tab"

kill $PID
```

### B.4 — Polling pause on tab-hidden (manual smoke)

```bash
echo "B.4.manual: open browser at /doctor.html"
echo "  - Watch network tab; /api/doctor fires at 30s"
echo "  - Hide tab → polling stops"
echo "  - Restore tab → polling resumes"
```

### B.5 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-E.4-doctor-page
# Expected: exactly 5 files (4 new + 1 modified)
git diff main...feat/v1.5.0-E.4-doctor-page -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.6 — No PM2 verbs in diff

```bash
git diff main...feat/v1.5.0-E.4-doctor-page | grep -E '^\+.*pm2 (start|restart|reload|delete|save|stop|kill)' | head -5
# Expected: empty
```

### B.7 — No new CSS tokens

```bash
git diff main...feat/v1.5.0-E.4-doctor-page -- dashboard/public/css/dashboard.css | grep -E '^\+\s*--[a-z]' | head -5
# Expected: empty
```

### B.8 — No NAV_LINKS edits

```bash
git diff main...feat/v1.5.0-E.4-doctor-page -- dashboard/public/js/shell.js
# Expected: empty (NAV_LINKS already includes /doctor.html from E.1)
```

### B.9 — No `innerHTML` of unescaped data

Worker grep-checks the new files for any `innerHTML = ` interpolation that doesn't go through `escape(...)`:

```bash
grep -nE 'innerHTML.*\$\{' dashboard/public/js/pages/doctor.js | grep -vE 'escape\(|encodeURIComponent\(' | head -10
```

Expected pattern: every `${...}` inside an `innerHTML` template-literal is one of:
- A literal already-known constant (e.g. CSS class name from a fixed enum lookup)
- An already-escaped output (a function whose body invokes `escape()`)
- A direct call to `escape(...)` or `encodeURIComponent(...)`

Worker reviews grep output and confirms each line matches one of these. If any line interpolates raw data without an `escape()` wrapper or known-safe value, **HALT and ping glados**.

### B.10 — Cleanup

```bash
rm -f /tmp/E4-*.out /tmp/E4-*.json
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 5 paths exactly (4 new + 1 modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED
- [ ] B.1 test suite: 12 new tests pass; total ≥ 149 (137 baseline + 12 doctor-utils)
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/doctor.html` imports `doctor.js`; both `pages/doctor.js` and `pages/doctor-utils.js` load with `Content-Type: application/javascript`; manual browser smoke documented in DONE block
- [ ] B.5 diff-lock = 5 paths; pnpm-lock.yaml unchanged
- [ ] B.6 no PM2 verbs in diff
- [ ] B.7 no new CSS tokens
- [ ] B.8 no NAV_LINKS edits in shell.js
- [ ] B.9 no unescaped `innerHTML` interpolation
- [ ] **All CSS uses existing tokens** — no new `--*` definitions
- [ ] **All dynamic strings HTML-escaped** before innerHTML — `escape()` everywhere; URL params via `encodeURIComponent`
- [ ] **Polling pauses on `visibilitychange` hidden** — 30s timer stops; resumes on visible
- [ ] **Refresh button** — forces immediate fetch via `force=true`; respects inFlight latch (no overlapping requests); shows "Refreshing…" status during fetch
- [ ] **Summary banner** derives status from `summary.fail / warn / pass / total` (NOT `exit_code` directly — that's informational)
- [ ] **Top-level checks grouped by category** in locked order (core, deps, auth, build, config, strategic); category=`agent` checks excluded from top-level (they live in per-agent section)
- [ ] **Per-agent cards** with agent name linking to `/agents.html?name=<encoded>`
- [ ] **Checks sorted by severity** within each card (fail → warn → pass → skip), stable within tier
- [ ] **Error envelope handling** — `isErrorEnvelope` detection renders inline banner WITHOUT crashing the page or stopping polling
- [ ] **Forward-compat** — unknown status / category enum values don't crash; render verbatim with `unknown` class fallback
- [ ] **No frontend unit tests added beyond pure helpers** — only `doctor-utils.js` gets `node --test`. DOM render not jsdom-tested.
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.10 outputs verbatim, manual browser smoke description, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 5 paths (4 new + 1 modified)
Branch: feat/v1.5.0-E.4-doctor-page

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. E.1+E.2+E.3 surface present: ✓
  3. E.4 target paths absent: ✓
  4. endpoint sample: <captured envelope shape + status enum + category enum>
  5. test baseline: 137 passed
  6. tooling: node ≥22 ✓ pnpm ✓ curl ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - all 137 carry-over tests: passed
    - dashboard/test/doctor-utils.test.js: 12 passed
    Total: 149 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - doctor.html imports doctor.js ✓
    - doctor.js loads ✓
    - doctor-utils.js loads ✓
  B.3.manual: <description: summary banner with counts, category cards, per-agent cards
              with agent-detail click-through, refresh button, 30s polling>
  B.4.manual polling pause: <observed timer stops on tab-hidden, resumes on visible>
  B.5 diff-lock = 5 paths: ✓
  B.6 no PM2 verbs in diff: ✓
  B.7 no new CSS tokens: ✓
  B.8 no NAV_LINKS edits: ✓
  B.9 no unescaped innerHTML: ✓

Worker scope attestations:
  - dashboard/pnpm-lock.yaml UNCHANGED
  - No new --* CSS tokens added (all consume existing E.1+E.2+E.3 tokens)
  - All dynamic strings HTML-escaped before innerHTML
  - URL params via encodeURIComponent
  - shell.js NAV_LINKS unchanged
  - Existing dashboard/test/doctor.test.js (D.3 backend) NOT modified

DO NOT MERGE. Glados merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full Doctor page (summary + categories + per-agent + Refresh button + polling) in single PR.
- **DO NOT MERGE** — glados merges.
- **DO NOT REDEFINE TOKENS** — `dashboard.css` additions consume existing tokens. Any new token requires explicit spec amendment.
- **DO NOT ADD JSDOM/RTL** — locked from E.1+E.2+E.3. Pure-function helpers get `node --test`; DOM render is verified via live boot smoke.
- **DO NOT EXTEND DEPENDENCIES** — production stays at `express` + `dotenv`. Zero new dev deps.
- **DO NOT BREAK E.1+E.2+E.3 TESTS** — 137 baseline stays. E.4 adds 12 new tests; total 149.
- **DO NOT TOUCH OVERVIEW / AGENTS** — `js/pages/overview.js`, `overview-utils.js`, `agents.js`, `agents-utils.js` are read-only inputs; modifying them is out of scope.
- **DO NOT EDIT NAV_LINKS** — `shell.js` already includes `/doctor.html`.
- **DO NOT MODIFY existing `dashboard/test/doctor.test.js`** — that's the D.3 backend route test. E.4 ships a DISTINCT `doctor-utils.test.js`.
- **DO NOT IMPLEMENT FIX ACTIONS** — `fix_hint` from the envelope is RENDERED only. No "Apply Fix" button, no shell-out, no `?fix=1` query. That's a future leaf if owner ever requests it.
- **DO NOT ADD `?nocache=1` BACKEND BYPASS** — D.3 spec mentions this as a *future* leaf possibility. E.4 just re-polls; the 5s backend cache TTL already makes manual Refresh cheap.
- **POLLING IS LOCKED AT 30s** — `POLL_MS = 30000`. Manual Refresh is the lever for "I want fresher data now."
- **HTML-ESCAPE EVERY DYNAMIC STRING** — `escape()` for innerHTML interpolation. URL params via `encodeURIComponent`.
- **SUMMARY DERIVATION USES `fail`/`warn`/`pass`/`total`** — `exit_code` is informational; never the visual driver. The renderer must work even if `exit_code` is missing.
- **MPA IS THE LOCK** — `/doctor.html` is a single static file. NO hash routing. NO history.pushState.
- **HALT-and-ping rule** — pre-flight surprises (E.1/E.2/E.3 surface missing, locked pill classes absent, endpoint envelope keys differ from D.0a/D.3 lock, NEW status / category enum values appear, target paths already exist) stop the worker.
- **`gh repo clone` not SSH** for fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings glados `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/`, `data/`, `docs/TASK.md`, `pnpm-lock.yaml`, `skills/`, `dashboard/node_modules/`.

---

## F. Forward links

- **E.5 Updates** — `/updates.html` reads `/api/update/check` for the **owner-directive-locked "Update Now" button gate** (button hidden/disabled unless `update_available === true`). On click, calls `/api/update/apply` + opens EventSource on `/api/update/progress/:id`. Polling fallback `/api/update/status/:id` on EventSource error. Highest-risk leaf in Phase E; built last.
- **E.6 Backups** — `/backups.html` consumes `/api/backups`. List + size + age. No restore UI in v1.5.0.
- **E.7 Tasks** — `/tasks.html` is the full paginated tasks view. Active sessions surfaced prominently per Decision E lock. Reuses `taskStatusClass` + pill rendering from E.3.
- **Future leaf — fix-hint apply action** — if owner ever wants one-click fixes, add an "Apply Fix" button per check that POSTs to a future `/api/doctor/fix/:id` endpoint. Not in v1.5.0 scope.
- **Future leaf — `?nocache=1` backend bypass** — if owner reports stale doctor data, add a query-string cache bypass to D.3. Manual Refresh in E.4 already uses the same path; would just append the query param. Out of E.4 scope.
- **Future leaf — server-sent doctor refresh** — D.3's forward-link mentions an SSE stream `/api/doctor/stream`. If E.4's 30s polling ever proves too slow for live use, that's the upgrade path.
- **Future leaf — pageworker pattern extraction** — by E.7, the polling + visibilitychange + inFlight boilerplate has reproduced 4-5 times. A cleanup leaf can extract `createPageController({ endpoints, render, intervalMs })` into `js/pages/page-controller.js`. Out of E.4 scope.
