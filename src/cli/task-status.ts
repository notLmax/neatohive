/**
 * cli/task-status.ts
 * Implementation of `hive task status <task-id>`. Reads the runner events
 * log, filters to a given task, and prints the event chain with relative
 * timestamps.
 *
 * Usage:
 *   node dist/cli/task-status.js <task-id>
 *
 * Exit codes:
 *   0 — success
 *   1 — no events found / no log file
 *   2 — bad args
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface EventLine {
  ts: string;
  taskId: string;
  agent?: string;
  event: string;
  detail?: Record<string, unknown>;
}

/**
 * Parse raw JSONL log content, filtering to a specific taskId.
 * Malformed lines are silently skipped.
 */
export function parseEventLog(rawLog: string, taskId: string): EventLine[] {
  const events: EventLine[] = [];
  for (const line of rawLog.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.taskId === taskId) events.push(e);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/**
 * Format a relative duration in milliseconds into a human-readable string.
 */
export function formatRelativeTime(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `+${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `+${minutes}m`;
  return `+${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Format detail fields as a flat key=value string for display.
 */
function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/**
 * Format a list of events into the human-readable event chain string.
 */
export function formatEventChain(events: EventLine[]): string {
  if (events.length === 0) return "";

  const baseTs = new Date(events[0].ts).getTime();
  const agents = new Set(events.map((e) => e.agent).filter(Boolean));
  const showAgent = agents.size > 1;

  const header = [
    `Task: ${events[0].taskId}`,
    `Agent: ${events[0].agent ?? "unknown"}`,
    "",
  ].join("\n");

  const rows = events.map((e) => {
    const relMs = new Date(e.ts).getTime() - baseTs;
    const time = formatRelativeTime(relMs).padEnd(12);
    const eventName = e.event.padEnd(20);
    const detail = formatDetail(e.detail);
    const agentCol = showAgent ? `[${e.agent}] ` : "";
    return `  ${time}${agentCol}${eventName}${detail}`;
  });

  return header + rows.join("\n") + "\n";
}

function main(): void {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("usage: hive task status <task-id>");
    process.exit(2);
  }

  const logPath = join(process.cwd(), "data", "runner-events.log");
  if (!existsSync(logPath)) {
    console.error(`no event log at ${logPath}`);
    process.exit(1);
  }

  const rawLog = readFileSync(logPath, "utf-8");
  const events = parseEventLog(rawLog, taskId);

  if (events.length === 0) {
    console.error(`no events for task: ${taskId}`);
    process.exit(1);
  }

  process.stdout.write(formatEventChain(events));
}

// Only run when invoked directly (not when imported by tests).
const isDirectEntry =
  process.argv[1]?.endsWith("task-status.js") ||
  process.argv[1]?.endsWith("task-status.ts");
if (isDirectEntry) {
  main();
}
