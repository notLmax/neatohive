/**
 * Tests for bot-boot.ts — boot beacon writer.
 */

process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeBootBeacon } from "./bot-boot.js";

describe("writeBootBeacon", () => {
  let tmpDir: string;

  it("creates state dir and writes JSONL entry", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "botboot-"));
    // Simulate agents/<name>/state/ not existing yet.
    writeBootBeacon(tmpDir, "house-md", "1.3.6", 1234);

    const beaconPath = join(tmpDir, "agents", "house-md", "state", "boot.jsonl");
    assert.ok(existsSync(beaconPath));

    const content = readFileSync(beaconPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.version, "1.3.6");
    assert.equal(parsed.pid, 1234);
    assert.equal(typeof parsed.ts, "string");
    // Verify ISO 8601 format
    assert.ok(!isNaN(Date.parse(parsed.ts)));

    rmSync(tmpDir, { recursive: true });
  });

  it("appends multiple entries", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "botboot-"));
    writeBootBeacon(tmpDir, "atlas", "1.3.5", 100);
    writeBootBeacon(tmpDir, "atlas", "1.3.6", 200);

    const beaconPath = join(tmpDir, "agents", "atlas", "state", "boot.jsonl");
    const lines = readFileSync(beaconPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.pid, 100);
    assert.equal(second.pid, 200);

    rmSync(tmpDir, { recursive: true });
  });

  it("truncates file when exceeding 1000 lines", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "botboot-"));
    const beaconPath = join(tmpDir, "agents", "test-agent", "state", "boot.jsonl");

    // Pre-populate with 1001 lines.
    mkdirSync(join(tmpDir, "agents", "test-agent", "state"), { recursive: true });

    const bigContent = Array.from({ length: 1001 }, (_, i) =>
      JSON.stringify({ ts: `2026-04-${String(i).padStart(5, "0")}`, version: "1.0.0", pid: i })
    ).join("\n") + "\n";
    writeFileSync(beaconPath, bigContent);

    // Write one more entry — should trigger truncation.
    writeBootBeacon(tmpDir, "test-agent", "1.3.6", 9999);

    const lines = readFileSync(beaconPath, "utf-8").trim().split("\n");
    // Should be truncated to ~100 lines (the last 100 of the 1002).
    assert.ok(lines.length <= 101, `Expected ≤101 lines, got ${lines.length}`);

    // The most recent entry should be the one we just wrote.
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.pid, 9999);

    rmSync(tmpDir, { recursive: true });
  });

  it("produces valid JSON on each line", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "botboot-"));
    writeBootBeacon(tmpDir, "glados", "2.0.0", 42);

    const beaconPath = join(tmpDir, "agents", "glados", "state", "boot.jsonl");
    const lines = readFileSync(beaconPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line); // Should not throw
      assert.ok(parsed.ts);
      assert.ok(parsed.version);
      assert.ok(typeof parsed.pid === "number");
    }

    rmSync(tmpDir, { recursive: true });
  });
});
