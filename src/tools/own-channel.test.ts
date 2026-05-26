/**
 * Tests for own-channel.ts — sendToOwnChannel.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// We test the function's logic by checking its dependency on
// getPrimaryChannel and sendToChannel from messaging.ts. Since those
// functions depend on a Discord client, we test error paths that don't
// require one and mock the channel registration for the success case.

import { sendToOwnChannel } from "./own-channel.js";
import { registerPrimaryChannel } from "./messaging.js";

describe("sendToOwnChannel", () => {
  it("returns error when no primary channel registered", async () => {
    const result = await sendToOwnChannel("nobody", "hello");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("no primary channel"));
  });

  it("returns error when Discord client is not initialized", async () => {
    // Register a channel but no Discord client is set up.
    registerPrimaryChannel("test-agent", "test-channel");
    const result = await sendToOwnChannel("test-agent", "hello");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("not initialized") || result.error?.includes("not found"));
  });

  it("resolves the right channel from config", async () => {
    // Verify registerPrimaryChannel + getPrimaryChannel chain works.
    registerPrimaryChannel("atlas", "atlas-channel");
    // Will fail because Discord client is null, but the error message
    // should NOT be "no primary channel" — proving lookup succeeded.
    const result = await sendToOwnChannel("atlas", "test message");
    assert.equal(result.success, false);
    assert.ok(!result.error?.includes("no primary channel"));
  });
});
