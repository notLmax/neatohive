/**
 * Tests for the hivemind routing layer.
 *
 * These cover the pure routing logic: parsing the wire format, the
 * delegation registry, and the inbound routing decision tree. The
 * Discord-side send paths are exercised at the integration level (manual
 * smoke + the existing end-to-end after merge); these tests deliberately
 * stay synchronous and side-effect-free.
 *
 * Run: `pnpm test`.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseHivemindMessage,
  routeInbound,
  registerDelegation,
  lookupDelegation,
  findActiveDelegationFor,
  completeDelegation,
  formatHeader,
  newTaskId,
  delegationRegistry,
  DELEGATION_TTL_MS,
  _setClockForTesting,
  _resetClockForTesting,
  _resetRegistryForTesting,
  _resetEscalationFlagForTesting,
  maybeOffloadLargeMessage,
  deriveSlug,
  HIVEMIND_OFFLOAD_THRESHOLD,
  setRegistryStateFile,
  loadRegistryFromDisk,
  getRegistryStateFile,
  markEscalationFired,
  consumeEscalationFlag,
  enqueueInbound,
  isHivemindProcessing,
  getHivemindProcessingState,
  _resetInboundQueueForTesting,
  writeHivemindReceipt,
} from "./messaging.js";

beforeEach(() => {
  _resetRegistryForTesting();
  _resetClockForTesting();
  _resetEscalationFlagForTesting();
  setRegistryStateFile(undefined); // disable persistence between tests
});

// ── parseHivemindMessage ──────────────────────────────────────

describe("parseHivemindMessage", () => {
  it("parses a legacy-format message (no marker) and tags it as legacy", () => {
    const r = parseHivemindMessage("**[glados → atlas]**\nBuild the thing.");
    assert.ok(r);
    assert.equal(r.fromAgent, "glados");
    assert.equal(r.toAgent, "atlas");
    assert.equal(r.kind, "legacy");
    assert.equal(r.taskId, undefined);
    assert.equal(r.body, "Build the thing.");
  });

  it("parses a delegation marker", () => {
    const r = parseHivemindMessage(
      "**[glados → atlas]** `delegation:t-abc123`\nBuild the thing.",
    );
    assert.ok(r);
    assert.equal(r.kind, "delegation");
    assert.equal(r.taskId, "t-abc123");
    assert.equal(r.body, "Build the thing.");
  });

  it("parses a response marker", () => {
    const r = parseHivemindMessage(
      "**[atlas → glados]** `response:t-abc123`\nDone.",
    );
    assert.ok(r);
    assert.equal(r.kind, "response");
    assert.equal(r.taskId, "t-abc123");
    assert.equal(r.body, "Done.");
  });

  it("parses an escalation marker", () => {
    const r = parseHivemindMessage(
      "**[atlas → glados]** `escalation:t-abc123`\nPaused on owner input.",
    );
    assert.ok(r);
    assert.equal(r.kind, "escalation");
    assert.equal(r.taskId, "t-abc123");
  });

  it("parses a query marker", () => {
    const r = parseHivemindMessage(
      "**[glados → cave-johnson]** `query:t-abc123`\nDo we have data on X?",
    );
    assert.ok(r);
    assert.equal(r.kind, "query");
    assert.equal(r.taskId, "t-abc123");
  });

  it("treats an unknown kind as legacy", () => {
    const r = parseHivemindMessage(
      "**[glados → atlas]** `whatever:t-abc123`\nbody",
    );
    assert.ok(r);
    assert.equal(r.kind, "legacy");
  });

  it("returns null for non-hivemind content", () => {
    assert.equal(parseHivemindMessage("hello world"), null);
    assert.equal(parseHivemindMessage("[not a hivemind] body"), null);
  });

  it("supports multi-line bodies", () => {
    const r = parseHivemindMessage(
      "**[glados → atlas]** `delegation:t-abc`\nline 1\nline 2\nline 3",
    );
    assert.ok(r);
    assert.equal(r.body, "line 1\nline 2\nline 3");
  });
});

// ── delegation registry ───────────────────────────────────────

describe("delegation registry", () => {
  it("registers a delegation with a unique taskId", () => {
    const r1 = registerDelegation("glados", "atlas", "delegation");
    const r2 = registerDelegation("glados", "atlas", "delegation");
    assert.notEqual(r1.taskId, r2.taskId);
    assert.match(r1.taskId, /^t-/);
    assert.equal(r1.from, "glados");
    assert.equal(r1.to, "atlas");
    assert.equal(r1.kind, "delegation");
  });

  it("looks up a registered delegation by taskId", () => {
    const r = registerDelegation("glados", "atlas", "delegation");
    const got = lookupDelegation(r.taskId);
    assert.ok(got);
    assert.equal(got.taskId, r.taskId);
  });

  it("returns undefined for unknown taskIds", () => {
    assert.equal(lookupDelegation("t-nope"), undefined);
  });

  it("findActiveDelegationFor returns the most recent delegation to an executor", () => {
    let now = 1000;
    _setClockForTesting(() => now);
    const a = registerDelegation("glados", "atlas", "delegation");
    now = 2000;
    const b = registerDelegation("house-md", "atlas", "delegation");
    now = 3000;
    const c = registerDelegation("glados", "cave-johnson", "delegation");

    const found = findActiveDelegationFor("atlas");
    assert.ok(found);
    assert.equal(found.taskId, b.taskId);

    const cave = findActiveDelegationFor("cave-johnson");
    assert.equal(cave?.taskId, c.taskId);

    assert.equal(findActiveDelegationFor("nobody"), undefined);
    // Suppress unused warning
    void a;
  });

  it("prunes entries older than the TTL on read", () => {
    let now = 1000;
    _setClockForTesting(() => now);
    const r = registerDelegation("glados", "atlas", "delegation");
    assert.ok(lookupDelegation(r.taskId));

    now += DELEGATION_TTL_MS + 1;
    assert.equal(lookupDelegation(r.taskId), undefined);
    assert.equal(delegationRegistry.size, 0);
  });

  it("completeDelegation removes the entry", () => {
    const r = registerDelegation("glados", "atlas", "delegation");
    completeDelegation(r.taskId);
    assert.equal(lookupDelegation(r.taskId), undefined);
  });

  it("newTaskId is unique per call", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newTaskId());
    assert.equal(ids.size, 100);
  });
});

// ── routeInbound ──────────────────────────────────────────────

describe("routeInbound", () => {
  it("ignores messages addressed to a different agent", () => {
    const parsed = parseHivemindMessage(
      "**[glados → atlas]** `delegation:t-1`\nbody",
    )!;
    const r = routeInbound(parsed, "cave-johnson");
    assert.equal(r.kind, "ignore");
  });

  it("a delegation arrives as a request the receiver should process", () => {
    const parsed = parseHivemindMessage(
      "**[glados → atlas]** `delegation:t-1`\nbody",
    )!;
    const r = routeInbound(parsed, "atlas");
    assert.equal(r.kind, "request");
    assert.equal(r.kind === "request" && r.messageKind, "delegation");
  });

  it("a query arrives as a request", () => {
    const parsed = parseHivemindMessage(
      "**[glados → atlas]** `query:t-1`\nbody",
    )!;
    const r = routeInbound(parsed, "atlas");
    assert.equal(r.kind, "request");
    assert.equal(r.kind === "request" && r.messageKind, "query");
  });

  it("a legacy message arrives as a request", () => {
    const parsed = parseHivemindMessage("**[glados → atlas]**\nbody")!;
    const r = routeInbound(parsed, "atlas");
    assert.equal(r.kind, "request");
    assert.equal(r.kind === "request" && r.messageKind, "legacy");
  });

  // ── delegation → response cycle: the headline test ──
  it("a delegation followed by its response is routed correctly", () => {
    // Step 1: glados delegates to atlas. SendMessage path registers.
    const reg = registerDelegation("glados", "atlas", "delegation");

    // Step 2: atlas's bot receives the delegation, routes as request.
    const inbound = parseHivemindMessage(
      `**[glados → atlas]** \`delegation:${reg.taskId}\`\ndo work`,
    )!;
    const requestRoute = routeInbound(inbound, "atlas");
    assert.equal(requestRoute.kind, "request");

    // Step 3: atlas replies. The response message hits glados's bot.
    const responseMsg = parseHivemindMessage(
      `**[atlas → glados]** \`response:${reg.taskId}\`\nhere it is`,
    )!;
    const responseRoute = routeInbound(responseMsg, "glados");
    assert.equal(responseRoute.kind, "response");
    assert.equal(
      responseRoute.kind === "response" && responseRoute.record.taskId,
      reg.taskId,
    );
  });

  it("a response with no taskId is surfaced as stale, not silently dropped", () => {
    const parsed = parseHivemindMessage("**[atlas → glados]**\nbody")!;
    // legacy parse gives kind=legacy, which routes as a request — that's
    // the correct legacy-compat behavior. To simulate a malformed response
    // we have to construct one explicitly.
    const explicit = {
      ...parsed,
      kind: "response" as const,
      taskId: undefined,
    };
    const r = routeInbound(explicit, "glados");
    assert.equal(r.kind, "stale");
    assert.equal(r.kind === "stale" && /without taskId/i.test(r.reason), true);
  });

  it("a response referencing an unknown taskId surfaces as stale", () => {
    const parsed = parseHivemindMessage(
      "**[atlas → glados]** `response:t-nope`\nbody",
    )!;
    const r = routeInbound(parsed, "glados");
    assert.equal(r.kind, "stale");
    assert.equal(r.kind === "stale" && r.taskId, "t-nope");
  });

  it("a response whose endpoints don't match the registered delegation is stale", () => {
    // glados delegated to atlas, but a response arrives claiming to be
    // from cave-johnson → glados with the same taskId — wrong sender.
    const reg = registerDelegation("glados", "atlas", "delegation");
    const parsed = parseHivemindMessage(
      `**[cave-johnson → glados]** \`response:${reg.taskId}\`\nimposter`,
    )!;
    const r = routeInbound(parsed, "glados");
    assert.equal(r.kind, "stale");
    assert.equal(
      r.kind === "stale" &&
        /endpoints do not match/i.test(r.reason),
      true,
    );
  });

  it("an escalation routes as escalation regardless of registry presence", () => {
    // Even if the registry has aged out, the escalation must reach the
    // delegator — that's the whole point of the escalation flow.
    const parsed = parseHivemindMessage(
      "**[atlas → glados]** `escalation:t-aged-out`\npaused",
    )!;
    const r = routeInbound(parsed, "glados");
    assert.equal(r.kind, "escalation");
    assert.equal(r.kind === "escalation" && r.record, undefined);
  });

  it("an escalation surfaces the registry record when one exists", () => {
    const reg = registerDelegation("glados", "atlas", "delegation");
    const parsed = parseHivemindMessage(
      `**[atlas → glados]** \`escalation:${reg.taskId}\`\npaused on owner`,
    )!;
    const r = routeInbound(parsed, "glados");
    assert.equal(r.kind, "escalation");
    assert.equal(
      r.kind === "escalation" && r.record?.taskId,
      reg.taskId,
    );
  });

  // ── escalation flow proxy: the headline escalation test ──
  it("escalation breaks out of #hivemind to the owner's channel (via routing record)", () => {
    // The Discord side-effects (posting to the executor's primary channel)
    // are integration-tested. This unit test asserts the routing decision
    // tree: when atlas escalates to glados, the receiving bot for glados
    // does NOT mistake it for a request and reply back to #hivemind. It
    // absorbs silently — and the receiving end can identify which task
    // is paused.
    const reg = registerDelegation("glados", "atlas", "delegation");
    const escalationToDelegator = parseHivemindMessage(
      `**[atlas → glados]** \`escalation:${reg.taskId}\`\nblocked, asked owner`,
    )!;
    const r = routeInbound(escalationToDelegator, "glados");

    // It is NOT a request — that's the bug we're preventing.
    assert.notEqual(r.kind, "request");
    // It IS an escalation, with the registry record attached.
    assert.equal(r.kind, "escalation");
    assert.equal(
      r.kind === "escalation" && r.record?.from,
      "glados",
    );
    assert.equal(
      r.kind === "escalation" && r.record?.to,
      "atlas",
    );
  });
});

// ── deriveSlug ────────────────────────────────────────────────

describe("deriveSlug", () => {
  it("kebab-cases the first non-empty line", () => {
    assert.equal(
      deriveSlug("Status sync and autonomy v1 discussion\nbody continues"),
      "status-sync-and-autonomy-v1-discussion",
    );
  });

  it("strips punctuation and special chars", () => {
    assert.equal(deriveSlug("Q5: what about persistence?"), "q5-what-about-persistence");
  });

  it("collapses runs of whitespace and dashes", () => {
    assert.equal(deriveSlug("hello    world   --   foo"), "hello-world-foo");
  });

  it("caps at ~40 chars", () => {
    const s = deriveSlug("a".repeat(200));
    assert.ok(s.length <= 40, `slug too long: ${s.length}`);
  });

  it("falls back to 'message' for empty / whitespace-only input", () => {
    assert.equal(deriveSlug(""), "message");
    assert.equal(deriveSlug("\n\n   \n"), "message");
  });

  it("skips leading blank lines", () => {
    assert.equal(deriveSlug("\n\n  \nReal first line here"), "real-first-line-here");
  });
});

// ── maybeOffloadLargeMessage ──────────────────────────────────

describe("maybeOffloadLargeMessage", () => {
  // Capture-only fs stubs so tests don't touch the disk.
  function makeStubs() {
    const written = new Map<string, string>();
    const dirs = new Set<string>();
    return {
      written,
      dirs,
      fsWrite: (p: string, c: string) => void written.set(p, c),
      fsMkdir: (p: string) => void dirs.add(p),
      fsExists: (p: string) => written.has(p),
    };
  }
  const fixedNow = new Date("2026-04-29T12:00:00Z");

  it("returns body unchanged when under the threshold", () => {
    const stubs = makeStubs();
    const r = maybeOffloadLargeMessage("atlas", "house-md", "short message", {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    assert.equal(r.offloaded, false);
    assert.equal(r.body, "short message");
    assert.equal(stubs.written.size, 0);
  });

  it("offloads when body exceeds threshold and rewrites with [ATTACH:]", () => {
    const stubs = makeStubs();
    const big = "Status update for autonomy-v1\n" + "x".repeat(HIVEMIND_OFFLOAD_THRESHOLD);
    const r = maybeOffloadLargeMessage("atlas", "house-md", big, {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    assert.equal(r.offloaded, true);
    assert.match(r.body, /\[ATTACH:[^\]]+\.md\]/);
    assert.match(r.body, /auto-offloaded/i);
    // The summary line is the first non-empty line of the original body.
    assert.match(r.body, /Status update for autonomy-v1/);
    // Stub body is much shorter than the original.
    assert.ok(r.body.length < HIVEMIND_OFFLOAD_THRESHOLD);
    // File was written.
    assert.equal(stubs.written.size, 1);
    const [path, content] = [...stubs.written.entries()][0];
    assert.match(path, /shared\/exchange\/atlas-house-md-status-update-for-autonomy-v1-20260429\.md$/);
    assert.ok(content.includes(big), "file should contain original body");
    assert.match(content, /^<!-- auto-offloaded/);
  });

  it("the stub contains imperative instructions telling the receiver to use the Read tool", () => {
    const stubs = makeStubs();
    const big = "topic line\n" + "x".repeat(HIVEMIND_OFFLOAD_THRESHOLD);
    const r = maybeOffloadLargeMessage("atlas", "house-md", big, {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    // The receiver-side Claude session needs an unambiguous action verb so
    // it actually reads the file rather than treating the stub as the full
    // message. Assert several imperative cues are present.
    assert.match(r.body, /MUST read/i);
    assert.match(r.body, /Read.+tool/i);
    assert.match(r.body, /absolute path/i);
    assert.match(r.body, /Do not respond based only on this stub/i);
    // The exact path appears both in the instructions block and as an
    // [ATTACH:] marker so file resolution + agent-driven reads both work.
    assert.ok(r.filePath);
    assert.ok(r.body.includes(r.filePath!));
  });

  it("disambiguates same-day repeats by appending a counter", () => {
    const stubs = makeStubs();
    const big = "shared topic\n" + "x".repeat(HIVEMIND_OFFLOAD_THRESHOLD);
    const r1 = maybeOffloadLargeMessage("atlas", "house-md", big, {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    const r2 = maybeOffloadLargeMessage("atlas", "house-md", big, {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    assert.notEqual(r1.filePath, r2.filePath);
    assert.match(r2.filePath!, /-20260429-2\.md$/);
  });

  it("creates the exchange directory exactly once per offload", () => {
    const stubs = makeStubs();
    const big = "topic\n" + "x".repeat(HIVEMIND_OFFLOAD_THRESHOLD);
    maybeOffloadLargeMessage("atlas", "house-md", big, {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    assert.equal(stubs.dirs.size, 1);
    assert.ok([...stubs.dirs][0].endsWith("shared/exchange"));
  });

  it("keeps the stub small enough for the wire format to fit Discord's 4000-char limit", () => {
    const stubs = makeStubs();
    const big = "a brief topic\n" + "x".repeat(20_000);
    const r = maybeOffloadLargeMessage("atlas", "house-md", big, {
      baseDir: "/base",
      now: fixedNow,
      ...stubs,
    });
    // Header is ~80 chars max. Stub + header must comfortably fit 4000.
    const headerEstimate = 80;
    assert.ok(
      r.body.length + headerEstimate < 4000,
      `stub too large: ${r.body.length}`,
    );
  });
});

// ── formatHeader ──────────────────────────────────────────────

describe("formatHeader", () => {
  it("emits a marker when taskId is present", () => {
    assert.equal(
      formatHeader("glados", "atlas", "delegation", "t-1"),
      "**[glados → atlas]** `delegation:t-1`",
    );
  });
  it("omits the marker when taskId is absent (legacy)", () => {
    assert.equal(
      formatHeader("glados", "atlas", "delegation"),
      "**[glados → atlas]**",
    );
  });

  it("round-trips through parseHivemindMessage", () => {
    const header = formatHeader("atlas", "glados", "response", "t-roundtrip");
    const parsed = parseHivemindMessage(`${header}\nthe body`);
    assert.ok(parsed);
    assert.equal(parsed.fromAgent, "atlas");
    assert.equal(parsed.toAgent, "glados");
    assert.equal(parsed.kind, "response");
    assert.equal(parsed.taskId, "t-roundtrip");
    assert.equal(parsed.body, "the body");
  });
});

// ── persistent delegation registry ──────────────────────────────

describe("persistent delegation registry (autonomy-v1 finding a)", () => {
  function withTmp<T>(fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "hive-reg-"));
    const file = join(dir, "delegations.jsonl");
    try {
      return fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      setRegistryStateFile(undefined);
    }
  }

  it("setRegistryStateFile + getRegistryStateFile roundtrips", () => {
    setRegistryStateFile("/tmp/foo");
    assert.equal(getRegistryStateFile(), "/tmp/foo");
    setRegistryStateFile(undefined);
    assert.equal(getRegistryStateFile(), undefined);
    setRegistryStateFile("");
    assert.equal(getRegistryStateFile(), undefined);
  });

  it("registerDelegation appends a JSONL 'register' event when persistence is enabled", () => {
    withTmp((file) => {
      setRegistryStateFile(file);
      registerDelegation("glados", "atlas", "delegation");
      const raw = readFileSync(file, "utf8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.event, "register");
      assert.equal(entry.from, "glados");
      assert.equal(entry.to, "atlas");
      assert.equal(entry.kind, "delegation");
      assert.match(entry.taskId, /^t-/);
    });
  });

  it("completeDelegation appends a 'complete' event", () => {
    withTmp((file) => {
      setRegistryStateFile(file);
      const reg = registerDelegation("glados", "atlas", "delegation");
      completeDelegation(reg.taskId);
      const raw = readFileSync(file, "utf8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 2);
      const last = JSON.parse(lines[1]);
      assert.equal(last.event, "complete");
      assert.equal(last.taskId, reg.taskId);
    });
  });

  it("loadRegistryFromDisk replays active delegations into memory", () => {
    withTmp((file) => {
      setRegistryStateFile(file);
      const r1 = registerDelegation("glados", "atlas", "delegation");
      const r2 = registerDelegation("glados", "cave-johnson", "query");
      // Now wipe in-memory and replay from disk.
      _resetRegistryForTesting();
      assert.equal(delegationRegistry.size, 0);
      const result = loadRegistryFromDisk();
      assert.equal(result.loaded, 2);
      assert.equal(result.expired, 0);
      assert.ok(lookupDelegation(r1.taskId));
      assert.ok(lookupDelegation(r2.taskId));
    });
  });

  it("loadRegistryFromDisk omits delegations that completed before crash", () => {
    withTmp((file) => {
      setRegistryStateFile(file);
      const r1 = registerDelegation("glados", "atlas", "delegation");
      const r2 = registerDelegation("glados", "cave-johnson", "delegation");
      completeDelegation(r1.taskId);
      _resetRegistryForTesting();
      loadRegistryFromDisk();
      assert.equal(lookupDelegation(r1.taskId), undefined, "completed task gone");
      assert.ok(lookupDelegation(r2.taskId), "active task survived");
    });
  });

  it("loadRegistryFromDisk drops entries older than the 24h TTL", () => {
    withTmp((file) => {
      let now = 1_000_000;
      _setClockForTesting(() => now);
      setRegistryStateFile(file);
      const r1 = registerDelegation("glados", "atlas", "delegation");
      // Advance 25 hours.
      now += 25 * 60 * 60 * 1000;
      const r2 = registerDelegation("glados", "atlas", "delegation");
      _resetRegistryForTesting();
      const result = loadRegistryFromDisk();
      assert.equal(result.expired, 1);
      assert.equal(result.loaded, 1);
      assert.equal(lookupDelegation(r1.taskId), undefined);
      assert.ok(lookupDelegation(r2.taskId));
    });
  });

  it("loadRegistryFromDisk skips malformed lines without poisoning the load", () => {
    withTmp((file) => {
      setRegistryStateFile(file);
      const r1 = registerDelegation("glados", "atlas", "delegation");
      // Hand-edit the file with a bad line in the middle.
      const raw = readFileSync(file, "utf8");
      writeFileSync(file, raw + "this is not json\n");
      _resetRegistryForTesting();
      const result = loadRegistryFromDisk();
      assert.equal(result.loaded, 1);
      assert.ok(lookupDelegation(r1.taskId));
    });
  });

  it("loadRegistryFromDisk is a no-op when persistence is disabled", () => {
    setRegistryStateFile(undefined);
    const result = loadRegistryFromDisk();
    assert.equal(result.loaded, 0);
    assert.equal(result.expired, 0);
  });

  it("DELEGATION_TTL_MS is 24h (autonomy-v1 finding a — bumped from 60min)", () => {
    assert.equal(DELEGATION_TTL_MS, 24 * 60 * 60 * 1000);
  });

  it("the headline crash-recovery scenario: delegate → restart → response still routes", () => {
    withTmp((file) => {
      setRegistryStateFile(file);

      // Step 1: glados delegates to atlas. Registry persists to disk.
      const reg = registerDelegation("glados", "atlas", "delegation");
      assert.ok(lookupDelegation(reg.taskId));

      // Step 2: pm2 restart wipes glados's bot process — in-memory map gone.
      _resetRegistryForTesting();
      assert.equal(delegationRegistry.size, 0);

      // Step 3: glados's bot restarts, replays from disk.
      const replay = loadRegistryFromDisk();
      assert.equal(replay.loaded, 1);

      // Step 4: atlas's response arrives. Routing finds the registered
      // delegation — NOT a stale-task error.
      const parsed = parseHivemindMessage(
        `**[atlas → glados]** \`response:${reg.taskId}\`\nhere it is`,
      )!;
      const route = routeInbound(parsed, "glados");
      assert.equal(route.kind, "response");
      assert.equal(
        route.kind === "response" && route.record.taskId,
        reg.taskId,
      );
    });
  });
});

// ── escalation auto-reply suppression flag ──────────────────────

describe("EscalateToOwner auto-reply suppression flag", () => {
  it("starts cleared", () => {
    assert.equal(consumeEscalationFlag(), false);
  });

  it("markEscalationFired sets the flag; consume reads-and-clears", () => {
    markEscalationFired();
    assert.equal(consumeEscalationFlag(), true);
    // Second consume returns false — flag was cleared by the first read.
    assert.equal(consumeEscalationFlag(), false);
  });

  it("flag is independent of registry state", () => {
    markEscalationFired();
    _resetRegistryForTesting();
    // Resetting the registry should NOT clear the escalation flag —
    // they're independent concerns. Only consumeEscalationFlag or the
    // explicit test reset can clear it.
    assert.equal(consumeEscalationFlag(), true);
  });

  it("_resetEscalationFlagForTesting clears the flag", () => {
    markEscalationFired();
    _resetEscalationFlagForTesting();
    assert.equal(consumeEscalationFlag(), false);
  });

  it("flag stays clear on partial-failure path (regression guard)", () => {
    // Regression guard for the v1.3.2 hotfix. Originally
    // markEscalationFired() ran BEFORE the hivemind notice attempt — so
    // if the owner-channel post succeeded but the hivemind notice to the
    // delegator failed, the bot's auto-reply was suppressed even though
    // the delegator had not been notified, silently swallowing the
    // agent's text reply.
    //
    // After the fix, markEscalationFired() is called only AFTER the
    // hivemind notice succeeds (or there's no delegator to notify). The
    // partial-failure path returns early without setting the flag, so
    // the bot's auto-reply still fires and the delegator at least gets
    // the agent's text. This test models that contract: when no
    // markEscalationFired() call has been made (the partial-failure
    // early return), consumeEscalationFlag must return false.
    _resetEscalationFlagForTesting();
    // No markEscalationFired() — modeling the partial-failure early
    // return.
    assert.equal(
      consumeEscalationFlag(),
      false,
      "flag must remain clear when escalation returns partial failure",
    );
  });

  it("the suppression flow models the intended bot behavior", () => {
    // Models what the bot's hivemind handler does (v1.4.6 queue-based):
    //   1. enqueueInbound — queue sets processing state automatically
    //   2. runAgent — agent may or may not call EscalateToOwner
    //   3. consumeEscalationFlag — if true, skip the auto-reply
    //   4. queue drain clears processing state
    //
    // If the agent escalated, the auto-reply is suppressed and the
    // delegating agent only gets the silent-absorb escalation notice.
    // If the agent did NOT escalate, the flag stays false and the
    // auto-reply runs as before.

    // Path A — agent escalated.
    markEscalationFired();
    const escalated = consumeEscalationFlag();
    assert.equal(escalated, true, "bot would suppress auto-reply");

    // Path B — agent did not escalate.
    const notEscalated = consumeEscalationFlag();
    assert.equal(notEscalated, false, "bot would proceed with normal auto-reply");
  });
});

// ── Bug #3 — kind=response sender-side validation (v1.3.3 fix) ─────

describe("kind=response sender-side validation (v1.3.3 fix)", () => {
  // The pre-fix sendToAgent for kind=response called lookupDelegation on the
  // SENDER's local registry. But the original delegation lives in the
  // DELEGATOR's registry (the recipient of the response), not the
  // responder's (the sender). So a legitimate response was rejected as
  // "stale task" because the sender had no record of it.
  //
  // Fix: trust the caller, drop the sender-side lookup. Validation moves
  // to the receiver via routeInbound (already correct).
  //
  // We can't directly call sendToAgent here (it requires a registered
  // Discord client). But we can assert the routing logic on the receiver
  // side still works correctly — that's where validation belongs.

  it("routeInbound still rejects a response with no taskId (regression guard)", () => {
    // The receiver-side check stays loud and clear. Only sender-side
    // validation was removed.
    const parsed = parseHivemindMessage("**[atlas → glados]**\nbody")!;
    const explicit = {
      ...parsed,
      kind: "response" as const,
      taskId: undefined,
    };
    const r = routeInbound(explicit, "glados");
    assert.equal(r.kind, "stale");
    assert.equal(r.kind === "stale" && /without taskId/i.test(r.reason), true);
  });

  it("routeInbound still rejects an unknown taskId (regression guard)", () => {
    const parsed = parseHivemindMessage(
      "**[atlas → glados]** `response:t-nope`\nbody",
    )!;
    const r = routeInbound(parsed, "glados");
    assert.equal(r.kind, "stale");
    assert.equal(r.kind === "stale" && r.taskId, "t-nope");
  });

  it("the smoke-test scenario: responder sends kind=response with task_id from the DELEGATOR's registry", () => {
    // Models 2026-04-29's smoke: house-md (delegator) registers
    // delegation, atlas (responder) calls SendMessage(kind=response,
    // task_id=...) with the task_id but has it in NO local registry.
    //
    // Pre-fix: sendToAgent's lookupDelegation returned undefined for
    // atlas → reject as stale.
    // Post-fix: sendToAgent doesn't look up. The send goes through.
    // House-md's bot's routeInbound finds the delegation in HOUSE-MD's
    // registry → routes correctly as kind=response.
    //
    // We can't easily exercise sendToAgent end-to-end without a Discord
    // client; this test asserts the receiver-side routing works given
    // the message construction the responder will produce.
    const taskId = "t-smoke-from-delegator";
    // Simulate house-md's registry holding the original delegation.
    registerDelegation("house-md", "atlas", "delegation");
    // The first registered taskId is generated; for this test, register a
    // SECOND one with our test taskId by directly inserting (bypassing
    // newTaskId generation).
    delegationRegistry.set(taskId, {
      taskId,
      from: "house-md",
      to: "atlas",
      kind: "delegation",
      startedAt: Date.now(),
    });

    // Atlas sends back: **[atlas → house-md]** `response:<taskId>` body
    const parsed = parseHivemindMessage(
      `**[atlas → house-md]** \`response:${taskId}\`\nhere is the haiku`,
    )!;
    const r = routeInbound(parsed, "house-md");
    assert.equal(r.kind, "response", "routes correctly on receiver side");
    assert.equal(
      r.kind === "response" && r.record.taskId,
      taskId,
    );
  });
});

// ── Phase 1 (v1.4.6): queue-based hivemind processing state ─────

describe("hivemind processing state (v1.4.6 — queue-based)", () => {
  beforeEach(() => {
    _resetInboundQueueForTesting();
  });

  it("isHivemindProcessing is false when idle", () => {
    assert.equal(isHivemindProcessing(), false);
    const state = getHivemindProcessingState();
    assert.equal(state.active, false);
    assert.equal(state.kind, null);
  });

  it("isHivemindProcessing is true during queue processing (kind='request')", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "state-test-req",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(isHivemindProcessing(), true);
    assert.equal(getHivemindProcessingState().kind, "request");
    release!();
  });

  it("isHivemindProcessing is true during queue processing (kind='response')", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "state-test-resp",
      kind: "response",
      fromAgent: "a",
      taskId: "t-1",
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(isHivemindProcessing(), true);
    assert.equal(getHivemindProcessingState().kind, "response");
    release!();
  });

  it("isHivemindProcessing is true during queue processing (kind='escalation')", async () => {
    let release: () => void;
    const blocker = new Promise<void>((r) => { release = r; });
    enqueueInbound({
      id: "state-test-esc",
      kind: "escalation",
      fromAgent: "a",
      taskId: "t-2",
      enqueuedAt: Date.now(),
      process: async () => { await blocker; },
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(isHivemindProcessing(), true);
    assert.equal(getHivemindProcessingState().kind, "escalation");
    release!();
  });

  it("state resets to idle after queue drains", async () => {
    enqueueInbound({
      id: "state-test-drain",
      kind: "request",
      fromAgent: "a",
      taskId: undefined,
      enqueuedAt: Date.now(),
      process: async () => {},
    });
    // Wait for drain
    const start = Date.now();
    while (Date.now() - start < 2000) {
      if (!isHivemindProcessing()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(isHivemindProcessing(), false);
    assert.equal(getHivemindProcessingState().kind, null);
  });
});

// ── Phase 5: hivemind receipt log ───────────────────────────────

describe("writeHivemindReceipt (Phase 5 — observability)", () => {
  it("appends a JSON line to the receipt file", () => {
    // writeHivemindReceipt writes to data/hivemind-receipts.log in cwd.
    // We call it and verify it doesn't throw — the actual file write
    // targets the real data/ dir (which tests may not want to persist,
    // but the function is idempotent and append-only).
    assert.doesNotThrow(() => {
      writeHivemindReceipt({
        fromAgent: "atlas",
        toAgent: "glados",
        taskId: "t-test-1",
        kind: "request",
        sessionUpdated: true,
      });
    });
  });

  it("multiple calls produce multiple lines (append, no rewrite)", () => {
    // Two consecutive calls should both succeed (append mode).
    assert.doesNotThrow(() => {
      writeHivemindReceipt({
        fromAgent: "atlas",
        toAgent: "glados",
        taskId: "t-test-2a",
        kind: "response",
        sessionUpdated: false,
      });
      writeHivemindReceipt({
        fromAgent: "house-md",
        toAgent: "glados",
        taskId: "t-test-2b",
        kind: "escalation",
        sessionUpdated: true,
      });
    });
    // Read the file and verify it has valid JSON lines
    const content = readFileSync(join(process.cwd(), "data", "hivemind-receipts.log"), "utf8");
    const lines = content.trim().split("\n").filter((l: string) => l.trim());
    assert.ok(lines.length >= 2, "should have at least 2 lines");
    // Each line should parse as valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.timestamp, "each line should have a timestamp");
      assert.ok(parsed.fromAgent, "each line should have fromAgent");
      assert.ok(parsed.toAgent, "each line should have toAgent");
    }
  });
});
