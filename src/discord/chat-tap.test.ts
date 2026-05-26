import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachChatTap, type ChatBusLike, type ChannelResolver } from "./chat-tap.js";

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
    assert.equal((env.id as string).length, 36);
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
