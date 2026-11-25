import type { CallOffer, ListeningCall } from "@sondine/api";
import type { HoldOccurrence } from "@sondine/protocol";
import type { PausedFlags } from "../status/status-model";

// What Sondine says when a call starts (ADR 036), as a pure decision. A call
// the helper sees (`call.seen`), never one of an app the user muted or one
// already answered, and never while a private zone holds capture (a zone keeps
// the upper hand: nothing is really heard, and listening would record nothing).
//
// - During a pause (`listen`): offered when the pause began at least a minute
//   before the call (a pause taken during a call, or just before it, is meant
//   for it).
// - While Sondine listens to everything (`skip`): said, with « Ne pas écouter
//   cet appel ».
//
// Nothing while Sondine already listens, or pauses, for one call.
//
// The call going on is said apart from the offer: the island's switch stays
// until the call is over, answered or not, and whenever the pause was taken.

/** A pause younger than this when the call starts was meant for it. */
export const FRESH_PAUSE_MS = 60_000;
/**
 * A call is over this long after it was last seen: an app that drops its
 * microphone for a moment (a device changes, a channel is joined) is still in
 * the same call. The intent before an answer comes back then too.
 */
export const CALL_END_GRACE_MS = 10_000;

export interface SeenCall {
  readonly callId: string;
  readonly bundleId: string;
  /** The app's name as the helper resolved it, else null. */
  readonly name: string | null;
  /** Wall time core learned of it. */
  readonly sinceMs: number;
  /** When it was last seen; null while the helper sees it. */
  readonly endedMs: number | null;
}

/**
 * A call of this app that starts: the call going on when the app was seen in
 * one less than `graceMs` ago, else a new one.
 */
export function joinCall(
  calls: Iterable<SeenCall>,
  started: SeenCall,
  nowMs: number,
  graceMs: number,
): SeenCall {
  for (const call of calls) {
    if (call.bundleId !== started.bundleId) continue;
    if (call.endedMs !== null && nowMs - call.endedMs > graceMs) continue;
    return { ...call, name: call.name ?? started.name, endedMs: null };
  }
  return started;
}

export interface OfferInput {
  readonly enabled: boolean;
  /** The user's stored intent. */
  readonly flags: PausedFlags;
  /** When the paused flags were last written; null when never. */
  readonly pausedSinceMs: number | null;
  /** Already listening, or paused, for a call. */
  readonly forCall: boolean;
  readonly calls: readonly SeenCall[];
  readonly holds: readonly HoldOccurrence[];
  readonly mutedBundleIds: ReadonlySet<string>;
  readonly declinedCallIds: ReadonlySet<string>;
}

const latestOf = (calls: readonly SeenCall[]) =>
  calls.reduce<SeenCall | null>(
    (best, call) => (best === null || call.sinceMs > best.sinceMs ? call : best),
    null,
  );

/** The app's name as shown, else its bundle ID. */
export const callName = (call: SeenCall) => (call.name ?? call.bundleId).slice(0, 255);

/** The calls Sondine may speak of: none while turned off or held by a private zone. */
function spoken(
  input: Pick<OfferInput, "enabled" | "holds" | "calls" | "mutedBundleIds" | "declinedCallIds">,
): readonly SeenCall[] {
  if (!input.enabled || input.holds.some((hold) => !hold.lifted)) return [];
  return input.calls.filter(
    (call) => !input.mutedBundleIds.has(call.bundleId) && !input.declinedCallIds.has(call.callId),
  );
}

/** The call to notify now, the latest to start; null for none. */
export function offerFor(input: OfferInput): CallOffer | null {
  if (input.forCall) return null;
  const paused = input.flags.microphone || input.flags.systemAudio;
  const pausedSinceMs = input.pausedSinceMs ?? 0;
  const latest = latestOf(
    spoken(input).filter((call) => !paused || call.sinceMs - pausedSinceMs >= FRESH_PAUSE_MS),
  );
  if (latest === null) return null;
  return {
    kind: paused ? "listen" : "skip",
    callId: latest.callId,
    bundleId: latest.bundleId,
    name: callName(latest),
    sinceMs: latest.sinceMs,
  };
}

/** The call going on, answered or not, whatever the pause; null for none. */
export function callGoingOn(
  input: Parameters<typeof spoken>[0],
): Omit<ListeningCall, "episodeId"> | null {
  const latest = latestOf(spoken(input));
  if (latest === null) return null;
  return {
    callId: latest.callId,
    bundleId: latest.bundleId,
    name: callName(latest),
    sinceMs: latest.sinceMs,
  };
}

/** Whether the helper sees a call of this app now. */
export function seenApp(calls: readonly SeenCall[], bundleId: string): boolean {
  return calls.some((call) => call.bundleId === bundleId && call.endedMs === null);
}
