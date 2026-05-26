# α.1 — WebSocket Server Skeleton + Auth + Connection Registry

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on framework feature branch `feat/dashboard-chat-mirror`. **WORKFLOW LOCK (Daniel 2026-05-10): ALL spec commits + leaf merges land on `feat/dashboard-chat-mirror`, NOT on main.** Reason: keep main clean for the live v1.5.0 installer URL. Feature branch merges to main as a single owner-paced ceremony when chat-mirror is complete + verified end-to-end.
**Project:** dashboard-chat-mirror (v1.5.x)
**Phase:** α — Backend WebSocket infrastructure (4 PRs)
**Leaf:** α.1 (1 of 4 in Phase α)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** v1.5.0 SHIPPED. dashboard-chat-mirror project doc authored at `agents/raymond-holt/projects/dashboard-chat-mirror.md`. House-md's 2026-05-10 architectural read locked Decisions A–G + 4 extra concerns.
**Successor:** α.2 (chat-bus in-memory pub/sub between Discord ingress + WS server + JSONL writer).

---

## Goal

Stand up the WebSocket server infrastructure inside the existing dashboard Express app. No chat-bus, no Discord tap, no message protocol beyond heartbeat — JUST the WS server skeleton + auth handshake + per-connection registry.

This leaf is intentionally narrow. It proves the architecture (Decision B: `ws` npm package attached to existing Express via `createServer(app)`) works without committing to message-flow surface area. Subsequent α leaves wire chat ingress (α.3), the chat-bus (α.2), and the full message protocol (α.4) on top of this foundation.

**Locked behavior:**

1. **WS server attached at path `/api/chat/ws`** via `new WebSocketServer({ server, path: '/api/chat/ws' })`. The existing Express HTTP server is wrapped by `http.createServer(app)`; the WS server upgrades on that path only.
2. **Auth via `?token=<64-hex>` query parameter** (Decision F). Reuse `tokenFromRequest()` from `dashboard/middleware/auth.js` (D.1 + E.5's query-param extension). Auth happens at WebSocket upgrade time; failures close with code `1008` (policy violation).
3. **Access-log token sanitization.** Any logging emitted by ws.js (connection open, close, error, etc.) MUST scrub `?token=...` from URLs before write. Use a `sanitizeUrl()` helper.
4. **Per-connection registry** with this state: `{client_id, ws, connected_at, last_ack_seen, subscribed_channels, reconnect_token}`. `client_id` is a UUIDv4 minted at connection-accept time. `subscribed_channels: []` initialized empty (channel subscription is α.4's concern). `last_ack_seen: -1` initialized (reconnect ack pattern wired in α.4). `reconnect_token` is a 32-hex random string the client can present on a future connect to resume from `last_ack_seen` (full reconnect flow in α.4; α.1 just mints + stores the token).
5. **Heartbeat ping/pong** every 30 seconds. Server sends `ping` frame; client must respond with `pong` within 60 seconds or the server closes the connection (code `1011`, "going away — heartbeat timeout"). The `ws` library handles ping/pong natively; we configure `clientTracking: true` + a polling interval.
6. **Connection lifecycle logging** to stderr (matches existing dashboard logging convention): `[hive-dashboard ws] connect <client_id> from <sanitized_url>`, `[hive-dashboard ws] disconnect <client_id> reason=<code>`.

**Owner directive lock (carried from chat-mirror project doc Decision F):** token-in-URL is the only path for browser WebSocket clients. Sanitization at log-emit time is the discipline that prevents accidental log-grep leaks.

**Non-goals (explicit drops for this leaf):**

- No chat-bus pub/sub (α.2)
- No Discord message ingest (α.3)
- No actual message-send / message-receive protocol beyond heartbeat (α.4)
- No JSONL writes (Phase β)
- No frontend chat UI (Phase γ)
- No reconnect-replay logic beyond minting + storing reconnect_token (α.4)
- No rate limiting on connections (future leaf if abuse surfaces)
- No CORS for cross-origin WS (the dashboard is single-origin via Tailscale; cross-origin not in scope)

---

## Architectural givens (carried)

### From D.1 — `dashboard/middleware/auth.js`

```js
function tokenFromRequest(req) {
  // Header first: Authorization: Bearer <token>
  // Then query param: ?token=<token>
  // Returns the token string or null.
}
```

α.1 reuses this for WS upgrade auth. The WS server invokes `tokenFromRequest({headers: req.headers, query: parsedQuery})` during the upgrade handshake.

### From existing `dashboard/index.js`

The dashboard currently does:
```js
const { createApp } = require('./app');
const app = createApp({ token: process.env.HIVE_DASHBOARD_TOKEN });
const port = process.env.HIVE_DASHBOARD_PORT || 7777;
app.listen(port, '0.0.0.0', () => {...});
```

α.1 changes this to use an explicit HTTP server so the WS server can attach:
```js
const http = require('node:http');
const { createApp } = require('./app');
const { attachWsServer } = require('./lib/ws');

const app = createApp({ token: process.env.HIVE_DASHBOARD_TOKEN });
const server = http.createServer(app);
attachWsServer(server, { token: process.env.HIVE_DASHBOARD_TOKEN });
server.listen(port, '0.0.0.0', () => {...});
```

`createApp` itself doesn't change in α.1 — only the bootstrap module switches from `app.listen` to `http.createServer + server.listen`.

### From E.5 — `dashboard/public/js/api.js`

E.5 introduced `?token=<token>` query-param auth for EventSource (also can't send custom headers). α.1's `?token=` flow on WS is the same pattern. Same `tokenFromRequest()` helper.

### `ws` npm package — locked as the WebSocket library

Per Decision B: `ws` (npm). NOT socket.io, NOT @types/ws-only, NOT a fork. Latest stable at time of spec lock. Worker pins via `pnpm add ws` which generates the lockfile entry.

Notes on `ws` choice:
- Maintained by Einaros, used by Node ecosystem extensively
- Tiny footprint (no polyfills)
- Server + client class-based API
- Native ping/pong via `ws.ping()` + `ws.on('pong')`
- Connection-per-client model (no rooms abstraction — we manage that in α.2's chat-bus)

---

## Pre-conditions

- v1.5.0 SHIPPED + framework HEAD includes J.1.0.6 merge (`967f027`).
- dashboard-chat-mirror project doc at `agents/raymond-holt/projects/dashboard-chat-mirror.md` (raymond-holt's projects dir — for context; not in framework repo).
- `dashboard/middleware/auth.js` includes `tokenFromRequest()` from E.5 (`?token=` query-param support).
- `dashboard/index.js` currently uses `app.listen()` (NOT yet `http.createServer + server.listen`).
- Node ≥ 22 (matches existing dashboard requirement).

---

## Where state lives (α.1 conventions)

**New files (2):**
- `dashboard/lib/ws.js` — the WS server module
- `dashboard/test/ws.test.js` — node:test for the module

**Modified files (3):**
- `dashboard/index.js` — switch from `app.listen()` to `http.createServer(app) + attachWsServer + server.listen()`
- `dashboard/package.json` — add `ws` dependency
- `dashboard/pnpm-lock.yaml` — regenerated to include `ws`

**Total: 5 paths.**

---

## Pre-flight (worker MUST run all 6; outputs captured in PR body)

### 1. Framework repo current state — feature-branch checkout

```bash
cd ~/neato-hive
git fetch origin feat/dashboard-chat-mirror
git checkout feat/dashboard-chat-mirror
git pull origin feat/dashboard-chat-mirror
git log --oneline -5
```

Expected: HEAD includes `967f027` (J.1.0.6 merge — chat-mirror project succeeds v1.5.0 ship) PLUS the α.1 spec commit on the feature branch.

**Branch the leaf FROM `feat/dashboard-chat-mirror`, merge BACK to `feat/dashboard-chat-mirror`.** Bob's leaf branch is `feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton` and his PR targets `feat/dashboard-chat-mirror` (NOT main).

### 2. α.1 target paths absent

```bash
test ! -f dashboard/lib/ws.js && echo "dashboard/lib/ws.js absent ✓"
test ! -f dashboard/test/ws.test.js && echo "dashboard/test/ws.test.js absent ✓"
```

**HALT and ping raymond-holt** if either exists.

### 3. Dashboard existing surface intact

```bash
test -f dashboard/index.js && echo "index.js ✓"
test -f dashboard/app.js && echo "app.js ✓"
test -f dashboard/middleware/auth.js && echo "auth.js ✓"
grep -nE '^function tokenFromRequest' dashboard/middleware/auth.js | head -3
# Expected: 1 match (D.1's helper, extended by E.5 with query-param fallback)
```

**HALT and ping raymond-holt** if any missing or `tokenFromRequest` not present.

### 4. Current `dashboard/index.js` uses `app.listen`

```bash
grep -nE 'app\.listen\(' dashboard/index.js | head -3
# Expected: 1 match
grep -nE 'http\.createServer' dashboard/index.js | head -3
# Expected: empty (not yet using createServer)
```

**HALT and ping raymond-holt** if shape differs.

### 5. Dashboard tests baseline

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tail -10
# Expected: 168 tests passing (current baseline post-v1.5.0)
```

Worker captures the count. New test additions in α.1 should add ≥ 6 new tests (locked test count in §A.5).

### 6. Tooling

```bash
node --version && pnpm --version
which jq
```

Expected: Node ≥ 22; pnpm ≥ 10.

---

## A. Deliverables

Single PR on framework repo. Branch: `feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton`. **PR target: `feat/dashboard-chat-mirror` feature branch, NOT main.**

**Diff lock: 5 paths exactly** (2 new + 3 modified).

### A.1 — `dashboard/lib/ws.js`

```javascript
'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { tokenFromRequest } = require('../middleware/auth');

const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 60000;

/**
 * Sanitize a URL string for logging by stripping the `token=` query param.
 * Replaces the value with `<REDACTED>` so we keep the structure visible
 * without leaking the token.
 *
 * Example:
 *   "/api/chat/ws?token=abcdef..." → "/api/chat/ws?token=<REDACTED>"
 *   "/api/chat/ws?token=foo&channel=house-md" → "/api/chat/ws?token=<REDACTED>&channel=house-md"
 */
function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url.replace(/([?&]token=)[^&]*/gi, '$1<REDACTED>');
}

/**
 * Parse query params from a request URL.
 * Returns a plain object {key: value, ...}.
 */
function parseQuery(url) {
  if (typeof url !== 'string') return {};
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const query = url.slice(idx + 1);
  const out = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      out[decodeURIComponent(pair)] = '';
    } else {
      const k = decodeURIComponent(pair.slice(0, eq));
      const v = decodeURIComponent(pair.slice(eq + 1));
      out[k] = v;
    }
  }
  return out;
}

/**
 * Generate a 32-hex-char random reconnect token.
 */
function mintReconnectToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Attach a WebSocket server to an HTTP server.
 *
 * Path: /api/chat/ws
 * Auth: ?token=<token> query param matched against expectedToken via
 *       constant-time compare (via tokenFromRequest's existing logic).
 * Close codes:
 *   1008 - policy violation (auth fail)
 *   1011 - server going away (heartbeat timeout)
 *
 * Returns the WebSocketServer instance + the connection registry.
 */
function attachWsServer(httpServer, { token: expectedToken } = {}) {
  if (!expectedToken || typeof expectedToken !== 'string') {
    throw new Error('attachWsServer: token (expectedToken) is required');
  }

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/chat/ws',
    clientTracking: true,
  });

  const registry = new Map(); // client_id → { ws, connected_at, last_ack_seen, subscribed_channels, reconnect_token }

  wss.on('connection', (ws, req) => {
    const sanitized = sanitizeUrl(req.url || '');
    const query = parseQuery(req.url || '');
    const tokenInUrl = typeof query.token === 'string' ? query.token : null;
    const presentedToken = tokenFromRequest({
      headers: req.headers || {},
      query: { token: tokenInUrl },
    });

    if (typeof presentedToken !== 'string') {
      console.error(`[hive-dashboard ws] auth-fail (no token) from ${sanitized}`);
      ws.close(1008, 'unauthorized');
      return;
    }

    // Constant-time compare via the same buffer pattern as auth middleware
    const presentedBuf = Buffer.from(presentedToken, 'utf8');
    const expectedBuf = Buffer.from(expectedToken, 'utf8');
    if (
      presentedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(presentedBuf, expectedBuf)
    ) {
      console.error(`[hive-dashboard ws] auth-fail (bad token) from ${sanitized}`);
      ws.close(1008, 'unauthorized');
      return;
    }

    const clientId = crypto.randomUUID();
    const reconnectToken = mintReconnectToken();
    const state = {
      ws,
      connected_at: new Date().toISOString(),
      last_ack_seen: -1,
      subscribed_channels: [],
      reconnect_token: reconnectToken,
    };
    registry.set(clientId, state);

    console.error(`[hive-dashboard ws] connect ${clientId} from ${sanitized}`);

    // Send initial server-hello so the client gets its client_id + reconnect_token.
    // The full protocol envelope is locked in α.4; for α.1 this is a minimal
    // hello frame so tests can verify connection acceptance.
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        client_id: clientId,
        reconnect_token: reconnectToken,
      }));
    } catch (err) {
      console.error(`[hive-dashboard ws] hello-send failed for ${clientId}: ${err.message}`);
    }

    // Heartbeat liveness — server pings periodically; client must respond
    // with pong within the timeout or the connection is terminated.
    let isAlive = true;
    ws.on('pong', () => { isAlive = true; });

    const heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        console.error(`[hive-dashboard ws] heartbeat-timeout ${clientId}`);
        try { ws.terminate(); } catch { /* already closed */ }
        return;
      }
      isAlive = false;
      try { ws.ping(); } catch { /* connection dying */ }
    }, HEARTBEAT_INTERVAL_MS);

    ws.on('close', (code, reason) => {
      clearInterval(heartbeatInterval);
      registry.delete(clientId);
      console.error(`[hive-dashboard ws] disconnect ${clientId} code=${code} reason=${reason}`);
    });

    ws.on('error', (err) => {
      console.error(`[hive-dashboard ws] error ${clientId} ${err.message}`);
    });

    // α.1 does NOT handle message receipt beyond protocol enrichment in α.4.
    // For α.1 we accept incoming frames but log + drop them with a "not yet wired" notice.
    ws.on('message', (data) => {
      console.error(`[hive-dashboard ws] message-drop ${clientId} (protocol wires in α.4)`);
    });
  });

  return { wss, registry };
}

module.exports = { attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken };
```

**Locked semantics:**

- WS path is `/api/chat/ws` exactly — α.4 references this path in the client.
- Auth-fail closes with `1008` (policy violation) — standard WS code for auth.
- Heartbeat-timeout closes with `1011` (server going away) — protocol-defined for server-side termination.
- Hello frame is the minimal protocol envelope α.1 ships; α.4 expands the full message-send / message-receive protocol on the same connection.
- `registry` is exported via the return value so α.2 (chat-bus) can pub/sub against it.
- `sanitizeUrl()` is exported for reuse by other ws.js consumers (and by α.4's reconnect-URL handling).

### A.2 — `dashboard/index.js` modifications

Replace the existing bootstrap section with:

```javascript
'use strict';

const http = require('node:http');
const { createApp } = require('./app');
const { attachWsServer } = require('./lib/ws');

const token = process.env.HIVE_DASHBOARD_TOKEN;
if (!token) {
  console.error('hive-dashboard: HIVE_DASHBOARD_TOKEN required in env');
  process.exit(1);
}

const port = parseInt(process.env.HIVE_DASHBOARD_PORT || '7777', 10);

const app = createApp({ token });
const server = http.createServer(app);
attachWsServer(server, { token });

server.listen(port, '0.0.0.0', () => {
  console.error(`hive-dashboard listening on 0.0.0.0:${port}`);
});
```

**Key changes from current `dashboard/index.js`:**
- Replaces `app.listen(...)` with explicit `http.createServer(app)` + `server.listen(...)` so WS can attach.
- Adds `attachWsServer(server, {token})` call right before `server.listen()`.
- Token validation moved up so the WS attach can read it.

If the current `dashboard/index.js` has additional bootstrap logic (e.g. log lines, signal handlers), preserve it verbatim. Only the listen-call swap is in scope.

### A.3 — `dashboard/package.json` add `ws` dependency

Add `"ws"` to `dependencies` (NOT devDependencies — production-required for the WS server to run). Pin to current stable `^8.18.0` or the latest stable when worker runs (don't override pnpm's natural resolution).

```diff
   "dependencies": {
     "dotenv": "^16.4.5",
-    "express": "^4.19.2"
+    "express": "^4.19.2",
+    "ws": "^8.18.0"
   }
```

**Worker discipline:** add ONLY the `ws` line. No other dep changes. Sort alphabetically (existing convention puts `express` before `ws` — alphabetic).

### A.4 — `dashboard/pnpm-lock.yaml` regenerated

Worker runs `pnpm install` inside `dashboard/` to regenerate the lockfile with the new `ws` entry. Lockfile is git-tracked. The diff will be ~30-50 lines (new ws entry + its single dependency `@types/node` which `ws` doesn't have at runtime — just `ws` itself).

**Worker discipline:** only the `ws` entry should change. NO other version bumps (existing deps stay pinned). Verify by `git diff --stat` showing 1 modified file (pnpm-lock.yaml).

### A.5 — `dashboard/test/ws.test.js`

`node --test` suite for the ws module. Locked test cases (6):

1. **`sanitizeUrl()` redacts `token=` parameter:**
   - `sanitizeUrl('/api/chat/ws?token=abc123')` → `'/api/chat/ws?token=<REDACTED>'`
   - `sanitizeUrl('/api/chat/ws?token=foo&channel=bar')` → `'/api/chat/ws?token=<REDACTED>&channel=bar'`
   - `sanitizeUrl('/api/chat/ws')` → `'/api/chat/ws'`
   - `sanitizeUrl(null)` → `''`

2. **`parseQuery()` extracts params:**
   - `parseQuery('/api/chat/ws?token=abc&channel=hivemind')` → `{token: 'abc', channel: 'hivemind'}`
   - `parseQuery('/path-no-query')` → `{}`
   - `parseQuery('/api/chat/ws?token=&empty=')` → `{token: '', empty: ''}`

3. **`mintReconnectToken()` produces 32-hex-char string:**
   - Length 32, regex `^[a-f0-9]+$`
   - Two consecutive calls return different values

4. **WS auth-fail without token:** Spin up a test HTTP server, attach ws server, attempt WS connection WITHOUT `?token=`. Expect close with code 1008.

5. **WS auth-fail with bad token:** Spin up a test HTTP server, attach ws server with token "expected", attempt WS connection with `?token=wrong`. Expect close with code 1008.

6. **WS auth-pass + hello frame:** Spin up a test HTTP server, attach ws server, attempt WS connection with correct `?token=`. Expect open event + hello message with `client_id` (UUID format) + `reconnect_token` (32-hex). Then close cleanly.

Test harness uses `node --test`. WS client side uses `new WebSocket('ws://...')` from the `ws` package (which has both server and client).

**Worker scope safety:** test starts/stops the HTTP server on an ephemeral port (e.g. 0, OS-assigned). Never reuses port 7777. Cleans up sockets at end of each test.

---

## B. Tests + verification

### B.1 — bash -n + Node syntax check on changed files

```bash
node --check dashboard/lib/ws.js && echo "ws.js syntax ✓"
node --check dashboard/index.js && echo "index.js syntax ✓"
node --check dashboard/test/ws.test.js && echo "ws.test.js syntax ✓"
```

### B.2 — Test suite runs clean

```bash
cd ~/neato-hive/dashboard
HIVE_DASHBOARD_TOKEN=$(printf 'a%.0s' {1..64}) pnpm test 2>&1 | tee /tmp/alpha1-test.out | tail -15
# Expected: 168 baseline + 6 new ws tests = 174 tests passing
grep -E '✔|pass' /tmp/alpha1-test.out | wc -l
```

### B.3 — Lockfile reproducibility

```bash
cd ~/neato-hive/dashboard
pnpm install --frozen-lockfile
echo "lockfile reproducible ✓"
pnpm list --depth=0 --prod
# Expected: dotenv + express + ws (3 prod deps)
```

### B.4 — Live boot smoke: WS connection accepts + closes cleanly

```bash
TOKEN=$(printf 'b%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=37790 \
  node dashboard/index.js > /tmp/alpha1-boot.out 2>&1 &
PID=$!
sleep 2

# Successful WS connect via the ws CLI client (npx wscat is the easiest)
echo "--- ws connect with correct token ---"
timeout 3 npx wscat -c "ws://127.0.0.1:37790/api/chat/ws?token=$TOKEN" 2>&1 | head -5
# Expected: "Connected" + the hello frame with client_id + reconnect_token

echo "--- ws connect with WRONG token ---"
timeout 3 npx wscat -c "ws://127.0.0.1:37790/api/chat/ws?token=wrong" 2>&1 | head -5
# Expected: connection closed with code 1008

kill $PID
```

If `wscat` isn't available, alternative: write a tiny Node script that uses the `ws` client to verify the same behavior.

### B.5 — Token sanitization in logs

```bash
TOKEN=$(printf 'c%.0s' {1..64})
HIVE_DASHBOARD_TOKEN=$TOKEN HIVE_DASHBOARD_PORT=37791 \
  node dashboard/index.js > /tmp/alpha1-sanitize.out 2>&1 &
PID=$!
sleep 2

# Connect, then check the log for token leak
timeout 3 npx wscat -c "ws://127.0.0.1:37791/api/chat/ws?token=$TOKEN" >/dev/null 2>&1 || true

grep -E "$TOKEN" /tmp/alpha1-sanitize.out && echo "FAIL — token leaked to stderr" || echo "B.5: no token leak ✓"
grep -E "<REDACTED>" /tmp/alpha1-sanitize.out && echo "B.5: redaction marker present ✓"

kill $PID
```

### B.6 — Diff-lock confirmation

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton
# Expected: 5 files
#   dashboard/lib/ws.js (new)
#   dashboard/test/ws.test.js (new)
#   dashboard/index.js (modified)
#   dashboard/package.json (modified)
#   dashboard/pnpm-lock.yaml (modified)
```

### B.7 — No NAV_LINKS edits

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton -- dashboard/public/js/shell.js
# Expected: empty (chat NAV link added in Phase γ, not here)
```

### B.8 — No frontend changes

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton -- 'dashboard/public/**' | head -3
# Expected: empty (all changes are backend-only in α.1)
```

### B.9 — Cleanup

```bash
rm -f /tmp/alpha1-*.out
```

---

## C. Acceptance / hard gates

- [ ] Diff lock: 5 paths exactly (2 new + 3 modified)
- [ ] B.1 `node --check` clean on all 3 changed/new .js files
- [ ] B.2 test suite: 6 new ws tests pass; total ≥ 174 (168 baseline + 6 new)
- [ ] B.3 lockfile reproducible; prod deps = `dotenv + express + ws` (no extras)
- [ ] B.4 live boot smoke: correct-token WS connect succeeds + hello frame received; wrong-token closes with 1008
- [ ] B.5 token sanitization: token does NOT appear in stderr logs; `<REDACTED>` marker present
- [ ] B.6 diff-lock = 5 paths
- [ ] B.7 no NAV_LINKS edits in `shell.js`
- [ ] B.8 no `dashboard/public/**` changes (backend-only leaf)
- [ ] **WS path locked at `/api/chat/ws`** — α.4 + frontend depend on this exactly
- [ ] **Auth via `?token=` query param** — Decision F (browser WS API constraint)
- [ ] **Auth-fail close code = 1008** — protocol-standard for policy violation
- [ ] **Heartbeat-timeout close code = 1011** — protocol-standard for server going away
- [ ] **Token sanitization in all log output** — Decision F access-log requirement
- [ ] **Per-connection registry exported** — α.2 chat-bus will consume it
- [ ] **No CHANGELOG.md update** — Phase α leaves don't bump CHANGELOG; ζ.3 handles release-doc updates
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.8 outputs verbatim, sample WS connect + hello frame transcript, sample token-sanitization log excerpt, diff-lock confirmation

---

## D. When done (DONE block)

```text
PR URL: <gh url>
Diff: 5 paths (2 new + 3 modified)
Branch: feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton (targets feat/dashboard-chat-mirror, NOT main)

Pre-flight outputs:
  1. framework HEAD: <sha — includes J.1.0.6 967f027>
  2. α.1 target paths absent: ✓
  3. dashboard surface intact + tokenFromRequest present: ✓
  4. dashboard/index.js uses app.listen (not yet createServer): ✓
  5. dashboard test baseline: 168 passing
  6. tooling: node ≥22 ✓ pnpm ≥10 ✓

Tooling check:
  node --check dashboard/lib/ws.js: ✓
  node --check dashboard/index.js: ✓
  node --check dashboard/test/ws.test.js: ✓

Tests:
  B.2 test suite: 168 baseline + 6 new = 174 passing ✓
  B.3 lockfile reproducible: ✓
       prod deps = dotenv + express + ws ✓
  B.4 live boot smoke:
    - correct-token WS connect → hello frame received with client_id + reconnect_token ✓
    - wrong-token WS connect → closed with code 1008 ✓
  B.5 token sanitization:
    - token NOT in stderr ✓
    - <REDACTED> marker present ✓
  B.6 diff-lock = 5 paths ✓
  B.7 no NAV_LINKS edits ✓
  B.8 no frontend changes ✓

Worker scope attestations:
  - No dashboard/public/** changes
  - No CHANGELOG.md changes
  - No bin/hive changes
  - No agents/ changes
  - Existing tokenFromRequest() in dashboard/middleware/auth.js UNCHANGED
  - prod deps post-leaf: dotenv + express + ws (no other additions)

Sample WS connect transcript (token redacted):
  <verbatim wscat output showing hello frame>

Sample token-sanitization log excerpt:
  <verbatim stderr showing <REDACTED> in URL>

Diff-lock confirmation:
  git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.1-ws-server-skeleton
  <verbatim — exactly 5 lines>

DO NOT MERGE. Raymond-holt merges.
```

---

## E. Standing rules

- **DON'T HALF-SHIP** — WS server attach + auth + registry + heartbeat + 6 tests in single PR.
- **DO NOT MERGE** — raymond-holt merges.
- **DO NOT MODIFY `dashboard/middleware/auth.js`** — `tokenFromRequest()` is reused as-is from D.1 + E.5.
- **DO NOT MODIFY `dashboard/app.js`** — `createApp()` shape is unchanged in α.1.
- **DO NOT ADD chat-bus, Discord tap, JSONL writes, or message protocol beyond heartbeat + hello** — those are α.2, α.3, α.4, and Phase β respectively.
- **DO NOT MODIFY `dashboard/public/**`** — frontend chat UI is Phase γ.
- **DO NOT MODIFY NAV_LINKS in `shell.js`** — Phase γ.3 adds the chat link.
- **WS PATH IS LOCKED AT `/api/chat/ws`** — exact string.
- **AUTH VIA `?token=` QUERY PARAM** — Decision F; browser WS API can't send custom headers.
- **TOKEN SANITIZATION MANDATORY IN ALL LOG OUTPUT** — Decision F access-log requirement.
- **CONSTANT-TIME COMPARE FOR AUTH** — reuse `crypto.timingSafeEqual` (matches existing auth middleware).
- **EXISTING TESTS MUST STILL PASS** — 168 baseline + 6 new = 174 total. Zero regressions.
- **NO NEW PROD DEPS BEYOND `ws`** — single new dep, alphabetically ordered in package.json.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises (target paths exist, tokenFromRequest missing, dashboard/index.js shape unexpected, test baseline wrong count) stop the worker. Halt means halt — do not fix-and-proceed inline. Your 7-for-7 L8 discipline pattern is the standard.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **dirty git status whitelist** — `agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/`.

---

## F. Forward links

- **α.2 — chat-bus in-memory pub/sub.** New `dashboard/lib/chat-bus.js`. In-process pub/sub between Discord bot ingress, WS server, and JSONL writer. Channel routing. Sequence-counter per channel. Consumes the `registry` exported by α.1's `attachWsServer()`.
- **α.3 — Discord bot ingress tap.** New `src/messaging/discord-tap.ts`. Intercepts Discord message-create events; enriches with metadata; pushes to chat-bus. ~80 LOC.
- **α.4 — WS protocol (send/recv + reconnect ack).** Expands `ws.js` to handle `{type: "send", channel, content, attachments?}` from client; emits `{type: "message", ...}` for inbound. Wires reconnect-replay flow using `last_ack_seen` + `reconnect_token` minted in α.1. ~150 LOC change to ws.js + new `dashboard/lib/chat-protocol.js`.
- **Phase β — JSONL persistence + attachment mirroring.**
- **Phase γ — Dashboard chat UI** (`/chat.html` + `chat.js`).
- **Phase δ — Agent-side inbound transport** (`src/messaging/inbound.ts`).
- **Phase ε — Failover semantics.**
- **Phase ζ — E2E + dogfood + failover drill.**
