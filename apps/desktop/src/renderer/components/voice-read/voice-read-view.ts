import type { VoiceReadSession, VoiceReadStatus } from "@sondine/api";

// What the voice read shows (ADR 034), from its status: nothing to offer
// while voices are not recognized or the build cannot record, the text and
// « Commencer » before, the text with its meter and counter while recording,
// then the outcome.

export type VoiceReadView =
  | { readonly kind: "recognition-off" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly failure: VoiceReadSession["failure"] }
  | {
      readonly kind: "recording";
      readonly voicedSeconds: number;
      readonly targetSeconds: number;
      readonly canFinish: boolean;
      /** The voice heard toward the target, 0 to 100. */
      readonly percent: number;
      /** The microphone's level, 0 to 1. */
      readonly level: number;
    }
  | { readonly kind: "embedding" }
  | { readonly kind: "done" };

/**
 * `mine`: this panel started the session on screen; an outcome an earlier read
 * left (kept, or failed) shows as ready to read again.
 */
export function voiceReadView(status: VoiceReadStatus, mine = true): VoiceReadView {
  const { session } = status;
  if (session.phase === "recording") {
    return {
      kind: "recording",
      voicedSeconds: Math.min(
        Math.floor(session.voicedMs / 1000),
        Math.round(session.targetMs / 1000),
      ),
      targetSeconds: Math.round(session.targetMs / 1000),
      canFinish: session.voicedMs >= session.minimumMs,
      percent:
        session.targetMs <= 0
          ? 100
          : Math.min(100, Math.floor((session.voicedMs / session.targetMs) * 100)),
      level: session.level,
    };
  }
  if (session.phase === "embedding") return { kind: "embedding" };
  if (session.phase === "done" && mine) return { kind: "done" };
  if (!status.recognition) return { kind: "recognition-off" };
  if (!status.available) return { kind: "unavailable" };
  return { kind: "ready", failure: session.phase === "failed" && mine ? session.failure : null };
}

/**
 * Whether the session on screen is this panel's read. Asked for, the read is
 * not yet this panel's: the status may still show what an earlier read left
 * (kept, or failed) until the new one is seen under way, or until its start
 * answers with its own failure. Only then is its outcome this panel's, so a
 * « kept » from before never closes the first run's dialog on a new read.
 */
export type ReadTrack = "none" | "asked" | "mine";

export function trackRead(
  track: ReadTrack,
  event:
    | { readonly type: "asked" }
    | { readonly type: "status"; readonly phase: VoiceReadSession["phase"] }
    | { readonly type: "started"; readonly phase: VoiceReadSession["phase"] },
): ReadTrack {
  switch (event.type) {
    case "asked":
      return "asked";
    case "status":
      return track === "asked" && (event.phase === "recording" || event.phase === "embedding")
        ? "mine"
        : track;
    // A start that fails answers with its failure; one under way is seen in the status.
    case "started":
      return track === "asked" && event.phase === "failed" ? "mine" : track;
  }
}

/** Under this the meter warns that the voice is too quiet. */
export const QUIET_LEVEL = 0.25;
