/**
 * cron.ts
 * Manage scheduled jobs using node-cron.
 * Jobs persist to disk so they survive restarts.
 *
 * Two job types:
 *   - "shell": runs a command via execSync (legacy)
 *   - "agent": sends a prompt through the agent's AI session and posts results to Discord
 *
 * v1.4.5: per-agent cron ownership. Each job has an `agent` field; each
 * process only fires jobs whose `agent` matches HIVE_AGENT_NAME.
 */

import cron from "node-cron";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, watch } from "fs";
import { join } from "path";

export interface CronJob {
  id: string;
  agent: string;       // which agent owns this cron — required, non-empty
  schedule: string;
  description: string;
  command: string; // Shell command (type=shell) or agent prompt (type=agent)
  type: "shell" | "agent";
  createdAt: string;
  enabled: boolean;
}

/**
 * Mode hint for the agent executor callback.
 *
 *   - `cron` (default): scheduled-task path. The bot's executor posts the
 *     agent's text reply to its own user-facing channel so the owner sees
 *     scheduled work happening. Cron fires this.
 *   - `wake`: autonomy-v1 task-completion wake path. Silent by default —
 *     the bot does NOT auto-post the reply to the channel. The agent
 *     decides what to surface (via SendMessage to another agent, or by
 *     posting to its own channel deliberately). Used by the runner via
 *     the per-agent wake queue.
 */
export type AgentExecutorMode = "cron" | "wake";

export interface AgentExecutorOptions {
  /** Defaults to "cron" for backward compatibility. */
  mode?: AgentExecutorMode;
}

/**
 * Callback type for agent execution.
 * Takes a prompt, runs it through the agent's session, sends results
 * (or doesn't, in wake mode) and returns the agent's text response.
 */
export type AgentExecutor = (
  prompt: string,
  opts?: AgentExecutorOptions,
) => Promise<string>;

const CRON_FILE = "./data/cron-jobs.json";
const CRON_LOG_DIR = "./data/cron-logs";
export const activeTasks = new Map<string, cron.ScheduledTask>();
let agentExecutor: AgentExecutor | undefined;

function ensureDirs(): void {
  if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
  if (!existsSync(CRON_LOG_DIR)) mkdirSync(CRON_LOG_DIR, { recursive: true });
}

export function loadJobs(): CronJob[] {
  ensureDirs();
  if (!existsSync(CRON_FILE)) return [];
  const jobs = JSON.parse(readFileSync(CRON_FILE, "utf-8")) as CronJob[];
  // Backfill type for legacy jobs that predate the type field
  for (const job of jobs) {
    if (!job.type) job.type = "shell";
  }
  return jobs;
}

function saveJobs(jobs: CronJob[]): void {
  ensureDirs();
  writeFileSync(CRON_FILE, JSON.stringify(jobs, null, 2));
}

/**
 * Registers the agent executor callback.
 * Called by bot.ts after the Discord client is ready.
 * This is what allows "agent" type cron jobs to trigger AI work.
 */
export function setAgentExecutor(executor: AgentExecutor): void {
  agentExecutor = executor;
  console.log("[cron] Agent executor registered — agent-type jobs will trigger AI work");
}

/**
 * Adds a new cron job. Requires a non-empty agent name.
 */
export function cronAdd(
  agent: string,
  schedule: string,
  command: string,
  description: string,
  type: "shell" | "agent" = "agent"
): CronJob {
  if (!agent || typeof agent !== "string" || agent.trim() === "") {
    throw new Error("cronAdd requires a non-empty agent name");
  }

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  const job: CronJob = {
    id: `cron-${Date.now()}`,
    agent,
    schedule,
    description,
    command,
    type,
    createdAt: new Date().toISOString(),
    enabled: true,
  };

  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);

  // Start the task
  startJob(job);

  return job;
}

/**
 * Lists all cron jobs.
 */
export function cronList(): CronJob[] {
  return loadJobs();
}

/**
 * Lists cron jobs for a specific agent.
 */
export function cronListForAgent(agent: string): CronJob[] {
  return loadJobs().filter(j => j.agent === agent);
}

/**
 * Removes a cron job by ID.
 * Always tries to stop the active in-memory task, even if the registry
 * entry was already removed by another process.
 */
export function cronRemove(id: string): boolean {
  const jobs = loadJobs();
  const filtered = jobs.filter((j) => j.id !== id);
  const wasInRegistry = filtered.length !== jobs.length;

  if (wasInRegistry) saveJobs(filtered);

  // ALWAYS try to stop the active task, regardless of whether the entry
  // was still in the registry. Fixes the case where another process
  // already removed it from JSON but our in-memory schedule kept firing.
  const task = activeTasks.get(id);
  let wasActive = false;
  if (task) {
    task.stop();
    activeTasks.delete(id);
    wasActive = true;
  }

  return wasInRegistry || wasActive;
}

/**
 * Starts a cron job's scheduled task.
 */
function startJob(job: CronJob): void {
  if (!job.enabled) return;

  const thisAgent = process.env.HIVE_AGENT_NAME;
  if (!thisAgent) return;  // safety net (init should refuse first)
  if (job.agent !== thisAgent) return;  // not mine

  const task = cron.schedule(job.schedule, async () => {
    const timestamp = new Date().toISOString();
    const logFile = join(CRON_LOG_DIR, `${job.id}.log`);

    console.log(`[cron] Firing job ${job.id} (${job.type}): ${job.description}`);

    try {
      let output: string;

      if (job.type === "agent") {
        if (!agentExecutor) {
          throw new Error("Agent executor not registered — cannot run agent-type cron jobs");
        }
        output = await agentExecutor(job.command);
      } else {
        const { execSync } = await import("child_process");
        output = execSync(job.command, {
          timeout: 60_000,
          encoding: "utf-8",
        });
      }

      const logEntry = `[${timestamp}] OK: ${(output || "").trim()}\n`;
      appendFileSync(logFile, logEntry);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const logEntry = `[${timestamp}] ERROR: ${errMsg}\n`;
      appendFileSync(logFile, logEntry);
      console.error(`[cron] Job ${job.id} failed: ${errMsg}`);
    }
  });

  activeTasks.set(job.id, task);
}

// ── File watcher with debounce + error guards (Phase 4) ──────

let reconcileTimer: NodeJS.Timeout | null = null;
let watcher: ReturnType<typeof watch> | null = null;

function debouncedReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    try {
      reconcileActiveTasks();
    } catch (e) {
      console.error("[cron] reconcile failed; will retry on next event:", e);
    }
  }, 250);
}

export function setupWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (existsSync(CRON_FILE)) {
    watcher = watch(CRON_FILE, { persistent: false }, debouncedReconcile);
  }
}

export function reconcileActiveTasks(): void {
  const thisAgent = process.env.HIVE_AGENT_NAME;
  if (!thisAgent) return;

  let jobs: CronJob[];
  try {
    jobs = loadJobs();
  } catch (e) {
    console.warn("[cron] reconcile read failed; skipping this cycle:", e);
    return;
  }

  const currentJobs = jobs.filter(j => j.agent === thisAgent && j.enabled);
  const currentIds = new Set(currentJobs.map(j => j.id));

  // Stop tasks no longer in registry
  for (const [id, task] of activeTasks.entries()) {
    if (!currentIds.has(id)) {
      task.stop();
      activeTasks.delete(id);
      console.log(`[cron] reconcile: stopped stale task ${id}`);
    }
  }

  // Start new tasks (idempotent — startJob no-ops if already in activeTasks)
  for (const job of currentJobs) {
    if (!activeTasks.has(job.id)) {
      startJob(job);
      console.log(`[cron] reconcile: started new task ${job.id}`);
    }
  }
}

/**
 * Initializes all saved cron jobs on startup.
 * Only starts jobs owned by the current agent (HIVE_AGENT_NAME).
 */
export function initCronJobs(): void {
  const thisAgent = process.env.HIVE_AGENT_NAME;
  if (!thisAgent) {
    console.warn("[cron] HIVE_AGENT_NAME env var not set — refusing to start any cron jobs in this process.");
    return;
  }

  const jobs = loadJobs();
  const ownJobs = jobs.filter(j => j.agent === thisAgent && j.enabled);

  // Detect legacy entries that lack `agent` field — log + refuse to fire
  const legacy = jobs.filter(j => !j.agent || j.agent.trim() === "");
  if (legacy.length > 0) {
    console.warn(`[cron] ${legacy.length} legacy job(s) without 'agent' field detected. They will NOT fire. Re-create via CronCreate.`);
    for (const j of legacy) console.warn(`  - id=${j.id} schedule=${j.schedule} desc=${j.description}`);
  }

  for (const job of ownJobs) startJob(job);
  console.log(`[cron] ${thisAgent}: scheduled ${ownJobs.length} of ${jobs.length} total jobs in registry.`);

  // Start file watcher for cross-process reconciliation
  setupWatcher();
}

// ── Test helpers ─────────────────────────────────────────────

export function _resetCronForTesting(): void {
  for (const [id, task] of activeTasks.entries()) {
    task.stop();
    activeTasks.delete(id);
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
}
