import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { trackRuns } from "./capture";
import { oneOf } from "./check";
import { assertionOrigins, contextKinds, contextPreviews } from "./enums";

/**
 * What the user added to a conversation (ADR 024): a note, a link, an image
 * or a file. Anchored like an assertion to a point of captured audio, never
 * to an episode id: the item belongs to the episode whose member slice holds
 * `(track_run_id, anchor_sample)`, so regrouping, splits, merges and
 * reanalyses move no item. A pinned item also keeps its sentence's span.
 */
export const contextItems = sqliteTable(
  "context_items",
  {
    id: integer("id").primaryKey(),
    kind: text("kind", { enum: contextKinds }).notNull(),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    /** Inside one of the episode's member slices when it was added. */
    anchorSample: integer("anchor_sample").notNull(),
    /** The sentence it is pinned to, on that track; both null for the whole conversation. */
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    /** A note's text, or a link's address; empty for a file. */
    body: text("body").notNull().default(""),
    /** A link's title the user typed, or a file's name; null when none. */
    title: text("title"),
    /** A file's bytes, by their SHA-256 (hex): `<data>/context/<sha256>`. */
    fileSha256: text("file_sha256"),
    fileBytes: integer("file_bytes"),
    mediaType: text("media_type"),
    /** An image's preview format (`<data>/context/previews/<sha256>.<ext>`); null when none. */
    preview: text("preview", { enum: contextPreviews }),
    /**
     * An audio file's transcription: the imported recording « Transcrire »
     * made of it (ADR 021). Deleted with the item's conversation; « Retirer »
     * leaves it in « Importés ».
     */
    transcriptRunId: integer("transcript_run_id").references(() => trackRuns.id),
    /** The fr-norm form of what search reads (`context_fts`). */
    searchText: text("search_text").notNull().default(""),
    origin: text("origin", { enum: assertionOrigins }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("context_items_anchor_idx").on(t.trackRunId, t.anchorSample),
    index("context_items_span_idx")
      .on(t.trackRunId, t.spanStart)
      .where(sql`${t.spanStart} is not null`),
    index("context_items_file_idx")
      .on(t.fileSha256)
      .where(sql`${t.fileSha256} is not null`),
    index("context_items_transcript_idx")
      .on(t.transcriptRunId)
      .where(sql`${t.transcriptRunId} is not null`),
    check("context_items_kind_check", oneOf(t.kind, contextKinds)),
    check("context_items_origin_check", oneOf(t.origin, assertionOrigins)),
    check("context_items_preview_check", oneOf(t.preview, contextPreviews)),
    check("context_items_anchor_check", sql`${t.anchorSample} >= 0`),
    check(
      "context_items_span_check",
      sql`(${t.spanStart} is null and ${t.spanEnd} is null) or (${t.spanStart} is not null and ${t.spanEnd} > ${t.spanStart})`,
    ),
    check(
      "context_items_file_check",
      sql`(${t.kind} in ('image', 'file')) = (${t.fileSha256} is not null and ${t.fileBytes} is not null and ${t.mediaType} is not null)`,
    ),
    check("context_items_preview_kind_check", sql`${t.preview} is null or ${t.kind} = 'image'`),
  ],
);
