/**
 * Tests for the autonomy-v1 wake plumbing:
 *   - buildWakePrompt (pure)
 *   - buildDailyMemoryLine (pure)
 *   - wake-queue I/O (file-backed, uses tmp dirs)
 *   - end-to-end: runner handleSpawnEvent enqueues a wake file the bot
 *     would consume.
 */

process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWakePrompt,
  buildDailyMemoryLine,
} from "./wake-prompt.js";
import {
  enqueueWake,
  listPendingWakes,
  readWakeSignal,
  archiveWake,
  wakeDirFor,
  processedDirFor,
} from "./wake-queue.js";
import {
  buildNewTask,
  ensureTasksDir,
  renderTaskFile,
  taskFilePath,
  type TaskFrontmatter,
} from "./task-file.js";
import { Spawner } from "./spawner.js";
import { handleSpawnEvent, type RunnerState } from "./index.js";

// ── buildWakePrompt ───────────────────────────────────────────

describe("buildWakePrompt", () => {
  function fmFor(overrides: Partial<TaskFrontmatter> = {}): TaskFrontmatter {
    return {
      task_id: "t_2026-04-29_atlas_abcd",
      agent: "atlas",
      kind: "shell",
      cmd: "echo hi",
      status: "done",
      started_at: "2026-04-29T12:00:00Z",
      finished_at: "2026-04-29T12:00:01Z",
      exit_code: 0,
      output_path: "/tmp/hive-tasks/t_xxx.log",
      timeout_minutes: 10,
      on_complete_prompt: null,
      on_failure_prompt: null,
      reply_to: null,
      delegated_by: null,
      ...overrides,
    };
  }

  it("success path emits a checkmark banner and the on_complete_prompt", () => {
    const p = buildWakePrompt(
      {
        task: fmFor({
          status: "done",
          on_complete_prompt: "summarize the build log and post results",
        }),
      },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /✓ Your task .+ completed/);
    assert.match(p, /summarize the build log/);
    assert.match(p, /wake-mode turn/i);
  });

  it("failure path emits an X banner and falls back to default when no on_failure_prompt", () => {
    const p = buildWakePrompt(
      { task: fmFor({ status: "failed", exit_code: 127, on_failure_prompt: null }) },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /✗ Your task .+ failed/);
    assert.match(p, /Decide whether to retry, escalate.+abandon/);
  });

  it("timeout path identifies as timeout with the duration", () => {
    const p = buildWakePrompt(
      { task: fmFor({ status: "timeout", exit_code: null, timeout_minutes: 90 }) },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /⏰ Your task .+ timed out/);
    assert.match(p, /after 90m/);
  });

  it("uses on_failure_prompt when present", () => {
    const p = buildWakePrompt(
      {
        task: fmFor({
          status: "failed",
          on_failure_prompt: "ping the owner — this build is critical",
        }),
      },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /ping the owner/);
    assert.doesNotMatch(p, /No on_failure_prompt was specified/);
  });

  it("reply_to encodes the structured continuation linkage", () => {
    const p = buildWakePrompt(
      {
        task: fmFor({
          on_complete_prompt: "report results",
          reply_to: "glados:t-abc123",
        }),
      },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /SendMessage.+to: "glados".+kind: "response".+task_id: "t-abc123"/s);
  });

  it("includes the last 50 lines of output when the file exists", () => {
    const fakeOutput = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const p = buildWakePrompt(
      {
        task: fmFor({ output_path: "/fake/output.log" }),
      },
      {
        fileExists: () => true,
        readFile: () => fakeOutput,
      },
    );
    assert.match(p, /Last 50 lines of output/);
    assert.match(p, /line 99/);
    assert.doesNotMatch(p, /line 0\b/);
  });

  it("falls back to '(no captured output)' when the log file is missing", () => {
    const p = buildWakePrompt(
      { task: fmFor() },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /no captured output/);
  });

  it("wake-mode disclaimer is present so the agent doesn't auto-post", () => {
    const p = buildWakePrompt(
      { task: fmFor() },
      { fileExists: () => false, readFile: () => "" },
    );
    assert.match(p, /Your text reply will NOT be auto-posted/);
  });
});

// ── buildDailyMemoryLine ──────────────────────────────────────

describe("buildDailyMemoryLine", () => {
  it("renders a one-line wake summary", () => {
    const line = buildDailyMemoryLine({
      task_id: "t_x",
      agent: "atlas",
      kind: "codex",
      cmd: "x",
      status: "done",
      started_at: null,
      finished_at: null,
      exit_code: 0,
      output_path: "/tmp/x",
      timeout_minutes: 90,
      on_complete_prompt: "report results",
      on_failure_prompt: null,
      reply_to: null,
      delegated_by: null,
    });
    assert.equal(
      line,
      "- [wake] task t_x (codex) → done (exit 0); acted on on_complete_prompt\n",
    );
  });

  it("uses on_failure note when failure path was taken", () => {
    const line = buildDailyMemoryLine({
      task_id: "t_x",
      agent: "atlas",
      kind: "shell",
      cmd: "x",
      status: "failed",
      started_at: null,
      finished_at: null,
      exit_code: 1,
      output_path: "/tmp/x",
      timeout_minutes: 10,
      on_complete_prompt: null,
      on_failure_prompt: "retry",
      reply_to: null,
      delegated_by: null,
    });
    assert.match(line, /acted on on_failure_prompt/);
  });
});

// ── wake-queue I/O ────────────────────────────────────────────

describe("wake-queue", () => {
  it("enqueueWake writes an atomically-renamed JSON file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      const path = enqueueWake(tmp, {
        task_id: "t_q",
        agent: "atlas",
        status: "done",
        prompt: "do the thing",
        enqueued_at: "2026-04-29T12:00:00Z",
        task_path: "/path/to/task.md",
      });
      assert.ok(existsSync(path));
      assert.match(path, /agents\/atlas\/wake\/t_q\.json$/);
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(parsed.task_id, "t_q");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("listPendingWakes returns files in the wake dir, sorted", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      enqueueWake(tmp, { task_id: "t_b", agent: "atlas", status: "done", prompt: "x", enqueued_at: "x", task_path: "x" });
      enqueueWake(tmp, { task_id: "t_a", agent: "atlas", status: "done", prompt: "x", enqueued_at: "x", task_path: "x" });
      const pending = listPendingWakes(tmp, "atlas");
      assert.equal(pending.length, 2);
      assert.ok(pending[0].endsWith("t_a.json"));
      assert.ok(pending[1].endsWith("t_b.json"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("listPendingWakes returns [] when wake dir does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      assert.deepEqual(listPendingWakes(tmp, "atlas"), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readWakeSignal rejects malformed signals", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      const path = join(tmp, "bad.json");
      writeFileSync(path, JSON.stringify({ task_id: "t_x" })); // missing fields
      assert.throws(() => readWakeSignal(path), /malformed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("archiveWake moves the file to processed/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      const path = enqueueWake(tmp, { task_id: "t_arch", agent: "atlas", status: "done", prompt: "x", enqueued_at: "x", task_path: "x" });
      const dest = archiveWake(tmp, "atlas", path);
      assert.ok(!existsSync(path), "active file gone");
      assert.ok(existsSync(dest), "archived file present");
      assert.ok(dest.startsWith(processedDirFor(tmp, "atlas")));
      // Subsequent listPending excludes processed/.
      assert.deepEqual(listPendingWakes(tmp, "atlas"), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── End-to-end: terminal state → wake file enqueued ───────────

describe("handleSpawnEvent enqueues a wake on terminal state", () => {
  function makeState(baseDir: string): RunnerState {
    return {
      baseDir,
      agents: ["atlas"],
      spawner: new Spawner(),
      events: { path: "x", log: () => {} } as any,
      pathByTaskId: new Map(),
      picked: new Set(),
    };
  }

  it("exit_zero writes a 'done' wake file with the on_complete_prompt", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({
        agent: "atlas",
        kind: "shell",
        cmd: "echo hi",
        task_id: "t_wake_exit",
        on_complete_prompt: "summarize and report",
      });
      file.frontmatter.status = "running";
      const path = taskFilePath(tmp, "atlas", "t_wake_exit");
      writeFileSync(path, renderTaskFile(file));

      const state = makeState(tmp);
      state.pathByTaskId.set("t_wake_exit", path);

      handleSpawnEvent(state, {
        type: "exit",
        taskId: "t_wake_exit",
        exitCode: 0,
        finishedAt: Date.now(),
      });

      const pending = listPendingWakes(tmp, "atlas");
      assert.equal(pending.length, 1, "exactly one wake file");
      const sig = readWakeSignal(pending[0]);
      assert.equal(sig.task_id, "t_wake_exit");
      assert.equal(sig.status, "done");
      assert.match(sig.prompt, /summarize and report/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("timeout writes a 'timeout' wake file with the failure default", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({
        agent: "atlas",
        kind: "codex",
        cmd: "long thing",
        task_id: "t_wake_timeout",
      });
      file.frontmatter.status = "running";
      const path = taskFilePath(tmp, "atlas", "t_wake_timeout");
      writeFileSync(path, renderTaskFile(file));

      const state = makeState(tmp);
      state.pathByTaskId.set("t_wake_timeout", path);

      handleSpawnEvent(state, {
        type: "timeout",
        taskId: "t_wake_timeout",
        finishedAt: Date.now(),
      });

      const pending = listPendingWakes(tmp, "atlas");
      assert.equal(pending.length, 1);
      const sig = readWakeSignal(pending[0]);
      assert.equal(sig.status, "timeout");
      assert.match(sig.prompt, /timed out/);
      assert.match(sig.prompt, /Decide whether to retry/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("wake dir is created lazily on first signal", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-wake-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({
        agent: "atlas",
        kind: "shell",
        cmd: "x",
        task_id: "t_lazy",
      });
      file.frontmatter.status = "running";
      const path = taskFilePath(tmp, "atlas", "t_lazy");
      writeFileSync(path, renderTaskFile(file));
      const state = makeState(tmp);
      state.pathByTaskId.set("t_lazy", path);
      assert.equal(existsSync(wakeDirFor(tmp, "atlas")), false);
      handleSpawnEvent(state, {
        type: "exit",
        taskId: "t_lazy",
        exitCode: 0,
        finishedAt: Date.now(),
      });
      assert.equal(existsSync(wakeDirFor(tmp, "atlas")), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
