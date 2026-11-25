import { createHash } from "node:crypto";
import type { JournalInput, JournalLine, JournalSpeaker } from "@sondine/core";
import type { Database } from "./database";
import { loadEpisodeApps, loadRunSpeakers, loadSelfSpeakers } from "./episode-sources";
import { int, intOrNull, oneOfValues, str, strOrNull } from "./rows";
import { journalExcludedSpans } from "./same-moment";
import { episodeContexts } from "./schema/enums";

// What the daily journal reads of one conversation (ADR 028): its current
// transcript, with its voices and the user among them. Media, dictations,
// imports and traces are not the user's day, moments under 10 s of voice
// hold nothing to write, and open episodes are still arriving. Over the time
// another recording of the same meeting feeds the journal (ADR 032), its
// lines are left out, so the journal has no line twice.

/** Contexts the journal writes about. */
export const JOURNAL_CONTEXTS = ["call", "in_person", "mixed"] as const;
/** Sizes it writes about: a trace is under 1.5 s of voice. */
export const JOURNAL_SIZES = ["moment", "conversation"] as const;
/**
 * Voice a moment needs to be written about. Shorter ones gave the model
 * nothing to write on Téo's days (10 of 11 empty answers on 2026-11-09)
 * and took about a tenth of a day's time.
 */
export const JOURNAL_MOMENT_MIN_VOICED_MS = 10_000;

export interface JournalSource {
  readonly input: JournalInput;
  /** The `asr` run read; current while the episode's pointer names it. */
  readonly asrRunId: number;
  readonly inputGeneration: number;
  /** SHA-256 over everything the model reads; a journal is current only for this hash. */
  readonly inputHash: string;
}

/** SQL for an episode the journal writes about, alias `e`. */
export const journalEpisodeSql = `e.state = 'closed'
  AND e.context IN (${JOURNAL_CONTEXTS.map((c) => `'${c}'`).join(", ")})
  AND e.size IN (${JOURNAL_SIZES.map((s) => `'${s}'`).join(", ")})
  AND (e.size = 'conversation' OR e.voiced_ms >= ${JOURNAL_MOMENT_MIN_VOICED_MS})
  AND EXISTS (SELECT 1 FROM episode_analysis ea WHERE ea.episode_id = e.id AND ea.stage = 'asr')`;

export function loadJournalSource(
  db: Database,
  episodeId: number,
  timeZone: string,
  nowMs: number,
): JournalSource | null {
  const row = db
    .statement(
      `SELECT e.id, e.context, e.started_at_ms, e.ended_at_ms, e.input_generation, ea.run_id
       FROM episodes e JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
       WHERE e.id = ? AND ${journalEpisodeSql}`,
    )
    .get(episodeId);
  if (row === undefined) return null;
  const context = oneOfValues(row, "context", episodeContexts);
  if (context !== "call" && context !== "in_person" && context !== "mixed") return null;
  const runId = int(row, "run_id");
  const heardLines: JournalLine[] = db
    .statement(
      `SELECT id, start_ms, speaker_label, text FROM segments
       WHERE run_id = ? AND episode_id = ? ORDER BY start_ms, seq, id`,
    )
    .all(runId, episodeId)
    .map((segment) => ({
      segmentId: int(segment, "id"),
      startMs: int(segment, "start_ms"),
      speakerLabel: strOrNull(segment, "speaker_label"),
      text: str(segment, "text"),
    }))
    .filter((line) => line.text.trim() !== "");
  const excluded = journalExcludedSpans(db, episodeId);
  const lines =
    excluded.length === 0
      ? heardLines
      : heardLines.filter(
          (line) =>
            !excluded.some((span) => line.startMs >= span.fromMs && line.startMs < span.toMs),
        );
  const self = loadSelfSpeakers(db, [episodeId]).get(episodeId)?.label ?? null;
  const heard = new Set(lines.map((line) => line.speakerLabel));
  const speakers: JournalSpeaker[] = loadRunSpeakers(db, runId)
    .filter((speaker) => heard.has(speaker.label))
    .map((speaker) => ({ label: speaker.label, self: speaker.label === self }));
  const app =
    context === "call"
      ? (loadEpisodeApps(
          db,
          [
            {
              id: episodeId,
              context,
              startedAtMs: int(row, "started_at_ms"),
              endedAtMs: intOrNull(row, "ended_at_ms"),
            },
          ],
          nowMs,
        ).get(episodeId)?.[0]?.name ?? null)
      : null;
  const startedAtMs = int(row, "started_at_ms");
  const input: JournalInput = {
    episodeId,
    startedAtMs,
    context,
    app,
    speakers,
    lines,
    timeZone,
  };
  return {
    input,
    asrRunId: runId,
    inputGeneration: int(row, "input_generation"),
    inputHash: journalInputHash(input, runId),
  };
}

/** What the model reads, hashed: the run, voices, lines and their words, the date and zone. */
export function journalInputHash(input: JournalInput, runId: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runId,
        startedAtMs: input.startedAtMs,
        timeZone: input.timeZone,
        context: input.context,
        app: input.app,
        speakers: input.speakers,
        lines: input.lines.map((line) => [
          line.segmentId,
          line.startMs,
          line.speakerLabel,
          line.text,
        ]),
      }),
    )
    .digest("hex");
}

/** Episodes the journal writes about that started within `[fromMs, toMs)`, oldest first. */
export function journalEpisodesBetween(db: Database, fromMs: number, toMs: number): number[] {
  return db
    .statement(
      `SELECT e.id FROM episodes e
       WHERE e.started_at_ms >= ? AND e.started_at_ms < ? AND ${journalEpisodeSql}
       ORDER BY e.started_at_ms, e.id`,
    )
    .all(fromMs, toMs)
    .map((row) => int(row, "id"));
}
