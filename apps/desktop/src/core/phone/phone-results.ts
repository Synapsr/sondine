import { createHash } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import {
  router,
  type ApiServices,
  type EpisodeDetail,
  type JournalDay,
  type JournalLine,
  type JournalVoice,
} from "@sondine/api";
import {
  phoneRecordingEpisode,
  phoneRecordingReadings,
  storedPhoneRecording,
  type Database,
} from "@sondine/db";
import type {
  GetAnswer,
  PhoneJournalLine,
  PhoneLineVoice,
  PhoneNote,
  PhoneResult,
  PhoneSentence,
  PhoneSpeaker,
} from "@sondine/protocol";

// A phone recording's result (ADR 008, « What the phone keeps », M5.3): what
// the Mac's own procedures read of its episode (`episodes.get`, `journal.day`),
// with their deletion filter, cut to what the phone shows. Its revision is
// the SHA-256 of the result's JSON as sent, built from one read: whatever
// changes what the phone would show changes it, and nothing is stored to keep
// it. An answer read while something was deleted is withheld, as an agent's
// is (ADR 011).

export interface PhoneResultDeps {
  readonly db: Database;
  /** The app's procedures, once the API is built. */
  readonly services: () => ApiServices | null;
  /** The playback timeline of an episode (`episodes.playback` plans the same). */
  readonly playback: (episodeId: number) => {
    readonly generation: number;
    readonly startedAtMs: number | null;
    readonly durationMs: number;
  } | null;
  /** Moves the moment anything is deleted (ADR 011's content generation). */
  readonly contentGeneration: () => number;
  /** Runs between the reads and their check; tests delete something there. */
  readonly whileReading?: () => Promise<void>;
}

/** `YYYY-MM-DD` of a time in the Mac's time zone, as `journal.day` names days. */
export const localDay = (ms: number): string =>
  new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
    ms,
  );

const NAME_MAX = 200;
export const cut = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max));
export const nameOf = (name: string | null | undefined): string | null =>
  name === null || name === undefined || name === "" ? null : cut(name, NAME_MAX);

/**
 * The transcript's voices. `version` 2 adds `guessSelf` (ADR 039): the guess
 * is the user, which the phone may confirm; a version 1 phone reads no such key.
 */
export function speakersOf(detail: EpisodeDetail, version = 1): PhoneSpeaker[] {
  return detail.speakers.slice(0, 64).map((speaker) => {
    const guess = speaker.person === null ? (speaker.recognized ?? speaker.suggestion) : null;
    return {
      ordinal: speaker.ordinal,
      name: nameOf(speaker.person?.name),
      guess: nameOf(guess?.person.name),
      self: speaker.self,
      ...(version >= 2 ? { guessSelf: guess?.person.self === true } : {}),
    };
  });
}

export const lineVoice = (voice: JournalVoice): PhoneLineVoice => ({
  ref: voice.ref,
  ordinal: voice.ordinal,
  name: nameOf(voice.name),
  guess: voice.name === null ? nameOf(voice.guess?.person.name) : null,
  self: voice.self,
});

/** The transcript's sentences, each with its voice's number. */
export function sentencesOf(detail: EpisodeDetail): PhoneSentence[] {
  return detail.segments.map((segment) => ({
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker:
      segment.speakerLabel === null
        ? null
        : (detail.speakers.find((speaker) => speaker.label === segment.speakerLabel)?.ordinal ??
          null),
    text: cut(segment.text, 20_000),
  }));
}

/** The notes and links the user added to it (not its images or files). */
export function notesOf(detail: EpisodeDetail): PhoneNote[] {
  return detail.context
    .filter((item) => (item.kind === "note" || item.kind === "link") && item.text.trim() !== "")
    .slice(0, 500)
    .map((item) => ({ id: item.id, text: cut(item.text, 20_000), addedAtMs: item.addedAtMs }));
}

/** Lines and commitments of the recording's days that cite it, but those the user said were wrong. */
function journalOf(episodeId: number, days: readonly JournalDay[]): PhoneJournalLine[] {
  const out: PhoneJournalLine[] = [];
  const seen = new Set<string>();
  const add = (kind: PhoneJournalLine["kind"], line: JournalLine, due: string | null) => {
    const cited = line.citations.filter((citation) => citation.episodeId === episodeId);
    if (line.status === "dismissed" || line.text.trim() === "") return;
    if (line.episodeId !== episodeId && cited.length === 0) return;
    const key = `${kind}:${line.itemId ?? ""}:${line.markId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind,
      text: cut(line.text, 2_000),
      voices: line.voices.slice(0, 32).map(lineVoice),
      sentenceIds: cited.slice(0, 64).map((citation) => citation.segmentId),
      startMs: line.startMs,
      done: line.status === "done",
      due,
    });
  };
  for (const day of days) {
    for (const conversation of day.conversations) {
      for (const line of conversation.lines) add("line", line, null);
    }
    for (const commitment of day.commitments) add("commitment", commitment, commitment.due);
  }
  return out.toSorted((a, b) => a.startMs - b.startMs).slice(0, 500);
}

/** The SHA-256 of a result's JSON, as the answer carries it. */
export const resultRevision = (result: PhoneResult): string =>
  createHash("sha256").update(JSON.stringify(result), "utf8").digest("hex");

/**
 * The answer to `get` for the phone `deviceId` (its owner, checked by the
 * caller): the result when its revision is not `revision`.
 */
export async function readPhoneResult(
  deps: PhoneResultDeps,
  input: {
    readonly deviceId: string;
    readonly recordingId: string;
    readonly revision: string | null;
    /** The phone's sync version: tags and `guessSelf` from 2 (ADR 039). */
    readonly version: number;
  },
): Promise<GetAnswer> {
  const { db } = deps;
  const generation = deps.contentGeneration();
  const [state] = phoneRecordingReadings(db, input.deviceId, [input.recordingId]);
  if (state !== "ready") return { status: "unavailable", state: state ?? "unknown" };
  const stored = storedPhoneRecording(db, input.recordingId);
  const episodeId = phoneRecordingEpisode(db, input.recordingId);
  const services = deps.services();
  if (stored === null || episodeId === null || services === null) {
    return { status: "unavailable", state: "waiting" };
  }
  const client = createRouterClient(router, { context: { services } });
  let read: { detail: EpisodeDetail; journal: JournalDay[] };
  try {
    const detail = await client.episodes.get({ episodeId });
    const startedAtMs = detail.episode.startedAtMs;
    const days = [...new Set([startedAtMs, detail.episode.endedAtMs ?? startedAtMs].map(localDay))];
    read = { detail, journal: await Promise.all(days.map((day) => client.journal.day({ day }))) };
  } catch (error) {
    // Deleted while it was read: as below.
    if (deps.contentGeneration() !== generation) return { status: "withheld" };
    throw error;
  }
  const { detail } = read;
  const startedAtMs = detail.episode.startedAtMs;
  const endedAtMs = detail.episode.endedAtMs ?? startedAtMs;
  const plan = deps.playback(episodeId);
  await deps.whileReading?.();
  // Read before a deletion committed: withheld, the phone asks again.
  if (deps.contentGeneration() !== generation) return { status: "withheld" };
  const result: PhoneResult = {
    recordingId: input.recordingId,
    name: stored.name,
    startedAtMs,
    endedAtMs,
    timeUncertain: stored.timeUncertain,
    speakers: speakersOf(detail, input.version),
    sentences: sentencesOf(detail),
    journal: journalOf(episodeId, read.journal),
    notes: notesOf(detail),
    ...(input.version >= 2 ? { tags: detail.episode.tags } : {}),
    audio:
      plan === null || plan.startedAtMs === null || detail.privacy.audioGone
        ? null
        : {
            generation: plan.generation,
            startedAtMs: plan.startedAtMs,
            durationMs: plan.durationMs,
          },
  };
  const revision = resultRevision(result);
  return revision === input.revision
    ? { status: "unchanged" }
    : { status: "result", revision, result };
}
