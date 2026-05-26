/**
 * wake-prompt.ts
 * Pure builder for the prompt the runner hands to an agent when one of
 * its tasks reaches a terminal state. Tested in isolation so the wording
 * stays consistent across success, failure, and timeout paths.
 *
 * Design contract:
 *   - The prompt is the agent's marching orders post-task. It must
 *     include enough context that the agent can act without re-reading
 *     the task file (though it can if it wants).
 *   - For `reply_to: <agent>:<task_id>` tasks, the wake explicitly
 *     instructs the agent to SendMessage(kind=response, task_id=...).
 *     Structured field beats prompt-engineering the linkage every time.
 *   - On failure/timeout, fall back to a sensible default if
 *     `on_failure_prompt` is empty.
 *   - Include a tail of the captured output if available so the agent
 *     can reason about what actually happened.
 */

import { existsSync, readFileSync } from "node:fs";
import type { TaskFrontmatter } from "./task-file.js";

const OUTPUT_TAIL_LINES = 50;

export interface BuildWakePromptInput {
  /** Task as written to disk after terminal state was recorded. */
  task: TaskFrontmatter;
  /** Optional output tail. Reads from `task.output_path` if not provided. */
  outputTail?: string;
}

export interface BuildWakePromptDeps {
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

/**
 * Build the wake prompt. Pure unless `outputTail` is omitted, in which
 * case the deps' fileExists/readFile are consulted.
 */
export function buildWakePrompt(
  input: BuildWakePromptInput,
  deps: BuildWakePromptDeps = {},
): string {
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

  const t = input.task;
  const success = t.status === "done";
  const banner = success
    ? `✓ Your task ${t.task_id} completed (kind: ${t.kind}, exit_code: ${t.exit_code}).`
    : t.status === "timeout"
      ? `⏰ Your task ${t.task_id} timed out (kind: ${t.kind}, after ${t.timeout_minutes}m).`
      : `✗ Your task ${t.task_id} failed (kind: ${t.kind}, exit_code: ${t.exit_code}).`;

  const lines: string[] = [];
  lines.push("[autonomy-v1 wake — your long-running task finished]");
  lines.push("");
  lines.push(banner);
  lines.push("");
  lines.push(`**Started:** ${t.started_at ?? "?"}`);
  lines.push(`**Finished:** ${t.finished_at ?? "?"}`);
  lines.push(`**Output log:** ${t.output_path}`);
  lines.push(`**Task file:** agents/${t.agent}/tasks/${t.task_id}.md`);
  lines.push("");

  // ── Output tail ──
  let tail = input.outputTail;
  if (tail === undefined && fileExists(t.output_path)) {
    try {
      const raw = readFile(t.output_path);
      const allLines = raw.split("\n");
      tail = allLines.slice(-OUTPUT_TAIL_LINES).join("\n");
    } catch {
      tail = undefined;
    }
  }
  if (tail && tail.trim().length > 0) {
    lines.push(`**Last ${OUTPUT_TAIL_LINES} lines of output:**`);
    lines.push("```");
    lines.push(tail);
    lines.push("```");
    lines.push("");
  } else {
    lines.push("_(no captured output)_");
    lines.push("");
  }

  // ── Continuation prompt ──
  if (success) {
    if (t.on_complete_prompt && t.on_complete_prompt.trim()) {
      lines.push("**Your continuation (from on_complete_prompt):**");
      lines.push(t.on_complete_prompt);
    } else {
      lines.push(
        "**No on_complete_prompt was specified.** Decide next steps and surface to the owner if anything matters here.",
      );
    }
  } else {
    if (t.on_failure_prompt && t.on_failure_prompt.trim()) {
      lines.push("**Your failure path (from on_failure_prompt):**");
      lines.push(t.on_failure_prompt);
    } else {
      // Default failure prompt — encodes the spec D3 default.
      lines.push("**No on_failure_prompt was specified. Default behavior:**");
      lines.push(
        `Task ${t.task_id} ${t.status} (exit ${t.exit_code ?? "n/a"}). Output is at ${t.output_path}. ` +
          `Decide whether to retry, escalate to the owner, or abandon. ` +
          `If this was delegated to you (delegated_by: ${t.delegated_by ?? "none"}), let the delegator know.`,
      );
    }
  }

  // ── Reply-to linkage (finding b) ──
  if (t.reply_to && t.reply_to.trim()) {
    const [replyAgent, replyTaskId] = t.reply_to.split(":", 2);
    lines.push("");
    lines.push("**Reply-to linkage (structured continuation):**");
    lines.push(
      `When you respond, call \`SendMessage\` with \`to: "${replyAgent}", kind: "response", task_id: "${replyTaskId}"\`. ` +
        `That is the original delegation this work was for. The receiving agent's bot will route your reply back to the right conversation.`,
    );
  }

  lines.push("");
  lines.push(
    "_Note: this is a wake-mode turn. Your text reply will NOT be auto-posted to your channel — use `SendMessage` if you want to notify the owner or another agent. Otherwise, just internalize the result._",
  );

  return lines.join("\n");
}

/**
 * Daily-memory line written on every wake. Short and machine-greppable
 * so operators can scan a day's wake history quickly.
 */
export function buildDailyMemoryLine(t: TaskFrontmatter): string {
  const status = t.status;
  const code = t.exit_code !== null && t.exit_code !== undefined ? `exit ${t.exit_code}` : status;
  const summary = `task ${t.task_id} (${t.kind}) → ${status} (${code})`;
  const continuation = t.on_complete_prompt
    ? "; acted on on_complete_prompt"
    : t.on_failure_prompt
      ? "; acted on on_failure_prompt"
      : "";
  return `- [wake] ${summary}${continuation}\n`;
}
