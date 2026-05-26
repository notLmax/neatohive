/**
 * cli/config-migrate-agents.ts
 *
 * `hive config migrate-agents` — moves the operator's agent definitions
 * out of the version-controlled `config/config.yaml` into the gitignored
 * `config/agents.local.yaml`. After this, `git pull` and `hive update`
 * cannot affect your agent set, ever.
 *
 * Behavior is deliberately conservative:
 *   1. Never destroys data — the original `config.yaml` is backed up
 *      before any rewrite.
 *   2. Refuses to run if `agents.local.yaml` already exists (would
 *      otherwise risk overwriting a previous migration's output).
 *   3. Writes `agents.local.yaml` first, then asks the operator (via
 *      stdout instructions) whether to also reset `config.yaml` —
 *      does NOT silently rewrite the committed file.
 *
 * Result: agents.local.yaml exists with every agent the operator was
 * running. Even if `config.yaml` still has them too, the loader merges
 * both — local wins, no double-load. The operator can clean up
 * `config.yaml` at their leisure (or let the next upstream pull do it).
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import {
  AGENTS_LOCAL_FILENAME,
  agentsLocalPath,
} from "../core/config-overlay.js";

interface ParsedConfig {
  raw: string;
  obj: Record<string, unknown>;
  agents: Record<string, unknown>;
}

function loadConfig(configPath: string): ParsedConfig {
  const raw = readFileSync(configPath, "utf-8");
  const obj = yaml.load(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") {
    throw new Error(`${configPath} did not parse as a YAML mapping`);
  }
  const agents = (obj.agents as Record<string, unknown>) ?? {};
  return { raw, obj, agents };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function main(): void {
  const baseDir = process.cwd();
  const configPath = join(baseDir, "config", "config.yaml");
  if (!existsSync(configPath)) {
    console.error(`[migrate] missing ${configPath}`);
    process.exit(1);
  }

  const localPath = agentsLocalPath(configPath);
  if (existsSync(localPath)) {
    console.error(
      `[migrate] ${AGENTS_LOCAL_FILENAME} already exists at ${localPath}.`,
    );
    console.error(
      `[migrate] Refusing to overwrite. If you really want to redo the migration,`,
    );
    console.error(
      `[migrate] move it aside first:`,
    );
    console.error(`[migrate]   mv ${localPath} ${localPath}.old`);
    process.exit(1);
  }

  let parsed: ParsedConfig;
  try {
    parsed = loadConfig(configPath);
  } catch (err) {
    console.error(
      `[migrate] ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  const agentNames = Object.keys(parsed.agents);
  if (agentNames.length === 0) {
    console.error(
      `[migrate] no agents found in ${configPath} — nothing to migrate.`,
    );
    process.exit(0);
  }

  // Always back up. Even if the operator ultimately decides not to clean
  // config.yaml, having a known-good snapshot is cheap insurance.
  const backupPath = `${configPath}.backup-${timestamp()}`;
  copyFileSync(configPath, backupPath);

  // Write the local overlay. Use the SAME shape as the committed config
  // so the contents are familiar to operators reading the file.
  const localContent =
    `# config/agents.local.yaml — your local agent definitions.\n` +
    `#\n` +
    `# This file is gitignored. It will NEVER be touched by \`git pull\`\n` +
    `# or \`hive update\`. Agents listed here override anything with the\n` +
    `# same name in the committed config/config.yaml.\n` +
    `#\n` +
    `# To add a new agent, append to the agents map below. To remove one,\n` +
    `# delete its entry. Restart the affected agent process for changes to\n` +
    `# take effect.\n` +
    `\n` +
    `agents:\n` +
    yaml
      .dump({ agents: parsed.agents }, { lineWidth: -1, noRefs: true })
      .replace(/^agents:\n/, "");

  try {
    writeFileSync(localPath, localContent);
  } catch (err) {
    console.error(
      `[migrate] failed to write ${localPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }

  console.log(`[migrate] ✓ wrote ${localPath} (${agentNames.length} agent(s))`);
  console.log(`[migrate] ✓ backup: ${backupPath}`);
  console.log("");
  console.log(`Migrated agents: ${agentNames.join(", ")}`);
  console.log("");
  console.log("Next steps (optional, but recommended):");
  console.log("");
  console.log(
    "  Your config.yaml still contains these agents. The runtime works fine",
  );
  console.log(
    "  either way (local overlay wins on conflict), but to make `git pull`",
  );
  console.log(
    "  fully conflict-free in the future, restore config.yaml to its upstream",
  );
  console.log("  form:");
  console.log("");
  console.log("    git fetch origin");
  console.log("    git checkout origin/main -- config/config.yaml");
  console.log("");
  console.log(
    "  After that, your agents.local.yaml is the source of truth. config.yaml",
  );
  console.log(
    "  only carries platform settings (model, codex, safety) and the canonical",
  );
  console.log("  house-md seed.");
  console.log("");
  console.log(
    "Backout: if anything goes wrong, restore from the backup above and delete",
  );
  console.log("the local file:");
  console.log("");
  console.log(`  cp ${backupPath} ${configPath}`);
  console.log(`  rm ${localPath}`);
}

main();
