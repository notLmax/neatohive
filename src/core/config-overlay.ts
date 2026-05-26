/**
 * config-overlay.ts
 *
 * Two-file config layout for safe upgrades:
 *
 *   config/config.yaml         — committed. Platform settings + canonical
 *                                seed agents (house-md).
 *   config/agents.local.yaml   — gitignored. The owner's actual agents.
 *
 * The runtime merges them at boot. Local agents override committed ones
 * on key conflict. If `agents.local.yaml` doesn't exist, the loader falls
 * back to the committed agents alone — fully backward-compatible with the
 * pre-overlay layout.
 *
 * Why this matters: `git pull` (and `hive update`) must never delete or
 * silently change a Hive operator's running agent set. Keeping agents in
 * a gitignored file makes that impossible — the file is invisible to git.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

export const AGENTS_LOCAL_FILENAME = "agents.local.yaml";

/**
 * Resolve the local-agents file path next to the committed config file.
 * Exported so the migration script and the loader stay in sync on path.
 */
export function agentsLocalPath(configPath: string): string {
  return join(dirname(configPath), AGENTS_LOCAL_FILENAME);
}

/**
 * Pure merge function. Local wins on key collision. Committed agents that
 * are not redefined locally are preserved (so the canonical `house-md`
 * comes through even when an operator has only added new agents).
 *
 * Either side may be `null`/`undefined` (e.g., a freshly-cloned repo with
 * no agents.local.yaml yet). The function never mutates its inputs.
 */
export function mergeAgents(
  committed: Record<string, unknown> | null | undefined,
  local: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (committed && typeof committed === "object") {
    for (const [k, v] of Object.entries(committed)) out[k] = v;
  }
  if (local && typeof local === "object") {
    for (const [k, v] of Object.entries(local)) out[k] = v; // local overrides
  }
  return out;
}

export interface OverlayLoadResult {
  /** Final merged config object — agents now hold the merged map. */
  config: Record<string, unknown>;
  /** True if `agents.local.yaml` was found and read. */
  localOverlayPresent: boolean;
  /** Names of agents that were defined in BOTH files (local won). Useful
   *  for logging at boot so operators see what overrode what. */
  overriddenAgents: string[];
  /** Path of the local file (whether or not it exists). */
  localPath: string;
}

/**
 * Inject for tests so we can drive the loader without touching disk.
 */
export interface OverlayDeps {
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

/**
 * Load the committed config file and overlay `agents.local.yaml` if it
 * exists. Returns the merged result plus diagnostics.
 *
 * Behavior matrix:
 *   - committed only:       returns committed config (legacy behavior)
 *   - local only:           returns config with agents = local
 *   - both:                 agents = committed ∪ local, local wins
 *   - committed missing:    throws — same as before, refuse to start
 *   - local malformed:      throws explicitly — does NOT silently drop
 *
 * The throw on malformed-local is deliberate. Silent drop would mean an
 * operator's agents disappear on the next bot restart with no signal.
 * Loud failure is the safer default.
 */
export function loadConfigWithOverlay(
  configPath: string,
  deps: OverlayDeps = {},
): OverlayLoadResult {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p));

  const committedRaw = readFile(configPath);
  const committed = yaml.load(committedRaw) as Record<string, unknown> | null;
  if (!committed || typeof committed !== "object") {
    throw new Error(`config/config.yaml did not parse to an object`);
  }

  const localPath = agentsLocalPath(configPath);
  let local: Record<string, unknown> | null = null;
  let localOverlayPresent = false;

  if (fileExists(localPath)) {
    localOverlayPresent = true;
    const localRaw = readFile(localPath);
    let parsed: unknown;
    try {
      parsed = yaml.load(localRaw);
    } catch (err) {
      throw new Error(
        `${AGENTS_LOCAL_FILENAME} is not valid YAML (${
          err instanceof Error ? err.message : String(err)
        }). Refusing to start — silent drop would lose your agents.`,
      );
    }
    // The local file may use either of two shapes:
    //   shape A:  agents:\n  foo: ...    (top-level `agents:` key)
    //   shape B:  foo: ...               (top-level agent map)
    // Shape A matches the committed config layout; shape B is more concise.
    // We accept both.
    if (parsed === null || parsed === undefined) {
      local = null; // empty file — treat as no overlay
    } else if (
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `${AGENTS_LOCAL_FILENAME} did not parse to a YAML mapping at the top level.`,
      );
    } else {
      const obj = parsed as Record<string, unknown>;
      if (
        obj.agents &&
        typeof obj.agents === "object" &&
        !Array.isArray(obj.agents)
      ) {
        local = obj.agents as Record<string, unknown>;
      } else {
        local = obj;
      }
    }
  }

  const committedAgents =
    (committed.agents as Record<string, unknown> | undefined) ?? {};
  const merged = mergeAgents(committedAgents, local);

  const overridden = local
    ? Object.keys(local).filter((k) => k in committedAgents)
    : [];

  // Return a SHALLOW copy of the committed config with the merged agents
  // so the caller never accidentally mutates either source.
  const result = { ...committed, agents: merged };

  return {
    config: result,
    localOverlayPresent,
    overriddenAgents: overridden,
    localPath,
  };
}
