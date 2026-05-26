/**
 * Tests for wake-prompt-boot.ts — boot-announce prompt rendering.
 */

process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildBootWakePrompt, type BuildBootWakePromptInput } from "./wake-prompt-boot.js";

function baseInput(overrides: Partial<BuildBootWakePromptInput> = {}): BuildBootWakePromptInput {
  return {
    agent: "house-md",
    version: "1.3.6",
    bootEntry: { ts: "2026-04-29T22:14:33Z", version: "1.3.6", pid: 42 },
    recentTasks: [],
    dailyMemoryTail: "",
    ...overrides,
  };
}

describe("buildBootWakePrompt", () => {
  it("includes wake-mode tag and version", () => {
    const prompt = buildBootWakePrompt(baseInput());
    assert.ok(prompt.includes("[autonomy-v1 wake — agent restart detected]"));
    assert.ok(prompt.includes("**Version:** v1.3.6"));
    assert.ok(prompt.includes("**Boot at:** 2026-04-29T22:14:33Z"));
    assert.ok(prompt.includes("**PID:** 42"));
  });

  it("shows no tasks when recentTasks is empty", () => {
    const prompt = buildBootWakePrompt(baseInput());
    assert.ok(prompt.includes("**Recent tasks (last 24h):** none"));
  });

  it("lists recent tasks when provided", () => {
    const prompt = buildBootWakePrompt(baseInput({
      recentTasks: ["t-abc (shell) → done"],
    }));
    assert.ok(prompt.includes("**Recent tasks (last 24h):** 1"));
    assert.ok(prompt.includes("  - t-abc (shell) → done"));
  });

  it("lists multiple recent tasks", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => `task-${i} (claude) → done`);
    const prompt = buildBootWakePrompt(baseInput({ recentTasks: tasks }));
    assert.ok(prompt.includes("**Recent tasks (last 24h):** 10"));
    assert.ok(prompt.includes("  - task-0 (claude) → done"));
    assert.ok(prompt.includes("  - task-9 (claude) → done"));
  });

  it("shows no daily memory when empty", () => {
    const prompt = buildBootWakePrompt(baseInput());
    assert.ok(prompt.includes("**Daily memory:** _(no entries today)_"));
  });

  it("includes daily memory tail when provided", () => {
    const prompt = buildBootWakePrompt(baseInput({
      dailyMemoryTail: "- [wake] task t-1 (shell) → done\n- [wake] task t-2 (claude) → failed",
    }));
    assert.ok(prompt.includes("**Daily memory (last 5 lines):**"));
    assert.ok(prompt.includes("- [wake] task t-1 (shell) → done"));
    assert.ok(prompt.includes("- [wake] task t-2 (claude) → failed"));
  });

  it("includes sendToOwnChannel instruction", () => {
    const prompt = buildBootWakePrompt(baseInput());
    assert.ok(prompt.includes("sendToOwnChannel"));
    assert.ok(prompt.includes("back online"));
  });

  it("includes wake-mode disclaimer", () => {
    const prompt = buildBootWakePrompt(baseInput());
    assert.ok(prompt.includes("wake-mode turn"));
    assert.ok(prompt.includes("NOT auto-posted"));
  });
});
