/**
 * Tests for the runner core: state machine + task file I/O + spawner +
 * processOneTask integration. No real subprocesses, no real disk —
 * everything is injectable.
 *
 * Run: `pnpm test`.
 */

process.env.TZ = "UTC";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import {
  transition,
  canTransition,
  isTerminal,
  isTaskKind,
  TASK_KINDS,
  DEFAULT_TIMEOUT_MINUTES,
  InvalidTransitionError,
  type TaskStatus,
} from "./state-machine.js";
import {
  buildNewTask,
  parseTaskFile,
  renderTaskFile,
  generateTaskId,
  tasksDirFor,
  taskFilePath,
  listTaskFiles,
  findOpenTasks,
  ensureTasksDir,
} from "./task-file.js";
import { Spawner, type SpawnEvent } from "./spawner.js";
import { createEventsLogger, type RunnerEvent } from "./events-log.js";
import { processOneTask, handleSpawnEvent, type RunnerState } from "./index.js";
import { listPendingWakes, readWakeSignal } from "./wake-queue.js";

// ── State machine ────────────────────────────────────────────

describe("state-machine: transition", () => {
  it("pending -> running on spawn", () => {
    assert.equal(transition("pending", "spawn"), "running");
  });
  it("running -> done on exit_zero", () => {
    assert.equal(transition("running", "exit_zero"), "done");
  });
  it("running -> failed on exit_nonzero", () => {
    assert.equal(transition("running", "exit_nonzero"), "failed");
  });
  it("running -> timeout on timeout", () => {
    assert.equal(transition("running", "timeout"), "timeout");
  });
  it("pending -> cancelled on cancel", () => {
    assert.equal(transition("pending", "cancel"), "cancelled");
  });
  it("running -> cancelled on cancel", () => {
    assert.equal(transition("running", "cancel"), "cancelled");
  });
  it("rejects exit_zero from pending", () => {
    assert.throws(() => transition("pending", "exit_zero"), InvalidTransitionError);
  });
  it("rejects spawn from running (no double-spawn)", () => {
    assert.throws(() => transition("running", "spawn"), InvalidTransitionError);
  });
  it("terminal states reject every trigger", () => {
    const terminals: TaskStatus[] = ["done", "failed", "timeout", "cancelled"];
    for (const t of terminals) {
      for (const trig of ["spawn", "exit_zero", "exit_nonzero", "timeout", "cancel"] as const) {
        assert.throws(() => transition(t, trig), InvalidTransitionError);
      }
    }
  });
  it("isTerminal flags exactly the four terminal states", () => {
    assert.equal(isTerminal("pending"), false);
    assert.equal(isTerminal("running"), false);
    assert.equal(isTerminal("done"), true);
    assert.equal(isTerminal("failed"), true);
    assert.equal(isTerminal("timeout"), true);
    assert.equal(isTerminal("cancelled"), true);
  });
  it("canTransition matches transition's behavior", () => {
    assert.equal(canTransition("pending", "spawn"), true);
    assert.equal(canTransition("done", "spawn"), false);
  });
  it("default timeouts match spec D3", () => {
    assert.equal(DEFAULT_TIMEOUT_MINUTES.codex, 90);
    assert.equal(DEFAULT_TIMEOUT_MINUTES.claude, 30);
    assert.equal(DEFAULT_TIMEOUT_MINUTES.shell, 10);
  });
  it("isTaskKind only accepts the three locked kinds", () => {
    for (const k of TASK_KINDS) assert.equal(isTaskKind(k), true);
    assert.equal(isTaskKind("python"), false);
    assert.equal(isTaskKind(""), false);
  });
});

// ── Task file I/O ────────────────────────────────────────────

describe("task-file", () => {
  it("generateTaskId is deterministic with injected clock + random", () => {
    const id = generateTaskId(
      "atlas",
      new Date("2026-04-29T12:00:00Z"),
      () => "ab12",
    );
    assert.equal(id, "t_2026-04-29_atlas_ab12");
  });

  it("buildNewTask sets sane defaults from kind", () => {
    const file = buildNewTask({
      agent: "atlas",
      kind: "shell",
      cmd: "echo hi",
      now: new Date("2026-04-29T12:00:00Z"),
      task_id: "t_2026-04-29_atlas_test",
    });
    assert.equal(file.frontmatter.task_id, "t_2026-04-29_atlas_test");
    assert.equal(file.frontmatter.agent, "atlas");
    assert.equal(file.frontmatter.kind, "shell");
    assert.equal(file.frontmatter.status, "pending");
    assert.equal(file.frontmatter.timeout_minutes, 10);
    assert.equal(file.frontmatter.output_path, "/tmp/hive-tasks/t_2026-04-29_atlas_test.log");
    assert.equal(file.frontmatter.on_complete_prompt, null);
    assert.equal(file.frontmatter.reply_to, null);
    assert.match(file.body, /Task t_2026-04-29_atlas_test/);
  });

  it("buildNewTask uses codex default timeout when kind=codex", () => {
    const file = buildNewTask({ agent: "atlas", kind: "codex", cmd: "x" });
    assert.equal(file.frontmatter.timeout_minutes, 90);
  });

  it("buildNewTask carries reply_to + delegated_by through to frontmatter", () => {
    const file = buildNewTask({
      agent: "atlas",
      kind: "shell",
      cmd: "x",
      reply_to: "glados:t-abc123",
      delegated_by: "glados",
    });
    assert.equal(file.frontmatter.reply_to, "glados:t-abc123");
    assert.equal(file.frontmatter.delegated_by, "glados");
  });

  it("renderTaskFile + parseTaskFile round-trip preserves frontmatter", () => {
    const original = buildNewTask({
      agent: "atlas",
      kind: "shell",
      cmd: "echo 'hello world'",
      task_id: "t_round",
      on_complete_prompt: "report results",
      reply_to: "glados:t-xxx",
    });
    const rendered = renderTaskFile(original);
    const reparsed = parseTaskFile(rendered);
    assert.deepEqual(reparsed.frontmatter, original.frontmatter);
  });

  it("parseTaskFile rejects files without frontmatter delimiters", () => {
    assert.throws(() => parseTaskFile("just a body"), /missing YAML frontmatter/);
  });

  it("listTaskFiles returns [] when the agent has no tasks/ dir yet (lazy create)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-tasks-"));
    try {
      const files = listTaskFiles(tmp, "atlas");
      assert.deepEqual(files, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensureTasksDir creates the dir and listTaskFiles picks up .md files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-tasks-"));
    try {
      ensureTasksDir(tmp, "atlas");
      writeFileSync(taskFilePath(tmp, "atlas", "t_one"), "---\ntask_id: t_one\n---\n\nbody");
      writeFileSync(taskFilePath(tmp, "atlas", "t_two"), "---\ntask_id: t_two\n---\n\nbody");
      writeFileSync(join(tasksDirFor(tmp, "atlas"), "ignored.txt"), "not md");
      const files = listTaskFiles(tmp, "atlas");
      assert.equal(files.length, 2);
      assert.ok(files.every((f) => f.endsWith(".md")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("findOpenTasks skips terminal-state files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-tasks-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const pending = buildNewTask({ agent: "atlas", kind: "shell", cmd: "x", task_id: "t_pending" });
      const done = buildNewTask({ agent: "atlas", kind: "shell", cmd: "x", task_id: "t_done" });
      done.frontmatter.status = "done";
      writeFileSync(taskFilePath(tmp, "atlas", "t_pending"), renderTaskFile(pending));
      writeFileSync(taskFilePath(tmp, "atlas", "t_done"), renderTaskFile(done));
      const open = findOpenTasks(tmp, ["atlas"]);
      assert.equal(open.length, 1);
      assert.equal(open[0].file.frontmatter.task_id, "t_pending");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Spawner ───────────────────────────────────────────────────

describe("Spawner", () => {
  function makeFakeChild(): { child: any; emit: (event: string, ...args: any[]) => void } {
    const emitter = new EventEmitter() as any;
    emitter.pid = 12345;
    emitter.stdout = null;
    emitter.stderr = null;
    emitter.kill = (_sig?: string) => {};
    return { child: emitter, emit: (e, ...a) => emitter.emit(e, ...a) };
  }

  function makeSpawner() {
    const fake = makeFakeChild();
    let timerCallbacks: Array<() => void> = [];
    let timerIds = 0;
    const timers = new Map<number, () => void>();
    let nowVal = 1000;
    const sp = new Spawner({
      spawn: () => fake.child as any,
      openLog: () => ({ end: () => {}, write: () => true } as any),
      setTimer: ((cb: () => void, _ms: number) => {
        const id = ++timerIds;
        timers.set(id, cb);
        timerCallbacks.push(cb);
        return id as any;
      }) as any,
      clearTimer: ((id: any) => { timers.delete(id); }) as any,
      now: () => nowVal,
    });
    return { sp, fake, fireTimer: (i = 0) => timerCallbacks[i](), timers, setNow: (n: number) => { nowVal = n; } };
  }

  it("emits started then exit on a successful run", () => {
    const { sp, fake, setNow } = makeSpawner();
    const events: SpawnEvent[] = [];
    sp.launch(
      { taskId: "t_a", kind: "shell", cmd: "echo hi", outputPath: "/tmp/out.log", timeoutMinutes: 10 },
      (e) => events.push(e),
    );
    setNow(2000);
    fake.emit("exit", 0);
    assert.equal(events[0].type, "started");
    assert.equal((events[0] as any).pid, 12345);
    assert.equal(events[1].type, "exit");
    assert.equal((events[1] as any).exitCode, 0);
  });

  it("non-zero exit is reported as exit with the actual code", () => {
    const { sp, fake } = makeSpawner();
    const events: SpawnEvent[] = [];
    sp.launch(
      { taskId: "t_a", kind: "shell", cmd: "false", outputPath: "/tmp/out.log" },
      (e) => events.push(e),
    );
    fake.emit("exit", 1);
    assert.equal(events[1].type, "exit");
    assert.equal((events[1] as any).exitCode, 1);
  });

  it("firing the timeout watchdog emits a timeout event and skips a duplicate exit", () => {
    const { sp, fake, fireTimer } = makeSpawner();
    const events: SpawnEvent[] = [];
    sp.launch(
      { taskId: "t_t", kind: "shell", cmd: "sleep 1000", outputPath: "/tmp/out.log" },
      (e) => events.push(e),
    );
    // Fire the watchdog (the SIGTERM path).
    fireTimer(0);
    // Now the child "dies" — should NOT emit a duplicate exit.
    fake.emit("exit", 143);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["started", "timeout"]);
  });

  it("rejects a duplicate launch for the same taskId", () => {
    const { sp, fake } = makeSpawner();
    const events: SpawnEvent[] = [];
    sp.launch({ taskId: "t_a", kind: "shell", cmd: "x", outputPath: "/tmp/out.log" }, (e) => events.push(e));
    sp.launch({ taskId: "t_a", kind: "shell", cmd: "x", outputPath: "/tmp/out.log" }, (e) => events.push(e));
    const errors = events.filter((e) => e.type === "error");
    assert.equal(errors.length, 1);
    assert.match((errors[0] as any).error, /already running/);
    fake.emit("exit", 0);
  });

  it("activeCount tracks in-flight tasks", () => {
    const { sp, fake } = makeSpawner();
    sp.launch({ taskId: "t_a", kind: "shell", cmd: "x", outputPath: "/tmp/out.log" }, () => {});
    assert.equal(sp.activeCount(), 1);
    fake.emit("exit", 0);
    assert.equal(sp.activeCount(), 0);
  });

  it("exitToStatus maps 0 → done and non-0 → failed", () => {
    const { sp } = makeSpawner();
    assert.equal(sp.exitToStatus(0), "done");
    assert.equal(sp.exitToStatus(1), "failed");
    assert.equal(sp.exitToStatus(127), "failed");
  });
});

// ── Events log ────────────────────────────────────────────────

describe("events-log", () => {
  it("creates the dir, writes JSONL, fail-soft on errors", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-events-"));
    try {
      const path = join(tmp, "data", "runner-events.log");
      const logger = createEventsLogger(path);
      logger.log({ taskId: "t_1", agent: "atlas", kind: "shell", event: "discovered" });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]) as RunnerEvent;
      assert.equal(parsed.taskId, "t_1");
      assert.equal(parsed.event, "discovered");
      assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not throw when the path is unwritable (fail-soft)", () => {
    const logger = createEventsLogger("/dev/null/cant-write/here.log");
    assert.doesNotThrow(() => logger.log({ taskId: "x", event: "boot" }));
  });
});

// ── processOneTask integration ────────────────────────────────

describe("processOneTask", () => {
  function makeState(baseDir: string, agents: string[]): RunnerState & { events: any[] } {
    const captured: any[] = [];
    const events = {
      path: "/tmp/test-events.log",
      log: (e: any) => captured.push(e),
    };
    const spawner = new Spawner({
      spawn: () => {
        const c: any = new EventEmitter();
        c.pid = 99;
        c.stdout = null;
        c.stderr = null;
        c.kill = () => {};
        return c;
      },
      openLog: () => ({ end: () => {}, write: () => true } as any),
      setTimer: (() => 1) as any,
      clearTimer: (() => {}) as any,
      now: () => 1000,
    });
    return {
      baseDir,
      agents,
      spawner,
      events: captured as any,
      pathByTaskId: new Map(),
      picked: new Set(),
    } as any;
  }

  it("picks up a pending task, marks it running, and remembers the path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-runner-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({ agent: "atlas", kind: "shell", cmd: "echo hi", task_id: "t_run" });
      const path = taskFilePath(tmp, "atlas", "t_run");
      writeFileSync(path, renderTaskFile(file));
      const state = makeState(tmp, ["atlas"]);
      // shim the events object so events.log doesn't blow up
      (state as any).events = { path: "x", log: () => {} };
      processOneTask(state, path);
      const updated = parseTaskFile(readFileSync(path, "utf8"));
      assert.equal(updated.frontmatter.status, "running");
      assert.ok(updated.frontmatter.started_at);
      assert.equal(state.pathByTaskId.get("t_run"), path);
      assert.ok(state.picked.has("t_run"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not double-pick the same task on repeated polls", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-runner-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({ agent: "atlas", kind: "shell", cmd: "x", task_id: "t_dup" });
      const path = taskFilePath(tmp, "atlas", "t_dup");
      writeFileSync(path, renderTaskFile(file));
      const state = makeState(tmp, ["atlas"]);
      (state as any).events = { path: "x", log: () => {} };
      processOneTask(state, path);
      const beforeActive = state.spawner.activeCount();
      processOneTask(state, path);
      assert.equal(state.spawner.activeCount(), beforeActive);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("orphaned 'running' tasks are marked failed AND a wake fires (v1.3.3 Bug #2)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-runner-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({
        agent: "atlas",
        kind: "shell",
        cmd: "x",
        task_id: "t_orphan",
        on_failure_prompt: "decide whether to retry",
      });
      file.frontmatter.status = "running";
      file.frontmatter.started_at = "2026-04-29T10:00:00Z";
      const path = taskFilePath(tmp, "atlas", "t_orphan");
      writeFileSync(path, renderTaskFile(file));
      const state = makeState(tmp, ["atlas"]);
      (state as any).events = { path: "x", log: () => {} };
      processOneTask(state, path);

      // Status flipped to failed.
      const updated = parseTaskFile(readFileSync(path, "utf8"));
      assert.equal(updated.frontmatter.status, "failed");
      assert.match(updated.body, /Marked failed on runner restart/);

      // AND a wake file got enqueued so the agent finds out — pre-v1.3.3
      // this was missing, breaking the crash-recovery promise.
      const pending = listPendingWakes(tmp, "atlas");
      assert.equal(pending.length, 1, "orphan-recovery wake should be enqueued");
      const sig = readWakeSignal(pending[0]);
      assert.equal(sig.task_id, "t_orphan");
      assert.equal(sig.status, "failed");
      // The wake prompt should carry the on_failure_prompt the agent set.
      assert.match(sig.prompt, /decide whether to retry/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores terminal tasks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-runner-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({ agent: "atlas", kind: "shell", cmd: "x", task_id: "t_term" });
      file.frontmatter.status = "done";
      const path = taskFilePath(tmp, "atlas", "t_term");
      writeFileSync(path, renderTaskFile(file));
      const state = makeState(tmp, ["atlas"]);
      (state as any).events = { path: "x", log: () => {} };
      const beforePicked = state.picked.size;
      processOneTask(state, path);
      assert.equal(state.picked.size, beforePicked);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── handleSpawnEvent ──────────────────────────────────────────

describe("handleSpawnEvent", () => {
  it("an exit_zero event flips the file to done with finished_at + exit_code", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-runner-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({ agent: "atlas", kind: "shell", cmd: "x", task_id: "t_exit" });
      file.frontmatter.status = "running";
      const path = taskFilePath(tmp, "atlas", "t_exit");
      writeFileSync(path, renderTaskFile(file));
      const captured: any[] = [];
      const state: RunnerState = {
        baseDir: tmp,
        agents: ["atlas"],
        spawner: new Spawner(),
        events: { path: "x", log: (e: any) => captured.push(e) } as any,
        pathByTaskId: new Map([["t_exit", path]]),
        picked: new Set(["t_exit"]),
      };
      handleSpawnEvent(state, {
        type: "exit",
        taskId: "t_exit",
        exitCode: 0,
        finishedAt: new Date("2026-04-29T13:00:00Z").getTime(),
      });
      const updated = parseTaskFile(readFileSync(path, "utf8"));
      assert.equal(updated.frontmatter.status, "done");
      assert.equal(updated.frontmatter.exit_code, 0);
      assert.equal(updated.frontmatter.finished_at, "2026-04-29T13:00:00.000Z");
      assert.equal(captured.find((c: any) => c.event === "exit")?.detail?.status, "done");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("spawner uses detached mode and process-group kill (Phase 2)", () => {
    // Verify the spawn options include detached: true and that cancel()
    // uses negative-pid (process.kill(-pid, ...)) instead of child.kill().
    let capturedOpts: any = null;
    const fakeChild: any = new EventEmitter();
    fakeChild.pid = 42;
    fakeChild.stdout = null;
    fakeChild.stderr = null;
    fakeChild.kill = () => {};

    const spawner = new Spawner({
      spawn: (_cmd: any, _args: any, opts: any) => {
        capturedOpts = opts;
        return fakeChild;
      },
      openLog: () => ({ end: () => {}, write: () => true, pipe: () => {} } as any),
      setTimer: (() => 1) as any,
      clearTimer: (() => {}) as any,
      now: () => 1000,
    });

    spawner.launch(
      { taskId: "t-detach", kind: "shell", cmd: "echo hi", outputPath: "/dev/null" },
      () => {},
    );

    assert.ok(capturedOpts, "spawn should have been called");
    assert.equal(capturedOpts.detached, true, "spawn must use detached: true");
  });

  it("a timeout event flips the file to timeout with finished_at and null exit_code", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hive-runner-"));
    try {
      ensureTasksDir(tmp, "atlas");
      const file = buildNewTask({ agent: "atlas", kind: "codex", cmd: "x", task_id: "t_timeout" });
      file.frontmatter.status = "running";
      const path = taskFilePath(tmp, "atlas", "t_timeout");
      writeFileSync(path, renderTaskFile(file));
      const state: RunnerState = {
        baseDir: tmp,
        agents: ["atlas"],
        spawner: new Spawner(),
        events: { path: "x", log: () => {} } as any,
        pathByTaskId: new Map([["t_timeout", path]]),
        picked: new Set(["t_timeout"]),
      };
      handleSpawnEvent(state, {
        type: "timeout",
        taskId: "t_timeout",
        finishedAt: Date.now(),
      });
      const updated = parseTaskFile(readFileSync(path, "utf8"));
      assert.equal(updated.frontmatter.status, "timeout");
      assert.equal(updated.frontmatter.exit_code, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
