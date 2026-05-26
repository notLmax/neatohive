/**
 * Tests for the hivemind [ATTACH:...] marker handling in bot.ts.
 *
 * Covers the fix for the Request-path omission in the hivemind handler
 * (`filePaths` was destructured but never attached to the outgoing message).
 *
 * Run: `pnpm test` (or `tsx --test src/discord/bot.test.ts`).
 */

// Pin timezone BEFORE any Date() use so the local-date assertions in the
// logHivemindAttachWarning tests don't flake across CI timezones.
process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAttachments,
  resolveAttachments,
  logHivemindAttachWarning,
} from "./attachments.js";

// ── extractAttachments ─────────────────────────────────────────

describe("extractAttachments", () => {
  it("returns cleanText unchanged and empty filePaths when no marker present", () => {
    const r = extractAttachments("hello world");
    assert.equal(r.cleanText, "hello world");
    assert.deepEqual(r.filePaths, []);
  });

  it("extracts a single absolute-path marker and strips it", () => {
    const r = extractAttachments("see attached [ATTACH:/tmp/foo.md]");
    assert.deepEqual(r.filePaths, ["/tmp/foo.md"]);
    assert.equal(r.cleanText, "see attached");
  });

  it("extracts multiple markers in a single message", () => {
    const input =
      "first [ATTACH:/tmp/a.md] then [ATTACH:/tmp/b.md] and [ATTACH:/tmp/c.md]";
    const r = extractAttachments(input);
    assert.deepEqual(r.filePaths, ["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"]);
    assert.match(r.cleanText, /^first\s+then\s+and$/);
  });

  it("extracts markers that appear inside code fences (no escape syntax)", () => {
    // We control both sides of the hivemind channel; agents aren't expected
    // to quote ATTACH markers literally. If they do, we still process.
    const input = "look at this:\n```\n[ATTACH:/tmp/x.md]\n```";
    const r = extractAttachments(input);
    assert.deepEqual(r.filePaths, ["/tmp/x.md"]);
    // cleanText keeps the fence; exact whitespace isn't contractual, just
    // assert the marker is gone.
    assert.ok(!r.cleanText.includes("[ATTACH:"));
  });

  it("collapses excessive blank lines created by marker stripping", () => {
    const input = "top\n\n\n[ATTACH:/tmp/a.md]\n\n\nbottom";
    const r = extractAttachments(input);
    assert.equal(r.cleanText, "top\n\nbottom");
    assert.deepEqual(r.filePaths, ["/tmp/a.md"]);
  });

  it("preserves relative-path markers for the resolver to reject downstream", () => {
    // The policy decision 'reject relative' lives in resolveAttachments, not
    // the extractor — this contract is important for warning messages to
    // include the original path the agent wrote.
    const r = extractAttachments("[ATTACH:./foo.md]");
    assert.deepEqual(r.filePaths, ["./foo.md"]);
  });
});

// ── resolveAttachments ─────────────────────────────────────────

describe("resolveAttachments", () => {
  // Stub builder so tests don't depend on discord.js runtime behaviour.
  const stubBuilder = (fp: string, name: string) =>
    ({ __stub: true, path: fp, name }) as any;
  const always = (_p: string) => true;
  const never = (_p: string) => false;

  it("rejects relative paths with a warning and no builder", () => {
    const r = resolveAttachments(["./relative.md"], {
      fsCheck: always,
      buildAttachment: stubBuilder,
    });
    assert.equal(r.builders.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /non-absolute/);
    assert.match(r.warnings[0], /\.\/relative\.md/);
  });

  it("warns and skips when an absolute file is missing", () => {
    const r = resolveAttachments(["/tmp/does-not-exist.md"], {
      fsCheck: never,
      buildAttachment: stubBuilder,
    });
    assert.equal(r.builders.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /not found/);
  });

  it("builds an attachment when absolute path exists", () => {
    const r = resolveAttachments(["/tmp/real.md"], {
      fsCheck: always,
      buildAttachment: stubBuilder,
    });
    assert.equal(r.builders.length, 1);
    assert.equal(r.warnings.length, 0);
    assert.equal((r.builders[0] as any).path, "/tmp/real.md");
    assert.equal((r.builders[0] as any).name, "real.md");
  });

  it("handles a mix of good, missing, and relative paths independently", () => {
    const existing = new Set(["/tmp/good.md"]);
    const r = resolveAttachments(
      ["/tmp/good.md", "/tmp/missing.md", "./relative.md"],
      {
        fsCheck: (p) => existing.has(p),
        buildAttachment: stubBuilder,
      },
    );
    assert.equal(r.builders.length, 1);
    assert.equal((r.builders[0] as any).name, "good.md");
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0], /not found.*missing\.md/);
    assert.match(r.warnings[1], /non-absolute.*relative\.md/);
  });

  it("captures builder-construction failures as warnings, not throws", () => {
    const r = resolveAttachments(["/tmp/boom.md"], {
      fsCheck: always,
      buildAttachment: () => {
        throw new Error("stub failure");
      },
    });
    assert.equal(r.builders.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /failed to attach.*stub failure/);
  });

  it("skips empty path entries without warning noise", () => {
    const r = resolveAttachments(["", "/tmp/real.md"], {
      fsCheck: always,
      buildAttachment: stubBuilder,
    });
    assert.equal(r.builders.length, 1);
    assert.equal(r.warnings.length, 0);
  });
});

// ── logHivemindAttachWarning ───────────────────────────────────

describe("logHivemindAttachWarning", () => {
  function withTmpDir<T>(fn: (base: string) => T): T {
    const base = mkdtempSync(join(tmpdir(), "hive-attach-log-"));
    try {
      return fn(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  const fixedNow = new Date("2026-04-22T12:00:00Z");

  it("creates the memory dir and file with a date header on first write", () => {
    withTmpDir((base) => {
      logHivemindAttachWarning("atlas", "ATTACH file not found: /tmp/x.md", {
        baseDir: base,
        now: fixedNow,
      });
      const file = join(base, "agents", "atlas", "memory", "2026-04-22.md");
      assert.ok(existsSync(file), "memory file should exist");
      const content = readFileSync(file, "utf8");
      assert.match(content, /^# 2026-04-22 — atlas/);
      assert.match(content, /hivemind attach warning.*not found.*\/tmp\/x\.md/);
    });
  });

  it("appends without duplicating the header when the file already exists", () => {
    withTmpDir((base) => {
      const memoryDir = join(base, "agents", "glados", "memory");
      const file = join(memoryDir, "2026-04-22.md");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(file, "# 2026-04-22 — glados\n\n- pre-existing entry\n");

      logHivemindAttachWarning("glados", "rejected non-absolute ATTACH path: ./foo", {
        baseDir: base,
        now: fixedNow,
      });

      const content = readFileSync(file, "utf8");
      // Header still present exactly once.
      const headerCount = (content.match(/# 2026-04-22 — glados/g) || []).length;
      assert.equal(headerCount, 1, "header should not duplicate on append");
      assert.match(content, /pre-existing entry/);
      assert.match(content, /hivemind attach warning.*non-absolute.*\.\/foo/);
    });
  });

  it("is fail-soft: does not throw when the base dir is unwritable", () => {
    // /dev/null/foo will fail both mkdir and appendFile; the function must
    // swallow the error so a logging failure never breaks the reply path.
    assert.doesNotThrow(() =>
      logHivemindAttachWarning("atlas", "x", { baseDir: "/dev/null" }),
    );
  });
});
