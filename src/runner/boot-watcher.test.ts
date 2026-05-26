/**
 * Tests for boot-watcher.ts — pure beacon reading and filtering.
 */

process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readBootBeacon,
  findNewEntries,
  bootBeaconPath,
  type BootEntry,
} from "./boot-watcher.js";
import { buildBootWakePrompt } from "./wake-prompt-boot.js";
import { listPendingWakes, readWakeSignal, ensureWakeDirs } from "./wake-queue.js";

describe("bootBeaconPath", () => {
  it("returns canonical path", () => {
    const p = bootBeaconPath("/hive", "atlas");
    assert.equal(p, join("/hive", "agents", "atlas", "state", "boot.jsonl"));
  });
});

describe("readBootBeacon", () => {
  let tmpDir: string;

  it("returns empty for missing file", () => {
    const result = readBootBeacon("/nonexistent/boot.jsonl");
    assert.deepEqual(result, []);
  });

  it("parses valid JSONL entries", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-"));
    const beaconFile = join(tmpDir, "boot.jsonl");
    const lines = [
      JSON.stringify({ ts: "2026-04-29T10:00:00Z", version: "1.3.5", pid: 1234 }),
      JSON.stringify({ ts: "2026-04-29T11:00:00Z", version: "1.3.6", pid: 5678 }),
    ];
    writeFileSync(beaconFile, lines.join("\n") + "\n");

    const entries = readBootBeacon(beaconFile);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].ts, "2026-04-29T10:00:00Z");
    assert.equal(entries[0].version, "1.3.5");
    assert.equal(entries[0].pid, 1234);
    assert.equal(entries[1].ts, "2026-04-29T11:00:00Z");
    assert.equal(entries[1].version, "1.3.6");
    assert.equal(entries[1].pid, 5678);

    rmSync(tmpDir, { recursive: true });
  });

  it("skips malformed lines silently", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-"));
    const beaconFile = join(tmpDir, "boot.jsonl");
    const lines = [
      "not json at all",
      JSON.stringify({ ts: "2026-04-29T10:00:00Z", version: "1.3.5", pid: 1234 }),
      JSON.stringify({ ts: 123, version: "bad", pid: "nope" }), // wrong types
      "",
      JSON.stringify({ ts: "2026-04-29T12:00:00Z", version: "1.3.6", pid: 9999 }),
    ];
    writeFileSync(beaconFile, lines.join("\n") + "\n");

    const entries = readBootBeacon(beaconFile);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].pid, 1234);
    assert.equal(entries[1].pid, 9999);

    rmSync(tmpDir, { recursive: true });
  });

  it("handles empty file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-"));
    const beaconFile = join(tmpDir, "boot.jsonl");
    writeFileSync(beaconFile, "");

    const entries = readBootBeacon(beaconFile);
    assert.deepEqual(entries, []);

    rmSync(tmpDir, { recursive: true });
  });
});

describe("findNewEntries", () => {
  const entries: BootEntry[] = [
    { ts: "2026-04-29T08:00:00Z", version: "1.3.5", pid: 100 },
    { ts: "2026-04-29T10:00:00Z", version: "1.3.5", pid: 200 },
    { ts: "2026-04-29T12:00:00Z", version: "1.3.6", pid: 300 },
  ];

  it("returns entries newer than lastSeenTs", () => {
    const result = findNewEntries(entries, "2026-04-29T09:00:00Z");
    assert.equal(result.length, 2);
    assert.equal(result[0].pid, 200);
    assert.equal(result[1].pid, 300);
  });

  it("returns empty when all entries are older", () => {
    const result = findNewEntries(entries, "2026-04-29T13:00:00Z");
    assert.deepEqual(result, []);
  });

  it("returns all entries when lastSeenTs is before all", () => {
    const result = findNewEntries(entries, "2026-04-29T07:00:00Z");
    assert.equal(result.length, 3);
  });

  it("excludes entries with exact lastSeenTs match", () => {
    const result = findNewEntries(entries, "2026-04-29T10:00:00Z");
    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 300);
  });
});

// ── Integration: beacon → wake file ────────────────────────────

describe("integration: boot beacon → wake enqueue", () => {
  it("runner sees new beacon → enqueues a wake with correct shape", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "boot-int-"));

    // Set up a beacon file with one entry.
    const stateDir = join(tmpDir, "agents", "house-md", "state");
    mkdirSync(stateDir, { recursive: true });
    const beaconFile = join(stateDir, "boot.jsonl");
    const entry = { ts: "2026-04-29T22:14:33Z", version: "1.3.6", pid: 42 };
    writeFileSync(beaconFile, JSON.stringify(entry) + "\n");

    // Read beacon and find new entries (simulate runner poll).
    const entries = readBootBeacon(beaconFile);
    const lastSeen = "2026-04-29T22:00:00Z"; // before the entry
    const newEntries = findNewEntries(entries, lastSeen);
    assert.equal(newEntries.length, 1);

    // Build wake prompt.
    const prompt = buildBootWakePrompt({
      agent: "house-md",
      version: "1.3.6",
      bootEntry: newEntries[0],
      recentTasks: [],
      dailyMemoryTail: "",
    });
    assert.ok(prompt.includes("v1.3.6"));
    assert.ok(prompt.includes("sendToOwnChannel"));

    // Write the wake signal manually (simulating what runner does).
    ensureWakeDirs(tmpDir, "house-md");
    const signal = {
      task_id: `boot-${entry.ts}`,
      agent: "house-md",
      status: "boot-announce",
      prompt,
      enqueued_at: new Date().toISOString(),
      task_path: beaconFile,
    };
    const wakeFile = join(tmpDir, "agents", "house-md", "wake", `boot-announce-${entry.ts.replace(/[:.]/g, "-")}.json`);
    writeFileSync(wakeFile, JSON.stringify(signal, null, 2));

    // Verify the wake file is picked up by listPendingWakes.
    const pending = listPendingWakes(tmpDir, "house-md");
    assert.equal(pending.length, 1);
    assert.ok(pending[0].includes("boot-announce"));

    // Read it back and verify shape.
    const read = readWakeSignal(pending[0]);
    assert.equal(read.agent, "house-md");
    assert.equal(read.status, "boot-announce");
    assert.ok(read.prompt.includes("sendToOwnChannel"));

    rmSync(tmpDir, { recursive: true });
  });
});
