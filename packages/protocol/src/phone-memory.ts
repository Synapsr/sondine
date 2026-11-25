import * as z from "zod";
import {
  PhoneJournalLine,
  PhoneNote,
  PhoneSentence,
  PhoneSpeaker,
  PHONE_ROUTES,
  RecordingName,
} from "./phone-sync";
import { Uuid, WallMs } from "./primitives";
import { named } from "./registry";

// Reading the Mac's memory from the phone (ADR 008, built at M5.4): search,
// a day, its journal, the open commitments and a conversation's text, read
// live and kept in the phone's memory only. Each is `POST /v1/memory/<name>`
// with a JSON body, like the sync's routes (`phone-sync.ts`), with the same
// credential and refusals. The Mac reads them through its own procedures, as
// agents' tools read them (ADR 011): nothing deleted, and an answer read
// while something was deleted is `withheld` (ask again). Never in them:
// voices' data (embeddings, likeness scores, profiles), people's ids,
// diagnostics, settings, keys, or audio.

/** Largest answer of a memory read: a long conversation's text. */
export const MAX_PHONE_MEMORY_BYTES = 8 << 20;
/** Episodes in one page of search results. */
export const PHONE_SEARCH_PAGE = 20;

export const SearchText = named(
  "SearchText",
  "What the user typed in the phone's search field: 1 to 200 characters (UTF-16 units), no control characters. The phone trims it.",
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  z.string().regex(/^[^\u0000-\u001f\u007f]{1,200}$/),
);

const Day = z.iso.date();
const Name = z.string().min(1).max(200);

export const PhoneEpisode = named(
  "PhoneEpisode",
  "An episode of the Mac's memory as the phone lists it: its times (`endedAtMs` null while it goes on), its kind (`context`: in person, a call, media, mixed, a dictation, an import; `size`), its first words, the names the user gave its voices (`people`) and whom Sondine takes others for (`guesses`, unconfirmed, ADR 030), the apps it heard, and for a phone recording its name and, when this phone made it, its id.",
  z.strictObject({
    episodeId: z.int().min(1),
    startedAtMs: WallMs,
    endedAtMs: WallMs.nullable(),
    context: z.enum(["call", "in_person", "media", "mixed", "dictation", "imported"]).nullable(),
    size: z.enum(["trace", "moment", "conversation"]).nullable(),
    firstWords: z.string().max(120).nullable(),
    people: z.array(Name).max(16),
    guesses: z.array(Name).max(16),
    apps: z.array(z.string().min(1).max(120)).max(8),
    phone: z
      .strictObject({ name: RecordingName.nullable(), recordingId: Uuid.nullable() })
      .nullable(),
  }),
);
export type PhoneEpisode = z.output<typeof PhoneEpisode>;

export const PhoneTextRange = named(
  "PhoneTextRange",
  "Where the search matched in a text, in UTF-16 code units: `text.slice(start, end)`.",
  z.strictObject({ start: z.int().min(0), end: z.int().min(0) }),
);

export const PhoneSearchHit = named(
  "PhoneSearchHit",
  "A sentence the search found: its id, times, text, where it matched, and the voice that said it (null when none is known).",
  z.strictObject({
    sentenceId: z.int().min(1),
    startMs: WallMs,
    endMs: WallMs,
    text: z.string().max(20_000),
    highlights: z.array(PhoneTextRange).max(64),
    speaker: PhoneSpeaker.nullable(),
  }),
);
export type PhoneSearchHit = z.output<typeof PhoneSearchHit>;

export const PhoneSearchEpisode = named(
  "PhoneSearchEpisode",
  "An episode the search found: how many of its sentences matched, the best (at most 5) in time order, and its notes or links that matched (their first 500 characters).",
  z.strictObject({
    episode: PhoneEpisode,
    hitCount: z.int().min(0),
    hits: z.array(PhoneSearchHit).max(5),
    notes: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(500),
          highlights: z.array(PhoneTextRange).max(64),
        }),
      )
      .max(5),
  }),
);
export type PhoneSearchEpisode = z.output<typeof PhoneSearchEpisode>;

/** A memory read answered while something was deleted: nothing of it is sent. */
const Withheld = z.strictObject({ status: z.literal("withheld") });

// POST /v1/memory/search

export const MemorySearchRequest = named(
  "MemorySearchRequest",
  "A search of the Mac's transcripts, read as the Mac's search reads it, from `offset` (episodes skipped).",
  z.strictObject({ text: SearchText, offset: z.int().min(0).max(10_000) }),
);
export type MemorySearchRequest = z.output<typeof MemorySearchRequest>;

export const MemorySearchAnswer = named(
  "MemorySearchAnswer",
  "`results`: matching episodes newest first (20 at most), how many match in all, how many closed episodes are not transcribed yet (the search cannot see them), and the offset of the next page (null on the last). `withheld`: something was deleted while it was read; ask again.",
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("results"),
      episodes: z.array(PhoneSearchEpisode).max(PHONE_SEARCH_PAGE),
      total: z.int().min(0),
      untranscribed: z.int().min(0),
      nextOffset: z.int().min(1).nullable(),
    }),
    Withheld,
  ]),
);
export type MemorySearchAnswer = z.output<typeof MemorySearchAnswer>;

// POST /v1/memory/day

export const MemoryDayRequest = named(
  "MemoryDayRequest",
  "A day of the Mac's memory, `YYYY-MM-DD` in the Mac's time zone.",
  z.strictObject({ day: Day }),
);
export type MemoryDayRequest = z.output<typeof MemoryDayRequest>;

export const MemoryDayAnswer = named(
  "MemoryDayAnswer",
  "`day`: the day's conversations newest first (100 at most, the ongoing one included), and how many moments, media, dictations and traces it had. `withheld`: ask again.",
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("day"),
      day: Day,
      conversations: z.array(PhoneEpisode).max(100),
      moments: z.int().min(0),
      media: z.int().min(0),
      dictations: z.int().min(0),
      traces: z.int().min(0),
    }),
    Withheld,
  ]),
);
export type MemoryDayAnswer = z.output<typeof MemoryDayAnswer>;

// POST /v1/memory/journal

export const PhoneMemoryLine = named(
  "PhoneMemoryLine",
  "A line of the Mac's journal or a commitment (ADR 028), read only: as a recording's journal line, with the episode it is about. `sentenceIds` are the sentences of that episode it cites; `startMs` is when the first of them was said.",
  PhoneJournalLine.extend({ episodeId: z.int().min(1) }),
);
export type PhoneMemoryLine = z.output<typeof PhoneMemoryLine>;

export const MemoryJournalRequest = named(
  "MemoryJournalRequest",
  "A day's journal, `YYYY-MM-DD` in the Mac's time zone.",
  z.strictObject({ day: Day }),
);
export type MemoryJournalRequest = z.output<typeof MemoryJournalRequest>;

export const MemoryJournalAnswer = named(
  "MemoryJournalAnswer",
  "`journal`: the day's lines and the commitments made that day, in time order, but those the user said were wrong; how many of its conversations are not written yet, and whether one is being written now. `withheld`: ask again.",
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("journal"),
      day: Day,
      lines: z.array(PhoneMemoryLine).max(1_000),
      commitments: z.array(PhoneMemoryLine).max(500),
      pending: z.int().min(0),
      writing: z.boolean(),
    }),
    Withheld,
  ]),
);
export type MemoryJournalAnswer = z.output<typeof MemoryJournalAnswer>;

// POST /v1/memory/commitments

export const MemoryCommitmentsRequest = named(
  "MemoryCommitmentsRequest",
  "One page of the open commitments made in the 90 days before `beforeMs` (now when null): about 500, newest conversation first.",
  z.strictObject({ beforeMs: WallMs.nullable() }),
);
export type MemoryCommitmentsRequest = z.output<typeof MemoryCommitmentsRequest>;

export const MemoryCommitmentsAnswer = named(
  "MemoryCommitmentsAnswer",
  "`commitments`: a page of the open ones, newest conversation first (about 500: a page never splits the conversations that started in one millisecond); `today` in the Mac's time zone (one whose `due` is before it is late); `nextBeforeMs`, the start of the oldest conversation kept or of the window, for the next page. `withheld`: ask again.",
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("commitments"),
      today: Day,
      commitments: z.array(PhoneMemoryLine).max(2_000),
      nextBeforeMs: WallMs,
    }),
    Withheld,
  ]),
);
export type MemoryCommitmentsAnswer = z.output<typeof MemoryCommitmentsAnswer>;

// POST /v1/memory/conversation

export const MemoryConversationRequest = named(
  "MemoryConversationRequest",
  "An episode's text, by its id on the Mac.",
  z.strictObject({ episodeId: z.int().min(1) }),
);
export type MemoryConversationRequest = z.output<typeof MemoryConversationRequest>;

export const MemoryConversationAnswer = named(
  "MemoryConversationAnswer",
  "`conversation`: the episode, its voices (the user's names, a guess as a guess), its sentences in time order and its notes and links, read only; `truncated` when the last sentences did not fit in one answer. `gone`: deleted, or never there. `withheld`: ask again.",
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("conversation"),
      episode: PhoneEpisode,
      speakers: z.array(PhoneSpeaker).max(64),
      sentences: z.array(PhoneSentence),
      notes: z.array(PhoneNote).max(500),
      truncated: z.boolean(),
    }),
    z.strictObject({ status: z.literal("gone") }),
    Withheld,
  ]),
);
export type MemoryConversationAnswer = z.output<typeof MemoryConversationAnswer>;

/** The memory reads and their bodies. */
export const PHONE_MEMORY_ROUTES = {
  search: { path: "/v1/memory/search", request: MemorySearchRequest, answer: MemorySearchAnswer },
  day: { path: "/v1/memory/day", request: MemoryDayRequest, answer: MemoryDayAnswer },
  journal: {
    path: "/v1/memory/journal",
    request: MemoryJournalRequest,
    answer: MemoryJournalAnswer,
  },
  commitments: {
    path: "/v1/memory/commitments",
    request: MemoryCommitmentsRequest,
    answer: MemoryCommitmentsAnswer,
  },
  conversation: {
    path: "/v1/memory/conversation",
    request: MemoryConversationRequest,
    answer: MemoryConversationAnswer,
  },
} as const;
export type PhoneMemoryRoute = keyof typeof PHONE_MEMORY_ROUTES;

/** Every JSON route a phone may call: the sync's and the memory reads. */
export const PHONE_ALL_ROUTES = { ...PHONE_ROUTES, ...PHONE_MEMORY_ROUTES } as const;

/** Every memory message schema by name: the fixtures' `schema` field names one. */
export const PHONE_MEMORY_SCHEMAS = {
  MemorySearchRequest,
  MemorySearchAnswer,
  MemoryDayRequest,
  MemoryDayAnswer,
  MemoryJournalRequest,
  MemoryJournalAnswer,
  MemoryCommitmentsRequest,
  MemoryCommitmentsAnswer,
  MemoryConversationRequest,
  MemoryConversationAnswer,
} as const;
export type PhoneMemorySchemaName = keyof typeof PHONE_MEMORY_SCHEMAS;
