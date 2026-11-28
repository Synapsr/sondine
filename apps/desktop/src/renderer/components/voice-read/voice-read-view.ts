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

/** Under this the meter warns that the voice is too quiet. */
export const QUIET_LEVEL = 0.25;
