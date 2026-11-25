import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { analysisRuns } from "./analysis";
import { episodes } from "./episodes";

/**
 * People the user named (architecture §6, §8). A name reaches a voice only
 * through `speaker_is` assertions anchored to capture facts; this row holds
 * the name. `is_self` marks the user, at most one row.
 */
export const people = sqliteTable(
  "people",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    isSelf: integer("is_self", { mode: "boolean" }).notNull().default(false),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("people_self_unique")
      .on(t.isSelf)
      .where(sql`${t.isSelf} = 1`),
    check("people_name_check", sql`length(trim(${t.name})) between 1 and 80`),
  ],
);

/**
 * A voice's embedding in one transcript (architecture §8): biometric data,
 * derived from the voice's exclusive speech and kept only with its run and
 * episode (both cascade). A person's voice is the embeddings of the voices
 * named as them; nothing else is stored about it.
 */
export const speakerEmbeddings = sqliteTable(
  "speaker_embeddings",
  {
    id: integer("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** `wespeaker-v2:<model sha256>:<pipeline version>`: vectors of two versions are never compared. */
    embedderVersion: text("embedder_version").notNull(),
    /** 256 float32, little-endian, unit length. */
    vector: blob("vector", { mode: "buffer" }).notNull(),
    speechMs: integer("speech_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("speaker_embeddings_unique").on(t.runId, t.label, t.embedderVersion),
    index("speaker_embeddings_episode_idx").on(t.episodeId),
    check("speaker_embeddings_vector_check", sql`length(${t.vector}) = 1024`),
  ],
);

/**
 * The user's voice read (ADR 034): the embedding of a short text they read
 * aloud on purpose, in the first run or later from Settings ▸ Voix, one at a
 * time. It is one of their references (ADR 030), heard on a microphone. Only
 * the embedding is kept: the recording is deleted once embedded. It goes with
 * its person (cascade), with « Oublier ma voix lue », and when « Reconnaître
 * les voix » is turned off.
 */
export const voiceReads = sqliteTable(
  "voice_reads",
  {
    id: integer("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** As in `speaker_embeddings`: vectors of two versions are never compared. */
    embedderVersion: text("embedder_version").notNull(),
    /** 256 float32, little-endian, unit length. */
    vector: blob("vector", { mode: "buffer" }).notNull(),
    speechMs: integer("speech_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("voice_reads_person_idx").on(t.personId),
    check("voice_reads_vector_check", sql`length(${t.vector}) = 1024`),
  ],
);

/** A run whose voices were embedded with one embedder version (some may have had too little speech). */
export const voicePasses = sqliteTable(
  "voice_passes",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    embedderVersion: text("embedder_version").notNull(),
    finishedAtMs: integer("finished_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.embedderVersion] })],
);

/**
 * Transcripts whose voices were linked (architecture §8): voices of one
 * person, numbered apart by the engine, merged into one. Once per run;
 * `merged` counts the voices merged into another.
 */
export const voiceLinks = sqliteTable("voice_links", {
  runId: integer("run_id")
    .primaryKey()
    .references(() => analysisRuns.id, { onDelete: "cascade" }),
  merged: integer("merged").notNull(),
  finishedAtMs: integer("finished_at_ms").notNull(),
});
