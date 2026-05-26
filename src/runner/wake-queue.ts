/**
 * wake-queue.ts
 *
 * Cross-process wake signaling. The runner daemon and the per-agent bot
 * processes are separate PIDs, so the runner can't directly invoke the
 * bot's in-process `agentExecutor`. Instead, the runner writes a wake
 * file at `agents/<name>/wake/<task_id>.json`. The bot polls its own
 * wake dir, reads the file, calls `agentExecutor(prompt, {mode:"wake"})`,
 * then archives the file to `agents/<name>/wake/processed/`.
 *
 * Why a file queue:
 *   - Reuses the per-agent storage convention (agents/<name>/...).
 *   - No new transport (no IPC sockets, no HTTP endpoint per bot).
 *   - Operator-inspectable — `ls agents/atlas/wake/` shows pending wakes.
 *   - Crash-resilient: if the bot is restarting when the runner writes
 *     a wake, the file is still there when the bot comes back up.
 *
 * Why not synthetic hivemind: explicitly rejected by the spec. Pollutes
 * #hivemind, creates a parallel routing path, breaks visibility.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface WakeSignal {
  task_id: string;
  agent: string;
  status: string;
  /** Pre-rendered prompt the bot will hand to agentExecutor. */
  prompt: string;
  /** ISO 8601 — when the runner enqueued the wake. */
  enqueued_at: string;
  /** Path to the original task .md file, for cross-reference. */
  task_path: string;
}

export function wakeDirFor(baseDir: string, agent: string): string {
  return join(baseDir, "agents", agent, "wake");
}

export function processedDirFor(baseDir: string, agent: string): string {
  return join(wakeDirFor(baseDir, agent), "processed");
}

export function ensureWakeDirs(baseDir: string, agent: string): void {
  mkdirSync(wakeDirFor(baseDir, agent), { recursive: true });
  mkdirSync(processedDirFor(baseDir, agent), { recursive: true });
}

/**
 * Write a wake signal. Atomic via write-temp-then-rename so a partial
 * file can never be picked up by the bot mid-write.
 */
export function enqueueWake(
  baseDir: string,
  signal: WakeSignal,
): string {
  ensureWakeDirs(baseDir, signal.agent);
  const finalPath = join(
    wakeDirFor(baseDir, signal.agent),
    `${signal.task_id}.json`,
  );
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(signal, null, 2));
  renameSync(tempPath, finalPath);
  return finalPath;
}

/**
 * List pending wake signals for an agent (filenames only). Returns
 * absolute paths. Skips the `processed/` subdir.
 *
 * Both task-completion wakes (<task_id>.json) and boot-announce wakes
 * (boot-announce-<ts>.json) coexist in the same directory. The
 * `.endsWith(".json")` filter picks up both shapes.
 */
export function listPendingWakes(baseDir: string, agent: string): string[] {
  const dir = wakeDirFor(baseDir, agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort();
}

export function readWakeSignal(path: string): WakeSignal {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as WakeSignal;
  if (!parsed.task_id || !parsed.agent || !parsed.prompt) {
    throw new Error(`malformed wake signal at ${path}`);
  }
  return parsed;
}

/**
 * Move a processed wake file out of the active queue into the
 * processed/ archive. Operators can inspect or prune at leisure.
 */
export function archiveWake(baseDir: string, agent: string, wakePath: string): string {
  ensureWakeDirs(baseDir, agent);
  const file = wakePath.split("/").pop() ?? "wake.json";
  const dest = join(processedDirFor(baseDir, agent), file);
  renameSync(wakePath, dest);
  return dest;
}
