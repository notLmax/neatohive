process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { startLocalBridge } from "./index.js";

class FakeWebSocket extends EventEmitter {
  readyState = 0;

  send(_payload: string): void {}

  close(): void {
    this.emit("close");
  }
}

describe("startLocalBridge", () => {
  it("is a no-op when hubUrl is empty string", () => {
    const logs: string[] = [];
    let createCalls = 0;

    const handle = startLocalBridge(
      {
        agentName: "atlas",
        hubUrl: "",
        onInboundMessage: async () => {},
      },
      {
        log: (message) => logs.push(String(message)),
        error: () => {},
        setTimeout,
        clearTimeout,
        createWebSocket: () => {
          createCalls += 1;
          return new FakeWebSocket() as unknown as any;
        },
        openState: 1,
      },
    );

    handle.publish({ type: "session_reset", channelKey: "x", ts: Date.now() });
    handle.close();

    assert.equal(createCalls, 0);
    assert.deepEqual(logs, ["[local-bridge] hubUrl unset — bridge disabled"]);
  });

  it("is a no-op when hubUrl is missing/undefined", () => {
    const logs: string[] = [];
    let createCalls = 0;

    startLocalBridge(
      {
        agentName: "atlas",
        hubUrl: undefined as unknown as string,
        onInboundMessage: async () => {},
      },
      {
        log: (message) => logs.push(String(message)),
        error: () => {},
        setTimeout,
        clearTimeout,
        createWebSocket: () => {
          createCalls += 1;
          return new FakeWebSocket() as unknown as any;
        },
        openState: 1,
      },
    );

    assert.equal(createCalls, 0);
    assert.deepEqual(logs, ["[local-bridge] hubUrl unset — bridge disabled"]);
  });

  it("connects when hubUrl is provided regardless of env var", () => {
    let createCalls = 0;

    startLocalBridge(
      {
        agentName: "atlas",
        hubUrl: "ws://hub.example/ws/agent/atlas",
        onInboundMessage: async () => {},
      },
      {
        log: () => {},
        error: () => {},
        setTimeout,
        clearTimeout,
        createWebSocket: () => {
          createCalls += 1;
          return new FakeWebSocket() as unknown as any;
        },
        openState: 1,
      },
    );

    assert.equal(createCalls, 1);
  });

  it("keeps reconnect behavior when hub is unreachable", () => {
    const logs: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;

    startLocalBridge(
      {
        agentName: "atlas",
        hubUrl: "ws://hub.example/ws/agent/atlas",
        onInboundMessage: async () => {},
      },
      {
        log: (message) => logs.push(String(message)),
        error: () => {},
        setTimeout: ((cb: () => void, _delay?: number) => {
          const id = nextTimerId++;
          timers.set(id, cb);
          return id as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
          timers.delete(id as unknown as number);
        }) as typeof clearTimeout,
        createWebSocket: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket as unknown as any;
        },
        openState: 1,
      },
    );

    assert.equal(sockets.length, 1);

    sockets[0].emit("close");

    assert.deepEqual(logs, [
      "[local-bridge] Disconnected from hub",
      "[local-bridge] reconnecting in 1000ms...",
    ]);
    assert.equal(timers.size, 1);

    const reconnect = timers.get(1);
    assert.ok(reconnect);
    reconnect();

    assert.equal(sockets.length, 2);
  });
});
