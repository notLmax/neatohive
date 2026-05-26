/**
 * messaging-queue.test.ts
 * Tests for the per-agent FIFO inbound queue (v1.4.6, Bug #1 fix).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueInbound,
  isHivemindProcessing,
  getHivemindProcessingState,
  getInboundQueueStats,
  _resetInboundQueueForTesting,
} from "./messaging.js";

async function waitForQueueDrain(maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const stats = getInboundQueueStats();
    if (stats.depth === 0 && stats.processing === null) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("queue did not drain within timeout");
}

describe("Hivemind inbound queue (v1.4.6)", () => {
  beforeEach(() => {
    _resetInboundQueueForTesting();
  });

  it("processes one inbound — start to end", async () => {
    let executed = false;
    enqueueInbound({
      id: "test-1",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { executed = true; },
    });
    await waitForQueueDrain();
    assert.equal(executed, true);
    assert.equal(isHivemindProcessing(), false);
  });

  it("serializes 5 concurrent enqueues — all processed in order, none dropped", async () => {
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      enqueueInbound({
        id: `test-${i}`,
        kind: "request",
        fromAgent: "a",
        taskId: undefined,
        enqueuedAt: Date.now(),
        process: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push(i);
        },
      });
    }
    await waitForQueueDrain();
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("isHivemindProcessing reflects worker state during processing", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "test-block",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(isHivemindProcessing(), true);
    assert.equal(getHivemindProcessingState().kind, "request");
    release!();
    await waitForQueueDrain();
    assert.equal(isHivemindProcessing(), false);
  });

  it("processor exception does not stop subsequent inbounds", async () => {
    let secondRan = false;
    enqueueInbound({
      id: "test-throw",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { throw new Error("boom"); },
    });
    enqueueInbound({
      id: "test-after",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { secondRan = true; },
    });
    await waitForQueueDrain();
    assert.equal(secondRan, true);
  });

  it("getInboundQueueStats reports depth + processing kind", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "stats-1",
      kind: "response",
      fromAgent: "a",
      taskId: "t-1",
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    enqueueInbound({
      id: "stats-2",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => {},
    });
    await new Promise((r) => setTimeout(r, 5));
    const stats = getInboundQueueStats();
    assert.equal(stats.depth, 1, "1 queued (the second), 1 processing");
    assert.equal(stats.processing?.kind, "response");
    release!();
    await waitForQueueDrain();
  });

  it("backpressure warning fires at threshold", async () => {
    const origWarn = console.warn;
    let warnedAt: string | null = null;
    console.warn = (...args: unknown[]) => {
      const msg = String(args[0]);
      if (msg.includes("backpressure")) {
        const match = msg.match(/depth crossed (\d+)/);
        if (match) warnedAt = match[1];
      }
    };
    try {
      let release: () => void;
      const blocker = new Promise<void>((r) => { release = r; });
      enqueueInbound({
        id: "block-0",
        kind: "request",
        fromAgent: "a",
        taskId: undefined,
        enqueuedAt: Date.now(),
        process: async () => { await blocker; },
      });
      for (let i = 1; i <= 15; i++) {
        enqueueInbound({
          id: `pile-${i}`,
          kind: "request",
          fromAgent: "a",
          taskId: undefined,
          enqueuedAt: Date.now(),
          process: async () => {},
        });
      }
      assert.equal(warnedAt, "10");
      release!();
      await waitForQueueDrain();
    } finally {
      console.warn = origWarn;
    }
  });

  it("queue is idle when nothing is enqueued", () => {
    const stats = getInboundQueueStats();
    assert.equal(stats.depth, 0);
    assert.equal(stats.processing, null);
    assert.equal(isHivemindProcessing(), false);
    assert.deepEqual(getHivemindProcessingState(), { active: false, kind: null });
  });

  it("getHivemindProcessingState reflects kind during processing", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "kind-test",
      kind: "escalation",
      fromAgent: "b",
      taskId: "t-2",
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 5));
    const state = getHivemindProcessingState();
    assert.equal(state.active, true);
    assert.equal(state.kind, "escalation");
    release!();
    await waitForQueueDrain();
    const after = getHivemindProcessingState();
    assert.equal(after.active, false);
    assert.equal(after.kind, null);
  });

  it("multiple kinds processed in FIFO order", async () => {
    const kinds: string[] = [];
    for (const kind of ["request", "response", "escalation", "request"] as const) {
      enqueueInbound({
        id: `kind-${kind}-${kinds.length}`,
        kind,
        fromAgent: "a",
        taskId: kind === "response" || kind === "escalation" ? "t-x" : undefined,
        enqueuedAt: Date.now(),
        process: async () => {
          kinds.push(kind);
          await new Promise((r) => setTimeout(r, 5));
        },
      });
    }
    await waitForQueueDrain();
    assert.deepEqual(kinds, ["request", "response", "escalation", "request"]);
  });

  it("_resetInboundQueueForTesting clears all state", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "reset-test",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(isHivemindProcessing(), true);
    // Force reset while processing — simulates test isolation
    _resetInboundQueueForTesting();
    assert.equal(isHivemindProcessing(), false);
    assert.equal(getInboundQueueStats().depth, 0);
    // Clean up the blocked promise to avoid unhandled rejection
    release!();
  });

  it("enqueueInbound after drain completes starts a new drain cycle", async () => {
    let count = 0;
    enqueueInbound({
      id: "cycle-1",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { count++; },
    });
    await waitForQueueDrain();
    assert.equal(count, 1);

    // Second enqueue after drain finished
    enqueueInbound({
      id: "cycle-2",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { count++; },
    });
    await waitForQueueDrain();
    assert.equal(count, 2);
  });

  it("stats ageMs increases while processing", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "age-test",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 20));
    const stats = getInboundQueueStats();
    assert.ok(stats.processing !== null);
    assert.ok(stats.processing!.ageMs >= 15, `ageMs=${stats.processing!.ageMs} should be >= 15`);
    release!();
    await waitForQueueDrain();
  });
});
