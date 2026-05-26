/**
 * bot-boot.ts
 * Boot beacon writer. Called from bot.ts after the Discord client is
 * ready, if the agent's config has announce_on_boot: true.
 *
 * Writes one JSONL line to agents/<name>/state/boot.jsonl:
 *   {"ts":"<ISO>","version":"<X.Y.Z>","pid":<pid>}
 *
 * The runner daemon watches this file and enqueues a boot-announce wake
 * when it discovers a new entry.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

const MAX_LINES = 1000;
const TRUNCATE_TO = 100;

/**
 * Write a boot beacon entry if announce_on_boot is true.
 * Appends one JSONL line. Caps the file at MAX_LINES (truncates to
 * TRUNCATE_TO most recent lines if exceeded).
 */
export function writeBootBeacon(
  baseDir: string,
  agentName: string,
  version: string,
  pid: number,
): void {
  const stateDir = join(baseDir, "agents", agentName, "state");
  mkdirSync(stateDir, { recursive: true });

  const beaconPath = join(stateDir, "boot.jsonl");

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    version,
    pid,
  });

  appendFileSync(beaconPath, entry + "\n");

  // Cap file size — truncate to last TRUNCATE_TO lines if over MAX_LINES.
  try {
    const content = readFileSync(beaconPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length > MAX_LINES) {
      const kept = lines.slice(-TRUNCATE_TO);
      writeFileSync(beaconPath, kept.join("\n") + "\n");
      console.log(
        `[boot-beacon] Truncated ${beaconPath}: ${lines.length} → ${kept.length} lines`,
      );
    }
  } catch {
    // Best-effort truncation — don't crash on failure.
  }
}
