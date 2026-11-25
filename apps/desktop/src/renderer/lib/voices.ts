import type { EpisodeSpeaker, PersonRef } from "@sondine/api";

// How voices are named. A voice the user named reads as that person's name
// (« Marie »), the one named as the user as « Moi »; so does a voice Sondine
// recognized (ADR 030), marked until the user answers (« Marie* »). Otherwise, in a
// call, the microphone voice that speaks most is shown as « Moi » (`self`): an
// assumption from the sources, never an identity, which a voice named or
// recognized as the user replaces. The other voices are
// numbered by their ordinal, skipping the user's, so a call reads « Moi »,
// « Voix 1 », « Voix 2 » and an in-person talk « Voix 1 », « Voix 2 »; a
// named voice keeps its number for its colour and place in the player.
// Before a transcript, only the side the speech came from is known: the
// microphone or the Mac's own sound (`track`).

export type Voice =
  /** `recognized`: Sondine recognized the voice, the user did not name it (ADR 030). */
  | { readonly kind: "self"; readonly recognized?: true }
  | {
      readonly kind: "person";
      readonly personId: number;
      readonly name: string;
      readonly number: number;
      readonly recognized?: true;
    }
  | { readonly kind: "other"; readonly number: number }
  | { readonly kind: "unknown" }
  | { readonly kind: "track"; readonly track: "microphone" | "computer" };

const SELF: Voice = { kind: "self" };
const UNKNOWN: Voice = { kind: "unknown" };

/** A voice's number once the user's voice is taken out of the count. */
export function voiceNumber(ordinal: number, selfOrdinal: number | null): number {
  return selfOrdinal !== null && ordinal > selfOrdinal ? ordinal - 1 : ordinal;
}

/**
 * The voice of a speaker known by its ordinal and who it is, if anyone: the
 * person the user named it as, or the one Sondine recognized (ADR 030).
 */
export function voiceOf(
  ordinal: number | null,
  self: boolean,
  selfOrdinal: number | null,
  person: PersonRef | null = null,
  recognized: PersonRef | null = null,
): Voice {
  const shown = person ?? recognized;
  const mark = person === null && recognized !== null ? { recognized: true as const } : {};
  // The guessed `self` never outweighs a person: the API drops it for a named
  // voice, and a recognized one may be someone else.
  if (shown?.self === true) return { ...SELF, ...mark };
  if (self && shown === null) return SELF;
  if (ordinal === null) return UNKNOWN;
  const number = voiceNumber(ordinal, selfOrdinal);
  return shown === null
    ? { kind: "other", number }
    : { kind: "person", personId: shown.id, name: shown.name, number, ...mark };
}

export interface EpisodeVoice {
  readonly label: string;
  readonly voice: Voice;
  readonly voicedMs: number;
}

/**
 * The episode's voices: the user's first, then by number. A voice Sondine
 * recognized reads as its person unless `recognized` is false: what leaves
 * the app (exports) keeps the names the user gave (ADR 030).
 */
export function episodeVoices(
  speakers: readonly EpisodeSpeaker[],
  { recognized = true }: { readonly recognized?: boolean } = {},
): EpisodeVoice[] {
  const guessOf = (speaker: EpisodeSpeaker): PersonRef | null =>
    recognized ? (speaker.recognized?.person ?? null) : null;
  // The API's `self` is already the one that counts: a voice named as the user, or
  // recognized on enough evidence, took the place of the sources' guess.
  const isSelf = (speaker: EpisodeSpeaker) => {
    const person = speaker.person ?? guessOf(speaker);
    return person === null ? speaker.self : person.self;
  };
  // Numbered around that voice only, as search and the journal number them.
  const selfOrdinal =
    speakers.find((speaker) => speaker.self || speaker.person?.self === true)?.ordinal ?? null;
  return speakers
    .map((speaker) => ({
      label: speaker.label,
      voice: voiceOf(
        speaker.ordinal,
        isSelf(speaker),
        selfOrdinal,
        speaker.person,
        guessOf(speaker),
      ),
      voicedMs: speaker.voicedMs,
      order: isSelf(speaker) ? 0 : speaker.ordinal,
    }))
    .toSorted((a, b) => a.order - b.order)
    .map(({ order: _order, ...voice }) => voice);
}

/** Each speaker label's voice, for the segments that carry the label. */
export function voicesByLabel(
  speakers: readonly EpisodeSpeaker[],
  options: { readonly recognized?: boolean } = {},
): ReadonlyMap<string, Voice> {
  return new Map(episodeVoices(speakers, options).map((entry) => [entry.label, entry.voice]));
}

/** The voice of a segment's speaker label; unknown without one. */
export function voiceOfLabel(voices: ReadonlyMap<string, Voice>, label: string | null): Voice {
  return label === null ? UNKNOWN : (voices.get(label) ?? UNKNOWN);
}

/** Sondine recognized the voice; the user did not name it (ADR 030). */
export const isRecognized = (voice: Voice): boolean =>
  (voice.kind === "self" || voice.kind === "person") && voice.recognized === true;

/** Two voices are the same speaker (turns group on it). */
export function sameVoice(a: Voice, b: Voice): boolean {
  if (a.kind === "person") return b.kind === "person" && a.personId === b.personId;
  if (a.kind === "other") return b.kind === "other" && a.number === b.number;
  if (a.kind === "track") return b.kind === "track" && a.track === b.track;
  return a.kind === b.kind;
}

/** The voices of one person, or one voice nobody is known as: one badge (ADR 037). */
export interface VoiceGroup {
  readonly key: string;
  /** How the badge reads: a voice the user named before one Sondine only recognized. */
  readonly voice: Voice;
  readonly entries: readonly EpisodeVoice[];
  /** All its voices' speaking time. */
  readonly voicedMs: number;
}

/**
 * The episode's voices by person: two voices of « Marie » (diarization gave
 * her two numbers) are one badge with both times added; « Moi » is one; a
 * voice nobody is known as stays on its own. In `episodeVoices` order.
 */
export function voiceGroups(entries: readonly EpisodeVoice[]): VoiceGroup[] {
  const groups = new Map<string, EpisodeVoice[]>();
  for (const entry of entries) {
    const { voice } = entry;
    const key =
      voice.kind === "self"
        ? "self"
        : voice.kind === "person"
          ? `person:${voice.personId}`
          : `voice:${entry.label}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([key, list]) => {
    const first = list[0];
    if (first === undefined) throw new Error("a group has a voice");
    return {
      key,
      voice: (list.find((entry) => !isRecognized(entry.voice)) ?? first).voice,
      entries: list,
      voicedMs: list.reduce((sum, entry) => sum + entry.voicedMs, 0),
    };
  });
}
