/**
 * users.ts
 * Loads the user table from config/users.local.yaml.
 * One user can have N Discord IDs. The owner user (primary: true)
 * is the EscalateToOwner target.
 *
 * Back-compat: if users.local.yaml doesn't exist, synthesize a single
 * owner user from DISCORD_OWNER_ID + DISCORD_AUTHORIZED_USERS env vars.
 * This keeps existing Hives working without setup change.
 */

import { readFileSync, existsSync } from "fs";
import yaml from "js-yaml";

export interface User {
  id: string;
  name: string;
  primary: boolean;
  discord_ids: string[];
}

export interface UsersTable {
  users: User[];
  /** Discord ID → User. Built once at load time. */
  discordIdToUser: Map<string, User>;
  /** The user with primary: true. Required — load throws if missing. */
  ownerUser: User;
  /** Union of all users' discord_ids. The bot's gate set. */
  allowedUserIds: Set<string>;
}

export function loadUsers(opts?: {
  configPath?: string;
  ownerIdEnv?: string;
  authorizedUsersEnv?: string;
}): UsersTable {
  const configPath = opts?.configPath ?? "config/users.local.yaml";
  let users: User[];

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const doc = yaml.load(raw) as { users?: unknown[] };
    if (!doc || !Array.isArray(doc.users)) {
      throw new Error(`users.local.yaml: expected a top-level 'users' array`);
    }
    users = doc.users.map((entry: any, i: number) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`users.local.yaml: entry ${i} is not an object`);
      }
      return {
        id: String(entry.id ?? ""),
        name: String(entry.name ?? ""),
        primary: entry.primary === true,
        discord_ids: Array.isArray(entry.discord_ids)
          ? entry.discord_ids.map((d: unknown) => String(d))
          : [],
      };
    });
  } else {
    // Back-compat fallback: synthesize from env vars.
    const ownerId = opts?.ownerIdEnv;
    if (!ownerId) {
      throw new Error(
        "No config/users.local.yaml found and DISCORD_OWNER_ID is not set. " +
          "Create config/users.local.yaml or set DISCORD_OWNER_ID in .env.",
      );
    }
    console.warn(
      "[users] DEPRECATION: using DISCORD_OWNER_ID + DISCORD_AUTHORIZED_USERS env vars. " +
        "This fallback will be removed in v1.5.x. Create config/users.local.yaml instead.",
    );
    const authorizedRaw = opts?.authorizedUsersEnv ?? "";
    const extraIds = authorizedRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    users = [
      {
        id: "owner",
        name: "Owner",
        primary: true,
        discord_ids: [ownerId, ...extraIds],
      },
    ];
  }

  // ── Validation ──
  if (users.length === 0) {
    throw new Error("users.local.yaml: at least one user is required");
  }

  const primaryUsers = users.filter((u) => u.primary);
  if (primaryUsers.length === 0) {
    throw new Error("users.local.yaml: exactly one user must have primary: true (found 0)");
  }
  if (primaryUsers.length > 1) {
    throw new Error(
      `users.local.yaml: exactly one user must have primary: true (found ${primaryUsers.length}: ${primaryUsers.map((u) => u.id).join(", ")})`,
    );
  }

  for (const user of users) {
    if (!user.discord_ids || user.discord_ids.length === 0) {
      throw new Error(`users.local.yaml: user '${user.id}' has no discord_ids`);
    }
    for (const did of user.discord_ids) {
      if (!did || typeof did !== "string" || did.trim().length === 0) {
        throw new Error(`users.local.yaml: user '${user.id}' has an empty discord_id`);
      }
    }
  }

  // ── Build lookup structures ──
  const discordIdToUser = new Map<string, User>();
  for (const user of users) {
    for (const did of user.discord_ids) {
      if (discordIdToUser.has(did)) {
        const existing = discordIdToUser.get(did)!;
        throw new Error(
          `users.local.yaml: discord_id '${did}' is claimed by both '${existing.id}' and '${user.id}'`,
        );
      }
      discordIdToUser.set(did, user);
    }
  }

  const allowedUserIds = new Set<string>();
  for (const user of users) {
    for (const did of user.discord_ids) {
      allowedUserIds.add(did);
    }
  }

  return {
    users,
    discordIdToUser,
    ownerUser: primaryUsers[0],
    allowedUserIds,
  };
}
