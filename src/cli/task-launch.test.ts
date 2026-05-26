import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameAgent, CrossAgentError } from "./task-launch.js";

describe("assertSameAgent — cross-agent launch gate", () => {
  it("allows launch when HIVE_AGENT_NAME is unset (owner-from-terminal)", () => {
    // No env var → undefined caller. Owner running CLI directly.
    assert.doesNotThrow(() => assertSameAgent(undefined, "bob-the-builder"));
    assert.doesNotThrow(() => assertSameAgent("", "bob-the-builder"));
  });

  it("allows self-dispatch for bob-the-builder", () => {
    // bob launching a worker under his own umbrella — the legitimate path.
    assert.doesNotThrow(() =>
      assertSameAgent("bob-the-builder", "bob-the-builder"),
    );
  });

  it("allows self-dispatch for non-bob agents", () => {
    // house-md launching a worker under house-md's own umbrella.
    assert.doesNotThrow(() => assertSameAgent("house-md", "house-md"));
  });

  it("blocks cross-agent dispatch with CrossAgentError", () => {
    // The footgun case: house-md trying to launch under bob's umbrella.
    let caught: unknown;
    try {
      assertSameAgent("house-md", "bob-the-builder");
      assert.fail("should have thrown");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CrossAgentError);
    assert.ok(caught.message.includes("house-md"));
    assert.ok(caught.message.includes("bob-the-builder"));
    assert.equal(caught.callerAgent, "house-md");
    assert.equal(caught.targetAgent, "bob-the-builder");
  });

  it("exit-code distinctness: CrossAgentError is distinguishable from parse errors", () => {
    // assertSameAgent throws CrossAgentError (→ exit 3 in main()),
    // while parseArgs throws plain Error (→ exit 2 in main()).
    // Verify the error type is distinct.
    try {
      assertSameAgent("atlas", "glados");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof CrossAgentError);
      assert.ok(!(err instanceof TypeError));
      assert.ok(!(err instanceof RangeError));
      // In main(), CrossAgentError → exit(3), plain Error → exit(2).
      // The gate produces a distinct error class, ensuring distinct exit codes.
    }
  });
});
