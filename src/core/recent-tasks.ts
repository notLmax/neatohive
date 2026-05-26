/**
 * recent-tasks.ts
 *
 * Renders a "Recent Tasks" section for an agent's system prompt.
 * Per spec D1: "Each agent gets its recent tasks injected into the
 * system prompt at session start." Without this, an agent has no
 * awareness of pending work between sessions — every restart looks
 * like a clean slate even when codex jobs are still running.
 *
 * Recency rules:
 *   - Always include non-terminal tasks (pending / running) regardless
 *     of age. The agent NEEDS to know about live work.
 *   - For terminal tasks (done / failed / timeout / cancelled), include
 *     only those that finished in the last 24h.
 *   - Cap total entries at 10 to bound prompt growth.
 *   - Sort: live tasks first (newest), then recent terminals (newest).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface SimpleTaskFrontmatter {
  task_id: string;
  agent: string;
  kind: string;
  cmd: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
}

const FRONTMATTER_SPLIT = /^---\s*\n([\s\S]*?)\n---/;
const TERMINAL = new Set(["done", "failed", "timeout", "cancelled"]);
const RECENT_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10;

function tryParseFrontmatter(text: string): SimpleTaskFrontmatter | null {
  const m = text.match(FRONTMATTER_SPLIT);
  if (!m) return null;
  try {
    const obj = yaml.load(m[1]);
    if (!obj || typeof obj !== "object") return null;
    return obj as SimpleTaskFrontmatter;
  } catch {
    return null;
  }
}

export interface RecentTasksDeps {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  readDir?: (p: string) => string[];
  now?: () => number;
}

/**
 * Read the agent's tasks/ dir and return the entries the system prompt
 * should surface. Pure-ish: filesystem ops are injectable.
 */
export function collectRecentTasks(
  tasksDir: string,
  deps: RecentTasksDeps = {},
): SimpleTaskFrontmatter[] {
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
  const now = deps.now ?? (() => Date.now());

  if (!fileExists(tasksDir)) return [];

  const live: SimpleTaskFrontmatter[] = [];
  const recentTerminal: SimpleTaskFrontmatter[] = [];

  const cutoff = now() - RECENT_TERMINAL_WINDOW_MS;

  for (const file of readDir(tasksDir)) {
    if (!file.endsWith(".md")) continue;
    let raw: string;
    try {
      raw = readFile(join(tasksDir, file));
    } catch {
      continue;
    }
    const fm = tryParseFrontmatter(raw);
    if (!fm) continue;

    if (TERMINAL.has(fm.status)) {
      const finishedAtMs = fm.finished_at ? Date.parse(fm.finished_at) : NaN;
      if (Number.isFinite(finishedAtMs) && finishedAtMs >= cutoff) {
        recentTerminal.push(fm);
      }
    } else {
      live.push(fm);
    }
  }

  // Sort live tasks newest-first by started_at (or task_id for ties).
  live.sort((a, b) => {
    const aMs = a.started_at ? Date.parse(a.started_at) : 0;
    const bMs = b.started_at ? Date.parse(b.started_at) : 0;
    if (bMs !== aMs) return bMs - aMs;
    return b.task_id.localeCompare(a.task_id);
  });
  // Sort recent terminals newest-first by finished_at.
  recentTerminal.sort((a, b) => {
    const aMs = a.finished_at ? Date.parse(a.finished_at) : 0;
    const bMs = b.finished_at ? Date.parse(b.finished_at) : 0;
    return bMs - aMs;
  });

  return [...live, ...recentTerminal].slice(0, MAX_ENTRIES);
}

/**
 * Render the section as markdown. Empty list returns empty string so
 * the system prompt skips the section entirely.
 */
export function renderRecentTasksSection(
  tasks: SimpleTaskFrontmatter[],
): string {
  if (tasks.length === 0) return "";

  const lines: string[] = [];
  lines.push("# Recent Tasks");
  lines.push("");
  lines.push(
    "Long-running tasks you launched via `hive task launch`. Live ones are still running (the runner will wake you when they complete). Terminal ones finished in the last 24h.",
  );
  lines.push("");
  lines.push("| Task ID | Kind | Status | Exit | Started | Finished |");
  lines.push("|---------|------|--------|------|---------|----------|");
  for (const t of tasks) {
    const exit =
      t.exit_code === null || t.exit_code === undefined ? "—" : String(t.exit_code);
    lines.push(
      `| ${t.task_id} | ${t.kind} | ${t.status} | ${exit} | ${t.started_at ?? "—"} | ${t.finished_at ?? "—"} |`,
    );
  }
  return lines.join("\n");
}
