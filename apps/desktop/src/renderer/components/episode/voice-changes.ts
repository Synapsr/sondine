import type { EpisodeDetail, EpisodeSpeaker, PersonRef, TranscriptSegment } from "@sondine/api";
import { TURN_GAP_MS } from "./transcript-view";

// What a voice action changes in an episode as the window shows it, applied
// at once while core does it (ADR 037: confirming a voice is a primary action,
// and answers in the same frame). Core's answer replaces it when it comes; an
// error puts the episode back as it was.

function withSpeakers(
  detail: EpisodeDetail,
  change: (speaker: EpisodeSpeaker) => EpisodeSpeaker,
): EpisodeDetail {
  return withPeople({ ...detail, speakers: detail.speakers.map(change) });
}

/** The episode's people as its voices now say: the title and the badges agree. */
function withPeople(detail: EpisodeDetail): EpisodeDetail {
  const { episode, speakers } = detail;
  const listed = (known: readonly PersonRef[], heard: readonly PersonRef[]) => {
    const people = [...known, ...heard].filter(
      (person, index, all) =>
        heard.some((voice) => voice.id === person.id) &&
        all.findIndex((other) => other.id === person.id) === index,
    );
    return people.toSorted((a, b) => Number(b.self) - Number(a.self));
  };
  const people = listed(
    episode.people,
    speakers.flatMap((speaker) => speaker.person ?? []),
  );
  const recognized = listed(
    episode.recognized,
    speakers.flatMap((speaker) =>
      speaker.person === null ? (speaker.recognized?.person ?? []) : [],
    ),
  ).filter((person) => !people.some((named) => named.id === person.id));
  return { ...detail, episode: { ...episode, people, recognized } };
}

/** The voice `label` named as `person`: no longer a guess. */
export function namedIn(detail: EpisodeDetail, label: string, person: PersonRef): EpisodeDetail {
  return withSpeakers(detail, (speaker) =>
    speaker.label === label
      ? { ...speaker, person, self: person.self, recognized: null, suggestion: null }
      : // One user: a voice named as them takes the place of the guess.
        person.self && speaker.person === null
        ? { ...speaker, self: false }
        : speaker,
  );
}

/** « Non »: the voice is not that person; Sondine's guess goes. */
export function refusedIn(detail: EpisodeDetail, label: string, personId: number): EpisodeDetail {
  return withSpeakers(detail, (speaker) =>
    speaker.label === label
      ? {
          ...speaker,
          recognized: speaker.recognized?.person.id === personId ? null : speaker.recognized,
          suggestion: speaker.suggestion?.person.id === personId ? null : speaker.suggestion,
        }
      : speaker,
  );
}

/** « Retirer le nom ». */
export function unnamedIn(detail: EpisodeDetail, label: string): EpisodeDetail {
  return withSpeakers(detail, (speaker) =>
    speaker.label === label ? { ...speaker, person: null } : speaker,
  );
}

/**
 * « Fusionner avec… » (ADR 038): the voice that speaks later joins the one
 * that speaks first (the lower ordinal), its sentences and time with it; the
 * voices after it move up a number, as core numbers them. Guesses of either
 * go until Sondine hears the joined voice again.
 */
export function mergedIn(detail: EpisodeDetail, label: string, other: string): EpisodeDetail {
  const one = detail.speakers.find((speaker) => speaker.label === label);
  const two = detail.speakers.find((speaker) => speaker.label === other);
  if (one === undefined || two === undefined || one === two) return detail;
  const [target, source] = one.ordinal < two.ordinal ? [one, two] : [two, one];
  return withPeople({
    ...detail,
    speakers: detail.speakers.flatMap((speaker) =>
      speaker === source
        ? []
        : speaker === target
          ? [
              {
                ...speaker,
                voicedMs: speaker.voicedMs + source.voicedMs,
                recognized: null,
                suggestion: null,
              },
            ]
          : [
              speaker.ordinal > source.ordinal
                ? { ...speaker, ordinal: speaker.ordinal - 1 }
                : speaker,
            ],
    ),
    segments: detail.segments.map((segment) =>
      segment.speakerLabel === source.label ? { ...segment, speakerLabel: target.label } : segment,
    ),
  });
}

/** Where a voice speaks: from its first sentence to the last of a run of its own. */
export interface Passage {
  /** The first sentence's index in the transcript. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The passages of some voices, in time order: their sentences one after the
 * other, until another voice speaks or a long silence, as turns read.
 */
export function passagesOf(
  segments: readonly Pick<TranscriptSegment, "startMs" | "endMs" | "speakerLabel">[],
  labels: ReadonlySet<string>,
): Passage[] {
  const out: { index: number; startMs: number; endMs: number }[] = [];
  let open = false;
  segments.forEach((segment, index) => {
    if (segment.speakerLabel === null || !labels.has(segment.speakerLabel)) {
      open = false;
      return;
    }
    const last = out.at(-1);
    if (open && last !== undefined && segment.startMs - last.endMs < TURN_GAP_MS) {
      last.endMs = Math.max(last.endMs, segment.endMs);
    } else {
      out.push({ index, startMs: segment.startMs, endMs: segment.endMs });
    }
    open = true;
  });
  return out;
}
