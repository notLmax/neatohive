/**
 * index.ts
 * Neato Hive — entry point.
 * 
 * Usage: node dist/index.js --agent <agent-name>
 * 
 * Each agent runs as its own process with its own Discord bot.
 * PM2 manages each agent independently:
 *   pm2 start dist/index.js --name dinesh -- --agent dinesh
 *   pm2 start dist/index.js --name house-md -- --agent house-md
 */

import "dotenv/config";
import { startBot } from "./discord/bot.js";
import { initCronJobs } from "./tools/cron.js";
import { registerDiscordClient } from "./tools/messaging.js";
import { loadUsers } from "./core/users.js";
import { loadConfigWithOverlay } from "./core/config-overlay.js";
import { resolveAgentConfig } from "./core/agent.js";
import { join } from "path";

function getAgentName(): string {
  const idx = process.argv.indexOf("--agent");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error("Usage: node dist/index.js --agent <agent-name>");
    console.error("Example: node dist/index.js --agent dinesh");
    process.exit(1);
  }
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const agentName = getAgentName();

  // Propagate agent name to child processes (claude, codex, shell, hive update).
  // Consumed by bin/hive cmd_update for self-update detection (v1.4.0+).
  process.env.HIVE_AGENT_NAME = agentName;

  const tokenEnvVar = `DISCORD_BOT_TOKEN_${agentName.toUpperCase().replace(/-/g, "_")}`;
  const token = process.env[tokenEnvVar];

  if (!token) {
    console.error(`Missing ${tokenEnvVar} in .env`);
    console.error(`Add: ${tokenEnvVar}=<your bot token>`);
    process.exit(1);
  }

  const users = loadUsers({
    configPath: join(process.cwd(), "config", "users.local.yaml"),
    ownerIdEnv: process.env.DISCORD_OWNER_ID,
    authorizedUsersEnv: process.env.DISCORD_AUTHORIZED_USERS ?? "",
  });
  console.log(`[users] Loaded ${users.users.length} user(s); owner=${users.ownerUser.name} (${users.ownerUser.discord_ids.length} discord ID(s))`);

  console.log("================================================");
  console.log(`  Neato Hive — ${agentName}`);
  console.log("================================================");
  console.log();

  const configPath = join(process.cwd(), "config", "config.yaml");
  console.log(`[config] Loading from ${configPath}`);

  // Multi-account auth isolation: if this agent has claude_config_dir
  // set in agents.local.yaml, propagate to the Claude Agent SDK via
  // CLAUDE_CONFIG_DIR env var BEFORE startBot loads the SDK. The SDK
  // reads credentials from <dir>/.credentials.json when this is set.
  // Skipped silently when the field is absent — preserves default auth.
  try {
    const cfg = loadConfigWithOverlay(configPath);
    const agentCfg = resolveAgentConfig(cfg.config, agentName);
    if (agentCfg.claudeConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = agentCfg.claudeConfigDir;
      console.log(`[auth] Claude: CLAUDE_CONFIG_DIR=${agentCfg.claudeConfigDir}`);
    } else {
      console.log(`[auth] Claude: using CLI-managed auth (default)`);
    }
  } catch (e) {
    console.warn(`[auth] Could not resolve claude_config_dir: ${e instanceof Error ? e.message : String(e)} — falling back to default auth`);
  }

  const client = await startBot({
    token,
    users,
    configPath,
    agentName,
  });

  // Register Discord client for cross-channel messaging tool
  registerDiscordClient(client);

  // Initialize persisted cron jobs
  initCronJobs();

  console.log();
  console.log(`[ready] ${agentName} is online.`);

  const shutdown = async () => {
    console.log("\n[shutdown] Shutting down...");
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
