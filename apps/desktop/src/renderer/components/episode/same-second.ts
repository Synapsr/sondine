import type { EpisodeSameMoment } from "@sondine/api";

// The jump between two recordings of the same meeting (ADR 032).

/** Where to open the other: this one's wall time, kept within the shared time, on the other's clock. */
export function sameSecond(moment: EpisodeSameMoment, hereMs: number): number {
  const within = Math.min(Math.max(hereMs, moment.sharedFromMs), moment.sharedToMs);
  return Math.round(
    within + moment.offsetMs + (moment.driftPpm * (within - moment.anchorMs)) / 1_000_000,
  );
}
