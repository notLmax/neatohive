/**
 * Tests for the config overlay loader. Covers every case where an
 * upgrade/restart could affect an operator's agent set, with particular
 * focus on the safety-critical "your agents must not silently disappear"
 * paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import {
  AGENTS_LOCAL_FILENAME,
  agentsLocalPath,
  mergeAgents,
  loadConfigWithOverlay,
} from "./config-overlay.js";

// ── agentsLocalPath ───────────────────────────────────────────

describe("agentsLocalPath", () => {
  it("places the overlay next to the committed config file", () => {
    const p = agentsLocalPath("/repo/config/config.yaml");
    assert.equal(p, "/repo/config/agents.local.yaml");
  });
  it("AGENTS_LOCAL_FILENAME is the expected constant", () => {
    assert.equal(AGENTS_LOCAL_FILENAME, "agents.local.yaml");
  });
});

// ── mergeAgents ───────────────────────────────────────────────

describe("mergeAgents", () => {
  it("returns committed agents when local is absent", () => {
    const merged = mergeAgents(
      { "house-md": { channels: ["house-md"] } },
      null,
    );
    assert.deepEqual(merged, { "house-md": { channels: ["house-md"] } });
  });

  it("returns local agents when committed is absent", () => {
    const merged = mergeAgents(null, {
      atlas: { channels: ["atlas"] },
    });
    assert.deepEqual(merged, { atlas: { channels: ["atlas"] } });
  });

  it("preserves committed agents that are NOT redefined locally", () => {
    // Critical case: house-md is committed, operator only added atlas
    // locally. Merge must return BOTH — losing house-md would mean a
    // fresh-clone Hive operator's only seed agent disappears.
    const merged = mergeAgents(
      { "house-md": { channels: ["house-md"] } },
      { atlas: { channels: ["atlas"] } },
    );
    assert.deepEqual(Object.keys(merged).sort(), ["atlas", "house-md"]);
  });

  it("local agents override committed on key collision", () => {
    const merged = mergeAgents(
      { "house-md": { channels: ["house-md"], model: "old-model" } },
      { "house-md": { channels: ["house-md"], model: "new-model" } },
    );
    assert.deepEqual((merged["house-md"] as any).model, "new-model");
  });

  it("never mutates either input", () => {
    const committed = { a: { v: 1 } };
    const local = { b: { v: 2 } };
    mergeAgents(committed, local);
    assert.deepEqual(committed, { a: { v: 1 } });
    assert.deepEqual(local, { b: { v: 2 } });
  });

  it("treats undefined inputs as empty", () => {
    assert.deepEqual(mergeAgents(undefined, undefined), {});
  });
});

// ── loadConfigWithOverlay ─────────────────────────────────────

describe("loadConfigWithOverlay", () => {
  function makeFs(files: Record<string, string>) {
    return {
      readFile: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      fileExists: (p: string) => p in files,
    };
  }

  const COMMITTED_BASIC = yaml.dump({
    model: "claude-opus-4-7",
    agents: {
      "house-md": { channels: ["house-md"], behavior_dir: "agents/house-md" },
    },
    safety: { blocked_commands: ["rm -rf /"] },
  });

  it("returns committed config unchanged when no overlay is present (legacy mode)", () => {
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({ "/repo/config/config.yaml": COMMITTED_BASIC }),
    );
    assert.equal(r.localOverlayPresent, false);
    assert.deepEqual(r.overriddenAgents, []);
    assert.deepEqual(Object.keys(r.config.agents as object), ["house-md"]);
  });

  it("merges local overlay agents on top of committed ones", () => {
    // Committed: house-md. Local: atlas + glados. Merged: 3.
    const local = yaml.dump({
      agents: {
        atlas: { channels: ["atlas"], behavior_dir: "agents/atlas" },
        glados: { channels: ["glados"], behavior_dir: "agents/glados" },
      },
    });
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({
        "/repo/config/config.yaml": COMMITTED_BASIC,
        "/repo/config/agents.local.yaml": local,
      }),
    );
    assert.equal(r.localOverlayPresent, true);
    assert.deepEqual(
      Object.keys(r.config.agents as object).sort(),
      ["atlas", "glados", "house-md"],
    );
    assert.deepEqual(r.overriddenAgents, []);
  });

  it("operator who added agents but never touched house-md still gets house-md", () => {
    // The "your agents must not silently disappear" headline test —
    // expressed from the reverse direction (committed agents must also
    // not disappear when local overlay is present).
    const local = yaml.dump({
      agents: { atlas: { channels: ["atlas"] } },
    });
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({
        "/repo/config/config.yaml": COMMITTED_BASIC,
        "/repo/config/agents.local.yaml": local,
      }),
    );
    const names = Object.keys(r.config.agents as object);
    assert.ok(names.includes("house-md"), "house-md must survive merge");
    assert.ok(names.includes("atlas"), "local atlas must be loaded");
  });

  it("local override flags the agent in overriddenAgents", () => {
    const local = yaml.dump({
      agents: {
        "house-md": { channels: ["house-md"], model: "different" },
      },
    });
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({
        "/repo/config/config.yaml": COMMITTED_BASIC,
        "/repo/config/agents.local.yaml": local,
      }),
    );
    assert.deepEqual(r.overriddenAgents, ["house-md"]);
    assert.equal(
      ((r.config.agents as any)["house-md"] as any).model,
      "different",
    );
  });

  it("accepts shape B (top-level agent map without `agents:` key)", () => {
    const localFlat = yaml.dump({
      atlas: { channels: ["atlas"] },
    });
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({
        "/repo/config/config.yaml": COMMITTED_BASIC,
        "/repo/config/agents.local.yaml": localFlat,
      }),
    );
    assert.ok((r.config.agents as any).atlas);
    assert.ok(
      (r.config.agents as any)["house-md"],
      "house-md must still come through",
    );
  });

  it("empty local file is treated as no overlay (just-created template case)", () => {
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({
        "/repo/config/config.yaml": COMMITTED_BASIC,
        "/repo/config/agents.local.yaml": "",
      }),
    );
    assert.equal(r.localOverlayPresent, true);
    // Still get committed agents.
    assert.ok((r.config.agents as any)["house-md"]);
  });

  it("malformed local YAML throws — does NOT silently drop agents", () => {
    // The crucial safety property: a bad file is loud, not silent.
    assert.throws(
      () =>
        loadConfigWithOverlay(
          "/repo/config/config.yaml",
          makeFs({
            "/repo/config/config.yaml": COMMITTED_BASIC,
            "/repo/config/agents.local.yaml": "this: is: not: valid: yaml: [",
          }),
        ),
      /not valid YAML/i,
    );
  });

  it("malformed top-level (non-mapping) local file throws", () => {
    assert.throws(
      () =>
        loadConfigWithOverlay(
          "/repo/config/config.yaml",
          makeFs({
            "/repo/config/config.yaml": COMMITTED_BASIC,
            "/repo/config/agents.local.yaml": yaml.dump([1, 2, 3]),
          }),
        ),
      /YAML mapping/,
    );
  });

  it("missing committed config throws (no silent fallback to local-only)", () => {
    // If config.yaml itself is missing, that's a real error — refusing
    // to start is correct behavior. Local overlay alone is not enough.
    assert.throws(
      () =>
        loadConfigWithOverlay(
          "/repo/config/config.yaml",
          makeFs({
            "/repo/config/agents.local.yaml": yaml.dump({
              agents: { atlas: {} },
            }),
          }),
        ),
      /ENOENT/,
    );
  });

  it("preserves non-agent sections (model, codex, safety) untouched", () => {
    // Operators should be able to upgrade with confidence that platform
    // settings are honored even when the overlay is active.
    const local = yaml.dump({
      agents: { atlas: { channels: ["atlas"] } },
    });
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({
        "/repo/config/config.yaml": COMMITTED_BASIC,
        "/repo/config/agents.local.yaml": local,
      }),
    );
    assert.equal(r.config.model, "claude-opus-4-7");
    assert.deepEqual((r.config as any).safety, {
      blocked_commands: ["rm -rf /"],
    });
  });

  it("returned config is a fresh object (caller can't mutate the inputs)", () => {
    const r = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({ "/repo/config/config.yaml": COMMITTED_BASIC }),
    );
    (r.config.agents as any).injected = { hostile: true };
    // Re-load — the injected key must not appear.
    const r2 = loadConfigWithOverlay(
      "/repo/config/config.yaml",
      makeFs({ "/repo/config/config.yaml": COMMITTED_BASIC }),
    );
    assert.equal((r2.config.agents as any).injected, undefined);
  });
});
