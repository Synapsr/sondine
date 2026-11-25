import { createRouterClient, ORPCError, type RouterClient } from "@orpc/server";
import {
  router,
  type ApiServices,
  type EpisodeSummary,
  type JournalCommitment,
  type JournalLine,
  type SearchHit,
  type UsageCounter,
} from "@sondine/api";
import { phoneRecordingsOfEpisodes, type Database } from "@sondine/db";
import {
  MAX_PHONE_MEMORY_BYTES,
  PHONE_SEARCH_PAGE,
  RecordingName,
  type MemoryCommitmentsAnswer,
  type MemoryCommitmentsRequest,
  type MemoryConversationAnswer,
  type MemoryConversationRequest,
  type MemoryDayAnswer,
  type MemoryDayRequest,
  type MemoryJournalAnswer,
  type MemoryJournalRequest,
  type MemorySearchAnswer,
  type MemorySearchRequest,
  type PhoneEpisode,
  type PhoneMemoryLine,
  type PhoneMemoryRoute,
  type PHONE_MEMORY_ROUTES,
  type PhoneSearchEpisode,
  type PhoneSpeaker,
} from "@sondine/protocol";
import type * as z from "zod";
import {
  cut,
  lineVoice,
  localDay,
  nameOf,
  notesOf,
  sentencesOf,
  speakersOf,
} from "./phone-results";

// The phone's live reads of the Mac's memory (ADR 008, M5.4): search, a day,
// its journal, the open commitments and an episode's text. Each runs the
// procedure the agent's tool of the same read runs (`PHONE_MEMORY_READS`),
// in process, so the deletion filter and what may be read are theirs; an
// answer read while something was deleted is withheld, as an agent's is
// (ADR 011). What goes out is cut to what the phone shows: names, never ids
// of people, likeness scores, labels of voices, tracks, settings or audio.
// A phone sees its own recordings' ids, never another phone's.

export type MemoryInput<R extends PhoneMemoryRoute> = z.output<
  (typeof PHONE_MEMORY_ROUTES)[R]["request"]
>;
export type MemoryAnswer<R extends PhoneMemoryRoute> = z.output<
  (typeof PHONE_MEMORY_ROUTES)[R]["answer"]
>;

/** Each read, for the phone `deviceId` that asks. */
export type PhoneMemoryReads = {
  readonly [R in PhoneMemoryRoute]: (
    input: MemoryInput<R>,
    deviceId: string,
  ) => Promise<MemoryAnswer<R>>;
};

export interface PhoneMemoryDeps {
  readonly db: Database;
  /** The app's procedures, once the API is built. */
  readonly services: () => ApiServices | null;
  /** The anonymous statistics (ADR 042). */
  readonly usage?: UsageCounter;
  /** Moves the moment anything is deleted (ADR 011's content generation). */
  readonly contentGeneration: () => number;
  readonly now?: () => number;
  /** Runs between the reads and their check; tests delete something there. */
  readonly whileReading?: () => Promise<void>;
  /** The largest answer sent, `MAX_PHONE_MEMORY_BYTES`; tests lower it. */
  readonly maxAnswerBytes?: number;
}

const WITHHELD = { status: "withheld" } as const;
/** Open commitments asked for one page; a page may hold a few more (`journal.commitments`). */
const COMMITMENTS_PAGE = 500;

/** The UTF-8 bytes of a value's JSON, as the answer carries it. */
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * The longest prefix of `items` whose JSON fits in `room` bytes (an array's
 * commas included), and the room left.
 */
function fitting<T>(items: readonly T[], room: number): { kept: T[]; left: number } {
  let left = room;
  let count = 0;
  for (const item of items) {
    const size = bytesOf(item) + (count === 0 ? 0 : 1);
    if (size > left) break;
    left -= size;
    count += 1;
  }
  return { kept: items.slice(0, count), left };
}

type Client = RouterClient<typeof router>;

/** A phone recording's name as the wire takes it; null when blank or not one. */
const recordingName = (name: string | null): string | null =>
  name !== null && RecordingName.safeParse(name).success ? name : null;

const names = (people: readonly { readonly name: string }[]) =>
  people
    .map((person) => nameOf(person.name))
    .filter((name) => name !== null)
    .slice(0, 16);

/** A voice of a search hit, as the transcript names it. */
function hitSpeaker(hit: SearchHit): PhoneSpeaker | null {
  if (hit.speakerOrdinal === null) return null;
  return {
    ordinal: hit.speakerOrdinal,
    name: nameOf(hit.person?.name),
    guess: hit.person === null ? nameOf(hit.recognized?.name) : null,
    self: hit.self,
  };
}

/** A journal line or a commitment, with the sentences of its episode it cites. */
function memoryLine(
  kind: PhoneMemoryLine["kind"],
  line: JournalLine,
  due: string | null,
): PhoneMemoryLine {
  const cited = line.citations.filter((citation) => citation.episodeId === line.episodeId);
  return {
    kind,
    episodeId: line.episodeId,
    text: cut(line.text, 2_000),
    voices: line.voices.slice(0, 32).map(lineVoice),
    sentenceIds: cited.slice(0, 64).map((citation) => citation.segmentId),
    startMs: cited[0]?.startMs ?? line.startMs,
    done: line.status === "done",
    due,
  };
}

/** Lines the user did not say were wrong, and that say something. */
const shown = (line: JournalLine) => line.status !== "dismissed" && line.text.trim() !== "";

const byTime = (a: PhoneMemoryLine, b: PhoneMemoryLine) => a.startMs - b.startMs;

const commitmentLine = (commitment: JournalCommitment) =>
  memoryLine("commitment", commitment, commitment.due);

export function makePhoneMemory(deps: PhoneMemoryDeps): PhoneMemoryReads {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxAnswerBytes ?? MAX_PHONE_MEMORY_BYTES;

  /**
   * Runs `read` with the app's procedures and answers what it built, or
   * `withheld` when something was deleted meanwhile. `missing` answers a
   * `NOT_FOUND` that no deletion explains.
   */
  const guarded = async <A>(
    read: (client: Client) => Promise<A>,
    missing?: () => A,
  ): Promise<A | typeof WITHHELD> => {
    const services = deps.services();
    if (services === null) throw new Error("the API is not ready yet");
    const generation = deps.contentGeneration();
    const client = createRouterClient(router, {
      context:
        deps.usage === undefined
          ? { services }
          : { services, usage: { counter: deps.usage, surface: "mobile" } },
    });
    let answer: A;
    try {
      answer = await read(client);
    } catch (error) {
      if (deps.contentGeneration() !== generation) return WITHHELD;
      if (missing !== undefined && error instanceof ORPCError && error.code === "NOT_FOUND") {
        return missing();
      }
      throw error;
    }
    await deps.whileReading?.();
    return deps.contentGeneration() === generation ? answer : WITHHELD;
  };

  /** The episodes as the phone lists them; `deviceId` sees its own recordings' ids. */
  const episodesOf = (summaries: readonly EpisodeSummary[], deviceId: string) => {
    const held = phoneRecordingsOfEpisodes(
      db,
      summaries.filter((summary) => summary.phone !== null).map((summary) => summary.id),
    );
    return summaries.map((summary): PhoneEpisode => ({
      episodeId: summary.id,
      startedAtMs: summary.startedAtMs,
      endedAtMs: summary.endedAtMs,
      context: summary.context,
      size: summary.size,
      firstWords: summary.firstWords === null ? null : cut(summary.firstWords, 120),
      people: names(summary.people),
      guesses: names(summary.recognized),
      apps: summary.apps
        .map((app) => cut(app.name.trim(), 120))
        .filter((name) => name !== "")
        .slice(0, 8),
      phone:
        summary.phone === null
          ? null
          : {
              name: recordingName(summary.phone.name),
              recordingId:
                held.get(summary.id)?.deviceId === deviceId
                  ? (held.get(summary.id)?.recordingId ?? null)
                  : null,
            },
    }));
  };

  const search = (input: MemorySearchRequest, deviceId: string): Promise<MemorySearchAnswer> => {
    const text = input.text.trim();
    if (text === "") {
      return Promise.resolve({
        status: "results",
        episodes: [],
        total: 0,
        untranscribed: 0,
        nextOffset: null,
      });
    }
    return guarded(async (client) => {
      const found = await client.search.query({
        text,
        offset: input.offset,
        limit: PHONE_SEARCH_PAGE,
      });
      const cards = new Map(
        episodesOf(
          found.episodes.map((entry) => entry.episode),
          deviceId,
        ).map((card) => [card.episodeId, card]),
      );
      const next = input.offset + found.episodes.length;
      return {
        status: "results",
        episodes: found.episodes.flatMap((entry): PhoneSearchEpisode[] => {
          const episode = cards.get(entry.episode.id);
          if (episode === undefined) return [];
          return [
            {
              episode,
              hitCount: entry.hitCount,
              hits: entry.hits.map((hit) => ({
                sentenceId: hit.segmentId,
                startMs: hit.startMs,
                endMs: hit.endMs,
                text: cut(hit.text, 20_000),
                highlights: hit.highlights.slice(0, 64),
                speaker: hitSpeaker(hit),
              })),
              notes: entry.contextHits
                .filter(
                  (item) => (item.kind === "note" || item.kind === "link") && item.text !== "",
                )
                .map((item) => ({
                  text: cut(item.text, 500),
                  highlights: item.highlights.slice(0, 64),
                })),
            },
          ];
        }),
        total: found.total,
        untranscribed: found.untranscribed,
        nextOffset: found.episodes.length > 0 && next < found.total ? next : null,
      };
    });
  };

  const day = (input: MemoryDayRequest, deviceId: string): Promise<MemoryDayAnswer> =>
    guarded(async (client) => {
      const overview = await client.episodes.day({ day: input.day });
      return {
        status: "day",
        day: overview.day,
        conversations: episodesOf(overview.conversations.episodes.slice(0, 100), deviceId),
        moments: overview.momentHours.reduce((sum, hour) => sum + hour.moments, 0),
        media: overview.media.total,
        dictations: overview.dictations.total,
        traces: overview.traces,
      };
    });

  const journal = (input: MemoryJournalRequest): Promise<MemoryJournalAnswer> =>
    guarded(async (client) => {
      const written = await client.journal.day({ day: input.day });
      return {
        status: "journal",
        day: written.day,
        lines: written.conversations
          .flatMap((conversation) => conversation.lines.filter(shown))
          .map((line) => memoryLine("line", line, null))
          .toSorted(byTime)
          .slice(0, 1_000),
        commitments: written.commitments
          .filter(shown)
          .map(commitmentLine)
          .toSorted(byTime)
          .slice(0, 500),
        pending: written.state.pending,
        writing: written.state.writing,
      };
    });

  const commitments = (input: MemoryCommitmentsRequest): Promise<MemoryCommitmentsAnswer> =>
    guarded(async (client) => {
      // One page of the procedure itself: its cursor skips nothing.
      const open = await client.journal.commitments({
        status: "open",
        days: 90,
        limit: COMMITMENTS_PAGE,
        ...(input.beforeMs === null ? {} : { beforeMs: input.beforeMs }),
      });
      return {
        status: "commitments",
        today: localDay(now()),
        commitments: open.commitments.filter(shown).map(commitmentLine),
        nextBeforeMs: open.nextBeforeMs,
      };
    });

  const conversation = (
    input: MemoryConversationRequest,
    deviceId: string,
  ): Promise<MemoryConversationAnswer> =>
    guarded(
      async (client): Promise<MemoryConversationAnswer> => {
        const detail = await client.episodes.get({ episodeId: input.episodeId });
        const [episode] = episodesOf([detail.episode], deviceId);
        if (episode === undefined) return { status: "gone" };
        const sentences = sentencesOf(detail);
        const notes = notesOf(detail);
        const bare = {
          status: "conversation",
          episode,
          speakers: speakersOf(detail),
          sentences: [],
          notes: [],
          truncated: true,
        } satisfies MemoryConversationAnswer;
        // One budget for the whole answer: the sentences first (the
        // conversation itself), then the notes in what is left.
        const said = fitting(sentences, maxBytes - bytesOf(bare));
        const added = fitting(notes, said.left);
        const answer: MemoryConversationAnswer = {
          ...bare,
          sentences: said.kept,
          notes: added.kept,
          truncated: said.kept.length < sentences.length || added.kept.length < notes.length,
        };
        // The answer as sent: never over the limit, whatever was measured.
        while (
          bytesOf(answer) > maxBytes &&
          (answer.notes.length > 0 || answer.sentences.length > 0)
        ) {
          if (answer.notes.length > 0) answer.notes = answer.notes.slice(0, -1);
          else answer.sentences = answer.sentences.slice(0, -1);
          answer.truncated = true;
        }
        return answer;
      },
      () => ({ status: "gone" }),
    );

  return { search, day, journal, commitments, conversation };
}
