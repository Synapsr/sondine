import type { Typed } from "./histories";

/** When the user spoke a dictation, and the text its app typed. */
export interface Dictated {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /**
   * When its text came, if that is what places it: only a microphone watched
   * until then says that no other dictation came between.
   */
  readonly watchedUntilMs?: number;
}

/** A stretch an app listened to the microphone, ended. */
export interface ListenSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** A text comes this long after its speech at most. */
const LATE_MS = 5 * 60_000;
/** An app may say a little more than its microphone was open. */
const SPOKE_MORE_MS = 1_000;

/**
 * Places each dictation in time. One whose app says only when its text came
 * was spoken in the microphone span that ended before: taken only when exactly
 * one ended since the text before it, so that a cancelled dictation, or two
 * at once, never lends its place to another's words.
 */
export function placeTyped(typed: readonly Typed[], spans: readonly ListenSpan[]): Dictated[] {
  const came = typed
    .filter((entry) => entry.kind === "came")
    .toSorted((a, b) => a.fromMs - b.fromMs);
  const placed = typed.flatMap((entry): Dictated[] =>
    entry.kind === "spoken"
      ? [{ startMs: entry.startMs, endMs: entry.endMs, text: entry.text }]
      : [],
  );
  for (const [index, entry] of came.entries()) {
    const before = came[index - 1];
    const next = came[index + 1];
    // Two texts in one second: which came first is not told.
    if (before !== undefined && before.toMs >= entry.fromMs) continue;
    if (next !== undefined && next.fromMs <= entry.toMs) continue;
    const since = Math.max(before?.toMs ?? -Infinity, entry.fromMs - LATE_MS);
    const ended = spans.filter((span) => span.endMs > since && span.endMs <= entry.toMs);
    const span = ended[0];
    if (span === undefined || ended.length > 1) continue;
    if (entry.spokeMs !== null && entry.spokeMs > span.endMs - span.startMs + SPOKE_MORE_MS) {
      continue;
    }
    placed.push({
      startMs: span.startMs,
      endMs: span.endMs,
      text: entry.text,
      watchedUntilMs: entry.toMs,
    });
  }
  return placed.toSorted((a, b) => a.startMs - b.startMs);
}
