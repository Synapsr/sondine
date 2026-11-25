import { transaction, type Database } from "./database";
import { msToSamples } from "./deleted-ranges";
import { phoneHeldSql } from "./phone-recordings";
import { int, intOrNull } from "./rows";

// « Garder les 2 dernières minutes » (plan.md, Later 1; ADR 015, ADR 029):
// everything the Mac captured over a wall range, speech or not, becomes
// ranges of its runs the user keeps (`kept_audio`, origin `moment`). A range
// is audio, not an episode, so it holds whatever later becomes of it: audio
// still in the spool is archived instead of expiring with it (`planArchive`),
// the region still open and the episode not closed yet are kept once they
// are, and a split, a merge or a new grouping finds it where the audio is.
// What the range reaches keeps its audio past every duration, zone and the
// disk cap, as « Garder l'audio » does, until « Ne plus garder ».

/** The gesture keeps this much before it. */
export const KEEP_RECENT_MS = 2 * 60_000;

/** A chunk's wall time may sit this far before the range and still reach it. */
const CHUNK_REACH_MS = 10_000;

/**
 * How far an open run's last block may end before the gesture and still be
 * followed by audio it has not committed yet (the helper's 2 s commit, then
 * the import). Further, its blocks stopped arriving (a gap, the disk full) or
 * the clock moved: nothing past the last block is counted on.
 */
const PENDING_MS = 10_000;

export interface KeepRecentOptions {
  readonly fromWallMs: number;
  readonly toWallMs: number;
  readonly nowMs: number;
}

export type KeepRecentResult =
  | {
      readonly outcome: "kept";
      /** Wall time the kept audio covers, once each (a pause or an erased part is not counted). */
      readonly keptMs: number;
      /** The recordings it reaches so far (more may form from it). */
      readonly episodeIds: readonly number[];
    }
  /** Nothing was captured then (paused, held, erased, or Sondine off): nothing is kept. */
  | { readonly outcome: "nothing" };

interface RunRow {
  readonly id: number;
  readonly open: boolean;
  readonly sampleRate: number;
  readonly startedWallMs: number;
  readonly sampleEnd: number | null;
}

interface Span {
  readonly from: number;
  readonly to: number;
}

/** The run's sample at `wallMs`, from the last block before it (or the run's start). */
function sampleAt(db: Database, run: RunRow, wallMs: number): number {
  const anchor = db
    .statement(
      `SELECT sample_start, wall_ms FROM chunks
       WHERE track_run_id = ? AND wall_ms <= ? ORDER BY sample_start DESC LIMIT 1`,
    )
    .get(run.id, wallMs);
  return anchor === undefined
    ? msToSamples(wallMs - run.startedWallMs, run.sampleRate)
    : int(anchor, "sample_start") + msToSamples(wallMs - int(anchor, "wall_ms"), run.sampleRate);
}

/**
 * The last sample the run holds or will hold: a closed run's end; for an open
 * one, its last block's end, and what it captured since when that block is
 * recent (`PENDING_MS`).
 */
function heldEnd(
  db: Database,
  run: RunRow,
  toWallMs: number,
): { readonly sample: number; readonly committed: number; readonly committedWallMs: number } {
  const last = db
    .statement(
      `SELECT sample_start + sample_count AS sample_end,
         wall_ms + sample_count * 1000.0 / ? AS wall_end
       FROM chunks WHERE track_run_id = ? ORDER BY sample_start DESC LIMIT 1`,
    )
    .get(run.sampleRate, run.id);
  const committed = last === undefined ? 0 : int(last, "sample_end");
  const committedWallMs =
    last === undefined ? run.startedWallMs : Number(last["wall_end"] ?? run.startedWallMs);
  if (!run.open) return { sample: run.sampleEnd ?? committed, committed, committedWallMs };
  const sinceMs = toWallMs - committedWallMs;
  const pendingMs = sinceMs > 0 && sinceMs <= PENDING_MS ? sinceMs : 0;
  return {
    sample: committed + msToSamples(pendingMs, run.sampleRate),
    committed,
    committedWallMs,
  };
}

/** `spans` merged, minus `holes`, as a total length. */
function coveredMs(spans: readonly Span[], holes: readonly Span[]): number {
  const merged: Span[] = [];
  for (const span of spans.toSorted((a, b) => a.from - b.from)) {
    const previous = merged.at(-1);
    if (previous !== undefined && span.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, span.to) };
    } else if (span.to > span.from) {
      merged.push(span);
    }
  }
  let total = 0;
  for (const span of merged) {
    let length = span.to - span.from;
    for (const hole of holes) {
      length -= Math.max(0, Math.min(span.to, hole.to) - Math.max(span.from, hole.from));
    }
    total += Math.max(0, length);
  }
  return Math.round(total);
}

/**
 * Keeps what the Mac captured over `[fromWallMs, toWallMs)`: for every run
 * of a microphone or the Mac's sound that overlaps it (never a phone
 * recording or an imported file, ADR 032), its samples over that time, those
 * an open run has not committed yet included, placed by the run's own block
 * times. A run's range never reaches past what it holds, so a clock set
 * forward since the run started keeps nothing rather than audio still to
 * come. `keptMs` counts only audio that exists: blocks present or archived,
 * and an open run's uncommitted tail, outside any range erased. One
 * transaction.
 */
export function keepRecentAudio(db: Database, options: KeepRecentOptions): KeepRecentResult {
  const { fromWallMs, toWallMs, nowMs } = options;
  if (!(fromWallMs < toWallMs)) {
    throw new RangeError(`Empty range [${fromWallMs}, ${toWallMs})`);
  }
  return transaction(db, () => {
    // Runs with a block then, and the open ones (their newest audio may not be committed yet).
    const runs: RunRow[] = db
      .statement(
        `SELECT t.id, t.state, t.sample_rate, t.started_wall_ms, t.sample_end
         FROM track_runs t
         WHERE t.source_kind != 'phone'
           AND t.started_wall_ms < :to AND coalesce(t.ended_wall_ms, :to) > :from
           AND (t.state = 'open' OR t.id IN (
             SELECT track_run_id FROM chunks WHERE wall_ms >= :reach AND wall_ms < :to))
         ORDER BY t.id`,
      )
      .all({ from: fromWallMs, to: toWallMs, reach: fromWallMs - CHUNK_REACH_MS })
      .map((row) => ({
        id: int(row, "id"),
        open: row["state"] === "open",
        sampleRate: int(row, "sample_rate"),
        startedWallMs: int(row, "started_wall_ms"),
        sampleEnd: intOrNull(row, "sample_end"),
      }));
    const blocks = db.statement(
      `SELECT sample_start, sample_count, wall_ms FROM chunks
       WHERE track_run_id = ? AND sample_start < ? AND sample_start + sample_count > ?
         AND audio_state IN ('present', 'archived')`,
    );
    const insert = db.statement(
      `INSERT INTO kept_audio (track_run_id, sample_start, sample_end, created_at_ms, origin)
       VALUES (?, ?, ?, ?, 'moment')`,
    );
    const heard: Span[] = [];
    const ranges: { readonly runId: number; readonly start: number; readonly end: number }[] = [];
    for (const run of runs) {
      const held = heldEnd(db, run, toWallMs);
      const end = Math.min(Math.max(0, sampleAt(db, run, toWallMs)), held.sample);
      const start = Math.max(0, sampleAt(db, run, fromWallMs));
      if (!(start < end)) continue;
      // What of it exists, in wall time from each block's own clock, inside the range.
      const msPerSample = 1000 / run.sampleRate;
      const inRange = (span: Span): Span => ({
        from: Math.max(fromWallMs, span.from),
        to: Math.min(toWallMs, span.to),
      });
      const pieces: Span[] = blocks.all(run.id, end, start).map((row) => {
        const blockStart = int(row, "sample_start");
        const wall = int(row, "wall_ms");
        return inRange({
          from: wall + (Math.max(start, blockStart) - blockStart) * msPerSample,
          to:
            wall +
            (Math.min(end, blockStart + int(row, "sample_count")) - blockStart) * msPerSample,
        });
      });
      if (run.open && end > held.committed) {
        const from = Math.max(start, held.committed);
        pieces.push(
          inRange({
            from: held.committedWallMs + (from - held.committed) * msPerSample,
            to: held.committedWallMs + (end - held.committed) * msPerSample,
          }),
        );
      }
      if (!pieces.some((piece) => piece.to > piece.from)) continue;
      ranges.push({ runId: run.id, start, end });
      heard.push(...pieces);
    }
    // An erased range keeps nothing, blocks still to come included.
    const erased = db
      .statement(
        `SELECT wall_start_ms, wall_end_ms FROM deleted_ranges
         WHERE scope = 'all' AND wall_start_ms < ? AND wall_end_ms > ?`,
      )
      .all(toWallMs + PENDING_MS, fromWallMs - CHUNK_REACH_MS)
      .map((row) => ({ from: int(row, "wall_start_ms"), to: int(row, "wall_end_ms") }));
    const keptMs = coveredMs(heard, erased);
    if (keptMs === 0) return { outcome: "nothing" } as const;
    for (const range of ranges) insert.run(range.runId, range.start, range.end, nowMs);
    // The recordings it reaches show it at once (their summaries changed).
    const episodeIds = db
      .statement(
        `UPDATE episodes SET updated_at_ms = :now
         WHERE id IN (SELECT e.id FROM episodes e
           WHERE e.started_at_ms < :to AND coalesce(e.ended_at_ms, :to) > :from
             AND NOT ${phoneHeldSql("e")})
         RETURNING id`,
      )
      .all({ now: nowMs, from: fromWallMs, to: toWallMs })
      .map((row) => int(row, "id"))
      .toSorted((a, b) => a - b);
    return { outcome: "kept", keptMs, episodeIds } as const;
  });
}
