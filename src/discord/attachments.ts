/**
 * attachments.ts
 * Pure helpers for handling `[ATTACH:/absolute/path]` markers that agents
 * emit in their replies. Kept separate from bot.ts so it can be unit-tested
 * without pulling in the Discord client, the agent runtime, or any of the
 * heavier transitive dependencies.
 */

import { AttachmentBuilder } from "discord.js";
import { basename, isAbsolute, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

/** Marker pattern. Global so multiple markers in a single message all match. */
export const ATTACH_PATTERN = /\[ATTACH:([^\]]+)\]/g;

/**
 * Strips every `[ATTACH:...]` marker from `text` and returns the cleaned
 * text plus the captured paths (in order). Excess blank lines created by
 * stripping are collapsed to `\n\n` and the result is trimmed so the
 * downstream formatter doesn't post padding.
 */
export function extractAttachments(
  text: string,
): { cleanText: string; filePaths: string[] } {
  const filePaths: string[] = [];
  const cleanText = text
    .replace(ATTACH_PATTERN, (_match, path) => {
      filePaths.push(path.trim());
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, filePaths };
}

/**
 * Resolves the captured `filePaths` into Discord `AttachmentBuilder`s,
 * applying the hivemind policy:
 *   - Relative paths are rejected (agents must use absolute paths).
 *   - Missing / unreadable files are skipped with a warning.
 *   - Multiple attachments are supported.
 *   - The caller handles how warnings surface (console, daily memory, etc).
 *   - Failure on any single marker never throws — degrades gracefully.
 *
 * `opts.fsCheck` and `opts.buildAttachment` are injection points for unit
 * tests so they don't have to hit the filesystem or instantiate real
 * `AttachmentBuilder` objects.
 */
export function resolveAttachments(
  filePaths: string[],
  opts?: {
    fsCheck?: (p: string) => boolean;
    buildAttachment?: (fp: string, name: string) => AttachmentBuilder;
  },
): { builders: AttachmentBuilder[]; warnings: string[] } {
  const fsCheck = opts?.fsCheck ?? existsSync;
  const buildAttachment =
    opts?.buildAttachment ??
    ((fp: string, name: string) => new AttachmentBuilder(fp, { name }));

  const builders: AttachmentBuilder[] = [];
  const warnings: string[] = [];

  for (const fp of filePaths) {
    if (!fp) continue;
    if (!isAbsolute(fp)) {
      warnings.push(`rejected non-absolute ATTACH path: ${fp}`);
      continue;
    }
    if (!fsCheck(fp)) {
      warnings.push(`ATTACH file not found: ${fp}`);
      continue;
    }
    try {
      builders.push(buildAttachment(fp, basename(fp)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`failed to attach ${fp}: ${msg}`);
    }
  }

  return { builders, warnings };
}

/**
 * Appends a hivemind-attachment warning to the sending agent's daily memory
 * file (`<baseDir>/agents/<name>/memory/YYYY-MM-DD.md`). If the file doesn't
 * exist yet for today, it's created with a matching date header so the
 * format aligns with what the agent would write itself.
 *
 * Synchronous and fail-soft: any filesystem error is logged to console and
 * swallowed so a bad attachment can't also break the reply path.
 */
export function logHivemindAttachWarning(
  agentName: string,
  warning: string,
  opts?: { baseDir?: string; now?: Date },
): void {
  try {
    const base = opts?.baseDir ?? process.cwd();
    const now = opts?.now ?? new Date();
    // Local date, not UTC — matches whatever filename the agent would use
    // for its own daily memory entries in the same wall-clock session.
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const today = `${y}-${m}-${d}`;
    const memoryDir = join(base, "agents", agentName, "memory");
    const memoryFile = join(memoryDir, `${today}.md`);

    mkdirSync(memoryDir, { recursive: true });
    const needHeader = !existsSync(memoryFile);
    const line = needHeader
      ? `# ${today} — ${agentName}\n\n- [hivemind attach warning] ${warning}\n`
      : `- [hivemind attach warning] ${warning}\n`;
    appendFileSync(memoryFile, line);
  } catch (err) {
    console.error(`[hivemind attach] Failed to log warning to daily memory:`, err);
  }
}
