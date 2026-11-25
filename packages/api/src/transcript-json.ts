import * as z from "zod";
import { ContextKind, EpisodeContext, EpisodeSize } from "./schemas";

/**
 * A transcript exported as JSON (M2): versioned, so a script or an agent
 * reads it the same way later. Times are UTC ISO 8601 with the Mac's time
 * zone beside them; `offsetMs` counts from the episode's start. Speaker names
 * are the ones on screen, in the user's language; voice data is never in it.
 * `docs/schemas/transcript-2.schema.json` is this schema as JSON Schema
 * (`pnpm --filter @sondine/api run gen` writes it). Version 2 (2026-11-09)
 * adds the context the user added to the conversation (ADR 024); version 1
 * was strict, so it could not take a new field.
 */
export const TRANSCRIPT_JSON_SCHEMA = "sondine.transcript/2";

const Instant = z.iso.datetime();

/** One item the user added to the conversation: its text, never a file's bytes. */
const ContextJson = z.strictObject({
  kind: ContextKind,
  addedAt: Instant,
  /** The start of the sentence it is pinned to; null for the whole conversation. */
  pinnedAt: Instant.nullable(),
  /** A note's text, or a link's address; empty for an image or a file. */
  text: z.string(),
  /** A link's title the user typed, or a file's name; null when none. */
  title: z.string().nullable(),
  file: z.strictObject({ mediaType: z.string(), bytes: z.int().min(0) }).nullable(),
});

export const TranscriptJsonV2 = z.strictObject({
  schema: z.literal(TRANSCRIPT_JSON_SCHEMA),
  episode: z.strictObject({
    id: z.int().positive(),
    startedAt: Instant,
    /** Null while it was still going on. */
    endedAt: Instant.nullable(),
    /** IANA name, for example `Europe/Paris`. */
    timeZone: z.string().min(1),
    context: EpisodeContext.nullable(),
    size: EpisodeSize.nullable(),
    /** Apps heard in it (the call app, what played the media, the app a dictation was said to). */
    apps: z.array(z.string()),
  }),
  speakers: z.array(
    z.strictObject({
      /** The speaker's id in this transcript; segments refer to it. */
      label: z.string(),
      /** As on screen: « Moi », « Voix 2 », or the name the user gave. */
      name: z.string(),
      /** The voice is the user's, as named or as the sources tell in a call or a dictation. */
      self: z.boolean(),
      person: z.strictObject({ id: z.int().positive(), name: z.string() }).nullable(),
      voicedMs: z.int().min(0),
    }),
  ),
  segments: z.array(
    z.strictObject({
      start: Instant,
      end: Instant,
      offsetMs: z.int().min(0),
      /** A `speakers[].label`, or null when the segment has no speaker. */
      speaker: z.string().nullable(),
      text: z.string(),
      lang: z.string().nullable(),
      /** The user corrected the text. */
      edited: z.boolean(),
    }),
  ),
  /** What the user added to the conversation, oldest first. */
  context: z.array(ContextJson),
});
export type TranscriptJsonV2 = z.output<typeof TranscriptJsonV2>;

/** A day's transcripts in one JSON file: the episodes in time order, each as above. */
export const DAY_JSON_SCHEMA = "sondine.day/2";

export const DayJsonV2 = z.strictObject({
  schema: z.literal(DAY_JSON_SCHEMA),
  /** The local day, `YYYY-MM-DD`. */
  day: z.iso.date(),
  timeZone: z.string().min(1),
  episodes: z.array(TranscriptJsonV2),
});
export type DayJsonV2 = z.output<typeof DayJsonV2>;

/** Search results as JSON: each matching episode with its best matches. */
export const SEARCH_JSON_SCHEMA = "sondine.search/2";

export const SearchJsonV2 = z.strictObject({
  schema: z.literal(SEARCH_JSON_SCHEMA),
  /** The words searched, as typed. */
  query: z.string(),
  /** The local days searched, inclusive; null for no bound. */
  from: z.iso.date().nullable(),
  to: z.iso.date().nullable(),
  timeZone: z.string().min(1),
  /** Matching episodes in all, which may be more than those listed. */
  total: z.int().min(0),
  episodes: z.array(
    z.strictObject({
      id: z.int().positive(),
      startedAt: Instant,
      endedAt: Instant.nullable(),
      context: EpisodeContext.nullable(),
      size: EpisodeSize.nullable(),
      /** Matching segments in the episode; `hits` lists the best of them. 0 when only its context matched. */
      hitCount: z.int().min(0),
      hits: z.array(
        z.strictObject({
          start: Instant,
          end: Instant,
          /** As on screen: « Moi », « Voix 2 », or the name the user gave. */
          speaker: z.string().nullable(),
          text: z.string(),
        }),
      ),
      /** The context the user added that matched: a note, a link's title and address, a file's name. */
      contextHits: z.array(z.strictObject({ kind: ContextKind, text: z.string() })),
    }),
  ),
});
export type SearchJsonV2 = z.output<typeof SearchJsonV2>;

/** The JSON Schemas published in `docs/schemas`, by file name. */
export function exportJsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    "transcript-2.schema.json": {
      $id: "https://sondine.app/schemas/transcript-2.schema.json",
      title: "Sondine transcript, version 2",
      ...z.toJSONSchema(TranscriptJsonV2),
    },
    "day-2.schema.json": {
      $id: "https://sondine.app/schemas/day-2.schema.json",
      title: "Sondine day of transcripts, version 2",
      ...z.toJSONSchema(DayJsonV2),
    },
    "search-2.schema.json": {
      $id: "https://sondine.app/schemas/search-2.schema.json",
      title: "Sondine search results, version 2",
      ...z.toJSONSchema(SearchJsonV2),
    },
  };
}
