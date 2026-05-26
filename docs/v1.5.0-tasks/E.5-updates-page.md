# v1.5.0 E.5 — Updates Page

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework `main`.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** E — Dashboard frontend (7 PRs)
**Leaf:** E.5 (5 of 7 in Phase E)
**Author:** raymond-holt
**Reviewer/dispatcher:** raymond-holt (per 2026-05-08 owner-authorized mid-flight handoff from glados)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** E.1 ✅ `06da606`; E.2 ✅ `5ae35d8`; E.3 ✅ `f002003`; E.4 ✅ `c9d78f9`
**Successors:** E.6 (Backups page); E.7 (Tasks page)

---

## Goal

Render `/updates.html` — the dashboard surface for checking and applying Hive updates. The page composes three coordinated surfaces:

1. **Update availability gate.** Read `GET /api/update/check` (D.3 envelope, pass-through of `hive update --check --json` per C.5 lock). Render a three-state status banner derived from the locked `update_available` field — `true` (update available, button enabled), `false` (current, button hidden), `null` (could not check, button hidden + retry prompt). The "Update Now" button is gated by the locked owner directive: **hidden/disabled unless `update_available === true`. Never collapse `null` and `false`.**
2. **In-flight progress.** When an update is running, render the C.6 locked phase vocabulary as a step-by-step progress indicator. Primary live data via `EventSource('/api/update/progress/:id')`; fallback to polling `/api/update/status/:id` every 1.5s on `EventSource.onerror` (per Q1 architecture — state file is sole source of truth, SSE is enrichment). Reconnect SSE on visibility recovery; polling keeps running until `done` is observed or SSE successfully reconnects.
3. **Post-update setup.** When the stream surfaces `migration-*` events (C.7 vocabulary), render a discrete "Post-update setup" subsection. Specifically, the `migration-pm2-reload-pending` event renders an instruction banner with the literal `pm2 startOrReload ecosystem.config.cjs && pm2 save` command and the `ecosystem_path` from the event detail. This subsection persists post-`done` so the owner can reference it after the update concludes.

**MPA carry-over:** `/updates.html` lives at `dashboard/public/updates.html`. Single static file, inline `<script type="module">` boots `requireToken()` + `renderShell({ activePage: '/updates.html', title: 'Updates' })` + `renderUpdates(main)`. NAV_LINKS already includes `/updates.html` from E.1 — DO NOT edit `shell.js`.

**Polling cadence (multi-mode):**
- **IDLE mode** (no in-flight update): poll `/api/update/check` every 60s. Backend caches at 30s TTL → 60s frontend cadence stays well below the cache horizon.
- **IN-FLIGHT mode** (apply has been called and `done` not yet observed): EventSource is primary; on `EventSource.onerror`, switch to polling `/api/update/status/:id` every 1500ms; periodically attempt to re-open EventSource (every 5s while polling). Stop both timers when `done` event observed.
- **TERMINAL mode** (post-`done`, success or failure): all timers stopped. Render the final state. Render the post-update banner if migration events were seen. Provide a "Check again" button to return to IDLE mode.
- **`visibilitychange` hidden** pauses the IDLE-mode check poll. IN-FLIGHT polling/SSE remain active (they are the user-meaningful signal — their pause would be a UX regression). Resumes IDLE polling on visible.

**Confirm modal:** `window.confirm(...)` before applying an update — matches the precedent set by E.3's Restart button. Modal text is locked: `"Apply update v<local> → v<remote>? This will replace your current install."`. No native `<dialog>` element; no jsdom; no new CSS modal.

---

## Architectural givens (carried)

### Locked from E.1 + E.2 + E.3 + E.4

- `dashboard/public/js/auth.js` — `requireToken()`, `getToken()`, `clearToken()`, `redirectToLogin()`
- `dashboard/public/js/api.js` — `apiFetch(path, opts)`, `apiJson(path, opts)`, `apiPing()`
- `dashboard/public/js/shell.js` — `renderShell({ activePage, title })`, `setShellVersion(v)`, NAV_LINKS includes `/updates.html`
- `dashboard/public/js/pages/overview.js` + `overview-utils.js` (E.2), `agents.js` + `agents-utils.js` (E.3), `doctor.js` + `doctor-utils.js` (E.4) — DO NOT modify; E.5 ships its OWN page modules
- CSS tokens (consume only — DO NOT redefine):
  - Status: `--status-pass`, `--status-warn`, `--status-fail`, `--status-info`
  - Surfaces: `--surface`, `--surface-elevated`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-subtle`
- Pill class convention: `.pill` base class is reused; new `.pill-update-*` classes map to existing `--status-*` tokens (same pattern E.3 used for `.pill-task-*` and E.4 for `.pill-doctor-*`)
- Static asset serving order (E.1 lock) — no change

### Module structure

E.5 ships into the existing `dashboard/public/js/pages/` directory:

- `dashboard/public/js/pages/updates.js` — DOM rendering + SSE + polling orchestration (impure: DOM, fetch, EventSource, timers)
- `dashboard/public/js/pages/updates-utils.js` — pure functions (state derivation, phase formatting, terminal detection, gate logic)

The split mirrors E.2/E.3/E.4 — pure logic gets `node --test` coverage, DOM render is verified via live boot smoke.

### Endpoint usage

```js
// IDLE mode
const check = await apiJson('/api/update/check');
// IN-FLIGHT mode
const apply = await apiJson('/api/update/apply', { method: 'POST', body: '{}' });
const eventSource = new EventSource(`/api/update/progress/${encodeURIComponent(apply.update_id)}`);
const status = await apiJson(`/api/update/status/${encodeURIComponent(updateId)}`);
```

**Authorization for EventSource.** EventSource doesn't accept custom headers via the standard browser API. The dashboard's auth middleware (D.1) accepts `Authorization: Bearer <token>` headers — for SSE, E.5 uses a fall-through: pass the token via `?token=<token>` query parameter. The auth middleware (D.1) already accepts this pattern (it checks both `Authorization` header and `?token` query). Verify in pre-flight #5; if the middleware rejects query-param auth, HALT and ping raymond-holt.

The token is obtained via `getToken()` from `auth.js` (locked from E.1) and URL-encoded via `encodeURIComponent`.

### Locked envelope shapes

**`/api/update/check` (C.5 lock, three-state):**

Available:
```json
{
  "update_available": true,
  "local_version": "1.5.0",
  "remote_version": "1.5.1",
  "tarball_url": "...",
  "checksum_sha256": "...",
  "released_at": "2026-05-08T12:34:56Z",
  "changelog_url": "..."
}
```

Current:
```json
{
  "update_available": false,
  "local_version": "1.5.0",
  "remote_version": "1.5.0",
  "released_at": "2026-05-07T00:00:00Z"
}
```

Error / unreachable:
```json
{
  "update_available": null,
  "error": "failed to fetch metadata from ...",
  "local_version": "1.5.0"
}
```

D.3 may also surface 500-style errors `{ error: "check_failed", detail: "..." }` when the backend's `hive update --check --json` spawn itself fails. E.5 detects these via `isCheckErrorPayload(payload)` (the `update_available` key is absent) and renders an inline error banner without crashing the page.

**`/api/update/apply` (D.3 lock):**
```json
{ "version": "1", "ts": "...", "update_id": "20260508-abc123", "started_at": "..." }
```

5xx error shape: `{ error: "update_id_not_discovered" | "apply_failed", detail: "..." }`. Treated as a non-terminal error — banner rendered; user may retry.

**`/api/update/status/:id` (D.3 lock):**
```json
{
  "version": "1", "ts": "...", "update_id": "...",
  "current": { "phase": "...", "ts": "...", "sequence": N, "detail": {...} },
  "is_done": false,
  "success": null
}
```

`404 { error: "update_not_found", update_id }` if the state file is missing. E.5 treats this as a transient race after apply (state file may not yet exist for a few hundred ms); silent-retry up to 3 attempts before surfacing the error.

**`/api/update/progress/:id` (SSE):** stream of `data: {phase, ts, sequence, detail}\n\n` events plus `: heartbeat\n\n` every 15s. Auto-closes after `done` event observed.

### Locked phase vocabulary (from C.6)

The following 14 update phases plus the 6 migration phases (from C.7) are the complete locked vocabulary E.5 must render. New phases not listed here render verbatim under a "Step in progress" generic label (forward-compat — never crash).

| Phase | Step group | Friendly label |
|---|---|---|
| `start` | Acquire | "Starting update" |
| `lock-acquired` | Acquire | "Acquired update lock" |
| `staging-setup-complete` | Acquire | "Prepared staging directory" |
| `fetch-start` | Check | "Fetching release metadata" |
| `fetch-complete` | Check | "Fetched release metadata" |
| `compare-complete` | Check | "Compared versions" |
| `download-start` | Download | "Downloading release tarball" |
| `download-complete` | Download | "Downloaded release tarball" |
| `verify-complete` | Verify | "Verified checksum" |
| `extract-complete` | Install | "Extracted release tarball" |
| `overlay-applied` | Install | "Applied overlay" |
| `finalize-start` | Finalize | "Finalizing install" |
| `finalize-complete` | Finalize | "Finalized install" |
| `finalize-failed` | Finalize | "Finalize failed" |
| `rollback-start` | Rollback | "Rolling back" |
| `rollback-complete` | Rollback | "Rollback complete" |
| `error` | Error | "Update error" |
| `done` | Terminal | "Update complete" or "Update failed" depending on `detail.success` |

Migration vocabulary (rendered in the "Post-update setup" subsection):

| Phase | Friendly label |
|---|---|
| `migration-start` | "Starting post-update setup" |
| `migration-token-generated` | "Generated dashboard token" |
| `migration-token-already-present` | "Dashboard token already present (skipped)" |
| `migration-pm2-reload-pending` | "PM2 reload required (manual step)" |
| `migration-complete` | "Post-update setup complete" |
| `migration-failed` | "Post-update setup failed" |

The 6 step-groups (Acquire, Check, Download, Verify, Install, Finalize) plus the conditional Rollback group form the user-facing progress tracker. Each group is `pending` until any of its phases appears in the stream, `active` while one of its phases is the most-recent non-migration event, or `complete` once a successor group has any event present. The Rollback group is only visible when at least one of its phases has appeared.

### Three-state gate logic (locked from owner directive)

```js
export function updateGateState(payload) {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'unknown', label: 'Could not load update info', show_button: false };
  }
  if (typeof payload.error === 'string' && typeof payload.update_available === 'undefined') {
    return { kind: 'unknown', label: payload.detail || payload.error, show_button: false };
  }
  if (payload.update_available === true) {
    const local = typeof payload.local_version === 'string' ? payload.local_version : '?';
    const remote = typeof payload.remote_version === 'string' ? payload.remote_version : '?';
    return { kind: 'available', label: `Update available: v${local} → v${remote}`, show_button: true };
  }
  if (payload.update_available === false) {
    const local = typeof payload.local_version === 'string' ? payload.local_version : '?';
    return { kind: 'current', label: `Up to date (v${local})`, show_button: false };
  }
  // update_available === null — could not check
  const detail = typeof payload.error === 'string' ? payload.error : 'Could not contact the release server.';
  return { kind: 'unknown', label: detail, show_button: false };
}
```

**Three-tier (locked):**
- `available` (info via `--status-info` or `--accent`) — `update_available === true` and both `local_version` + `remote_version` present
- `current` (green via `--status-pass`) — `update_available === false`
- `unknown` (amber via `--status-warn`) — `update_available === null` OR the payload is malformed / missing the field

`show_button: true` ONLY when `kind === 'available'`. Never derived from any other path. This is the owner-directive lock.

### Polling pattern (IDLE)

```js
const CHECK_POLL_MS = 60000;
let checkPollHandle = null;
let checkInFlight = false;

async function refreshCheck(force = false) {
  if (checkInFlight && !force) return;
  if (checkInFlight) return;
  checkInFlight = true;
  setCheckPending(true);
  try {
    const payload = await apiJson('/api/update/check').catch((err) => ({
      __fetchError: err && err.message ? err.message : 'fetch failed',
    }));
    renderGate(payload);
  } finally {
    checkInFlight = false;
    setCheckPending(false);
  }
}

function startCheckPolling() {
  void refreshCheck();
  checkPollHandle = window.setInterval(() => void refreshCheck(false), CHECK_POLL_MS);
}
function stopCheckPolling() {
  if (checkPollHandle) { window.clearInterval(checkPollHandle); checkPollHandle = null; }
}
document.addEventListener('visibilitychange', () => {
  if (mode !== 'IDLE') return;
  if (document.visibilityState === 'hidden') stopCheckPolling();
  else if (!checkPollHandle) startCheckPolling();
});
```

A "Check again" button is also wired to `void refreshCheck(true)` so the user can force a fresh poll. Same in-flight-latch pattern as E.4: `force=true` does not skip the latch (no overlapping requests), it just re-enables refresh from a "stop polling" state if the user manually re-enables.

### SSE + polling-fallback pattern (IN-FLIGHT)

```js
const STATUS_POLL_MS = 1500;
const SSE_RECONNECT_MS = 5000;

let eventSource = null;
let statusPollHandle = null;
let sseReconnectHandle = null;
let observedEvents = [];   // {phase, ts, sequence, detail}
let lastSequenceSeen = -1;
let updateId = null;

function startInFlight(id) {
  updateId = id;
  observedEvents = [];
  lastSequenceSeen = -1;
  openSse();
}

function openSse() {
  if (!updateId) return;
  closeSse();
  const token = getToken();
  const qp = token ? `?token=${encodeURIComponent(token)}` : '';
  eventSource = new EventSource(`/api/update/progress/${encodeURIComponent(updateId)}${qp}`);
  eventSource.addEventListener('message', onSseMessage);
  eventSource.addEventListener('error', onSseError);
  // SSE is now primary: stop polling + stop reconnect attempts
  stopStatusPolling();
  stopSseReconnect();
}

function closeSse() {
  if (eventSource) {
    try { eventSource.close(); } catch { /* ignore */ }
    eventSource = null;
  }
}

function onSseMessage(evt) {
  const parsed = parseEventLine(evt.data);
  if (!parsed) return;
  if (typeof parsed.sequence === 'number' && parsed.sequence <= lastSequenceSeen) return;
  if (typeof parsed.sequence === 'number') lastSequenceSeen = parsed.sequence;
  observedEvents.push(parsed);
  renderProgress(observedEvents);
  if (parsed.phase === 'done') terminate(parsed);
}

function onSseError() {
  // Stream dropped. Fall back to polling; periodically retry SSE.
  closeSse();
  startStatusPolling();
  startSseReconnect();
}

function startStatusPolling() {
  if (statusPollHandle) return;
  void pollStatusOnce();
  statusPollHandle = window.setInterval(() => void pollStatusOnce(), STATUS_POLL_MS);
}
function stopStatusPolling() {
  if (statusPollHandle) { window.clearInterval(statusPollHandle); statusPollHandle = null; }
}

async function pollStatusOnce() {
  if (!updateId) return;
  try {
    const payload = await apiJson(`/api/update/status/${encodeURIComponent(updateId)}`);
    if (!payload || !payload.current) return;
    if (typeof payload.current.sequence === 'number' && payload.current.sequence > lastSequenceSeen) {
      observedEvents.push(payload.current);
      lastSequenceSeen = payload.current.sequence;
      renderProgress(observedEvents);
    }
    if (payload.is_done && payload.current && payload.current.phase === 'done') {
      terminate(payload.current);
    }
  } catch (err) {
    // 404 race tolerated up to a few attempts; silent fall-through is acceptable
  }
}

function startSseReconnect() {
  if (sseReconnectHandle) return;
  sseReconnectHandle = window.setInterval(() => openSse(), SSE_RECONNECT_MS);
}
function stopSseReconnect() {
  if (sseReconnectHandle) { window.clearInterval(sseReconnectHandle); sseReconnectHandle = null; }
}

function terminate(doneEvent) {
  closeSse();
  stopStatusPolling();
  stopSseReconnect();
  setMode('TERMINAL');
  renderTerminal(observedEvents, doneEvent);
}
```

**Locked semantics:**
- SSE is primary. Polling is fallback. They never run concurrently except in the brief window when SSE is reconnecting (and in that window, the dedupe by `sequence` prevents double-rendering).
- `lastSequenceSeen` ensures replay events from a re-opened SSE are deduped.
- `EventSource` browser API does NOT expose retry control beyond the default reconnect behavior — E.5 manages reconnect explicitly via `closeSse()` + `setInterval(openSse)` because the browser default is exponential backoff that's too slow for a 30-second update flow.
- Polling tolerates 404 silently for the first 3 attempts (state file race after apply); the polling interval is 1.5s so 3 attempts = ~4.5s tolerance.

### Migration subsection

When `observedEvents` contains any event with `phase` matching `/^migration-/`, render a discrete "Post-update setup" `<section>` BELOW the main progress tracker. The section persists post-`done`. Each migration event is rendered as a row with phase pill + friendly label + (for `migration-pm2-reload-pending`) the `ecosystem_path` and the literal command:

```
pm2 startOrReload <ecosystem_path>
pm2 save
```

This command is rendered inside a `<pre>` block (no inline editing; user copies). The instruction reads: *"PM2 reload required. Run the following on your machine to start the new dashboard process. This is a one-time step after upgrading from v1.4.x:"*.

Failure rendering: `migration-failed` events render with the `step` and `error` from `detail`.

### Refresh / "Check again" buttons

- IDLE mode top-right: **"Check again"** — forces immediate `refreshCheck(true)`. Disabled during in-flight check.
- TERMINAL mode top-right: **"Check again"** — clears observed events, switches mode back to IDLE, runs `refreshCheck(true)`.
- IN-FLIGHT mode top-right: no Check button (would be confusing — there's no idle state to check from while the update is running).

### "Update Now" button

- Visible AND enabled ONLY when `gate.kind === 'available'` AND mode is IDLE.
- On click: `window.confirm("Apply update v<local> → v<remote>? This will replace your current install.")`. If user cancels: no-op.
- On confirm: disable the button, switch mode to IN-FLIGHT, POST `/api/update/apply` with empty body. On success: `startInFlight(payload.update_id)`. On failure: render error banner; restore IDLE mode + re-enable the button.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Updates                                              [Check again]   │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ [available]  Update available: v1.5.0 → v1.5.1                   │ │
│ │ Released: 2026-05-08T12:34:56Z                                   │ │
│ │ Changelog: <changelog_url> (link)                                │ │
│ │ [Update Now]                                                     │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ── progress (IN-FLIGHT) ────────────────────────────────────────     │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Update in progress (id: 20260508-abc123)                          │ │
│ │ Connection: SSE                  Stream: 8 events                 │ │
│ │                                                                   │ │
│ │  ✓ Acquire           — Prepared staging directory                 │ │
│ │  ✓ Check             — Compared versions                          │ │
│ │  ✓ Download          — Downloaded release tarball                 │ │
│ │  ✓ Verify            — Verified checksum                          │ │
│ │  ⟳ Install           — Applying overlay                           │ │
│ │  · Finalize          — pending                                    │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ── post-update setup (when migration-* events observed) ────         │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Post-update setup                                                  │ │
│ │  ✓ Generated dashboard token                                       │ │
│ │  ⚠ PM2 reload required (manual step)                               │ │
│ │      Run on your machine:                                          │ │
│ │      ┌───────────────────────────────────────────────────────────┐│ │
│ │      │ pm2 startOrReload /path/to/ecosystem.config.cjs           ││ │
│ │      │ pm2 save                                                  ││ │
│ │      └───────────────────────────────────────────────────────────┘│ │
│ │  ✓ Post-update setup complete                                      │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

Below 720px: cards collapse to single column; the command `<pre>` wraps with horizontal scroll; step rows stack the indicator + label vertically.

---

## Pre-conditions

- E.1 ✅ at `06da606`, E.2 ✅ at `5ae35d8`, E.3 ✅ at `f002003`, E.4 ✅ at `c9d78f9`
- D.3 endpoints live: `/api/update/check`, `POST /api/update/apply`, `/api/update/status/:id`, `/api/update/progress/:id` (SSE)
- C.5 + C.6 + C.7 backend in place: `hive update --check --json`, state-file emission, migration handler
- D.1 auth middleware accepts both `Authorization: Bearer <token>` AND `?token=<token>` query parameter (verify in pre-flight #5)
- Node ≥ 22

---

## Where state lives (E.5 conventions)

**New files (4):**
- `dashboard/public/updates.html` — static page hosting the updates render
- `dashboard/public/js/pages/updates.js` — page render + SSE + polling orchestration
- `dashboard/public/js/pages/updates-utils.js` — pure helpers (gate, phase, events, terminal)
- `dashboard/test/updates-utils.test.js` — `node --test` for pure helpers

**Modified file (1):**
- `dashboard/public/css/dashboard.css` — append updates-page-specific styles. Tokens-only — NO new tokens defined.

**Total: 5 paths.**

**No backend changes.** D.3 already ships all four endpoints. No new prod deps. No new dev deps.

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `c9d78f9` (E.4 merge) plus this E.5 spec commit.

### 2. E.1 + E.2 + E.3 + E.4 surface present

```bash
test -f dashboard/public/index.html && echo "index.html ✓"
test -f dashboard/public/login.html && echo "login.html ✓"
test -f dashboard/public/agents.html && echo "agents.html ✓"
test -f dashboard/public/doctor.html && echo "doctor.html ✓"
test -f dashboard/public/js/auth.js && echo "auth.js ✓"
test -f dashboard/public/js/api.js && echo "api.js ✓"
test -f dashboard/public/js/shell.js && echo "shell.js ✓"
test -d dashboard/public/js/pages && echo "pages/ ✓"
test -f dashboard/public/js/pages/overview.js && echo "overview.js ✓"
test -f dashboard/public/js/pages/agents.js && echo "agents.js ✓"
test -f dashboard/public/js/pages/doctor.js && echo "doctor.js ✓"
test -f dashboard/public/css/dashboard.css && echo "dashboard.css ✓"
grep -E '\.pill-task-pass|\.pill-status-online|\.pill-activity-idle|\.pill-doctor-pass' dashboard/public/css/dashboard.css | head -4
grep -E "href: '/updates.html'" dashboard/public/js/shell.js && echo "NAV_LINKS includes /updates.html ✓"
```

**HALT and ping raymond-holt** if any E.1-E.4 surface is missing OR locked pill classes are absent OR `/updates.html` is missing from NAV_LINKS.

### 3. E.5 target paths absent

```bash
test ! -f dashboard/public/updates.html && echo "updates.html absent ✓"
test ! -f dashboard/public/js/pages/updates.js && echo "updates.js absent ✓"
test ! -f dashboard/public/js/pages/updates-utils.js && echo "updates-utils.js absent ✓"
test ! -f dashboard/test/updates-utils.test.js && echo "updates-utils.test.js absent ✓"
```

**HALT and ping raymond-holt** if any of the 4 NEW target paths exist.

### 4. Endpoint sample (live boot to confirm shape matches expectations)

```bash
TOKEN=$(printf 'a%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57781 \
  node dashboard/index.js > /tmp/E5-pre4.out 2>&1 &
PID=$!
sleep 2

# /api/update/check shape
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57781/api/update/check \
  | jq -c '{has_update_available: (.update_available | type), keys: keys}'

# /api/update/status/<bogus> → 404
RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:57781/api/update/status/nonexistent-id)
test "$RC" = "404" && echo "/api/update/status/<unknown> 404 ✓"

# /api/update/progress/<bogus> → 404
RC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:57781/api/update/progress/nonexistent-id)
test "$RC" = "404" && echo "/api/update/progress/<unknown> 404 ✓"

kill $PID
```

Expected:
- `/api/update/check` → 200, `update_available` field present (type is `boolean` or `null`), other keys per C.5 lock
- `/api/update/status/<unknown>` → 404 with `{error: "update_not_found"}`
- `/api/update/progress/<unknown>` → 404 with `{error: "update_not_found"}`

**HALT and ping raymond-holt** if envelope shape differs from C.5/D.3 lock OR if 404 statuses differ.

### 5. Auth middleware accepts `?token=<token>` query parameter

```bash
TOKEN=$(printf 'a%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57782 \
  node dashboard/index.js > /tmp/E5-pre5.out 2>&1 &
PID=$!
sleep 2

# Header-based auth (control)
RC_HEADER=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57782/api/status)
echo "header-auth: $RC_HEADER (expect 200)"

# Query-param auth (E.5 SSE pattern)
RC_QUERY=$(curl -s -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:57782/api/status?token=$TOKEN")
echo "query-auth: $RC_QUERY (expect 200)"

kill $PID
```

**HALT and ping raymond-holt** if `query-auth` is anything other than 200. EventSource cannot use header-based auth; without query-param support, E.5 cannot ship as designed and the spec must be amended.

### 6. Tooling

```bash
node --version && pnpm --version && which curl && which jq
```

Expected: Node ≥ 22.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/v1.5.0-E.5-updates-page`.

**Diff lock: 5 paths exactly** (4 new + 1 modified).

### A.1 — `dashboard/public/js/pages/updates-utils.js`

Pure functions only. No DOM. No I/O.

```javascript
'use strict';

// Three-state gate derivation from /api/update/check envelope.
// Returns { kind: 'available' | 'current' | 'unknown', label, show_button: bool }.
// show_button is TRUE only when kind === 'available'. Owner-directive lock:
// never collapse update_available === null and update_available === false.
export function updateGateState(payload) {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'unknown', label: 'Could not load update info', show_button: false };
  }
  // Backend 5xx envelope shape ({ error, detail }) — no update_available key
  if (typeof payload.error === 'string' && typeof payload.update_available === 'undefined') {
    const detail = typeof payload.detail === 'string' ? payload.detail : payload.error;
    return { kind: 'unknown', label: detail, show_button: false };
  }
  if (payload.update_available === true) {
    const local = typeof payload.local_version === 'string' ? payload.local_version : '?';
    const remote = typeof payload.remote_version === 'string' ? payload.remote_version : '?';
    return {
      kind: 'available',
      label: `Update available: v${local} → v${remote}`,
      show_button: true,
    };
  }
  if (payload.update_available === false) {
    const local = typeof payload.local_version === 'string' ? payload.local_version : '?';
    return { kind: 'current', label: `Up to date (v${local})`, show_button: false };
  }
  // update_available === null OR missing — could not check
  const detail = typeof payload.error === 'string'
    ? payload.error
    : 'Could not contact the release server.';
  return { kind: 'unknown', label: detail, show_button: false };
}

// Detect the 5xx-style error envelope (no update_available key, has error string).
// Used by the renderer to switch to the inline error banner mode.
export function isCheckErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (typeof payload.update_available !== 'undefined') return false;
  return true;
}

// Locked phase vocabulary mappings.
const PHASE_GROUP = {
  'start': 'acquire',
  'lock-acquired': 'acquire',
  'staging-setup-complete': 'acquire',
  'fetch-start': 'check',
  'fetch-complete': 'check',
  'compare-complete': 'check',
  'download-start': 'download',
  'download-complete': 'download',
  'verify-complete': 'verify',
  'extract-complete': 'install',
  'overlay-applied': 'install',
  'finalize-start': 'finalize',
  'finalize-complete': 'finalize',
  'finalize-failed': 'finalize',
  'rollback-start': 'rollback',
  'rollback-complete': 'rollback',
  'error': 'error',
  'done': 'terminal',
};

const PHASE_LABEL = {
  'start': 'Starting update',
  'lock-acquired': 'Acquired update lock',
  'staging-setup-complete': 'Prepared staging directory',
  'fetch-start': 'Fetching release metadata',
  'fetch-complete': 'Fetched release metadata',
  'compare-complete': 'Compared versions',
  'download-start': 'Downloading release tarball',
  'download-complete': 'Downloaded release tarball',
  'verify-complete': 'Verified checksum',
  'extract-complete': 'Extracted release tarball',
  'overlay-applied': 'Applied overlay',
  'finalize-start': 'Finalizing install',
  'finalize-complete': 'Finalized install',
  'finalize-failed': 'Finalize failed',
  'rollback-start': 'Rolling back',
  'rollback-complete': 'Rollback complete',
  'error': 'Update error',
  'done': 'Update complete',
};

const MIGRATION_LABEL = {
  'migration-start': 'Starting post-update setup',
  'migration-token-generated': 'Generated dashboard token',
  'migration-token-already-present': 'Dashboard token already present (skipped)',
  'migration-pm2-reload-pending': 'PM2 reload required (manual step)',
  'migration-complete': 'Post-update setup complete',
  'migration-failed': 'Post-update setup failed',
};

export function isMigrationPhase(phase) {
  return typeof phase === 'string' && phase.startsWith('migration-');
}

export function phaseGroup(phase) {
  if (typeof phase !== 'string') return 'unknown';
  if (PHASE_GROUP[phase]) return PHASE_GROUP[phase];
  if (isMigrationPhase(phase)) return 'migration';
  return 'unknown';
}

export function formatPhaseLabel(phase) {
  if (typeof phase !== 'string') return '';
  if (PHASE_LABEL[phase]) return PHASE_LABEL[phase];
  if (MIGRATION_LABEL[phase]) return MIGRATION_LABEL[phase];
  return phase; // forward-compat: render unknown phase verbatim
}

// Locked group order for the progress tracker.
// rollback group only renders if any rollback event has been observed.
const GROUP_ORDER = ['acquire', 'check', 'download', 'verify', 'install', 'finalize'];

// Compute step-group state from an event stream.
// Returns array of { group, label, state: 'pending' | 'active' | 'complete' | 'failed', most_recent_phase? }
// Order is GROUP_ORDER, plus 'rollback' appended if any rollback events observed.
export function deriveStepGroups(events) {
  if (!Array.isArray(events)) return GROUP_ORDER.map((g) => ({ group: g, state: 'pending' }));

  // Filter migration events out — they belong in the post-update section
  const updateEvents = events.filter((e) => e && typeof e.phase === 'string' && !isMigrationPhase(e.phase));

  // Track which groups have been touched
  const seenGroups = new Set();
  const groupLastPhase = {};
  let mostRecentGroup = null;
  let failedGroup = null;
  let rolledBack = false;

  for (const evt of updateEvents) {
    const g = phaseGroup(evt.phase);
    if (g === 'unknown' || g === 'terminal' || g === 'error') {
      // 'done' and 'error' do not map to a step-group; track separately
      if (evt.phase === 'finalize-failed') {
        failedGroup = 'finalize';
      } else if (evt.phase === 'error') {
        // 'error' phase indicates a generic failure — mark the most-recent group as failed
        if (mostRecentGroup) failedGroup = mostRecentGroup;
      }
      continue;
    }
    if (g === 'rollback') {
      rolledBack = true;
    }
    if (evt.phase === 'finalize-failed') {
      failedGroup = 'finalize';
    }
    seenGroups.add(g);
    groupLastPhase[g] = evt.phase;
    mostRecentGroup = g;
  }

  const result = [];
  let pastActive = false;
  for (const group of GROUP_ORDER) {
    if (!seenGroups.has(group)) {
      result.push({ group, state: pastActive ? 'pending' : 'pending', most_recent_phase: null });
      continue;
    }
    if (failedGroup === group) {
      result.push({ group, state: 'failed', most_recent_phase: groupLastPhase[group] });
      pastActive = true;
      continue;
    }
    if (group === mostRecentGroup) {
      result.push({ group, state: 'active', most_recent_phase: groupLastPhase[group] });
      pastActive = true;
      continue;
    }
    result.push({ group, state: 'complete', most_recent_phase: groupLastPhase[group] });
  }

  if (rolledBack) {
    const rollbackComplete = updateEvents.some((e) => e.phase === 'rollback-complete');
    result.push({
      group: 'rollback',
      state: rollbackComplete ? 'complete' : 'active',
      most_recent_phase: groupLastPhase['rollback'] || null,
    });
  }

  return result;
}

export function groupLabel(group) {
  const map = {
    acquire: 'Acquire',
    check: 'Check',
    download: 'Download',
    verify: 'Verify',
    install: 'Install',
    finalize: 'Finalize',
    rollback: 'Rollback',
    migration: 'Post-update setup',
  };
  if (typeof group !== 'string') return '';
  return map[group] || group;
}

// Detect terminal state from event stream.
// Returns { is_done, success: bool|null, last_error: string|null, rolled_back: bool }
export function terminalState(events) {
  if (!Array.isArray(events)) return { is_done: false, success: null, last_error: null, rolled_back: false };
  let isDone = false;
  let success = null;
  let lastError = null;
  let rolledBack = false;

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    if (evt.phase === 'rollback-start' || evt.phase === 'rollback-complete') rolledBack = true;
    if ((evt.phase === 'error' || evt.phase === 'finalize-failed') && evt.detail) {
      const errMsg = typeof evt.detail.error === 'string' ? evt.detail.error : null;
      if (errMsg) lastError = errMsg;
    }
    if (evt.phase === 'done') {
      isDone = true;
      success = evt.detail && typeof evt.detail.success === 'boolean' ? evt.detail.success : null;
    }
  }

  return { is_done: isDone, success, last_error: lastError, rolled_back: rolledBack };
}

// Filter migration events out of the main event stream for "post-update setup" rendering.
export function migrationEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((e) => e && typeof e.phase === 'string' && isMigrationPhase(e.phase));
}

// Parse a single SSE data line. Returns { phase, ts, sequence, detail } or null.
export function parseEventLine(line) {
  if (typeof line !== 'string' || line.length === 0) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.phase !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
```

### A.2 — `dashboard/public/js/pages/updates.js`

DOM render + SSE + polling orchestration. Imports utils from A.1, `apiJson`/`apiFetch` from `js/api.js`, `getToken` from `js/auth.js`.

```javascript
'use strict';

import { apiJson } from '/js/api.js';
import { getToken } from '/js/auth.js';
import {
  updateGateState,
  isCheckErrorPayload,
  formatPhaseLabel,
  phaseGroup,
  isMigrationPhase,
  deriveStepGroups,
  groupLabel,
  terminalState,
  migrationEvents,
  parseEventLine,
} from '/js/pages/updates-utils.js';

const CHECK_POLL_MS = 60000;
const STATUS_POLL_MS = 1500;
const SSE_RECONNECT_MS = 5000;

export function renderUpdates(main) {
  main.innerHTML = `
    <div class="updates-page-header">
      <h1>Updates</h1>
      <div class="updates-actions">
        <button type="button" id="updates-refresh-btn" class="updates-refresh-btn">Check again</button>
        <span class="updates-refresh-status" id="updates-refresh-status"></span>
      </div>
    </div>
    <section class="overview-card updates-gate-card" id="updates-gate-card"></section>
    <div id="updates-error" class="updates-error"></div>
    <section class="overview-card updates-progress-card" id="updates-progress-card" hidden></section>
    <section class="overview-card updates-migration-card" id="updates-migration-card" hidden></section>
    <section class="overview-card updates-terminal-card" id="updates-terminal-card" hidden></section>
  `;

  let mode = 'IDLE';
  let lastGate = null;

  let checkInFlight = false;
  let checkPollHandle = null;

  let updateId = null;
  let observedEvents = [];
  let lastSequenceSeen = -1;

  let eventSource = null;
  let statusPollHandle = null;
  let sseReconnectHandle = null;
  let connectionMode = 'sse'; // 'sse' | 'polling'
  let consecutivePollErrors = 0;

  const refreshButton = document.getElementById('updates-refresh-btn');
  const refreshStatus = document.getElementById('updates-refresh-status');

  refreshButton.addEventListener('click', () => {
    if (mode === 'IN_FLIGHT') return; // no-op during update
    if (mode === 'TERMINAL') {
      // Reset to IDLE before re-checking
      observedEvents = [];
      lastSequenceSeen = -1;
      updateId = null;
      hideProgress();
      hideMigration();
      hideTerminal();
      setMode('IDLE');
    }
    void refreshCheck(true);
  });

  // -- IDLE mode helpers --

  async function refreshCheck(force = false) {
    if (checkInFlight && !force) return;
    if (checkInFlight) return;
    checkInFlight = true;
    setRefreshPending(true);
    try {
      const payload = await apiJson('/api/update/check').catch((err) => ({
        __fetchError: err && err.message ? err.message : 'fetch failed',
      }));
      lastGate = payload;
      renderGate(payload);
    } finally {
      checkInFlight = false;
      setRefreshPending(false);
    }
  }

  function setRefreshPending(pending) {
    refreshButton.disabled = pending || mode === 'IN_FLIGHT';
    refreshButton.textContent = pending ? 'Checking…' : 'Check again';
    refreshStatus.textContent = pending ? 'Checking…' : '';
  }

  function startCheckPolling() {
    if (mode !== 'IDLE') return;
    if (checkPollHandle) return;
    void refreshCheck();
    checkPollHandle = window.setInterval(() => {
      if (mode === 'IDLE') void refreshCheck(false);
    }, CHECK_POLL_MS);
  }
  function stopCheckPolling() {
    if (checkPollHandle) { window.clearInterval(checkPollHandle); checkPollHandle = null; }
  }

  // -- Gate render --

  function renderGate(payload) {
    const card = document.getElementById('updates-gate-card');

    if (payload && payload.__fetchError) {
      card.className = 'overview-card updates-gate-card gate-unknown';
      card.innerHTML = `
        <div class="updates-gate-headline">
          <span class="pill pill-update-unknown">unknown</span>
          <span class="updates-gate-label">Could not load update info</span>
        </div>
        <p class="updates-gate-detail">${escape(payload.__fetchError)}</p>
      `;
      return;
    }

    if (isCheckErrorPayload(payload)) {
      const errMsg = payload && typeof payload.error === 'string'
        ? (typeof payload.detail === 'string' ? payload.detail : payload.error)
        : 'Update info unavailable.';
      card.className = 'overview-card updates-gate-card gate-unknown';
      card.innerHTML = `
        <div class="updates-gate-headline">
          <span class="pill pill-update-unknown">unknown</span>
          <span class="updates-gate-label">Could not check for updates</span>
        </div>
        <p class="updates-gate-detail">${escape(errMsg)}</p>
      `;
      return;
    }

    const gate = updateGateState(payload);
    card.className = `overview-card updates-gate-card gate-${gate.kind}`;

    let extra = '';
    if (gate.kind === 'available') {
      const released = typeof payload.released_at === 'string' ? payload.released_at : '';
      const changelog = typeof payload.changelog_url === 'string' ? payload.changelog_url : '';
      extra = `
        <div class="updates-gate-meta">
          ${released ? `<div>Released: <span class="updates-gate-meta-value">${escape(released)}</span></div>` : ''}
          ${changelog ? `<div>Changelog: <a href="${escape(changelog)}" target="_blank" rel="noopener">${escape(changelog)}</a></div>` : ''}
        </div>
        <button type="button" id="updates-apply-btn" class="updates-apply-btn">Update Now</button>
      `;
    } else if (gate.kind === 'current') {
      const released = typeof payload.released_at === 'string' ? payload.released_at : '';
      extra = released ? `<p class="updates-gate-detail">Last released: ${escape(released)}</p>` : '';
    } else {
      // unknown
      extra = `<p class="updates-gate-detail">Try the "Check again" button. If the problem persists, the release server may be unreachable.</p>`;
    }

    card.innerHTML = `
      <div class="updates-gate-headline">
        <span class="pill pill-update-${gate.kind}">${escape(gate.kind)}</span>
        <span class="updates-gate-label">${escape(gate.label)}</span>
      </div>
      ${extra}
    `;

    if (gate.show_button) {
      const applyBtn = document.getElementById('updates-apply-btn');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => onApplyClick(payload));
      }
    }
  }

  // -- Apply button --

  async function onApplyClick(checkPayload) {
    if (mode !== 'IDLE') return;
    const local = typeof checkPayload.local_version === 'string' ? checkPayload.local_version : '?';
    const remote = typeof checkPayload.remote_version === 'string' ? checkPayload.remote_version : '?';
    const confirmMsg = `Apply update v${local} → v${remote}? This will replace your current install.`;
    if (!window.confirm(confirmMsg)) return;

    const applyBtn = document.getElementById('updates-apply-btn');
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Starting…';
    }

    try {
      const payload = await apiJson('/api/update/apply', { method: 'POST', body: '{}' });
      if (!payload || typeof payload.update_id !== 'string' || payload.update_id.length === 0) {
        renderApplyError('apply_failed', 'Server did not return an update_id.');
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Update Now'; }
        return;
      }
      stopCheckPolling();
      setMode('IN_FLIGHT');
      startInFlight(payload.update_id);
    } catch (err) {
      const status = err && err.status ? err.status : null;
      const body = err && err.body ? err.body : null;
      const code = body && typeof body.error === 'string' ? body.error : 'apply_failed';
      const detail = body && typeof body.detail === 'string' ? body.detail : (err && err.message) || 'Apply failed.';
      renderApplyError(code, detail, status);
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Update Now'; }
    }
  }

  function renderApplyError(code, detail, status) {
    const errorEl = document.getElementById('updates-error');
    errorEl.innerHTML = `
      <div class="updates-error-banner">
        <strong>Could not start update.</strong>
        ${status ? `<span class="updates-error-status">${escape('HTTP ' + status)}</span>` : ''}
        <div class="updates-error-detail">${escape(code)}: ${escape(detail)}</div>
      </div>
    `;
  }
  function clearApplyError() {
    const errorEl = document.getElementById('updates-error');
    errorEl.innerHTML = '';
  }

  // -- IN-FLIGHT mode --

  function startInFlight(id) {
    updateId = id;
    observedEvents = [];
    lastSequenceSeen = -1;
    consecutivePollErrors = 0;
    clearApplyError();
    showProgress();
    renderProgressEmpty(id);
    openSse();
  }

  function openSse() {
    if (!updateId) return;
    closeSse();
    const token = getToken();
    const qp = token ? `?token=${encodeURIComponent(token)}` : '';
    eventSource = new EventSource(`/api/update/progress/${encodeURIComponent(updateId)}${qp}`);
    eventSource.addEventListener('open', onSseOpen);
    eventSource.addEventListener('message', onSseMessage);
    eventSource.addEventListener('error', onSseError);
  }
  function closeSse() {
    if (eventSource) {
      try {
        eventSource.removeEventListener('open', onSseOpen);
        eventSource.removeEventListener('message', onSseMessage);
        eventSource.removeEventListener('error', onSseError);
        eventSource.close();
      } catch { /* ignore */ }
      eventSource = null;
    }
  }
  function onSseOpen() {
    connectionMode = 'sse';
    stopStatusPolling();
    stopSseReconnect();
    updateConnectionPill();
  }
  function onSseMessage(evt) {
    const parsed = parseEventLine(evt && evt.data);
    if (!parsed) return;
    if (typeof parsed.sequence === 'number' && parsed.sequence <= lastSequenceSeen) return;
    if (typeof parsed.sequence === 'number') lastSequenceSeen = parsed.sequence;
    observedEvents.push(parsed);
    renderProgress(observedEvents);
    if (parsed.phase === 'done') terminate(parsed);
  }
  function onSseError() {
    closeSse();
    connectionMode = 'polling';
    updateConnectionPill();
    startStatusPolling();
    startSseReconnect();
  }

  function startStatusPolling() {
    if (statusPollHandle) return;
    void pollStatusOnce();
    statusPollHandle = window.setInterval(() => void pollStatusOnce(), STATUS_POLL_MS);
  }
  function stopStatusPolling() {
    if (statusPollHandle) { window.clearInterval(statusPollHandle); statusPollHandle = null; }
  }

  async function pollStatusOnce() {
    if (!updateId || mode !== 'IN_FLIGHT') return;
    try {
      const payload = await apiJson(`/api/update/status/${encodeURIComponent(updateId)}`);
      consecutivePollErrors = 0;
      if (!payload || !payload.current) return;
      const current = payload.current;
      if (typeof current.sequence === 'number' && current.sequence > lastSequenceSeen) {
        observedEvents.push(current);
        lastSequenceSeen = current.sequence;
        renderProgress(observedEvents);
      }
      if (payload.is_done && current && current.phase === 'done') {
        terminate(current);
      }
    } catch (err) {
      consecutivePollErrors += 1;
      // Tolerate transient 404 race for the first ~3 attempts (~4.5s) then surface.
      if (consecutivePollErrors > 3) {
        const errorEl = document.getElementById('updates-error');
        if (errorEl) {
          errorEl.innerHTML = `
            <div class="updates-error-banner">
              <strong>Connection lost.</strong>
              <div class="updates-error-detail">Retrying… (errors: ${escape(String(consecutivePollErrors))})</div>
            </div>
          `;
        }
      }
    }
  }

  function startSseReconnect() {
    if (sseReconnectHandle) return;
    sseReconnectHandle = window.setInterval(() => {
      if (mode !== 'IN_FLIGHT') return;
      openSse();
    }, SSE_RECONNECT_MS);
  }
  function stopSseReconnect() {
    if (sseReconnectHandle) { window.clearInterval(sseReconnectHandle); sseReconnectHandle = null; }
  }

  function terminate(doneEvent) {
    closeSse();
    stopStatusPolling();
    stopSseReconnect();
    setMode('TERMINAL');
    renderTerminal(observedEvents, doneEvent);
  }

  // -- Mode + render --

  function setMode(next) {
    mode = next;
    refreshButton.disabled = (next === 'IN_FLIGHT');
  }

  function showProgress() {
    document.getElementById('updates-progress-card').hidden = false;
  }
  function hideProgress() {
    document.getElementById('updates-progress-card').hidden = true;
    document.getElementById('updates-progress-card').innerHTML = '';
  }
  function showMigration() {
    document.getElementById('updates-migration-card').hidden = false;
  }
  function hideMigration() {
    document.getElementById('updates-migration-card').hidden = true;
    document.getElementById('updates-migration-card').innerHTML = '';
  }
  function showTerminal() {
    document.getElementById('updates-terminal-card').hidden = false;
  }
  function hideTerminal() {
    document.getElementById('updates-terminal-card').hidden = true;
    document.getElementById('updates-terminal-card').innerHTML = '';
  }

  function renderProgressEmpty(id) {
    const card = document.getElementById('updates-progress-card');
    card.innerHTML = `
      <header class="updates-progress-header">
        <h2>Update in progress</h2>
        <div class="updates-progress-meta">
          <span class="updates-progress-id">id: <code>${escape(id)}</code></span>
          <span id="updates-connection-pill" class="pill pill-update-connection-sse">SSE</span>
          <span class="updates-progress-event-count">0 events</span>
        </div>
      </header>
      <ol id="updates-step-list" class="updates-step-list"></ol>
    `;
    renderStepList([]);
  }

  function renderProgress(events) {
    const card = document.getElementById('updates-progress-card');
    if (card.hidden) {
      showProgress();
      renderProgressEmpty(updateId);
    }
    const meta = card.querySelector('.updates-progress-event-count');
    if (meta) {
      const n = events.length;
      meta.textContent = `${n} event${n === 1 ? '' : 's'}`;
    }
    renderStepList(events);

    const migration = migrationEvents(events);
    if (migration.length > 0) renderMigration(migration);
  }

  function renderStepList(events) {
    const list = document.getElementById('updates-step-list');
    if (!list) return;
    const groups = deriveStepGroups(events);
    list.innerHTML = groups.map((g) => {
      const stateClass = `step-${g.state}`;
      const indicator = (
        g.state === 'complete' ? '✓' :
        g.state === 'active' ? '⟳' :
        g.state === 'failed' ? '✗' :
        '·'
      );
      const phaseLabel = g.most_recent_phase
        ? formatPhaseLabel(g.most_recent_phase)
        : (g.state === 'pending' ? 'pending' : '');
      return `
        <li class="updates-step-row ${stateClass}">
          <span class="updates-step-indicator">${escape(indicator)}</span>
          <span class="updates-step-group">${escape(groupLabel(g.group))}</span>
          <span class="updates-step-detail">${escape(phaseLabel)}</span>
        </li>
      `;
    }).join('');
  }

  function renderMigration(events) {
    const card = document.getElementById('updates-migration-card');
    showMigration();
    card.innerHTML = `
      <header class="updates-migration-header">
        <h2>Post-update setup</h2>
      </header>
      <ul class="updates-migration-list">
        ${events.map((evt) => renderMigrationRow(evt)).join('')}
      </ul>
    `;
  }

  function renderMigrationRow(evt) {
    const phase = typeof evt.phase === 'string' ? evt.phase : 'unknown';
    const label = formatPhaseLabel(phase);
    const isFailed = phase === 'migration-failed';
    const isPmReload = phase === 'migration-pm2-reload-pending';
    const indicator = isFailed ? '✗' : (phase === 'migration-complete' ? '✓' : '⚠');
    const klass = isFailed ? 'migration-row-failed' : (isPmReload ? 'migration-row-warn' : 'migration-row-ok');

    let extra = '';
    if (isPmReload && evt.detail && typeof evt.detail.ecosystem_path === 'string') {
      const path = evt.detail.ecosystem_path;
      extra = `
        <div class="updates-migration-instructions">
          <p>PM2 reload required. Run the following on your machine to start the new dashboard process:</p>
          <pre class="updates-migration-cmd">pm2 startOrReload ${escape(path)}
pm2 save</pre>
          <p class="updates-migration-note">This is a one-time step after upgrading from v1.4.x.</p>
        </div>
      `;
    } else if (isFailed && evt.detail) {
      const step = typeof evt.detail.step === 'string' ? evt.detail.step : 'unknown';
      const error = typeof evt.detail.error === 'string' ? evt.detail.error : 'no detail';
      extra = `
        <div class="updates-migration-instructions">
          <p><strong>Step:</strong> <code>${escape(step)}</code></p>
          <p><strong>Error:</strong> ${escape(error)}</p>
          <p class="updates-migration-note">Migration retries on the next <code>hive update</code>.</p>
        </div>
      `;
    }

    return `
      <li class="updates-migration-row ${klass}">
        <span class="updates-migration-indicator">${escape(indicator)}</span>
        <span class="updates-migration-label">${escape(label)}</span>
        ${extra}
      </li>
    `;
  }

  function renderTerminal(events, doneEvent) {
    showTerminal();
    const card = document.getElementById('updates-terminal-card');
    const term = terminalState(events);
    const final = doneEvent && doneEvent.detail ? doneEvent.detail : (term ? { success: term.success } : {});
    const success = final.success === true;
    const finalVersion = typeof final.final_version === 'string' ? final.final_version : null;

    let body;
    if (success) {
      body = `
        <div class="updates-terminal-headline">
          <span class="pill pill-update-success">success</span>
          <span class="updates-terminal-label">Update complete${finalVersion ? `: now at v${escape(finalVersion)}` : ''}</span>
        </div>
        <p class="updates-terminal-note">Refresh this page once you have completed any post-update setup steps shown below.</p>
      `;
    } else if (term.rolled_back) {
      body = `
        <div class="updates-terminal-headline">
          <span class="pill pill-update-failure">rolled back</span>
          <span class="updates-terminal-label">Update was rolled back</span>
        </div>
        ${term.last_error ? `<p class="updates-terminal-note"><strong>Cause:</strong> ${escape(term.last_error)}</p>` : ''}
        <p class="updates-terminal-note">Your install is unchanged. You can try the update again with the "Check again" button.</p>
      `;
    } else {
      body = `
        <div class="updates-terminal-headline">
          <span class="pill pill-update-failure">failed</span>
          <span class="updates-terminal-label">Update failed</span>
        </div>
        ${term.last_error ? `<p class="updates-terminal-note"><strong>Cause:</strong> ${escape(term.last_error)}</p>` : ''}
        <p class="updates-terminal-note">Check <code>~/.neato-hive/state/update-${escape(updateId || '')}.jsonl</code> for the full event log. The "Check again" button returns to the idle state.</p>
      `;
    }

    card.innerHTML = body;
  }

  function updateConnectionPill() {
    const pill = document.getElementById('updates-connection-pill');
    if (!pill) return;
    if (connectionMode === 'sse') {
      pill.className = 'pill pill-update-connection-sse';
      pill.textContent = 'SSE';
    } else {
      pill.className = 'pill pill-update-connection-polling';
      pill.textContent = 'polling';
    }
  }

  // -- Visibility handling (IDLE only) --

  document.addEventListener('visibilitychange', () => {
    if (mode !== 'IDLE') return;
    if (document.visibilityState === 'hidden') stopCheckPolling();
    else startCheckPolling();
  });

  // -- Boot --

  if (document.visibilityState !== 'hidden') startCheckPolling();
}

function escape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}
```

**Locked semantics:**
- Single `mode` state machine: `IDLE` → `IN_FLIGHT` → `TERMINAL` → (back to `IDLE` via Check-again).
- IDLE-mode polling pauses on `visibilitychange` hidden. IN-FLIGHT mode SSE/polling does NOT pause on hidden — the user-meaningful signal stays live.
- `show_button` derived purely from `updateGateState(payload).show_button`. The "Update Now" button DOM element is only added to the page when `gate.kind === 'available'`. No stylesheet hide-toggle.
- Confirm modal uses `window.confirm()` (matches E.3 precedent for destructive actions; no jsdom).
- Apply error responses (4xx/5xx) render as a banner; user can retry.
- 404 race after apply tolerated for ~3 polling attempts (~4.5s) before surfacing; subsequent errors render as a "Connection lost. Retrying…" banner that auto-clears once polling resumes.
- Migration events render in a separate card, persisting across mode transitions. The PM2 reload command is rendered inside `<pre>` for safe copy-paste.
- All dynamic strings HTML-escaped before innerHTML; URL params via `encodeURIComponent`.

### A.3 — `dashboard/public/updates.html`

Mirrors `doctor.html` from E.4 — single static page, inline boot script.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Updates - Hive Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body>
  <script type="module">
    import { requireToken } from '/js/auth.js';
    import { apiFetch, apiPing } from '/js/api.js';
    import { renderShell, setShellVersion } from '/js/shell.js';
    import { renderUpdates } from '/js/pages/updates.js';

    if (!requireToken()) {
      // Redirected to login.
    } else {
      const isAuthorized = await apiPing();
      if (isAuthorized) {
        const main = renderShell({ activePage: '/updates.html', title: 'Updates' });
        renderUpdates(main);

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

`activePage: '/updates.html'` matches the NAV_LINKS entry from `shell.js`. NO NAV_LINKS edits.

### A.4 — `dashboard/public/css/dashboard.css` additions

Append (do NOT redefine existing tokens). All styles use existing tokens.

```css
/* ---- Updates page ---- */

.updates-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 16px;
}
.updates-page-header h1 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--text-primary);
}
.updates-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.updates-refresh-btn {
  appearance: none;
  background: var(--accent-subtle);
  color: var(--text-primary);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 6px 14px;
  font-weight: 500;
  cursor: pointer;
}
.updates-refresh-btn:hover:not(:disabled) { background: var(--accent); }
.updates-refresh-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.updates-refresh-status {
  font-size: 0.85em;
  color: var(--text-secondary);
}

/* Gate card */

.updates-gate-card {
  margin-bottom: 16px;
  border-left: 4px solid var(--border);
}
.updates-gate-card.gate-available { border-left-color: var(--status-info, var(--accent)); }
.updates-gate-card.gate-current { border-left-color: var(--status-pass); }
.updates-gate-card.gate-unknown { border-left-color: var(--status-warn); }

.updates-gate-headline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.updates-gate-label {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}
.updates-gate-detail {
  margin: 4px 0 0;
  font-size: 0.9em;
  color: var(--text-secondary);
}
.updates-gate-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 6px 0 12px;
  font-size: 0.85em;
  color: var(--text-secondary);
}
.updates-gate-meta-value { color: var(--text-primary); }
.updates-gate-meta a {
  color: var(--accent);
  text-decoration: none;
  word-break: break-all;
}
.updates-gate-meta a:hover { text-decoration: underline; }

.updates-apply-btn {
  appearance: none;
  background: var(--accent);
  color: var(--text-primary);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 18px;
  font-weight: 600;
  font-size: 0.95em;
  cursor: pointer;
}
.updates-apply-btn:hover:not(:disabled) { filter: brightness(1.05); }
.updates-apply-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* Error banner */

.updates-error { margin-bottom: 16px; }
.updates-error-banner {
  padding: 10px 14px;
  background: var(--surface-elevated);
  border: 1px solid var(--status-fail);
  border-left: 4px solid var(--status-fail);
  border-radius: 8px;
  color: var(--text-primary);
}
.updates-error-status {
  font-size: 0.8em;
  color: var(--text-secondary);
  margin-left: 8px;
}
.updates-error-detail {
  margin-top: 4px;
  font-size: 0.85em;
  color: var(--text-secondary);
}

/* Progress card */

.updates-progress-card { margin-bottom: 16px; }
.updates-progress-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.updates-progress-header h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--text-primary);
}
.updates-progress-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85em;
  color: var(--text-secondary);
}
.updates-progress-id code {
  font-family: 'SF Mono', Menlo, monospace;
  background: var(--surface-elevated);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-primary);
}

.updates-step-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.updates-step-row {
  display: grid;
  grid-template-columns: 24px max-content 1fr;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.updates-step-row.step-pending { opacity: 0.55; }
.updates-step-row.step-active { border-color: var(--accent); }
.updates-step-row.step-complete { border-color: var(--status-pass); }
.updates-step-row.step-failed { border-color: var(--status-fail); }
.updates-step-indicator {
  font-weight: 600;
  text-align: center;
  color: var(--text-primary);
}
.updates-step-row.step-active .updates-step-indicator { color: var(--accent); }
.updates-step-row.step-complete .updates-step-indicator { color: var(--status-pass); }
.updates-step-row.step-failed .updates-step-indicator { color: var(--status-fail); }
.updates-step-group {
  font-weight: 500;
  color: var(--text-primary);
}
.updates-step-detail {
  color: var(--text-secondary);
}

/* Migration card */

.updates-migration-card { margin-bottom: 16px; }
.updates-migration-header h2 {
  margin: 0 0 12px;
  font-size: 1.05rem;
  color: var(--text-primary);
}
.updates-migration-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.updates-migration-row {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.updates-migration-row.migration-row-ok { border-color: var(--status-pass); }
.updates-migration-row.migration-row-warn { border-color: var(--status-warn); }
.updates-migration-row.migration-row-failed { border-color: var(--status-fail); }
.updates-migration-indicator {
  text-align: center;
  font-weight: 600;
  color: var(--text-primary);
}
.updates-migration-row.migration-row-ok .updates-migration-indicator { color: var(--status-pass); }
.updates-migration-row.migration-row-warn .updates-migration-indicator { color: var(--status-warn); }
.updates-migration-row.migration-row-failed .updates-migration-indicator { color: var(--status-fail); }
.updates-migration-label {
  font-weight: 500;
  color: var(--text-primary);
}
.updates-migration-instructions {
  grid-column: 1 / -1;
  margin-top: 4px;
  padding: 8px 10px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 0.9em;
}
.updates-migration-instructions p { margin: 0 0 6px; }
.updates-migration-instructions p:last-child { margin-bottom: 0; }
.updates-migration-cmd {
  display: block;
  margin: 6px 0;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: 'SF Mono', Menlo, monospace;
  white-space: pre;
  overflow-x: auto;
  color: var(--text-primary);
}
.updates-migration-note {
  font-size: 0.85em;
  color: var(--text-muted);
}

/* Terminal card */

.updates-terminal-card { margin-bottom: 16px; }
.updates-terminal-headline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.updates-terminal-label {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}
.updates-terminal-note {
  margin: 6px 0 0;
  font-size: 0.9em;
  color: var(--text-secondary);
}
.updates-terminal-note code {
  font-family: 'SF Mono', Menlo, monospace;
  background: var(--surface-elevated);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-primary);
}

/* Updates pills (token-mapped) */

.pill-update-available { background: var(--accent); }
.pill-update-current { background: var(--status-pass); }
.pill-update-unknown { background: var(--status-warn); }
.pill-update-success { background: var(--status-pass); }
.pill-update-failure { background: var(--status-fail); }
.pill-update-connection-sse { background: var(--accent-subtle); color: var(--text-primary); }
.pill-update-connection-polling { background: var(--status-warn); }

@media (max-width: 720px) {
  .updates-page-header { flex-direction: column; align-items: stretch; }
  .updates-actions { justify-content: flex-end; }
  .updates-progress-meta { flex-wrap: wrap; }
  .updates-step-row { grid-template-columns: 24px 1fr; row-gap: 4px; }
  .updates-step-row .updates-step-detail { grid-column: 1 / -1; }
  .updates-migration-cmd { font-size: 0.85em; }
}
```

**Locked:**
- All colors via existing tokens — zero new hex values.
- New `.pill-update-*` classes map state to existing `--status-*` / `--accent` tokens (same pattern E.3 used for `.pill-task-*`, E.4 for `.pill-doctor-*`).
- Visual emphasis: failed/active step rows have colored borders; pending rows dim via opacity.
- Mobile responsive at 720px.

### A.5 — `dashboard/test/updates-utils.test.js`

`node --test` for the pure helpers. Locked test cases (15):

1. `updateGateState(null)` → `{ kind: 'unknown', label: 'Could not load update info', show_button: false }`
2. `updateGateState({update_available: true, local_version: '1.5.0', remote_version: '1.5.1'})` → `{ kind: 'available', label: 'Update available: v1.5.0 → v1.5.1', show_button: true }`
3. `updateGateState({update_available: false, local_version: '1.5.0'})` → `{ kind: 'current', label: 'Up to date (v1.5.0)', show_button: false }`
4. `updateGateState({update_available: null, error: 'unreachable', local_version: '1.5.0'})` → `{ kind: 'unknown', label: 'unreachable', show_button: false }`
5. `updateGateState({update_available: null})` (no error) → `{ kind: 'unknown', label: 'Could not contact the release server.', show_button: false }`
6. `updateGateState({error: 'check_failed', detail: 'spawn failed'})` (5xx envelope) → `{ kind: 'unknown', label: 'spawn failed', show_button: false }`
7. `isCheckErrorPayload({update_available: false})` → `false`; `isCheckErrorPayload({error: 'foo'})` → `true`; `isCheckErrorPayload(null)` → `true`
8. `isMigrationPhase('migration-start')` → `true`; `isMigrationPhase('start')` → `false`; `isMigrationPhase(null)` → `false`
9. `phaseGroup` — locked vocabulary: `'overlay-applied'` → `'install'`; `'rollback-start'` → `'rollback'`; `'done'` → `'terminal'`; `'mystery'` → `'unknown'`
10. `formatPhaseLabel('overlay-applied')` → `'Applied overlay'`; `formatPhaseLabel('migration-pm2-reload-pending')` → `'PM2 reload required (manual step)'`; `formatPhaseLabel('mystery')` → `'mystery'` (forward-compat verbatim)
11. `deriveStepGroups([])` → 6 entries, all state `'pending'`, in locked order `acquire/check/download/verify/install/finalize`
12. `deriveStepGroups([{phase: 'overlay-applied'}])` → entries where `acquire/check/download/verify` are `'pending'` and `install` is `'active'`, `finalize` is `'pending'` (the upstream groups remain pending until they're actually emitted; a worker that jumps straight to install is uncommon but the renderer must not crash)
13. `deriveStepGroups([{phase: 'lock-acquired', sequence: 1}, {phase: 'compare-complete', sequence: 5}, {phase: 'finalize-failed', sequence: 11}])` → `acquire`/`check` complete, `download`/`verify`/`install` pending, `finalize` is `'failed'`
14. `deriveStepGroups` with rollback events → the rollback group is appended after `finalize`, with state `'active'` while only `rollback-start` seen and `'complete'` once `rollback-complete` seen
15. `terminalState([{phase: 'done', detail: {success: true, final_version: '1.5.1'}}])` → `{is_done: true, success: true, last_error: null, rolled_back: false}`; `terminalState([{phase: 'finalize-failed', detail: {step: 'doctor', error: 'sweep failed'}}, {phase: 'rollback-start'}, {phase: 'rollback-complete'}, {phase: 'done', detail: {success: false}}])` → `{is_done: true, success: false, last_error: 'sweep failed', rolled_back: true}`
16. `migrationEvents([{phase: 'start'}, {phase: 'migration-start'}, {phase: 'migration-complete'}])` → returns just the two migration events
17. `parseEventLine('{"phase":"start","ts":"...","sequence":0,"detail":{}}')` → parsed object; `parseEventLine('not-json')` → `null`; `parseEventLine('{}')` → `null` (no phase key); `parseEventLine('')` → `null`

The test file uses ESM imports (matches E.2 / E.3 / E.4 pattern via `loadUpdatesUtils()` helper that reads the source file and imports via `data:` URL — same shape as `doctor-utils.test.js`'s `loadDoctorUtils()`).

---

## B. Tests + verification

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E5-test.out
# Expected: 149 (E.4 baseline) + 17 (updates-utils) = 166 tests passing
grep -E '✔|pass' /tmp/E5-test.out | wc -l
```

### B.2 — Lockfile + dep audit

```bash
cd ~/neato-hive/dashboard
pnpm install --frozen-lockfile
pnpm list --depth=0 --prod
# Expected: express + dotenv only — E.5 adds NO new prod deps
```

### B.3 — Live boot smoke

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57777 \
  node dashboard/index.js > /tmp/E5-boot.out 2>&1 &
PID=$!
sleep 2

curl -fsS http://127.0.0.1:57777/updates.html | grep -q 'pages/updates.js' && echo "B.3.a: updates.html imports updates.js ✓"
curl -fsS http://127.0.0.1:57777/js/pages/updates.js | head -3 | grep -q "use strict" && echo "B.3.b: updates.js loads ✓"
curl -fsS http://127.0.0.1:57777/js/pages/updates-utils.js | head -3 | grep -q "use strict" && echo "B.3.c: updates-utils.js loads ✓"

# Endpoint reachability through the full stack
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57777/api/update/check | jq -c '{has_update_available: (.update_available | type)}'

# Query-param auth (E.5 SSE pattern)
RC=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:57777/api/update/check?token=$TOKEN")
test "$RC" = "200" && echo "B.3.d: query-token auth on /api/update/check 200 ✓"

echo "B.3.manual: open http://127.0.0.1:57777/updates.html in browser; paste $TOKEN; verify"
echo "  - Gate card renders with one of: available pill+button / current pill / unknown pill"
echo "  - 'Check again' button forces an immediate fresh /api/update/check fetch"
echo "  - Background polling visible in dev tools at 60s cadence"
echo "  - Hide tab → polling pauses; restore tab → polling resumes"
echo "  - (If a real update were available, clicking 'Update Now' would prompt window.confirm)"
echo "  - Visit updates.html?token=$TOKEN — same render via query-param auth"

kill $PID
```

### B.4 — In-flight progress smoke (pre-write fixture state file)

```bash
TOKEN=$(printf 'c%.0s' {1..64})
TMP_STATE=/tmp/E5-state-$$
mkdir -p "$TMP_STATE/state"

# Pre-write a happy-path fixture spanning all step groups
cat > "$TMP_STATE/state/update-fixture-happy.jsonl" <<'EOF'
{"phase":"start","ts":"2026-05-08T12:00:00Z","sequence":0,"detail":{"id":"fixture-happy","dry_run":false}}
{"phase":"lock-acquired","ts":"2026-05-08T12:00:01Z","sequence":1,"detail":{}}
{"phase":"staging-setup-complete","ts":"2026-05-08T12:00:02Z","sequence":2,"detail":{"path":"/tmp/staging-x"}}
{"phase":"fetch-start","ts":"2026-05-08T12:00:03Z","sequence":3,"detail":{}}
{"phase":"fetch-complete","ts":"2026-05-08T12:00:04Z","sequence":4,"detail":{"remote_version":"1.5.1"}}
{"phase":"compare-complete","ts":"2026-05-08T12:00:05Z","sequence":5,"detail":{"local_version":"1.5.0","remote_version":"1.5.1","update_available":true}}
{"phase":"download-start","ts":"2026-05-08T12:00:06Z","sequence":6,"detail":{}}
{"phase":"download-complete","ts":"2026-05-08T12:00:08Z","sequence":7,"detail":{"size_bytes":12345678}}
{"phase":"verify-complete","ts":"2026-05-08T12:00:09Z","sequence":8,"detail":{}}
{"phase":"extract-complete","ts":"2026-05-08T12:00:10Z","sequence":9,"detail":{}}
{"phase":"overlay-applied","ts":"2026-05-08T12:00:11Z","sequence":10,"detail":{"items_swapped":12}}
{"phase":"finalize-start","ts":"2026-05-08T12:00:12Z","sequence":11,"detail":{}}
{"phase":"finalize-complete","ts":"2026-05-08T12:00:13Z","sequence":12,"detail":{}}
{"phase":"migration-start","ts":"2026-05-08T12:00:14Z","sequence":13,"detail":{"from_version":"1.5.0","to_version":"1.5.1"}}
{"phase":"migration-token-already-present","ts":"2026-05-08T12:00:15Z","sequence":14,"detail":{}}
{"phase":"migration-pm2-reload-pending","ts":"2026-05-08T12:00:16Z","sequence":15,"detail":{"ecosystem_path":"/Users/glados/neato-hive/ecosystem.config.cjs"}}
{"phase":"migration-complete","ts":"2026-05-08T12:00:17Z","sequence":16,"detail":{}}
{"phase":"done","ts":"2026-05-08T12:00:18Z","sequence":17,"detail":{"success":true,"final_version":"1.5.1"}}
EOF

HIVE_STATE_ROOT="$TMP_STATE" HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57778 \
  node dashboard/index.js > /tmp/E5-fixture-boot.out 2>&1 &
PID=$!
sleep 2

# Confirm endpoints serve the fixture
curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:57778/api/update/status/fixture-happy | jq -c '{is_done, success, current_phase: .current.phase}'
# Expected: {"is_done":true,"success":true,"current_phase":"done"}

# Confirm SSE replay
curl -fsS -N -H "Authorization: Bearer $TOKEN" --max-time 2 \
  http://127.0.0.1:57778/api/update/progress/fixture-happy | head -c 1500 | grep -c '^data: '
# Expected: 18 (the 18 lines of the fixture replayed as data: events)

# Confirm SSE auto-close after done event (curl exits without --max-time hitting)
curl -fsS -N -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:57778/api/update/progress/fixture-happy 2>&1 | tail -3
echo "(exit means SSE auto-closed on done — D.3 contract)"

echo ""
echo "B.4.manual: open http://127.0.0.1:57778/updates.html?token=$TOKEN in browser"
echo "  - Gate card renders (likely 'unknown' since no real release-server)"
echo "  - Manually drive into IN_FLIGHT mode by pasting into browser console:"
echo "      window.dispatchEvent(new Event('updates-fixture-test')); // (worker may scaffold a hook)"
echo "    OR: open the dashboard pointing at the fixture port and click any UI that ends in"
echo "    POST /api/update/apply (this WOULD trigger a real update — DO NOT in worker scope)"
echo "  - Recommended: confirm the SSE replay above matches the rendered step list manually"

kill $PID
rm -rf "$TMP_STATE"
```

**Worker-scope ban:** Worker MUST NOT POST `/api/update/apply` against any live or fixture dashboard. The B.4 smoke verifies the *backend serves the fixture correctly* and the *frontend HTML imports the modules* — the IN-FLIGHT render is verified via the unit tests on `deriveStepGroups` + `terminalState` + `migrationEvents` plus the manual browser smoke note. Same precedent as D.3's B.5 ("apply gate" — no real `hive update` triggered by worker).

### B.5 — Diff-lock confirmation

```bash
git diff --stat main...feat/v1.5.0-E.5-updates-page
# Expected: exactly 5 files (4 new + 1 modified)
git diff main...feat/v1.5.0-E.5-updates-page -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.6 — No PM2 verbs in diff

```bash
git diff main...feat/v1.5.0-E.5-updates-page | grep -E '^\+.*pm2 (start|restart|reload|delete|save|stop|kill)' | head -5
# Expected: empty (pm2 startOrReload appears INSIDE the rendered <pre> command instructions —
# that is content, not an executed call. Worker confirms via grep that no '+ ' line of code
# CALLS pm2; only template-literal rendering of the literal command-string text.)
git diff main...feat/v1.5.0-E.5-updates-page | grep -E '^\+\s*(pm2 |const.*spawn.*pm2|exec.*pm2)' | head -5
# Expected: empty
```

### B.7 — No new CSS tokens

```bash
git diff main...feat/v1.5.0-E.5-updates-page -- dashboard/public/css/dashboard.css | grep -E '^\+\s*--[a-z]' | head -5
# Expected: empty
```

### B.8 — No NAV_LINKS edits

```bash
git diff main...feat/v1.5.0-E.5-updates-page -- dashboard/public/js/shell.js
# Expected: empty (NAV_LINKS already includes /updates.html from E.1)
```

### B.9 — No `innerHTML` of unescaped data

Worker grep-checks the new files for any `innerHTML = ` interpolation that doesn't go through `escape(...)`:

```bash
grep -nE 'innerHTML.*\$\{' dashboard/public/js/pages/updates.js | grep -vE 'escape\(|encodeURIComponent\(' | head -10
```

Expected pattern: every `${...}` inside an `innerHTML` template-literal is one of:
- A literal already-known constant (e.g. CSS class name from a fixed enum lookup, or a function whose body's body invokes `escape()` like `renderMigrationRow`)
- A direct call to `escape(...)` or `encodeURIComponent(...)`

Worker reviews grep output and confirms each line matches one of these. If any line interpolates raw data without an `escape()` wrapper or known-safe value, **HALT and ping raymond-holt**.

### B.10 — No real `hive update` triggered + live state directory unchanged

```bash
# 1. Worker tests stub all spawn calls — no real hive update.
git diff main...feat/v1.5.0-E.5-updates-page -- 'dashboard/test/**' \
  | grep -E "spawn.*hive.*['\"]update['\"]" | head -5
# Expected: empty

# 2. Live state directory unchanged
ls -la ~/.neato-hive/state/ 2>/dev/null | head -10
# Worker captures BEFORE pre-flight + AFTER full test run. No new update-*.jsonl files
# should appear with timestamps in the worker turn window.

# 3. Live migrations marker unchanged
ls -la ~/.neato-hive/migrations/ 2>/dev/null
```

### B.11 — Cleanup

```bash
rm -f /tmp/E5-*.out /tmp/E5-*.json
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 5 paths exactly (4 new + 1 modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED
- [ ] B.1 test suite: 17 new tests pass; total ≥ 166 (149 baseline + 17 updates-utils)
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: `/updates.html` imports `updates.js`; both `pages/updates.js` and `pages/updates-utils.js` load with `Content-Type: application/javascript`; `/api/update/check` and query-param auth confirmed; manual browser smoke documented in DONE block
- [ ] B.4 in-flight fixture smoke: backend serves fixture state file via `/api/update/status` and SSE; replay emits 18 data events; SSE auto-closes on `done`
- [ ] B.5 diff-lock = 5 paths; pnpm-lock.yaml unchanged
- [ ] B.6 no PM2 verbs in diff (executable code paths)
- [ ] B.7 no new CSS tokens
- [ ] B.8 no NAV_LINKS edits in shell.js
- [ ] B.9 no unescaped `innerHTML` interpolation
- [ ] B.10 no real `hive update` triggered; live state + migrations dirs unchanged from worker turn
- [ ] **Three-state gate logic locked** — `update_available === true` → button visible AND enabled; `update_available === false` → "current" label + button hidden; `update_available === null` (or 5xx envelope) → "unknown" label + button hidden. Owner-directive lock: never collapse `null` and `false`.
- [ ] **Confirm modal** — Update Now click triggers `window.confirm("Apply update v<local> → v<remote>? This will replace your current install.")`. Cancel = no-op.
- [ ] **State file is sole source of truth** — both SSE and polling fallback render from event stream. The `lastSequenceSeen` dedupe ensures no double-render across the SSE/polling boundary.
- [ ] **SSE + polling fallback contract** — primary EventSource; on `EventSource.onerror`, switch to polling at 1.5s; periodically attempt SSE reconnect at 5s; stop both on `done` event observed.
- [ ] **Migration subsection** — when any `migration-*` event observed, render "Post-update setup" card. `migration-pm2-reload-pending` renders the `ecosystem_path` and the literal `pm2 startOrReload <path>` + `pm2 save` instructions inside a `<pre>` block.
- [ ] **All CSS uses existing tokens** — no new `--*` definitions
- [ ] **All dynamic strings HTML-escaped** before innerHTML — `escape()` everywhere; URL params via `encodeURIComponent`
- [ ] **IDLE polling pauses on `visibilitychange` hidden** — 60s timer stops; resumes on visible. IN-FLIGHT polling/SSE remain active across hide/show.
- [ ] **Forward-compat** — unknown phase strings render verbatim under their group (or `unknown` group); never crash
- [ ] **No frontend unit tests added beyond pure helpers** — only `updates-utils.js` gets `node --test`. DOM render not jsdom-tested.
- [ ] **No live `hive update` triggered by worker turn** — explicit DONE-block attestation
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.11 outputs verbatim, manual browser smoke description, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 5 paths (4 new + 1 modified)
Branch: feat/v1.5.0-E.5-updates-page

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. E.1+E.2+E.3+E.4 surface present: ✓
  3. E.5 target paths absent: ✓
  4. endpoint sample: <captured /api/update/check shape, status 404, progress 404>
  5. query-param auth: <header 200, query 200> ✓
  6. tooling: node ≥22 ✓ pnpm ✓ curl ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - all 149 carry-over tests: passed
    - dashboard/test/updates-utils.test.js: 17 passed
    Total: 166 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - updates.html imports updates.js ✓
    - updates.js loads ✓
    - updates-utils.js loads ✓
    - /api/update/check 200 ✓
    - query-param auth 200 ✓
  B.3.manual: <description: gate card render with three-state pill, Check again button,
              60s polling, visibility pause/resume, query-param auth via URL>
  B.4 in-flight fixture smoke:
    - /api/update/status/fixture-happy → is_done:true, success:true ✓
    - SSE replay: 18 data events ✓
    - SSE auto-close on done: ✓
  B.5 diff-lock = 5 paths: ✓
  B.6 no PM2 verbs in code: ✓
  B.7 no new CSS tokens: ✓
  B.8 no NAV_LINKS edits: ✓
  B.9 no unescaped innerHTML: ✓
  B.10 worker-scope:
    - no `hive update` spawn in test code: ✓
    - live ~/.neato-hive/state/ unchanged: ✓
    - live ~/.neato-hive/migrations/ unchanged: ✓

Worker scope attestations:
  - dashboard/pnpm-lock.yaml UNCHANGED
  - No new --* CSS tokens added (all consume existing E.1+E.2+E.3+E.4 tokens)
  - All dynamic strings HTML-escaped before innerHTML
  - URL params via encodeURIComponent
  - shell.js NAV_LINKS unchanged
  - No live `hive update` was triggered by worker turn
  - No real PM2 verbs executed (the `pm2 startOrReload` text appears only inside rendered <pre> instructions)
  - Three-state gate: NULL and FALSE are distinct UI states (verified by unit tests T.1-T.6)
  - Confirm modal: window.confirm() before apply (matches E.3 Restart precedent)

DO NOT MERGE. Raymond-holt merges per 2026-05-08 owner-authorized handoff.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full Updates page (gate + apply + progress + migration + terminal) in single PR. No "we'll add the in-flight handling in a follow-up."
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT REDEFINE TOKENS** — `dashboard.css` additions consume existing tokens. Any new token requires explicit spec amendment.
- **DO NOT ADD JSDOM/RTL** — locked from E.1+E.2+E.3+E.4. Pure-function helpers get `node --test`; DOM render is verified via live boot smoke.
- **DO NOT EXTEND DEPENDENCIES** — production stays at `express` + `dotenv`. Zero new dev deps.
- **DO NOT BREAK E.1+E.2+E.3+E.4 TESTS** — 149 baseline stays. E.5 adds 17 new tests; total 166.
- **DO NOT TOUCH OVERVIEW / AGENTS / DOCTOR** — `js/pages/overview.js`, `agents.js`, `doctor.js`, and their utils are read-only inputs; modifying them is out of scope.
- **DO NOT EDIT NAV_LINKS** — `shell.js` already includes `/updates.html`.
- **DO NOT TRIGGER LIVE UPDATES** — Worker MUST NOT POST `/api/update/apply` against any live or fixture dashboard. B.10 captures `~/.neato-hive/state/` + `~/.neato-hive/migrations/` baselines and re-checks post-test.
- **DO NOT EXEC PM2** — the `pm2 startOrReload` command appears in the rendered instruction `<pre>` ONLY. Code paths must not invoke pm2. B.6 enforces.
- **DO NOT COLLAPSE `null` AND `false`** — owner-directive lock: three-state `update_available` has three distinct UI states. The unit tests enforce.
- **HTML-ESCAPE EVERY DYNAMIC STRING** — `escape()` for innerHTML interpolation. URL params via `encodeURIComponent`.
- **CONFIRM MODAL IS LOCKED** — `window.confirm()` with the exact message text in §A.2. No native `<dialog>`. Matches E.3 Restart precedent.
- **STATE FILE IS SOURCE OF TRUTH** — SSE primary, polling fallback, both render from event stream. Dedupe via `lastSequenceSeen`.
- **POLLING IS LOCKED** — IDLE check: 60s; IN-FLIGHT status fallback: 1.5s; SSE reconnect attempt: 5s. Manual "Check again" is the lever for "I want fresher data now" in IDLE/TERMINAL modes.
- **VISIBILITYCHANGE PAUSES IDLE ONLY** — IN-FLIGHT SSE/polling never pauses (the user-meaningful signal stays live across tab-hide).
- **MPA IS THE LOCK** — `/updates.html` is a single static file. NO hash routing. NO history.pushState.
- **AUTHORIZATION FOR EVENTSOURCE VIA `?token=` QUERY PARAM** — pre-flight #5 verifies. If middleware rejects query-param auth, HALT and ping raymond-holt.
- **HALT-and-ping rule** — pre-flight surprises (E.1-E.4 surface missing, locked pill classes absent, endpoint envelope keys differ from C.5/D.3 lock, query-param auth rejected, target paths already exist) stop the worker.
- **`gh repo clone` not SSH** for fresh clones; remote-URL check before cleanup.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/`, `data/`, `docs/TASK.md`, `pnpm-lock.yaml`, `skills/`, `dashboard/node_modules/`.

---

## F. Forward links

- **E.6 Backups** — `/backups.html` consumes `/api/backups`. List + size + age. No restore UI in v1.5.0. Mirrors E.5's gate-card + table shape but read-only.
- **E.7 Tasks** — `/tasks.html` is the full paginated tasks view. Active sessions surfaced prominently per Decision E lock. Reuses `taskStatusClass` + pill rendering from E.3. May reuse E.5's `pill-update-connection-*` pattern for live-tail connection state if a future leaf adds SSE-driven live tasks rendering.
- **Future leaf — IN-FLIGHT recovery on page reload** — currently if the user reloads `/updates.html` while an update is mid-flight, E.5 starts in IDLE and forgets the in-flight `update_id`. A future leaf could persist `update_id` to `localStorage` on entry to IN_FLIGHT and recover from there on reload (read it back, switch directly to IN_FLIGHT mode, re-open SSE). Out of E.5 scope.
- **Future leaf — automatic PM2 reload** — if owner ever decides the dashboard should auto-execute the PM2 reload (vs. the current manual-instruction pattern), C.7 + E.5 amend to surface a "Run PM2 reload now" button that POSTs to a new `/api/update/finalize` endpoint. Owner-directive currently locks this as a manual ceremony.
- **Future leaf — changelog rendering** — `changelog_url` is currently rendered as a plain hyperlink. A future leaf could fetch the changelog content (HTML or markdown) and render inline. Owner-directive default: external link only (matches plain-text precedent set in raymond-holt's 2026-05-08 brief; modal pre-approved as default but not yet wired).
- **Future leaf — pageworker pattern extraction** — by E.7, the polling + visibilitychange + inFlight boilerplate has reproduced 5+ times across E.2, E.3, E.4, E.5 (twice — IDLE check + IN-FLIGHT status). A cleanup leaf can extract `createPageController({ endpoints, render, intervalMs })` into `js/pages/page-controller.js`. Out of E.5 scope.
- **Future leaf — confirm modal upgrade** — `window.confirm()` is the v1.5.0 ceiling per the no-jsdom lock. If owner ever wants a styled in-page modal, a future leaf could add a vanilla-JS `<dialog>` element with consistent styling. Out of E.5 scope.
