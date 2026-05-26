/**
 * Discord chat tap — subscribes to discord.js messageCreate and publishes
 * enriched events to a chat-bus instance per Decision C schema.
 *
 * Caller supplies:
 *   - client: a discord.js Client (the agent's bot instance)
 *   - bus: a chat-bus instance (publish(channel, msg) → { sequence, ts, enriched })
 *   - channelResolver: maps a discord.js Message to a channel name string,
 *     or returns null to skip (e.g., DMs, ignored channels)
 *
 * Returns: { detach } — call detach() to unregister the listener.
 *
 * Per α.3 scope:
 *   - Owns: id (uuid), source ('discord'), source_message_id (message.id),
 *     author_id (message.author.id), author_kind ('user' or 'agent'),
 *     content (message.content), attachments ([] stub), metadata ({} stub).
 *   - Bus owns: channel (via resolver, injected to publish), sequence, ts.
 *
 * Errors during handler invocation are swallowed silently — Discord listener
 * errors MUST NOT crash the bot process. Structured error logging is a
 * downstream concern.
 */

import { randomUUID } from "node:crypto";
import type { Client, Message } from "discord.js";

export interface ChatBusLike {
  publish: (
    channel: string,
    message: unknown,
  ) => { sequence: number; ts: string; enriched: unknown };
}

export type ChannelResolver = (message: Message) => string | null;

export interface AttachChatTapOptions {
  client: Client;
  bus: ChatBusLike;
  channelResolver: ChannelResolver;
}

export interface ChatTapHandle {
  detach: () => void;
}

export function attachChatTap({
  client,
  bus,
  channelResolver,
}: AttachChatTapOptions): ChatTapHandle {
  if (!client || typeof (client as any).on !== "function") {
    throw new TypeError("attachChatTap: client must be a discord.js Client");
  }
  if (!bus || typeof bus.publish !== "function") {
    throw new TypeError("attachChatTap: bus must implement publish(channel, msg)");
  }
  if (typeof channelResolver !== "function") {
    throw new TypeError("attachChatTap: channelResolver must be a function");
  }

  const handler = (message: Message): void => {
    try {
      const channel = channelResolver(message);
      if (typeof channel !== "string" || channel.length === 0) {
        return;
      }

      const envelope = {
        id: randomUUID(),
        source: "discord" as const,
        source_message_id: message.id,
        author_id: message.author.id,
        author_kind: message.author.bot ? ("agent" as const) : ("user" as const),
        content: message.content,
        attachments: [] as Array<{
          filename: string;
          local_path: string;
          url: string;
          size_bytes: number;
        }>,
        metadata: {} as Record<string, unknown>,
      };

      bus.publish(channel, envelope);
    } catch {
      // Swallow — Discord listener errors must not crash the bot.
      // Downstream observability layers (later phase) can wrap or replace
      // this catch with structured logging.
    }
  };

  client.on("messageCreate", handler);

  return {
    detach(): void {
      client.off("messageCreate", handler);
    },
  };
}
