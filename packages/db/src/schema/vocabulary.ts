import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { analysisRuns, segments } from "./analysis";
import { oneOf } from "./check";
import { episodes } from "./episodes";

/**
 * The user's Vocabulary (ADR 046): words Sondine writes their way, each with
 * an optional short note the journal's model reads (« le nom de mon app »).
 * `key` is the word without case or accents, so « Téo » and « teo » are one.
 * Settings ▸ Vocabulaire also lists the People's names, read from `people`.
 */
export const vocabularyWords = sqliteTable(
  "vocabulary_words",
  {
    id: integer("id").primaryKey(),
    word: text("word").notNull(),
    key: text("key").notNull().unique(),
    note: text("note"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    check("vocabulary_words_word_check", sql`length(${t.word}) between 1 and 60`),
    check("vocabulary_words_key_check", sql`length(${t.key}) between 1 and 60`),
    check("vocabulary_words_note_check", sql`${t.note} is null or length(${t.note}) <= 200`),
  ],
);

export const vocabularyVerdicts = ["user_word", "as_written"] as const;

/**
 * What the journal's model answered for a word that looks like one of the
 * user's (« Sandrine » for « Sondine »): asked once per word of a sentence
 * and name. Goes with the sentence.
 */
export const vocabularyChecks = sqliteTable(
  "vocabulary_checks",
  {
    id: integer("id").primaryKey(),
    segmentId: integer("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    charStart: integer("char_start").notNull(),
    /** The user's word it was asked about. */
    name: text("name").notNull(),
    verdict: text("verdict", { enum: vocabularyVerdicts }).notNull(),
    configKey: text("config_key").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    unique("vocabulary_checks_word_unique").on(t.segmentId, t.charStart, t.name),
    check("vocabulary_checks_verdict_check", oneOf(t.verdict, vocabularyVerdicts)),
  ],
);

/**
 * One episode's transcript read for the user's names: done for its `asr`
 * run and the names it was read with (`names_key`), or failed `attempts`
 * times. Goes with the episode; a new transcript or new names read it again.
 */
export const vocabularyPasses = sqliteTable(
  "vocabulary_passes",
  {
    episodeId: integer("episode_id")
      .primaryKey()
      .references(() => episodes.id, { onDelete: "cascade" }),
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    namesKey: text("names_key").notNull(),
    status: text("status", { enum: ["done", "failed"] }).notNull(),
    attempts: integer("attempts").notNull(),
    candidates: integer("candidates").notNull(),
    corrected: integer("corrected").notNull(),
    finishedAtMs: integer("finished_at_ms").notNull(),
  },
  (t) => [
    check("vocabulary_passes_status_check", oneOf(t.status, ["done", "failed"])),
    check("vocabulary_passes_counts_check", sql`${t.attempts} >= 0 and ${t.candidates} >= 0`),
  ],
);
