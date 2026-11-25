import type { Database } from "./database";
import { int, intOrNull, oneOfValues, type Row } from "./rows";
import { deletedRangeScopes, type DeletedRangeScope } from "./schema/enums";

/**
 * A capture span to test against tombstones. Both ranges are half-open; a
 * point is `[t, t + 1)`. `trackRunId` null means only `all` tombstones apply.
 * An imported recording's run (`phone`) takes no `all` tombstone: those
 * forget what the Mac heard at a time, not a file the user brought in.
 */
export interface CaptureSpan {
  readonly trackRunId: number | null;
  readonly sampleStart: number | null;
  readonly sampleEnd: number | null;
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

export interface DeletedRange {
  readonly id: number;
  readonly scope: DeletedRangeScope;
  readonly trackRunId: number | null;
  readonly sampleStart: number | null;
  readonly sampleEnd: number | null;
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

const intersecting = `
  SELECT id, scope, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms
  FROM deleted_ranges
  WHERE (scope = 'all' AND wall_start_ms < :wallEnd AND wall_end_ms > :wallStart
         AND NOT EXISTS (SELECT 1 FROM track_runs t WHERE t.id = :run AND t.source_kind = 'phone'))
     OR (scope = 'track_run' AND track_run_id = :trackRunId
         AND sample_start < :sampleEnd AND sample_end > :sampleStart)
  ORDER BY wall_start_ms, id`;

export function findDeletedRanges(db: Database, span: CaptureSpan): DeletedRange[] {
  const hasSamples =
    span.trackRunId !== null && span.sampleStart !== null && span.sampleEnd !== null;
  return db
    .statement(intersecting)
    .all({
      wallStart: span.wallStartMs,
      wallEnd: Math.max(span.wallEndMs, span.wallStartMs + 1),
      run: span.trackRunId,
      trackRunId: hasSamples ? span.trackRunId : null,
      sampleStart: hasSamples ? span.sampleStart : null,
      sampleEnd:
        hasSamples && span.sampleStart !== null && span.sampleEnd !== null
          ? Math.max(span.sampleEnd, span.sampleStart + 1)
          : null,
    })
    .map(toDeletedRange);
}

export function intersectsDeletedRange(db: Database, span: CaptureSpan): boolean {
  return findDeletedRanges(db, span).length > 0;
}

export function hasDeletedRanges(db: Database): boolean {
  return db.statement("SELECT 1 AS present FROM deleted_ranges LIMIT 1").get() !== undefined;
}

function toDeletedRange(row: Row): DeletedRange {
  return {
    id: int(row, "id"),
    scope: oneOfValues(row, "scope", deletedRangeScopes),
    trackRunId: intOrNull(row, "track_run_id"),
    sampleStart: intOrNull(row, "sample_start"),
    sampleEnd: intOrNull(row, "sample_end"),
    wallStartMs: int(row, "wall_start_ms"),
    wallEndMs: int(row, "wall_end_ms"),
  };
}

/** Wall-clock duration of `samples` at `sampleRate`, rounded up to whole ms. */
export const samplesToMs = (samples: number, sampleRate: number): number =>
  Math.ceil((samples * 1000) / sampleRate);

/** Samples covering `ms` at `sampleRate`, rounded down. */
export const msToSamples = (ms: number, sampleRate: number): number =>
  Math.floor((ms * sampleRate) / 1000);
