/**
 * runner/index.ts
 * Long-running `hive-runner` daemon. Watches every agent's tasks/ dir,
 * spawns child processes for `pending` tasks, monitors them to terminal
 * state, and writes the result back to the task file.
 *
 * PR 2a scope: observable runner. No auto-wake — that's PR 2b.
 *
 * Architecture:
 *
 *   discoverPendingTasks() ──▶ Spawner.launch() ──▶ events ──▶ updateTaskFile()
 *                                                          ──▶ EventsLogger
 *
 * Polling loop is used instead of fs.watch because fs.watch has flaky
 * cross-platform behavior (especially macOS), and the latency budget
 * for picking up a new task is generous (~2s).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../core/agent.js";
import { Spawner, type SpawnEvent } from "./spawner.js";
import {
  type TaskFile,
  readTaskFile,
  writeTaskFile,
  listTaskFiles,
} from "./task-file.js";
import {
  transition,
  type TaskStatus,
  isTaskKind,
  isTerminal,
} from "./state-machine.js";
import {
  createEventsLogger,
  defaultEventsLogPath,
  type EventsLogger,
} from "./events-log.js";
import { buildWakePrompt } from "./wake-prompt.js";
import { enqueueWake, ensureWakeDirs, wakeDirFor } from "./wake-queue.js";
import { readBootBeacon, findNewEntries, bootBeaconPath } from "./boot-watcher.js";
import { buildBootWakePrompt } from "./wake-prompt-boot.js";
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, readdirSync, writeFileSync as fsWriteFileSync, renameSync as fsRenameSync } from "node:fs";

const POLL_INTERVAL_MS = 2_000;

// ── Per-process state ─────────────────────────────────────────

interface RunnerState {
  baseDir: string;
  agents: string[];
  spawner: Spawner;
  events: EventsLogger;
  /** taskId → file path. Lets us update the right file when an event
   *  arrives, without rescanning the disk every time. */
  pathByTaskId: Map<string, string>;
  /** Track which tasks we've already discovered so the polling loop
   *  doesn't re-spawn the same pending task multiple times. */
  picked: Set<string>;
  /** Per-agent last-seen timestamp for boot beacon entries. Initialized
   *  to runner's own boot time (quiet cutoff — avoids replaying old
   *  entries on runner restart). */
  bootLastSeen: Map<string, string>;
}

// ── Task processing ───────────────────────────────────────────

function processOneTask(state: RunnerState, path: string): void {
  let file: TaskFile;
  try {
    file = readTaskFile(path);
  } catch (err) {
    state.events.log({
      taskId: "unknown",
      event: "error",
      detail: `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const fm = file.frontmatter;

  // Already terminal — nothing to do.
  if (isTerminal(fm.status)) return;
  // Already running and we've already picked it — keep waiting.
  if (state.picked.has(fm.task_id)) return;
  // Sanity: must be a known kind.
  if (!isTaskKind(fm.kind)) {
    state.events.log({
      taskId: fm.task_id,
      event: "error",
      detail: `unknown kind: ${fm.kind}`,
    });
    return;
  }
  // Tasks marked `running` from a prior runner session are orphaned. Mark
  // them failed AND fire a wake so the owning agent can decide retry /
  // escalate / abandon. v1.3.3 fix — previously the agent had no signal
  // when its task died on runner restart, breaking the "PR 2b crash
  // recovery" promise.
  if (fm.status === "running") {
    fm.status = "failed";
    fm.finished_at = new Date().toISOString();
    fm.exit_code = fm.exit_code ?? -1;
    file.body += `\n_(Marked failed on runner restart — task was running but the prior runner exited. Wake fired with failure path so the agent can decide retry / escalate / abandon.)_\n`;
    writeTaskFile(path, file);
    state.events.log({
      taskId: fm.task_id,
      agent: fm.agent,
      kind: fm.kind,
      event: "error",
      detail: "orphaned-on-runner-restart",
    });

    // Fire a wake so the agent finds out. The wake prompt's failure path
    // ("decide whether to retry, escalate, or abandon") is appropriate
    // here — the agent doesn't know the task didn't actually fail in the
    // child, but the practical effect is the same.
    try {
      const prompt = buildWakePrompt({ task: fm });
      const wakePath = enqueueWake(state.baseDir, {
        task_id: fm.task_id,
        agent: fm.agent,
        status: fm.status,
        prompt,
        enqueued_at: new Date().toISOString(),
        task_path: path,
      });
      state.events.log({
        taskId: fm.task_id,
        agent: fm.agent,
        kind: fm.kind,
        event: "wake_enqueued",
        detail: { wakePath, reason: "orphan-recovery" },
      });
    } catch (err) {
      state.events.log({
        taskId: fm.task_id,
        agent: fm.agent,
        event: "error",
        detail: `failed to enqueue orphan-recovery wake: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }
  if (fm.status !== "pending") return;

  state.picked.add(fm.task_id);
  state.pathByTaskId.set(fm.task_id, path);
  state.events.log({
    taskId: fm.task_id,
    agent: fm.agent,
    kind: fm.kind,
    event: "discovered",
    detail: { cmd: fm.cmd, timeout_minutes: fm.timeout_minutes },
  });

  // Persist running status BEFORE spawn so a runner crash mid-spawn doesn't
  // leave the file in `pending` forever. (Subtle: there's a tiny window
  // where status=running and no PID — orphan recovery in 2b will catch it.)
  fm.status = transition(fm.status, "spawn");
  fm.started_at = new Date().toISOString();
  writeTaskFile(path, file);

  state.spawner.launch(
    {
      taskId: fm.task_id,
      kind: fm.kind,
      cmd: fm.cmd,
      outputPath: fm.output_path,
      timeoutMinutes: fm.timeout_minutes,
    },
    (event) => handleSpawnEvent(state, event),
  );
}

function handleSpawnEvent(state: RunnerState, event: SpawnEvent): void {
  const path = state.pathByTaskId.get(event.taskId);

  switch (event.type) {
    case "started": {
      state.events.log({
        taskId: event.taskId,
        event: "spawned",
        detail: { pid: event.pid },
      });
      return;
    }
    case "exit":
    case "timeout": {
      if (!path) return; // shouldn't happen, but guard
      let file: TaskFile;
      try {
        file = readTaskFile(path);
      } catch {
        return;
      }
      const trigger =
        event.type === "timeout"
          ? "timeout"
          : event.exitCode === 0
            ? "exit_zero"
            : "exit_nonzero";
      let nextStatus: TaskStatus;
      try {
        nextStatus = transition(file.frontmatter.status, trigger);
      } catch {
        // Already terminal somehow — leave alone.
        return;
      }
      file.frontmatter.status = nextStatus;
      file.frontmatter.finished_at = new Date(event.finishedAt).toISOString();
      file.frontmatter.exit_code =
        event.type === "exit" ? event.exitCode : null;
      writeTaskFile(path, file);
      state.events.log({
        taskId: event.taskId,
        agent: file.frontmatter.agent,
        kind: file.frontmatter.kind,
        event: event.type === "timeout" ? "timeout" : "exit",
        detail:
          event.type === "exit"
            ? { exitCode: event.exitCode, status: nextStatus }
            : { status: nextStatus },
      });

      // ── PR 2b: fire the wake ──
      // Build the prompt from the now-terminal task file, drop a wake
      // signal into the agent's wake queue. The agent's bot polls that
      // queue and invokes its registered agentExecutor with mode="wake".
      try {
        const prompt = buildWakePrompt({ task: file.frontmatter });
        const wakePath = enqueueWake(state.baseDir, {
          task_id: file.frontmatter.task_id,
          agent: file.frontmatter.agent,
          status: file.frontmatter.status,
          prompt,
          enqueued_at: new Date().toISOString(),
          task_path: path,
        });
        state.events.log({
          taskId: event.taskId,
          agent: file.frontmatter.agent,
          kind: file.frontmatter.kind,
          event: "wake_enqueued",
          detail: { wakePath },
        });
      } catch (err) {
        state.events.log({
          taskId: event.taskId,
          agent: file.frontmatter.agent,
          event: "error",
          detail: `failed to enqueue wake: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    case "error": {
      state.events.log({
        taskId: event.taskId,
        event: "error",
        detail: event.error,
      });
      return;
    }
  }
}

// ── Boot beacon polling ──────────────────────────────────────

function pollBootBeacons(state: RunnerState): void {
  for (const agent of state.agents) {
    const beaconFile = bootBeaconPath(state.baseDir, agent);
    const entries = readBootBeacon(beaconFile);
    const lastSeen = state.bootLastSeen.get(agent) ?? new Date().toISOString();
    const newEntries = findNewEntries(entries, lastSeen);

    for (const entry of newEntries) {
      // Gather context for the boot-announce prompt.
      let recentTasks: string[] = [];
      let dailyMemoryTail = "";

      // Recent tasks: scan agents/<agent>/tasks/ for files modified in last 24h.
      try {
        const tasksDir = join(state.baseDir, "agents", agent, "tasks");
        if (fsExistsSync(tasksDir)) {
          const taskFiles = readdirSync(tasksDir)
            .filter((f) => f.endsWith(".md"))
            .slice(-10);
          for (const tf of taskFiles) {
            try {
              const content = fsReadFileSync(join(tasksDir, tf), "utf-8");
              const idMatch = content.match(/task_id:\s*(\S+)/);
              const statusMatch = content.match(/status:\s*(\S+)/);
              const kindMatch = content.match(/kind:\s*(\S+)/);
              if (idMatch && statusMatch) {
                recentTasks.push(
                  `${idMatch[1]} (${kindMatch?.[1] ?? "?"}) → ${statusMatch[1]}`,
                );
              }
            } catch {}
          }
        }
      } catch {}

      // Daily memory tail: last 5 lines of today's memory file.
      try {
        const today = new Date();
        const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const memoryFile = join(state.baseDir, "agents", agent, "memory", `${ymd}.md`);
        if (fsExistsSync(memoryFile)) {
          const lines = fsReadFileSync(memoryFile, "utf-8").split("\n");
          dailyMemoryTail = lines.slice(-5).join("\n");
        }
      } catch {}

      // Build the prompt and enqueue the wake.
      try {
        const prompt = buildBootWakePrompt({
          agent,
          version: entry.version,
          bootEntry: entry,
          recentTasks,
          dailyMemoryTail,
        });

        ensureWakeDirs(state.baseDir, agent);
        const wakeFileName = `boot-announce-${entry.ts.replace(/[:.]/g, "-")}.json`;
        const wakePath = join(wakeDirFor(state.baseDir, agent), wakeFileName);
        const tempPath = `${wakePath}.tmp-${process.pid}`;
        const signal = {
          task_id: `boot-${entry.ts}`,
          agent,
          status: "boot-announce",
          prompt,
          enqueued_at: new Date().toISOString(),
          task_path: beaconFile,
        };
        fsWriteFileSync(tempPath, JSON.stringify(signal, null, 2));
        fsRenameSync(tempPath, wakePath);

        state.events.log({
          taskId: `boot-${entry.ts}`,
          agent,
          event: "boot_wake_enqueued",
          detail: { wakePath, version: entry.version, pid: entry.pid },
        });
      } catch (err) {
        state.events.log({
          taskId: `boot-${entry.ts}`,
          agent,
          event: "error",
          detail: `failed to enqueue boot wake: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Update last-seen regardless of enqueue success.
      state.bootLastSeen.set(agent, entry.ts);
    }
  }
}

// ── Polling loop ──────────────────────────────────────────────

function pollOnce(state: RunnerState): void {
  for (const agent of state.agents) {
    for (const path of listTaskFiles(state.baseDir, agent)) {
      processOneTask(state, path);
    }
  }
  pollBootBeacons(state);
}

// ── Entry point ───────────────────────────────────────────────

export async function main(): Promise<void> {
  const baseDir = process.cwd();
  const configPath = join(baseDir, "config", "config.yaml");
  if (!existsSync(configPath)) {
    console.error(`[runner] missing ${configPath} — refusing to start`);
    process.exit(1);
  }
  const config = loadConfig(configPath);
  const agents = Object.keys(
    (config.agents as Record<string, unknown>) ?? {},
  );

  const events = createEventsLogger(defaultEventsLogPath(baseDir));
  const spawner = new Spawner();

  // Quiet runner cutoff: initialize each agent's last-seen to runner's
  // own boot time so old historical beacon entries don't fire on restart.
  const runnerBootTime = new Date().toISOString();
  const bootLastSeen = new Map<string, string>();
  for (const agent of agents) {
    bootLastSeen.set(agent, runnerBootTime);
  }

  const state: RunnerState = {
    baseDir,
    agents,
    spawner,
    events,
    pathByTaskId: new Map(),
    picked: new Set(),
    bootLastSeen,
  };

  console.log("================================================");
  console.log("  Neato Hive — task runner");
  console.log("================================================");
  console.log();
  console.log(`[runner] base: ${baseDir}`);
  console.log(`[runner] agents: ${agents.join(", ")}`);
  console.log(`[runner] events log: ${events.path}`);
  console.log(`[runner] poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[runner] v1.3.6 — task runner + boot beacon watcher.`);
  console.log();

  events.log({ taskId: "-", event: "boot", detail: { agents } });

  // First sweep, then poll.
  pollOnce(state);
  const interval = setInterval(() => pollOnce(state), POLL_INTERVAL_MS);

  const shutdown = (signal: string) => {
    console.log(`\n[runner] ${signal} — shutting down`);
    clearInterval(interval);
    events.log({ taskId: "-", event: "shutdown", detail: { signal } });
    // Don't kill in-flight children — they may be long-running codex jobs
    // that survive runner restarts. The orphan-recovery path picks them up.
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// NOTE: main() is exported above and invoked from src/runner/main.ts.
// Do NOT auto-run main() at module load — tests import from this file.

export { processOneTask, handleSpawnEvent, pollOnce, pollBootBeacons, type RunnerState };
