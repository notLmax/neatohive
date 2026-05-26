/**
 * spawner.ts
 * Child-process management for the runner. Spawns codex/claude/shell
 * tasks via `child_process.spawn`, captures stdout+stderr to a log file,
 * enforces per-kind timeouts, and reports terminal events.
 *
 * No tmux. Uniform across kinds. (Per PR 2a Finding (d).)
 *
 * The spawn function and clock are injectable for tests so the suite
 * can exercise the timeout + terminal paths without real subprocess work.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import {
  type TaskKind,
  type TaskStatus,
  DEFAULT_TIMEOUT_MINUTES,
} from "./state-machine.js";

// ── Public types ──────────────────────────────────────────────

export interface SpawnRequest {
  taskId: string;
  kind: TaskKind;
  cmd: string;
  outputPath: string;
  timeoutMinutes?: number;
}

export type SpawnEvent =
  | { type: "started"; taskId: string; pid: number; startedAt: number }
  | { type: "exit"; taskId: string; exitCode: number; finishedAt: number }
  | { type: "timeout"; taskId: string; finishedAt: number }
  | { type: "error"; taskId: string; error: string };

export type SpawnHandler = (event: SpawnEvent) => void;

// ── Injection seams (for tests) ───────────────────────────────

export interface SpawnerDeps {
  spawn?: typeof nodeSpawn;
  /** Open the output log stream. Replaced in tests with a no-op. */
  openLog?: (path: string) => WriteStream;
  /** Setter for timeout — defaults to setTimeout. */
  setTimer?: typeof setTimeout;
  /** Clearer — defaults to clearTimeout. */
  clearTimer?: typeof clearTimeout;
  /** Clock for finishedAt / startedAt. Defaults to Date.now. */
  now?: () => number;
}

// ── Spawner ───────────────────────────────────────────────────

interface ActiveProc {
  taskId: string;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout> | null;
  killed: boolean;
}

/**
 * Owns a single bag of in-flight child processes. The runner uses one
 * Spawner instance for the lifetime of the daemon.
 */
export class Spawner {
  private spawn: typeof nodeSpawn;
  private openLog: (path: string) => WriteStream;
  private setTimer: typeof setTimeout;
  private clearTimer: typeof clearTimeout;
  private now: () => number;
  private active = new Map<string, ActiveProc>();

  constructor(deps: SpawnerDeps = {}) {
    this.spawn = deps.spawn ?? nodeSpawn;
    this.openLog =
      deps.openLog ??
      ((path: string) => {
        mkdirSync(dirname(path), { recursive: true });
        return createWriteStream(path, { flags: "a" });
      });
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Launch a child for the given request. Routes lifecycle events through
   * `handler`. Returns immediately; the caller does not await the child.
   *
   * Shell semantics: cmd is passed through `bash -lc "<cmd>"` regardless of
   * kind. codex/claude entries are just shell commands wrapping the CLI
   * invocation — keeps the spawner uniform.
   */
  launch(req: SpawnRequest, handler: SpawnHandler): void {
    if (this.active.has(req.taskId)) {
      handler({
        type: "error",
        taskId: req.taskId,
        error: `taskId ${req.taskId} already running`,
      });
      return;
    }

    const minutes = req.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES[req.kind];
    const timeoutMs = minutes * 60 * 1000;

    let log: WriteStream;
    try {
      log = this.openLog(req.outputPath);
    } catch (err) {
      handler({
        type: "error",
        taskId: req.taskId,
        error: `failed to open output log ${req.outputPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawn("bash", ["-lc", req.cmd], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: true,  // bash becomes process-group leader
      });
    } catch (err) {
      try { log.end(); } catch {}
      handler({
        type: "error",
        taskId: req.taskId,
        error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (child.stdout) child.stdout.pipe(log, { end: false });
    if (child.stderr) child.stderr.pipe(log, { end: false });

    const startedAt = this.now();
    handler({
      type: "started",
      taskId: req.taskId,
      pid: child.pid ?? -1,
      startedAt,
    });

    const proc: ActiveProc = { taskId: req.taskId, child, timer: null, killed: false };
    this.active.set(req.taskId, proc);

    // Timeout watchdog: SIGTERM the entire process group, then SIGKILL after a 10-second grace.
    proc.timer = this.setTimer(() => {
      if (proc.killed) return;
      proc.killed = true;
      const pid = child.pid;
      if (pid) {
        try { process.kill(-pid, "SIGTERM"); } catch {}
      }
      this.setTimer(() => {
        if (pid) {
          try { process.kill(-pid, "SIGKILL"); } catch {}
        }
      }, 10_000);
      handler({ type: "timeout", taskId: req.taskId, finishedAt: this.now() });
    }, timeoutMs);

    child.on("exit", (code) => {
      if (proc.timer) this.clearTimer(proc.timer);
      try { log.end(); } catch {}
      this.active.delete(req.taskId);
      // If the process was killed by the timeout watchdog, the timeout
      // event has already been emitted — don't double-report as exit.
      if (proc.killed) return;
      handler({
        type: "exit",
        taskId: req.taskId,
        exitCode: code ?? -1,
        finishedAt: this.now(),
      });
    });

    child.on("error", (err) => {
      handler({
        type: "error",
        taskId: req.taskId,
        error: err.message,
      });
    });
  }

  /**
   * Cancel a running task. Returns true if a process was signaled, false
   * if the taskId wasn't active.
   */
  cancel(taskId: string): boolean {
    const proc = this.active.get(taskId);
    if (!proc) return false;
    proc.killed = true;
    if (proc.timer) this.clearTimer(proc.timer);
    const pid = proc.child.pid;
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); } catch {}
    }
    this.setTimer(() => {
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
      }
    }, 10_000);
    this.active.delete(taskId);
    return true;
  }

  /** Status mapper used by the runner's event handler. */
  exitToStatus(exitCode: number): TaskStatus {
    return exitCode === 0 ? "done" : "failed";
  }

  activeCount(): number {
    return this.active.size;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }
}
