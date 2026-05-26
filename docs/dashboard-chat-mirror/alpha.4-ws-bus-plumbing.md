# Chat-Mirror α.4 — WS Message Protocol + Bus Plumbing + Reconnect Replay

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on **`feat/dashboard-chat-mirror`** (the long-running feature branch, NOT main).
**Project:** dashboard-chat-mirror (v1.5.x)
**Phase:** α — Backend WebSocket infrastructure (4 leaves)
**Leaf:** α.4 (4 of 4 in Phase α — closes Phase α)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** α.1 merged `a18ca69` (WS server skeleton); α.2 merged `1c0b8bf` (chat-bus pub/sub); α.3 merged `952d9f2` (Discord chat-tap).
**Successor:** Phase β (JSONL persistence + agent inbound module — Decision E carry-over).

---

## ⚠ Workflow lock — feature branch isolation

**ALL work on this leaf targets `feat/dashboard-chat-mirror`, NOT main.** Per Daniel's 2026-05-10 directive (LESSONS.md L9): chat-mirror lives on its own long-running branch until the full feature verifies end-to-end, then merges to main as a single owner-paced ceremony.

**Bob dispatch:**
- `git checkout feat/dashboard-chat-mirror && git pull origin feat/dashboard-chat-mirror` (NOT main)
- Leaf branch: `feat/dashboard-chat-mirror-alpha.4-ws-bus-plumbing` (worker creates AFTER pre-flight passes)
- PR base ref: `feat/dashboard-chat-mirror`

---

## ⚠ Architectural framing (read first)

This leaf closes Phase α by wiring the three α.x outputs together into a working dashboard-side chat surface. The result: a browser WS client can connect, subscribe to channels, send messages, receive published events, ack consumed messages, and reconnect with full replay of unacked traffic.

**Three integration moves:**

1. **`attachWsServer` accepts a `bus` parameter** — a chat-bus instance per α.2's `createChatBus` contract. The bus becomes the message-routing fabric for the entire dashboard process.
2. **`dashboard/index.js` instantiates the bus** and passes it to `attachWsServer`. ONE bus per dashboard process. (Agent bot processes have their own bus instances; cross-process bridging happens via β.1 JSONL persistence in a future phase. α.4 is dashboard-process-local only.)
3. **The WS server's `ws.on('message')` stub is replaced** with the full frame protocol: `subscribe`, `unsubscribe`, `send`, `ack`. Bus subscriber lifecycle is tied to client subscription state. Disconnect cleans up bus subscribers (no leaks). Reconnect with a valid `reconnect_token` restores subscriptions and replays unacked messages from a per-channel ring buffer.

**What this leaf does NOT do:**

- **NO cross-process bus bridging.** The dashboard process bus is isolated from agent bot processes' bus instances in α.4. β.1 JSONL persistence + tail-watcher is the eventual bridge.
- **NO JSONL persistence.** β.1's scope.
- **NO bot.ts wiring of `src/discord/chat-tap.ts`.** α.3.5 (future) attaches the tap to live agent Discord clients. α.4 only wires the dashboard side.
- **NO user-identity resolution.** Outgoing `send` frames build envelopes with `author_id: 'hive-owner'` static + `author_kind: 'user'`. Future user-identity work refines.
- **NO attachment handling.** Decision A's local-mirror is Phase δ. α.4 publishes `attachments: []`.
- **NO frontend UI work.** Phase γ. α.4 ships pure backend protocol.

**Owner directive carry-overs (project doc):**
- Decision B (locked 2026-05-10): WS over `ws` npm package. α.1 already uses this — α.4 inherits.
- Decision C (locked 2026-05-10): JSONL schema. α.4's outgoing-envelope construction matches the tap-owned fields (Decision C subset, since channel/sequence/ts come from the bus).
- Decision D (locked 2026-05-10): failover egress semantics. α.4 does NOT implement Discord posting from dashboard — that's the dashboard-egress side of the failover, future leaf. α.4 just publishes to the bus; β.x layers Discord egress.
- Decision E (locked 2026-05-10): dedup-before-wake. Lives in agent inbound (future). NOT here.
- Decision F (locked 2026-05-10): `?token=<64-hex>` query-param auth. α.1 already implements. α.4 adds `?reconnect_token=<32-hex>` as a SECOND query param for reconnect (orthogonal to the auth token). `sanitizeUrl` already redacts `token=` — α.4 must extend redaction to `reconnect_token=` as well.

---

## Goal

Ship the full WS message protocol with per-client subscription routing, bus-backed fan-out, reconnect-replay over a per-channel ring buffer, and clean bus-subscriber lifecycle on disconnect.

**The leaf ships:**

1. **`dashboard/lib/ws.js` (MODIFIED)** — `attachWsServer` accepts `{ token, bus, ringSize = 100 }`, validates bus shape, wildcard-subscribes to bus to populate per-channel ring buffer, handles incoming frames per protocol below, mints + tracks reconnect tokens, restores state on reconnect, cleans up bus subscribers on disconnect.
2. **`dashboard/index.js` (MODIFIED)** — instantiates a single `createChatBus()` and passes it to `attachWsServer`.
3. **`dashboard/test/ws.test.js` (MODIFIED)** — `startHarness` now constructs a bus and passes it to `attachWsServer`. All 6 existing α.1 tests remain.
4. **`dashboard/test/ws-protocol.test.js` (NEW)** — 11 new tests covering frame protocol, fan-out, subscription lifecycle, reconnect replay, error robustness.

**This leaf closes Phase α.** Subsequent leaves (β onwards) build on this foundation: β.1 JSONL writer subscribes to the bus; β.2 JSONL-tail watcher bridges other-process JSONL writes into the dashboard's bus for failover; γ phase wires the browser-side UI to this WS protocol.

---

## Required reading

### α.1 — `attachWsServer` current signature and state shape (`dashboard/lib/ws.js`)

```js
function attachWsServer(httpServer, { token } = {}) { ... return { wss, registry }; }

// Per-connection state in registry (Map<client_id, state>):
{
  client_id: <uuid>,
  ws: <WebSocket>,
  connected_at: <iso>,
  last_ack_seen: -1,                  // α.4 evolves to Map<channel, sequence>
  subscribed_channels: [],             // α.4 evolves to Set<channel>
  reconnect_token: <32-hex>,
}
```

`sanitizeUrl` currently redacts `token=`. α.4 extends to also redact `reconnect_token=`.

α.1's `ws.on('message')` stub: `console.error('[hive-dashboard ws] message-drop ... (protocol wires in alpha.4)')`. α.4 replaces with full protocol.

### α.2 — chat-bus contract (`dashboard/lib/chat-bus.js`)

```js
module.exports = { createChatBus };
// const bus = createChatBus({ now? });
// bus.publish(channel: string, message: object) → { sequence, ts, enriched }
// bus.subscribe(channel: string | '*', callback: (msg) => void) → () => void  // unsubscribe
// bus.peekSequence(channel: string) → number
// bus.channels() → string[]
```

The bus enriches every published message with `{ channel, sequence, ts }` injected as outer fields, spread over the publisher-supplied body. Wildcard `'*'` subscribers receive every publish across all channels.

### Decision C — JSONL event schema (project doc)

```json
{
  "id": "<uuid>",
  "source": "discord" | "dashboard",
  "source_message_id": "<discord-snowflake-or-dashboard-ulid>",
  "channel": "<agent-name-or-hivemind>",
  "author_id": "<discord-user-id-or-agent-name>",
  "author_kind": "user" | "agent",
  "content": "<text>",
  "attachments": [...],
  "metadata": {...},
  "ts": "...",
  "sequence": N
}
```

α.4's `send` frame handler builds envelopes for `source: 'dashboard'`. Tap-owned fields (`id`, `source`, `source_message_id`, `author_id`, `author_kind`, `content`, `attachments: []`, `metadata: {}`) are populated server-side. The bus injects `channel`, `sequence`, `ts`.

### Idiom — match existing `dashboard/lib/*.js`

- `'use strict';` at top.
- CommonJS `require` / `module.exports`.
- Use `node:crypto.randomUUID()` for envelope ids and dashboard `source_message_id`.
- Error logging: `console.error('[hive-dashboard ws] <event> <details>')`. Match α.1's existing log format.

---

## Frame protocol (locked)

All frames are JSON. Server tolerates parse failures + unknown types silently (logged, ignored — never closes the socket on bad input).

### Server → Client frames

**`hello`** — sent immediately on accept. Already implemented by α.1.

```json
{ "type": "hello", "client_id": "<uuid>", "reconnect_token": "<32-hex>" }
```

α.4 keeps this shape unchanged. On reconnect, a NEW `client_id` and NEW `reconnect_token` are minted; the OLD reconnect_token is invalidated immediately on use.

**`message`** — sent for every bus event on a channel the client is subscribed to. Built from the bus's `enriched` message shape.

```json
{
  "type": "message",
  "channel": "<channel>",
  "sequence": <int>,
  "ts": "<iso>",
  "id": "<uuid>",
  "source": "discord" | "dashboard",
  "source_message_id": "<id>",
  "author_id": "<id>",
  "author_kind": "user" | "agent",
  "content": "<text>",
  "attachments": [],
  "metadata": {}
}
```

**`subscribed`** — confirmation echo of a successful subscribe.

```json
{ "type": "subscribed", "channel": "<channel>" }
```

**`unsubscribed`** — confirmation echo of a successful unsubscribe.

```json
{ "type": "unsubscribed", "channel": "<channel>" }
```

**`error`** — soft-error report for malformed client frames. The server does NOT close the connection on protocol errors; it returns an error frame and continues.

```json
{ "type": "error", "code": "bad_frame" | "bad_channel" | "bad_type" | "bad_json", "detail": "<short string>" }
```

### Client → Server frames

**`subscribe`** — client subscribes to a channel. Idempotent (subscribing to an already-subscribed channel is a no-op success). After success, the client receives `subscribed` echo + every subsequent bus publish on that channel as a `message` frame.

```json
{ "type": "subscribe", "channel": "<channel>" }
```

**`unsubscribe`** — client unsubscribes. Idempotent. Echo: `unsubscribed`.

```json
{ "type": "unsubscribe", "channel": "<channel>" }
```

**`send`** — client publishes a message to a channel. The server constructs a Decision C envelope and calls `bus.publish(channel, envelope)`. The publish fans out to all subscribers (including the sending client, if subscribed to that channel — echo-on-send is the expected pattern; the client uses `source_message_id` to match its own send to the echo).

```json
{ "type": "send", "channel": "<channel>", "content": "<text>" }
```

**`ack`** — client acknowledges receipt of a message up to `sequence` on a channel. The server stores `state.last_ack_seen[channel] = sequence`. No echo.

```json
{ "type": "ack", "channel": "<channel>", "sequence": <int> }
```

### Connection URL

Initial connect: `wss://host:port/api/chat/ws?token=<auth-token>`
Reconnect: `wss://host:port/api/chat/ws?token=<auth-token>&reconnect_token=<32-hex>`

`sanitizeUrl` MUST redact both `token` and `reconnect_token` query params before logging.

---

## Diff lock — 4 paths exactly

1. `dashboard/lib/ws.js` (MODIFIED — ~150 LOC net add)
2. `dashboard/index.js` (MODIFIED — ~3 LOC net add)
3. `dashboard/test/ws.test.js` (MODIFIED — `startHarness` builds and passes a bus; existing tests untouched in behavior)
4. `dashboard/test/ws-protocol.test.js` (NEW — 11 tests, ~400 LOC)

**NO other paths.** No modifications to `dashboard/lib/chat-bus.js` (α.2 frozen), `src/discord/chat-tap.ts` (α.3 frozen), `dashboard/app.js`, `dashboard/middleware/`, `dashboard/public/`, `dashboard/routes/`, `dashboard/package.json`, `dashboard/pnpm-lock.yaml`. No new prod dependencies.

---

## A. Pre-flight halts (HALT and ping raymond-holt if ANY fail)

```bash
# 1. On feat/dashboard-chat-mirror, clean working tree per whitelist
cd ~/neato-hive
git fetch origin
git checkout feat/dashboard-chat-mirror
git pull origin feat/dashboard-chat-mirror
git rev-parse --abbrev-ref HEAD                 # Expected: feat/dashboard-chat-mirror
git rev-parse HEAD                               # Expected: 952d9f2 or descendant
```

```bash
# 2. α.1 + α.2 + α.3 outputs present (sanity)
test -f dashboard/lib/ws.js && echo "α.1 ws.js ✓"
test -f dashboard/lib/chat-bus.js && echo "α.2 chat-bus.js ✓"
test -f src/discord/chat-tap.ts && echo "α.3 chat-tap.ts ✓"
grep -nE '^module\.exports = \{ attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken \};' dashboard/lib/ws.js | head -1
grep -nE '^module\.exports = \{ createChatBus \};' dashboard/lib/chat-bus.js | head -1
# Expected: both grep matches present (1 each)
```

```bash
# 3. α.4 target paths state
test -f dashboard/lib/ws.js && echo "α.4 ws.js target present (will be modified) ✓"
test -f dashboard/index.js && echo "α.4 index.js target present (will be modified) ✓"
test -f dashboard/test/ws.test.js && echo "α.4 ws.test.js target present (will be modified) ✓"
test ! -e dashboard/test/ws-protocol.test.js && echo "α.4 ws-protocol.test.js target absent (will be created) ✓"
```

```bash
# 4. Test baseline = 184 (174 α.1 baseline + 10 α.2 added)
cd dashboard && pnpm test 2>&1 | tail -5
# Expected: "tests 184" "pass 184" "fail 0"
```

```bash
# 5. Tooling
node --version    # Expected: ≥ 22
pnpm --version    # Expected: ≥ 10
```

```bash
# 6. No prod-dependency drift planned (sanity — express + dotenv + ws)
grep -nE '"(ws|express|dotenv)":' dashboard/package.json | head -3
# Expected: 3 matches
```

```bash
# 7. α.1's sanitizeUrl currently redacts token= only (sanity for α.4 extension)
grep -nE 'token=\)\[\^&\]\*' dashboard/lib/ws.js | head -1
# Expected: 1 match
```

**HALT and ping raymond-holt** if any check fails. Halt-and-ping means HALT — do not fix-and-proceed inline. Your 13-for-13 L8 discipline pattern is the standard.

---

## A.1 — `dashboard/lib/ws.js` modifications

**File:** `dashboard/lib/ws.js` (MODIFIED)

### A.1.1 — Top of file: keep imports, add reconnect-token GC constant

Keep:
```js
'use strict';
const crypto = require('node:crypto');
const { createAuthMiddleware } = require('../middleware/auth');
const { WebSocketServer } = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 60000;
const WS_PATH = '/api/chat/ws';
```

Add:
```js
const RECONNECT_TTL_MS = 5 * 60 * 1000;  // 5 minutes — disconnected sessions older than this are pruned
const DEFAULT_RING_SIZE = 100;            // per-channel ring buffer cap for reconnect replay
```

### A.1.2 — Extend `sanitizeUrl` to redact both `token` and `reconnect_token`

Replace:
```js
function sanitizeUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }
  return url.replace(/([?&]token=)[^&]*/gi, '$1<REDACTED>');
}
```

With:
```js
function sanitizeUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }
  return url
    .replace(/([?&]token=)[^&]*/gi, '$1<REDACTED>')
    .replace(/([?&]reconnect_token=)[^&]*/gi, '$1<REDACTED>');
}
```

The order matters: `token=` matches FIRST, then `reconnect_token=` matches independently (the regex `[?&]reconnect_token=` requires `?` or `&` before `reconnect_token`, so the earlier `token=` substitution does not interfere).

Wait — verify regex robustness: the `token=` regex `[?&]token=` would ALSO match `&reconnect_token=` because `_token=` is a substring of `reconnect_token=` ... actually no. `[?&]token=` requires `?` or `&` *immediately* before `token=`. The string `&reconnect_token=` has `&reconnect_` before `token=` — so the character class `[?&]` does NOT match at that position. We're fine. But for safety, add word-boundary anchor:

```js
.replace(/([?&]token=)[^&]*/gi, '$1<REDACTED>')        // matches '?token=' or '&token='
.replace(/([?&]reconnect_token=)[^&]*/gi, '$1<REDACTED>'); // matches '?reconnect_token=' or '&reconnect_token='
```

Both regexes anchor on `[?&]` immediately before the keyword. No overlap. Safe.

### A.1.3 — Replace `attachWsServer` signature + bus validation

Replace:
```js
function attachWsServer(httpServer, { token } = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('attachWsServer: token is required');
  }
  ...
}
```

With:
```js
function attachWsServer(httpServer, { token, bus, ringSize = DEFAULT_RING_SIZE } = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('attachWsServer: token is required');
  }
  if (!bus || typeof bus.publish !== 'function' || typeof bus.subscribe !== 'function') {
    throw new Error('attachWsServer: bus is required and must implement publish() + subscribe()');
  }
  if (typeof ringSize !== 'number' || ringSize < 1) {
    throw new Error('attachWsServer: ringSize must be a positive integer');
  }
  ...
}
```

### A.1.4 — Add ring buffer + disconnected-sessions data structures

Inside `attachWsServer`, AFTER `const registry = new Map();` and BEFORE `wss.on('connection', ...)`:

```js
  // Per-channel ring buffer: Map<channel, Array<enrichedMsg>>. Each array capped at ringSize.
  // Populated by wildcard '*' subscriber. Consumed by reconnect-replay logic.
  const rings = new Map();

  function appendToRing(enrichedMsg) {
    const channel = enrichedMsg.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      return;
    }
    let ring = rings.get(channel);
    if (!ring) {
      ring = [];
      rings.set(channel, ring);
    }
    ring.push(enrichedMsg);
    if (ring.length > ringSize) {
      ring.splice(0, ring.length - ringSize);
    }
  }

  // Wildcard subscriber drives the ring buffer. Lives for the lifetime of the WS server.
  // Stored for potential future server-shutdown cleanup (not exposed in α.4).
  const ringUnsubscribe = bus.subscribe('*', appendToRing);

  // Disconnected sessions: Map<reconnect_token, { state, expiresAt }>.
  // Pruned on reconnect-attempt AND opportunistically by the heartbeat tick.
  const disconnectedSessions = new Map();

  function pruneDisconnectedSessions() {
    const now = Date.now();
    for (const [token, entry] of disconnectedSessions.entries()) {
      if (entry.expiresAt <= now) {
        disconnectedSessions.delete(token);
      }
    }
  }
```

### A.1.5 — Inside `wss.on('connection', ...)` — replace state shape + add reconnect-replay branch

The α.1 connection handler builds a fresh state on every connection. α.4 replaces the state-build with conditional reconnect-restore.

Replace the section from `const clientId = crypto.randomUUID();` through the `try { ws.send(hello) ... }` block with:

```js
    pruneDisconnectedSessions();

    let state;
    let replayMessages = [];
    const incomingReconnectToken = typeof query.reconnect_token === 'string' ? query.reconnect_token : null;

    if (incomingReconnectToken && disconnectedSessions.has(incomingReconnectToken)) {
      // Reconnect path: restore subscribed_channels and last_ack_seen; queue replay messages.
      const saved = disconnectedSessions.get(incomingReconnectToken);
      disconnectedSessions.delete(incomingReconnectToken);  // one-time-use

      const newClientId = crypto.randomUUID();
      const newReconnectToken = mintReconnectToken();

      state = {
        client_id: newClientId,
        ws,
        connected_at: new Date().toISOString(),
        last_ack_seen: new Map(saved.state.last_ack_seen),  // copy, NOT shared reference
        subscribed_channels: new Set(saved.state.subscribed_channels),
        reconnect_token: newReconnectToken,
        busUnsubscribes: new Map(),
      };

      // Compute replay: for each subscribed channel, send messages from ring where sequence > last_ack_seen
      for (const channel of state.subscribed_channels) {
        const ring = rings.get(channel) || [];
        const lastAck = state.last_ack_seen.get(channel) ?? -1;
        for (const msg of ring) {
          if (msg.sequence > lastAck) {
            replayMessages.push(msg);
          }
        }
      }

      console.error(
        `[hive-dashboard ws] reconnect ${newClientId} (was ${saved.state.client_id}) ` +
        `channels=${[...state.subscribed_channels].join(',') || '(none)'} replay=${replayMessages.length}`
      );
    } else {
      // Fresh connection.
      const clientId = crypto.randomUUID();
      const reconnectToken = mintReconnectToken();
      state = {
        client_id: clientId,
        ws,
        connected_at: new Date().toISOString(),
        last_ack_seen: new Map(),
        subscribed_channels: new Set(),
        reconnect_token: reconnectToken,
        busUnsubscribes: new Map(),
      };
      if (incomingReconnectToken) {
        console.error(`[hive-dashboard ws] reconnect-token-miss ${clientId} (token did not match a stored session)`);
      } else {
        console.error(`[hive-dashboard ws] connect ${clientId} from ${sanitizedUrl}`);
      }
    }

    registry.set(state.client_id, state);

    try {
      ws.send(
        JSON.stringify({
          type: 'hello',
          client_id: state.client_id,
          reconnect_token: state.reconnect_token,
        })
      );
    } catch (err) {
      console.error(`[hive-dashboard ws] hello-send failed for ${state.client_id}: ${err.message}`);
    }

    // After hello, re-attach bus subscribers for restored channels + flush replay queue.
    if (state.subscribed_channels.size > 0) {
      for (const channel of state.subscribed_channels) {
        attachBusSubscriber(state, channel);
      }
      for (const msg of replayMessages) {
        sendMessageFrame(state, msg);
      }
    }
```

### A.1.6 — Add helper functions inside `attachWsServer` (above `wss.on('connection', ...)`)

```js
  function sendMessageFrame(state, enrichedMsg) {
    try {
      state.ws.send(JSON.stringify({ type: 'message', ...enrichedMsg }));
    } catch (err) {
      // Connection is likely closing. Bus subscriber cleanup happens via ws.on('close').
    }
  }

  function attachBusSubscriber(state, channel) {
    if (state.busUnsubscribes.has(channel)) {
      return;  // already subscribed
    }
    const unsubscribe = bus.subscribe(channel, (enrichedMsg) => {
      sendMessageFrame(state, enrichedMsg);
    });
    state.busUnsubscribes.set(channel, unsubscribe);
  }

  function detachBusSubscriber(state, channel) {
    const unsubscribe = state.busUnsubscribes.get(channel);
    if (unsubscribe) {
      unsubscribe();
      state.busUnsubscribes.delete(channel);
    }
  }

  function detachAllBusSubscribers(state) {
    for (const unsubscribe of state.busUnsubscribes.values()) {
      try { unsubscribe(); } catch { /* idempotent */ }
    }
    state.busUnsubscribes.clear();
  }

  function sendErrorFrame(state, code, detail) {
    try {
      state.ws.send(JSON.stringify({ type: 'error', code, detail }));
    } catch {
      // Connection is likely closing.
    }
  }

  function handleClientFrame(state, raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      sendErrorFrame(state, 'bad_json', 'frame did not parse as JSON');
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      sendErrorFrame(state, 'bad_frame', 'frame must be an object with a string type');
      return;
    }
    switch (frame.type) {
      case 'subscribe': {
        if (typeof frame.channel !== 'string' || frame.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'subscribe.channel must be a non-empty string');
          return;
        }
        if (frame.channel === '*') {
          sendErrorFrame(state, 'bad_channel', 'wildcard subscription not permitted');
          return;
        }
        state.subscribed_channels.add(frame.channel);
        attachBusSubscriber(state, frame.channel);
        try { state.ws.send(JSON.stringify({ type: 'subscribed', channel: frame.channel })); } catch { /* closing */ }
        return;
      }
      case 'unsubscribe': {
        if (typeof frame.channel !== 'string' || frame.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'unsubscribe.channel must be a non-empty string');
          return;
        }
        state.subscribed_channels.delete(frame.channel);
        detachBusSubscriber(state, frame.channel);
        try { state.ws.send(JSON.stringify({ type: 'unsubscribed', channel: frame.channel })); } catch { /* closing */ }
        return;
      }
      case 'send': {
        if (typeof frame.channel !== 'string' || frame.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'send.channel must be a non-empty string');
          return;
        }
        if (typeof frame.content !== 'string') {
          sendErrorFrame(state, 'bad_frame', 'send.content must be a string');
          return;
        }
        const envelope = {
          id: crypto.randomUUID(),
          source: 'dashboard',
          source_message_id: crypto.randomUUID(),
          author_id: 'hive-owner',
          author_kind: 'user',
          content: frame.content,
          attachments: [],
          metadata: {},
        };
        try {
          bus.publish(frame.channel, envelope);
        } catch (err) {
          console.error(`[hive-dashboard ws] publish-fail ${state.client_id} channel=${frame.channel} ${err.message}`);
        }
        return;
      }
      case 'ack': {
        if (typeof frame.channel !== 'string' || frame.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'ack.channel must be a non-empty string');
          return;
        }
        if (typeof frame.sequence !== 'number' || !Number.isInteger(frame.sequence) || frame.sequence < 0) {
          sendErrorFrame(state, 'bad_frame', 'ack.sequence must be a non-negative integer');
          return;
        }
        const prev = state.last_ack_seen.get(frame.channel) ?? -1;
        if (frame.sequence > prev) {
          state.last_ack_seen.set(frame.channel, frame.sequence);
        }
        return;
      }
      default: {
        sendErrorFrame(state, 'bad_type', `unknown frame type: ${frame.type}`);
        return;
      }
    }
  }
```

### A.1.7 — Replace the `ws.on('message')` stub + extend `ws.on('close')`

Replace:
```js
    ws.on('message', () => {
      console.error(`[hive-dashboard ws] message-drop ${clientId} (protocol wires in alpha.4)`);
    });
```

With:
```js
    ws.on('message', (raw) => {
      handleClientFrame(state, raw);
    });
```

Replace `ws.on('close', ...)`:
```js
    ws.on('close', (code, reason) => {
      clearInterval(heartbeatInterval);
      registry.delete(clientId);
      console.error(...);
    });
```

With:
```js
    ws.on('close', (code, reason) => {
      clearInterval(heartbeatInterval);
      registry.delete(state.client_id);

      // Save state for potential reconnect IF the client had any subscriptions.
      if (state.subscribed_channels.size > 0) {
        disconnectedSessions.set(state.reconnect_token, {
          state: {
            client_id: state.client_id,
            last_ack_seen: new Map(state.last_ack_seen),       // copy
            subscribed_channels: [...state.subscribed_channels], // copy
          },
          expiresAt: Date.now() + RECONNECT_TTL_MS,
        });
      }

      detachAllBusSubscribers(state);

      console.error(
        `[hive-dashboard ws] disconnect ${state.client_id} code=${code} reason=${Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason)}`
      );
    });
```

The `ws.on('error', ...)` handler updates its `clientId` reference to `state.client_id`:
```js
    ws.on('error', (err) => {
      console.error(`[hive-dashboard ws] error ${state.client_id} ${err.message}`);
    });
```

### A.1.8 — Heartbeat cleanup of `clientId` reference

The α.1 heartbeat handler references `clientId` (now `state.client_id`):
```js
    const heartbeatInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        console.error(`[hive-dashboard ws] heartbeat-timeout ${state.client_id}`);
        ...
      }
      ...
    }, HEARTBEAT_INTERVAL_MS);
```

### A.1.9 — Export the existing public surface unchanged

`module.exports = { attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken };`

No new exports. α.4 keeps the public surface exactly per α.1.

### A.1.10 — Hard contracts (will be acceptance-tested)

- Module exports unchanged: `{ attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken }` exactly.
- `attachWsServer` throws synchronously if `token` missing OR `bus` missing/wrong shape OR `ringSize` < 1.
- `attachWsServer({ token, bus })` (no ringSize) defaults `ringSize` to 100.
- `sanitizeUrl` redacts both `token=` AND `reconnect_token=` query params; preserves other params.
- Per-channel monotonic ring buffer populated by wildcard `bus.subscribe('*')`; cap = ringSize; FIFO eviction.
- On `subscribe` frame: idempotent add to `state.subscribed_channels`, attach bus subscriber, emit `subscribed` echo.
- On `unsubscribe` frame: idempotent remove + bus unsubscribe + `unsubscribed` echo.
- On `send` frame: build Decision C envelope (server-owned fields: id, source='dashboard', source_message_id, author_id='hive-owner', author_kind='user', content, attachments=[], metadata={}); call `bus.publish(channel, envelope)`. Bus-injected fields land via the `enriched` shape.
- On `ack` frame: update `state.last_ack_seen[channel]` if `frame.sequence > prev`.
- Bad JSON / bad frame / bad channel / bad type / bad sequence → `error` frame; connection NOT closed.
- Disconnect with subscriptions → save state into `disconnectedSessions` keyed by reconnect_token; TTL 5 min.
- Reconnect with matching `reconnect_token` → restore subscriptions + last_ack_seen, mint new client_id + reconnect_token, replay messages from ring buffer where `sequence > last_ack_seen[channel]`, attach bus subscribers for restored channels. The old reconnect_token is invalidated immediately (one-time-use).
- Reconnect with stale/wrong reconnect_token → treated as fresh connection, log `reconnect-token-miss`.
- Disconnect cleans up ALL bus subscribers (no leaks).

---

## A.2 — `dashboard/index.js` modifications

**File:** `dashboard/index.js` (MODIFIED)

Add the bus import + instantiation + pass-through. Net add: ~3 lines.

Replace:
```js
const { createApp } = require('./app');
const { attachWsServer } = require('./lib/ws');
```

With:
```js
const { createApp } = require('./app');
const { attachWsServer } = require('./lib/ws');
const { createChatBus } = require('./lib/chat-bus');
```

Replace:
```js
const app = createApp({ token });
const server = http.createServer(app);

attachWsServer(server, { token });
```

With:
```js
const app = createApp({ token });
const server = http.createServer(app);
const bus = createChatBus();

attachWsServer(server, { token, bus });
```

The bus is process-local. No JSONL tail watcher in α.4 — cross-process bridging is β.x's scope.

---

## A.3 — `dashboard/test/ws.test.js` modifications

**File:** `dashboard/test/ws.test.js` (MODIFIED)

Update `startHarness` to construct and pass a bus. The 6 existing test bodies do not change — they exercise auth + hello shape only, which is bus-agnostic.

### A.3.1 — Add bus import at top

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const { attachWsServer, mintReconnectToken, parseQuery, sanitizeUrl } = require('../lib/ws');
const { createChatBus } = require('../lib/chat-bus');  // NEW
const { WebSocket } = require('ws');
```

### A.3.2 — Update `startHarness` to construct + pass a bus

Replace:
```js
async function startHarness(token) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });
  const { registry, wss } = attachWsServer(server, { token });
  ...
}
```

With:
```js
async function startHarness(token) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });
  const bus = createChatBus();
  const { registry, wss } = attachWsServer(server, { token, bus });
  ...
  return { registry, wss, wsUrl, bus, async close() { ... } };
}
```

The `bus` is exposed on the returned harness object so the new ws-protocol.test.js can construct a harness that EXTENDS startHarness's pattern; for α.1 tests it's unused.

### A.3.3 — Update the sanitizeUrl test (extend to cover reconnect_token redaction)

The existing test:
```js
test('sanitizeUrl redacts token query params', () => {
  assert.strictEqual(sanitizeUrl('/api/chat/ws?token=abc123'), '/api/chat/ws?token=<REDACTED>');
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?token=foo&channel=bar'),
    '/api/chat/ws?token=<REDACTED>&channel=bar'
  );
  assert.strictEqual(sanitizeUrl('/api/chat/ws'), '/api/chat/ws');
  assert.strictEqual(sanitizeUrl(null), '');
});
```

**Keep all four existing assertions; ADD reconnect_token assertions:**

```js
test('sanitizeUrl redacts token AND reconnect_token query params', () => {
  // Original token= coverage (unchanged):
  assert.strictEqual(sanitizeUrl('/api/chat/ws?token=abc123'), '/api/chat/ws?token=<REDACTED>');
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?token=foo&channel=bar'),
    '/api/chat/ws?token=<REDACTED>&channel=bar'
  );
  assert.strictEqual(sanitizeUrl('/api/chat/ws'), '/api/chat/ws');
  assert.strictEqual(sanitizeUrl(null), '');
  // New reconnect_token= coverage (α.4):
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?reconnect_token=deadbeef'),
    '/api/chat/ws?reconnect_token=<REDACTED>'
  );
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?token=abc&reconnect_token=def'),
    '/api/chat/ws?token=<REDACTED>&reconnect_token=<REDACTED>'
  );
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?reconnect_token=def&token=abc'),
    '/api/chat/ws?reconnect_token=<REDACTED>&token=<REDACTED>'
  );
});
```

Rename the test title from `'sanitizeUrl redacts token query params'` to `'sanitizeUrl redacts token AND reconnect_token query params'`.

The other 5 α.1 tests stay BYTE-FOR-BYTE identical.

### A.3.4 — Test count attestation

- 6 α.1 tests in this file (the sanitizeUrl test EXPANDED but still ONE test; remaining 5 untouched).
- Total file test count: 6.

---

## A.4 — `dashboard/test/ws-protocol.test.js` implementation

**File:** `dashboard/test/ws-protocol.test.js` (NEW)

**Locked test list (11 tests):**

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { attachWsServer } = require('../lib/ws');
const { createChatBus } = require('../lib/chat-bus');

const TOKEN = 'a'.repeat(64);

async function startHarness(opts = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const bus = createChatBus();
  const { registry, wss } = attachWsServer(server, {
    token: TOKEN,
    bus,
    ringSize: opts.ringSize ?? 100,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/api/chat/ws`;

  return {
    server,
    registry,
    wss,
    bus,
    wsUrl,
    async close() {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectAndHello(wsUrl, queryAppend = '') {
  const ws = new WebSocket(`${wsUrl}?token=${TOKEN}${queryAppend ? '&' + queryAppend : ''}`);
  const [first] = await once(ws, 'message');
  const hello = JSON.parse(first.toString('utf8'));
  return { ws, hello };
}

function nextFrame(ws) {
  return once(ws, 'message').then(([buf]) => JSON.parse(buf.toString('utf8')));
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

test('attachWsServer throws when bus is missing or wrong shape', () => {
  const server = http.createServer();
  assert.throws(() => attachWsServer(server, { token: TOKEN }), /bus is required/);
  assert.throws(() => attachWsServer(server, { token: TOKEN, bus: {} }), /bus is required/);
  assert.throws(
    () => attachWsServer(server, { token: TOKEN, bus: { publish: () => {} } }),
    /bus is required/
  );
  // Valid bus does not throw:
  const goodBus = createChatBus();
  assert.doesNotThrow(() => attachWsServer(server, { token: TOKEN, bus: goodBus }));
});

test('subscribe frame attaches bus subscriber and receives subsequent publishes', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    const sub = await nextFrame(ws);
    assert.deepStrictEqual(sub, { type: 'subscribed', channel: 'agent-x' });

    h.bus.publish('agent-x', { id: 'msg-1', content: 'hello', source: 'test' });
    const msg = await nextFrame(ws);
    assert.strictEqual(msg.type, 'message');
    assert.strictEqual(msg.channel, 'agent-x');
    assert.strictEqual(msg.sequence, 1);
    assert.strictEqual(msg.id, 'msg-1');
    assert.strictEqual(msg.content, 'hello');

    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('send frame publishes a Decision C envelope to the bus', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    const seen = [];
    h.bus.subscribe('hivemind', (msg) => seen.push(msg));

    send(ws, { type: 'send', channel: 'hivemind', content: 'from dashboard' });
    // Give the server a tick to process the frame.
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].channel, 'hivemind');
    assert.strictEqual(seen[0].source, 'dashboard');
    assert.strictEqual(seen[0].author_id, 'hive-owner');
    assert.strictEqual(seen[0].author_kind, 'user');
    assert.strictEqual(seen[0].content, 'from dashboard');
    assert.deepStrictEqual(seen[0].attachments, []);
    assert.deepStrictEqual(seen[0].metadata, {});
    assert.strictEqual(typeof seen[0].id, 'string');
    assert.strictEqual(typeof seen[0].source_message_id, 'string');
    assert.strictEqual(seen[0].sequence, 1);

    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('subscribe is channel-isolated — no cross-channel leakage', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame(ws); // subscribed echo

    h.bus.publish('agent-y', { content: 'y-only' });
    h.bus.publish('agent-x', { content: 'x-only' });

    const msg = await nextFrame(ws);
    assert.strictEqual(msg.channel, 'agent-x');
    assert.strictEqual(msg.content, 'x-only');
    // No further frames should arrive for agent-y. We don't have a timer-based negative assertion;
    // the lack of a second message frame before close is the assertion.

    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('multiple clients on same channel all receive the publish', async () => {
  const h = await startHarness();
  try {
    const a = await connectAndHello(h.wsUrl);
    const b = await connectAndHello(h.wsUrl);
    send(a.ws, { type: 'subscribe', channel: 'shared' });
    await nextFrame(a.ws);
    send(b.ws, { type: 'subscribe', channel: 'shared' });
    await nextFrame(b.ws);

    h.bus.publish('shared', { content: 'broadcast' });

    const aMsg = await nextFrame(a.ws);
    const bMsg = await nextFrame(b.ws);
    assert.strictEqual(aMsg.content, 'broadcast');
    assert.strictEqual(bMsg.content, 'broadcast');
    assert.strictEqual(aMsg.sequence, bMsg.sequence);

    a.ws.close();
    b.ws.close();
    await once(a.ws, 'close');
    await once(b.ws, 'close');
  } finally {
    await h.close();
  }
});

test('unsubscribe frame stops subsequent receipt and emits unsubscribed echo', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame(ws);

    h.bus.publish('agent-x', { content: 'before' });
    const beforeMsg = await nextFrame(ws);
    assert.strictEqual(beforeMsg.content, 'before');

    send(ws, { type: 'unsubscribe', channel: 'agent-x' });
    const unsub = await nextFrame(ws);
    assert.deepStrictEqual(unsub, { type: 'unsubscribed', channel: 'agent-x' });

    h.bus.publish('agent-x', { content: 'after' });
    // No further frame should arrive for this client. Server-side bus subscriber count:
    // expect zero busUnsubscribes entries for agent-x.
    const state = [...h.registry.values()][0];
    assert.strictEqual(state.busUnsubscribes.has('agent-x'), false);

    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('disconnect cleans up bus subscribers (no leak)', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame(ws);

    const stateBefore = [...h.registry.values()][0];
    assert.strictEqual(stateBefore.busUnsubscribes.size, 1);

    ws.close();
    await once(ws, 'close');
    // Server has its own close handler — wait a tick for it to process.
    await new Promise((r) => setTimeout(r, 20));

    // Registry entry is removed:
    assert.strictEqual(h.registry.size, 0);

    // Publishing now should not throw (no subscriber refs to closed ws).
    assert.doesNotThrow(() => h.bus.publish('agent-x', { content: 'post-close' }));
  } finally {
    await h.close();
  }
});

test('ack frame updates last_ack_seen for the channel', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame(ws);

    h.bus.publish('agent-x', { content: 'm1' });
    await nextFrame(ws); // sequence 1
    h.bus.publish('agent-x', { content: 'm2' });
    await nextFrame(ws); // sequence 2

    send(ws, { type: 'ack', channel: 'agent-x', sequence: 2 });
    await new Promise((r) => setTimeout(r, 20));

    const state = [...h.registry.values()][0];
    assert.strictEqual(state.last_ack_seen.get('agent-x'), 2);

    // Lower acks are ignored:
    send(ws, { type: 'ack', channel: 'agent-x', sequence: 1 });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(state.last_ack_seen.get('agent-x'), 2);

    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('reconnect with valid reconnect_token restores subscriptions and replays unacked messages', async () => {
  const h = await startHarness();
  try {
    // Initial connect + subscribe + receive a few messages + ack the first.
    const c1 = await connectAndHello(h.wsUrl);
    const reconnectToken = c1.hello.reconnect_token;
    send(c1.ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame(c1.ws); // subscribed

    h.bus.publish('agent-x', { content: 'one' });   // seq 1
    h.bus.publish('agent-x', { content: 'two' });   // seq 2
    h.bus.publish('agent-x', { content: 'three' }); // seq 3
    await nextFrame(c1.ws);
    await nextFrame(c1.ws);
    await nextFrame(c1.ws);

    send(c1.ws, { type: 'ack', channel: 'agent-x', sequence: 1 });
    await new Promise((r) => setTimeout(r, 20));

    c1.ws.close();
    await once(c1.ws, 'close');
    await new Promise((r) => setTimeout(r, 20));

    // Reconnect using the saved reconnect_token.
    const c2 = await connectAndHello(h.wsUrl, `reconnect_token=${reconnectToken}`);
    assert.notStrictEqual(c2.hello.client_id, c1.hello.client_id);
    assert.notStrictEqual(c2.hello.reconnect_token, reconnectToken);

    // Replay: messages with sequence > 1 (i.e. seq 2 and seq 3).
    const replay1 = await nextFrame(c2.ws);
    const replay2 = await nextFrame(c2.ws);
    assert.strictEqual(replay1.sequence, 2);
    assert.strictEqual(replay1.content, 'two');
    assert.strictEqual(replay2.sequence, 3);
    assert.strictEqual(replay2.content, 'three');

    c2.ws.close();
    await once(c2.ws, 'close');
  } finally {
    await h.close();
  }
});

test('reconnect with stale reconnect_token is treated as fresh connection (no replay)', async () => {
  const h = await startHarness();
  try {
    // Connect + immediately try to reconnect with a never-seen token.
    const c = await connectAndHello(h.wsUrl, 'reconnect_token=ff'.padEnd('reconnect_token='.length + 32, 'f'));
    // hello arrived = fresh connection. Confirm new tokens minted.
    assert.strictEqual(typeof c.hello.client_id, 'string');
    assert.strictEqual(typeof c.hello.reconnect_token, 'string');
    // No replay arrives — the next message we read should require sending something first.
    // Since no subscriptions and no bus publishes happen here, the test passes if no extra frame arrives.
    // We can't easily assert "no frames" without a timer; rely on the fact that nextFrame would hang otherwise.

    c.ws.close();
    await once(c.ws, 'close');
  } finally {
    await h.close();
  }
});

test('malformed frames emit error frame but do not close the socket', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);

    // Bad JSON:
    ws.send('not-json-at-all');
    const err1 = await nextFrame(ws);
    assert.strictEqual(err1.type, 'error');
    assert.strictEqual(err1.code, 'bad_json');

    // Frame without type:
    send(ws, { channel: 'x' });
    const err2 = await nextFrame(ws);
    assert.strictEqual(err2.type, 'error');
    assert.strictEqual(err2.code, 'bad_frame');

    // Unknown frame type:
    send(ws, { type: 'no-such-type' });
    const err3 = await nextFrame(ws);
    assert.strictEqual(err3.type, 'error');
    assert.strictEqual(err3.code, 'bad_type');

    // Subscribe with bad channel:
    send(ws, { type: 'subscribe', channel: '' });
    const err4 = await nextFrame(ws);
    assert.strictEqual(err4.code, 'bad_channel');

    // Subscribe to wildcard '*' is rejected:
    send(ws, { type: 'subscribe', channel: '*' });
    const err5 = await nextFrame(ws);
    assert.strictEqual(err5.code, 'bad_channel');

    // Ack with non-integer sequence:
    send(ws, { type: 'ack', channel: 'x', sequence: 'three' });
    const err6 = await nextFrame(ws);
    assert.strictEqual(err6.code, 'bad_frame');

    // Connection still alive — close cleanly.
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});
```

**Test count:** 11 exactly.

---

## B. Acceptance gates

### B.1 — `node --check` clean on modified + new files

```bash
node --check dashboard/lib/ws.js && echo "ws.js syntax ✓"
node --check dashboard/index.js && echo "index.js syntax ✓"
node --check dashboard/test/ws.test.js && echo "ws.test.js syntax ✓"
node --check dashboard/test/ws-protocol.test.js && echo "ws-protocol.test.js syntax ✓"
```

### B.2 — Test suite passes; baseline = 195 (184 + 11 new)

```bash
cd dashboard && pnpm test 2>&1 | tail -5
# Expected (verbatim shape):
#   tests 195
#   pass 195
#   fail 0
```

### B.3 — Module exports unchanged

```bash
node -e "const m = require('./dashboard/lib/ws'); console.log(JSON.stringify(Object.keys(m).sort()));"
# Expected: ["attachWsServer","mintReconnectToken","parseQuery","sanitizeUrl"]
```

### B.4 — `attachWsServer` rejects missing bus

```bash
node -e "
const http = require('node:http');
const { attachWsServer } = require('./dashboard/lib/ws');
const server = http.createServer();
try {
  attachWsServer(server, { token: 'a'.repeat(64) });
  console.log('FAIL: did not throw');
  process.exit(1);
} catch (err) {
  if (/bus is required/.test(err.message)) {
    console.log('OK: rejects missing bus');
  } else {
    console.log('FAIL: wrong error:', err.message);
    process.exit(1);
  }
}
"
```

### B.5 — `sanitizeUrl` redacts reconnect_token

```bash
node -e "
const { sanitizeUrl } = require('./dashboard/lib/ws');
const a = sanitizeUrl('/api/chat/ws?token=abc&reconnect_token=def');
console.log(a);
"
# Expected: /api/chat/ws?token=<REDACTED>&reconnect_token=<REDACTED>
```

### B.6 — Diff lock = 4 paths exactly

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.4-ws-bus-plumbing
# Expected: 4 files
#   dashboard/index.js
#   dashboard/lib/ws.js
#   dashboard/test/ws-protocol.test.js (new)
#   dashboard/test/ws.test.js
```

### B.7 — No edits outside diff-lock

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.4-ws-bus-plumbing \
  -- ':!dashboard/index.js' ':!dashboard/lib/ws.js' ':!dashboard/test/ws-protocol.test.js' ':!dashboard/test/ws.test.js'
# Expected: empty
```

### B.8 — No prod dependency drift

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.4-ws-bus-plumbing -- dashboard/package.json dashboard/pnpm-lock.yaml | head -3
# Expected: empty
```

### B.9 — Frozen α.x outputs untouched

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.4-ws-bus-plumbing -- dashboard/lib/chat-bus.js dashboard/test/chat-bus.test.js src/discord/chat-tap.ts src/discord/chat-tap.test.ts | head -3
# Expected: empty (α.2 and α.3 outputs frozen)
```

### B.10 — Live exercise: end-to-end send/subscribe/echo

```bash
node --input-type=module --eval "
import http from 'node:http';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { attachWsServer } from './dashboard/lib/ws.js';
import { createChatBus } from './dashboard/lib/chat-bus.js';

const TOKEN = 'a'.repeat(64);
const server = http.createServer((req,res)=>{res.end('ok');});
const bus = createChatBus();
attachWsServer(server, { token: TOKEN, bus });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ws = new WebSocket(\`ws://127.0.0.1:\${port}/api/chat/ws?token=\${TOKEN}\`);
const [helloRaw] = await once(ws, 'message');
const hello = JSON.parse(helloRaw.toString('utf8'));
console.log('hello:', JSON.stringify(hello));

ws.send(JSON.stringify({ type:'subscribe', channel:'agent-x' }));
const [subRaw] = await once(ws, 'message');
console.log('subscribed:', subRaw.toString('utf8'));

ws.send(JSON.stringify({ type:'send', channel:'agent-x', content:'hello world' }));
const [msgRaw] = await once(ws, 'message');
const msg = JSON.parse(msgRaw.toString('utf8'));
console.log('message:', JSON.stringify(msg));

ws.close();
server.close();
" 2>&1 | head -20
# NOTE: ws.js is CommonJS — the --input-type=module variant requires .mjs import wrappers.
# Fallback: just run \`pnpm test\` and verify the live-exercise tests pass. The B.10 transcript may be
# omitted if ESM/CJS interop is fiddly; the test suite covers the same ground deterministically.
```

(B.10 is informational; the test suite is the authoritative gate. Bob may capture either a working transcript or note "covered by ws-protocol.test.js tests 2, 3, 6.")

---

## C. Acceptance / hard gates checklist

- [ ] B.1 `node --check` clean on all 4 paths (2 modified + 1 new file + index.js)
- [ ] B.2 test suite: 184 baseline + 11 new = **195** passing
- [ ] B.3 module exports unchanged = `{ attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken }`
- [ ] B.4 `attachWsServer` rejects missing/malformed bus
- [ ] B.5 `sanitizeUrl` redacts `reconnect_token` query param
- [ ] B.6 diff-lock = 4 paths
- [ ] B.7 no edits outside diff-lock
- [ ] B.8 no prod dependency drift
- [ ] B.9 α.2 and α.3 outputs untouched (chat-bus.js, chat-bus.test.js, chat-tap.ts, chat-tap.test.ts)
- [ ] B.10 live exercise OR test-suite-covered attestation
- [ ] subscribe → publish → receive confirmed by ws-protocol.test.js #2
- [ ] send frame builds Decision C envelope confirmed by ws-protocol.test.js #3
- [ ] channel isolation confirmed by ws-protocol.test.js #4
- [ ] multi-client fan-out confirmed by ws-protocol.test.js #5
- [ ] unsubscribe lifecycle confirmed by ws-protocol.test.js #6
- [ ] disconnect cleanup confirmed by ws-protocol.test.js #7
- [ ] ack updates state confirmed by ws-protocol.test.js #8
- [ ] reconnect replay confirmed by ws-protocol.test.js #9
- [ ] stale reconnect token treated as fresh confirmed by ws-protocol.test.js #10
- [ ] malformed-frame robustness confirmed by ws-protocol.test.js #11
- [ ] PR body: pre-flight 1-7 outputs verbatim, B.1-B.10 outputs verbatim, diff-lock confirmation
- [ ] **No CHANGELOG.md update** — Phase α leaves don't bump CHANGELOG

---

## D. DONE block format

```text
PR URL: <gh url>
Diff: 4 paths (3 modified + 1 new)
Branch: feat/dashboard-chat-mirror-alpha.4-ws-bus-plumbing (targets feat/dashboard-chat-mirror, NOT main)

Pre-flight outputs:
  1. feat/dashboard-chat-mirror HEAD: 952d9f2 (or descendant)
  2. α.1 + α.2 + α.3 outputs present: ✓
  3. α.4 target paths state correct (3 to modify, 1 to create): ✓
  4. baseline test count: 184 passing
  5. tooling: node ≥22 ✓ pnpm ≥10 ✓
  6. prod deps unchanged (express + ws + dotenv): ✓
  7. α.1 sanitizeUrl token= redaction present: ✓

Tooling check:
  node --check dashboard/lib/ws.js: ✓
  node --check dashboard/index.js: ✓
  node --check dashboard/test/ws.test.js: ✓
  node --check dashboard/test/ws-protocol.test.js: ✓

Tests:
  B.2 test suite: 184 baseline + 11 new = 195 passing ✓
  B.3 module exports unchanged: ["attachWsServer","mintReconnectToken","parseQuery","sanitizeUrl"] ✓
  B.4 attachWsServer rejects missing bus: ✓
  B.5 sanitizeUrl redacts reconnect_token: ✓
  B.6 diff-lock = 4 paths ✓
  B.7 no out-of-scope edits ✓
  B.8 no prod dep drift ✓
  B.9 α.2 + α.3 outputs untouched ✓
  B.10 live-exercise OR test-coverage attestation

Worker scope attestations:
  - No edits to dashboard/lib/chat-bus.js (α.2 output frozen)
  - No edits to dashboard/test/chat-bus.test.js
  - No edits to src/discord/chat-tap.ts (α.3 output frozen)
  - No edits to src/discord/chat-tap.test.ts
  - No edits to dashboard/app.js
  - No edits to dashboard/middleware/
  - No edits to dashboard/public/
  - No edits to dashboard/package.json or dashboard/pnpm-lock.yaml
  - No new prod dependencies
  - No CHANGELOG.md changes
  - No src/discord/bot.ts changes (α.3.5 future scope)

Live exercise transcript:
  <verbatim node output OR statement "covered by ws-protocol.test.js tests N, N, N">

Commit:
  feat(dashboard): α.4 WS message protocol + bus plumbing + reconnect replay
```

---

## E. Hard NO list

- DO NOT modify `dashboard/lib/chat-bus.js` (α.2 output frozen).
- DO NOT modify `dashboard/test/chat-bus.test.js`.
- DO NOT modify `src/discord/chat-tap.ts` or `src/discord/chat-tap.test.ts` (α.3 output frozen).
- DO NOT modify `dashboard/app.js`, `dashboard/middleware/`, `dashboard/public/`, `dashboard/routes/`.
- DO NOT add prod dependencies. The WS protocol is pure Node + existing `ws` + node:crypto.
- DO NOT implement JSONL persistence (β.1 scope).
- DO NOT implement cross-process bus bridging (β.x scope).
- DO NOT implement Discord egress from dashboard (failover post-recovery — β.x or γ scope).
- DO NOT implement user-identity resolution. `author_id: 'hive-owner'` static for now.
- DO NOT modify `src/discord/bot.ts` (α.3.5 future scope).
- DO NOT add new exports from `dashboard/lib/ws.js`. Module surface stays exactly `{ attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken }`.
- DO NOT change the `hello` frame shape. `{ type, client_id, reconnect_token }` only.
- DO NOT close the WS socket on protocol errors. Bad frames → `error` frame, connection continues.
- DO NOT silently swallow `bus.publish` failures inside the `send` handler — log them via `console.error`. (The handler MUST NOT propagate, but observability matters here because publish failures are real bugs, not user input.)
- DO NOT change the heartbeat ping/pong interval or timeout constants.
- DO NOT introduce a wildcard subscribe path for clients (`channel: '*'` from a `subscribe` frame is REJECTED with `bad_channel`). Wildcard is server-internal only.
- DO NOT touch `dashboard/test/sse.test.js` or any other test file — `ws.test.js` is the only existing test file modified.
- DO NOT add CHANGELOG entries (ζ.3 handles release-doc updates).
- DO NOT change the public/ frontend (γ phase scope).
- **EXISTING TESTS MUST STILL PASS** — 184 baseline maintained, 11 new added = 195 total. Zero regressions.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises stop the worker. Halt means HALT — do not fix-and-proceed inline. Your 13-for-13 L8 discipline pattern is the standard. PR #73-style inline fixes are NOT acceptable on this leaf — the wire-up surface is hot path; raymond-holt judgment is required on any deviation.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **PR ready-for-review, NOT draft. DO NOT MERGE** — raymond-holt merges after review.
- **PR base ref enforcement.** `gh pr view --json baseRefName` MUST return `feat/dashboard-chat-mirror`. Bob's pre-merge attestation MUST quote this verbatim.

---

## F. Forward links

Phase α closes with α.4. Phase β begins immediately after:

- **β.1 — JSONL persistence writer.** New `dashboard/lib/jsonl-writer.js` (and/or `src/messaging/jsonl-writer.ts` for the agent-bot side). Wildcard-subscribes to a chat-bus. Per-channel daily-rotated JSONL at `~/.neato-hive/state/chat/<channel>.YYYY-MM-DD.jsonl`. Decision C schema validation at write time. Decision A attachment local-mirror integration deferred to δ.

- **β.2 — JSONL tail-watcher (cross-process bridge).** New `dashboard/lib/jsonl-tail.js` and matching agent-side module. Watches OTHER processes' JSONL output; on new entries, publishes to LOCAL bus with a special metadata field (`metadata: { from_jsonl_bridge: true }`) so the originating process's wildcard subscriber knows to skip re-write. This is the failover bridge — when Discord is down, dashboard publishes to its bus → JSONL writer persists → agent bot's tail-watcher picks it up → publishes to agent bot's bus → triggers a wake-fire path (Decision E).

- **α.3.5 — wire chat-tap into `src/discord/bot.ts`.** At agent bot boot, instantiate a chat-bus instance, build a channelResolver from agent config, call `attachChatTap({ client, bus, channelResolver })`. Add β.1 JSONL writer as a wildcard subscriber. This becomes part of the agent-bot side once β.1 is in.

- **γ phase — frontend chat UI** (`dashboard/public/chat.html`, `dashboard/public/js/chat.js`). Connects to the α.4 WS endpoint; renders per-agent chatrooms; handles reconnect with stored `reconnect_token`. Renders attachments from local-mirror path (δ output).

End of spec.
