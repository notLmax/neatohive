/**
 * messaging.ts
 * Send messages to Discord channels programmatically.
 *
 * Inter-agent messages route through #hivemind with a wire format that
 * carries an explicit context tag and a task id:
 *
 *     **[from → to]** `kind:task-id`
 *     <body>
 *
 * The `kind` is one of:
 *   - delegation — sender is asking receiver to do work.
 *   - response   — sender is replying to a prior delegation. Must reference
 *                  an in-flight delegation via task id.
 *   - escalation — sender is bouncing the task up (used internally by
 *                  EscalateToOwner) so the original delegator knows the
 *                  executor is paused on owner input.
 *   - query      — sender is asking a quick question, no work expected.
 *
 * The marker line is optional. Messages without one are treated as legacy
 * `delegation` with no task id — the old timing-window heuristic is gone, so
 * these never match a registered delegation and never absorb as responses.
 */

import { Client, TextChannel } from "discord.js";
import {
  extractAttachments,
  resolveAttachments,
  logHivemindAttachWarning,
} from "../discord/attachments.js";
import { mkdirSync, writeFileSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

let discordClient: Client | null = null;
const HIVEMIND_CHANNEL = "hivemind";

// ── Auto-offload large messages ───────────────────────────────
//
// Discord rejects messages over 4000 chars. Earlier versions of this code
// relied on `splitMessage` chunking, which works for owner-facing channels
// but is broken for hivemind: only the first chunk has the `**[from → to]**`
// header, so chunks 2+ silently fail the receiver's pattern match and are
// dropped. Instead, when a hivemind body exceeds the threshold we write the
// full content to `shared/exchange/<sender>-<receiver>-<slug>-<YYYYMMDD>.md`
// and replace the body with a short stub plus an [ATTACH:] marker. The
// receiver's bot resolves the marker and posts the file alongside the
// (now-short) text — single Discord message, full content delivered.

/** Char threshold that triggers auto-offload. Matches the 1900-char
 *  chunking boundary used elsewhere for owner-facing channels — keeps a
 *  single consistent size rule across the codebase. Anything larger turns
 *  into a `shared/exchange/` markdown file plus an imperative stub that
 *  tells the receiving agent to read the file before responding. */
export const HIVEMIND_OFFLOAD_THRESHOLD = 1900;

/** Where offloaded files go. Resolved relative to process.cwd() unless
 *  overridden in test injection. */
export const SHARED_EXCHANGE_DIR_NAME = "shared/exchange";

export interface OffloadOptions {
  /** Override base dir (defaults to process.cwd()). Used in tests. */
  baseDir?: string;
  /** Override clock for deterministic filenames in tests. */
  now?: Date;
  /** Override fs writers for tests. */
  fsWrite?: (path: string, content: string) => void;
  fsMkdir?: (path: string) => void;
  fsExists?: (path: string) => boolean;
}

/**
 * Derive a kebab-case slug from the first non-empty line of a message.
 * Caps at ~40 chars so filenames stay readable.
 */
export function deriveSlug(message: string): string {
  const firstLine = message
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "message";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "message";
}

/**
 * Format `YYYYMMDD` from a Date — sender-local, matching the rest of the
 * exchange convention.
 */
function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export interface OffloadResult {
  /** True iff the message was offloaded; otherwise body is unchanged. */
  offloaded: boolean;
  /** The (possibly rewritten) body to send in the Discord message. */
  body: string;
  /** Absolute path of the file written, when offloaded. */
  filePath?: string;
  /** First-line summary used as the stub heading. */
  summary?: string;
}

/**
 * If `body` exceeds the offload threshold, write the full content to
 * `shared/exchange/<from>-<to>-<slug>-<YYYYMMDD>.md` and return a short
 * stub (first ~200 chars + an [ATTACH:] marker). Otherwise return the body
 * unchanged. Pure-ish: filesystem writes are injectable for tests.
 */
export function maybeOffloadLargeMessage(
  from: string,
  to: string,
  body: string,
  opts: OffloadOptions = {},
): OffloadResult {
  if (body.length <= HIVEMIND_OFFLOAD_THRESHOLD) {
    return { offloaded: false, body };
  }

  const baseDir = opts.baseDir ?? process.cwd();
  const now = opts.now ?? new Date();
  const fsWrite = opts.fsWrite ?? ((p: string, c: string) => writeFileSync(p, c));
  const fsMkdir = opts.fsMkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const fsExists = opts.fsExists ?? ((p: string) => existsSync(p));

  const slug = deriveSlug(body);
  const ymd = formatYmd(now);
  const exchangeDir = join(baseDir, SHARED_EXCHANGE_DIR_NAME);
  fsMkdir(exchangeDir);

  // Disambiguate same-day repeats with a counter.
  let candidate = join(exchangeDir, `${from}-${to}-${slug}-${ymd}.md`);
  let counter = 2;
  while (fsExists(candidate)) {
    candidate = join(exchangeDir, `${from}-${to}-${slug}-${ymd}-${counter}.md`);
    counter++;
  }

  // Build the file: a YAML-ish header for searchability + the raw body.
  const header =
    `<!-- auto-offloaded by SendMessage — body exceeded ${HIVEMIND_OFFLOAD_THRESHOLD} chars -->\n` +
    `# ${from} → ${to} (${ymd})\n\n`;
  fsWrite(candidate, header + body);

  // Stub: first non-blank line as summary, then explicit imperative
  // instructions for the receiving agent. The agent (Claude under the hood)
  // sees this prompt and must decide to call its Read tool on the path —
  // wording is deliberately direct so the action is unambiguous.
  const summary = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
    ?.slice(0, 200) ?? "(see attached)";
  const stub =
    `📎 **Long message — full content is in the attached file. You MUST read it before responding.**\n\n` +
    `**Summary:** ${summary}\n\n` +
    `**Action required:** Use the \`Read\` tool on this exact absolute path to load the full message into your context:\n` +
    `\`${candidate}\`\n\n` +
    `Do not respond based only on this stub. The substantive content lives in the file. After reading it, reply normally — your text reply will be auto-routed back to the sender via #hivemind.\n\n` +
    `_(Auto-offloaded by SendMessage: the body was ${body.length} chars, exceeding the ${HIVEMIND_OFFLOAD_THRESHOLD}-char hivemind limit. Discord's transport drops continuation chunks for inter-agent messages, so anything over the limit goes via shared/exchange instead.)_\n` +
    `[ATTACH:${candidate}]`;

  return { offloaded: true, body: stub, filePath: candidate, summary };
}

// ── Message kinds ─────────────────────────────────────────────

export type MessageKind = "delegation" | "response" | "escalation" | "query";

export const MESSAGE_KINDS: ReadonlyArray<MessageKind> = [
  "delegation",
  "response",
  "escalation",
  "query",
];

// ── Delegation registry ───────────────────────────────────────
//
// In-memory record of in-flight delegations and queries. A `response` must
// reference one of these by task id; otherwise it is surfaced as a stale-task
// error rather than silently dropped.
//
// Stale entries are pruned lazily on every read with a 24-hour TTL — long
// enough to outlast a 90-minute codex job plus the wake-and-respond turn,
// short enough that the map can't grow unbounded in a long-running process.

export interface DelegationRecord {
  taskId: string;
  from: string;            // delegator (the agent that sent the request)
  to: string;              // executor  (the agent expected to respond)
  kind: "delegation" | "query";
  startedAt: number;
}

export const DELEGATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Persistence (autonomy-v1, finding a) ─────────────────────
//
// The delegation registry must survive `pm2 restart`. Without persistence,
// a delegating agent that restarts mid-task will route the eventual response
// as "stale" — which is exactly what we watched happen to house-md when his
// session was wiped earlier today.
//
// Storage: per-agent JSONL at `agents/<name>/state/delegations.jsonl`.
// Format: one line per registry event:
//   {"event":"register","taskId":"t-...","from":"A","to":"B","kind":"delegation","startedAt":1234567890}
//   {"event":"complete","taskId":"t-..."}
// Replay: read in order, register adds, complete removes. Expired entries
// (> TTL) dropped. Fail-soft on any I/O error — registry still works in
// memory even if disk persistence breaks.

let registryStateFile: string | undefined;

/**
 * Configure where the registry persists. Called once by bot.ts at startup
 * with the per-agent path. If left unset, the registry is in-memory only
 * (legacy behavior — used by tests).
 */
export function setRegistryStateFile(path: string | undefined): void {
  registryStateFile = path && path.length > 0 ? path : undefined;
}

export function getRegistryStateFile(): string | undefined {
  return registryStateFile;
}

function persistRegistryEvent(event: Record<string, unknown>): void {
  if (!registryStateFile) return;
  // Single-writer per agent, enforced by the PM2 ecosystem config (one
  // bot process per agent). Concurrent appends to this JSONL are not
  // synchronized — if we ever consider multi-process per agent, this
  // needs a real append lock (e.g., proper-lockfile or O_APPEND fd flush).
  try {
    const dir = join(registryStateFile, "..");
    mkdirSync(dir, { recursive: true });
    appendFileSync(registryStateFile, JSON.stringify(event) + "\n");
  } catch (err) {
    // Fail-soft. Don't crash the agent because state persistence broke.
    console.error(
      `[delegation-registry] persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Replay the persisted registry into memory. Called once at boot. Filters
 * out expired entries (> 24h) and entries that have a matching `complete`
 * event. Idempotent — calling more than once just rebuilds from disk.
 */
export function loadRegistryFromDisk(): { loaded: number; expired: number } {
  delegationRegistry.clear();
  if (!registryStateFile || !existsSync(registryStateFile)) {
    return { loaded: 0, expired: 0 };
  }

  const now = clock();
  const cutoff = now - DELEGATION_TTL_MS;
  let raw: string;
  try {
    raw = readFileSync(registryStateFile, "utf-8");
  } catch (err) {
    console.error(
      `[delegation-registry] read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { loaded: 0, expired: 0 };
  }

  let expired = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines, don't poison the whole load
    }
    if (entry.event === "register") {
      const startedAt = Number(entry.startedAt);
      if (!Number.isFinite(startedAt) || startedAt < cutoff) {
        expired++;
        continue;
      }
      const taskId = String(entry.taskId);
      const kind = entry.kind === "query" ? "query" : "delegation";
      delegationRegistry.set(taskId, {
        taskId,
        from: String(entry.from),
        to: String(entry.to),
        kind,
        startedAt,
      });
    } else if (entry.event === "complete") {
      delegationRegistry.delete(String(entry.taskId));
    }
  }
  return { loaded: delegationRegistry.size, expired };
}

/**
 * Test seam — clock injection for deterministic stale-task tests.
 */
let clock: () => number = () => Date.now();
export function _setClockForTesting(fn: () => number): void {
  clock = fn;
}
export function _resetClockForTesting(): void {
  clock = () => Date.now();
}

export const delegationRegistry = new Map<string, DelegationRecord>();

let taskIdCounter = 0;
export function newTaskId(): string {
  taskIdCounter = (taskIdCounter + 1) % 1_000_000;
  // 9-char base36 timestamp + 6-digit counter — collision-free within a
  // process, short enough to read in Discord, sortable by time.
  return `t-${clock().toString(36)}${taskIdCounter.toString(36).padStart(4, "0")}`;
}

function pruneStaleDelegations(): void {
  const now = clock();
  for (const [taskId, rec] of delegationRegistry) {
    if (now - rec.startedAt > DELEGATION_TTL_MS) {
      delegationRegistry.delete(taskId);
    }
  }
}

export function registerDelegation(
  from: string,
  to: string,
  kind: "delegation" | "query",
): DelegationRecord {
  pruneStaleDelegations();
  const rec: DelegationRecord = {
    taskId: newTaskId(),
    from,
    to,
    kind,
    startedAt: clock(),
  };
  delegationRegistry.set(rec.taskId, rec);
  persistRegistryEvent({
    event: "register",
    taskId: rec.taskId,
    from,
    to,
    kind,
    startedAt: rec.startedAt,
  });
  return rec;
}

export function lookupDelegation(taskId: string): DelegationRecord | undefined {
  pruneStaleDelegations();
  return delegationRegistry.get(taskId);
}

/**
 * Find the most recent in-flight delegation TO `executor`. Used by
 * EscalateToOwner so the executor can identify which delegation it is
 * blocked on without the caller having to thread the task id through.
 */
export function findActiveDelegationFor(
  executor: string,
): DelegationRecord | undefined {
  pruneStaleDelegations();
  let best: DelegationRecord | undefined;
  for (const rec of delegationRegistry.values()) {
    if (rec.to !== executor) continue;
    if (!best || rec.startedAt > best.startedAt) best = rec;
  }
  return best;
}

export function completeDelegation(taskId: string): void {
  delegationRegistry.delete(taskId);
  persistRegistryEvent({ event: "complete", taskId });
}

/**
 * Test-only helper to wipe the registry between tests.
 */
export function _resetRegistryForTesting(): void {
  delegationRegistry.clear();
  taskIdCounter = 0;
}

// ── Wire format ───────────────────────────────────────────────

const HIVEMIND_HEADER_PATTERN =
  /^\*\*\[(\S+)\s*→\s*(\S+)\]\*\*(?:\s+`([a-z]+):([^`]+)`)?\n?([\s\S]*)$/;

export interface ParsedHivemindMessage {
  fromAgent: string;
  toAgent: string;
  kind: MessageKind | "legacy";
  taskId?: string;
  body: string;
}

/**
 * Parse the hivemind wire format. Returns `null` if the message doesn't
 * match the inter-agent header pattern at all (e.g. unrelated bot messages).
 *
 * Messages without a `kind:taskId` marker are returned as `kind: "legacy"`
 * so the caller can decide how to treat them. New code emits the marker on
 * every outgoing message.
 */
export function parseHivemindMessage(
  raw: string,
): ParsedHivemindMessage | null {
  const m = raw.match(HIVEMIND_HEADER_PATTERN);
  if (!m) return null;
  const [, fromAgent, toAgent, kindRaw, taskId, body] = m;
  const kind: MessageKind | "legacy" = kindRaw && isMessageKind(kindRaw)
    ? kindRaw
    : "legacy";
  return {
    fromAgent,
    toAgent,
    kind,
    taskId: taskId || undefined,
    body: body || "",
  };
}

function isMessageKind(s: string): s is MessageKind {
  return (MESSAGE_KINDS as ReadonlyArray<string>).includes(s);
}

/**
 * Decide how the receiving agent's bot should route an inbound hivemind
 * message. Pure function — no Discord side effects. Tested directly.
 *
 * - "request"     — process as a new request (delegation or query).
 *                   Receiver runs runAgent and may reply back to hivemind.
 * - "response"    — absorb into the receiver's session silently (no
 *                   hivemind reply). The receiver is the original delegator
 *                   and just needs to internalize the answer.
 * - "escalation"  — absorb silently. The receiver (delegator) is being
 *                   informed that the executor is blocked on owner input.
 * - "stale"       — response references an unknown / expired task id.
 *                   Surface a stale-task error to #hivemind instead of
 *                   silently dropping.
 * - "ignore"      — message is malformed for routing (e.g. response with no
 *                   taskId, or kind doesn't match registry expectations).
 */
export type InboundRoute =
  | { kind: "request"; messageKind: "delegation" | "query" | "legacy" }
  | { kind: "response"; record: DelegationRecord }
  | { kind: "escalation"; record?: DelegationRecord }
  | { kind: "stale"; reason: string; taskId?: string }
  | { kind: "ignore"; reason: string };

export function routeInbound(
  msg: ParsedHivemindMessage,
  receivingAgent: string,
): InboundRoute {
  if (msg.toAgent !== receivingAgent) {
    return { kind: "ignore", reason: "not addressed to this agent" };
  }

  switch (msg.kind) {
    case "delegation":
    case "query":
    case "legacy":
      return { kind: "request", messageKind: msg.kind };

    case "response": {
      if (!msg.taskId) {
        return { kind: "stale", reason: "response without taskId" };
      }
      const rec = lookupDelegation(msg.taskId);
      if (!rec) {
        return {
          kind: "stale",
          reason: "no in-flight delegation for taskId",
          taskId: msg.taskId,
        };
      }
      // The response must come FROM the executor and be addressed TO the
      // original delegator. If those don't line up the registry entry is
      // for a different conversation and we treat it as stale.
      if (rec.from !== msg.toAgent || rec.to !== msg.fromAgent) {
        return {
          kind: "stale",
          reason: "response endpoints do not match registered delegation",
          taskId: msg.taskId,
        };
      }
      return { kind: "response", record: rec };
    }

    case "escalation": {
      // Best effort — we'll absorb even if the registry has already aged
      // out, since the delegator still needs to know its executor is stuck.
      const rec = msg.taskId ? lookupDelegation(msg.taskId) : undefined;
      return { kind: "escalation", record: rec };
    }
  }
}

// ── Discord client registration ───────────────────────────────

/**
 * Tracks each agent's primary user-facing channel name (the first non-
 * hivemind channel from config). EscalateToOwner uses this to find the
 * channel where the agent talks to the owner.
 */
const primaryChannels = new Map<string, string>();

export function registerPrimaryChannel(agentName: string, channelName: string): void {
  primaryChannels.set(agentName, channelName);
}

export function getPrimaryChannel(agentName: string): string | undefined {
  return primaryChannels.get(agentName);
}

// ── Inbound queue ───────────────────────────────────────────
//
// Per-agent FIFO inbound queue. Replaces the global boolean lock that
// raced under concurrent inbound load (Bug #1, fixed in v1.4.6).
//
// Each agent runs in its own PM2 process, so module-scope = per-agent.
// Inbounds enqueue immediately; a single async worker drains the queue
// one inbound at a time. The kind-aware block guard at SendMessage
// checks whether the worker is currently processing (any kind).
//
// Edge cases:
//   - Inbound arrives during boot: process() callbacks live inside the
//     messageCreate handler closure, which is initialized by the time
//     the event fires — safe.
//   - Process exit while queue is non-empty: queued inbounds are lost.
//     Acceptable for v1.4.6 (in-memory queue). Durable queue is a
//     v1.5.x candidate if observed as a real failure mode.

export type HivemindInboundKind = "request" | "response" | "escalation";

export interface QueuedInbound {
  /** Stable id for diagnostics (timestamp + counter is fine). */
  id: string;
  kind: HivemindInboundKind;
  fromAgent: string;
  taskId: string | undefined;
  /** Function the bot supplies — the worker invokes this to actually run runAgent + post results. */
  process: () => Promise<void>;
  /** Diagnostic-only — when this inbound was received. */
  enqueuedAt: number;
}

const inboundQueue: QueuedInbound[] = [];
let processing: { kind: HivemindInboundKind; startedAt: number } | null = null;
let drainInFlight = false;

/** Enqueue an inbound and kick the drain loop if idle. */
export function enqueueInbound(item: QueuedInbound): void {
  inboundQueue.push(item);
  console.log(
    `[hivemind:queue] enqueued id=${item.id} kind=${item.kind} from=${item.fromAgent} (depth=${inboundQueue.length})`,
  );
  if (inboundQueue.length === HIVEMIND_QUEUE_BACKPRESSURE_THRESHOLD) {
    console.warn(
      `[hivemind:queue] backpressure: depth crossed ${HIVEMIND_QUEUE_BACKPRESSURE_THRESHOLD}. Producer may be outpacing consumer.`,
    );
  }
  void drainQueue();
}

const HIVEMIND_QUEUE_BACKPRESSURE_THRESHOLD = 10;

async function drainQueue(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    while (inboundQueue.length > 0) {
      const next = inboundQueue.shift()!;
      processing = { kind: next.kind, startedAt: Date.now() };
      try {
        await next.process();
      } catch (err) {
        console.error(
          `[hivemind:queue] processor threw on id=${next.id}:`,
          err,
        );
      } finally {
        processing = null;
      }
    }
  } finally {
    drainInFlight = false;
  }
}

/** Replaces the legacy boolean. True iff the worker is currently mid-inbound. */
export function isHivemindProcessing(): boolean {
  return processing !== null;
}

/** Replaces the legacy getHivemindProcessingState(). Same shape for compatibility. */
export function getHivemindProcessingState(): {
  active: boolean;
  kind: "request" | "response" | "escalation" | null;
} {
  return { active: processing !== null, kind: processing?.kind ?? null };
}

/**
 * Diagnostic — exposed for tests + `hive doctor` checks. Reports queue
 * depth and the current processor's kind/age.
 */
export function getInboundQueueStats(): {
  depth: number;
  processing: { kind: HivemindInboundKind; ageMs: number } | null;
} {
  return {
    depth: inboundQueue.length,
    processing: processing
      ? { kind: processing.kind, ageMs: Date.now() - processing.startedAt }
      : null,
  };
}

/** Test-only helper to reset the queue between tests. */
export function _resetInboundQueueForTesting(): void {
  inboundQueue.length = 0;
  processing = null;
  drainInFlight = false;
}

/**
 * Tracks whether `EscalateToOwner` was called during the current hivemind
 * turn. The bot's hivemind handler reads this after `runAgent` returns
 * and SUPPRESSES the auto-reply to #hivemind when the flag is set —
 * because:
 *   - The delegating agent already received a `kind=escalation` notice
 *     via EscalateToOwner's own out-of-band SendMessage.
 *   - That notice is absorbed silently by the receiver (no spin-up).
 *   - If we ALSO posted the agent's text reply as `kind=response`, it
 *     would spin the receiver up just to read "I'm asking the owner",
 *     wasting a runAgent invocation.
 *
 * The escalating agent's turn ends without sending a kind=response.
 * The original delegation stays pending in its registry. When the owner
 * answers in the agent's primary channel, a NEW turn fires, and THAT
 * turn issues the resolved kind=response back to the delegator. One
 * productive spin-up per side, no wasted round-trips.
 */
let escalationFiredInCurrentTurn = false;

export function markEscalationFired(): void {
  escalationFiredInCurrentTurn = true;
}

/**
 * Read-and-clear. The bot calls this immediately after `runAgent` returns
 * for a hivemind request turn. Always returns false outside an in-flight
 * hivemind turn.
 */
export function consumeEscalationFlag(): boolean {
  const v = escalationFiredInCurrentTurn;
  escalationFiredInCurrentTurn = false;
  return v;
}

/** Test seam — reset between tests. */
export function _resetEscalationFlagForTesting(): void {
  escalationFiredInCurrentTurn = false;
}

/**
 * Registers the Discord client for use by the messaging tool.
 * Called once at startup after the bot connects.
 */
export function registerDiscordClient(client: Client): void {
  discordClient = client;
}

// ── Outgoing: hivemind ────────────────────────────────────────

export interface SendToAgentOptions {
  /** Defaults to "delegation". */
  kind?: MessageKind;
  /** Required when kind=response or kind=escalation. */
  taskId?: string;
  /** Optional explicit attachments — appended to any [ATTACH:] markers. */
  attachments?: string[];
}

export interface SendResult {
  success: boolean;
  error?: string;
  /** When kind=delegation or kind=query, the new registry id. */
  taskId?: string;
}

/**
 * Sends a message to another agent via the #hivemind channel.
 * Messages are formatted with the explicit kind/taskId marker.
 */
export async function sendToAgent(
  from: string,
  to: string,
  message: string,
  opts: SendToAgentOptions = {},
): Promise<SendResult> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  const kind: MessageKind = opts.kind ?? "delegation";

  // Validate / resolve the task id.
  let taskId: string | undefined;
  if (kind === "delegation" || kind === "query") {
    const rec = registerDelegation(from, to, kind);
    taskId = rec.taskId;
  } else if (kind === "response") {
    if (!opts.taskId) {
      return {
        success: false,
        error: "response messages require taskId — the original delegation id",
      };
    }
    // v1.3.3: do NOT validate the taskId against the SENDER's local
    // registry. The original delegation lives in the DELEGATOR's
    // registry (the message recipient here), not the responder's
    // (the sender). The receiver's bot validates via routeInbound on
    // arrival — that's where the stale-task surfacing happens. The old
    // sender-side gate broke kind=response entirely because no agent
    // mirrors received delegations into its own registry. Smoke-test
    // surfaced this on 2026-04-29.
    taskId = opts.taskId;
  } else if (kind === "escalation") {
    if (!opts.taskId) {
      return {
        success: false,
        error: "escalation messages require taskId — the original delegation id",
      };
    }
    taskId = opts.taskId;
  }

  const hivemind = discordClient.channels.cache.find(
    (ch) => ch instanceof TextChannel && ch.name === HIVEMIND_CHANNEL,
  ) as TextChannel | undefined;

  if (!hivemind) {
    return {
      success: false,
      error: `#${HIVEMIND_CHANNEL} channel not found. Create it in Discord.`,
    };
  }

  try {
    // Symmetric [ATTACH:/abs/path] handling — agents emit markers in the
    // body and they get resolved to Discord file attachments. The optional
    // explicit attachments list is appended.
    const { cleanText, filePaths: bodyPaths } = extractAttachments(message);

    // Auto-offload oversized bodies to shared/exchange. Runs on the cleaned
    // body (post-[ATTACH:] extraction) so a message that's mostly markers
    // doesn't get over-eagerly offloaded. The offload itself adds a NEW
    // [ATTACH:] marker, which we re-extract below.
    const offload = maybeOffloadLargeMessage(from, to, cleanText);
    const finalText = offload.offloaded ? offload.body : cleanText;
    const finalExtraction = offload.offloaded
      ? extractAttachments(finalText)
      : { cleanText: finalText, filePaths: [] as string[] };

    const allPaths = [
      ...bodyPaths,
      ...finalExtraction.filePaths,
      ...(opts.attachments ?? []),
    ];
    const { builders, warnings } = resolveAttachments(allPaths);
    for (const w of warnings) {
      console.warn(`[hivemind attach] ${w}`);
      logHivemindAttachWarning(from, w);
    }

    const body =
      finalExtraction.cleanText.trim() ||
      (builders.length > 0 ? "" : message);
    const header = formatHeader(from, to, kind, taskId);
    const formatted = body ? `${header}\n${body}` : header;

    if (builders.length > 0) {
      await hivemind.send({ content: formatted, files: builders });
    } else {
      await hivemind.send(formatted);
    }
    return { success: true, taskId };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

/**
 * Formats the wire header. Exported so the bot can build response/escalation
 * headers with the same logic when it sends from inside the message handler.
 */
export function formatHeader(
  from: string,
  to: string,
  kind: MessageKind,
  taskId?: string,
): string {
  const arrow = `**[${from} → ${to}]**`;
  if (!taskId) return arrow;
  return `${arrow} \`${kind}:${taskId}\``;
}

// ── EscalateToOwner orchestration ─────────────────────────────

export interface EscalateToOwnerArgs {
  executor: string;       // agent doing the work (the caller)
  delegatedBy: string;    // agent that originally delegated
  question: string;
  context: string;
}

export interface EscalateResult {
  success: boolean;
  error?: string;
  taskId?: string;
  primaryChannel?: string;
}

/**
 * Two-step orchestration:
 *   1. Post a 🆘 prefixed question into the executor's primary channel so
 *      the owner sees it.
 *   2. Send a `kind=escalation` hivemind message to the delegator so it
 *      knows the executor is paused pending owner input.
 *
 * If no in-flight delegation can be found we still post to the owner — the
 * agent may legitimately be escalating something it picked up via another
 * path — but skip the hivemind notification (no one to notify).
 */
export async function escalateToOwner(
  args: EscalateToOwnerArgs,
): Promise<EscalateResult> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  const primary = getPrimaryChannel(args.executor);
  if (!primary) {
    return {
      success: false,
      error: `no primary channel registered for ${args.executor}`,
    };
  }

  const channel = discordClient.channels.cache.find(
    (ch) => ch instanceof TextChannel && ch.name === primary,
  ) as TextChannel | undefined;
  if (!channel) {
    return {
      success: false,
      error: `primary channel #${primary} not found`,
    };
  }

  const banner = `🆘 **[${args.executor}, blocked on task from ${args.delegatedBy}]**`;
  const content = [
    banner,
    `**Question:** ${args.question}`,
    `**Context:** ${args.context}`,
  ].join("\n");

  try {
    await channel.send(content);
  } catch (err) {
    return {
      success: false,
      error: `failed to post to #${primary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Notify the delegator via hivemind (if there's an active delegation).
  // We do this BEFORE marking the escalation flag so that on hivemind-send
  // failure we leave the flag clear — the bot's auto-reply then fires and
  // at least surfaces the agent's text reply to the delegator, instead of
  // silently swallowing it after a partial-success escalation.
  const active = findActiveDelegationFor(args.executor);
  let taskId: string | undefined;
  if (active && active.from === args.delegatedBy) {
    taskId = active.taskId;
    const notice = `⏸ Paused on task ${active.taskId} — escalated to owner.\n**Q:** ${args.question}\n**Why:** ${args.context}`;
    const sendResult = await sendToAgent(
      args.executor,
      args.delegatedBy,
      notice,
      { kind: "escalation", taskId: active.taskId },
    );
    if (!sendResult.success) {
      // Owner saw the question, but the delegator did not get the
      // silent-absorb notice. Don't suppress the auto-reply — let the
      // agent's text reply through so the delegator at least learns
      // something happened. Flag stays clear.
      return {
        success: false,
        error: `posted to owner channel but hivemind notice failed: ${sendResult.error}`,
        primaryChannel: primary,
      };
    }
  }

  // Both sides notified (or no delegator to notify). Set the flag so the
  // bot's hivemind handler suppresses the auto-reply. The delegator gets
  // exactly ONE message — the silent-absorb escalation notice above —
  // instead of TWO (escalation + spin-up text).
  markEscalationFired();

  return { success: true, taskId, primaryChannel: primary };
}

// ── Hivemind receipt log (Phase 5 — observability) ───────────

function dataDir(): string {
  const d = join(process.cwd(), "data");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const RECEIPT_FILE_NAME = "hivemind-receipts.log";

export function writeHivemindReceipt(receipt: {
  fromAgent: string;
  toAgent: string;
  taskId: string;
  kind: "request" | "response" | "escalation";
  sessionUpdated: boolean;
}): void {
  const filePath = join(dataDir(), RECEIPT_FILE_NAME);
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...receipt }) + "\n";
  try {
    appendFileSync(filePath, line);
  } catch (e) {
    console.warn("[hivemind:receipt] write failed:", e);
  }
}

// ── Outgoing: arbitrary channel ───────────────────────────────

/**
 * Sends a message to a Discord channel by name.
 * Used for direct channel posting (non-hivemind).
 */
export async function sendToChannel(
  channelName: string,
  message: string,
): Promise<{ success: boolean; error?: string }> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  const channel = discordClient.channels.cache.find(
    (ch) => ch instanceof TextChannel && ch.name === channelName,
  ) as TextChannel | undefined;

  if (!channel) {
    return { success: false, error: `Channel "${channelName}" not found` };
  }

  try {
    await channel.send(message);
    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

/**
 * Sends a message to a Discord channel by ID.
 */
export async function sendToChannelById(
  channelId: string,
  message: string,
): Promise<{ success: boolean; error?: string }> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return {
        success: false,
        error: `Channel ${channelId} not found or not a text channel`,
      };
    }

    await channel.send(message);
    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}
