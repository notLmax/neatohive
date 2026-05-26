#!/usr/bin/env node
/**
 * scripts/agent-watcher.mjs
 *
 * Diagnostic watcher for ~/neato-hive/agents/ — logs every create, change,
 * and delete event under the agents/ tree to data/agent-watcher.log so we
 * can catch whatever has been wiping agent .md files.
 *
 * Run via: pm2 start scripts/agent-watcher.mjs --name agent-watcher
 *
 * Each event is one JSON line:
 *   {"ts":"2026-05-08T17:30:00.000Z","event":"delete","path":"glados/AGENTS.md","pid":<watcher-pid>,"loadavg":[0.5,0.3,0.2]}
 *
 * Notes:
 * - Node's fs.watch on macOS uses FSEvents under the hood; "rename" fires
 *   on both create AND delete. We stat the path to disambiguate.
 * - We also snapshot loadavg + a list of `claude` / `codex` / `node` processes
 *   currently running, since the kernel doesn't tell us *who* triggered the
 *   event. Time-correlation against PM2 logs / runner-events is the path to
 *   the culprit.
 */

import { watch, statSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const AGENTS_DIR = "/Users/glados/neato-hive/agents";
const LOG_DIR = "/Users/glados/neato-hive/data";
const LOG_PATH = path.join(LOG_DIR, "agent-watcher.log");

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function snapshotProcesses() {
  try {
    const out = execSync(
      "ps -eo pid,ppid,comm,args | grep -E '(claude|codex|node|rsync|cp|rm|mv)' | grep -v grep | head -20",
      { encoding: "utf8", timeout: 1000 }
    );
    return out.trim().split("\n").slice(0, 10);
  } catch {
    return [];
  }
}

function logEvent(record) {
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
}

function classify(filename) {
  const full = path.join(AGENTS_DIR, filename);
  if (!existsSync(full)) return "delete";
  try {
    const s = statSync(full);
    return s.isDirectory() ? "dir-touch" : "create-or-modify";
  } catch {
    return "stat-failed";
  }
}

console.log(`[agent-watcher] watching ${AGENTS_DIR}`);
console.log(`[agent-watcher] log file: ${LOG_PATH}`);
console.log(`[agent-watcher] pid: ${process.pid}`);

logEvent({
  ts: new Date().toISOString(),
  event: "watcher-start",
  pid: process.pid,
  cwd: process.cwd(),
});

const watcher = watch(AGENTS_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return;

  // Filter out high-frequency noise: session.json, crash-detect.json,
  // .DS_Store, runtime.json — these change constantly during normal ops.
  const base = path.basename(filename);
  if (
    base === "session.json" ||
    base === "crash-detect.json" ||
    base === ".DS_Store" ||
    base === "runtime.json"
  ) {
    return;
  }

  const event = eventType === "rename" ? classify(filename) : "modify";
  const record = {
    ts: new Date().toISOString(),
    event,
    path: filename,
    raw_event: eventType,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    procs: snapshotProcesses(),
  };

  logEvent(record);

  if (event === "delete") {
    console.log(`[DELETE] ${filename}`);
  }
});

process.on("SIGTERM", () => {
  watcher.close();
  logEvent({ ts: new Date().toISOString(), event: "watcher-stop", reason: "SIGTERM" });
  process.exit(0);
});

process.on("SIGINT", () => {
  watcher.close();
  logEvent({ ts: new Date().toISOString(), event: "watcher-stop", reason: "SIGINT" });
  process.exit(0);
});
