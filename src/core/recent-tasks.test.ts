/**
 * Tests for the "Recent Tasks" prompt section. Covers the recency
 * contract: live tasks always appear; terminal tasks only if finished
 * within 24h; max 10 entries; sort live-first then newest.
 */

process.env.TZ = "UTC";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectRecentTasks,
  renderRecentTasksSection,
} from "./recent-tasks.js";

function makeFs(files: Record<string, string>) {
  return {
    fileExists: (p: string) => p === "/tasks" || p in files,
    readFile: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readDir: () => Object.keys(files).map((p) => p.split("/").pop()!),
  };
}

function fixtureMd(opts: {
  task_id: string;
  status?: string;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  kind?: string;
}): string {
  return [
    "---",
    `task_id: ${opts.task_id}`,
    `agent: atlas`,
    `kind: ${opts.kind ?? "shell"}`,
    `cmd: "x"`,
    `status: ${opts.status ?? "running"}`,
    `started_at: ${opts.started_at === undefined ? "null" : opts.started_at === null ? "null" : `'${opts.started_at}'`}`,
    `finished_at: ${opts.finished_at === undefined ? "null" : opts.finished_at === null ? "null" : `'${opts.finished_at}'`}`,
    `exit_code: ${opts.exit_code === undefined || opts.exit_code === null ? "null" : opts.exit_code}`,
    `output_path: /tmp/x.log`,
    `timeout_minutes: 10`,
    `on_complete_prompt: null`,
    `on_failure_prompt: null`,
    `reply_to: null`,
    `delegated_by: null`,
    "---",
    "",
    "# Body",
  ].join("\n");
}

describe("collectRecentTasks", () => {
  const NOW = new Date("2026-04-29T12:00:00Z").getTime();

  it("returns [] when the tasks dir doesn't exist", () => {
    const r = collectRecentTasks("/tasks", {
      fileExists: () => false,
      readFile: () => "",
      readDir: () => [],
      now: () => NOW,
    });
    assert.deepEqual(r, []);
  });

  it("includes live (pending/running) tasks regardless of age", () => {
    const r = collectRecentTasks("/tasks", {
      ...makeFs({
        "/tasks/t_live.md": fixtureMd({
          task_id: "t_live",
          status: "running",
          started_at: "2026-04-01T00:00:00Z", // 28 days old, still live
        }),
      }),
      now: () => NOW,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].task_id, "t_live");
  });

  it("includes terminal tasks only if finished within 24h", () => {
    const within = "2026-04-29T06:00:00Z"; // 6h ago
    const old = "2026-04-27T12:00:00Z"; // 48h ago
    const r = collectRecentTasks("/tasks", {
      ...makeFs({
        "/tasks/t_recent.md": fixtureMd({
          task_id: "t_recent",
          status: "done",
          started_at: "2026-04-29T05:00:00Z",
          finished_at: within,
          exit_code: 0,
        }),
        "/tasks/t_old.md": fixtureMd({
          task_id: "t_old",
          status: "done",
          started_at: "2026-04-27T11:00:00Z",
          finished_at: old,
          exit_code: 0,
        }),
      }),
      now: () => NOW,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].task_id, "t_recent");
  });

  it("sorts live tasks first (newest), then recent terminals (newest)", () => {
    const r = collectRecentTasks("/tasks", {
      ...makeFs({
        "/tasks/t_live_old.md": fixtureMd({
          task_id: "t_live_old",
          status: "running",
          started_at: "2026-04-29T08:00:00Z",
        }),
        "/tasks/t_live_new.md": fixtureMd({
          task_id: "t_live_new",
          status: "running",
          started_at: "2026-04-29T11:00:00Z",
        }),
        "/tasks/t_done_recent.md": fixtureMd({
          task_id: "t_done_recent",
          status: "done",
          finished_at: "2026-04-29T11:30:00Z",
          exit_code: 0,
        }),
      }),
      now: () => NOW,
    });
    assert.deepEqual(
      r.map((x) => x.task_id),
      ["t_live_new", "t_live_old", "t_done_recent"],
    );
  });

  it("caps the result at 10 entries", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      files[`/tasks/t_${i}.md`] = fixtureMd({
        task_id: `t_${i}`,
        status: "running",
        started_at: `2026-04-29T${String(i).padStart(2, "0")}:00:00Z`,
      });
    }
    const r = collectRecentTasks("/tasks", {
      ...makeFs(files),
      now: () => NOW,
    });
    assert.equal(r.length, 10);
  });

  it("skips non-md files and malformed frontmatter", () => {
    const r = collectRecentTasks("/tasks", {
      fileExists: () => true,
      readFile: (p: string) => {
        if (p.endsWith("good.md")) {
          return fixtureMd({ task_id: "t_good", status: "running" });
        }
        if (p.endsWith("bad.md")) return "no frontmatter here";
        throw new Error("ENOENT");
      },
      readDir: () => ["good.md", "bad.md", "ignore.txt"],
      now: () => NOW,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].task_id, "t_good");
  });
});

describe("renderRecentTasksSection", () => {
  it("returns empty string for empty list (caller skips section)", () => {
    assert.equal(renderRecentTasksSection([]), "");
  });

  it("renders a markdown table with the right columns", () => {
    const out = renderRecentTasksSection([
      {
        task_id: "t_a",
        agent: "atlas",
        kind: "codex",
        cmd: "x",
        status: "running",
        started_at: "2026-04-29T12:00:00Z",
        finished_at: null,
        exit_code: null,
      },
    ]);
    assert.match(out, /# Recent Tasks/);
    assert.match(out, /\| Task ID \| Kind \| Status \| Exit \| Started \| Finished \|/);
    assert.match(out, /t_a \| codex \| running \| — \| 2026-04-29T12:00:00Z \| —/);
  });
});
