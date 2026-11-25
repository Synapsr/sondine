import type { EpisodeContext, TrackKind } from "./types";

/** One speaker of a published transcript, with the track it was heard on. */
export interface SpeakerSource {
  readonly label: string;
  readonly trackKind: TrackKind;
  readonly voicedMs: number;
}

/**
 * The user as far as the sources tell: in a call or a dictation (the user
 * talking to a dictation app), the speaker heard on the microphone (`input`)
 * with the most voiced time; ties go to the earlier speaker in `speakers`.
 * Null elsewhere, and when no speaker was heard on the microphone.
 *
 * A source assumption, not an identity: built-in speakers let the
 * microphone hear the far side too (ADR 016), so this marks at most one
 * speaker, never merges speakers, and is derived at each read, never stored.
 * Identities come in M3.
 */
export function selfSpeakerLabel(
  context: EpisodeContext | null,
  speakers: readonly SpeakerSource[],
): string | null {
  if (context !== "call" && context !== "dictation") return null;
  let best: SpeakerSource | null = null;
  for (const speaker of speakers) {
    if (speaker.trackKind !== "input") continue;
    if (best === null || speaker.voicedMs > best.voicedMs) best = speaker;
  }
  return best?.label ?? null;
}
