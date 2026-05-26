import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { computeBridgeHubUrl, registerReadyHandlers } from "./bot.js";

class FakeClient extends EventEmitter {
  on(eventName: string, listener: (...args: any[]) => void): this {
    return super.on(eventName, listener);
  }
}

test("registerReadyHandlers fires when clientReady is emitted", async () => {
  const client = new FakeClient();
  let calls = 0;

  registerReadyHandlers(client, async () => {
    calls++;
  });

  client.emit("clientReady");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
});

test("registerReadyHandlers is idempotent across ready and clientReady", async () => {
  const client = new FakeClient();
  let calls = 0;

  registerReadyHandlers(client, async () => {
    calls++;
  });

  client.emit("ready");
  client.emit("clientReady");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
});

test("computeBridgeHubUrl defaults to the loopback URL when LOCAL_BRIDGE_URL is unset", () => {
  assert.equal(
    computeBridgeHubUrl({} as NodeJS.ProcessEnv, "atlas"),
    "ws://127.0.0.1:7777/ws/agent/atlas",
  );
});

test("computeBridgeHubUrl honors LOCAL_BRIDGE_URL override when set", () => {
  assert.equal(
    computeBridgeHubUrl({ LOCAL_BRIDGE_URL: "ws://remote:9999/agent" } as NodeJS.ProcessEnv, "atlas"),
    "ws://remote:9999/agent",
  );
});

test("computeBridgeHubUrl returns empty string when LOCAL_BRIDGE_DISABLED is 'true'", () => {
  assert.equal(
    computeBridgeHubUrl({ LOCAL_BRIDGE_DISABLED: "true" } as NodeJS.ProcessEnv, "atlas"),
    "",
  );
  assert.equal(
    computeBridgeHubUrl(
      { LOCAL_BRIDGE_DISABLED: "true", LOCAL_BRIDGE_URL: "ws://remote:9999/agent" } as NodeJS.ProcessEnv,
      "atlas",
    ),
    "",
  );
});
