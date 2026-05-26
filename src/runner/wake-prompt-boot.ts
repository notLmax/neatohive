/**
 * wake-prompt-boot.ts
 * Pure builder for the boot-announce wake prompt. When the runner detects
 * a new boot beacon entry, it builds this prompt and enqueues it as a wake
 * signal. The agent then calls sendToOwnChannel to post a visible "back
 * online" message.
 */

import type { BootEntry } from "./boot-watcher.js";

export interface BuildBootWakePromptInput {
  agent: string;
  version: string;
  bootEntry: BootEntry;
  /** Recent task summaries (last 24h). Empty array if none. */
  recentTasks: string[];
  /** Tail of today's daily memory file. Empty string if none. */
  dailyMemoryTail: string;
}

/**
 * Build the boot-announce wake prompt. Pure function — all data is
 * passed in via the input object.
 */
export function buildBootWakePrompt(input: BuildBootWakePromptInput): string {
  const { agent, version, bootEntry, recentTasks, dailyMemoryTail } = input;

  const lines: string[] = [];

  lines.push("[autonomy-v1 wake — agent restart detected]");
  lines.push("");
  lines.push("You just restarted as part of a fleet wave or manual restart.");
  lines.push("");
  lines.push(`**Version:** v${version}`);
  lines.push(`**Boot at:** ${bootEntry.ts}`);
  lines.push(`**PID:** ${bootEntry.pid}`);
  lines.push("");

  if (recentTasks.length > 0) {
    lines.push(`**Recent tasks (last 24h):** ${recentTasks.length}`);
    for (const task of recentTasks) {
      lines.push(`  - ${task}`);
    }
  } else {
    lines.push("**Recent tasks (last 24h):** none");
  }
  lines.push("");

  if (dailyMemoryTail.trim()) {
    lines.push("**Daily memory (last 5 lines):**");
    lines.push("```");
    lines.push(dailyMemoryTail);
    lines.push("```");
  } else {
    lines.push("**Daily memory:** _(no entries today)_");
  }
  lines.push("");

  lines.push("**Your continuation:**");
  lines.push(
    `Use \`sendToOwnChannel({message: "..."})\` to post a brief, friendly ` +
      `"back online" message to your primary channel. Keep it under ~80 words. ` +
      `Mention the version, optionally a one-line "what I did just before ` +
      `restart" callout if your daily memory shows recent work. Then end ` +
      `your turn.`,
  );
  lines.push("");
  lines.push(
    "This is a wake-mode turn. Your text reply is NOT auto-posted — only " +
      "the explicit `sendToOwnChannel` call surfaces.",
  );

  return lines.join("\n");
}
