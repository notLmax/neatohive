import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  isNoReply,
  relayLoopGuardTripped,
  RELAY_LOOP_THRESHOLD,
  RELAY_LOOP_WINDOW_MS,
  NO_REPLY_MARKER,
  _resetRelayLoopGuardForTesting,
} from "./relay-guards.js";

describe("isNoReply marker recognition", () => {
  it("matches the bare marker exactly", () => {
    assert.equal(isNoReply("[NO_REPLY]"), true);
  });

  it("matches the marker after trimming surrounding whitespace", () => {
    assert.equal(isNoReply("  [NO_REPLY]  "), true);
    assert.equal(isNoReply("\n[NO_REPLY]\n"), true);
  });

  it("matches when the marker leads commentary on the same line", () => {
    assert.equal(isNoReply("[NO_REPLY] acknowledged, moving on."), true);
  });

  it("matches when the marker leads commentary on a new line", () => {
    assert.equal(isNoReply("[NO_REPLY]\nclosing this thread"), true);
  });

  it("does NOT match the marker mid-text — agents discussing the marker shouldn't suppress", () => {
    assert.equal(
      isNoReply("Following the [NO_REPLY] convention is important."),
      false,
    );
  });

  it("matches when the marker trails on its own line (v1.4.5.1)", () => {
    // Atlas's exact format from 2026-05-04: content first, marker on its
    // own line at the end. Natural prose ordering.
    assert.equal(
      isNoReply(
        "Acknowledged. Spec fix on main, v2 worker dispatched.\n\n[NO_REPLY]",
      ),
      true,
    );
  });

  it("matches with a single newline before the trailing marker", () => {
    assert.equal(isNoReply("ack\n[NO_REPLY]"), true);
  });

  it("does NOT match a trailing-LIKE marker on the same line as content", () => {
    // "content [NO_REPLY]" (space, not newline) is ambiguous — could be
    // mid-text reference. Stay conservative: only trigger on own-line
    // trailing marker.
    assert.equal(isNoReply("Discussing [NO_REPLY] usage today."), false);
    assert.equal(isNoReply("Done with work [NO_REPLY]"), false);
  });

  it("does NOT match a substring", () => {
    assert.equal(isNoReply("[NO_REPLY_OTHER]"), false);
  });

  it("does NOT match a similar-looking marker without the brackets", () => {
    assert.equal(isNoReply("NO_REPLY"), false);
    assert.equal(isNoReply("No response requested."), false);
  });

  it("does NOT match an empty string", () => {
    assert.equal(isNoReply(""), false);
    assert.equal(isNoReply("   "), false);
  });

  it("exposes the canonical marker constant for documentation/tooling", () => {
    assert.equal(NO_REPLY_MARKER, "[NO_REPLY]");
  });
});

describe("relayLoopGuardTripped circuit breaker", () => {
  beforeEach(() => {
    _resetRelayLoopGuardForTesting();
  });

  it("does not trip on the first relay in a direction", () => {
    assert.equal(relayLoopGuardTripped("a", "b", 1000), false);
  });

  it("does not trip until count exceeds the threshold", () => {
    let now = 1000;
    for (let i = 0; i < RELAY_LOOP_THRESHOLD; i++) {
      assert.equal(
        relayLoopGuardTripped("a", "b", now),
        false,
        `should not trip on call ${i + 1}/${RELAY_LOOP_THRESHOLD}`,
      );
      now += 1000;
    }
    // The (THRESHOLD + 1)th relay within the window trips.
    assert.equal(relayLoopGuardTripped("a", "b", now), true);
  });

  it("treats opposite directions as independent", () => {
    let now = 1000;
    // Saturate a->b
    for (let i = 0; i <= RELAY_LOOP_THRESHOLD; i++) {
      relayLoopGuardTripped("a", "b", now);
      now += 1000;
    }
    // b->a should still be clean.
    assert.equal(relayLoopGuardTripped("b", "a", now), false);
  });

  it("decays — a relay outside the window does not count toward the threshold", () => {
    // Saturate just under the threshold.
    let now = 1000;
    for (let i = 0; i < RELAY_LOOP_THRESHOLD; i++) {
      relayLoopGuardTripped("a", "b", now);
      now += 1000;
    }
    // Skip far past the window.
    now += RELAY_LOOP_WINDOW_MS + 10_000;
    // Two more relays well after the window — neither should trip.
    assert.equal(relayLoopGuardTripped("a", "b", now), false);
    assert.equal(relayLoopGuardTripped("a", "b", now + 100), false);
  });

  it("the headline scenario: an unbounded ack loop is broken at THRESHOLD+1", () => {
    // Simulate the 14-message loop we hit in production.
    let now = 1000;
    let firstTrip = -1;
    for (let i = 0; i < 14; i++) {
      const tripped = relayLoopGuardTripped("atlas", "house-md", now);
      if (tripped && firstTrip < 0) firstTrip = i + 1;
      now += 2000; // 2s between each turn (faster than human pacing — pathological)
    }
    // First trip occurs on the (THRESHOLD + 1)th call.
    assert.equal(firstTrip, RELAY_LOOP_THRESHOLD + 1);
  });
});
