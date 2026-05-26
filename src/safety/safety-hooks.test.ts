/**
 * Tests for safety-hooks.ts
 *
 * Covers:
 *  - The three bugs surfaced by atlas and glados on 2026-04-22 (config paths
 *    in tilde form vs absolute candidate paths).
 *  - The protected-path leak for absolute-form inputs (originally described
 *    as the "~/.ssh" leak in the first revision of this PR).
 *  - Atlas's review blockers: HOME-unset, `..` traversal, darwin
 *    case-sensitivity, `$HOME` variable expansion, protected-before-
 *    destructive check ordering, display path form in errors.
 *
 * Run: `pnpm test` (or `tsx --test src/safety/*.test.ts`).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  createSafetyHooks,
  expandPath,
  stripQuotedStrings,
  pathIsUnder,
  resolveForCompare,
  casefoldForPlatform,
} from "./safety-hooks.js";

// Deterministic HOME for tests. Override process.env for the tests that need
// the "HOME unset" path; we rely on os.homedir() everywhere else, which
// consults the OS rather than just the env var.
const HOME = os.homedir();

// --- Helpers for invoking hook callbacks directly ---

const baseConfig = {
  blocked_commands: ["rm -rf /", "sudo rm", "mkfs"],
  allowed_paths: ["~/projects", "~/hive", "/tmp"],
  protected_paths: ["~/.ssh", "~/.codex", "/etc", "/usr"],
};

type HookResult = {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
};

async function invokeBash(command: string, cfg = baseConfig): Promise<HookResult> {
  const hooks = createSafetyHooks(cfg);
  const hook = hooks.PreToolUse.find((m) => m.matcher === "Bash")!.hooks[0];
  return (await hook({ tool_input: { command } } as any, undefined)) as HookResult;
}

async function invokeWrite(
  filepath: string,
  cfg = baseConfig,
  tool: "Write" | "Edit" = "Write",
): Promise<HookResult> {
  const hooks = createSafetyHooks(cfg);
  const hook = hooks.PreToolUse.find((m) => m.matcher === tool)!.hooks[0];
  return (await hook({ tool_input: { file_path: filepath } } as any, undefined)) as HookResult;
}

const isDeny = (r: HookResult) =>
  r.hookSpecificOutput?.permissionDecision === "deny";
const isAllow = (r: HookResult) =>
  !r.hookSpecificOutput || r.hookSpecificOutput.permissionDecision !== "deny";
const reason = (r: HookResult) =>
  r.hookSpecificOutput?.permissionDecisionReason ?? "";

// --- Helper units ---

describe("expandPath", () => {
  it("expands bare ~", () => {
    assert.equal(expandPath("~"), HOME);
  });

  it("expands ~/foo", () => {
    assert.equal(expandPath("~/foo"), `${HOME}/foo`);
  });

  it("leaves absolute paths alone", () => {
    assert.equal(expandPath("/etc/passwd"), "/etc/passwd");
  });

  it("leaves ~user form alone (not supported, should pass through)", () => {
    assert.equal(expandPath("~other/foo"), "~other/foo");
  });

  it("handles empty string safely", () => {
    assert.equal(expandPath(""), "");
  });

  it("is resilient when process.env.HOME is unset (uses os.homedir)", () => {
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      // os.homedir() consults OS APIs beyond env.HOME, so the expansion must
      // still produce a non-empty absolute path.
      const out = expandPath("~/.ssh");
      assert.ok(out.startsWith("/"), `expected absolute, got ${out}`);
      assert.ok(!out.startsWith("/.ssh"), `HOME fallback regressed: ${out}`);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
    }
  });
});

describe("stripQuotedStrings", () => {
  it("strips single-quoted content", () => {
    assert.equal(stripQuotedStrings("grep '>/foo' file"), "grep '' file");
  });

  it("strips double-quoted content", () => {
    assert.equal(stripQuotedStrings('grep ">/foo" file'), 'grep "" file');
  });

  it("preserves unquoted structure", () => {
    assert.equal(stripQuotedStrings("echo hi > /tmp/x"), "echo hi > /tmp/x");
  });

  it("handles multiple quoted segments", () => {
    assert.equal(stripQuotedStrings(`echo 'a' "b" 'c'`), `echo '' "" ''`);
  });

  it("bash single quotes: closes at first ' (no escaping)", () => {
    // `echo 'foo\' bar'` in bash closes at the first `'`; our regex should
    // match the same span. After stripping we should see '' plus bar'.
    assert.equal(stripQuotedStrings("echo 'foo\\' bar'"), "echo '' bar'");
  });
});

describe("pathIsUnder", () => {
  it("matches exact path", () => {
    assert.equal(pathIsUnder("/foo", "/foo"), true);
  });

  it("matches descendant", () => {
    assert.equal(pathIsUnder("/foo/bar", "/foo"), true);
  });

  it("rejects sibling with shared prefix", () => {
    assert.equal(pathIsUnder("/x/hive-archive", "/x/hive"), false);
  });

  it("rejects unrelated path", () => {
    assert.equal(pathIsUnder("/tmp", "/etc"), false);
  });

  it("on darwin: case-insensitive match (APFS default)", () => {
    if (process.platform !== "darwin") return;
    assert.equal(pathIsUnder("/USERS/x/.ssh", "/Users/x/.ssh"), true);
  });
});

describe("resolveForCompare", () => {
  it("collapses .. segments", () => {
    const r = resolveForCompare("/a/b/../c");
    assert.equal(r, "/a/c");
  });

  it("leaves clean absolute paths alone", () => {
    assert.equal(resolveForCompare("/a/b"), "/a/b");
  });
});

describe("casefoldForPlatform", () => {
  it("lowercases on darwin", () => {
    if (process.platform !== "darwin") return;
    assert.equal(casefoldForPlatform("/Users/X"), "/users/x");
  });
});

// --- Bug regressions: allowed-path false negative ---

describe("Write/Edit allowed-path check (bug surfaced by atlas/glados)", () => {
  it("ALLOWS absolute-path write under ~/projects (atlas repro)", async () => {
    const r = await invokeWrite(
      `${HOME}/projects/neato-hive/agents/atlas/memory/2026-04-22.md`,
    );
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("ALLOWS absolute-path Edit under ~/projects (glados repro)", async () => {
    const r = await invokeWrite(
      `${HOME}/projects/neato-hive/agents/glados/LESSONS.md`,
      baseConfig,
      "Edit",
    );
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("ALLOWS tilde-form write under ~/projects", async () => {
    const r = await invokeWrite("~/projects/neato-hive/agents/p-body/MEMORY.md");
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("ALLOWS write to /tmp (no tilde involved)", async () => {
    const r = await invokeWrite("/tmp/scratch.txt");
    assert.ok(isAllow(r));
  });

  it("BLOCKS write outside allowed directories", async () => {
    const r = await invokeWrite("/var/log/other.log");
    assert.ok(isDeny(r));
  });
});

// --- Protected-path absolute-form leak ---

describe("protected-path leak on absolute-form inputs", () => {
  it("BLOCKS Write with absolute path to ~/.ssh/authorized_keys", async () => {
    const r = await invokeWrite(`${HOME}/.ssh/authorized_keys`);
    assert.ok(isDeny(r), `expected deny, got: ${reason(r)}`);
  });

  it("BLOCKS Write with tilde-form path to ~/.ssh/authorized_keys", async () => {
    const r = await invokeWrite("~/.ssh/authorized_keys");
    assert.ok(isDeny(r));
  });

  it("BLOCKS Edit with absolute path to ~/.ssh/id_rsa", async () => {
    const r = await invokeWrite(`${HOME}/.ssh/id_rsa`, baseConfig, "Edit");
    assert.ok(isDeny(r));
  });

  it("BLOCKS Bash command targeting absolute ~/.ssh path", async () => {
    const r = await invokeBash(`echo pwned >> ${HOME}/.ssh/authorized_keys`);
    assert.ok(isDeny(r), `expected deny, got: ${reason(r)}`);
  });

  it("BLOCKS Bash command targeting tilde-form ~/.ssh path", async () => {
    const r = await invokeBash(`cat ~/.ssh/id_rsa`);
    assert.ok(isDeny(r));
  });
});

// --- New: .. traversal (Atlas blocker b) ---

describe("path traversal via ..", () => {
  it("BLOCKS Write to ~/projects/../../etc/passwd", async () => {
    const r = await invokeWrite(`${HOME}/projects/../../etc/passwd`);
    assert.ok(isDeny(r), `expected deny, got: ${reason(r)}`);
  });

  it("BLOCKS Write whose resolved path escapes to a protected dir", async () => {
    const r = await invokeWrite(`${HOME}/projects/./foo/../../../../etc/shadow`);
    assert.ok(isDeny(r));
  });

  it("BLOCKS Bash rm -rf with .. traversal out of allowed", async () => {
    const r = await invokeBash(
      `rm -rf ${HOME}/projects/../../etc/passwd`,
    );
    assert.ok(isDeny(r));
  });
});

// --- New: $HOME expansion (Atlas blocker d) ---

describe("$HOME / ${HOME} expansion in Bash commands", () => {
  it("BLOCKS cat $HOME/.ssh/id_rsa", async () => {
    const r = await invokeBash(`cat $HOME/.ssh/id_rsa`);
    assert.ok(isDeny(r), `expected deny, got: ${reason(r)}`);
  });

  it("BLOCKS cat ${HOME}/.ssh/id_rsa", async () => {
    const r = await invokeBash(`cat \${HOME}/.ssh/id_rsa`);
    assert.ok(isDeny(r));
  });

  it("BLOCKS cat \"$HOME/.ssh/id_rsa\" (double-quoted)", async () => {
    const r = await invokeBash(`cat "$HOME/.ssh/id_rsa"`);
    assert.ok(isDeny(r));
  });
});

// --- New: darwin case-sensitivity (Atlas c) ---

describe("darwin case-insensitive filesystem", () => {
  it("BLOCKS Write to /USERS/... (uppercase alias) on darwin", async () => {
    if (process.platform !== "darwin") return;
    const upper = `${HOME.replace(/^\/Users/, "/USERS")}/.ssh/authorized_keys`;
    const r = await invokeWrite(upper);
    assert.ok(isDeny(r), `expected deny, got: ${reason(r)}`);
  });
});

// --- Destructive-pattern allowlist + narrowed regex ---

describe("destructive-pattern allowlist + narrowed redirect regex", () => {
  it("ALLOWS rm -rf of a directory under ~/projects (absolute form)", async () => {
    const r = await invokeBash(`rm -rf ${HOME}/projects/scratch/tmp`);
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("ALLOWS rm -rf of a directory under ~/projects (tilde form)", async () => {
    const r = await invokeBash(`rm -rf ~/projects/scratch`);
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("ALLOWS rm -rf under /tmp", async () => {
    const r = await invokeBash(`rm -rf /tmp/scratch`);
    assert.ok(isAllow(r));
  });

  it("BLOCKS rm -rf targeting /etc", async () => {
    const r = await invokeBash(`rm -rf /etc/passwd`);
    assert.ok(isDeny(r));
  });

  it("does NOT trip destructive pattern on grep with '>/foo' in quoted arg", async () => {
    const r = await invokeBash(`grep '>/foo' /tmp/testfile`);
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("does NOT trip destructive pattern on 2>/dev/null stderr redirect", async () => {
    // Was the false positive Atlas traced back to the broad />\s*\/ regex.
    // Narrowed regex plus the (unchanged) allowlist escape should both permit this.
    const r = await invokeBash(`ls ${HOME}/projects 2>/dev/null`);
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  // --- Atlas follow-up (PR #4 post-merge review) ---
  // These lock the redirect-regex behaviour that the earlier narrowing broke:
  //   (a) a fd-prefixed stderr redirect on a command with NO allowed path
  //       must still be allowed (the allowlist escape doesn't save it because
  //       paths.length === 0 → allAllowed === false);
  //   (b) a no-space redirect to a path outside allowed dirs must still be
  //       blocked (old />\s*\/ matched this; the `(?:^|[\s;|&`(])(?:\d*)>`
  //       form silently regressed it).

  it("does NOT trip on date 2>/dev/null (no allowed path in command)", async () => {
    // Regression test for the claimed-but-not-delivered false-positive fix.
    // With the previous `(?:\d*)>` regex this still matched; since extractPaths
    // returns [] for this command, `allAllowed` was false and the hook blocked
    // with a misleading "destructive pattern" error.
    const r = await invokeBash(`date 2>/dev/null`);
    assert.ok(isAllow(r), `expected allow, got: ${reason(r)}`);
  });

  it("BLOCKS redirect-without-space to a path outside allowed dirs", async () => {
    // Regression test for the bypass the previous narrowing introduced.
    // `echo hi>/Users/x/Documents/foo.txt` — no space before `>` — was matched
    // by the original />\s*\/ pattern and blocked (extractPaths returned [],
    // so allAllowed was false). The `(?:^|[\s;|&`(])(?:\d*)>` form required a
    // boundary char before the operator and stopped matching this shape,
    // letting agents write outside allowed_paths via Bash and sidestep the
    // Write/Edit hook entirely.
    const r = await invokeBash(`echo hi>${HOME}/Documents/foo.txt`);
    assert.ok(isDeny(r), `expected deny, got: ${reason(r)}`);
  });
});

// --- Check ordering: protected before destructive ---

describe("check ordering: protected-path before destructive-pattern", () => {
  it("reports 'protected path' for a protected command that also trips destructive", async () => {
    const r = await invokeBash(`cat ~/.codex/auth.json 2>/dev/null | head -20`);
    assert.ok(isDeny(r));
    assert.match(
      reason(r),
      /protected path/,
      `expected 'protected path' in reason, got: ${reason(r)}`,
    );
  });
});

// --- Display path form in error messages ---

describe("error messages use display (tilde) form, not absolute", () => {
  it("Write to ~/.ssh shows ~/.ssh in reason, not /Users/...", async () => {
    const r = await invokeWrite(`${HOME}/.ssh/authorized_keys`);
    assert.match(
      reason(r),
      /~\/\.ssh/,
      `expected tilde form in reason, got: ${reason(r)}`,
    );
  });

  it("Write outside allowed dirs lists tilde-form allowed paths in reason", async () => {
    const r = await invokeWrite("/var/log/other.log");
    assert.match(
      reason(r),
      /~\/projects/,
      `expected tilde allowlist in reason, got: ${reason(r)}`,
    );
  });
});

// --- Sanity: existing protections still fire ---

describe("sanity — existing protections still fire", () => {
  it("BLOCKS rm -rf /", async () => {
    const r = await invokeBash(`rm -rf /`);
    assert.ok(isDeny(r));
  });

  it("BLOCKS sudo commands", async () => {
    const r = await invokeBash(`sudo cat /etc/shadow`);
    assert.ok(isDeny(r));
  });

  it("BLOCKS writes to /etc", async () => {
    const r = await invokeWrite("/etc/hosts");
    assert.ok(isDeny(r));
  });

  it("ALLOWS harmless read commands", async () => {
    const r = await invokeBash(`ls ${HOME}/projects`);
    assert.ok(isAllow(r));
  });
});
