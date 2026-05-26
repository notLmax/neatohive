/**
 * Tests for the user-identity loader (src/core/users.ts).
 * Covers YAML loading, validation, back-compat env fallback, and
 * lookup-structure correctness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadUsers } from "./users.js";

function tmpYaml(content: string): string {
  const dir = join(tmpdir(), `hive-users-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "users.local.yaml");
  writeFileSync(file, content, "utf-8");
  return file;
}

function cleanup(path: string): void {
  try {
    const dir = join(path, "..");
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe("loadUsers with valid yaml", () => {
  it("returns UsersTable with correct user/owner/map", () => {
    const path = tmpYaml(`
users:
  - id: owner
    name: Daniel
    primary: true
    discord_ids:
      - "111"
      - "222"
  - id: friend
    name: Alice
    primary: false
    discord_ids:
      - "333"
`);
    try {
      const table = loadUsers({ configPath: path });
      assert.equal(table.users.length, 2);
      assert.equal(table.ownerUser.id, "owner");
      assert.equal(table.ownerUser.name, "Daniel");
      assert.equal(table.ownerUser.primary, true);
      assert.deepEqual(table.ownerUser.discord_ids, ["111", "222"]);
      assert.equal(table.users[1].id, "friend");
    } finally {
      cleanup(path);
    }
  });
});

describe("loadUsers without primary user", () => {
  it("throws", () => {
    const path = tmpYaml(`
users:
  - id: someone
    name: Nobody
    primary: false
    discord_ids:
      - "111"
`);
    try {
      assert.throws(
        () => loadUsers({ configPath: path }),
        /exactly one user must have primary: true \(found 0\)/,
      );
    } finally {
      cleanup(path);
    }
  });
});

describe("loadUsers with two primary users", () => {
  it("throws", () => {
    const path = tmpYaml(`
users:
  - id: a
    name: A
    primary: true
    discord_ids:
      - "111"
  - id: b
    name: B
    primary: true
    discord_ids:
      - "222"
`);
    try {
      assert.throws(
        () => loadUsers({ configPath: path }),
        /exactly one user must have primary: true \(found 2/,
      );
    } finally {
      cleanup(path);
    }
  });
});

describe("loadUsers with empty discord_ids", () => {
  it("throws", () => {
    const path = tmpYaml(`
users:
  - id: owner
    name: Owner
    primary: true
    discord_ids: []
`);
    try {
      assert.throws(
        () => loadUsers({ configPath: path }),
        /has no discord_ids/,
      );
    } finally {
      cleanup(path);
    }
  });
});

describe("loadUsers with duplicate discord_ids across users", () => {
  it("throws", () => {
    const path = tmpYaml(`
users:
  - id: a
    name: A
    primary: true
    discord_ids:
      - "111"
  - id: b
    name: B
    primary: false
    discord_ids:
      - "111"
`);
    try {
      assert.throws(
        () => loadUsers({ configPath: path }),
        /discord_id '111' is claimed by both 'a' and 'b'/,
      );
    } finally {
      cleanup(path);
    }
  });
});

describe("loadUsers fallback to env vars when yaml missing", () => {
  it("synthesizes single owner user", () => {
    const table = loadUsers({
      configPath: "/nonexistent/users.local.yaml",
      ownerIdEnv: "999",
      authorizedUsersEnv: "888,777",
    });
    assert.equal(table.users.length, 1);
    assert.equal(table.ownerUser.id, "owner");
    assert.equal(table.ownerUser.name, "Owner");
    assert.equal(table.ownerUser.primary, true);
    assert.deepEqual(table.ownerUser.discord_ids, ["999", "888", "777"]);
    assert.equal(table.allowedUserIds.size, 3);
  });
});

describe("loadUsers fallback with empty DISCORD_AUTHORIZED_USERS", () => {
  it("owner has only ownerIdEnv", () => {
    const table = loadUsers({
      configPath: "/nonexistent/users.local.yaml",
      ownerIdEnv: "999",
      authorizedUsersEnv: "",
    });
    assert.equal(table.users.length, 1);
    assert.deepEqual(table.ownerUser.discord_ids, ["999"]);
    assert.equal(table.allowedUserIds.size, 1);
    assert.ok(table.allowedUserIds.has("999"));
  });
});

describe("discordIdToUser maps both IDs to same user", () => {
  it("when one user has 2 IDs", () => {
    const path = tmpYaml(`
users:
  - id: owner
    name: Daniel
    primary: true
    discord_ids:
      - "111"
      - "222"
`);
    try {
      const table = loadUsers({ configPath: path });
      assert.equal(table.discordIdToUser.get("111")?.id, "owner");
      assert.equal(table.discordIdToUser.get("222")?.id, "owner");
      assert.strictEqual(
        table.discordIdToUser.get("111"),
        table.discordIdToUser.get("222"),
      );
    } finally {
      cleanup(path);
    }
  });
});

describe("allowedUserIds set is the union of all users discord_ids", () => {
  it("contains all IDs from all users", () => {
    const path = tmpYaml(`
users:
  - id: owner
    name: Daniel
    primary: true
    discord_ids:
      - "111"
      - "222"
  - id: friend
    name: Alice
    primary: false
    discord_ids:
      - "333"
`);
    try {
      const table = loadUsers({ configPath: path });
      assert.equal(table.allowedUserIds.size, 3);
      assert.ok(table.allowedUserIds.has("111"));
      assert.ok(table.allowedUserIds.has("222"));
      assert.ok(table.allowedUserIds.has("333"));
    } finally {
      cleanup(path);
    }
  });
});
