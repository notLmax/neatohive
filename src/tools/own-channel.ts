/**
 * own-channel.ts
 * Exports sendToOwnChannel — lets an agent post a visible message to its
 * own primary Discord channel. Used by boot-announce wakes so the agent
 * can surface a "back online" message without relying on the wake-mode
 * auto-post (which is correctly disabled per autonomy-v1).
 */

import { getPrimaryChannel, sendToChannel } from "./messaging.js";

export interface OwnChannelResult {
  success: boolean;
  error?: string;
}

/**
 * Post a message to the agent's primary (owner-facing) channel.
 * Resolves the channel name from the messaging module's registry.
 */
export async function sendToOwnChannel(
  agentName: string,
  message: string,
): Promise<OwnChannelResult> {
  const channelName = getPrimaryChannel(agentName);
  if (!channelName) {
    return {
      success: false,
      error: `no primary channel registered for ${agentName}`,
    };
  }

  const result = await sendToChannel(channelName, message);
  return result;
}
