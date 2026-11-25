import { transaction, type Database } from "./database";
import { upsertApp, ImportConflictError, type ImportStatus } from "./capture-import";
import { endingSql } from "./episode-ends";
import { int, intOrNull, oneOfValues, str, strOrNull, type Row } from "./rows";
import {
  callEndReasons,
  callVias,
  listenVias,
  type CallEndReason,
  type CallVia,
  type ListenVia,
} from "./schema/enums";

// Calls and listens as the helper reports them (`call` and `listen` events,
// ADR 016 "Episodes"). Each id is one span of one app: a call, or another app
// listening to a microphone (a dictation app, a browser page). The grouping
// joins the spans of one call app that overlap or restart within the rejoin
// window; listen spans are never joined. Every function is idempotent:
// replaying events after a reconnect or a restart changes nothing.
//
// The helper replays every active span in each snapshot. So at a snapshot's
// end the open spans are exactly the ones it replayed: any other open span
// (its `ended` was lost, or its helper is gone) closes at its last-seen
// clock, as `lost`. A later `ended` for it still sets the exact end, and a
// later replay of it reopens it. Last-seen moves only for spans a clock
// really vouches for (`touchSpans`): a clock of the helper is no proof that
// a span stored before the connection is still on.

/** The tables of spans the helper replays: calls, and the other apps listening. */
export type SpanTable = "calls" | "listens";

/** A point on both helper clocks, as stored (ms and µs). */
export interface SpanClock {
  readonly wallMs: number;
  readonly continuousUs: number;
}

interface SpanActiveInput {
  readonly uid: string;
  readonly sessionId: string;
  readonly bundleId: string;
  readonly at: SpanClock;
  readonly nowMs: number;
}

export interface CallActiveInput extends SpanActiveInput {
  readonly via: CallVia;
  readonly inputDeviceUid: string | null;
}

export interface ListenActiveInput extends SpanActiveInput {
  readonly via: ListenVia;
}

/**
 * Records an active call, or confirms it (a replay). A replay of a call
 * closed as `lost` reopens it; one the helper ended stays ended.
 */
export function recordCallActive(
  db: Database,
  input: CallActiveInput,
): { readonly spanId: number; readonly status: ImportStatus } {
  return recordActive(db, "calls", input, {
    via: input.via,
    input_device_uid: input.inputDeviceUid,
  });
}

/** Records an app listening, or confirms it (a replay), as `recordCallActive` does a call. */
export function recordListenActive(
  db: Database,
  input: ListenActiveInput,
): { readonly spanId: number; readonly status: ImportStatus } {
  return recordActive(db, "listens", input, { via: input.via });
}

function recordActive(
  db: Database,
  table: SpanTable,
  input: SpanActiveInput,
  columns: Readonly<Record<string, string | null>>,
): { readonly spanId: number; readonly status: ImportStatus } {
  return transaction(db, () => {
    const existing = db
      .statement(`SELECT id, bundle_id, end_reason FROM ${table} WHERE uid = ?`)
      .get(input.uid);
    if (existing !== undefined) {
      const spanId = int(existing, "id");
      if (str(existing, "bundle_id") !== input.bundleId) {
        throw new ImportConflictError(
          `${table} ${spanId}: bundle_id differs from the recorded value`,
        );
      }
      if (strOrNull(existing, "end_reason") !== "lost") return { spanId, status: "duplicate" };
      db.statement(
        `UPDATE ${table} SET ended_wall_ms = NULL, ended_continuous_us = NULL, end_reason = NULL,
           updated_at_ms = ?
         WHERE id = ?`,
      ).run(input.nowMs, spanId);
      return { spanId, status: "updated" };
    }
    const { appId } = upsertApp(db, { bundleId: input.bundleId, seenAtMs: input.at.wallMs });
    const extra = Object.keys(columns);
    const inserted = db
      .statement(
        `INSERT INTO ${table} (uid, session_id, bundle_id, app_id, ${extra.join(", ")},
           started_wall_ms, started_continuous_us, last_seen_wall_ms, last_seen_continuous_us,
           updated_at_ms)
         VALUES (?, ?, ?, ?, ${extra.map(() => "?").join(", ")}, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.uid,
        input.sessionId,
        input.bundleId,
        appId,
        ...Object.values(columns),
        input.at.wallMs,
        input.at.continuousUs,
        input.at.wallMs,
        input.at.continuousUs,
        input.nowMs,
      );
    return { spanId: Number(inserted.lastInsertRowid), status: "inserted" };
  });
}

/**
 * Ends a span at the helper's `ended`. An `ended` for a span never seen
 * active is dropped (`unknown`): with no start there is no span to group by,
 * and the only way to get one is a helper backlog that overflowed.
 */
export function recordSpanEnded(
  db: Database,
  table: SpanTable,
  input: { readonly uid: string; readonly at: SpanClock; readonly nowMs: number },
): { readonly spanId: number | null; readonly status: ImportStatus } {
  return transaction(db, () => {
    const row = db
      .statement(
        `SELECT id, started_wall_ms, started_continuous_us, end_reason FROM ${table} WHERE uid = ?`,
      )
      .get(input.uid);
    if (row === undefined) return { spanId: null, status: "unknown" };
    const spanId = int(row, "id");
    if (strOrNull(row, "end_reason") === "ended") return { spanId, status: "duplicate" };
    // Clocks never put the end before the start, even across an adjustment.
    const end =
      input.at.continuousUs < int(row, "started_continuous_us")
        ? { wallMs: int(row, "started_wall_ms"), continuousUs: int(row, "started_continuous_us") }
        : input.at;
    db.statement(
      `UPDATE ${table} SET ended_wall_ms = ?, ended_continuous_us = ?, end_reason = 'ended',
         last_seen_wall_ms = max(last_seen_wall_ms, ?),
         last_seen_continuous_us = max(last_seen_continuous_us, ?), updated_at_ms = ?
       WHERE id = ?`,
    ).run(end.wallMs, end.continuousUs, end.wallMs, end.continuousUs, input.nowMs, spanId);
    return { spanId, status: "updated" };
  });
}

/**
 * These spans are still active at `at`: their last-seen moves there, never
 * back, and only while they are open. Returns the spans touched.
 */
export function touchSpans(
  db: Database,
  table: SpanTable,
  input: { readonly uids: Iterable<string>; readonly at: SpanClock },
): number {
  const uids = [...input.uids];
  if (uids.length === 0) return 0;
  const result = db
    .statement(
      `UPDATE ${table} SET last_seen_wall_ms = ?, last_seen_continuous_us = ?
       WHERE uid IN (SELECT value FROM json_each(?)) AND end_reason IS NULL
         AND last_seen_continuous_us < ?`,
    )
    .run(input.at.wallMs, input.at.continuousUs, JSON.stringify(uids), input.at.continuousUs);
  return Number(result.changes);
}

/**
 * At a snapshot's end: the spans it replayed were active at its clock (`at`,
 * null when it sent none), and every other open span closes at its last-seen
 * clock, as `lost`: the snapshot's clock says nothing of them. Returns the
 * spans closed.
 */
export function closeLostSpans(
  db: Database,
  table: SpanTable,
  input: {
    readonly replayed: ReadonlySet<string>;
    readonly at: SpanClock | null;
    readonly nowMs: number;
  },
): number {
  return transaction(db, () => {
    if (input.at !== null) touchSpans(db, table, { uids: input.replayed, at: input.at });
    const open = db.statement(`SELECT id, uid FROM ${table} WHERE end_reason IS NULL`).all();
    const close = db.statement(
      `UPDATE ${table} SET ended_wall_ms = last_seen_wall_ms,
         ended_continuous_us = last_seen_continuous_us, end_reason = 'lost', updated_at_ms = ?
       WHERE id = ?`,
    );
    let closed = 0;
    for (const row of open) {
      if (input.replayed.has(str(row, "uid"))) continue;
      close.run(input.nowMs, int(row, "id"));
      closed += 1;
    }
    return closed;
  });
}

interface StoredSpan {
  readonly id: number;
  readonly uid: string;
  readonly bundleId: string;
  readonly appId: number | null;
  readonly started: SpanClock;
  /** Null while the span is active. */
  readonly ended: SpanClock | null;
  readonly endReason: CallEndReason | null;
}

export interface StoredCall extends StoredSpan {
  readonly via: CallVia;
}

export interface StoredListen extends StoredSpan {
  readonly via: ListenVia;
}

/** Calls whose span meets `[fromWallMs, toWallMs]`; an active call reaches "now". */
export function loadCallsBetween(db: Database, fromWallMs: number, toWallMs: number): StoredCall[] {
  return loadSpansBetween(db, "calls", fromWallMs, toWallMs).map((row) => ({
    ...toStoredSpan(row),
    via: oneOfValues(row, "via", callVias),
  }));
}

/** Listen spans that meet `[fromWallMs, toWallMs]`; an active one reaches "now". */
export function loadListensBetween(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
): StoredListen[] {
  return loadSpansBetween(db, "listens", fromWallMs, toWallMs).map((row) => ({
    ...toStoredSpan(row),
    via: oneOfValues(row, "via", listenVias),
  }));
}

function loadSpansBetween(
  db: Database,
  table: SpanTable,
  fromWallMs: number,
  toWallMs: number,
): Row[] {
  return db
    .statement(
      `SELECT id, uid, bundle_id, app_id, via, started_wall_ms, started_continuous_us,
         ended_wall_ms, ended_continuous_us, end_reason
       FROM ${table}
       WHERE started_wall_ms <= ? AND (ended_wall_ms IS NULL OR ended_wall_ms >= ?)
       ORDER BY started_wall_ms, id`,
    )
    .all(toWallMs, fromWallMs);
}

function toStoredSpan(row: Row): StoredSpan {
  const endedWallMs = intOrNull(row, "ended_wall_ms");
  const endedContinuousUs = intOrNull(row, "ended_continuous_us");
  return {
    id: int(row, "id"),
    uid: str(row, "uid"),
    bundleId: str(row, "bundle_id"),
    appId: intOrNull(row, "app_id"),
    started: {
      wallMs: int(row, "started_wall_ms"),
      continuousUs: int(row, "started_continuous_us"),
    },
    ended:
      endedWallMs === null || endedContinuousUs === null
        ? null
        : { wallMs: endedWallMs, continuousUs: endedContinuousUs },
    endReason: row["end_reason"] === null ? null : oneOfValues(row, "end_reason", callEndReasons),
  };
}

/** An app track run: while it is open, that app's audio is on its own track, not `system:other`. */
export interface StoredAppTap {
  readonly bundleId: string;
  /** The run's first timing anchor. */
  readonly start: SpanClock;
  /** Continuous time of the run's last sample; null while it is open. */
  readonly endContinuousUs: number | null;
}

/** App track runs whose span meets `[fromWallMs, toWallMs]`. */
export function loadAppTapsBetween(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
): StoredAppTap[] {
  return db
    .statement(
      `SELECT a.bundle_id, t.sample_rate, t.sample_end, e.anchor_continuous_us, e.anchor_wall_ms
       FROM track_runs t
       JOIN apps a ON a.id = t.app_id
       JOIN epochs e ON e.track_run_id = t.id
         AND e.seq = (SELECT min(seq) FROM epochs WHERE track_run_id = t.id)
       WHERE t.source_kind = 'app' AND t.started_wall_ms <= ?
         AND (t.ended_wall_ms IS NULL OR t.ended_wall_ms >= ?)
       ORDER BY t.started_wall_ms, t.id`,
    )
    .all(toWallMs, fromWallMs)
    .map((row) => {
      const continuousUs = int(row, "anchor_continuous_us");
      const sampleEnd = intOrNull(row, "sample_end");
      return {
        bundleId: str(row, "bundle_id"),
        start: { wallMs: int(row, "anchor_wall_ms"), continuousUs },
        endContinuousUs:
          sampleEnd === null
            ? null
            : continuousUs + Math.round((sampleEnd * 1_000_000) / int(row, "sample_rate")),
      };
    });
}

/** Open episodes start at most this long ago: past 3 h one is cut (architecture §7). */
const OPEN_EPISODE_REACH_MS = 6 * 3_600_000;

/** A call going on now, and the open episode holding its speech (ADR 025). */
export interface OngoingCall {
  readonly callId: number;
  readonly bundleId: string;
  readonly appId: number | null;
  /** When the span began: speech before it belongs to something else. */
  readonly startedWallMs: number;
  /** Null until speech joined it. */
  readonly episodeId: number | null;
}

/**
 * The call going on now: the newest active call span, with the newest open
 * `call` episode that has speech since that span started (a call episode
 * stays open minutes after its call; another call's, or one the user ended,
 * stays out). Speech
 * counts from where it is known: a closed region by its end, an open one by
 * its start, never an open region left from before. Cheap enough for every
 * commit: the active spans are a handful of rows, the episodes an index range.
 */
export function ongoingCall(db: Database, nowMs: number): OngoingCall | null {
  const call = db
    .statement(
      `SELECT id, bundle_id, app_id, started_wall_ms FROM calls WHERE end_reason IS NULL
       ORDER BY started_wall_ms DESC, id DESC LIMIT 1`,
    )
    .get();
  if (call === undefined) return null;
  const episode = db
    .statement(
      `SELECT e.id FROM episodes e
       WHERE e.started_at_ms >= ? AND e.state = 'open' AND e.context = 'call'
         AND NOT ${endingSql("e")}
         AND EXISTS (SELECT 1 FROM episode_regions er
                     JOIN speech_regions r ON r.id = er.speech_region_id
                     WHERE er.episode_id = e.id AND coalesce(r.wall_end_ms, r.wall_start_ms) >= ?)
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 1`,
    )
    .get(nowMs - OPEN_EPISODE_REACH_MS, int(call, "started_wall_ms"));
  return {
    callId: int(call, "id"),
    bundleId: str(call, "bundle_id"),
    appId: intOrNull(call, "app_id"),
    startedWallMs: int(call, "started_wall_ms"),
    episodeId: episode === undefined ? null : int(episode, "id"),
  };
}

/** What Sondine recorded of a call of an app (ADR 036). */
export interface CallRecording {
  readonly episodeId: number;
  /** From the call's start, or the episode's when later, to its last speech. */
  readonly durationMs: number;
  /** Neither closed nor ended by the user. */
  readonly open: boolean;
}

/**
 * The latest episode of this app's call since `sinceMs`: a `call` episode of
 * that app (or of none yet: only the user spoke) with speech heard since
 * then, known as in `ongoingCall`.
 */
export function callRecording(
  db: Database,
  input: { readonly bundleId: string; readonly sinceMs: number },
): CallRecording | null {
  const row = db
    .statement(
      `SELECT e.id, e.started_at_ms, e.state = 'open' AND NOT ${endingSql("e")} AS open,
         (SELECT max(coalesce(r.wall_end_ms, r.wall_start_ms)) FROM episode_regions er
          JOIN speech_regions r ON r.id = er.speech_region_id
          WHERE er.episode_id = e.id) AS last_ms
       FROM episodes e LEFT JOIN apps a ON a.id = e.primary_app_id
       WHERE e.started_at_ms >= ? AND e.context = 'call'
         AND (a.bundle_id = ? OR a.bundle_id IS NULL)
         AND EXISTS (SELECT 1 FROM episode_regions er
                     JOIN speech_regions r ON r.id = er.speech_region_id
                     WHERE er.episode_id = e.id AND coalesce(r.wall_end_ms, r.wall_start_ms) >= ?)
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 1`,
    )
    .get(input.sinceMs - OPEN_EPISODE_REACH_MS, input.bundleId, input.sinceMs);
  if (row === undefined) return null;
  return {
    episodeId: int(row, "id"),
    durationMs: Math.max(
      0,
      int(row, "last_ms") - Math.max(int(row, "started_at_ms"), input.sinceMs),
    ),
    open: int(row, "open") === 1,
  };
}

/** A region slice of a call episode that holds the far side. */
export interface FarRegion {
  readonly trackRunId: number;
  readonly sampleRate: number;
  readonly sampleStart: number;
  /** Null while the region is open. */
  readonly sampleEnd: number | null;
  readonly sliceStart: number;
  readonly sliceEnd: number | null;
  readonly wallStartMs: number;
}

/**
 * The far side of a call in its episode: the call app's own tap, or
 * `system:other` where its attribution names the call app. Unattributed or
 * other apps' sound, and microphones, are left out: nothing else is surely
 * the people on the call. Only speech of the current span (`sinceWallMs`):
 * a closed region ending after it, an open one starting after it.
 */
export function farSideRegions(
  db: Database,
  input: { readonly episodeId: number; readonly bundleId: string; readonly sinceWallMs: number },
): FarRegion[] {
  return db
    .statement(
      `SELECT r.track_run_id, t.sample_rate, r.sample_start, r.sample_end, er.slice_sample_start,
         er.slice_sample_end, r.wall_start_ms
       FROM episode_regions er
       JOIN speech_regions r ON r.id = er.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       LEFT JOIN apps a ON a.id = t.app_id
       LEFT JOIN apps aa ON aa.id = r.attributed_app_id
       WHERE er.episode_id = ?
         AND ((t.source_kind = 'app' AND a.bundle_id = ?)
           OR (t.source_kind = 'system' AND aa.bundle_id = ?))
         AND coalesce(r.wall_end_ms, r.wall_start_ms) >= ?
       ORDER BY r.wall_start_ms, r.id`,
    )
    .all(input.episodeId, input.bundleId, input.bundleId, input.sinceWallMs)
    .map((row) => ({
      trackRunId: int(row, "track_run_id"),
      sampleRate: int(row, "sample_rate"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: intOrNull(row, "sample_end"),
      sliceStart: int(row, "slice_sample_start"),
      sliceEnd: intOrNull(row, "slice_sample_end"),
      wallStartMs: int(row, "wall_start_ms"),
    }));
}
