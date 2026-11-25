import type { Database } from "./database";
import { int, intOrNull, num, oneOfValues, str } from "./rows";
import { selfEchoVerdicts, type SelfEchoVerdict as StoredVerdict } from "./schema/enums";

// What a mic region heard while Sondine played on the speakers (ADR 035):
// judged once against the private `self:playback` reference, which never
// reaches the database; only the verdict and its numbers do. The grouping
// leaves out what is echo, keeps what someone said, and the transcription
// drops the echo stretches inside a region it keeps.

export type SelfEchoKind = "echo" | "near-end" | "no-reference";

const toStored: Record<SelfEchoKind, StoredVerdict> = {
  echo: "echo",
  "near-end": "near_end",
  "no-reference": "no_reference",
};
const fromStored: Record<StoredVerdict, SelfEchoKind> = {
  echo: "echo",
  near_end: "near-end",
  no_reference: "no-reference",
};

export interface SelfEchoJudgement {
  readonly regionId: number;
  /** The detector's id (`envelope-echo/1`). */
  readonly method: string;
  readonly kind: SelfEchoKind;
  readonly voicedMs: number;
  readonly coveredMs: number;
  readonly echoMs: number;
  readonly nearEndMs: number;
  readonly lagMs: number | null;
  readonly correlation: number;
  /** Echo stretches of a `near-end` region, in run samples, half-open. */
  readonly spans: readonly (readonly [number, number])[];
  readonly judgedAtMs: number;
}

export function recordSelfEcho(db: Database, judgement: SelfEchoJudgement): void {
  db.statement(
    `INSERT INTO self_echoes (speech_region_id, method, verdict, voiced_ms, covered_ms, echo_ms,
       near_end_ms, lag_ms, correlation, spans, judged_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (speech_region_id) DO UPDATE SET
       method = excluded.method, verdict = excluded.verdict, voiced_ms = excluded.voiced_ms,
       covered_ms = excluded.covered_ms, echo_ms = excluded.echo_ms,
       near_end_ms = excluded.near_end_ms, lag_ms = excluded.lag_ms,
       correlation = excluded.correlation, spans = excluded.spans,
       judged_at_ms = excluded.judged_at_ms`,
  ).run(
    judgement.regionId,
    judgement.method,
    toStored[judgement.kind],
    Math.round(judgement.voicedMs),
    Math.round(judgement.coveredMs),
    Math.round(judgement.echoMs),
    Math.round(judgement.nearEndMs),
    judgement.lagMs === null ? null : Math.round(judgement.lagMs),
    judgement.correlation,
    JSON.stringify(judgement.spans.map(([start, end]) => [Math.round(start), Math.round(end)])),
    judgement.judgedAtMs,
  );
}

/** The verdicts of `regionIds` that have one. */
export function loadSelfEchoes(
  db: Database,
  regionIds: readonly number[],
): Map<number, SelfEchoKind> {
  const out = new Map<number, SelfEchoKind>();
  if (regionIds.length === 0) return out;
  const statement = db.statement(
    `SELECT speech_region_id, verdict FROM self_echoes
     WHERE speech_region_id IN (SELECT value FROM json_each(?))`,
  );
  for (let at = 0; at < regionIds.length; at += 500) {
    for (const row of statement.all(JSON.stringify(regionIds.slice(at, at + 500)))) {
      out.set(
        int(row, "speech_region_id"),
        fromStored[oneOfValues(row, "verdict", selfEchoVerdicts)],
      );
    }
  }
  return out;
}

/** A closed mic region heard during a playback on the speakers, with no verdict yet. */
export interface RegionToJudge {
  readonly id: number;
  readonly trackRunId: number;
  readonly sampleRate: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly wallEndMs: number;
  readonly continuousStartUs: number;
  readonly continuousEndUs: number;
  /** The end of the playback its midpoint falls in (a lease while it plays), wall ms. */
  readonly playbackEndedWallMs: number;
}

/**
 * Closed microphone regions that ended at or after `sinceWallMs` whose wall
 * midpoint falls in a playback on the speakers (`playedBack`'s rule) and that
 * have no verdict, oldest first. Regions without continuous times cannot be
 * placed against the reference and are left to ADR 020's rule.
 */
export function regionsToJudge(db: Database, sinceWallMs: number): RegionToJudge[] {
  return db
    .statement(
      `SELECT r.id, r.track_run_id, t.sample_rate, r.sample_start, r.sample_end, r.wall_end_ms,
         r.continuous_start_us, r.continuous_end_us, max(p.ended_wall_ms) AS playback_end
       FROM speech_regions r
       JOIN track_runs t ON t.id = r.track_run_id
       JOIN self_playbacks p ON p.route = 'speakers'
         AND p.started_wall_ms <= (r.wall_start_ms + r.wall_end_ms) / 2.0
         AND (r.wall_start_ms + r.wall_end_ms) / 2.0 <= p.ended_wall_ms
       LEFT JOIN self_echoes e ON e.speech_region_id = r.id
       WHERE r.state = 'closed' AND r.wall_end_ms >= ? AND t.source_kind = 'input'
         AND e.speech_region_id IS NULL
         AND r.continuous_start_us IS NOT NULL AND r.continuous_end_us IS NOT NULL
       GROUP BY r.id
       ORDER BY r.wall_start_ms, r.id`,
    )
    .all(sinceWallMs)
    .map((row) => ({
      id: int(row, "id"),
      trackRunId: int(row, "track_run_id"),
      sampleRate: int(row, "sample_rate"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: int(row, "sample_end"),
      wallEndMs: int(row, "wall_end_ms"),
      continuousStartUs: int(row, "continuous_start_us"),
      continuousEndUs: int(row, "continuous_end_us"),
      playbackEndedWallMs: int(row, "playback_end"),
    }));
}

/** An echo stretch inside a mic region someone spoke in, in run samples, half-open. */
export interface SelfEchoStretch {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

/** The echo stretches of the `near-end` regions of `trackRunIds`. */
export function selfEchoStretches(db: Database, trackRunIds: readonly number[]): SelfEchoStretch[] {
  if (trackRunIds.length === 0) return [];
  return db
    .statement(
      `SELECT r.track_run_id, json_extract(s.value, '$[0]') AS start, json_extract(s.value, '$[1]') AS end
       FROM self_echoes e
       JOIN speech_regions r ON r.id = e.speech_region_id
       JOIN json_each(e.spans) s
       WHERE e.verdict = 'near_end' AND r.track_run_id IN (SELECT value FROM json_each(?))
       ORDER BY r.track_run_id, start`,
    )
    .all(JSON.stringify(trackRunIds))
    .map((row) => ({
      trackRunId: int(row, "track_run_id"),
      sampleStart: int(row, "start"),
      sampleEnd: int(row, "end"),
    }));
}

/** One verdict's numbers, for the bench and the logs. */
export function selfEchoOf(db: Database, regionId: number): SelfEchoJudgement | null {
  const row = db
    .statement(
      `SELECT speech_region_id, method, verdict, voiced_ms, covered_ms, echo_ms, near_end_ms,
         lag_ms, correlation, spans, judged_at_ms
       FROM self_echoes WHERE speech_region_id = ?`,
    )
    .get(regionId);
  if (row === undefined) return null;
  const spans: unknown = JSON.parse(str(row, "spans"));
  return {
    regionId: int(row, "speech_region_id"),
    method: str(row, "method"),
    kind: fromStored[oneOfValues(row, "verdict", selfEchoVerdicts)],
    voicedMs: int(row, "voiced_ms"),
    coveredMs: int(row, "covered_ms"),
    echoMs: int(row, "echo_ms"),
    nearEndMs: int(row, "near_end_ms"),
    lagMs: intOrNull(row, "lag_ms"),
    correlation: num(row, "correlation"),
    spans: Array.isArray(spans)
      ? spans.flatMap((span): [number, number][] =>
          Array.isArray(span) && typeof span[0] === "number" && typeof span[1] === "number"
            ? [[span[0], span[1]]]
            : [],
        )
      : [],
    judgedAtMs: int(row, "judged_at_ms"),
  };
}
