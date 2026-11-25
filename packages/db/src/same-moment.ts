import { transaction, type Database } from "./database";
import { JOURNAL_CONTEXTS, journalEpisodeSql } from "./journal-input";
import { phoneHeldSql, phoneRecordingSql } from "./phone-recordings";
import { int, intOrNull, num, oneOfValues, str } from "./rows";
import { sameMomentSources, type SameMomentSource } from "./schema/enums";
import type { SameMomentMeasureJson } from "./schema/same-moment";
import { otherIdSql, sourceHoleSql, sourceIdSql } from "./same-moment-sql";

// A meeting the Mac and the phone both heard (ADR 032, M5.7). The wall
// clocks propose pairs; the detector (packages/engines) compares their
// sound in core; each comparison is a row of `same_moment_links`, linked or
// not, for the two generations it read. Over the time both heard, one
// feeds the journal: the clearer one, or the one the user chose.

/** How far beyond its own times a phone recording's Mac partner is looked for. */
export const SAME_MOMENT_SEARCH_MS = 2 * 60_000;
/**
 * The same for a phone recording whose clock was not plausible: placed at
 * its arrival, it is right only when it was sent soon after (ADR 032).
 */
export const SAME_MOMENT_UNCERTAIN_SEARCH_MS = 15 * 60_000;
/** The least wall-clock overlap (with the search) worth comparing. */
export const SAME_MOMENT_MIN_OVERLAP_MS = 60_000;

/** One side of a pair to compare. */
export interface SameMomentSide {
  readonly episodeId: number;
  readonly generation: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export interface SameMomentPair {
  readonly phone: SameMomentSide;
  readonly mac: SameMomentSide;
  /** How far from the wall clocks the true offset may be, ms. */
  readonly searchMs: number;
}

const searchSql = (alias: string) => `(CASE WHEN EXISTS (
    SELECT 1 FROM episode_regions ser JOIN speech_regions sr ON sr.id = ser.speech_region_id
    JOIN phone_recordings sp ON sp.track_run_id = sr.track_run_id
    WHERE ser.episode_id = ${alias}.id AND sp.time_uncertain = 1)
  THEN ${SAME_MOMENT_UNCERTAIN_SEARCH_MS} ELSE ${SAME_MOMENT_SEARCH_MS} END)`;

/**
 * Pairs the clocks propose, over `episodes p` (a phone recording) and
 * `episodes m` (the Mac's): both closed, the Mac's a conversation of the
 * user's day heard by its microphone, overlapping by a minute once the
 * phone's times are widened by the search. Comparing them also needs their
 * audio; a link stays once retention took it (the text stays). A function:
 * `journal-input.ts` imports this module.
 */
const candidateSql = (): string => `p.state = 'closed' AND p.ended_at_ms IS NOT NULL
  AND ${phoneRecordingSql("p")}
  AND m.state = 'closed' AND m.ended_at_ms IS NOT NULL
  AND m.context IN (${JOURNAL_CONTEXTS.map((c) => `'${c}'`).join(", ")})
  AND NOT ${phoneHeldSql("m")}
  AND EXISTS (SELECT 1 FROM episode_regions mer JOIN speech_regions mr ON mr.id = mer.speech_region_id
    JOIN track_runs mt ON mt.id = mr.track_run_id
    WHERE mer.episode_id = m.id AND mt.source_kind = 'input')
  AND min(m.ended_at_ms, p.ended_at_ms + ${searchSql("p")})
    - max(m.started_at_ms, p.started_at_ms - ${searchSql("p")}) >= ${SAME_MOMENT_MIN_OVERLAP_MS}`;

/** A pair at its generations: `[phoneEpisodeId, phoneGeneration, macEpisodeId, macGeneration]`. */
export type SameMomentPairKey = readonly [number, number, number, number];

export const sameMomentPairKey = (pair: SameMomentPair): SameMomentPairKey => [
  pair.phone.episodeId,
  pair.phone.generation,
  pair.mac.episodeId,
  pair.mac.generation,
];

/**
 * The next pair to compare with `method`: never compared, or since changed,
 * and not among `skip` (a comparison that failed, waiting to be tried
 * again). Newest first.
 */
export function nextSameMomentPair(
  db: Database,
  method: string,
  skip: readonly SameMomentPairKey[] = [],
): SameMomentPair | null {
  const row = db
    .statement(
      `SELECT p.id AS phone_id, p.input_generation AS phone_generation,
         p.started_at_ms AS phone_start, p.ended_at_ms AS phone_end,
         m.id AS mac_id, m.input_generation AS mac_generation,
         m.started_at_ms AS mac_start, m.ended_at_ms AS mac_end, ${searchSql("p")} AS search_ms
       FROM episodes p JOIN episodes m
         ON m.started_at_ms < p.ended_at_ms + ${SAME_MOMENT_UNCERTAIN_SEARCH_MS}
         AND m.ended_at_ms > p.started_at_ms - ${SAME_MOMENT_UNCERTAIN_SEARCH_MS}
       WHERE ${candidateSql()} AND p.audio_gone_at_ms IS NULL AND m.audio_gone_at_ms IS NULL
         AND NOT EXISTS (SELECT 1 FROM same_moment_links l
           WHERE l.phone_episode_id = p.id AND l.mac_episode_id = m.id
             AND l.phone_generation = p.input_generation AND l.mac_generation = m.input_generation
             AND l.method = ?)
         AND NOT EXISTS (SELECT 1 FROM json_each(?) k
           WHERE k.value ->> '$[0]' = p.id AND k.value ->> '$[1]' = p.input_generation
             AND k.value ->> '$[2]' = m.id AND k.value ->> '$[3]' = m.input_generation)
       ORDER BY p.started_at_ms DESC, m.started_at_ms DESC LIMIT 1`,
    )
    .get(method, JSON.stringify(skip));
  if (row === undefined) return null;
  return {
    phone: {
      episodeId: int(row, "phone_id"),
      generation: int(row, "phone_generation"),
      startedAtMs: int(row, "phone_start"),
      endedAtMs: int(row, "phone_end"),
    },
    mac: {
      episodeId: int(row, "mac_id"),
      generation: int(row, "mac_generation"),
      startedAtMs: int(row, "mac_start"),
      endedAtMs: int(row, "mac_end"),
    },
    searchMs: int(row, "search_ms"),
  };
}

/**
 * Deletes the comparisons of pairs the clocks no longer propose (a split
 * moved one away, a type changed, its audio went): a link holds only while
 * its pair is one. Returns how many went.
 */
export function pruneSameMoments(db: Database): number {
  return Number(
    db
      .statement(
        `DELETE FROM same_moment_links WHERE NOT EXISTS (
           SELECT 1 FROM episodes p JOIN episodes m ON m.id = same_moment_links.mac_episode_id
           WHERE p.id = same_moment_links.phone_episode_id AND ${candidateSql()})`,
      )
      .run().changes,
  );
}

/** What the detector said of a pair, as stored. */
export type SameMomentResult =
  | {
      readonly linked: true;
      readonly offsetMs: number;
      readonly driftPpm: number;
      readonly anchorMs: number;
      readonly score: number;
      readonly sharedFromMs: number;
      readonly sharedToMs: number;
      /** Speech above each one's noise floor over the shared time: the clearer feeds the journal. */
      readonly clarity: { readonly phone: number; readonly mac: number };
      readonly measure: SameMomentMeasureJson;
    }
  | { readonly linked: false; readonly measure: SameMomentMeasureJson };

/**
 * Stores a comparison, in one transaction, only while both episodes are
 * still at the generations compared (else nothing, and false). A pair
 * linked before keeps the source the user chose.
 */
export function recordSameMoment(
  db: Database,
  input: {
    readonly pair: SameMomentPair;
    readonly method: string;
    readonly result: SameMomentResult;
    readonly nowMs: number;
  },
): boolean {
  const { pair, method, result, nowMs } = input;
  return transaction(db, () => {
    const current = db
      .statement(
        `SELECT
           (SELECT input_generation FROM episodes WHERE id = ?) AS phone_generation,
           (SELECT input_generation FROM episodes WHERE id = ?) AS mac_generation`,
      )
      .get(pair.phone.episodeId, pair.mac.episodeId);
    if (
      current === undefined ||
      intOrNull(current, "phone_generation") !== pair.phone.generation ||
      intOrNull(current, "mac_generation") !== pair.mac.generation
    ) {
      return false;
    }
    const previous = db
      .statement(
        `SELECT journal_source, source_chosen FROM same_moment_links
         WHERE phone_episode_id = ? AND mac_episode_id = ?`,
      )
      .get(pair.phone.episodeId, pair.mac.episodeId);
    const chosen =
      previous !== undefined && int(previous, "source_chosen") === 1 && previous["journal_source"]
        ? oneOfValues(previous, "journal_source", sameMomentSources)
        : null;
    const source: SameMomentSource | null = !result.linked
      ? null
      : (chosen ?? (result.clarity.mac >= result.clarity.phone ? "mac" : "phone"));
    db.statement(
      `INSERT INTO same_moment_links (phone_episode_id, mac_episode_id, phone_generation,
         mac_generation, method, linked, offset_ms, drift_ppm, anchor_ms, score, shared_from_ms,
         shared_to_ms, journal_source, source_chosen, measure, checked_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (phone_episode_id, mac_episode_id) DO UPDATE SET
         phone_generation = excluded.phone_generation, mac_generation = excluded.mac_generation,
         method = excluded.method, linked = excluded.linked, offset_ms = excluded.offset_ms,
         drift_ppm = excluded.drift_ppm, anchor_ms = excluded.anchor_ms, score = excluded.score,
         shared_from_ms = excluded.shared_from_ms, shared_to_ms = excluded.shared_to_ms,
         journal_source = excluded.journal_source, source_chosen = excluded.source_chosen,
         measure = excluded.measure, checked_at_ms = excluded.checked_at_ms`,
    ).run(
      pair.phone.episodeId,
      pair.mac.episodeId,
      pair.phone.generation,
      pair.mac.generation,
      method,
      result.linked ? 1 : 0,
      result.linked ? result.offsetMs : null,
      result.linked ? result.driftPpm : null,
      result.linked ? result.anchorMs : null,
      result.linked ? result.score : null,
      result.linked ? result.sharedFromMs : null,
      result.linked ? result.sharedToMs : null,
      source,
      result.linked && chosen !== null ? 1 : 0,
      JSON.stringify(result.measure),
      nowMs,
    );
    return true;
  });
}

/** Another recording of the same meeting, as one episode sees it. */
export interface SameMoment {
  readonly otherEpisodeId: number;
  /** Who recorded the other one. */
  readonly by: SameMomentSource;
  /** The other's wall time − this one's, ms, at `anchorMs`. */
  readonly offsetMs: number;
  /** How that offset moves per second of this one's clock, in millionths. */
  readonly driftPpm: number;
  /** On this one's clock. */
  readonly anchorMs: number;
  /** The time both heard, on this one's clock. */
  readonly sharedFromMs: number;
  readonly sharedToMs: number;
  /** This one feeds the journal over the shared time. */
  readonly feedsJournal: boolean;
  readonly sourceChosen: boolean;
}

/** The recordings linked to this episode (ADR 032), earliest shared time first. */
export function sameMomentsOf(db: Database, episodeId: number): SameMoment[] {
  return db
    .statement(
      `SELECT l.phone_episode_id, l.mac_episode_id, l.offset_ms, l.drift_ppm, l.anchor_ms,
         l.shared_from_ms, l.shared_to_ms, l.journal_source, l.source_chosen,
         EXISTS (SELECT 1 FROM episodes e WHERE e.id = ${sourceIdSql("l")}
           AND ${journalEpisodeSql}) AS source_journaled
       FROM same_moment_links l WHERE l.linked = 1 AND (l.phone_episode_id = ? OR l.mac_episode_id = ?)
       ORDER BY l.shared_from_ms, l.phone_episode_id, l.mac_episode_id`,
    )
    .all(episodeId, episodeId)
    .map((row): SameMoment => {
      const isPhone = int(row, "phone_episode_id") === episodeId;
      const offsetMs = int(row, "offset_ms");
      const driftPpm = num(row, "drift_ppm");
      const source = oneOfValues(row, "journal_source", sameMomentSources);
      // Stored on the phone's clock (offset, anchor) and the Mac's (shared time).
      const toThis = isPhone ? -offsetMs : 0;
      return {
        otherEpisodeId: int(row, isPhone ? "mac_episode_id" : "phone_episode_id"),
        by: isPhone ? "mac" : "phone",
        offsetMs: isPhone ? offsetMs : -offsetMs,
        driftPpm: isPhone ? driftPpm : -driftPpm,
        anchorMs: int(row, "anchor_ms") + (isPhone ? 0 : offsetMs),
        sharedFromMs: int(row, "shared_from_ms") + toThis,
        sharedToMs: int(row, "shared_to_ms") + toThis,
        // The other is the source but the journal does not read it (its type changed):
        // this one feeds it after all.
        feedsJournal: source === (isPhone ? "phone" : "mac") || int(row, "source_journaled") === 0,
        sourceChosen: int(row, "source_chosen") === 1,
      };
    });
}

/**
 * Wall-clock spans of this episode, on its own clock, where another
 * recording of the same meeting feeds the journal: its lines there are not
 * written. Only while the journal reads that source (its type, size and
 * transcript), and only where the source still holds its audio: a passage
 * deleted from it leaves this one's lines there to the journal.
 */
export function journalExcludedSpans(
  db: Database,
  episodeId: number,
): { readonly fromMs: number; readonly toMs: number }[] {
  const links = db
    .statement(
      `SELECT l.phone_episode_id, l.mac_episode_id, l.offset_ms, l.shared_from_ms, l.shared_to_ms,
         l.journal_source,
         (SELECT json_group_array(json_array(t.wall_start_ms, t.wall_end_ms))
          FROM deleted_ranges t WHERE ${sourceHoleSql("l", "t")}) AS holes
       FROM same_moment_links l JOIN episodes e ON e.id = ${sourceIdSql("l")}
       WHERE l.linked = 1 AND ${otherIdSql("l")} = ? AND ${journalEpisodeSql}`,
    )
    .all(episodeId);
  return links.flatMap((row) => {
    const offsetMs = int(row, "offset_ms");
    const sourceIsPhone = str(row, "journal_source") === "phone";
    // The shared time and the holes on the source's clock, then on this one's.
    const toSource = sourceIsPhone ? -offsetMs : 0;
    const toThis = sourceIsPhone ? offsetMs : -offsetMs;
    const holes = holesOf(str(row, "holes"));
    let spans = [
      {
        fromMs: int(row, "shared_from_ms") + toSource,
        toMs: int(row, "shared_to_ms") + toSource,
      },
    ];
    for (const [from, to] of holes) {
      spans = spans.flatMap((span) =>
        to <= span.fromMs || from >= span.toMs
          ? [span]
          : [
              { fromMs: span.fromMs, toMs: Math.max(span.fromMs, from) },
              { fromMs: Math.min(span.toMs, to), toMs: span.toMs },
            ].filter((part) => part.toMs > part.fromMs),
      );
    }
    return spans.map((span) => ({ fromMs: span.fromMs + toThis, toMs: span.toMs + toThis }));
  });
}

function holesOf(json: string): [number, number][] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((pair): [number, number][] =>
    Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number"
      ? [[pair[0], pair[1]]]
      : [],
  );
}

/**
 * The user's choice: `episodeId` feeds the journal over the time it shares
 * with `otherEpisodeId`. False when they are not linked.
 */
export function setSameMomentSource(
  db: Database,
  input: { readonly episodeId: number; readonly otherEpisodeId: number },
): boolean {
  return transaction(db, () => {
    const row = db
      .statement(
        `SELECT phone_episode_id FROM same_moment_links WHERE linked = 1
           AND ((phone_episode_id = :a AND mac_episode_id = :b)
             OR (phone_episode_id = :b AND mac_episode_id = :a))`,
      )
      .get({ a: input.episodeId, b: input.otherEpisodeId });
    if (row === undefined) return false;
    const source: SameMomentSource =
      int(row, "phone_episode_id") === input.episodeId ? "phone" : "mac";
    db.statement(
      `UPDATE same_moment_links SET journal_source = ?, source_chosen = 1
       WHERE phone_episode_id = ? AND mac_episode_id = ?`,
    ).run(
      source,
      source === "phone" ? input.episodeId : input.otherEpisodeId,
      source === "phone" ? input.otherEpisodeId : input.episodeId,
    );
    return true;
  });
}

/** `alsoRecordedBy` of `episodes e` in SQL: 'mac', 'phone' or null. */
export const alsoRecordedBySql = `(SELECT CASE WHEN l.phone_episode_id = e.id THEN 'mac' ELSE 'phone' END
  FROM same_moment_links l WHERE l.linked = 1 AND (l.phone_episode_id = e.id OR l.mac_episode_id = e.id)
  LIMIT 1)`;
