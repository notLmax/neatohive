/**
 * events-log.ts
 * One-line-per-event JSON log at `data/runner-events.log`. Visible record
 * of every state change so post-mortem debugging doesn't require attaching
 * to a live tmux session (we don't have one — see PR 2a Finding (d)).
 *
 * Synchronous and fail-soft: a bad write logs to console and is dropped
 * rather than crashing the daemon.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RunnerEvent {
  ts: string;
  taskId: string;
  agent?: string;
  kind?: string;
  event:
    | "discovered"
    | "spawned"
    | "exit"
    | "timeout"
    | "cancelled"
    | "error"
    | "boot"
    | "shutdown"
    | "wake_enqueued"
    | "wake_processed"
    | "boot_wake_enqueued"
    | "wake_picked_up"
    | "wake_turn_started"
    | "wake_turn_complete"
    | "wake_archived";
  detail?: unknown;
}

export interface EventsLogger {
  log: (event: Omit<RunnerEvent, "ts">) => void;
  /** Path of the log file — exposed for the boot banner so operators can
   *  tail it. */
  path: string;
}

export function defaultEventsLogPath(baseDir: string): string {
  return join(baseDir, "data", "runner-events.log");
}

export function createEventsLogger(
  path: string,
  opts: {
    appendFile?: (path: string, content: string) => void;
    mkdir?: (path: string) => void;
    exists?: (path: string) => boolean;
    now?: () => Date;
  } = {},
): EventsLogger {
  const appendFile = opts.appendFile ?? ((p: string, c: string) => appendFileSync(p, c));
  const mkdir = opts.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const exists = opts.exists ?? ((p: string) => existsSync(p));
  const now = opts.now ?? (() => new Date());

  if (!exists(dirname(path))) {
    try { mkdir(dirname(path)); } catch {}
  }

  return {
    path,
    log(event) {
      const full: RunnerEvent = { ts: now().toISOString(), ...event };
      try {
        appendFile(path, JSON.stringify(full) + "\n");
      } catch (err) {
        console.error(
          `[runner] failed to write events log: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
