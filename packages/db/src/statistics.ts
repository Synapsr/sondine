import type { Database } from "./database";
import { resolveSpeakers } from "./people";
import { episodeContexts, type EpisodeContext } from "./schema/enums";

// Statistics (ADR 037): figures computed on demand from what the database
// already holds, shown on this Mac only. Nothing is recorded to feed them,
// and a figure without its history is left out. Days are local days, given
// by the caller as [start, end) milliseconds so the time zone stays core's.

export interface StatisticsDay {
  /** YYYY-MM-DD, local. */
  readonly day: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface Statistics {
  /** Per day, oldest first: voiced time of conversations and moments, and conversations started. */
  readonly days: {
    readonly day: string;
    readonly voicedMs: number;
    readonly conversations: number;
  }[];
  /** Voiced time by context over the window, largest first. */
  readonly contexts: { readonly context: EpisodeContext; readonly voicedMs: number }[];
  /** Talk time of named people in conversations over the window, not the user, largest first. */
  readonly people: {
    readonly personId: number;
    readonly name: string;
    readonly talkMs: number;
  }[];
  /** Words in the current transcripts. */
  readonly words: number;
  /** Tool calls by outside agents since `agentsSinceMs`. */
  readonly agentReads: number;
}

const TOP_PEOPLE = 5;

export interface DayTotal {
  readonly day: string;
  /** Voiced time of the conversations and moments that started that day. */
  readonly voicedMs: number;
  readonly conversations: number;
}

/** Per day, in the order given: voiced time of conversations and moments, and conversations started. */
export function loadDayTotals(db: Database, days: readonly StatisticsDay[]): DayTotal[] {
  const perDay = db.statement(
    `SELECT COALESCE(SUM(voiced_ms), 0) AS voiced,
            COALESCE(SUM(size = 'conversation'), 0) AS conversations
     FROM episodes
     WHERE started_at_ms >= ? AND started_at_ms < ? AND size IN ('conversation', 'moment')`,
  );
  return days.map(({ day, startMs, endMs }) => {
    const row = perDay.get(startMs, endMs);
    return {
      day,
      voicedMs: Number(row?.["voiced"] ?? 0),
      conversations: Number(row?.["conversations"] ?? 0),
    };
  });
}

export function loadStatistics(
  db: Database,
  input: {
    /** The days charted, oldest first. */
    readonly days: readonly StatisticsDay[];
    /** The window of the other figures. */
    readonly sinceMs: number;
    readonly untilMs: number;
    /** Where agent reads start counting (the charted week); `sinceMs` when absent. */
    readonly agentsSinceMs?: number;
  },
): Statistics {
  const days = loadDayTotals(db, input.days);

  const contexts = db
    .statement(
      `SELECT context, SUM(voiced_ms) AS voiced FROM episodes
       WHERE started_at_ms >= ? AND started_at_ms < ? AND context IS NOT NULL
         AND size IN ('conversation', 'moment')
       GROUP BY context HAVING voiced > 0 ORDER BY voiced DESC`,
    )
    .all(input.sinceMs, input.untilMs)
    .flatMap((row) => {
      const context = episodeContexts.find((known) => known === row["context"]);
      return context === undefined ? [] : [{ context, voicedMs: Number(row["voiced"]) }];
    });

  // Talk time per person: each conversation's current transcript, its turns
  // by speaker, the speakers' names as the user confirmed them (media left out).
  const talk = new Map<number, { name: string; talkMs: number }>();
  const runs = db
    .statement(
      `SELECT ea.run_id FROM episodes e
       JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
       WHERE e.started_at_ms >= ? AND e.started_at_ms < ? AND e.size = 'conversation'
         AND (e.context IS NULL OR e.context <> 'media')`,
    )
    .all(input.sinceMs, input.untilMs);
  const turns = db.statement(
    `SELECT speaker_label, SUM(end_ms - start_ms) AS ms FROM speaker_turns
     WHERE run_id = ? GROUP BY speaker_label`,
  );
  for (const row of runs) {
    const runId = Number(row["run_id"]);
    const speakers = resolveSpeakers(db, runId);
    for (const turn of turns.all(runId)) {
      const person = speakers.get(String(turn["speaker_label"]));
      if (person === undefined || person.isSelf) continue;
      const entry = talk.get(person.id) ?? { name: person.name, talkMs: 0 };
      entry.talkMs += Number(turn["ms"]);
      talk.set(person.id, entry);
    }
  }
  const people = [...talk.entries()]
    .map(([personId, entry]) => ({ personId, ...entry }))
    .toSorted((a, b) => b.talkMs - a.talkMs)
    .slice(0, TOP_PEOPLE);

  // Words: spaces plus one, per non-empty sentence of the published transcripts.
  const words = Number(
    db
      .statement(
        `SELECT COALESCE(SUM(LENGTH(TRIM(s.text)) - LENGTH(REPLACE(TRIM(s.text), ' ', '')) + 1), 0)
           AS words
         FROM segments s JOIN episode_analysis ea ON ea.run_id = s.run_id AND ea.stage = 'asr'
         WHERE TRIM(s.text) <> ''`,
      )
      .get()?.["words"] ?? 0,
  );

  const agentReads = Number(
    db
      .statement("SELECT COUNT(*) AS n FROM agent_calls WHERE at_ms >= ? AND at_ms < ?")
      .get(input.agentsSinceMs ?? input.sinceMs, input.untilMs)?.["n"] ?? 0,
  );

  return { days, contexts, people, words, agentReads };
}
