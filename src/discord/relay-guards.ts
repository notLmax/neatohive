/**
 * relay-guards.ts
 *
 * Hivemind loop-prevention guards. Two layers:
 *
 *   1. `[NO_REPLY]` marker — agents emit this as the entire response (or
 *      as a leading marker with optional commentary) to gracefully end a
 *      hivemind exchange without spinning a new auto-reply on the other
 *      side. The bot recognises the marker and skips relay.
 *
 *   2. Per-direction circuit breaker — counts isRequest relays in a
 *      sliding 60-second window keyed by (sender → receiver). If more
 *      than 5 fire in that window, further relays are suppressed and a
 *      warning is logged. Returns to normal automatically once traffic
 *      dies down. This catches future loop bugs even if the marker
 *      contract is missed.
 *
 * Both guards apply only to the isRequest auto-reply path in bot.ts.
 * isResponse and isEscalation are absorb-only and never relay, so loops
 * can't form there.
 *
 * History: introduced in v1.3.8 after a 14-message echo loop between
 * atlas and house-md (both agents emitting "No response requested." in
 * an attempt to gracefully close, which the bot relayed verbatim).
 */

export const NO_REPLY_MARKER = "[NO_REPLY]";

/** True iff `text` opts out of relay via the NO_REPLY marker. */
export function isNoReply(text: string): boolean {
  const t = text.trim();
  if (t === NO_REPLY_MARKER) return true;
  // Allow leading marker + optional commentary, e.g.
  // "[NO_REPLY] acknowledged, moving on."
  if (
    t.startsWith(NO_REPLY_MARKER + " ") ||
    t.startsWith(NO_REPLY_MARKER + "\n")
  ) {
    return true;
  }
  // Allow trailing marker on its own line, e.g.
  // "Acknowledged, moving on.\n\n[NO_REPLY]"
  // Agents commonly write content first, marker last; this is natural prose
  // ordering and we should honor the intent. The "\n" prefix prevents
  // mid-text references like "the [NO_REPLY] convention" from matching.
  // (v1.4.5.1 fix.)
  if (t.endsWith("\n" + NO_REPLY_MARKER)) return true;
  return false;
}

export const RELAY_LOOP_WINDOW_MS = 60_000;
export const RELAY_LOOP_THRESHOLD = 5;

const recentRelays = new Map<string, number[]>();

/**
 * Record this relay attempt and report whether the directional rate has
 * exceeded the loop threshold. Counter naturally decays: entries older
 * than the window are pruned on each call.
 *
 * `nowMs` is injectable for deterministic tests; defaults to Date.now().
 */
export function relayLoopGuardTripped(
  from: string,
  to: string,
  nowMs: number = Date.now(),
): boolean {
  const key = `${from}->${to}`;
  const arr = (recentRelays.get(key) ?? []).filter(
    (t) => nowMs - t < RELAY_LOOP_WINDOW_MS,
  );
  arr.push(nowMs);
  recentRelays.set(key, arr);
  return arr.length > RELAY_LOOP_THRESHOLD;
}

/** Test helper — clears all per-pair counters. */
export function _resetRelayLoopGuardForTesting(): void {
  recentRelays.clear();
}
