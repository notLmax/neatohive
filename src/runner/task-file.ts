/**
 * task-file.ts
 * Read/write per-agent task files at `agents/<agent>/tasks/<task_id>.md`.
 *
 * Format:
 *
 *     ---
 *     <YAML frontmatter>
 *     ---
 *
 *     # Task <task_id>
 *
 *     <free-form body — agent narrative or runner-appended notes>
 *
 * The frontmatter is the source of truth for runner state. The body is a
 * human-readable scratch area; runner ignores it for routing decisions.
 */

import yaml from "js-yaml";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type TaskStatus,
  type TaskKind,
  TERMINAL_STATUSES,
  DEFAULT_TIMEOUT_MINUTES,
} from "./state-machine.js";

// ── Frontmatter schema ────────────────────────────────────────

export interface TaskFrontmatter {
  task_id: string;
  agent: string;
  kind: TaskKind;
  cmd: string;
  status: TaskStatus;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output_path: string;
  timeout_minutes: number;
  on_complete_prompt: string | null;
  on_failure_prompt: string | null;
  /** Structured continuation linkage (finding b). Format: `<agent>:<task_id>`.
   *  When present, the wake will SendMessage(kind=response, task_id=...) to
   *  that agent. Resolved in PR 2b; PR 2a only persists the field. */
  reply_to: string | null;
  /** Optional: agent that triggered this task via hivemind delegation. */
  delegated_by: string | null;
}

export interface TaskFile {
  frontmatter: TaskFrontmatter;
  body: string;
}

// ── ID generation ─────────────────────────────────────────────

/** `t_YYYY-MM-DD_<agent>_<4-char-random>`. Sortable by date, scoped per
 *  agent, collision-resistant within a day. */
export function generateTaskId(
  agent: string,
  now: Date = new Date(),
  randomFn: () => string = () =>
    Math.random().toString(36).slice(2, 6).padEnd(4, "0"),
): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `t_${y}-${m}-${d}_${agent}_${randomFn()}`;
}

// ── Path helpers ──────────────────────────────────────────────

export function tasksDirFor(baseDir: string, agent: string): string {
  return join(baseDir, "agents", agent, "tasks");
}

export function taskFilePath(baseDir: string, agent: string, taskId: string): string {
  return join(tasksDirFor(baseDir, agent), `${taskId}.md`);
}

// ── Read / write ──────────────────────────────────────────────

const FRONTMATTER_SPLIT = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parseTaskFile(text: string): TaskFile {
  const m = text.match(FRONTMATTER_SPLIT);
  if (!m) {
    throw new Error(
      "task file is missing YAML frontmatter delimited by --- lines",
    );
  }
  const fm = yaml.load(m[1]) as TaskFrontmatter | undefined;
  if (!fm || typeof fm !== "object") {
    throw new Error("task file frontmatter did not parse to an object");
  }
  return { frontmatter: fm, body: m[2] ?? "" };
}

export function renderTaskFile(file: TaskFile): string {
  // js-yaml dumps with stable key order if we pass plain object — fine for
  // our shape. Use lineWidth: -1 to avoid mid-string folding on long cmds.
  const fm = yaml.dump(file.frontmatter, { lineWidth: -1, noRefs: true });
  return `---\n${fm}---\n\n${file.body.trimStart()}\n`;
}

export function readTaskFile(path: string): TaskFile {
  const raw = readFileSync(path, "utf8");
  return parseTaskFile(raw);
}

export function writeTaskFile(path: string, file: TaskFile): void {
  writeFileSync(path, renderTaskFile(file));
}

// ── Builders ──────────────────────────────────────────────────

export interface NewTaskInput {
  agent: string;
  kind: TaskKind;
  cmd: string;
  on_complete_prompt?: string;
  on_failure_prompt?: string;
  reply_to?: string;       // <agent>:<task_id>
  delegated_by?: string;
  timeout_minutes?: number;
  /** Override output dir; defaults to /tmp/hive-tasks. */
  output_dir?: string;
  task_id?: string;
  now?: Date;
}

export function buildNewTask(input: NewTaskInput): TaskFile {
  const now = input.now ?? new Date();
  const taskId = input.task_id ?? generateTaskId(input.agent, now);
  const outputDir = input.output_dir ?? "/tmp/hive-tasks";
  const timeout = input.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES[input.kind];

  const frontmatter: TaskFrontmatter = {
    task_id: taskId,
    agent: input.agent,
    kind: input.kind,
    cmd: input.cmd,
    status: "pending",
    started_at: null,
    finished_at: null,
    exit_code: null,
    output_path: join(outputDir, `${taskId}.log`),
    timeout_minutes: timeout,
    on_complete_prompt: input.on_complete_prompt ?? null,
    on_failure_prompt: input.on_failure_prompt ?? null,
    reply_to: input.reply_to ?? null,
    delegated_by: input.delegated_by ?? null,
  };

  const body =
    `# Task ${taskId}\n\n` +
    `**Kind:** ${input.kind}\n` +
    `**Agent:** ${input.agent}\n\n` +
    `## Command\n\n\`\`\`\n${input.cmd}\n\`\`\`\n\n` +
    `## Notes\n\n_(Runner and agent append narrative here as the task progresses.)_\n`;

  return { frontmatter, body };
}

// ── Discovery ─────────────────────────────────────────────────

/**
 * List all task files under an agent's tasks dir. Missing dir → empty list
 * (lazy-create per spec — agents don't have a tasks/ dir until they launch
 * their first task).
 */
export function listTaskFiles(baseDir: string, agent: string): string[] {
  const dir = tasksDirFor(baseDir, agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f))
    .sort();
}

/**
 * Find every non-terminal task across all agents. The runner uses this on
 * boot to resume monitoring (PR 2a: best-effort; PR 2b will handle proper
 * crash recovery via the persistent delegation registry).
 */
export function findOpenTasks(
  baseDir: string,
  agents: string[],
): Array<{ path: string; file: TaskFile }> {
  const open: Array<{ path: string; file: TaskFile }> = [];
  for (const agent of agents) {
    for (const path of listTaskFiles(baseDir, agent)) {
      try {
        const file = readTaskFile(path);
        if (!TERMINAL_STATUSES.has(file.frontmatter.status)) {
          open.push({ path, file });
        }
      } catch {
        // Malformed file — skip. Logged at the runner level.
      }
    }
  }
  return open;
}

export function ensureTasksDir(baseDir: string, agent: string): string {
  const dir = tasksDirFor(baseDir, agent);
  mkdirSync(dir, { recursive: true });
  return dir;
}
