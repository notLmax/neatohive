# Chat-Mirror α.2 — Chat-Bus In-Memory Pub/Sub

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on **`feat/dashboard-chat-mirror`** (the long-running feature branch, NOT main).
**Project:** dashboard-chat-mirror (v1.5.x)
**Phase:** α — Backend WebSocket infrastructure (4 leaves)
**Leaf:** α.2 (2 of 4 in Phase α)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** α.1 merged at `a18ca69` (canonical skeleton.md design — `attachWsServer` + `sanitizeUrl` + `parseQuery` + `mintReconnectToken` exported from `dashboard/lib/ws.js`).
**Successor:** α.3 (Discord ingress tap publishes to this bus; α.4 wires the WS server's `registry` to consume from this bus).

---

## ⚠ Workflow lock — feature branch isolation

**ALL work on this leaf targets `feat/dashboard-chat-mirror`, NOT main.** Per Daniel's 2026-05-10 directive (LESSONS.md L9): chat-mirror lives on its own long-running branch until the full feature verifies end-to-end, then merges to main as a single owner-paced ceremony.

**Bob dispatch:**
- `git checkout feat/dashboard-chat-mirror && git pull origin feat/dashboard-chat-mirror` (NOT main)
- Leaf branch: `feat/dashboard-chat-mirror-alpha.2-chat-bus` (branches FROM and PRs INTO `feat/dashboard-chat-mirror`)
- PR base ref: `feat/dashboard-chat-mirror`

---

## Goal

Ship the in-process pub/sub conduit that the chat-mirror's bidirectional message flow runs through. This leaf is foundational; α.3 (Discord ingress) publishes to it, α.4 (WS protocol) consumes from it, β.1 (JSONL persistence) tails it. The bus owns:

1. **Per-channel monotonic sequence assignment.** Each `publish(channel, msg)` returns `{ sequence, ts }` and enriches the emitted message with those fields. Sequence starts at 1 per channel, never decreases, never repeats.
2. **Channel routing.** Subscribers on channel `X` receive only messages published to `X`. Wildcard subscribers (`'*'`) receive every published message.
3. **Pure-memory state.** No filesystem, no network, no Discord API. β.1 layers persistence on top via a tail subscriber.
4. **Backpressure-naive fan-out.** Subscribers are invoked synchronously in publish order. If a subscriber throws, the others still fire. This matches Node.js EventEmitter semantics and is sufficient for α.x scope.

The leaf ships:

1. **`dashboard/lib/chat-bus.js`** — the module. Exports `createChatBus()` factory that returns `{ publish, subscribe, peekSequence, channels }`.
2. **`dashboard/test/chat-bus.test.js`** — `node --test` covering sequence monotonicity, channel isolation, wildcard subscribers, unsubscribe lifecycle, error isolation between subscribers, ts assignment.

**NO wiring into `dashboard/index.js` yet.** α.4 wires the bus instance to the WS server's connection registry. This leaf is JUST the module + tests.

**NO chat-bus consumers ship in this leaf.** α.3 (Discord tap publishes inbound), α.4 (WS server consumes outbound), β.1 (JSONL writer tails) layer on top.

**NO event-schema validation in the bus.** Per Decision C (project doc): the JSONL writer enforces the locked schema downstream. The bus is shape-agnostic except for the three fields it INJECTS (`channel`, `sequence`, `ts`).

**Owner directive carry-overs (project doc):**
- Decision C (locked 2026-05-10): JSONL per-channel files + locked event schema. **The bus enriches with `channel + sequence + ts`; the message body itself is opaque pass-through.**
- Decision E (locked 2026-05-10): dedup-before-wake LRU lives in the AGENT inbound module (`src/messaging/inbound.ts`, future phase), NOT in the chat-bus. The bus does no dedup.

---

## Required reading

### Decision C — JSONL schema (project doc)

```json
{
  "id": "<uuid>",
  "source": "discord" | "dashboard",
  "source_message_id": "<discord-snowflake-or-dashboard-ulid>",
  "channel": "<agent-name-or-hivemind>",
  "author_id": "<discord-user-id-or-agent-name>",
  "author_kind": "user" | "agent",
  "content": "<text>",
  "attachments": [{"filename": "...", "local_path": "...", "url": "...", "size_bytes": N}],
  "metadata": {"task_id": "...", "kind": "delegation|response|query"},
  "ts": "2026-05-10T...Z",
  "sequence": N
}
```

The bus is responsible for `channel`, `sequence`, `ts`. All other fields come from the publisher (Discord tap, WS client, etc.) and pass through opaquely.

### α.1 module exports (`dashboard/lib/ws.js`)

```js
module.exports = { attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken };
```

The α.1 WS server holds the per-connection registry (`{client_id, socket, subscribed_channels: Set, last_ack_seen: number, reconnect_token: string}`). α.4 will plumb the chat-bus into the WS server so per-channel publishes fan out to subscribed clients. For α.2, the bus is standalone.

### Idiom — match existing `dashboard/lib/*.js`

All existing modules use:
- `'use strict';` at top
- CommonJS `require` / `module.exports`
- Factory pattern: `function createX(opts) { ... return { ... }; }`
- Optional dependency injection via opts

See `dashboard/lib/runner-events.js` and `dashboard/lib/sse.js` for reference.

---

## Diff lock — 2 paths exactly

1. `dashboard/lib/chat-bus.js` (NEW)
2. `dashboard/test/chat-bus.test.js` (NEW)

**NO other paths.** No modifications to `dashboard/lib/ws.js` (α.1 output), `dashboard/index.js`, `dashboard/app.js`, `dashboard/middleware/`, `dashboard/public/`, `dashboard/routes/`, `dashboard/package.json`, `dashboard/pnpm-lock.yaml`, or anywhere else. No new prod dependencies — the chat-bus is pure ES2022 Node, uses only the standard library.

---

## A. Pre-flight halts (HALT and ping raymond-holt if ANY fail)

```bash
# 1. On feat/dashboard-chat-mirror, clean working tree per whitelist
cd ~/neato-hive
git fetch origin
git checkout feat/dashboard-chat-mirror
git pull origin feat/dashboard-chat-mirror
git rev-parse --abbrev-ref HEAD                 # Expected: feat/dashboard-chat-mirror
git rev-parse HEAD                               # Expected: a18ca69 or descendant
```

```bash
# 2. α.1 output present (sanity check — confirms branch state)
test -f dashboard/lib/ws.js && echo "ws.js ✓"
grep -nE '^module\.exports = \{ attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken \};' dashboard/lib/ws.js | head -1
# Expected: 1 match
test -f dashboard/test/ws.test.js && echo "ws.test.js ✓"
```

```bash
# 3. α.2 target paths absent
test ! -e dashboard/lib/chat-bus.js && echo "chat-bus.js absent ✓"
test ! -e dashboard/test/chat-bus.test.js && echo "chat-bus.test.js absent ✓"
```

```bash
# 4. Test baseline = 174 passing (168 base + 6 from α.1)
cd dashboard && pnpm test 2>&1 | tail -3
# Expected: "tests 174" "pass 174" "fail 0"
```

```bash
# 5. Tooling
node --version    # Expected: ≥ 22
pnpm --version    # Expected: ≥ 10
```

```bash
# 6. No prod-dependency drift planned (sanity)
grep -nE '"(ws|express|dotenv)":' dashboard/package.json | head -3
# Expected: 3 matches (the existing locked prod deps post-α.1)
```

**HALT and ping raymond-holt** if any check fails. Halt-and-ping means HALT — do not fix-and-proceed inline. Your 11-for-11 L8 discipline pattern is the standard.

---

## A.1 — `dashboard/lib/chat-bus.js` implementation

**File:** `dashboard/lib/chat-bus.js` (NEW)

**Locked contract (exact shape — codex must match):**

```js
'use strict';

/**
 * Create an in-memory pub/sub chat-bus.
 *
 * Per-channel monotonic sequence. Channel-routed delivery + wildcard subscribers.
 * Synchronous, single-process, no persistence. β.1 layers JSONL persistence on top
 * via a wildcard-subscriber tail. α.4 wires this bus to the WS server's connection
 * registry so per-channel publishes fan out to subscribed clients.
 *
 * @param {Object} [opts]
 * @param {() => string} [opts.now] - Override for ts assignment (test injection).
 *   Default: `() => new Date().toISOString()`.
 * @returns {{
 *   publish: (channel: string, message: object) => { sequence: number, ts: string, enriched: object },
 *   subscribe: (channel: string, callback: (msg: object) => void) => () => void,
 *   peekSequence: (channel: string) => number,
 *   channels: () => string[]
 * }}
 */
function createChatBus({ now = () => new Date().toISOString() } = {}) {
  const sequences = new Map();    // channel → integer (high-water sequence)
  const subscribers = new Map();  // channel → Set<callback>

  function publish(channel, message) {
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('chat-bus: channel must be a non-empty string');
    }
    if (message === null || typeof message !== 'object') {
      throw new TypeError('chat-bus: message must be a non-null object');
    }

    const sequence = (sequences.get(channel) || 0) + 1;
    sequences.set(channel, sequence);
    const ts = now();
    const enriched = { ...message, channel, sequence, ts };

    // Channel-specific subscribers
    const channelSubs = subscribers.get(channel);
    if (channelSubs) {
      for (const cb of channelSubs) {
        try {
          cb(enriched);
        } catch (err) {
          // Swallow per-subscriber error so others still fire.
          // β.x can layer structured error logging; α.2 stays silent.
        }
      }
    }

    // Wildcard subscribers
    const wildcardSubs = subscribers.get('*');
    if (wildcardSubs) {
      for (const cb of wildcardSubs) {
        try {
          cb(enriched);
        } catch (err) {
          // Same as above.
        }
      }
    }

    return { sequence, ts, enriched };
  }

  function subscribe(channel, callback) {
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('chat-bus: channel must be a non-empty string');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('chat-bus: callback must be a function');
    }
    if (!subscribers.has(channel)) {
      subscribers.set(channel, new Set());
    }
    subscribers.get(channel).add(callback);
    return function unsubscribe() {
      const set = subscribers.get(channel);
      if (set) set.delete(callback);
    };
  }

  function peekSequence(channel) {
    return sequences.get(channel) || 0;
  }

  function channels() {
    return Array.from(sequences.keys());
  }

  return { publish, subscribe, peekSequence, channels };
}

module.exports = { createChatBus };
```

**Notes:**
- `now` injection allows deterministic ts in tests.
- `publish` returns `enriched` to give the caller the exact object emitted to subscribers (useful for chaining + assertion).
- Subscriber errors are swallowed silently. β.x logging is a future concern.
- `peekSequence` returns 0 for unknown channels (matches "no publishes yet" semantics).
- `channels()` returns channels that have HAD a publish — not channels that merely have subscribers without publishes. (A subscriber on a never-published channel is valid and benign.)

**Hard contracts (will be acceptance-tested):**
- Module exports: `{ createChatBus }` exactly.
- `createChatBus()` is the only export. No class export, no singleton, no module-level state.
- Per-channel sequences start at 1 and increment by 1 per publish.
- ts is assigned at publish time using `now()` (injectable).
- Wildcard `'*'` subscribers receive every publish.
- Cross-channel isolation: publish to A does not invoke B subscribers (except wildcards).
- Subscriber error in callback does not prevent other subscribers from firing.
- `unsubscribe()` removes the specific callback; idempotent (calling twice is a no-op).
- `publish` with non-string/empty channel throws `TypeError`.
- `publish` with non-object message throws `TypeError`.
- `subscribe` with bad inputs throws `TypeError`.

---

## A.2 — `dashboard/test/chat-bus.test.js` implementation

**File:** `dashboard/test/chat-bus.test.js` (NEW)

**Locked test list (10 tests, exact descriptions):**

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatBus } = require('../lib/chat-bus');

test('createChatBus exports a factory returning the documented API', () => {
  const bus = createChatBus();
  assert.equal(typeof bus.publish, 'function');
  assert.equal(typeof bus.subscribe, 'function');
  assert.equal(typeof bus.peekSequence, 'function');
  assert.equal(typeof bus.channels, 'function');
});

test('publish assigns monotonic per-channel sequence starting at 1', () => {
  const bus = createChatBus();
  const r1 = bus.publish('agent-x', { content: 'a' });
  const r2 = bus.publish('agent-x', { content: 'b' });
  const r3 = bus.publish('agent-y', { content: 'c' });
  const r4 = bus.publish('agent-x', { content: 'd' });
  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
  assert.equal(r3.sequence, 1);   // y starts at 1 independently
  assert.equal(r4.sequence, 3);   // x continues from 2
});

test('publish assigns ts from injected now() and enriches with channel + sequence + ts', () => {
  const bus = createChatBus({ now: () => '2026-05-11T00:00:00.000Z' });
  const r = bus.publish('agent-x', { content: 'hello', id: 'abc' });
  assert.equal(r.ts, '2026-05-11T00:00:00.000Z');
  assert.deepEqual(r.enriched, {
    content: 'hello',
    id: 'abc',
    channel: 'agent-x',
    sequence: 1,
    ts: '2026-05-11T00:00:00.000Z',
  });
});

test('subscribe receives messages published to the same channel', () => {
  const bus = createChatBus({ now: () => '2026-05-11T00:00:00.000Z' });
  const received = [];
  bus.subscribe('agent-x', (msg) => received.push(msg));
  bus.publish('agent-x', { content: 'first' });
  bus.publish('agent-x', { content: 'second' });
  assert.equal(received.length, 2);
  assert.equal(received[0].content, 'first');
  assert.equal(received[0].sequence, 1);
  assert.equal(received[1].content, 'second');
  assert.equal(received[1].sequence, 2);
});

test('channel isolation: subscribers do not receive messages for other channels', () => {
  const bus = createChatBus();
  const xReceived = [];
  const yReceived = [];
  bus.subscribe('agent-x', (msg) => xReceived.push(msg));
  bus.subscribe('agent-y', (msg) => yReceived.push(msg));
  bus.publish('agent-x', { content: 'x-only' });
  bus.publish('agent-y', { content: 'y-only' });
  assert.equal(xReceived.length, 1);
  assert.equal(yReceived.length, 1);
  assert.equal(xReceived[0].content, 'x-only');
  assert.equal(yReceived[0].content, 'y-only');
});

test('wildcard subscribers receive every published message', () => {
  const bus = createChatBus();
  const all = [];
  bus.subscribe('*', (msg) => all.push(msg));
  bus.publish('agent-x', { content: 'a' });
  bus.publish('agent-y', { content: 'b' });
  bus.publish('hivemind', { content: 'c' });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((m) => m.channel), ['agent-x', 'agent-y', 'hivemind']);
});

test('unsubscribe removes a specific callback without affecting others', () => {
  const bus = createChatBus();
  const aReceived = [];
  const bReceived = [];
  const unsubA = bus.subscribe('agent-x', (msg) => aReceived.push(msg));
  bus.subscribe('agent-x', (msg) => bReceived.push(msg));
  bus.publish('agent-x', { content: '1' });
  unsubA();
  bus.publish('agent-x', { content: '2' });
  // Calling unsubscribe a second time is a no-op.
  unsubA();
  bus.publish('agent-x', { content: '3' });
  assert.equal(aReceived.length, 1);
  assert.equal(bReceived.length, 3);
});

test('subscriber throwing does not prevent other subscribers from firing', () => {
  const bus = createChatBus();
  const received = [];
  bus.subscribe('agent-x', () => { throw new Error('boom'); });
  bus.subscribe('agent-x', (msg) => received.push(msg));
  bus.publish('agent-x', { content: 'still-delivered' });
  assert.equal(received.length, 1);
  assert.equal(received[0].content, 'still-delivered');
});

test('peekSequence returns 0 for unknown channel and high-water for known channel', () => {
  const bus = createChatBus();
  assert.equal(bus.peekSequence('unknown'), 0);
  bus.publish('agent-x', { content: 'a' });
  bus.publish('agent-x', { content: 'b' });
  bus.publish('agent-y', { content: 'c' });
  assert.equal(bus.peekSequence('agent-x'), 2);
  assert.equal(bus.peekSequence('agent-y'), 1);
  assert.equal(bus.peekSequence('unknown'), 0);
});

test('publish throws TypeError on bad inputs; subscribe throws TypeError on bad inputs', () => {
  const bus = createChatBus();
  assert.throws(() => bus.publish('', { content: 'x' }), { name: 'TypeError' });
  assert.throws(() => bus.publish(123, { content: 'x' }), { name: 'TypeError' });
  assert.throws(() => bus.publish('agent-x', null), { name: 'TypeError' });
  assert.throws(() => bus.publish('agent-x', 'not-an-object'), { name: 'TypeError' });
  assert.throws(() => bus.subscribe('', () => {}), { name: 'TypeError' });
  assert.throws(() => bus.subscribe('agent-x', null), { name: 'TypeError' });
  assert.throws(() => bus.subscribe('agent-x', 'not-a-function'), { name: 'TypeError' });
});
```

**Test count:** 10 exactly.

---

## B. Acceptance gates

### B.1 — `node --check` clean

```bash
node --check dashboard/lib/chat-bus.js && echo "chat-bus.js syntax ✓"
node --check dashboard/test/chat-bus.test.js && echo "chat-bus.test.js syntax ✓"
```

### B.2 — Test suite passes; baseline = 184 (174 + 10 new)

```bash
cd dashboard && pnpm test 2>&1 | tail -5
# Expected (verbatim shape):
#   tests 184
#   pass 184
#   fail 0
```

### B.3 — Module exports match contract

```bash
node -e "const m = require('./dashboard/lib/chat-bus'); console.log(JSON.stringify(Object.keys(m).sort()));"
# Expected: ["createChatBus"]
```

### B.4 — Live exercise (informational)

```bash
node -e "
const { createChatBus } = require('./dashboard/lib/chat-bus');
const bus = createChatBus({ now: () => '2026-05-11T00:00:00.000Z' });
const got = [];
bus.subscribe('agent-x', (m) => got.push(m));
const r = bus.publish('agent-x', { content: 'hello' });
console.log(JSON.stringify({ result: r, got }));
"
# Expected output: result.sequence=1, result.ts='2026-05-11T00:00:00.000Z',
# got[0] has channel/sequence/ts/content set correctly.
```

### B.5 — Diff lock = 2 paths exactly

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.2-chat-bus
# Expected: 2 files
#   dashboard/lib/chat-bus.js (new)
#   dashboard/test/chat-bus.test.js (new)
```

### B.6 — No edits outside diff-lock

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.2-chat-bus \
  -- ':!dashboard/lib/chat-bus.js' ':!dashboard/test/chat-bus.test.js'
# Expected: empty
```

### B.7 — No prod dependency drift

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.2-chat-bus -- dashboard/package.json dashboard/pnpm-lock.yaml | head -3
# Expected: empty (no edits to package.json or pnpm-lock.yaml)
```

---

## C. Acceptance / hard gates checklist

- [ ] B.1 `node --check` clean on both new files
- [ ] B.2 test suite: 10 new chat-bus tests pass; total = **184** (174 baseline + 10 new)
- [ ] B.3 module exports = `{ createChatBus }` exactly
- [ ] B.4 live-exercise produces the documented enriched message shape
- [ ] B.5 diff-lock = 2 paths
- [ ] B.6 no edits outside diff-lock
- [ ] B.7 no prod dependency drift
- [ ] Sequence per-channel monotonicity confirmed by test
- [ ] Wildcard `'*'` semantics confirmed by test
- [ ] Channel isolation confirmed by test
- [ ] Subscriber error isolation confirmed by test
- [ ] TypeError raised on bad inputs confirmed by test
- [ ] PR body: pre-flight 1-6 outputs verbatim, B.1-B.7 outputs verbatim, the live-exercise transcript, diff-lock confirmation
- [ ] **No CHANGELOG.md update** — Phase α leaves don't bump CHANGELOG; ζ.3 handles release-doc updates

---

## D. DONE block format

```text
PR URL: <gh url>
Diff: 2 paths (2 new)
Branch: feat/dashboard-chat-mirror-alpha.2-chat-bus (targets feat/dashboard-chat-mirror, NOT main)

Pre-flight outputs:
  1. feat/dashboard-chat-mirror HEAD: a18ca69 (or descendant)
  2. α.1 output present (ws.js, ws.test.js): ✓
  3. α.2 target paths absent (chat-bus.js, chat-bus.test.js): ✓
  4. baseline test count: 174 passing
  5. tooling: node ≥22 ✓ pnpm ≥10 ✓
  6. prod deps unchanged (express + ws + dotenv): ✓

Tooling check:
  node --check dashboard/lib/chat-bus.js: ✓
  node --check dashboard/test/chat-bus.test.js: ✓

Tests:
  B.2 test suite: 174 baseline + 10 new = 184 passing ✓
  B.3 module exports: ["createChatBus"] ✓
  B.4 live exercise: sequence=1, ts injected, enriched shape correct ✓
  B.5 diff-lock = 2 paths ✓
  B.6 no out-of-scope edits ✓
  B.7 no prod dep drift ✓

Worker scope attestations:
  - No edits to dashboard/lib/ws.js (α.1 output untouched)
  - No edits to dashboard/index.js (α.4's domain to wire bus)
  - No edits to dashboard/app.js
  - No edits to dashboard/middleware/
  - No edits to dashboard/public/
  - No edits to dashboard/package.json or dashboard/pnpm-lock.yaml
  - No new prod dependencies
  - No CHANGELOG.md changes
  - No bin/hive, agents/, templates/ changes

Live exercise transcript:
  <verbatim node -e output from B.4>

Commit:
  feat(dashboard): α.2 chat-bus in-memory pub/sub
```

---

## E. Hard NO list

- DO NOT modify `dashboard/lib/ws.js` (α.1 output is canonical and frozen).
- DO NOT modify `dashboard/index.js` (α.4 wires the bus into the WS server, not this leaf).
- DO NOT modify `dashboard/app.js` (createApp shape is unchanged).
- DO NOT modify `dashboard/middleware/` (auth + helpers are stable).
- DO NOT add prod dependencies. The chat-bus is pure Node — no `eventemitter3`, no `emittery`, no `nanoid`. Standard library + Map + Set only.
- DO NOT implement JSONL persistence (β.1's scope).
- DO NOT implement Discord ingress (α.3's scope).
- DO NOT implement WS↔bus plumbing (α.4's scope).
- DO NOT implement dedup-before-wake (E.x agent inbound module's scope).
- DO NOT validate the Decision C event schema. The bus is shape-agnostic except for the three fields it injects (`channel`, `sequence`, `ts`).
- DO NOT add module-level state (no `let bus = createChatBus()` at module scope). The factory MUST be the only export.
- DO NOT add CHANGELOG entries (ζ.3 handles release-doc updates).
- DO NOT modify `dashboard/public/**` (Phase γ scope).
- DO NOT add NAV_LINKS entries to `dashboard/public/js/shell.js`.
- **EXISTING TESTS MUST STILL PASS** — 174 baseline + 10 new = 184 total. Zero regressions.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises (α.1 output missing, target paths present, test baseline wrong count, prod dep drift) stop the worker. Halt means halt — do not fix-and-proceed inline. Your 11-for-11 L8 discipline pattern is the standard.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **PR ready-for-review, NOT draft. DO NOT MERGE** — raymond-holt merges after review.
- **PR base ref enforcement.** `gh pr view --json baseRefName` MUST return `feat/dashboard-chat-mirror`. Bob's pre-merge attestation MUST quote this verbatim.

---

## F. Forward links

- **α.3 — Discord bot ingress tap.** New `src/messaging/discord-tap.ts`. Subscribes to discord.js message-create events; enriches with metadata per Decision C; calls `bus.publish(channel, msg)`. ~80 LOC.
- **α.4 — WS protocol expansion + bus plumbing.** Modifies `dashboard/lib/ws.js` (α.1 output) to: (a) instantiate or accept a chat-bus reference; (b) on incoming WS `{type: "send", channel, content, ...}` frames, call `bus.publish(channel, msg)`; (c) subscribe to channels per-client based on subscription frames; (d) push enriched messages to subscribed WS clients. Also modifies `dashboard/index.js` to construct the bus and pass it to `attachWsServer`. ~150 LOC change to ws.js + ~5 LOC change to index.js.
- **β.1 — JSONL persistence.** New `dashboard/lib/jsonl-writer.js`. Wildcard-subscribes to the bus (`bus.subscribe('*', writeToJsonl)`). Per-channel daily-rotated JSONL at `~/.neato-hive/state/chat/<channel>.YYYY-MM-DD.jsonl`. Enforces Decision C schema validation at write time. ~120 LOC + ~150 LOC tests.

End of spec.
