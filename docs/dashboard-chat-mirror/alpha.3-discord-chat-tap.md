# Chat-Mirror α.3 — Discord Chat Tap

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage once spec lands on **`feat/dashboard-chat-mirror`** (the long-running feature branch, NOT main).
**Project:** dashboard-chat-mirror (v1.5.x)
**Phase:** α — Backend WebSocket infrastructure (4 leaves)
**Leaf:** α.3 (3 of 4 in Phase α)
**Author:** raymond-holt
**Reviewer/dispatcher/merger:** raymond-holt
**Executor:** bob-the-builder (codex strict per standing directive `t-moul3bj20003`)
**Predecessors:** α.1 merged `a18ca69` (WS server skeleton); α.2 merged `1c0b8bf` (chat-bus pub/sub).
**Successor:** α.4 (full message protocol + reconnect flow + WS↔bus plumbing; α.3.x or β.1 will wire the tap into `src/discord/bot.ts`).

---

## ⚠ Workflow lock — feature branch isolation

**ALL work on this leaf targets `feat/dashboard-chat-mirror`, NOT main.** Per Daniel's 2026-05-10 directive (LESSONS.md L9): chat-mirror lives on its own long-running branch until the full feature verifies end-to-end, then merges to main as a single owner-paced ceremony.

**Bob dispatch:**
- `git checkout feat/dashboard-chat-mirror && git pull origin feat/dashboard-chat-mirror` (NOT main)
- Leaf branch: `feat/dashboard-chat-mirror-alpha.3-discord-chat-tap` (worker creates AFTER pre-flight passes)
- PR base ref: `feat/dashboard-chat-mirror`

---

## ⚠ Architectural framing (read first)

The dashboard's chat-mirror has TWO inputs:
1. **Discord** — message events arriving in the AGENT BOT processes (via `discord.js` `messageCreate`).
2. **Dashboard WS clients** — users typing into the dashboard chat UI (α.4 + γ phase).

Each agent bot process runs its own `discord.js` `Client` instance. The chat-bus (α.2) is a pure in-memory module — anyone can instantiate one. The design pattern:

- An agent bot process instantiates its OWN chat-bus instance at boot.
- The Discord tap (α.3, THIS leaf) registers a `messageCreate` listener on the bot's `discord.js` Client and **publishes enriched events to that bus**.
- Downstream subscribers (β.1 JSONL writer; future agent-inbound transport at E-decision) consume from the bus.
- The dashboard process is a SEPARATE process; it does not share the bus instance. The dashboard reads from JSONL (β.1 output) to populate its own chat-mirror UI.

**This leaf ships JUST the tap module + tests.** It does NOT wire the tap into `src/discord/bot.ts` (a separate concern; see §F forward links). It does NOT instantiate a chat-bus singleton at bot boot. It is a pure module with injectable dependencies, fully testable with mock client + mock bus.

---

## Goal

Ship the Discord ingress tap that maps a `discord.js` `messageCreate` event into a Decision C-shaped chat-bus publish. This leaf is foundational; once landed and wired (later), all Discord traffic becomes chat-mirror visible.

The leaf ships:

1. **`src/discord/chat-tap.ts`** — the module. Exports `attachChatTap({ client, bus, channelResolver })` returning `{ detach }`. Subscribes to `messageCreate` on the supplied client; for each message: invokes the channelResolver, builds a Decision C-shaped envelope (fields it owns), and calls `bus.publish(channel, envelope)`. Returns a `detach` function that unregisters the listener.
2. **`src/discord/chat-tap.test.ts`** — `node:test` (via `tsx --test`) covering listener registration, detach lifecycle, Decision C envelope shape, channelResolver null-skip, error isolation between handler invocations.

**NO wiring into `src/discord/bot.ts`.** The bot.ts integration (instantiate bus + tap at bot boot, plus channel resolution config) is a separate concern. This leaf is pure module + tests.

**NO chat-bus instantiation in this leaf.** Caller (eventual bot.ts wiring) instantiates the bus and injects it.

**NO Discord client construction.** Caller supplies the discord.js Client instance.

**NO attachment mirroring.** Decision A's local-mirror attachment work is δ phase. α.3 stubs `attachments: []`.

**NO hivemind metadata parsing.** Extracting `task_id` and `kind` from inbound hivemind text is a downstream concern. α.3 stubs `metadata: {}`.

**NO author→agent-name resolution.** `author_id = message.author.id` always (raw Discord snowflake). `author_kind = 'agent'` if `message.author.bot`, else `'user'`. Mapping bot snowflakes to agent names is a downstream concern.

**Owner directive carry-overs (project doc):**
- Decision C (locked 2026-05-10): JSONL per-channel + locked event schema. Tap fills the fields it owns (`id`, `source`, `source_message_id`, `author_id`, `author_kind`, `content`, `attachments`, `metadata`); bus fills `channel`, `sequence`, `ts`.
- Decision E (locked 2026-05-10): dedup-before-wake LRU lives in the AGENT inbound module (future phase), NOT in the tap. The tap publishes EVERY messageCreate to the bus.

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

α.3 owns: `id`, `source`, `source_message_id`, `author_id`, `author_kind`, `content`, `attachments` (stubbed `[]`), `metadata` (stubbed `{}`).
α.2's chat-bus injects: `channel`, `sequence`, `ts`.

### α.2's chat-bus contract (`dashboard/lib/chat-bus.js`)

```js
module.exports = { createChatBus };
// createChatBus() returns: { publish, subscribe, peekSequence, channels }
// publish(channel, msg) → { sequence, ts, enriched }
// throws TypeError on bad inputs
```

The tap injects a `bus` that conforms to this `publish(channel, msg)` interface. **Tests use a mock bus**, so the cross-process question (dashboard JS vs framework TS) does not arise in this leaf.

### Idiom — match existing `src/discord/*.ts`

- `'use strict'` is NOT used (ESM modules); but `"type": "module"` in `package.json` is.
- Imports use `.js` extension (TS-to-JS resolution): `import { extractAttachments } from "./attachments.js"`.
- Test files use `node:test` + `node:assert/strict`, run via `tsx --test`.
- See `src/discord/attachments.ts` and `src/discord/attachments.test.ts` for reference.

---

## Diff lock — 2 paths exactly

1. `src/discord/chat-tap.ts` (NEW)
2. `src/discord/chat-tap.test.ts` (NEW)

**NO other paths.** No modifications to `src/discord/bot.ts` (wiring is a future leaf), `src/discord/attachments.ts`, `src/discord/attachments.test.ts`, `package.json`, `pnpm-lock.yaml`, `dashboard/` (different process), or anywhere else. No new prod dependencies — uses `discord.js` (already a prod dep) + `node:crypto` (stdlib).

---

## A. Pre-flight halts (HALT and ping raymond-holt if ANY fail)

```bash
# 1. On feat/dashboard-chat-mirror, clean working tree per whitelist
cd ~/neato-hive
git fetch origin
git checkout feat/dashboard-chat-mirror
git pull origin feat/dashboard-chat-mirror
git rev-parse --abbrev-ref HEAD                 # Expected: feat/dashboard-chat-mirror
git rev-parse HEAD                               # Expected: 1c0b8bf or descendant
```

```bash
# 2. α.1 + α.2 output present (sanity check)
test -f dashboard/lib/ws.js && echo "α.1 ws.js ✓"
test -f dashboard/lib/chat-bus.js && echo "α.2 chat-bus.js ✓"
grep -nE '^module\.exports = \{ createChatBus \};' dashboard/lib/chat-bus.js | head -1
# Expected: 1 match
```

```bash
# 3. α.3 target paths absent
test ! -e src/discord/chat-tap.ts && echo "chat-tap.ts absent ✓"
test ! -e src/discord/chat-tap.test.ts && echo "chat-tap.test.ts absent ✓"
```

```bash
# 4. Framework test baseline (capture for post-implementation comparison)
pnpm test 2>&1 | tail -5 | tee /tmp/alpha3-baseline.out
# Capture the "tests N" / "pass N" / "fail 0" lines verbatim.
# Expected: fail 0. The N value is variable — record it.
# Post-implementation expectation: tests = N + 7 (7 new α.3 tests).
```

```bash
# 5. Tooling
node --version    # Expected: ≥ 22
pnpm --version    # Expected: ≥ 10
```

```bash
# 6. discord.js is a prod dep (sanity, no drift planned)
grep -nE '"discord\.js":' package.json | head -1
# Expected: 1 match
```

```bash
# 7. src/discord/ test file picked up by pnpm test pattern
grep -nE '"test":.*src/discord/\*\.test\.ts' package.json | head -1
# Expected: 1 match — confirms src/discord/chat-tap.test.ts will be auto-included
```

**HALT and ping raymond-holt** if any check fails. Halt-and-ping means HALT — do not fix-and-proceed inline. Your 12-for-12 L8 discipline pattern is the standard.

---

## A.1 — `src/discord/chat-tap.ts` implementation

**File:** `src/discord/chat-tap.ts` (NEW)

**Locked contract (exact shape — codex must match):**

```typescript
/**
 * Discord chat tap — subscribes to discord.js messageCreate and publishes
 * enriched events to a chat-bus instance per Decision C schema.
 *
 * Caller supplies:
 *   - client: a discord.js Client (the agent's bot instance)
 *   - bus: a chat-bus instance (publish(channel, msg) → { sequence, ts, enriched })
 *   - channelResolver: maps a discord.js Message to a channel name string,
 *     or returns null to skip (e.g., DMs, ignored channels)
 *
 * Returns: { detach } — call detach() to unregister the listener.
 *
 * Per α.3 scope:
 *   - Owns: id (uuid), source ('discord'), source_message_id (message.id),
 *     author_id (message.author.id), author_kind ('user' or 'agent'),
 *     content (message.content), attachments ([] stub), metadata ({} stub).
 *   - Bus owns: channel (via resolver, injected to publish), sequence, ts.
 *
 * Errors during handler invocation are swallowed silently — Discord listener
 * errors MUST NOT crash the bot process. Structured error logging is a
 * downstream concern.
 */

import { randomUUID } from "node:crypto";
import type { Client, Message } from "discord.js";

export interface ChatBusLike {
  publish: (
    channel: string,
    message: unknown,
  ) => { sequence: number; ts: string; enriched: unknown };
}

export type ChannelResolver = (message: Message) => string | null;

export interface AttachChatTapOptions {
  client: Client;
  bus: ChatBusLike;
  channelResolver: ChannelResolver;
}

export interface ChatTapHandle {
  detach: () => void;
}

export function attachChatTap({
  client,
  bus,
  channelResolver,
}: AttachChatTapOptions): ChatTapHandle {
  if (!client || typeof (client as any).on !== "function") {
    throw new TypeError("attachChatTap: client must be a discord.js Client");
  }
  if (!bus || typeof bus.publish !== "function") {
    throw new TypeError("attachChatTap: bus must implement publish(channel, msg)");
  }
  if (typeof channelResolver !== "function") {
    throw new TypeError("attachChatTap: channelResolver must be a function");
  }

  const handler = (message: Message): void => {
    try {
      const channel = channelResolver(message);
      if (typeof channel !== "string" || channel.length === 0) {
        return;
      }

      const envelope = {
        id: randomUUID(),
        source: "discord" as const,
        source_message_id: message.id,
        author_id: message.author.id,
        author_kind: message.author.bot ? ("agent" as const) : ("user" as const),
        content: message.content,
        attachments: [] as Array<{
          filename: string;
          local_path: string;
          url: string;
          size_bytes: number;
        }>,
        metadata: {} as Record<string, unknown>,
      };

      bus.publish(channel, envelope);
    } catch {
      // Swallow — Discord listener errors must not crash the bot.
      // Downstream observability layers (later phase) can wrap or replace
      // this catch with structured logging.
    }
  };

  client.on("messageCreate", handler);

  return {
    detach(): void {
      client.off("messageCreate", handler);
    },
  };
}
```

**Hard contracts (will be acceptance-tested):**
- Module exports: named `attachChatTap` function + interface types (`ChatBusLike`, `ChannelResolver`, `AttachChatTapOptions`, `ChatTapHandle`).
- `attachChatTap` returns an object with a `detach` function.
- Listener registered on `client.on('messageCreate', handler)`.
- `detach()` calls `client.off('messageCreate', handler)`.
- Envelope shape exactly matches Decision C's tap-owned fields.
- channelResolver returning `null` or empty string causes the handler to SKIP (no publish).
- Errors thrown inside the handler do not propagate.
- `TypeError` thrown synchronously if `client`, `bus`, or `channelResolver` is missing or wrong shape.

---

## A.2 — `src/discord/chat-tap.test.ts` implementation

**File:** `src/discord/chat-tap.test.ts` (NEW)

**Locked test list (7 tests):**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachChatTap, type ChatBusLike, type ChannelResolver } from "./chat-tap.js";

// Minimal fake Client: supports on() / off() / emit().
function createFakeClient() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      const arr = listeners.get(event);
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(event: string, ...args: unknown[]) {
      const arr = listeners.get(event);
      if (!arr) return;
      for (const cb of [...arr]) cb(...args);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.length ?? 0;
    },
  };
}

// Minimal fake bus that records publishes.
function createFakeBus(): ChatBusLike & { records: Array<{ channel: string; msg: unknown }> } {
  const records: Array<{ channel: string; msg: unknown }> = [];
  return {
    records,
    publish(channel: string, msg: unknown) {
      records.push({ channel, msg });
      return { sequence: records.length, ts: "2026-05-11T00:00:00.000Z", enriched: msg };
    },
  };
}

// Minimal fake Message: author + content + id.
function fakeMessage(opts: {
  id: string;
  content: string;
  authorId: string;
  authorBot?: boolean;
}) {
  return {
    id: opts.id,
    content: opts.content,
    author: { id: opts.authorId, bot: opts.authorBot ?? false },
  };
}

describe("attachChatTap", () => {
  it("registers a messageCreate listener and detach removes it", () => {
    const client = createFakeClient();
    const bus = createFakeBus();
    const resolver: ChannelResolver = () => "agent-x";
    const handle = attachChatTap({ client: client as any, bus, channelResolver: resolver });
    assert.equal(client.listenerCount("messageCreate"), 1);
    handle.detach();
    assert.equal(client.listenerCount("messageCreate"), 0);
  });

  it("publishes a Decision C-shaped envelope on messageCreate for a 'user' message", () => {
    const client = createFakeClient();
    const bus = createFakeBus();
    const resolver: ChannelResolver = () => "agent-x";
    attachChatTap({ client: client as any, bus, channelResolver: resolver });

    const msg = fakeMessage({ id: "snowflake-1", content: "hello", authorId: "user-123", authorBot: false });
    client.emit("messageCreate", msg);

    assert.equal(bus.records.length, 1);
    assert.equal(bus.records[0].channel, "agent-x");
    const env = bus.records[0].msg as Record<string, unknown>;
    assert.equal(typeof env.id, "string");
    assert.equal((env.id as string).length, 36); // UUID length
    assert.equal(env.source, "discord");
    assert.equal(env.source_message_id, "snowflake-1");
    assert.equal(env.author_id, "user-123");
    assert.equal(env.author_kind, "user");
    assert.equal(env.content, "hello");
    assert.deepEqual(env.attachments, []);
    assert.deepEqual(env.metadata, {});
  });

  it("sets author_kind='agent' when message.author.bot is true", () => {
    const client = createFakeClient();
    const bus = createFakeBus();
    attachChatTap({ client: client as any, bus, channelResolver: () => "agent-x" });

    client.emit("messageCreate", fakeMessage({ id: "s1", content: "bot-msg", authorId: "bot-456", authorBot: true }));
    const env = bus.records[0].msg as Record<string, unknown>;
    assert.equal(env.author_kind, "agent");
    assert.equal(env.author_id, "bot-456");
  });

  it("skips publish when channelResolver returns null", () => {
    const client = createFakeClient();
    const bus = createFakeBus();
    attachChatTap({ client: client as any, bus, channelResolver: () => null });

    client.emit("messageCreate", fakeMessage({ id: "s1", content: "ignored", authorId: "u1" }));
    assert.equal(bus.records.length, 0);
  });

  it("skips publish when channelResolver returns an empty string", () => {
    const client = createFakeClient();
    const bus = createFakeBus();
    attachChatTap({ client: client as any, bus, channelResolver: () => "" });

    client.emit("messageCreate", fakeMessage({ id: "s1", content: "ignored", authorId: "u1" }));
    assert.equal(bus.records.length, 0);
  });

  it("swallows errors thrown inside channelResolver or bus.publish (does not crash on emit)", () => {
    const client = createFakeClient();
    const throwingBus: ChatBusLike = {
      publish() {
        throw new Error("bus boom");
      },
    };
    attachChatTap({ client: client as any, bus: throwingBus, channelResolver: () => "agent-x" });

    // Must not throw.
    assert.doesNotThrow(() => {
      client.emit("messageCreate", fakeMessage({ id: "s1", content: "x", authorId: "u1" }));
    });

    const throwingResolver: ChannelResolver = () => {
      throw new Error("resolver boom");
    };
    const bus2 = createFakeBus();
    const client2 = createFakeClient();
    attachChatTap({ client: client2 as any, bus: bus2, channelResolver: throwingResolver });
    assert.doesNotThrow(() => {
      client2.emit("messageCreate", fakeMessage({ id: "s2", content: "y", authorId: "u2" }));
    });
    assert.equal(bus2.records.length, 0);
  });

  it("throws TypeError on bad inputs to attachChatTap", () => {
    const bus = createFakeBus();
    const resolver: ChannelResolver = () => "agent-x";
    assert.throws(() => attachChatTap({ client: null as any, bus, channelResolver: resolver }), { name: "TypeError" });
    assert.throws(() => attachChatTap({ client: {} as any, bus, channelResolver: resolver }), { name: "TypeError" });
    const client = createFakeClient();
    assert.throws(() => attachChatTap({ client: client as any, bus: null as any, channelResolver: resolver }), { name: "TypeError" });
    assert.throws(() => attachChatTap({ client: client as any, bus: {} as any, channelResolver: resolver }), { name: "TypeError" });
    assert.throws(() => attachChatTap({ client: client as any, bus, channelResolver: null as any }), { name: "TypeError" });
  });
});
```

**Test count:** 7 exactly.

---

## B. Acceptance gates

### B.1 — TypeScript compilation clean

```bash
pnpm build 2>&1 | tail -10
# Expected: success (no errors). The tsc build emits to dist/.
```

### B.2 — Test suite passes; baseline + 7 = total

```bash
pnpm test 2>&1 | tail -5
# Expected (verbatim shape — exact N varies by baseline; record both pre-flight count and this count):
#   tests <baseline + 7>
#   pass <baseline + 7>
#   fail 0
```

### B.3 — Module exports match contract

```bash
node -e "
import('./src/discord/chat-tap.ts').catch(async () => {
  // tsx required for direct TS import. Use the built dist path instead.
  const m = await import('./dist/discord/chat-tap.js');
  console.log(JSON.stringify(Object.keys(m).sort()));
});
"
# Easier alternative:
pnpm build && node -e "import('./dist/discord/chat-tap.js').then(m => console.log(JSON.stringify(Object.keys(m).sort())))"
# Expected: ["attachChatTap"] (interface types vanish at runtime)
```

### B.4 — Live exercise (informational)

```bash
pnpm build && node --input-type=module -e "
import { attachChatTap } from './dist/discord/chat-tap.js';
const listeners = new Map();
const client = {
  on(e, cb) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); },
  off(e, cb) { const a = listeners.get(e); if (a) a.splice(a.indexOf(cb), 1); },
  emit(e, ...args) { (listeners.get(e) || []).slice().forEach(cb => cb(...args)); },
};
const records = [];
const bus = { publish(ch, m) { records.push({ ch, m }); return { sequence: records.length, ts: '2026-05-11T00:00:00.000Z', enriched: m }; } };
const handle = attachChatTap({ client, bus, channelResolver: () => 'agent-x' });
client.emit('messageCreate', { id: 'snow-1', content: 'hi', author: { id: 'user-1', bot: false } });
console.log(JSON.stringify(records, null, 2));
handle.detach();
console.log('detached, listeners after:', (listeners.get('messageCreate') || []).length);
"
# Expected output: 1 record with channel='agent-x', envelope shaped per Decision C; "listeners after: 0".
```

### B.5 — Diff lock = 2 paths exactly

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.3-discord-chat-tap
# Expected: 2 files
#   src/discord/chat-tap.ts (new)
#   src/discord/chat-tap.test.ts (new)
```

### B.6 — No edits outside diff-lock

```bash
git diff --stat feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.3-discord-chat-tap \
  -- ':!src/discord/chat-tap.ts' ':!src/discord/chat-tap.test.ts'
# Expected: empty
```

### B.7 — No prod dependency drift

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.3-discord-chat-tap -- package.json pnpm-lock.yaml | head -3
# Expected: empty
```

### B.8 — `src/discord/bot.ts` untouched

```bash
git diff feat/dashboard-chat-mirror...feat/dashboard-chat-mirror-alpha.3-discord-chat-tap -- src/discord/bot.ts | head -3
# Expected: empty (bot.ts wiring is a future leaf, NOT α.3)
```

---

## C. Acceptance / hard gates checklist

- [ ] B.1 `pnpm build` clean
- [ ] B.2 test suite: 7 new chat-tap tests pass; total = baseline + 7
- [ ] B.3 module exports = `{ attachChatTap }` at runtime (TS interface types vanish)
- [ ] B.4 live-exercise produces the documented envelope shape
- [ ] B.5 diff-lock = 2 paths
- [ ] B.6 no edits outside diff-lock
- [ ] B.7 no prod dependency drift
- [ ] B.8 `src/discord/bot.ts` untouched
- [ ] Envelope shape: `{ id, source, source_message_id, author_id, author_kind, content, attachments: [], metadata: {} }` confirmed by test
- [ ] `author_kind = 'agent'` when `message.author.bot === true`; `'user'` otherwise — confirmed by test
- [ ] channelResolver `null` and empty-string both skip publish — confirmed by test
- [ ] Handler swallows errors from resolver and bus — confirmed by test
- [ ] `attachChatTap` throws TypeError on bad inputs — confirmed by test
- [ ] PR body: pre-flight 1-7 outputs verbatim, B.1-B.8 outputs verbatim, live-exercise transcript, diff-lock confirmation
- [ ] **No CHANGELOG.md update** — Phase α leaves don't bump CHANGELOG

---

## D. DONE block format

```text
PR URL: <gh url>
Diff: 2 paths (2 new)
Branch: feat/dashboard-chat-mirror-alpha.3-discord-chat-tap (targets feat/dashboard-chat-mirror, NOT main)

Pre-flight outputs:
  1. feat/dashboard-chat-mirror HEAD: 1c0b8bf (or descendant)
  2. α.1 + α.2 outputs present (ws.js + chat-bus.js): ✓
  3. α.3 target paths absent (chat-tap.ts + chat-tap.test.ts): ✓
  4. baseline test count: <N> passing (record exact number)
  5. tooling: node ≥22 ✓ pnpm ≥10 ✓
  6. discord.js prod dep present: ✓
  7. test script picks up src/discord/*.test.ts: ✓

Build:
  pnpm build: ✓ (no errors)

Tests:
  B.2 test suite: <N> baseline + 7 new = <N+7> passing ✓
  B.3 module exports: ["attachChatTap"] ✓
  B.4 live exercise: 1 publish recorded, envelope shape correct, detach removes listener ✓
  B.5 diff-lock = 2 paths ✓
  B.6 no out-of-scope edits ✓
  B.7 no prod dep drift ✓
  B.8 src/discord/bot.ts untouched ✓

Worker scope attestations:
  - No edits to src/discord/bot.ts (wiring is future leaf)
  - No edits to src/discord/attachments.ts or attachments.test.ts
  - No edits to dashboard/ (different process)
  - No edits to package.json or pnpm-lock.yaml
  - No new prod dependencies
  - No CHANGELOG.md changes

Live exercise transcript:
  <verbatim node --input-type=module output from B.4>

Commit:
  feat(discord): α.3 chat-tap publishes Discord messages to chat-bus
```

---

## E. Hard NO list

- DO NOT modify `src/discord/bot.ts` — wiring the tap into the bot is a separate, future leaf. This leaf is pure module + tests.
- DO NOT modify `src/discord/attachments.ts` or `attachments.test.ts` — attachment-mirror work (Decision A) is Phase δ.
- DO NOT modify `dashboard/lib/chat-bus.js` (α.2 frozen) or any dashboard/ file (different process).
- DO NOT modify `package.json` or `pnpm-lock.yaml` — no new prod deps. discord.js and node:crypto cover all needs.
- DO NOT implement chat-bus instantiation. Caller injects the bus.
- DO NOT implement Discord client construction. Caller injects the client.
- DO NOT implement attachment-mirror (`Decision A`). α.3 stubs `attachments: []`.
- DO NOT implement hivemind metadata parsing (extracting task_id/kind from content). α.3 stubs `metadata: {}`.
- DO NOT implement author bot→agent-name resolution. `author_id = message.author.id`; `author_kind` derived from `message.author.bot`.
- DO NOT implement dedup-before-wake (Decision E). The tap publishes every messageCreate; dedup is downstream.
- DO NOT implement channel resolution policy (which channels become which bus channels). channelResolver is INJECTED. The leaf does not pre-bake any specific resolution logic.
- DO NOT touch `dashboard/test/ws.test.js` or `dashboard/test/chat-bus.test.js` — α.1 and α.2 tests are frozen.
- DO NOT modify the `pnpm test` script in package.json — `src/discord/*.test.ts` is already in the glob pattern; new test file auto-included.
- DO NOT add `'use strict'` to the .ts files — ESM is enforced via `"type": "module"`.
- DO NOT use CommonJS `require()` — use ESM `import`.
- DO NOT import without `.js` extension — TS-to-JS resolution requires `import { X } from "./y.js"`.
- DO NOT add CHANGELOG entries (ζ.3 handles release-doc updates).
- **EXISTING TESTS MUST STILL PASS** — zero regressions.
- **HALT-and-ping rule (L8 reinforcement)** — pre-flight surprises stop the worker. Halt means halt — do not fix-and-proceed inline. Your 12-for-12 L8 discipline pattern is the standard.
- **`gh repo clone` not SSH** for any fresh clones.
- **on-complete prompt is bob-aimed** — pings raymond-holt `kind=delegation` when DONE block emitted.
- **PR ready-for-review, NOT draft. DO NOT MERGE** — raymond-holt merges after review.
- **PR base ref enforcement.** `gh pr view --json baseRefName` MUST return `feat/dashboard-chat-mirror`. Bob's pre-merge attestation MUST quote this verbatim.

---

## F. Forward links

- **α.4 — Full message protocol + WS↔bus plumbing.** Modifies `dashboard/lib/ws.js` (α.1 output) and `dashboard/index.js` to instantiate a chat-bus, pass it into the WS server, and wire WS clients to subscribe/publish per-channel. Also defines the full WS frame protocol (`{type: "send"|"subscribe"|"unsubscribe"|"ack", ...}`) and the reconnect-replay flow using `last_ack_seen` + `reconnect_token` minted in α.1. ~150 LOC change to ws.js + ~10 LOC change to index.js.
- **α.3.5 (future)** — wires the chat-tap into `src/discord/bot.ts`: at agent boot, instantiate a chat-bus instance, build a channelResolver from config (mapping Discord channel IDs to agent names per the agent's `config.yaml`), call `attachChatTap({ client, bus, channelResolver })`. Adds bus subscribers (β.1 JSONL writer, future agent-inbound transport). This is its own focused leaf, possibly part of β.x.
- **β.1 — JSONL persistence.** New `dashboard/lib/jsonl-writer.js` AND/OR `src/messaging/jsonl-writer.ts` (depending on whether persistence happens in agent bot process, dashboard process, or both). Wildcard-subscribes to a chat-bus. Per-channel daily-rotated JSONL at `~/.neato-hive/state/chat/<channel>.YYYY-MM-DD.jsonl`. Enforces Decision C schema validation at write time.

End of spec.
