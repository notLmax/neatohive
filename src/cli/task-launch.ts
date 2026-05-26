/**
 * cli/task-launch.ts
 * Implementation of `hive task launch`. Decoupled from the runner — this
 * just writes a `pending` task file. The runner picks it up on its next
 * polling sweep and spawns the child.
 *
 * Usage:
 *   node dist/cli/task-launch.js
 *     --agent <name>
 *     --kind <codex|claude|shell>
 *     --cmd "<shell command>"
 *     [--on-complete "<prompt>"]
 *     [--on-failure  "<prompt>"]
 *     [--timeout <minutes>]
 *     [--reply-to <agent>:<task_id>]
 *     [--delegated-by <agent>]
 *
 * On success: prints the task id (and absolute path) to stdout, exits 0.
 * On error: prints to stderr, exits non-zero.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildNewTask,
  renderTaskFile,
  taskFilePath,
} from "../runner/task-file.js";
import { isTaskKind, type TaskKind } from "../runner/state-machine.js";

interface ParsedArgs {
  agent: string;
  kind: TaskKind;
  cmd: string;
  on_complete?: string;
  on_failure?: string;
  timeout_minutes?: number;
  reply_to?: string;
  delegated_by?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      // Boolean flag — not used yet, but keep the door open.
      flags[key] = "true";
    } else {
      flags[key] = next;
      i++;
    }
  }

  const required = ["agent", "kind", "cmd"] as const;
  for (const r of required) {
    if (!flags[r]) {
      throw new Error(`missing required flag: --${r}`);
    }
  }

  if (!isTaskKind(flags.kind)) {
    throw new Error(
      `unknown kind: ${flags.kind} (expected: codex | claude | shell)`,
    );
  }

  if (flags["reply-to"] && !/^[a-z0-9-]+:[a-z0-9-]+/i.test(flags["reply-to"])) {
    throw new Error(
      `--reply-to must be in the form <agent>:<task_id>, got: ${flags["reply-to"]}`,
    );
  }

  const timeoutRaw = flags.timeout;
  let timeout_minutes: number | undefined;
  if (timeoutRaw !== undefined) {
    const n = Number(timeoutRaw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--timeout must be a positive number of minutes, got: ${timeoutRaw}`);
    }
    timeout_minutes = n;
  }

  return {
    agent: flags.agent,
    kind: flags.kind,
    cmd: flags.cmd,
    on_complete: flags["on-complete"],
    on_failure: flags["on-failure"],
    timeout_minutes,
    reply_to: flags["reply-to"],
    delegated_by: flags["delegated-by"],
  };
}

/**
 * Cross-agent gate. Throws if `callerAgent` is set and differs from
 * `targetAgent` — delegating agents must send a hivemind delegation,
 * not dispatch workers on each other's behalf. (See LESSONS.md 2026-05-06.)
 *
 * Returns normally when:
 * - callerAgent is undefined/empty (owner running from terminal)
 * - callerAgent === targetAgent (self-dispatch — the legitimate path)
 */
export function assertSameAgent(
  callerAgent: string | undefined,
  targetAgent: string,
): void {
  if (callerAgent && callerAgent !== targetAgent) {
    throw new CrossAgentError(callerAgent, targetAgent);
  }
}

export class CrossAgentError extends Error {
  constructor(
    public readonly callerAgent: string,
    public readonly targetAgent: string,
  ) {
    super(
      `agent '${callerAgent}' cannot launch a worker on behalf of '${targetAgent}'`,
    );
    this.name = "CrossAgentError";
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[hive task launch] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // ── Cross-agent gate ──
  // HIVE_AGENT_NAME is set on every PM2 agent process by src/index.ts.
  // If the caller is an agent process AND --agent is a different agent,
  // refuse: delegating agents must send a hivemind delegation, not
  // dispatch workers on each other's behalf. (See LESSONS.md 2026-05-06.)
  const callerAgent = process.env.HIVE_AGENT_NAME;
  try {
    assertSameAgent(callerAgent, args.agent);
  } catch (err) {
    if (err instanceof CrossAgentError) {
      console.error(
        `[hive task launch] BLOCKED: ${err.message}.`,
      );
      console.error(
        `[hive task launch] Delegating agents send a hivemind delegation; the receiving agent decides whether and how to dispatch.`,
      );
      console.error(
        `[hive task launch] If you genuinely need to dispatch on another agent's behalf (rare), unset HIVE_AGENT_NAME before invoking — but this is almost never the right move.`,
      );
      process.exit(3);
    }
    throw err;
  }

  const baseDir = process.cwd();
  const file = buildNewTask({
    agent: args.agent,
    kind: args.kind,
    cmd: args.cmd,
    on_complete_prompt: args.on_complete,
    on_failure_prompt: args.on_failure,
    reply_to: args.reply_to,
    delegated_by: args.delegated_by,
    timeout_minutes: args.timeout_minutes,
  });

  const path = taskFilePath(baseDir, args.agent, file.frontmatter.task_id);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderTaskFile(file));
  } catch (err) {
    console.error(
      `[hive task launch] failed to write task file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }

  // Stable, scriptable output: machine-parseable first line + human path.
  console.log(file.frontmatter.task_id);
  console.error(`[hive task launch] wrote ${path}`);
  console.error(
    `[hive task launch] runner will pick it up on its next poll (~2s). Watch:`,
  );
  console.error(`[hive task launch]   tail -f ${join(baseDir, "data", "runner-events.log")}`);
}

// Only run when invoked directly (not when imported by tests).
const isDirectEntry =
  process.argv[1]?.endsWith("task-launch.js") ||
  process.argv[1]?.endsWith("task-launch.ts");
if (isDirectEntry) {
  main();
}
