import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEventLog,
  formatEventChain,
  formatRelativeTime,
} from "./task-status.js";

describe("parseEventLog", () => {
  it("filters events by taskId and skips malformed lines", () => {
    const raw = [
      JSON.stringify({ ts: "2026-05-06T10:00:00.000Z", taskId: "t_abc", agent: "bob", event: "discovered" }),
      "NOT JSON AT ALL",
      JSON.stringify({ ts: "2026-05-06T10:00:01.000Z", taskId: "t_other", agent: "bob", event: "spawned" }),
      JSON.stringify({ ts: "2026-05-06T10:00:02.000Z", taskId: "t_abc", agent: "bob", event: "spawned" }),
    ].join("\n");

    const events = parseEventLog(raw, "t_abc");
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "discovered");
    assert.equal(events[1].event, "spawned");
  });

  it("returns empty array when no events match the taskId (empty log case)", () => {
    const events = parseEventLog("", "t_missing");
    assert.equal(events.length, 0);
  });

  it("returns empty array when log has entries but none match", () => {
    const raw = JSON.stringify({ ts: "2026-05-06T10:00:00.000Z", taskId: "t_other", event: "boot" });
    const events = parseEventLog(raw, "t_missing");
    assert.equal(events.length, 0);
  });
});

describe("formatRelativeTime", () => {
  it("formats sub-second as +Xms", () => {
    assert.equal(formatRelativeTime(0), "+0ms");
    assert.equal(formatRelativeTime(42), "+42ms");
    assert.equal(formatRelativeTime(999), "+999ms");
  });

  it("formats seconds", () => {
    assert.equal(formatRelativeTime(1000), "+1s");
    assert.equal(formatRelativeTime(59_000), "+59s");
  });

  it("formats minutes and seconds", () => {
    assert.equal(formatRelativeTime(60_000), "+1m");
    assert.equal(formatRelativeTime(241_000), "+4m01s");
    assert.equal(formatRelativeTime(372_000), "+6m12s");
  });
});

describe("formatEventChain", () => {
  it("prints full event chain with relative timestamps", () => {
    const events = [
      { ts: "2026-05-06T10:00:00.000Z", taskId: "t_abc", agent: "bob", event: "discovered", detail: { kind: "claude", timeout: "60min" } },
      { ts: "2026-05-06T10:00:00.002Z", taskId: "t_abc", agent: "bob", event: "spawned", detail: { pid: 19131 } },
      { ts: "2026-05-06T10:04:01.000Z", taskId: "t_abc", agent: "bob", event: "exit", detail: { exitCode: 0 } },
      { ts: "2026-05-06T10:04:01.000Z", taskId: "t_abc", agent: "bob", event: "wake_enqueued", detail: { wakePath: "agents/bob/wake/t_abc.json" } },
      { ts: "2026-05-06T10:04:05.000Z", taskId: "t_abc", agent: "bob", event: "wake_picked_up", detail: { ageMs: 4012 } },
      { ts: "2026-05-06T10:04:05.000Z", taskId: "t_abc", agent: "bob", event: "wake_turn_started" },
      { ts: "2026-05-06T10:04:12.000Z", taskId: "t_abc", agent: "bob", event: "wake_turn_complete", detail: { status: "ok", durationMs: 6800 } },
      { ts: "2026-05-06T10:04:12.000Z", taskId: "t_abc", agent: "bob", event: "wake_archived", detail: { archivedPath: "agents/bob/wake/processed/t_abc.json" } },
    ];

    const output = formatEventChain(events);

    assert.ok(output.includes("Task: t_abc"));
    assert.ok(output.includes("Agent: bob"));
    assert.ok(output.includes("+0ms"));
    assert.ok(output.includes("discovered"));
    assert.ok(output.includes("wake_picked_up"));
    assert.ok(output.includes("wake_turn_complete"));
    assert.ok(output.includes("wake_archived"));
    assert.ok(output.includes("status=ok"));
  });

  it("handles partial event chain (diagnostic case — no wake_picked_up)", () => {
    const events = [
      { ts: "2026-05-06T10:00:00.000Z", taskId: "t_partial", agent: "bob", event: "discovered" },
      { ts: "2026-05-06T10:00:00.002Z", taskId: "t_partial", agent: "bob", event: "spawned" },
      { ts: "2026-05-06T10:04:01.000Z", taskId: "t_partial", agent: "bob", event: "exit" },
      { ts: "2026-05-06T10:04:01.000Z", taskId: "t_partial", agent: "bob", event: "wake_enqueued" },
    ];

    const output = formatEventChain(events);
    assert.ok(output.includes("Task: t_partial"));
    assert.ok(output.includes("discovered"));
    assert.ok(output.includes("wake_enqueued"));
    assert.ok(!output.includes("wake_picked_up"));
  });

  it("returns empty string for empty events array", () => {
    assert.equal(formatEventChain([]), "");
  });
});
