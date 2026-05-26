/**
 * agent.ts
 * Core agent runtime — wraps the Claude Agent SDK.
 *
 * SDK query format: query({ prompt, options: { systemPrompt, ... } })
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt, buildSafetyRules, buildToolGuidance } from "./prompt-builder.js";
import { createHiveToolsServer } from "../tools/hive-tools-server.js";
import { createSafetyHooks } from "../safety/safety-hooks.js";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { loadConfigWithOverlay } from "./config-overlay.js";

export interface AgentConfig {
  name: string;
  behaviorDir: string;
  memoryDir: string;
  model: string;
  workingDir: string;
  codex: { enabled: boolean; command: string; args: string[] };
  safety: {
    blocked_commands: string[];
    allowed_paths: string[];
    protected_paths: string[];
  };
  /** When true, bot writes a boot beacon on startup and the runner
   *  enqueues a boot-announce wake so the agent can self-announce. */
  announce_on_boot?: boolean;
  /** Optional per-agent CLAUDE_CONFIG_DIR override. When set, the Claude
   *  Agent SDK reads credentials from `<dir>/.credentials.json` for this
   *  agent's process instead of the default `~/.claude`. Enables multi-
   *  account isolation by pointing different agents at different account
   *  directories (e.g. ~/.claude-max-1 vs ~/.claude-max-2). Tilde (~)
   *  expansion is supported. Optional and backward-compatible: when unset,
   *  the SDK falls through to default credential resolution. */
  claudeConfigDir?: string;
}

export interface AgentMessage {
  type: "text" | "text_interim" | "tool_use" | "tool_result" | "error" | "system";
  content: string;
  toolName?: string;
}

export interface ImageAttachment {
  url: string; // Discord CDN URL — Anthropic API fetches directly
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Inline base64 image data — used by the dashboard path where
   *  localhost URLs aren't fetchable by the Anthropic API. When set,
   *  the SDK receives a base64 content block instead of a URL block. */
  inline?: { data: string; mediaType: string };
}

/** Per-query usage data extracted from the SDK result message. */
export interface QueryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** Input tokens from the LAST API call only — actual context window fill level. */
  lastTurnInputTokens: number;
}

/** Return value from runAgent — session ID + usage data. */
export interface RunAgentResult {
  sessionId?: string;
  usage?: QueryUsage;
  compacted: boolean; // true if a compaction happened during this query
}

type ApprovalCallback = (message: string) => Promise<boolean>;

/**
 * Loads and parses the global config file, merging in the local-agents
 * overlay (`config/agents.local.yaml`) when present. Local agents win on
 * key conflict; committed agents that are not redefined locally are
 * preserved (so the canonical `house-md` always comes through).
 *
 * Backward-compatible: if the overlay file doesn't exist, the loader
 * returns the committed config unchanged. See `config-overlay.ts` for
 * the full design rationale.
 */
export function loadConfig(configPath: string): Record<string, unknown> {
  const result = loadConfigWithOverlay(configPath);
  if (result.localOverlayPresent) {
    const agentNames = Object.keys(
      (result.config.agents as Record<string, unknown>) ?? {},
    );
    console.log(
      `[config] Loaded ${agentNames.length} agent(s) — committed config + local overlay (${result.localPath})`,
    );
    if (result.overriddenAgents.length > 0) {
      console.log(
        `[config] Local overrides: ${result.overriddenAgents.join(", ")}`,
      );
    }
  }
  return result.config;
}

/**
 * Sends a prompt to the agent and streams responses back.
 */
export async function runAgent(
  prompt: string,
  config: AgentConfig,
  onMessage: (msg: AgentMessage) => void,
  onApprovalRequired: ApprovalCallback,
  sessionId?: string,
  images?: ImageAttachment[]
): Promise<RunAgentResult> {
  let returnSessionId: string | undefined;
  let queryUsage: QueryUsage | undefined;
  let compacted = false;
  let lastTurnInputTokens = 0; // Track per-turn usage from assistant messages
  // Buffer for the most recent assistant text block. We only know it was
  // "interim narration" (not the final reply) once a subsequent tool_use or
  // text block arrives. If it's still buffered when `result` fires, it IS the
  // final — let the result event emit it as a proper `text` message instead.
  let pendingText: string | null = null;

  const systemPrompt = buildSystemPrompt({
    agentName: config.name,
    behaviorDir: config.behaviorDir,
    safetyRules: buildSafetyRules(config.safety),
    toolGuidance: buildToolGuidance(),
    memoryDir: config.memoryDir,
    tasksDir: join(config.workingDir, "agents", config.name, "tasks"),
  });

  // Build MCP servers config
  const mcpServers: Record<string, unknown> = {};
  if (config.codex.enabled) {
    mcpServers["codex"] = {
      command: config.codex.command,
      args: config.codex.args,
    };
  }

  // Add in-process Hive tools (cron, memory, patch, process, messaging)
  mcpServers["hive-tools"] = createHiveToolsServer(config.behaviorDir, config.name);

  // Safety hooks — block dangerous commands and enforce path restrictions
  const safetyHooks = createSafetyHooks(config.safety);

  // SDK options
  const sdkOptions: Record<string, unknown> = {
    systemPrompt,
    model: config.model,
    cwd: config.workingDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
    ],
    hooks: safetyHooks,
    thinkingConfig: { type: "adaptive" },
  };

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  if (Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers;
  }

  // Build the prompt — plain string or multimodal with image content blocks
  let queryPrompt: any = prompt;
  if (images && images.length > 0) {
    const contentBlocks: any[] = [];
    for (const img of images) {
      if (img.inline) {
        // Dashboard path — base64-encoded inline image
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.inline.mediaType,
            data: img.inline.data,
          },
        });
      } else {
        // Discord path — URL-based image (Anthropic API fetches directly)
        contentBlocks.push({
          type: "image",
          source: {
            type: "url",
            url: img.url,
          },
        });
      }
    }
    if (prompt.trim()) {
      contentBlocks.push({ type: "text", text: prompt });
    }
    const userMessage = {
      type: "user" as const,
      message: { role: "user" as const, content: contentBlocks },
      parent_tool_use_id: null,
    };
    // query() expects string | AsyncIterable<SDKUserMessage>, so wrap in an async generator
    console.log(`[images] Sending multimodal prompt with ${contentBlocks.length} content block(s)`);
    console.log(`[images] Block types: ${contentBlocks.map((b: any) => b.type).join(", ")}`);
    queryPrompt = (async function* () {
      console.log("[images] Async generator yielding SDKUserMessage");
      yield userMessage;
      console.log("[images] Async generator done");
    })();
  }

  // Process the SDK query stream. If resume is set and fails, retry fresh.
  const maxAttempts = sessionId ? 2 : 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      for await (const message of query({ prompt: queryPrompt, options: sdkOptions } as any)) {
        if (typeof message !== "object" || message === null) continue;

        const msg = message as Record<string, unknown>;

        switch (msg.type) {
          case "system": {
            const subtype = msg.subtype as string;
            if (subtype === "init" && msg.session_id) {
              returnSessionId = msg.session_id as string;
            }
            // Track compaction events
            if (subtype === "compact_boundary") {
              compacted = true;
              const metadata = msg.compact_metadata as Record<string, unknown> | undefined;
              const preTokens = metadata?.pre_tokens as number | undefined;
              console.log(`[agent] Compaction occurred — pre_tokens: ${preTokens ?? "unknown"}`);
            }
            break;
          }

          case "assistant": {
            const assistantMsg = msg.message as Record<string, unknown> | undefined;
            if (!assistantMsg) break;

            // Capture per-turn usage — the last assistant message's tokens = actual context size
            // Total context = input_tokens (non-cached) + cache_read + cache_creation
            const turnUsage = assistantMsg.usage as Record<string, unknown> | undefined;
            if (turnUsage) {
              const turnInput = (turnUsage.input_tokens as number) || 0;
              const turnCacheRead = (turnUsage.cache_read_input_tokens as number) || 0;
              const turnCacheCreation = (turnUsage.cache_creation_input_tokens as number) || 0;
              lastTurnInputTokens = turnInput + turnCacheRead + turnCacheCreation;
              console.log(`[context] Per-turn: ${turnInput} new + ${turnCacheRead} cached + ${turnCacheCreation} cache-create = ${lastTurnInputTokens} total`);
            }

            const content = assistantMsg.content as Array<Record<string, unknown>> | undefined;
            if (!content || !Array.isArray(content)) break;

            // Buffer-and-flush strategy: a text block is only "interim
            // narration" if proven so by a subsequent tool_use or text block.
            // Text still in the buffer when `result` fires is the final reply.
            const hasToolUse = content.some((b) => b.type === "tool_use");
            if (hasToolUse && pendingText !== null) {
              // The buffered text came before work — it was narration. Flush as subtext.
              onMessage({ type: "text_interim", content: pendingText });
              pendingText = null;
            }

            for (const block of content) {
              if (block.type === "text" && block.text) {
                const text = block.text as string;
                // If we already had buffered text and now another text block
                // arrived, the previous one was narration — flush it.
                if (pendingText !== null) {
                  onMessage({ type: "text_interim", content: pendingText });
                }
                pendingText = text;
              }
            }
            break;
          }

          case "result": {
            // Extract text result. Prefer the SDK's result field; fall back
            // to the buffered pendingText if the SDK didn't populate it.
            const result = msg.result as string | undefined;
            const finalText = (result && result.trim()) ? result : pendingText;
            if (finalText && finalText.trim()) {
              onMessage({
                type: "text",
                content: finalText,
              });
            }
            pendingText = null;

            // Extract usage data
            const totalCost = msg.total_cost_usd as number | undefined;
            const numTurns = msg.num_turns as number | undefined;
            const durationMs = msg.duration_ms as number | undefined;
            const durationApiMs = msg.duration_api_ms as number | undefined;
            const usage = msg.usage as Record<string, unknown> | undefined;
            const modelUsageMap = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;

            if (usage || modelUsageMap) {
              // Get per-model stats (first model entry)
              let contextWindow = 200_000; // default for Opus
              let maxOutputTokens = 16_384;
              if (modelUsageMap) {
                const firstModel = Object.values(modelUsageMap)[0];
                if (firstModel) {
                  contextWindow = (firstModel.contextWindow as number) || contextWindow;
                  maxOutputTokens = (firstModel.maxOutputTokens as number) || maxOutputTokens;
                }
              }

              queryUsage = {
                inputTokens: (usage?.input_tokens as number) || 0,
                outputTokens: (usage?.output_tokens as number) || 0,
                cacheReadTokens: (usage?.cache_read_input_tokens as number) || 0,
                cacheCreationTokens: (usage?.cache_creation_input_tokens as number) || 0,
                costUSD: totalCost || 0,
                numTurns: numTurns || 0,
                durationMs: durationMs || 0,
                durationApiMs: durationApiMs || 0,
                contextWindow,
                maxOutputTokens,
                lastTurnInputTokens,
              };

              // Log to console for PM2 visibility
              const cacheTotal = queryUsage.cacheReadTokens + queryUsage.cacheCreationTokens;
              const cacheHitPct = cacheTotal > 0
                ? Math.round((queryUsage.cacheReadTokens / cacheTotal) * 100)
                : 0;
              console.log(
                `[usage] ${queryUsage.inputTokens.toLocaleString()} in / ${queryUsage.outputTokens.toLocaleString()} out` +
                ` | cache: ${cacheHitPct}% hit (${queryUsage.cacheReadTokens.toLocaleString()} read, ${queryUsage.cacheCreationTokens.toLocaleString()} new)` +
                ` | $${queryUsage.costUSD.toFixed(4)} | ${queryUsage.numTurns} turns | ${(queryUsage.durationMs / 1000).toFixed(1)}s`
              );
            }
            break;
          }

          case "rate_limit_event": {
            const info = msg.rate_limit_info as Record<string, unknown> | undefined;
            if (info?.isUsingOverage) {
              onMessage({
                type: "system",
                content: "⚠️ Using overage billing — MAX quota may be exhausted.",
              });
            }
            break;
          }

          default:
            break;
        }
      }
      break; // Success — exit retry loop
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      if (attempt < maxAttempts && sdkOptions.resume) {
        // Resume failed — clear resume and retry with a fresh session
        console.error(`[agent] Session resume failed, retrying fresh: ${errMsg}`);
        delete sdkOptions.resume;
        onMessage({
          type: "system",
          content: "⚠️ Session resume failed — starting fresh session.",
        });
        continue;
      }

      onMessage({ type: "error", content: `Agent error: ${errMsg}` });
    }
  }

  return { sessionId: returnSessionId, usage: queryUsage, compacted };
}

/**
 * Resolves agent config from the global config and agent name.
 */
export function resolveAgentConfig(
  globalConfig: Record<string, unknown>,
  agentName: string
): AgentConfig {
  const agents = globalConfig.agents as Record<string, Record<string, unknown>>;
  const agentDef = agents[agentName];
  if (!agentDef) throw new Error(`Agent "${agentName}" not found in config`);

  const safety = globalConfig.safety as AgentConfig["safety"];
  const codex = globalConfig.codex as AgentConfig["codex"];
  const model = globalConfig.model as string;
  const behaviorDir = join(process.cwd(), agentDef.behavior_dir as string);
  const memoryDir = join(behaviorDir, "memory");

  // Optional per-agent Claude credential directory. Tilde (~/) expansion
  // resolves to $HOME. When omitted, the SDK uses default resolution
  // (~/.claude on macOS, falls back to Keychain on macOS).
  const rawClaudeConfigDir = agentDef.claude_config_dir as string | undefined;
  let claudeConfigDir: string | undefined;
  if (rawClaudeConfigDir) {
    claudeConfigDir = rawClaudeConfigDir.startsWith("~/")
      ? join(process.env.HOME || "/tmp", rawClaudeConfigDir.slice(2))
      : rawClaudeConfigDir;
  }

  return {
    name: agentName,
    behaviorDir,
    memoryDir,
    model,
    workingDir: process.env.WORKING_DIR || join(process.env.HOME || "/tmp", "projects"),
    codex,
    safety,
    announce_on_boot: agentDef.announce_on_boot === true,
    claudeConfigDir,
  };
}
