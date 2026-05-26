/**
 * state-machine.ts
 * Pure state transitions for the task runner. No I/O, no side effects —
 * exists so the lifecycle can be unit-tested in isolation.
 *
 * Lifecycle:
 *   pending → running → done
 *                     → failed
 *                     → timeout
 *   pending → cancelled (before runner picks it up)
 *   running → cancelled (signaled via Cancel)
 *
 * Terminal states: done, failed, timeout, cancelled.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "timeout",
  "cancelled",
]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type TransitionTrigger =
  | "spawn"
  | "exit_zero"
  | "exit_nonzero"
  | "timeout"
  | "cancel";

const TRANSITIONS: Record<TaskStatus, Partial<Record<TransitionTrigger, TaskStatus>>> = {
  pending: {
    spawn: "running",
    cancel: "cancelled",
  },
  running: {
    exit_zero: "done",
    exit_nonzero: "failed",
    timeout: "timeout",
    cancel: "cancelled",
  },
  done: {},
  failed: {},
  timeout: {},
  cancelled: {},
};

export class InvalidTransitionError extends Error {
  constructor(public from: TaskStatus, public trigger: TransitionTrigger) {
    super(`Invalid transition: ${from} --${trigger}--> ?`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Apply a transition. Throws `InvalidTransitionError` if the trigger is not
 * valid in the current state. Caller is responsible for persisting the
 * resulting status to the task file.
 */
export function transition(
  from: TaskStatus,
  trigger: TransitionTrigger,
): TaskStatus {
  const next = TRANSITIONS[from][trigger];
  if (!next) {
    throw new InvalidTransitionError(from, trigger);
  }
  return next;
}

export function canTransition(
  from: TaskStatus,
  trigger: TransitionTrigger,
): boolean {
  return TRANSITIONS[from][trigger] !== undefined;
}

// ── Task kinds + default timeouts ───────────────────────────────

export type TaskKind = "codex" | "claude" | "shell";

export const TASK_KINDS: ReadonlyArray<TaskKind> = ["codex", "claude", "shell"];

/** Per-kind default timeouts in minutes. Overridable per-task via
 *  `--timeout` on the CLI. Locked by spec D3. */
export const DEFAULT_TIMEOUT_MINUTES: Record<TaskKind, number> = {
  codex: 90,
  claude: 30,
  shell: 10,
};

export function isTaskKind(s: string): s is TaskKind {
  return (TASK_KINDS as ReadonlyArray<string>).includes(s);
}
