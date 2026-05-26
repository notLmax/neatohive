/**
 * boot-watcher.ts
 * Pure functions for reading boot beacon files (agents/<name>/state/boot.jsonl).
 * Stateless — last-seen tracking is managed by the caller (runner).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BootEntry {
  ts: string;     // ISO 8601
  version: string;
  pid: number;
}

/**
 * Canonical path for an agent's boot beacon file.
 */
export function bootBeaconPath(baseDir: string, agent: string): string {
  return join(baseDir, "agents", agent, "state", "boot.jsonl");
}

/**
 * Parse a boot beacon JSONL file. Returns all valid entries; malformed
 * lines are silently skipped.
 */
export function readBootBeacon(path: string): BootEntry[] {
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const entries: BootEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed.ts === "string" &&
        typeof parsed.version === "string" &&
        typeof parsed.pid === "number"
      ) {
        entries.push({ ts: parsed.ts, version: parsed.version, pid: parsed.pid });
      }
      // else: malformed — skip silently
    } catch {
      // malformed JSON — skip silently
    }
  }
  return entries;
}

/**
 * Filter boot entries to only those newer than `lastSeenTs` (ISO 8601).
 * Comparison is lexicographic on ISO strings (correct for UTC timestamps).
 */
export function findNewEntries(entries: BootEntry[], lastSeenTs: string): BootEntry[] {
  return entries.filter((e) => e.ts > lastSeenTs);
}
