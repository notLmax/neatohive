'use strict';

/**
 * Create an in-memory pub/sub chat-bus.
 *
 * Per-channel monotonic sequence. Channel-routed delivery + wildcard subscribers.
 * Synchronous, single-process, no persistence. β.1 layers JSONL persistence on top
 * via a wildcard-subscriber tail. α.4 wires this bus to the WS server's connection
 * registry so per-channel publishes fan out to subscribed clients.
 *
 * @param {Object} [opts]
 * @param {() => string} [opts.now] - Override for ts assignment (test injection).
 *   Default: `() => new Date().toISOString()`.
 * @returns {{
 *   publish: (channel: string, message: object) => { sequence: number, ts: string, enriched: object },
 *   subscribe: (channel: string, callback: (msg: object) => void) => () => void,
 *   peekSequence: (channel: string) => number,
 *   channels: () => string[]
 * }}
 */
function createChatBus({ now = () => new Date().toISOString() } = {}) {
  const sequences = new Map();
  const subscribers = new Map();

  function publish(channel, message) {
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('chat-bus: channel must be a non-empty string');
    }
    if (message === null || typeof message !== 'object') {
      throw new TypeError('chat-bus: message must be a non-null object');
    }

    const sequence = (sequences.get(channel) || 0) + 1;
    sequences.set(channel, sequence);
    const ts = now();
    const enriched = { ...message, channel, sequence, ts };

    const channelSubs = subscribers.get(channel);
    if (channelSubs) {
      for (const callback of channelSubs) {
        try {
          callback(enriched);
        } catch {
          // Swallow per-subscriber error so others still fire.
        }
      }
    }

    const wildcardSubs = subscribers.get('*');
    if (wildcardSubs) {
      for (const callback of wildcardSubs) {
        try {
          callback(enriched);
        } catch {
          // Swallow per-subscriber error so others still fire.
        }
      }
    }

    return { sequence, ts, enriched };
  }

  function subscribe(channel, callback) {
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('chat-bus: channel must be a non-empty string');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('chat-bus: callback must be a function');
    }

    if (!subscribers.has(channel)) {
      subscribers.set(channel, new Set());
    }

    subscribers.get(channel).add(callback);

    return function unsubscribe() {
      const set = subscribers.get(channel);
      if (set) {
        set.delete(callback);
      }
    };
  }

  function peekSequence(channel) {
    return sequences.get(channel) || 0;
  }

  function channels() {
    return Array.from(sequences.keys());
  }

  return { publish, subscribe, peekSequence, channels };
}

module.exports = { createChatBus };
