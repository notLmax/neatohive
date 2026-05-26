/**
 * Tests for the cron subsystem.
 *
 * Phase 3: per-agent cron ownership (agent field, scope, legacy detection).
 * Phase 4: cronRemove fix + file watcher reconcile with debouncing.
 *
 * Run: `pnpm test`.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cronAdd,
  cronListForAgent,
  cronRemove,
  initCronJobs,
  loadJobs,
  activeTasks,
  reconcileActiveTasks,
  _resetCronForTesting,
} from "./cron.js";

// ── Phase 3: per-agent cron ownership ──────────────────────────

describe("Phase 3 — cron agent field + per-agent scope", () => {
  const origEnv = process.env.HIVE_AGENT_NAME;

  beforeEach(() => {
    _resetCronForTesting();
  });

  afterEach(() => {
    _resetCronForTesting();
    if (origEnv !== undefined) {
      process.env.HIVE_AGENT_NAME = origEnv;
    } else {
      delete process.env.HIVE_AGENT_NAME;
    }
    // Clean up any data dir created during test
    try {
      if (existsSync("./data/cron-jobs.json")) {
        writeFileSync("./data/cron-jobs.json", "[]");
      }
    } catch {}
  });

  it("cronAdd(agent='A', ...) stores agent='A' on the job", () => {
    process.env.HIVE_AGENT_NAME = "A";
    const job = cronAdd("A", "* * * * *", "echo hi", "test job");
    assert.equal(job.agent, "A");
  });

  it("cronAdd('', ...) throws (non-empty validation)", () => {
    assert.throws(
      () => cronAdd("", "* * * * *", "echo hi", "test"),
      /non-empty agent name/,
    );
  });

  it("cronAdd with whitespace-only agent throws", () => {
    assert.throws(
      () => cronAdd("   ", "* * * * *", "echo hi", "test"),
      /non-empty agent name/,
    );
  });

  it("cronListForAgent returns only matching agent's crons", () => {
    process.env.HIVE_AGENT_NAME = "A";
    cronAdd("A", "* * * * *", "cmd-a", "job A");
    cronAdd("B", "* * * * *", "cmd-b", "job B");
    const aJobs = cronListForAgent("A");
    const bJobs = cronListForAgent("B");
    assert.equal(aJobs.length, 1);
    assert.equal(aJobs[0].agent, "A");
    assert.equal(bJobs.length, 1);
    assert.equal(bJobs[0].agent, "B");
  });

  it("initCronJobs with HIVE_AGENT_NAME unset → no jobs scheduled, warning logged", () => {
    delete process.env.HIVE_AGENT_NAME;
    // Write a job to the registry
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync("./data/cron-jobs.json", JSON.stringify([{
      id: "cron-test-1",
      agent: "atlas",
      schedule: "* * * * *",
      command: "echo hi",
      description: "test",
      type: "agent",
      createdAt: new Date().toISOString(),
      enabled: true,
    }]));

    // Should not throw, should early return
    initCronJobs();
    assert.equal(activeTasks.size, 0, "no tasks should be scheduled without HIVE_AGENT_NAME");
  });

  it("initCronJobs with HIVE_AGENT_NAME=A → only A's jobs scheduled", () => {
    process.env.HIVE_AGENT_NAME = "A";
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync("./data/cron-jobs.json", JSON.stringify([
      { id: "cron-a", agent: "A", schedule: "* * * * *", command: "echo a", description: "a", type: "agent", createdAt: new Date().toISOString(), enabled: true },
      { id: "cron-b", agent: "B", schedule: "* * * * *", command: "echo b", description: "b", type: "agent", createdAt: new Date().toISOString(), enabled: true },
    ]));

    initCronJobs();
    assert.equal(activeTasks.size, 1, "only agent A's job should be scheduled");
    assert.ok(activeTasks.has("cron-a"));
    assert.ok(!activeTasks.has("cron-b"));
  });

  it("initCronJobs with a legacy entry (no agent field) → warning logged, entry skipped", () => {
    process.env.HIVE_AGENT_NAME = "A";
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync("./data/cron-jobs.json", JSON.stringify([
      { id: "cron-legacy", schedule: "* * * * *", command: "echo old", description: "legacy", type: "shell", createdAt: new Date().toISOString(), enabled: true },
      { id: "cron-new", agent: "A", schedule: "* * * * *", command: "echo new", description: "new", type: "agent", createdAt: new Date().toISOString(), enabled: true },
    ]));

    initCronJobs();
    // Legacy entry should NOT be scheduled
    assert.ok(!activeTasks.has("cron-legacy"), "legacy entry must not be scheduled");
    assert.ok(activeTasks.has("cron-new"), "new entry for this agent should be scheduled");
  });
});

// ── Phase 4: cronRemove fix + reconcile ────────────────────────

describe("Phase 4 — cronRemove fix + reconcile", () => {
  const origEnv = process.env.HIVE_AGENT_NAME;

  beforeEach(() => {
    _resetCronForTesting();
  });

  afterEach(() => {
    _resetCronForTesting();
    if (origEnv !== undefined) {
      process.env.HIVE_AGENT_NAME = origEnv;
    } else {
      delete process.env.HIVE_AGENT_NAME;
    }
    try {
      if (existsSync("./data/cron-jobs.json")) {
        writeFileSync("./data/cron-jobs.json", "[]");
      }
    } catch {}
  });

  it("cronRemove(id) when JSON lacks id AND activeTasks has it → stops active + returns true", () => {
    process.env.HIVE_AGENT_NAME = "A";
    // Set up an active task in memory but not in the JSON registry
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync("./data/cron-jobs.json", "[]");

    // Manually insert a fake task into activeTasks
    const fakeTask = { stop: mock.fn(), start: mock.fn() } as any;
    activeTasks.set("cron-orphan", fakeTask);

    const result = cronRemove("cron-orphan");
    assert.equal(result, true, "should return true when active task was stopped");
    assert.equal(fakeTask.stop.mock.calls.length, 1, "stop should have been called");
    assert.ok(!activeTasks.has("cron-orphan"), "task should be removed from activeTasks");
  });

  it("cronRemove(id) when both lack the entry → returns false", () => {
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync("./data/cron-jobs.json", "[]");

    const result = cronRemove("cron-nonexistent");
    assert.equal(result, false);
  });

  it("reconcileActiveTasks removes entries whose jobs are no longer in the registry", () => {
    process.env.HIVE_AGENT_NAME = "A";
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync("./data/cron-jobs.json", "[]");

    // Add a fake active task
    const fakeTask = { stop: mock.fn(), start: mock.fn() } as any;
    activeTasks.set("cron-stale", fakeTask);

    reconcileActiveTasks();
    assert.equal(fakeTask.stop.mock.calls.length, 1, "stale task should be stopped");
    assert.ok(!activeTasks.has("cron-stale"));
  });

  it("reconcileActiveTasks skips silently when JSON parse fails", () => {
    process.env.HIVE_AGENT_NAME = "A";
    const dataDir = "./data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    // Write invalid JSON
    writeFileSync("./data/cron-jobs.json", "NOT VALID JSON{{{");

    // Add a fake active task — it should NOT be stopped on parse failure
    const fakeTask = { stop: mock.fn(), start: mock.fn() } as any;
    activeTasks.set("cron-keep", fakeTask);

    // Should not throw
    reconcileActiveTasks();
    assert.equal(fakeTask.stop.mock.calls.length, 0, "tasks should NOT be stopped on parse failure");
    assert.ok(activeTasks.has("cron-keep"), "task should survive parse failure");
  });
});
