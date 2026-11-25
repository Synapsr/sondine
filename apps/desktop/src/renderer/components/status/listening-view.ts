import type { ListeningStatus, SpoolProblem } from "@sondine/api";

// What the window shows and offers for listening, in the top bar and on the
// status screen. Like the menu bar (main/tray-state.ts), it follows what the
// helper confirmed, never the user's request alone: a pause the helper has
// not applied yet reads as still pausing, with a retry. Capture that runs
// while its audio cannot be stored says so before anything else, then a
// private zone holding everything (ADR 029).

export type ListeningState =
  | ListeningStatus["effective"]
  | "pause-unconfirmed"
  | "held"
  | "disk-full"
  | "write-error";
export type ListeningAction = "pause" | "retry-pause" | "resume" | "lift";

export interface ListeningView {
  readonly state: ListeningState;
  /** The first action is the main one. */
  readonly actions: readonly ListeningAction[];
  /** When a timed pause ends; null otherwise. */
  readonly pausedUntilMs: number | null;
}

export function listeningView(
  listening: ListeningStatus,
  spool: readonly SpoolProblem[] = [],
): ListeningView {
  const pauseWanted = listening.desired === "paused";
  const effective = listening.effective;
  if (pauseWanted && (effective === "listening" || effective === "partial")) {
    return { state: "pause-unconfirmed", actions: ["retry-pause", "resume"], pausedUntilMs: null };
  }
  const resumable = effective === "paused" || (effective === "unknown" && pauseWanted);
  if (resumable) {
    return {
      state: effective,
      actions: ["resume"],
      pausedUntilMs: effective === "paused" ? listening.pausedUntilMs : null,
    };
  }
  const capturing = effective === "listening" || effective === "partial";
  if (!capturing) return { state: effective, actions: ["pause"], pausedUntilMs: null };
  if (spool.some((problem) => problem.code === "disk.full")) {
    return { state: "disk-full", actions: ["pause"], pausedUntilMs: null };
  }
  if (spool.length > 0) return { state: "write-error", actions: ["pause"], pausedUntilMs: null };
  const held = listening.holds.some((hold) => !hold.lifted && hold.scope === "all");
  if (held) return { state: "held", actions: ["lift", "pause"], pausedUntilMs: null };
  return { state: effective, actions: ["pause"], pausedUntilMs: null };
}

/** A failure that stops capture without the user asking: the banner says it. */
export function isListeningFailure(state: ListeningState): boolean {
  return state === "disk-full" || state === "write-error";
}
