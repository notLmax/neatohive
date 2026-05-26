# v1.5.0 E.1 — Frontend SPA Shell + Token Auth Flow + 401 Re-Prompt

**Status:** LOCKED — house-md dispatches Bob via fresh-turn one-shot cron once spec lands.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** E — Dashboard frontend (7 PRs)
**Leaf:** E.1 (1 of 7 in Phase E — foundation; everything else mounts on this shell)
**Author:** glados
**Reviewer/dispatcher:** house-md (per adjusted v1.5.0 loop)
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** Phase D complete — D.0a (`693f24b`), D.1 (`9ca2824`), D.2 (`6a5581e`), D.3 (`ea96618`), D.4 (`31d2ea6`)
**Successors:** E.2 (Overview), E.3 (Agent detail), E.4 (Doctor), E.5 (Updates), E.6 (Backups), E.7 (Tasks) — all mount on E.1's shell + auth flow

---

## Goal

Stand up the frontend foundation that every other E.x leaf mounts on. Three deliverables in one PR:

1. **Static asset serving from the dashboard process.** `dashboard/app.js` mounts `dashboard/public/` as static. Frontend HTML/CSS/JS is served by the same Express process that serves `/api/*`.
2. **Token entry + storage flow.** First-load detection, login page, localStorage persistence, 401 re-prompt. Token in localStorage; cleared on 401 from any API call; user redirected to a login page that accepts paste-from-clipboard.
3. **Base shell modules.** Three vanilla browser ESM files — `auth.js`, `api.js`, `shell.js` — that every E.2-E.7 page imports. Provides the auth-aware fetch wrapper, the page-shell renderer (header + nav + footer), and the auth state machine.

Plus a placeholder Overview page (`index.html`) that proves the auth flow end-to-end. E.2 replaces the placeholder body with the real Overview render.

---

## Architectural givens

### Frontend stack: vanilla HTML + ESM JavaScript. No framework. No build step.

**Locked:**
- **Multi-page** (one .html file per dashboard page). Future leaves add `agents.html`, `agent-detail.html`, `doctor.html`, `updates.html`, `backups.html`, `tasks.html`. Multi-page > SPA-with-hash-routing for v1: simpler, browser back-button works natively, no client-side router code.
- **Vanilla JS as ES modules** (`<script type="module">`). Each page imports shared modules via `<script type="module" src="./js/page-x.js"></script>`.
- **Plain CSS** in a single `dashboard/public/css/dashboard.css`. CSS variables for colors. No Tailwind, no preprocessor, no build step.
- **No new production dependencies.** Express + dotenv carry from D.1. Static serving is `express.static()` (built-in).

**Why no framework:**
- Zero build step → no bundler, no minifier, no source-map config, no CI churn
- Source files served exactly as written → easy to debug in DevTools
- Vanilla JS is enough for an internal dashboard (no SSR, no offline, no complex state graph)
- React/Vue/Solid would all add ≥ 100 KB of framework + a build pipeline; the entire dashboard's data layer is plain `fetch()` calls

**Why no JS test harness for E.1's frontend code:**
- Backend has 109 tests covering the data shapes that the frontend renders
- Frontend code in E.1 is pure-DOM-manipulation glue (no business logic worth unit testing)
- Future E.x leaves with non-trivial pure-function utilities (e.g. activity-state color picker, byte-formatter) MAY add `node --test` files that import the browser ESM via dynamic import — escape hatch noted
- E2E coverage ships in Phase J (`J.1` full E2E by Bob, full clone-install-update flow on Mac + Ubuntu + tailnet)
- **E.1 ships ZERO frontend unit tests.** Backend tests cover the static-serving wiring (B.x). Frontend correctness verified via the live boot smoke (B.x runs the dashboard, hits the pages, asserts shape).

If house-md or owner disagrees and wants frontend unit tests now, surface that BEFORE Bob dispatches. Default is "no frontend tests in E.1; revisit at E.4 or J.1 if it bites."

### Module/file layout (`dashboard/public/`)

```
dashboard/public/
├── index.html           # Overview placeholder (real impl in E.2)
├── login.html           # Token entry form
├── css/
│   └── dashboard.css    # Single stylesheet, CSS variables
├── js/
│   ├── auth.js          # Token storage + state (browser ESM)
│   ├── api.js           # Authed fetch wrapper (browser ESM)
│   └── shell.js         # Page header/nav/footer renderer (browser ESM)
```

### Auth flow contract (locked)

**Storage key:** `localStorage.getItem('hive_dashboard_token')`. 64-hex string per D.1.

**State machine:**

1. **Page loads** → `shell.js` calls `auth.requireToken()`:
   - If no token in localStorage → redirect to `/login.html?return=<current-path>`
   - If token present → call `api.ping()` (a HEAD/GET to `/api/status`) to validate
   - If 401 → `auth.clearToken()` + redirect to `/login.html?return=<current-path>` with a "session expired" flag
   - If 200 → render the page

2. **API fetch** → `api.fetchJson(path, opts)`:
   - Reads token from `auth.getToken()`
   - Adds `Authorization: Bearer <token>` header
   - On 401 → calls `auth.clearToken()` + `window.location.href = '/login.html?return=' + encodeURIComponent(window.location.pathname)`
   - On 2xx → returns parsed JSON
   - On other 4xx/5xx → throws an error with the response body

3. **Login page** (`/login.html`):
   - Renders a single input + "Save & continue" button
   - On submit:
     - Reads token from input (trim leading/trailing whitespace? **NO** — preserves byte-exact match with D.1's middleware which rejects whitespace; user pastes the raw 64-hex string)
     - Validates client-side: `^[a-f0-9]{64}$` regex; on mismatch, render error inline + don't submit
     - Test the token by hitting `/api/status` with it via fetch
     - On 200 → save to localStorage, redirect to `?return=` value (or `/` if absent)
     - On 401 → render "token rejected" error inline; do NOT save
   - Optional "session expired" notice if `?expired=1` in the URL (rendered by the 401-re-prompt path)

4. **Logout / token clear:** `auth.clearToken()` is exposed via a "Sign out" button in the page header (rendered by `shell.js`). Clicking → clearToken → redirect to `/login.html`.

### Page shell contract (locked)

`shell.js` exports `renderShell({ activePage, title })`. Called by every page's main JS.

**Renders:**
- Header bar with the dashboard title ("Hive Dashboard"), a nav row with links to all pages, and a "Sign out" button
- Active-page link in the nav is highlighted via `aria-current="page"` + a CSS rule
- A `<main id="page-content">` slot where page-specific render code injects content
- Footer with framework version (read from `/api/health` envelope's `version` field on first call; cached client-side for the session)

**Nav links** (in render order):
- Overview (`/`)
- Agents (`/agents.html`)
- Tasks (`/tasks.html`)
- Doctor (`/doctor.html`)
- Updates (`/updates.html`)
- Backups (`/backups.html`)

E.1 ships only `/` (Overview placeholder) and `/login.html`. The other links 404 until their respective E.x leaves merge — that's expected behavior for the foundation leaf. Each subsequent E.x adds one .html file + the shell auto-picks it up via the locked nav-link list.

### Static-serving order in `app.js`

Locked Express middleware order (D.1 + E.1):

```js
app.use(express.json({ limit: '1mb' }));

// E.1 — serve frontend static assets BEFORE the auth gate.
// Frontend itself is public; the API it talks to is gated.
app.use(express.static(path.join(__dirname, 'public')));

// D.1 — public health probe (auth bypass).
app.use('/api/health', healthRouter);

// D.1 — global auth gate for everything below.
app.use(createAuthMiddleware(token));

// D.2/D.3/D.4 — auth-gated API routes (unchanged from D.4 merged state).
app.use('/api/status', statusRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/doctor', doctorRouter);
app.use('/api/update', updateRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/runner-events', runnerEventsRouter);
app.use('/api/backups', backupsRouter);

// 404 + error handler (D.1 carry-over)
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
app.use((err, req, res, next) => { ... });
```

**Why static BEFORE auth gate:** the frontend HTML/CSS/JS is public — anyone with network access to port 7777 can load the SPA. They cannot load any DATA without a valid token (the API gate enforces). Putting static before the auth middleware avoids 401-ing CSS/JS files.

**Why static BEFORE `/api/health`:** order doesn't actually matter here (paths don't collide), but the "static then health then gate then APIs" ordering is the cleanest mental model: assets first, public probes second, then auth-gated business.

### Color tokens (locked CSS variables)

```css
:root {
  /* Surface */
  --surface: #f8f9fb;          /* page bg */
  --surface-elevated: #ffffff; /* card bg */
  --border: #e4e2de;

  /* Text */
  --text-primary: #222223;
  --text-secondary: #6e6b66;
  --text-muted: #a08a7f;

  /* Status — used by D.0a doctor envelope status enum + agent activity pills */
  --status-pass: #075d44;     /* green — pass / online / idle */
  --status-warn: #b45309;     /* amber — warn / stale */
  --status-fail: #c0392b;     /* red — fail / offline / errored */
  --status-info: #1e40af;     /* blue — task in progress */

  /* Activity (D.2 current_activity state) */
  --activity-idle: #075d44;   /* green */
  --activity-turn: #b45309;   /* amber */
  --activity-task: #1e40af;   /* blue */

  /* Brand accent (Neato — sparingly) */
  --accent: #f9bbdd;
  --accent-subtle: #ffeef8;

  /* Spacing (8px grid) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 32px;

  /* Radius */
  --radius: 10px;

  /* Type */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "SF Mono", "Menlo", "Consolas", monospace;
}
```

These tokens carry into E.2-E.7 unchanged. The neato-brand SKILL has a richer palette; for v1.5.0's internal dashboard we use a stripped-down version (skin can be enhanced later). E.1 commits the dashboard.css with the locked tokens; E.2+ extends the file with page-specific selectors.

### `auth.js` API contract (browser ESM)

```js
// dashboard/public/js/auth.js
const STORAGE_KEY = 'hive_dashboard_token';

export function getToken() {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setToken(token) {
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * requireToken() — guards a page. Call at top of each page's main JS.
 * If no token present → redirect to login. Returns the token if present.
 */
export function requireToken() {
  const token = getToken();
  if (!token) {
    redirectToLogin();
    return null;
  }
  return token;
}

export function redirectToLogin({ expired = false } = {}) {
  const params = new URLSearchParams();
  params.set('return', window.location.pathname + window.location.search);
  if (expired) params.set('expired', '1');
  window.location.href = '/login.html?' + params.toString();
}

export function isValidTokenFormat(s) {
  return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
}
```

### `api.js` API contract (browser ESM)

```js
// dashboard/public/js/api.js
import { getToken, clearToken, redirectToLogin } from './auth.js';

/**
 * apiFetch(path, opts) — fetch wrapper.
 * Adds Authorization header. On 401, clears token + redirects to login.
 * Returns the Response object — caller handles .json()/.text() as needed.
 *
 * Throws on network errors only. HTTP errors are returned as Response so
 * callers can branch on .status.
 */
export async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = new Headers(opts.headers || {});
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (opts.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    clearToken();
    redirectToLogin({ expired: true });
    // Throw so callers don't act on a 401 response (the redirect is async)
    throw new Error('unauthorized');
  }
  return res;
}

/**
 * apiJson(path, opts) — convenience wrapper. Returns parsed JSON on 2xx,
 * throws on non-2xx with { status, body } detail.
 */
export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const err = new Error('api_error');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

/**
 * apiPing() — validates the current token by hitting /api/status (auth-required).
 * Returns true on 200, false on any non-2xx. Used by shell.js on page load.
 */
export async function apiPing() {
  try {
    const res = await apiFetch('/api/status');
    return res.ok;
  } catch {
    return false;
  }
}
```

### `shell.js` API contract (browser ESM)

```js
// dashboard/public/js/shell.js
import { clearToken } from './auth.js';

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/agents.html', label: 'Agents' },
  { href: '/tasks.html', label: 'Tasks' },
  { href: '/doctor.html', label: 'Doctor' },
  { href: '/updates.html', label: 'Updates' },
  { href: '/backups.html', label: 'Backups' },
];

/**
 * renderShell({ activePage, title }) — renders the page chrome (header,
 * nav, footer). Returns the <main> element where page content goes.
 *
 * activePage: pathname like '/' or '/agents.html' — which nav link to highlight
 * title: page-specific title shown in <h1>
 */
export function renderShell({ activePage = '/', title = 'Hive Dashboard' } = {}) {
  document.title = title + ' — Hive Dashboard';
  const root = document.body;
  root.innerHTML = '';

  const header = document.createElement('header');
  header.className = 'shell-header';
  header.innerHTML = `
    <div class="shell-header-inner">
      <a href="/" class="shell-brand">Hive Dashboard</a>
      <nav class="shell-nav" role="navigation" aria-label="Primary">
        ${NAV_LINKS.map((l) => `
          <a href="${l.href}" ${l.href === activePage ? 'aria-current="page"' : ''}>${l.label}</a>
        `).join('')}
      </nav>
      <button type="button" class="shell-signout" id="shell-signout-btn">Sign out</button>
    </div>
  `;
  root.appendChild(header);

  const main = document.createElement('main');
  main.id = 'page-content';
  main.className = 'shell-main';
  root.appendChild(main);

  const footer = document.createElement('footer');
  footer.className = 'shell-footer';
  footer.innerHTML = `<small>Hive v<span id="shell-version">…</span></small>`;
  root.appendChild(footer);

  // Wire sign-out
  document.getElementById('shell-signout-btn').addEventListener('click', () => {
    clearToken();
    window.location.href = '/login.html';
  });

  return main;
}

/**
 * setShellVersion(versionString) — fills the footer version once api.js
 * has fetched it via /api/health.
 */
export function setShellVersion(v) {
  const el = document.getElementById('shell-version');
  if (el) el.textContent = v || 'unknown';
}
```

### `index.html` — placeholder Overview (E.1)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Overview — Hive Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body>
  <script type="module">
    import { requireToken } from '/js/auth.js';
    import { apiJson, apiFetch } from '/js/api.js';
    import { renderShell, setShellVersion } from '/js/shell.js';

    // Guard the page
    if (!requireToken()) { /* redirected; do nothing else */ }
    else {
      const main = renderShell({ activePage: '/', title: 'Overview' });
      main.innerHTML = `
        <h1>Overview</h1>
        <p class="muted">Real Overview render lands in E.2. This placeholder confirms the auth flow + shell are wired correctly.</p>
        <p class="muted">If you see this with the nav and "Sign out" button rendered, E.1's foundation is working.</p>
      `;

      // Hydrate the footer version from /api/health (public, no auth)
      apiFetch('/api/health')
        .then((r) => r.ok ? r.json() : null)
        .then((j) => setShellVersion(j ? j.version : 'unknown'))
        .catch(() => setShellVersion('unknown'));
    }
  </script>
</body>
</html>
```

### `login.html` — token entry

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Hive Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body class="login-body">
  <div class="login-card">
    <h1>Hive Dashboard</h1>
    <p class="muted">Paste your dashboard token to sign in.</p>
    <p class="muted small">Find it via <code>hive dashboard token</code> on the host machine.</p>
    <div id="login-banner" class="login-banner" hidden></div>
    <form id="login-form" autocomplete="off">
      <label for="token-input">Dashboard token</label>
      <input
        id="token-input"
        name="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="off"
        placeholder="64 hex characters"
        required
        minlength="64"
        maxlength="64"
        pattern="[a-f0-9]{64}"
      >
      <button type="submit">Save &amp; continue</button>
      <p id="login-error" class="error" hidden></p>
    </form>
  </div>

  <script type="module">
    import { setToken, isValidTokenFormat } from '/js/auth.js';

    const params = new URLSearchParams(window.location.search);
    const returnTo = params.get('return') || '/';
    const expired = params.get('expired') === '1';

    if (expired) {
      const banner = document.getElementById('login-banner');
      banner.textContent = 'Session expired or token rejected. Please sign in again.';
      banner.hidden = false;
    }

    document.getElementById('login-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errEl = document.getElementById('login-error');
      errEl.hidden = true;
      errEl.textContent = '';

      const input = document.getElementById('token-input');
      const token = input.value;

      if (!isValidTokenFormat(token)) {
        errEl.textContent = 'Token must be 64 hex characters (a-f, 0-9).';
        errEl.hidden = false;
        return;
      }

      // Validate against /api/status before saving
      try {
        const res = await fetch('/api/status', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (res.status === 401) {
          errEl.textContent = 'Token rejected by the dashboard.';
          errEl.hidden = false;
          return;
        }
        if (!res.ok) {
          errEl.textContent = 'Dashboard returned an error: ' + res.status;
          errEl.hidden = false;
          return;
        }
      } catch (err) {
        errEl.textContent = 'Could not reach dashboard: ' + err.message;
        errEl.hidden = false;
        return;
      }

      setToken(token);
      // Sanity: only redirect to same-origin paths starting with /
      const safeReturn = (returnTo.startsWith('/') && !returnTo.startsWith('//')) ? returnTo : '/';
      window.location.href = safeReturn;
    });
  </script>
</body>
</html>
```

**Locked behaviors:**
- `?return=` query param sanitized to same-origin paths (rejects `//evil.com` open-redirect)
- Client-side regex match BEFORE network call (fast feedback for typos)
- Network validation against `/api/status` BEFORE saving (don't save bad tokens)
- "Sign out" → clearToken + back to /login.html (handled by shell.js)

### `dashboard.css` — base styles

Locked content (Bob writes verbatim — no creative deviation):

```css
:root {
  /* (color/space/radius/type tokens per the §Color tokens block above) */
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--surface);
}

a { color: var(--text-primary); text-decoration: none; }
a:hover { text-decoration: underline; }

code { font-family: var(--font-mono); font-size: 0.9em; background: var(--surface-elevated); padding: 2px 6px; border-radius: 4px; }

.muted { color: var(--text-secondary); }
.small { font-size: 0.875em; }
.error { color: var(--status-fail); }

/* --- Shell --- */
.shell-header {
  background: var(--surface-elevated);
  border-bottom: 1px solid var(--border);
}
.shell-header-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-3) var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.shell-brand { font-weight: 600; font-size: 1.1em; }
.shell-nav { display: flex; gap: var(--space-3); flex: 1; }
.shell-nav a { padding: var(--space-1) var(--space-2); border-radius: 6px; }
.shell-nav a[aria-current="page"] { background: var(--accent-subtle); }
.shell-signout {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}
.shell-signout:hover { background: var(--surface-elevated); }

.shell-main {
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-4);
}
.shell-footer {
  max-width: 1200px;
  margin: var(--space-5) auto var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  color: var(--text-muted);
}

/* --- Login page --- */
.login-body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
}
.login-card {
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5);
  max-width: 420px;
  width: 100%;
}
.login-card h1 { margin: 0 0 var(--space-2); }
.login-card label {
  display: block;
  margin-top: var(--space-3);
  font-weight: 500;
}
.login-card input[type="password"] {
  display: block;
  width: 100%;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 0.95em;
  margin-top: var(--space-1);
}
.login-card button[type="submit"] {
  margin-top: var(--space-3);
  width: 100%;
  padding: var(--space-2);
  background: var(--text-primary);
  color: var(--surface-elevated);
  border: none;
  border-radius: 6px;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}
.login-banner {
  background: var(--accent-subtle);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: 0.9em;
}
```

---

## Pre-conditions

- Phase D complete (5/5 merged; D.4 squash `31d2ea6`)
- Dashboard runs on port 7777, gated by `HIVE_DASHBOARD_TOKEN` (D.1 carry-over)
- All 14 routes shipped: `/api/health`, `/api/status`, `/api/agents/*`, `/api/doctor`, `/api/update/*`, `/api/sessions/*`, `/api/tasks`, `/api/runner-events`, `/api/backups` (D.0a/D.1/D.2/D.3/D.4 carry-overs)
- `dashboard/public/` does not yet exist (worker confirms in pre-flight)
- Node ≥ 22 (carries from D.1)

---

## Where state lives (E.1 conventions)

**New files (8):**
- `dashboard/public/index.html`
- `dashboard/public/login.html`
- `dashboard/public/css/dashboard.css`
- `dashboard/public/js/auth.js`
- `dashboard/public/js/api.js`
- `dashboard/public/js/shell.js`
- `dashboard/test/static.test.js` — backend test for static-serving wiring (4 cases)

Wait, that's 7 new — let me recount: 6 frontend assets + 1 backend test = 7 new files.

**Modified files (1):**
- `dashboard/app.js` — insert `app.use(express.static(...))` between `express.json()` and `/api/health`

**Total: 8 paths.**

**No new dependencies.**

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state (post-D.4)

```bash
cd ~/neato-hive
git checkout main && git pull origin main
git log --oneline -5
```

Expected: HEAD includes `31d2ea6` (D.4 merge) + E.1-spec commit.

### 2. D.4 dashboard surface present

```bash
test -f dashboard/app.js && echo "app.js ✓"
test -f dashboard/lib/sessions.js && echo "lib/sessions.js ✓"
test -f dashboard/lib/tasks.js && echo "lib/tasks.js ✓"
test -f dashboard/lib/backups.js && echo "lib/backups.js ✓"
test -f dashboard/routes/sessions.js && echo "routes/sessions.js ✓"
test -f dashboard/routes/tasks.js && echo "routes/tasks.js ✓"
test -f dashboard/routes/runner-events.js && echo "routes/runner-events.js ✓"
test -f dashboard/routes/backups.js && echo "routes/backups.js ✓"
```

**HALT and ping house-md** if any are missing.

### 3. E.1 target paths absent

```bash
test ! -d dashboard/public && echo "dashboard/public/ absent ✓"
test ! -f dashboard/test/static.test.js && echo "test/static.test.js absent ✓"
```

**HALT and ping house-md** if either exists.

### 4. Existing app.js middleware order (worker reads to plan static-mount surgery)

```bash
sed -n '/^function createApp/,/^function listDeclaredAgents/p' dashboard/app.js | head -50
```

Worker captures the existing middleware chain. Plans the insertion: `app.use(express.static(...))` between `express.json()` and `/api/health`. **HALT and ping house-md** if the `app.use(...)` ordering doesn't match the D.4-merged shape.

### 5. Sanity check — the D.x test suite still passes from main

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tail -10
# Expected: 109 passing
```

Worker captures the count. **HALT and ping house-md** if any pre-existing test fails (regression from main — not E.1's concern, but a signal something is wrong).

### 6. Tooling

```bash
node --version && pnpm --version && which curl && which jq
```

Expected: Node ≥ 22.

---

## A. Deliverables

Single PR on framework repo. Branch name: `feat/v1.5.0-E.1-shell-token-auth`.

**Diff lock: 8 paths exactly** (7 new + `dashboard/app.js` modified).

### A.1 — `dashboard/public/index.html`

Per the §Architectural givens block. Placeholder Overview that proves the shell + auth flow.

### A.2 — `dashboard/public/login.html`

Per the §Architectural givens block. Token entry form with client-side regex validation + network validation against `/api/status`.

### A.3 — `dashboard/public/css/dashboard.css`

Per the §Architectural givens block. Locked content; Bob writes verbatim.

### A.4 — `dashboard/public/js/auth.js`

Per the §Architectural givens block. Browser ESM. Exports: `getToken`, `setToken`, `clearToken`, `requireToken`, `redirectToLogin`, `isValidTokenFormat`.

### A.5 — `dashboard/public/js/api.js`

Per the §Architectural givens block. Browser ESM. Exports: `apiFetch`, `apiJson`, `apiPing`.

### A.6 — `dashboard/public/js/shell.js`

Per the §Architectural givens block. Browser ESM. Exports: `renderShell`, `setShellVersion`. Locked NAV_LINKS list.

### A.7 — `dashboard/app.js` modification

Two-line insertion right after `app.use(express.json(...))`:

```js
const path = require('node:path');
// ... existing imports ...

  app.use(express.json({ limit: '1mb' }));

  // E.1 — serve frontend static assets BEFORE the auth gate
  app.use(express.static(path.join(__dirname, 'public')));

  // D.1 — public health probe (auth bypass)
  app.use('/api/health', healthRouter);
  // ... existing chain unchanged ...
```

### A.8 — `dashboard/test/static.test.js`

Backend tests for static-serving wiring.

Locked test cases (4):
1. `GET /` returns 200 + `text/html` content-type with `<title>Overview` in body (placeholder index.html)
2. `GET /login.html` returns 200 + `text/html`
3. `GET /css/dashboard.css` returns 200 + `text/css` content-type
4. `GET /js/auth.js` returns 200 + `application/javascript` (or `text/javascript`) content-type
5. **Regression gate:** `GET /api/status` (with valid token) still returns 200 (static serving did NOT shadow API routes)
6. **Regression gate:** `GET /api/health` (no token) still returns 200 (auth bypass preserved)

Wait — that's 6 cases, not 4. Locked test cases (6).

---

## B. Tests

### B.1 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/E1-test.out
# Expected: 109 (D.x carry-over) + 6 (E.1 static) = 115 tests passing
grep -E '✔|pass' /tmp/E1-test.out | wc -l
```

### B.2 — Lockfile reproducibility

```bash
cd ~/neato-hive/dashboard
rm -rf node_modules
pnpm install --frozen-lockfile
echo "lockfile reproducible ✓"
pnpm list --depth=0 --prod
# Expected: express + dotenv only — E.1 adds NO new prod deps
```

### B.3 — Live boot smoke (frontend asset serving + auth flow)

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57777 \
  node dashboard/index.js > /tmp/E1-boot.out 2>&1 &
PID=$!
sleep 2
kill -0 $PID && echo "process alive ✓"

# Frontend assets — public, no auth
RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57777/)
test "$RC" = "200" && echo "B.3.a: GET / → 200 (no auth) ✓"

RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57777/login.html)
test "$RC" = "200" && echo "B.3.b: GET /login.html → 200 (no auth) ✓"

RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57777/css/dashboard.css)
test "$RC" = "200" && echo "B.3.c: GET /css/dashboard.css → 200 ✓"

RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57777/js/auth.js)
test "$RC" = "200" && echo "B.3.d: GET /js/auth.js → 200 ✓"

# Content-type spot-checks
curl -fsSI http://127.0.0.1:57777/css/dashboard.css | grep -i 'content-type:.*text/css' && echo "B.3.e: css content-type ✓"
curl -fsSI http://127.0.0.1:57777/js/auth.js | grep -iE 'content-type:.*(application|text)/javascript' && echo "B.3.f: js content-type ✓"

# Regression — API routes still gated
RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57777/api/status)
test "$RC" = "401" && echo "B.3.g: /api/status unauth → 401 (regression OK) ✓"

RC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57777/api/health)
test "$RC" = "200" && echo "B.3.h: /api/health → 200 (auth bypass preserved) ✓"

# Auth flow — login.html valid tokens accepted
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:57777/api/status | jq -c '{version, agents_total: .agents.total}' && echo "B.3.i: /api/status with valid token ✓"

kill $PID
```

### B.4 — Static-asset content sanity

```bash
TOKEN=$(printf 'c%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=57778 node dashboard/index.js > /tmp/E1-boot2.out 2>&1 &
PID=$!
sleep 2

# index.html contains expected markers
curl -fsS http://127.0.0.1:57778/ | grep -qE '<script type="module">' && echo "B.4.a: index has ESM script ✓"
curl -fsS http://127.0.0.1:57778/ | grep -qE 'href="/css/dashboard\.css"' && echo "B.4.b: index links css ✓"
curl -fsS http://127.0.0.1:57778/ | grep -qE 'requireToken|api\.js|shell\.js' && echo "B.4.c: index imports auth/api/shell ✓"

# login.html contains the form + validation pattern
curl -fsS http://127.0.0.1:57778/login.html | grep -qE 'pattern="\[a-f0-9\]\{64\}"' && echo "B.4.d: login form has hex pattern ✓"
curl -fsS http://127.0.0.1:57778/login.html | grep -qE 'setToken|isValidTokenFormat' && echo "B.4.e: login uses auth.js ✓"

# auth.js exports the locked surface
curl -fsS http://127.0.0.1:57778/js/auth.js | grep -qE 'export function getToken' && echo "B.4.f: auth exports getToken ✓"
curl -fsS http://127.0.0.1:57778/js/auth.js | grep -qE 'export function clearToken' && echo "B.4.g: auth exports clearToken ✓"
curl -fsS http://127.0.0.1:57778/js/auth.js | grep -qE 'export function requireToken' && echo "B.4.h: auth exports requireToken ✓"

# api.js exports
curl -fsS http://127.0.0.1:57778/js/api.js | grep -qE 'export async function apiFetch' && echo "B.4.i: api exports apiFetch ✓"
curl -fsS http://127.0.0.1:57778/js/api.js | grep -qE 'export async function apiJson' && echo "B.4.j: api exports apiJson ✓"

# shell.js exports
curl -fsS http://127.0.0.1:57778/js/shell.js | grep -qE 'export function renderShell' && echo "B.4.k: shell exports renderShell ✓"

kill $PID
```

### B.5 — Diff-lock confirmation

```bash
cd ~/neato-hive
git diff --stat main...feat/v1.5.0-E.1-shell-token-auth
# Expected: exactly 8 lines:
#   dashboard/app.js (modified)
#   dashboard/public/index.html
#   dashboard/public/login.html
#   dashboard/public/css/dashboard.css
#   dashboard/public/js/auth.js
#   dashboard/public/js/api.js
#   dashboard/public/js/shell.js
#   dashboard/test/static.test.js

# pnpm-lock.yaml MUST NOT change
git diff main...feat/v1.5.0-E.1-shell-token-auth -- dashboard/pnpm-lock.yaml
# Expected: empty
```

### B.6 — No new deps anywhere

```bash
git diff main...feat/v1.5.0-E.1-shell-token-auth -- 'dashboard/package.json' \
  | grep -E '^\+\s+"' | head -10
# Expected: empty (no new dependency lines in package.json)
```

### B.7 — No PM2 verbs anywhere

```bash
git diff main...feat/v1.5.0-E.1-shell-token-auth | grep -E '^\+.*pm2 (start|restart|reload|delete|save|stop|kill)' | head -5
# Expected: empty.
```

### B.8 — Cleanup

```bash
rm -f /tmp/E1-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 8 paths exactly (7 new + `dashboard/app.js` modified)
- [ ] `dashboard/pnpm-lock.yaml` UNCHANGED
- [ ] `dashboard/package.json` UNCHANGED (no new deps)
- [ ] B.1 test suite: 6 new tests pass (static.test.js); total ≥ 115 with D.x carry-over
- [ ] B.2 lockfile reproducible
- [ ] B.3 live boot smoke: frontend assets served (no auth) + API routes still gated + /api/health bypass preserved
- [ ] B.4 content sanity: index/login/css/js all carry the expected markers
- [ ] B.5 diff-lock = 8 paths; pnpm-lock.yaml unchanged
- [ ] B.6 no new deps in package.json
- [ ] B.7 no PM2 verbs
- [ ] **No frontend test framework introduced** — vanilla JS, ZERO frontend unit tests in E.1 (architectural decision documented in §Architectural givens; revisit at E.4 or J.1 if it bites)
- [ ] **Live ~/neato-hive/.env, ~/.neato-hive/state/, ~/.neato-hive/migrations/, shadow files UNCHANGED** by worker
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.7 outputs verbatim, diff-lock confirmation, "no new deps" attestation, sample asset outputs (curl head + first 30 lines of each file, redacted of any tokens)

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 8 paths (7 new + dashboard/app.js modified)
Branch: feat/v1.5.0-E.1-shell-token-auth

Pre-flight outputs:
  1. framework HEAD: <sha>
  2. D.4 dashboard surface present: ✓
  3. E.1 target paths absent: ✓
  4. existing app.js middleware order: <captured>
  5. pre-existing test suite: 109 passing ✓
  6. tooling: node ≥22 ✓ pnpm ✓ curl ✓ jq ✓

Tests:
  B.1 test suite (pnpm test):
    - existing 109 D.x tests: passing
    - dashboard/test/static.test.js (E.1): 6 passed
    Total: 115 tests passing
  B.2 lockfile reproducible: ✓
  B.3 live boot smoke:
    - GET / 200 (no auth) ✓
    - GET /login.html 200 (no auth) ✓
    - GET /css/dashboard.css 200 + text/css ✓
    - GET /js/auth.js 200 + js content-type ✓
    - GET /api/status unauth 401 (regression OK) ✓
    - GET /api/health 200 (auth bypass preserved) ✓
    - GET /api/status with token 200 ✓
  B.4 content sanity:
    - index.html: ESM + css link + auth/api/shell imports ✓
    - login.html: pattern="[a-f0-9]{64}" + setToken usage ✓
    - auth.js: getToken/clearToken/requireToken exports ✓
    - api.js: apiFetch/apiJson exports ✓
    - shell.js: renderShell export ✓
  B.5 diff-lock = 8 paths ✓; pnpm-lock.yaml unchanged ✓
  B.6 no new deps in package.json ✓
  B.7 no PM2 verbs ✓

Worker scope attestations:
  - Live ~/neato-hive/.env unchanged
  - Live ~/.neato-hive/state/ unchanged
  - Live ~/.neato-hive/migrations/ unchanged
  - Live shadow files unchanged
  - dashboard/pnpm-lock.yaml unchanged
  - dashboard/package.json unchanged
  - No PM2 verbs executed
  - No frontend test framework added (vanilla JS only)

Sample assets (head/first lines):
  index.html → <head + first 20 lines>
  login.html → <head + first 20 lines>
  auth.js → <full file, 30-50 lines>
  api.js → <full file, 30-50 lines>

Diff-lock confirmation:
  git diff --stat main...feat/v1.5.0-E.1-shell-token-auth
  <verbatim — exactly 8 lines>

DO NOT MERGE. House-md merges per adjusted v1.5.0 loop.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — full shell + login + auth/api/shell modules + index placeholder + 6 backend tests in single PR.
- **DO NOT MERGE** — house-md
- **DO NOT INTRODUCE A FRONTEND FRAMEWORK** — vanilla HTML + ESM JavaScript only. No React, no Vue, no Solid, no Svelte, no Alpine, no htmx. If a future E.x leaf REALLY needs a framework, that's a separate spec amendment with explicit owner sign-off. E.1 ships zero framework deps.
- **DO NOT INTRODUCE A FRONTEND TEST HARNESS** — no jsdom, no happy-dom, no Playwright, no Cypress in E.1. Pure-function utilities CAN be added in later leaves with `node --test` + dynamic ESM import; DOM-rendering tests are SKIP for v1.
- **DO NOT INTRODUCE A BUILD STEP** — files served exactly as written. No bundler, minifier, source-map config, or postcss.
- **DO NOT EXTEND DEPENDENCIES** — production stays at `express` + `dotenv`. `package.json` MUST NOT change.
- **DO NOT BREAK D.x TESTS** — 109 → 115 (6 added). Use the existing `createApp` factory shape additively.
- **DO NOT TRIM TOKEN INPUT** — preserves byte-exact match with D.1's middleware. Input element has `pattern="[a-f0-9]{64}"`; whitespace-padded tokens fail client-side regex BEFORE submit.
- **DO NOT OPEN-REDIRECT** — login page sanitizes `?return=` to same-origin paths starting with `/` and not `//`.
- **STATIC SERVING IS BEFORE THE AUTH GATE** — frontend assets are public; the API they talk to is gated. This is the locked Express middleware order.
- **STATE ENUM TOKENS LOCKED** — `--status-pass` / `--status-warn` / `--status-fail` / `--status-info` for D.0a doctor envelope. `--activity-idle` / `--activity-turn` / `--activity-task` for D.2 current_activity. E.2 forward-consumes these.
- **NAV_LINKS LIST LOCKED** — Overview, Agents, Tasks, Doctor, Updates, Backups. Renamed/added in subsequent leaves only via spec amendment. E.1 ships only Overview + login.html; the other links 404 until their E.x leaves merge — that's expected.
- **HALT-and-ping rule** — pre-flight surprises (D.4 surface missing, dashboard/public/ already exists, app.js middleware order changed, pre-existing tests failing) stop the worker.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings house-md `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **E.2 Overview** — replaces `index.html` body with the real Overview render. Consumes `/api/status` (5s poll) + uses `--activity-idle/-turn/-task` color tokens for agent pills + renders `recent_events` subsection.
- **E.3 Agent detail** — adds `agent-detail.html`. Consumes `/api/agents/:name` + `/api/agents/:name/logs`. Tail polls `/api/agents/:name` at 1s for `current_activity` updates.
- **E.4 Doctor** — adds `doctor.html`. Consumes `/api/doctor`. Renders by `category` per the D.0a envelope. May introduce the first frontend pure-function utility worth testing (status → color mapper). If so, add it via `node --test` + dynamic import; this is the escape hatch noted in §Architectural givens.
- **E.5 Updates** — adds `updates.html`. Consumes `/api/update/check` (button gate per owner directive: hide/disable when `update_available !== true`); calls `/api/update/apply` on click; opens `EventSource('/api/update/progress/:id')` + falls back to polling `/api/update/status/:id` on `EventSource.onerror`. Renders C.6 phase vocabulary as progress bar; renders C.7 `migration-pm2-reload-pending` event detail as a banner. Highest implementation risk in Phase E; built last.
- **E.6 Backups** — adds `backups.html`. Consumes `/api/backups`. CTA to copy `hive update --rollback <id>` to clipboard.
- **E.7 Tasks** — adds `tasks.html`. Consumes `/api/tasks` (sort by `elapsed_ms` desc; 5s auto-refresh) + `/api/sessions/active` for "live now" filter. Cancel button calls `hive task cancel <id>` (forward-link — that CLI subcommand is post-E scope, not yet specced).
- **Future leaf — frontend type hints:** `JSDoc` annotations are sufficient for v1. If type-checking pressure builds, a future leaf may add `tsc --noEmit` against `*.d.ts` declaration files for the public modules without introducing TypeScript proper. Out of E.1 scope.
- **Future leaf — neato-brand polish:** v1.5.0 dashboard ships with stripped-down brand tokens. A post-v1.5.0 polish leaf may consume the full `neato-brand` skill (Inter font, full palette, gradient stripe) for stricter brand alignment. Not blocking.
