/**
 * bot.ts
 * Discord bot for a single agent.
 * Each agent runs its own bot process with its own token.
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
  Partials,
  REST,
  Routes,
  Events,
  AttachmentBuilder,
} from "discord.js";
import { runAgent, resolveAgentConfig, loadConfig } from "../core/agent.js";
import type { AgentMessage, ImageAttachment, RunAgentResult, QueryUsage } from "../core/agent.js";
import { startLocalBridge } from "../local-bridge/index.js";
import type { LocalBridgeHandle, InboundMessage } from "../local-bridge/index.js";
import {
  enqueueInbound,
  parseHivemindMessage,
  routeInbound,
  registerPrimaryChannel,
  getPrimaryChannel,
  completeDelegation,
  formatHeader,
  maybeOffloadLargeMessage,
  setRegistryStateFile,
  loadRegistryFromDisk,
  consumeEscalationFlag,
  writeHivemindReceipt,
} from "../tools/messaging.js";
import { setAgentExecutor } from "../tools/cron.js";
import {
  archiveWake,
  ensureWakeDirs,
  listPendingWakes,
  readWakeSignal,
} from "../runner/wake-queue.js";
import { createEventsLogger, defaultEventsLogPath } from "../runner/events-log.js";
import { buildDailyMemoryLine } from "../runner/wake-prompt.js";
import { readTaskFile } from "../runner/task-file.js";
import { join, basename } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, appendFileSync } from "fs";
import { pipeline } from "stream/promises";
import {
  extractAttachments,
  resolveAttachments,
  logHivemindAttachWarning,
} from "./attachments.js";
import { writeBootBeacon } from "./bot-boot.js";
import {
  isNoReply,
  relayLoopGuardTripped,
  RELAY_LOOP_THRESHOLD,
  RELAY_LOOP_WINDOW_MS,
} from "./relay-guards.js";
import type { UsersTable } from "../core/users.js";

interface BotOptions {
  token: string;
  users: UsersTable;
  configPath: string;
  agentName: string;
}

type ReadyEventRegistrar = Pick<Client, "on">;

export function registerReadyHandlers(
  client: ReadyEventRegistrar,
  onReady: () => Promise<void> | void,
): void {
  let fired = false;
  const handler = async () => {
    if (fired) return;
    fired = true;
    await onReady();
  };

  client.on("clientReady", handler);
  client.on("ready", handler);
}

export function computeBridgeHubUrl(env: NodeJS.ProcessEnv, agentName: string): string {
  if (env.LOCAL_BRIDGE_DISABLED === "true") {
    return "";
  }
  if (typeof env.LOCAL_BRIDGE_URL === "string" && env.LOCAL_BRIDGE_URL.length > 0) {
    return env.LOCAL_BRIDGE_URL;
  }
  return `ws://127.0.0.1:7777/ws/agent/${agentName}`;
}

// ── Session Stats ──────────────────────────────────────────────
interface SessionStats {
  sessionStarted: Date;
  lastActivity: Date;
  interactions: number;
  compactions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalTurns: number;
  totalDurationMs: number;
  // From the most recent query (for "current context" approximation)
  // lastContextTokens = inputTokens + cacheReadTokens (total tokens sent to model)
  lastContextTokens: number;
  lastOutputTokens: number;
  contextWindow: number;
  model: string;
}

function createSessionStats(model: string): SessionStats {
  return {
    sessionStarted: new Date(),
    lastActivity: new Date(),
    interactions: 0,
    compactions: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUSD: 0,
    totalTurns: 0,
    totalDurationMs: 0,
    lastContextTokens: 0,
    lastOutputTokens: 0,
    contextWindow: 200_000,
    model,
  };
}

function updateStats(stats: SessionStats, usage: QueryUsage | undefined, compacted: boolean): void {
  stats.interactions++;
  stats.lastActivity = new Date();
  if (compacted) stats.compactions++;

  if (usage) {
    stats.totalInputTokens += usage.inputTokens;
    stats.totalOutputTokens += usage.outputTokens;
    stats.totalCacheReadTokens += usage.cacheReadTokens;
    stats.totalCacheCreationTokens += usage.cacheCreationTokens;
    stats.totalCostUSD += usage.costUSD;
    stats.totalTurns += usage.numTurns;
    stats.totalDurationMs += usage.durationMs;
    stats.lastContextTokens = usage.lastTurnInputTokens;
    stats.lastOutputTokens = usage.outputTokens;
    stats.contextWindow = usage.contextWindow;
  }
}

function formatStats(stats: SessionStats, agentName: string, sessionId: string | undefined): string {
  const cacheTotal = stats.totalCacheReadTokens + stats.totalCacheCreationTokens;
  const cacheHitPct = cacheTotal > 0
    ? Math.round((stats.totalCacheReadTokens / cacheTotal) * 100)
    : 0;

  // Total input = non-cached + cached (full picture of what was sent to the model)
  const totalIn = stats.totalInputTokens + stats.totalCacheReadTokens;

  const contextPct = stats.contextWindow > 0
    ? Math.round((stats.lastContextTokens / stats.contextWindow) * 100)
    : 0;

  const elapsed = Date.now() - stats.sessionStarted.getTime();
  const elapsedStr = formatDuration(elapsed);

  const shortSessionId = sessionId
    ? sessionId.substring(0, 8)
    : "none";

  const lines = [
    `🐝 **Neato Hive** — ${agentName}`,
    `🧠 Model: ${stats.model}`,
    `🧮 Tokens: ${formatTokens(totalIn)} in / ${formatTokens(stats.totalOutputTokens)} out`,
    `🗄️ Cache: ${cacheHitPct}% hit · ${formatTokens(stats.totalCacheReadTokens)} cached, ${formatTokens(stats.totalCacheCreationTokens)} new`,
    `📚 Context: ${formatTokens(stats.lastContextTokens)}/${formatTokens(stats.contextWindow)} (${contextPct}%) · 🧹 Compactions: ${stats.compactions}`,
    `🧵 Session: ${shortSessionId} · ${stats.interactions} interactions · up ${elapsedStr}`,
    `⚙️ Think: adaptive · 💰 Cost: $${stats.totalCostUSD.toFixed(4)}`,
  ];

  return lines.join("\n");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMins}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

/**
 * Logs usage to a persistent file for historical tracking.
 * Appends one JSON line per interaction.
 */
function logUsage(agentName: string, usage: QueryUsage | undefined): void {
  if (!usage) return;
  const logDir = join(process.cwd(), "data");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "usage.jsonl");
  const entry = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUSD: usage.costUSD,
    numTurns: usage.numTurns,
    durationMs: usage.durationMs,
  };
  appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

// ── Session Persistence ────────────────────────────────────────

function sessionFilePath(agentName: string): string {
  return join(process.cwd(), "agents", agentName, "session.json");
}

function loadSession(agentName: string): string | undefined {
  try {
    const file = sessionFilePath(agentName);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8"));
      return data.sessionId;
    }
  } catch {}
  return undefined;
}

function saveSession(agentName: string, sessionId: string): void {
  try {
    writeFileSync(
      sessionFilePath(agentName),
      JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("[sessions] Failed to save:", err);
  }
}

function clearSession(agentName: string): void {
  try {
    writeFileSync(
      sessionFilePath(agentName),
      JSON.stringify({ sessionId: "", updatedAt: new Date().toISOString(), clearedBy: "crash-protection" }, null, 2)
    );
    console.log(`[sessions] Session cleared for ${agentName} (crash protection)`);
  } catch (err) {
    console.error("[sessions] Failed to clear:", err);
  }
}

// ── Dashboard Session Persistence ─────────────────────────────

function dashboardSessionFilePath(agentName: string): string {
  return join(process.cwd(), "agents", agentName, "dashboard-session.json");
}

function loadDashboardSession(agentName: string): string | undefined {
  try {
    const file = dashboardSessionFilePath(agentName);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8"));
      return data.sessionId || undefined;
    }
  } catch {}
  return undefined;
}

function saveDashboardSession(agentName: string, sessionId: string): void {
  try {
    writeFileSync(
      dashboardSessionFilePath(agentName),
      JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("[dashboard-session] Failed to save:", err);
  }
}

function dashboardUploadPath(uploadId: string): string | null {
  if (!/^[a-f0-9-]+\.(jpg|jpeg|png|gif|webp)$/i.test(uploadId)) {
    return null;
  }

  return join(process.cwd(), "data", "dashboard-uploads", uploadId);
}

function dashboardUploadMediaType(uploadId: string): string | null {
  const lower = uploadId.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

// ── Runtime State (per-agent toggles) ──────────────────────────
//
// Small persisted flags that survive restart but aren't part of version control.
// Currently tracks the /show-thinking toggle. Stored alongside session.json in
// each agent's directory.

interface RuntimeState {
  /** When true, interim checkpoint narration is posted as Discord subtext above the final reply. Default false. */
  showThinking: boolean;
}

function runtimeFilePath(agentName: string): string {
  return join(process.cwd(), "agents", agentName, "runtime.json");
}

function loadRuntime(agentName: string): RuntimeState {
  try {
    const file = runtimeFilePath(agentName);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<RuntimeState>;
      return { showThinking: data.showThinking === true };
    }
  } catch (err) {
    console.error("[runtime] Failed to load, using defaults:", err);
  }
  return { showThinking: false };
}

function saveRuntime(agentName: string, state: RuntimeState): void {
  try {
    writeFileSync(
      runtimeFilePath(agentName),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("[runtime] Failed to save:", err);
  }
}

// ── Crash Loop Detection ───────────────────────────────────────

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

function detectCrashLoop(agentName: string): boolean {
  const crashFile = join(process.cwd(), "agents", agentName, "crash-detect.json");
  const now = Date.now();
  let timestamps: number[] = [];

  try {
    if (existsSync(crashFile)) {
      const parsed = JSON.parse(readFileSync(crashFile, "utf-8"));
      if (Array.isArray(parsed)) timestamps = parsed;
    }
  } catch {}

  if (!Array.isArray(timestamps)) timestamps = [];
  timestamps = timestamps.filter((t) => typeof t === "number" && now - t < CRASH_LOOP_WINDOW_MS);
  timestamps.push(now);

  try {
    writeFileSync(crashFile, JSON.stringify(timestamps));
  } catch {}

  if (timestamps.length >= CRASH_LOOP_THRESHOLD) {
    console.error(`[crash-protection] ${timestamps.length} restarts in ${CRASH_LOOP_WINDOW_MS / 1000}s — crash loop detected`);
    return true;
  }

  return false;
}

// ── Attachment Handling ────────────────────────────────────────

const ATTACHMENTS_DIR = "/tmp/hive-attachments";

async function downloadAttachment(url: string, filename: string): Promise<string> {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const localPath = join(ATTACHMENTS_DIR, `${Date.now()}-${filename}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${filename}: ${response.statusText}`);
  }
  const fileStream = createWriteStream(localPath);
  // @ts-ignore — Node 24 ReadableStream is compatible with pipeline
  await pipeline(response.body as any, fileStream);
  return localPath;
}


// ── Approval Flow ──────────────────────────────────────────────

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }
>();

// ── Message Splitting ──────────────────────────────────────────

function splitMessage(content: string, maxLength = 1900): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIdx === -1) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── Send Response Helper ───────────────────────────────────────

async function sendToChannel(
  channel: TextChannel | ThreadChannel,
  text: string,
  discordFiles?: AttachmentBuilder[]
): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1 && discordFiles && discordFiles.length > 0) {
      await channel.send({ content: chunks[i], files: discordFiles });
    } else {
      await channel.send(chunks[i]);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// ██  START BOT  ████████████████████████████████████████████████
// ════════════════════════════════════════════════════════════════

export async function startBot(options: BotOptions): Promise<Client> {
  const { token, users, configPath, agentName } = options;
  const allowedUserIds = users.allowedUserIds;
  const config = loadConfig(configPath);
  const agentConfig = resolveAgentConfig(config, agentName);
  const model = (config.model as string) || "claude-opus-4-7";

  // Get the channels this agent listens to
  const agents = config.agents as Record<string, { channels: string[] }>;
  const agentDef = agents[agentName];
  if (!agentDef) {
    console.error(`Agent "${agentName}" not found in config.yaml`);
    process.exit(1);
  }
  const allowedChannels = new Set(agentDef.channels);

  // Register this agent's primary user-facing channel so EscalateToOwner
  // (and the in-flight escalation flow) can find it. Convention: the first
  // non-hivemind channel in the agent's config is the owner-facing one.
  const primaryChannel = agentDef.channels.find((c) => c !== "hivemind");
  if (primaryChannel) {
    registerPrimaryChannel(agentName, primaryChannel);
  }

  // Persistent delegation registry — replay any in-flight delegations
  // from disk so a `pm2 restart` mid-conversation doesn't drop them.
  // Per-agent file at agents/<name>/state/delegations.jsonl. The path is
  // configured here; the messaging module appends events on every
  // register/complete from now on.
  const registryFile = join(process.cwd(), "agents", agentName, "state", "delegations.jsonl");
  setRegistryStateFile(registryFile);
  const loaded = loadRegistryFromDisk();
  if (loaded.loaded > 0 || loaded.expired > 0) {
    console.log(
      `[delegation-registry] replayed from disk: ${loaded.loaded} active, ${loaded.expired} expired`,
    );
  }

  // Load persisted session — with crash loop protection
  let currentSessionId = loadSession(agentName);

  if (currentSessionId && detectCrashLoop(agentName)) {
    console.error(`[crash-protection] Clearing session for ${agentName} to break crash loop`);
    clearSession(agentName);
    currentSessionId = undefined;
  }

  if (currentSessionId) {
    console.log(`[sessions] Resuming session ${currentSessionId.substring(0, 8)}...`);
  }

  // Runtime toggles (persisted) — /show-thinking, etc.
  const runtimeState = loadRuntime(agentName);
  console.log(`[runtime] show-thinking: ${runtimeState.showThinking ? "on" : "off"}`);

  // Session stats — tracks token usage, cache, compactions, cost
  let sessionStats = createSessionStats(model);

  // ── Local Bridge (dashboard integration) ──
  let dashboardSessionId = loadDashboardSession(agentName);
  let dashboardSessionStats = createSessionStats(model);

  const bridgeHubUrl = computeBridgeHubUrl(process.env, agentName);

  async function handleDashboardMessage(payload: InboundMessage): Promise<void> {
    const channelKey = payload.channelKey;

    if (payload.isSlashCommand && payload.rawCommand) {
      if (payload.rawCommand === "/newsession") {
        dashboardSessionId = undefined;
        saveDashboardSession(agentName, "");
        dashboardSessionStats = createSessionStats(model);
        bridgeHandle.publish({ type: "session_reset", channelKey, ts: Date.now() });
        return;
      }
      if (payload.rawCommand === "/status") {
        const statusText = formatStats(dashboardSessionStats, agentName, dashboardSessionId);
        bridgeHandle.publish({ type: "system", text: statusText, channelKey, ts: Date.now() });
        return;
      }
    }

    bridgeHandle.publish({ type: "agent_status", status: "thinking", ts: Date.now() });

    let finalReplyText = "";

    // Handle uploaded dashboard images by inlining them into the agent call.
    let imageAttachments: ImageAttachment[] | undefined;
    if (payload.attachments && payload.attachments.length > 0) {
      imageAttachments = [];
      for (const uploadId of payload.attachments) {
        const filePath = dashboardUploadPath(uploadId);
        const mediaType = dashboardUploadMediaType(uploadId);
        if (!filePath || !mediaType || !existsSync(filePath)) {
          bridgeHandle.publish({
            type: "system",
            text: `Skipped missing dashboard upload: ${uploadId}`,
            channelKey,
            ts: Date.now(),
          });
          continue;
        }

        imageAttachments.push({
          url: "",
          mediaType: mediaType as ImageAttachment["mediaType"],
          inline: {
            data: readFileSync(filePath).toString("base64"),
            mediaType,
          },
        });
      }
    }

    try {
      const result = await runAgent(
        payload.text,
        agentConfig,
        (msg: AgentMessage) => {
          switch (msg.type) {
            case "text_interim":
              bridgeHandle.publish({ type: "agent_text", text: msg.content, channelKey, ts: Date.now(), final: false });
              break;
            case "text":
              finalReplyText = msg.content;
              bridgeHandle.publish({ type: "agent_text", text: msg.content, channelKey, ts: Date.now(), final: true });
              break;
            case "tool_use":
              bridgeHandle.publish({ type: "tool_use", toolName: msg.toolName || "unknown", channelKey, ts: Date.now() });
              break;
            case "tool_result":
              bridgeHandle.publish({ type: "tool_result", toolName: msg.toolName || "unknown", channelKey, ts: Date.now(), ok: !msg.content.toLowerCase().includes("error") });
              break;
            case "error":
              bridgeHandle.publish({ type: "system", text: `Error: ${msg.content}`, channelKey, ts: Date.now() });
              break;
            case "system":
              bridgeHandle.publish({ type: "system", text: msg.content, channelKey, ts: Date.now() });
              break;
          }
        },
        async () => false,
        dashboardSessionId,
        imageAttachments,
      );

      if (result.sessionId) {
        dashboardSessionId = result.sessionId;
        saveDashboardSession(agentName, result.sessionId);
      }
      updateStats(dashboardSessionStats, result.usage, result.compacted);
      logUsage(agentName, result.usage);

      const primaryChannelName = getPrimaryChannel(agentName);
      const primaryChannelId = primaryChannelName
        ? client.channels.cache.find((candidate) => candidate instanceof TextChannel && candidate.name === primaryChannelName)?.id
        : undefined;

      if (primaryChannelId && payload.text.trim() && !payload.isSlashCommand) {
        const dashboardUserLine = `[via dashboard] ${payload.text.trim()}`;
        const targetChannel = await client.channels.fetch(primaryChannelId).catch(() => null);
        if (targetChannel && "send" in targetChannel) {
          await targetChannel.send(dashboardUserLine);
          if (finalReplyText.trim()) {
            await targetChannel.send(finalReplyText.trim());
          }
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[dashboard] runAgent failed:`, error);
      bridgeHandle.publish({ type: "system", text: `Error: ${errMsg}`, channelKey, ts: Date.now() });
    } finally {
      bridgeHandle.publish({ type: "agent_status", status: "idle", ts: Date.now() });
    }
  }

  const bridgeHandle: LocalBridgeHandle = startLocalBridge({
    agentName,
    hubUrl: bridgeHubUrl,
    onInboundMessage: handleDashboardMessage,
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  registerReadyHandlers(client, async () => {
    console.log(`[discord] Logged in as ${client.user?.tag}`);
    console.log(`[discord] Owner user: ${users.ownerUser.name} (Discord IDs: ${users.ownerUser.discord_ids.join(", ")})`);
    console.log(`[discord] Channels: ${[...allowedChannels].join(", ")}`);

    // Register slash commands
    const rest = new REST().setToken(token);
    try {
      await rest.put(
        Routes.applicationCommands(client.user!.id),
        {
          body: [
            { name: "newsession", description: "Start a fresh conversation session" },
            { name: "status", description: "Show agent status — tokens, cache, context, cost" },
            { name: "show-thinking", description: "Toggle visible checkpoint narration above replies" },
          ]
        }
      );
      console.log("[discord] Registered slash commands: /newsession, /status, /show-thinking");
    } catch (err) {
      console.error("[discord] Failed to register slash commands:", err);
    }

    // Boot beacon — write if agent opts in via announce_on_boot: true.
    if (agentConfig.announce_on_boot) {
      try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
        const version = pkg.version ?? "0.0.0";
        writeBootBeacon(process.cwd(), agentName, version, process.pid);
        console.log(`[boot-beacon] Wrote beacon for ${agentName} v${version} pid=${process.pid}`);
      } catch (err) {
        console.error(`[boot-beacon] Failed to write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  // ── Slash Command Handling ──
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!allowedUserIds.has(interaction.user.id)) return;

    if (interaction.commandName === "newsession") {
      currentSessionId = undefined;
      saveSession(agentName, "");
      sessionStats = createSessionStats(model); // Reset stats
      await interaction.reply("Session cleared. Next message starts fresh.");
    }

    if (interaction.commandName === "status") {
      const statusText = formatStats(sessionStats, agentName, currentSessionId);
      await interaction.reply(statusText);
    }

    if (interaction.commandName === "show-thinking") {
      runtimeState.showThinking = !runtimeState.showThinking;
      saveRuntime(agentName, runtimeState);
      await interaction.reply(
        runtimeState.showThinking
          ? "Thinking visible: **on**. You'll see checkpoint narration as subtext above my replies."
          : "Thinking visible: **off**. Back to final replies only."
      );
    }
  });

  const HIVEMIND_CHANNEL = "hivemind";

  client.on("messageCreate", async (message: Message) => {
    // Get channel name
    const channelName =
      message.channel instanceof TextChannel
        ? message.channel.name
        : message.channel instanceof ThreadChannel
          ? message.channel.parent?.name || "unknown"
          : "dm";

    // ── Hivemind: inter-agent messages ──
    if (channelName === HIVEMIND_CHANNEL && message.author.bot) {
      const parsed = parseHivemindMessage(message.content);
      if (!parsed) return;
      if (parsed.toAgent !== agentName) return;
      if (message.author.id === client.user?.id) return;

      const { fromAgent, body } = parsed;
      const route = routeInbound(parsed, agentName);

      console.log(`[hivemind:receive] messageCreate from #hivemind, agent=${agentName}, fromAgent=${fromAgent}, taskId=${parsed.taskId ?? "none"}, kind=${parsed.kind}`);
      console.log(`[hivemind:receive] routeInbound decision: ${route.kind}`);

      if (route.kind === "ignore") {
        console.log(`[hivemind] Ignoring message from ${fromAgent}: ${route.reason}`);
        return;
      }

      const channel = message.channel as TextChannel;

      if (route.kind === "stale") {
        // Surface — never silently drop. Stale routing is the kind of bug
        // that corrupts agent state by e.g. routing a fresh delegation as
        // a response. Posting it visibly in #hivemind is the alarm.
        console.warn(
          `[hivemind] Stale response from ${fromAgent} → ${agentName}: ${route.reason}` +
            (route.taskId ? ` (taskId=${route.taskId})` : ""),
        );
        const idNote = route.taskId ? ` \`task=${route.taskId}\`` : "";
        await channel.send(
          `${formatHeader(agentName, fromAgent, "response")}\n` +
            `⚠️ Dropped stale response${idNote}: ${route.reason}. ` +
            `The original delegation has expired or never existed. ` +
            `Re-delegate if the work still matters.`,
        );
        return;
      }

      const isResponse = route.kind === "response";
      const isEscalation = route.kind === "escalation";
      const isRequest = route.kind === "request";

      let promptPrefix: string;
      if (isResponse) {
        promptPrefix = `[Response from ${fromAgent} via #hivemind to your earlier delegation (task ${route.record.taskId}) — absorb into your context, do NOT use SendMessage]`;
        console.log(`[hivemind] Response from ${fromAgent} for task ${route.record.taskId} (absorbing)`);
      } else if (isEscalation) {
        promptPrefix = `[Escalation notice from ${fromAgent} via #hivemind — they paused on a task you delegated and asked the owner. Just internalize this — do NOT use SendMessage]`;
        const tid = route.record?.taskId;
        console.log(
          `[hivemind] Escalation notice from ${fromAgent}${tid ? ` for task ${tid}` : ""} (absorbing)`,
        );
      } else {
        // Surface the task_id in the prompt header so the receiving agent can
        // capture it. Needed when the agent calls EscalateToOwner mid-turn:
        // after the owner answers, the agent's NEXT turn must call
        // SendMessage(kind=response, task_id=<id>) explicitly to close the
        // delegation — auto-tagging across owner-mediated turns isn't wired
        // up (would require persistent state and racy resolution detection).
        // Bug #4 from Lance's hivemind orchestration troubleshoot, 2026-04-30.
        const tidNote = parsed.taskId ? `, task_id=${parsed.taskId}` : "";
        promptPrefix = `[Message from ${fromAgent} via #hivemind${tidNote} — reply directly, do NOT use SendMessage]`;
        console.log(
          `[hivemind] Request from ${fromAgent} → ${agentName}${parsed.taskId ? ` (task_id=${parsed.taskId})` : ""}`,
        );
      }

      const taggedPrompt = `${promptPrefix}\n${body.trim()}`;

      const parsedKind = isRequest ? "request" : isResponse ? "response" : "escalation";
      const inboundId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      enqueueInbound({
        id: inboundId,
        kind: parsedKind,
        fromAgent,
        taskId: parsed.taskId,
        enqueuedAt: Date.now(),
        process: async () => {
          let resultText = "";
          const errors: string[] = [];
          let sessionWriteResult = false;

          channel.sendTyping().catch(() => {});
          const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

          console.log(`[hivemind:receive] starting runAgent for hivemind ${parsedKind} turn (id=${inboundId})`);

          try {
            const result = await runAgent(
              taggedPrompt,
              agentConfig,
              (msg: AgentMessage) => {
                switch (msg.type) {
                  case "text": resultText = msg.content; break;
                  case "error": errors.push(msg.content); break;
                }
              },
              async () => false,
              currentSessionId,
            );

            if (result.sessionId) {
              currentSessionId = result.sessionId;
              saveSession(agentName, result.sessionId);
              sessionWriteResult = true;
            }
            updateStats(sessionStats, result.usage, result.compacted);
            logUsage(agentName, result.usage);

            console.log(`[hivemind:receive] runAgent completed (id=${inboundId}), sessionId=${result.sessionId?.substring(0, 8) ?? "none"}, resultText length=${resultText.length}`);

            if (isRequest) {
              const responseTaskId = parsed.taskId;
              const replyHeader = responseTaskId
                ? formatHeader(agentName, fromAgent, "response", responseTaskId)
                : `**[${agentName} → ${fromAgent}]**`;

              const escalated = consumeEscalationFlag();
              if (escalated) {
                console.log(
                  `[hivemind] Auto-reply suppressed — ${agentName} escalated to owner; original delegation ${parsed.taskId ?? "(legacy)"} stays pending.`,
                );
              }

              const noReply = !escalated && resultText.trim() ? isNoReply(resultText) : false;
              if (noReply) {
                console.log(
                  `[hivemind] [NO_REPLY] marker — suppressing relay (${agentName} → ${fromAgent}).`,
                );
              }

              let loopGuardTripped = false;
              if (!escalated && !noReply && resultText.trim()) {
                loopGuardTripped = relayLoopGuardTripped(agentName, fromAgent);
                if (loopGuardTripped) {
                  console.warn(
                    `[hivemind] Loop guard tripped — ${RELAY_LOOP_THRESHOLD}+ relays from ${agentName} → ${fromAgent} in last ${RELAY_LOOP_WINDOW_MS / 1000}s. Suppressing further relay until traffic dies down.`,
                  );
                }
              }

              if (!escalated && !noReply && !loopGuardTripped && resultText.trim()) {
                const { cleanText, filePaths } = extractAttachments(resultText);

                const offload = maybeOffloadLargeMessage(agentName, fromAgent, cleanText);
                const finalText = offload.offloaded ? offload.body : cleanText;
                const finalExtraction = offload.offloaded
                  ? extractAttachments(finalText)
                  : { cleanText: finalText, filePaths: [] as string[] };

                const allPaths = [...filePaths, ...finalExtraction.filePaths];
                const { builders, warnings } = resolveAttachments(allPaths);
                for (const w of warnings) {
                  console.warn(`[hivemind attach] ${w}`);
                  logHivemindAttachWarning(agentName, w);
                }
                const replyBody =
                  finalExtraction.cleanText.trim() ||
                  (builders.length > 0 ? "" : resultText);
                const responseFormatted = replyBody
                  ? `${replyHeader}\n${replyBody}`
                  : replyHeader;
                await sendToChannel(channel, responseFormatted, builders);
              }

              if (!escalated && !loopGuardTripped) {
                for (const err of errors) {
                  await channel.send(`${replyHeader}\n❌ ${err}`);
                }
              }
            } else if (isResponse) {
              completeDelegation(route.record.taskId);
              console.log(
                `[hivemind] Absorbed response from ${fromAgent} for task ${route.record.taskId} (cleared from registry)`,
              );
              if (resultText.trim()) {
                if (isNoReply(resultText)) {
                  console.log(
                    `[hivemind] [NO_REPLY] marker — suppressing own-channel surface (${agentName} absorbed response from ${fromAgent}).`,
                  );
                } else {
                  const ownChannelName = [...allowedChannels][0];
                  const ownChannel = client.channels.cache.find(
                    (ch) => ch instanceof TextChannel && ch.name === ownChannelName
                  ) as TextChannel | undefined;
                  if (ownChannel) {
                    const { cleanText, filePaths } = extractAttachments(resultText);
                    const { builders, warnings } = resolveAttachments(filePaths);
                    for (const w of warnings) {
                      console.warn(`[hivemind attach] ${w}`);
                      logHivemindAttachWarning(agentName, w);
                    }
                    await sendToChannel(ownChannel, cleanText || resultText, builders);
                  }
                }
              }
            } else if (isEscalation) {
              if (resultText.trim()) {
                if (isNoReply(resultText)) {
                  console.log(
                    `[hivemind] [NO_REPLY] marker — suppressing own-channel surface (${agentName} absorbed escalation from ${fromAgent}).`,
                  );
                } else {
                  const ownChannelName = [...allowedChannels][0];
                  const ownChannel = client.channels.cache.find(
                    (ch) => ch instanceof TextChannel && ch.name === ownChannelName
                  ) as TextChannel | undefined;
                  if (ownChannel) {
                    const { cleanText, filePaths } = extractAttachments(resultText);
                    const { builders, warnings } = resolveAttachments(filePaths);
                    for (const w of warnings) {
                      console.warn(`[hivemind attach] ${w}`);
                      logHivemindAttachWarning(agentName, w);
                    }
                    await sendToChannel(ownChannel, cleanText || resultText, builders);
                  }
                }
              }
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[hivemind:receive] runAgent failed (id=${inboundId}):`, error);
            await channel.send(
              `${formatHeader(agentName, fromAgent, "response", parsed.taskId)}\n❌ Error: ${errMsg}`,
            );
          } finally {
            clearInterval(typingInterval);
            writeHivemindReceipt({
              fromAgent,
              toAgent: agentName,
              taskId: parsed.taskId ?? "none",
              kind: parsedKind,
              sessionUpdated: sessionWriteResult,
            });
          }
        },
      });

      return; // handler returns immediately after enqueue; processing happens in the background drain loop
    }

    // ── Normal messages: owner only ──

    if (message.author.bot) return;
    if (!allowedUserIds.has(message.author.id)) return;

    // Check for approval responses
    const content = message.content.trim().toLowerCase();
    if (content === "yes" || content === "no") {
      for (const [id, pending] of pendingApprovals) {
        clearTimeout(pending.timeout);
        pending.resolve(content === "yes");
        pendingApprovals.delete(id);
        return;
      }
    }

    if (!allowedChannels.has(channelName)) return;

    // Show typing indicator
    const channel = message.channel as TextChannel | ThreadChannel;
    channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

    // Extract image attachments
    const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    const imageAttachments: ImageAttachment[] = [];
    const fileDescriptions: string[] = [];

    for (const [, attachment] of message.attachments) {
      const contentType = attachment.contentType || "";
      if (IMAGE_TYPES.has(contentType) && attachment.url) {
        imageAttachments.push({
          url: attachment.url,
          mediaType: contentType as ImageAttachment["mediaType"],
        });
      } else if (attachment.url && attachment.name) {
        try {
          const localPath = await downloadAttachment(attachment.url, attachment.name);
          fileDescriptions.push(`[Attached file: ${attachment.name} → saved to ${localPath}]`);
          console.log(`[files] Downloaded ${attachment.name} → ${localPath}`);
        } catch (err) {
          console.error(`[files] Failed to download ${attachment.name}:`, err);
          fileDescriptions.push(`[Attached file: ${attachment.name} — download failed]`);
        }
      }
    }

    if (imageAttachments.length > 0) {
      console.log(`[images] ${imageAttachments.length} image(s) attached`);
    }

    let userPrompt = message.content;
    if (fileDescriptions.length > 0) {
      userPrompt = fileDescriptions.join("\n") + "\n\n" + userPrompt;
    }

    // Track responses
    let resultText = "";
    let lastInterim = "";
    let didSendInterim = false;
    const errors: string[] = [];
    const systemMessages: string[] = [];
    const discordChannelKey = `discord:${message.channel.id}`;

    // Mirror user message to dashboard bridge
    bridgeHandle.publish({
      type: "user_message",
      source: "discord",
      text: userPrompt,
      channelKey: discordChannelKey,
      ts: Date.now(),
    });

    try {
      const result = await runAgent(
        userPrompt,
        agentConfig,
        (msg: AgentMessage) => {
          // Forward events to bridge for dashboard mirroring
          switch (msg.type) {
            case "text_interim": {
              bridgeHandle.publish({ type: "agent_text", text: msg.content, channelKey: discordChannelKey, ts: Date.now(), final: false });
              // Gated on the per-agent /show-thinking toggle. Default off.
              if (!runtimeState.showThinking) break;
              // Attachment markers belong in the final reply so extractAttachments()
              // can process them there. If an interim happens to contain one, skip.
              if (msg.content.includes("[ATTACH:")) break;
              const trimmed = msg.content.trim();
              if (!trimmed) break;
              lastInterim = msg.content;
              didSendInterim = true;
              // Prefix each non-empty line with "-# " so Discord renders as subtext.
              const asSubtext = trimmed
                .split("\n")
                .map((line) => (line.trim() ? `-# ${line}` : line))
                .join("\n");
              void sendToChannel(channel, asSubtext).catch((e) =>
                console.error(`[interim] ${e instanceof Error ? e.message : e}`)
              );
              break;
            }
            case "text":
              bridgeHandle.publish({ type: "agent_text", text: msg.content, channelKey: discordChannelKey, ts: Date.now(), final: true });
              // Dedup: if the final exactly matches the last posted interim,
              // the user already saw it — skip re-sending as the main reply.
              resultText = msg.content === lastInterim ? "" : msg.content;
              break;
            case "error":
              bridgeHandle.publish({ type: "system", text: `Error: ${msg.content}`, channelKey: discordChannelKey, ts: Date.now() });
              errors.push(msg.content);
              break;
            case "system":
              bridgeHandle.publish({ type: "system", text: msg.content, channelKey: discordChannelKey, ts: Date.now() });
              systemMessages.push(msg.content);
              break;
            case "tool_use":
              bridgeHandle.publish({ type: "tool_use", toolName: msg.toolName || "unknown", channelKey: discordChannelKey, ts: Date.now() });
              break;
          }
        },
        async (approvalMessage: string) => {
          const approvalMsg = await channel.send(
            `⚠️ **Approval Required**\n${approvalMessage}\n\nReply **yes** or **no**.`
          );

          return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(approvalMsg.id);
              resolve(false);
              channel.send("⏰ Approval timed out — action denied.");
            }, 120_000);

            pendingApprovals.set(approvalMsg.id, { resolve, timeout });
          });
        },
        currentSessionId,
        imageAttachments.length > 0 ? imageAttachments : undefined
      );

      if (result.sessionId) {
        currentSessionId = result.sessionId;
        saveSession(agentName, result.sessionId);
      }
      updateStats(sessionStats, result.usage, result.compacted);
      logUsage(agentName, result.usage);

      for (const sysMsg of systemMessages) {
        await channel.send(sysMsg);
      }

      for (const err of errors) {
        await channel.send(err);
      }

      if (!resultText.trim()) {
        // If the final text was deduped against an interim we already posted,
        // the user already saw content — don't post a "no output" placeholder.
        if (errors.length === 0 && !didSendInterim) {
          await channel.send("*(completed with no text output)*");
        }
        return;
      }

      // Extract file attachments from agent response
      const { cleanText, filePaths } = extractAttachments(resultText);
      const discordFiles: AttachmentBuilder[] = [];

      for (const filePath of filePaths) {
        try {
          if (existsSync(filePath)) {
            discordFiles.push(new AttachmentBuilder(filePath, { name: basename(filePath) }));
            console.log(`[files] Attaching ${filePath}`);
          } else {
            console.error(`[files] File not found: ${filePath}`);
          }
        } catch (err) {
          console.error(`[files] Failed to attach ${filePath}:`, err);
        }
      }

      await sendToChannel(channel, cleanText || resultText, discordFiles);

      // If there's no text but there are files, send files alone
      if (!cleanText.trim() && discordFiles.length > 0) {
        await channel.send({ files: discordFiles });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await channel.send(`❌ Error: ${errMsg}`);
    } finally {
      clearInterval(typingInterval);
    }
  });

  // ── Agent executor (cron + autonomy-v1 wake) ──
  //
  // One callback, two modes. cron mode auto-posts the agent's text reply
  // to its own user channel (so the owner sees scheduled work). wake mode
  // (autonomy-v1 task completion) is silent unless the agent explicitly
  // SendMessages — the agent decides what surfaces.
  setAgentExecutor(async (prompt: string, opts) => {
    const mode = opts?.mode ?? "cron";
    const tagPrefix =
      mode === "wake"
        ? "[autonomy-v1 wake — silent mode, no auto-post]"
        : "[Scheduled task — cron job]";
    const taggedPrompt = `${tagPrefix}\n${prompt}`;

    let resultText = "";
    const errors: string[] = [];

    try {
      const result = await runAgent(
        taggedPrompt,
        agentConfig,
        (msg: AgentMessage) => {
          switch (msg.type) {
            case "text": resultText = msg.content; break;
            case "error": errors.push(msg.content); break;
          }
        },
        async () => false,
        currentSessionId,
      );

      if (result.sessionId) {
        currentSessionId = result.sessionId;
        saveSession(agentName, result.sessionId);
      }
      updateStats(sessionStats, result.usage, result.compacted);
      logUsage(agentName, result.usage);

      // Send result to the agent's own Discord channel — cron mode only.
      // Wake mode is silent: the agent decides what surfaces (via its own
      // SendMessage calls during the turn). This split is finding (c) of
      // the autonomy-v1 analysis.
      if (mode === "cron" && client.isReady()) {
        const ownChannelName = [...allowedChannels][0];
        const ownChannel = client.channels.cache.find(
          (ch) => ch instanceof TextChannel && ch.name === ownChannelName
        ) as TextChannel | undefined;

        if (ownChannel) {
          const fullOutput = [...errors.map(e => `❌ ${e}`), resultText].filter(Boolean).join("\n");
          if (fullOutput.trim()) {
            const { cleanText, filePaths } = extractAttachments(fullOutput);
            const discordFiles: AttachmentBuilder[] = [];
            for (const fp of filePaths) {
              try {
                if (existsSync(fp)) {
                  discordFiles.push(new AttachmentBuilder(fp, { name: basename(fp) }));
                }
              } catch {}
            }
            await sendToChannel(ownChannel, cleanText || fullOutput, discordFiles);
          }
        }
      }

      return resultText;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[${mode}] Agent executor failed: ${errMsg}`);
      return `Error: ${errMsg}`;
    }
  });

  // ── Wake queue poller (autonomy-v1) ──
  //
  // Every WAKE_POLL_INTERVAL_MS, scan agents/<this-agent>/wake/ for new
  // wake signal files written by the runner daemon. For each, call the
  // registered agentExecutor with mode=wake (silent path), then archive
  // the file to wake/processed/.
  //
  // No-op until the runner is started — the wake dir is lazy-created on
  // first signal.
  const WAKE_POLL_INTERVAL_MS = 5_000;
  const wakeBaseDir = process.cwd();
  let wakePollInFlight = false;
  ensureWakeDirs(wakeBaseDir, agentName);
  const wakeEventsLogger = createEventsLogger(defaultEventsLogPath(wakeBaseDir));

  const pollWakeQueue = async (): Promise<void> => {
    if (wakePollInFlight) return; // skip overlapping ticks
    wakePollInFlight = true;
    try {
      const pending = listPendingWakes(wakeBaseDir, agentName);
      for (const wakePath of pending) {
        let signal;
        try {
          signal = readWakeSignal(wakePath);
        } catch (err) {
          console.error(
            `[wake] failed to read ${wakePath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          // Quarantine the broken file so we don't loop on it forever.
          try { archiveWake(wakeBaseDir, agentName, wakePath); } catch {}
          continue;
        }

        // ── EMIT #1: wake_picked_up ──
        const enqueuedAt = Date.parse(signal.enqueued_at);
        const ageMs = isFinite(enqueuedAt) ? Date.now() - enqueuedAt : 0;
        wakeEventsLogger.log({
          taskId: signal.task_id,
          agent: agentName,
          event: "wake_picked_up",
          detail: { wakePath, ageMs },
        });

        console.log(
          `[wake] processing ${signal.task_id} (status=${signal.status})`,
        );

        // Daily-memory wake-event line — written BEFORE running the
        // agent so even a crash mid-execution leaves a paper trail.
        try {
          const taskFile = readTaskFile(signal.task_path);
          const memoryDir = join(process.cwd(), "agents", agentName, "memory");
          mkdirSync(memoryDir, { recursive: true });
          const today = new Date();
          const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
          const memoryFile = join(memoryDir, `${ymd}.md`);
          const needHeader = !existsSync(memoryFile);
          const line = needHeader
            ? `# ${ymd} — ${agentName}\n\n${buildDailyMemoryLine(taskFile.frontmatter)}`
            : buildDailyMemoryLine(taskFile.frontmatter);
          appendFileSync(memoryFile, line);
        } catch (err) {
          console.error(
            `[wake] daily memory write failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // ── EMIT #2: wake_turn_started ──
        const turnStartedAt = Date.now();
        wakeEventsLogger.log({
          taskId: signal.task_id,
          agent: agentName,
          event: "wake_turn_started",
          detail: { taskId: signal.task_id },
        });

        let turnStatus: "ok" | "error" | "exception" = "ok";
        let turnErrorMessage: string | undefined;

        // Invoke the agent. Errors are logged but don't block other wakes.
        try {
          let turnSawError = false;
          const result = await runAgent(
            `[autonomy-v1 wake — silent mode, no auto-post]\n${signal.prompt}`,
            agentConfig,
            (msg: AgentMessage) => {
              switch (msg.type) {
                case "error":
                  turnSawError = true;
                  console.error(`[wake] agent error: ${msg.content}`);
                  if (!turnErrorMessage) turnErrorMessage = msg.content;
                  break;
              }
            },
            async () => false,
            currentSessionId,
          );
          if (turnSawError) turnStatus = "error";
          if (result.sessionId) {
            currentSessionId = result.sessionId;
            saveSession(agentName, result.sessionId);
          }
          updateStats(sessionStats, result.usage, result.compacted);
          logUsage(agentName, result.usage);
        } catch (err) {
          turnStatus = "exception";
          turnErrorMessage = err instanceof Error ? err.message : String(err);
          console.error(
            `[wake] runAgent failed for ${signal.task_id}: ${turnErrorMessage}`,
          );
        }

        // ── EMIT #3: wake_turn_complete ──
        wakeEventsLogger.log({
          taskId: signal.task_id,
          agent: agentName,
          event: "wake_turn_complete",
          detail: {
            status: turnStatus,
            durationMs: Date.now() - turnStartedAt,
            ...(turnErrorMessage ? { errorMessage: turnErrorMessage } : {}),
          },
        });

        // ── EMIT #4: wake_archived ──
        // Archive the wake file regardless of outcome — at-least-once
        // semantics. If processing fails, the daily-memory line records it.
        let archivedPath: string | undefined;
        try {
          archivedPath = archiveWake(wakeBaseDir, agentName, wakePath);
        } catch (err) {
          console.error(`[wake] archive failed for ${wakePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (archivedPath) {
          wakeEventsLogger.log({
            taskId: signal.task_id,
            agent: agentName,
            event: "wake_archived",
            detail: { wakePath, archivedPath },
          });
        }
      }
    } finally {
      wakePollInFlight = false;
    }
  };

  setInterval(() => { void pollWakeQueue(); }, WAKE_POLL_INTERVAL_MS);
  // Run an initial pass on startup so any wake files written while the
  // bot was offline get processed promptly instead of waiting 5s.
  void pollWakeQueue();

  await client.login(token);
  return client;
}
