import { contextHomes, settleContext } from "./context-items";
import { settleTags, tagHomes } from "./recording-tags";
import { transaction, type Database } from "./database";
import { endingSql, endOfEpisode, type StoredEnd } from "./episode-ends";
import { applyKindOverride } from "./episode-kind";
import { findDeletedRanges, hasDeletedRanges, type DeletedRange } from "./deleted-ranges";
import { loadRunSpeakers, type EpisodeApp, type RunSpeaker } from "./episode-sources";
import { appColumns, appOf, segmentAppIdSql } from "./foreground";
import {
  analysisPriorities,
  analysisPriorityClass,
  enqueueAnalysisJob,
  type EnqueueOutcome,
} from "./jobs";
import { episodesWithoutText } from "./privacy-policy";
import { bumpInputGeneration, currentRunId, retireRun } from "./publish";
import { int, intOrNull, num, oneOfValues, str, strOrNull, type Row } from "./rows";
import {
  analysisStates,
  classificationStates,
  episodeContexts,
  episodeSizes,
  episodeStates,
  trackRunStates,
  trackSourceKinds,
  sameMomentSources,
  type AnalysisState,
  type ClassificationState,
  type EpisodeContext,
  type EpisodeSize,
  type EpisodeState,
  type TrackRunState,
  type TrackSourceKind,
  type SameMomentSource,
} from "./schema/enums";
import { alsoRecordedBySql } from "./same-moment";

// Storage side of the episode builder and of the episode read models (ADR
// 016, "Episodes"). Core decides the grouping; these functions read its input
// and write its result, each pass in one transaction.

/** A capture clock reading: a chunk's first sample, on both clocks. */
export interface ChunkClock {
  readonly sampleStart: number;
  readonly continuousUs: number;
  readonly wallMs: number;
}

/** A speech region the grouping may still move: in an open episode, or in none. */
export interface StoredRegion {
  readonly id: number;
  readonly trackRunId: number;
  readonly trackKey: string;
  readonly sourceKind: TrackSourceKind;
  readonly appId: number | null;
  readonly bundleId: string | null;
  /** A `system:other` region: the app its attribution named when it opened, if one. */
  readonly attributedBundleId: string | null;
  readonly sampleRate: number;
  readonly sampleStart: number;
  /**
   * The first sample the grouping may still move: `sampleStart`, or where the
   * user's end cut it, when an episode they ended holds what comes before.
   */
  readonly from: number;
  /** Null while the region is open. */
  readonly sampleEnd: number | null;
  /** Speech the VAD heard between the bounds; null while open and for older regions. */
  readonly voicedSamples: number | null;
  readonly wallStartMs: number;
  readonly wallEndMs: number | null;
  readonly continuousStartUs: number | null;
  readonly continuousEndUs: number | null;
  /**
   * The chunk holding the region's first sample (else the nearest one), for
   * a region without continuous times (recovered from a manifest).
   */
  readonly chunkClock: ChunkClock | null;
}

export interface LoadRegionsOptions {
  /**
   * Only regions starting at or after this wall time (indexed). The caller
   * passes a horizon that includes every open episode, and scans everything
   * at startup and after a spool reconciliation, which is how late regions
   * arrive.
   */
  readonly sinceWallMs?: number;
}

/**
 * Regions no closed episode holds, minus those a deleted range covers whole.
 * A region a deleted range covers in part stays; requests never send the
 * deleted part. A region the user's end cut (ADR 044) is loaded from the cut
 * once the episode they ended closed or went: an open episode holds the rest.
 */
export function loadUngroupedRegions(
  db: Database,
  options: LoadRegionsOptions = {},
): StoredRegion[] {
  const rows = db
    .statement(
      `SELECT r.id, r.track_run_id, t.track_key, t.source_kind, t.app_id, a.bundle_id,
         aa.bundle_id AS attributed_bundle_id, t.sample_rate,
         r.sample_start, r.sample_end, r.voiced_samples, r.wall_start_ms, r.wall_end_ms,
         r.continuous_start_us, r.continuous_end_us,
         (SELECT min(er.slice_sample_start) FROM episode_regions er
            JOIN episodes e ON e.id = er.episode_id
            WHERE er.speech_region_id = r.id AND e.state = 'open') AS held_from
       FROM speech_regions r
       JOIN track_runs t ON t.id = r.track_run_id
       LEFT JOIN apps a ON a.id = t.app_id
       LEFT JOIN apps aa ON aa.id = r.attributed_app_id
       WHERE r.wall_start_ms >= ?
         AND (NOT EXISTS (SELECT 1 FROM episode_regions er JOIN episodes e ON e.id = er.episode_id
             WHERE er.speech_region_id = r.id AND e.state = 'closed')
           OR held_from IS NOT NULL)
       ORDER BY r.id`,
    )
    .all(options.sinceWallMs ?? Number.MIN_SAFE_INTEGER);
  const checkDeleted = hasDeletedRanges(db);
  const out: StoredRegion[] = [];
  for (const row of rows) {
    const region = toStoredRegion(db, row);
    // Cut, then found to have ended before its cut: nothing is left of it.
    if (region.sampleEnd !== null && region.from >= region.sampleEnd) continue;
    if (checkDeleted && coveredByDeletedRanges(db, region)) continue;
    out.push(region);
  }
  return out;
}

function toStoredRegion(db: Database, row: Row): StoredRegion {
  const continuousStartUs = intOrNull(row, "continuous_start_us");
  const trackRunId = int(row, "track_run_id");
  const sampleStart = int(row, "sample_start");
  return {
    id: int(row, "id"),
    trackRunId,
    trackKey: str(row, "track_key"),
    sourceKind: oneOfValues(row, "source_kind", trackSourceKinds),
    appId: intOrNull(row, "app_id"),
    bundleId: strOrNull(row, "bundle_id"),
    attributedBundleId: strOrNull(row, "attributed_bundle_id"),
    sampleRate: int(row, "sample_rate"),
    sampleStart,
    from: intOrNull(row, "held_from") ?? sampleStart,
    sampleEnd: intOrNull(row, "sample_end"),
    voicedSamples: intOrNull(row, "voiced_samples"),
    wallStartMs: int(row, "wall_start_ms"),
    wallEndMs: intOrNull(row, "wall_end_ms"),
    continuousStartUs,
    continuousEndUs: intOrNull(row, "continuous_end_us"),
    chunkClock: continuousStartUs === null ? chunkClockAt(db, trackRunId, sampleStart) : null,
  };
}

/** The clock of the chunk at or before `sample` in a run, else the first one after it. */
function chunkClockAt(db: Database, trackRunId: number, sample: number): ChunkClock | null {
  const row =
    db
      .statement(
        `SELECT sample_start, continuous_us, wall_ms FROM chunks
         WHERE track_run_id = ? AND sample_start <= ? AND continuous_us IS NOT NULL
         ORDER BY sample_start DESC LIMIT 1`,
      )
      .get(trackRunId, sample) ??
    db
      .statement(
        `SELECT sample_start, continuous_us, wall_ms FROM chunks
         WHERE track_run_id = ? AND sample_start > ? AND continuous_us IS NOT NULL
         ORDER BY sample_start LIMIT 1`,
      )
      .get(trackRunId, sample);
  if (row === undefined) return null;
  return {
    sampleStart: int(row, "sample_start"),
    continuousUs: int(row, "continuous_us"),
    wallMs: int(row, "wall_ms"),
  };
}

/**
 * Wall-clock ms of a run sample, from the nearest chunk clock (the helper
 * stamps each chunk's first sample), else from the run's start.
 */
export function wallMsAtSample(db: Database, trackRunId: number, sample: number): number {
  const clock = chunkClockAt(db, trackRunId, sample);
  const run = db
    .statement("SELECT sample_rate, started_wall_ms FROM track_runs WHERE id = ?")
    .get(trackRunId);
  const rate = run === undefined ? 16_000 : int(run, "sample_rate");
  if (clock !== null)
    return clock.wallMs + Math.round(((sample - clock.sampleStart) * 1000) / rate);
  return (run === undefined ? 0 : int(run, "started_wall_ms")) + Math.round((sample * 1000) / rate);
}

function coveredByDeletedRanges(db: Database, region: StoredRegion): boolean {
  const end = region.sampleEnd ?? region.sampleStart + 1;
  const ranges = findDeletedRanges(db, {
    trackRunId: region.trackRunId,
    sampleStart: region.sampleStart,
    sampleEnd: end,
    wallStartMs: region.wallStartMs,
    wallEndMs: region.wallEndMs ?? region.wallStartMs + 1,
  });
  if (ranges.length === 0) return false;
  const spans = ranges
    .map((range) => deletedSamples(range, region))
    .toSorted((a, b) => a[0] - b[0]);
  let covered = region.sampleStart;
  for (const [from, to] of spans) {
    if (from > covered) return false;
    covered = Math.max(covered, to);
    if (covered >= end) return true;
  }
  return covered >= end;
}

/** Wall-clock tombstones convert to samples with this margin, so clock rounding never sends a deleted instant. */
const WALL_MARGIN_MS = 100;

/** A tombstone in a run's samples; `all` tombstones convert through the region's wall start. */
function deletedSamples(
  range: DeletedRange,
  run: { readonly sampleStart: number; readonly wallStartMs: number; readonly sampleRate: number },
): [number, number] {
  if (range.scope === "track_run" && range.sampleStart !== null && range.sampleEnd !== null) {
    return [range.sampleStart, range.sampleEnd];
  }
  const toSample = (wallMs: number) =>
    run.sampleStart + ((wallMs - run.wallStartMs) * run.sampleRate) / 1000;
  // Round outward: a deleted instant is never sent.
  return [
    Math.floor(toSample(range.wallStartMs - WALL_MARGIN_MS)),
    Math.ceil(toSample(range.wallEndMs + WALL_MARGIN_MS)),
  ];
}

export interface EpisodeMember {
  readonly regionId: number;
  readonly sliceStart: number;
  /** Null runs to the region's end. */
  readonly sliceEnd: number | null;
}

export interface OpenEpisode {
  readonly id: number;
  readonly startedAtMs: number;
  readonly inputGeneration: number;
  readonly size: EpisodeSize | null;
  /** It has a transcript: the user's end was undone once it was transcribed (ADR 044). */
  readonly transcribed: boolean;
  readonly members: readonly EpisodeMember[];
}

/** Open episodes with their region slices. */
export function loadOpenEpisodes(db: Database): OpenEpisode[] {
  const episodes = db
    .statement(
      "SELECT id, started_at_ms, input_generation, size FROM episodes WHERE state = 'open' ORDER BY id",
    )
    .all();
  const members = db.statement(
    `SELECT speech_region_id, slice_sample_start, slice_sample_end FROM episode_regions
     WHERE episode_id = ? ORDER BY speech_region_id, slice_sample_start`,
  );
  return episodes.map((row) => {
    const id = int(row, "id");
    return {
      id,
      startedAtMs: int(row, "started_at_ms"),
      inputGeneration: int(row, "input_generation"),
      size: nullableEnum(row, "size", episodeSizes),
      transcribed: currentRunId(db, id, "asr") !== undefined,
      members: members.all(id).map(toMember),
    };
  });
}

function toMember(row: Row): EpisodeMember {
  return {
    regionId: int(row, "speech_region_id"),
    sliceStart: int(row, "slice_sample_start"),
    sliceEnd: intOrNull(row, "slice_sample_end"),
  };
}

/** How far an open track run has been imported, on the capture clocks. */
export interface OpenRunClock {
  readonly trackRunId: number;
  readonly trackKey: string;
  readonly sampleRate: number;
  /** The run's newest chunk; null before its first commit. */
  readonly lastChunk: (ChunkClock & { readonly sampleCount: number }) | null;
  /** The run's first timing anchor, for a run without chunks. */
  readonly anchor: { readonly continuousUs: number; readonly wallMs: number } | null;
}

export function loadOpenRunClocks(db: Database): OpenRunClock[] {
  const runs = db
    .statement("SELECT id, track_key, sample_rate FROM track_runs WHERE state = 'open' ORDER BY id")
    .all();
  const lastChunk = db.statement(
    `SELECT sample_start, sample_count, continuous_us, wall_ms FROM chunks
     WHERE track_run_id = ? AND continuous_us IS NOT NULL
     ORDER BY sample_start DESC LIMIT 1`,
  );
  const anchor = db.statement(
    `SELECT anchor_continuous_us, anchor_wall_ms FROM epochs WHERE track_run_id = ? ORDER BY seq LIMIT 1`,
  );
  return runs.map((run) => {
    const id = int(run, "id");
    const chunk = lastChunk.get(id);
    const first = anchor.get(id);
    return {
      trackRunId: id,
      trackKey: str(run, "track_key"),
      sampleRate: int(run, "sample_rate"),
      lastChunk:
        chunk === undefined
          ? null
          : {
              sampleStart: int(chunk, "sample_start"),
              sampleCount: int(chunk, "sample_count"),
              continuousUs: int(chunk, "continuous_us"),
              wallMs: int(chunk, "wall_ms"),
            },
      anchor:
        first === undefined
          ? null
          : {
              continuousUs: int(first, "anchor_continuous_us"),
              wallMs: int(first, "anchor_wall_ms"),
            },
    };
  });
}

/** The source of one region of a closed episode, to match a late region's lane. */
export interface MemberSource {
  readonly trackKey: string;
  readonly sourceKind: TrackSourceKind;
  readonly bundleId: string | null;
}

/** A reading of both clocks; wall minus continuous estimates the boot. */
export interface ClockReading {
  readonly wallMs: number;
  readonly continuousUs: number;
}

export interface ClosedEpisode {
  readonly id: number;
  readonly inputGeneration: number;
  readonly context: EpisodeContext | null;
  readonly size: EpisodeSize | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly voicedMs: number;
  readonly kindInputs: Record<string, unknown>;
  readonly sources: readonly MemberSource[];
  /** Its primary app: for a dictation, the app it was said to. */
  readonly appBundleId: string | null;
  /**
   * One clock reading per track run of its regions (a run never spans a
   * boot), so a late region joins only an episode of its own boot.
   */
  readonly clocks: readonly ClockReading[];
  /** When the user ended it (ADR 044); null when it closed on its own. */
  readonly end: StoredEnd | null;
}

/** Closed episodes whose wall interval intersects `[fromMs, toMs]`, for late-region repair. */
export function loadClosedEpisodesBetween(
  db: Database,
  fromMs: number,
  toMs: number,
): ClosedEpisode[] {
  const rows = db
    .statement(
      `SELECT e.id, e.input_generation, e.context, e.size, e.started_at_ms, e.ended_at_ms,
         e.voiced_ms, e.kind_inputs, a.bundle_id AS app_bundle_id
       FROM episodes e LEFT JOIN apps a ON a.id = e.primary_app_id
       WHERE e.state = 'closed' AND e.started_at_ms <= ?
         AND coalesce(e.ended_at_ms, e.started_at_ms) >= ?
       ORDER BY e.started_at_ms, e.id`,
    )
    .all(toMs, fromMs);
  const sources = db.statement(
    `SELECT DISTINCT t.track_key, t.source_kind, a.bundle_id
     FROM episode_regions er
     JOIN speech_regions r ON r.id = er.speech_region_id
     JOIN track_runs t ON t.id = r.track_run_id
     LEFT JOIN apps a ON a.id = t.app_id
     WHERE er.episode_id = ?`,
  );
  const memberClocks = db.statement(
    `SELECT r.track_run_id, r.sample_start, r.wall_start_ms, r.continuous_start_us
     FROM episode_regions er
     JOIN speech_regions r ON r.id = er.speech_region_id
     WHERE er.episode_id = ?
     ORDER BY r.track_run_id, r.continuous_start_us IS NULL, r.sample_start`,
  );
  const clocksOf = (episodeId: number): ClockReading[] => {
    const byRun = new Map<number, ClockReading>();
    for (const member of memberClocks.all(episodeId)) {
      const trackRunId = int(member, "track_run_id");
      if (byRun.has(trackRunId)) continue;
      const continuousUs = intOrNull(member, "continuous_start_us");
      const clock =
        continuousUs !== null
          ? { wallMs: int(member, "wall_start_ms"), continuousUs }
          : chunkClockAt(db, trackRunId, int(member, "sample_start"));
      if (clock !== null) {
        byRun.set(trackRunId, { wallMs: clock.wallMs, continuousUs: clock.continuousUs });
      }
    }
    return [...byRun.values()];
  };
  return rows.map((row) => {
    const id = int(row, "id");
    const startedAtMs = int(row, "started_at_ms");
    return {
      id,
      inputGeneration: int(row, "input_generation"),
      context: nullableEnum(row, "context", episodeContexts),
      size: nullableEnum(row, "size", episodeSizes),
      startedAtMs,
      endedAtMs: intOrNull(row, "ended_at_ms") ?? startedAtMs,
      voicedMs: int(row, "voiced_ms"),
      kindInputs: parseObject(str(row, "kind_inputs")),
      sources: sources.all(id).map((source) => ({
        trackKey: str(source, "track_key"),
        sourceKind: oneOfValues(source, "source_kind", trackSourceKinds),
        bundleId: strOrNull(source, "bundle_id"),
      })),
      appBundleId: strOrNull(row, "app_bundle_id"),
      clocks: clocksOf(id),
      end: endOfEpisode(db, id),
    };
  });
}

/** What the grouping says about one episode after a pass. */
export interface EpisodeWrite {
  /** Null: a new episode. */
  readonly episodeId: number | null;
  readonly groupingKey: string;
  /** Close it now (and queue its analysis) in this pass. */
  readonly close: boolean;
  readonly context: EpisodeContext;
  readonly size: EpisodeSize;
  readonly sizeState: ClassificationState;
  readonly kindInputs: Record<string, unknown>;
  readonly startedAtMs: number;
  /** Null while a member region is open. */
  readonly endedAtMs: number | null;
  readonly voicedMs: number;
  readonly primaryAppId: number | null;
  /** The page its media came from, when its browser reported one (ADR 023). */
  readonly pageKey: string | null;
  readonly members: readonly EpisodeMember[];
}

/** Late regions joining a closed episode (ADR 016, "Repair"). */
export interface EpisodeRepair {
  readonly episodeId: number;
  readonly addMembers: readonly EpisodeMember[];
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly voicedMs: number;
  readonly size: EpisodeSize;
  readonly sizeState: ClassificationState;
  readonly kindInputs: Record<string, unknown>;
}

export interface EpisodePlan {
  readonly groupingVersion: string;
  readonly classifierVersion: string;
  readonly writes: readonly EpisodeWrite[];
  /** Open episodes left with no region. */
  readonly deletes: readonly number[];
  readonly repairs: readonly EpisodeRepair[];
}

export interface ApplyReport {
  readonly created: readonly number[];
  readonly closed: readonly number[];
  /** Existing episodes whose region set or a slice changed: their generation was bumped. */
  readonly bumped: readonly number[];
  readonly deleted: readonly number[];
  readonly repaired: readonly number[];
  /** Episodes whose analysis job was created or moved to a new generation. */
  readonly enqueued: readonly { readonly episodeId: number; readonly outcome: EnqueueOutcome }[];
  /**
   * Context items deleted because no episode holds their audio any more
   * (ADR 024): what was attached to them must not leave, and their files go.
   */
  readonly contextRemoved: number;
}

/**
 * Writes one grouping pass in one transaction: deletes emptied open
 * episodes, replaces changed region sets (bumping the generation), updates
 * the episodes, closes the ones the plan closes and queues their analysis,
 * and applies repairs to closed episodes.
 */
export function applyEpisodePlan(db: Database, plan: EpisodePlan, nowMs: number): ApplyReport {
  return transaction(db, () => {
    // Context follows its audio; an item whose region this pass takes out of
    // every episode (self-playback, for example) stays with its conversation.
    const touched = [
      ...plan.deletes,
      ...plan.writes.flatMap((write) => (write.episodeId === null ? [] : [write.episodeId])),
    ];
    const homes = contextHomes(db, touched);
    // Tags follow their audio the same way (ADR 039).
    const tagged = tagHomes(db, touched);
    const deleted: number[] = [];
    for (const id of plan.deletes) {
      // Its text goes with it, index rows first (segments restrict the delete).
      const open = db.statement("SELECT 1 FROM episodes WHERE id = ? AND state = 'open'").get(id);
      for (const stage of open === undefined ? [] : (["asr_live", "asr"] as const)) {
        const run = currentRunId(db, id, stage);
        if (run !== undefined) retireRun(db, run);
      }
      const result = db.statement("DELETE FROM episodes WHERE id = ? AND state = 'open'").run(id);
      if (Number(result.changes) > 0) deleted.push(id);
    }

    // Region sets first: a region moving between episodes leaves before it joins.
    const changed = new Set<number>();
    const stored = db.statement(
      `SELECT speech_region_id, slice_sample_start, slice_sample_end FROM episode_regions
       WHERE episode_id = ? ORDER BY speech_region_id, slice_sample_start`,
    );
    for (const write of plan.writes) {
      if (write.episodeId === null) continue;
      if (sameMembers(stored.all(write.episodeId).map(toMember), write.members)) continue;
      changed.add(write.episodeId);
      db.statement("DELETE FROM episode_regions WHERE episode_id = ?").run(write.episodeId);
    }

    const created: number[] = [];
    const closed: number[] = [];
    const bumped: number[] = [];
    const enqueued: { episodeId: number; outcome: EnqueueOutcome }[] = [];
    const insertMember = db.statement(
      `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start, slice_sample_end)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const write of plan.writes) {
      let episodeId = write.episodeId;
      if (episodeId === null) {
        const inserted = db
          .statement(
            `INSERT INTO episodes (state, started_at_ms, grouping_version, classifier_version,
               created_at_ms, updated_at_ms)
             VALUES ('open', ?, ?, ?, ?, ?)`,
          )
          .run(write.startedAtMs, plan.groupingVersion, plan.classifierVersion, nowMs, nowMs);
        episodeId = Number(inserted.lastInsertRowid);
        created.push(episodeId);
      } else if (changed.has(episodeId)) {
        bumpInputGeneration(db, episodeId, nowMs);
        bumped.push(episodeId);
      }
      if (write.episodeId === null || changed.has(episodeId)) {
        for (const member of write.members) {
          insertMember.run(
            episodeId,
            member.regionId,
            plan.groupingVersion,
            member.sliceStart,
            member.sliceEnd,
          );
        }
      }
      db.statement(
        `UPDATE episodes SET state = ?, context = ?, size = ?, size_state = ?, started_at_ms = ?,
           ended_at_ms = ?, voiced_ms = ?, primary_app_id = ?, grouping_version = ?, grouping_key = ?,
           page_key = ?, classifier_version = ?, kind_inputs = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(
        write.close ? "closed" : "open",
        write.context,
        write.size,
        write.sizeState,
        write.startedAtMs,
        write.endedAtMs,
        Math.round(write.voicedMs),
        write.primaryAppId,
        plan.groupingVersion,
        write.groupingKey,
        write.pageKey,
        plan.classifierVersion,
        JSON.stringify(write.kindInputs),
        nowMs,
        episodeId,
      );
      if (write.close) {
        closed.push(episodeId);
        const outcome = enqueueFor(db, episodeId, write, nowMs);
        if (outcome !== null) enqueued.push({ episodeId, outcome });
      }
    }

    const repaired: number[] = [];
    for (const repair of plan.repairs) {
      const episode = db
        .statement("SELECT context FROM episodes WHERE id = ? AND state = 'closed'")
        .get(repair.episodeId);
      if (episode === undefined) continue;
      for (const member of repair.addMembers) {
        insertMember.run(
          repair.episodeId,
          member.regionId,
          plan.groupingVersion,
          member.sliceStart,
          member.sliceEnd,
        );
      }
      bumpInputGeneration(db, repair.episodeId, nowMs);
      db.statement(
        `UPDATE episodes SET started_at_ms = ?, ended_at_ms = ?, voiced_ms = ?, size = ?, size_state = ?,
           kind_inputs = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(
        repair.startedAtMs,
        repair.endedAtMs,
        Math.round(repair.voicedMs),
        repair.size,
        repair.sizeState,
        JSON.stringify(repair.kindInputs),
        nowMs,
        repair.episodeId,
      );
      applyKindOverride(db, repair.episodeId, nowMs);
      repaired.push(repair.episodeId);
      const context = nullableEnum(episode, "context", episodeContexts);
      const outcome = enqueueFor(db, repair.episodeId, { context, size: repair.size }, nowMs);
      if (outcome !== null) enqueued.push({ episodeId: repair.episodeId, outcome });
    }
    // An id this pass deleted or created may be another conversation's now.
    const settled = settleContext(db, homes, nowMs, new Set([...deleted, ...created]));
    settleTags(db, tagged, new Set([...deleted, ...created]));
    return {
      created,
      closed,
      bumped,
      deleted,
      repaired,
      enqueued,
      contextRemoved: settled.deleted,
    };
  });
}

function enqueueFor(
  db: Database,
  episodeId: number,
  kind: { readonly context: EpisodeContext | null; readonly size: EpisodeSize | null },
  nowMs: number,
): EnqueueOutcome | null {
  const priorityClass = analysisPriorityClass(kind);
  if (priorityClass === null) return null;
  // A private zone keeps its text from being made: nothing runs unless the user asks (ADR 029).
  if (episodesWithoutText(db, [episodeId], nowMs).has(episodeId)) return null;
  const generation = int(
    db.statement("SELECT input_generation FROM episodes WHERE id = ?").get(episodeId) ?? {
      input_generation: 1,
    },
    "input_generation",
  );
  return enqueueAnalysisJob(db, {
    episodeId,
    inputGeneration: generation,
    priority: analysisPriorities[priorityClass],
    nowMs,
  }).outcome;
}

function sameMembers(a: readonly EpisodeMember[], b: readonly EpisodeMember[]): boolean {
  if (a.length !== b.length) return false;
  const key = (member: EpisodeMember) =>
    `${member.regionId}:${member.sliceStart}:${member.sliceEnd ?? ""}`;
  const left = a.map(key).toSorted();
  const right = b.map(key).toSorted();
  return left.every((value, index) => value === right[index]);
}

/**
 * Writes a size decision taken outside a grouping pass (after publication);
 * the user's word on the episode's kind still wins.
 */
export function updateEpisodeSize(
  db: Database,
  episodeId: number,
  decision: {
    readonly size: EpisodeSize;
    readonly sizeState: ClassificationState;
    readonly kindInputs: Record<string, unknown>;
    readonly classifierVersion: string;
  },
  nowMs: number,
): void {
  db.statement(
    `UPDATE episodes SET size = ?, size_state = ?, kind_inputs = ?, classifier_version = ?, updated_at_ms = ?
     WHERE id = ?`,
  ).run(
    decision.size,
    decision.sizeState,
    JSON.stringify(decision.kindInputs),
    decision.classifierVersion,
    nowMs,
    episodeId,
  );
  applyKindOverride(db, episodeId, nowMs);
}

export interface EpisodeSizeInput {
  readonly state: EpisodeState;
  readonly inputGeneration: number;
  readonly context: EpisodeContext | null;
  readonly size: EpisodeSize | null;
  readonly voicedMs: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

/** What the size table reads about a stored episode. */
export function loadEpisodeSizeInput(db: Database, episodeId: number): EpisodeSizeInput | null {
  const row = db
    .statement(
      `SELECT state, input_generation, context, size, voiced_ms, started_at_ms, ended_at_ms
       FROM episodes WHERE id = ?`,
    )
    .get(episodeId);
  if (row === undefined) return null;
  return {
    state: oneOfValues(row, "state", episodeStates),
    inputGeneration: int(row, "input_generation"),
    context: nullableEnum(row, "context", episodeContexts),
    size: nullableEnum(row, "size", episodeSizes),
    voicedMs: int(row, "voiced_ms"),
    startedAtMs: int(row, "started_at_ms"),
    endedAtMs: intOrNull(row, "ended_at_ms"),
  };
}

// Analysis input

/** One region slice of an episode, with what a request needs to place it. */
export interface AnalysisRegion {
  readonly regionId: number;
  readonly trackRunId: number;
  readonly trackKey: string;
  readonly sourceKind: TrackSourceKind;
  readonly sampleRate: number;
  readonly sampleStart: number;
  readonly sampleEnd: number | null;
  readonly sliceStart: number;
  readonly sliceEnd: number | null;
  readonly wallStartMs: number;
  readonly runStartedWallMs: number;
  readonly runState: TrackRunState;
  /** The run's last sample (exclusive) once it is closed. */
  readonly runSampleEnd: number | null;
}

export interface AnalysisInput {
  readonly episodeId: number;
  readonly state: EpisodeState;
  readonly context: EpisodeContext | null;
  readonly inputGeneration: number;
  readonly regions: readonly AnalysisRegion[];
  /** Tombstones intersecting any region slice (with roll), by run. */
  readonly deleted: ReadonlyMap<number, readonly [number, number][]>;
}

/** Roll the requests may add around a region, so tombstones are looked up that far. */
const lookupRollMs = 5_000;

export function loadAnalysisInput(db: Database, episodeId: number): AnalysisInput | null {
  const episode = db
    .statement("SELECT state, context, input_generation FROM episodes WHERE id = ?")
    .get(episodeId);
  if (episode === undefined) return null;
  const regions = db
    .statement(
      `SELECT r.id, r.track_run_id, t.track_key, t.source_kind, t.sample_rate, r.sample_start,
         r.sample_end, er.slice_sample_start, er.slice_sample_end, r.wall_start_ms,
         t.started_wall_ms, t.state AS run_state, t.sample_end AS run_sample_end
       FROM episode_regions er
       JOIN speech_regions r ON r.id = er.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE er.episode_id = ?
       ORDER BY t.track_key, t.started_wall_ms, er.slice_sample_start`,
    )
    .all(episodeId)
    .map((row): AnalysisRegion => ({
      regionId: int(row, "id"),
      trackRunId: int(row, "track_run_id"),
      trackKey: str(row, "track_key"),
      sourceKind: oneOfValues(row, "source_kind", trackSourceKinds),
      sampleRate: int(row, "sample_rate"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: intOrNull(row, "sample_end"),
      sliceStart: int(row, "slice_sample_start"),
      sliceEnd: intOrNull(row, "slice_sample_end"),
      wallStartMs: int(row, "wall_start_ms"),
      runStartedWallMs: int(row, "started_wall_ms"),
      runState: oneOfValues(row, "run_state", trackRunStates),
      runSampleEnd: intOrNull(row, "run_sample_end"),
    }));

  const deleted = new Map<number, [number, number][]>();
  if (hasDeletedRanges(db)) {
    for (const region of regions) {
      const roll = Math.ceil((lookupRollMs * region.sampleRate) / 1000);
      const end = region.sliceEnd ?? region.sampleEnd ?? region.sliceStart + 1;
      const span = { from: Math.max(0, region.sliceStart - roll), to: end + roll };
      const toMs = (sample: number) =>
        region.wallStartMs + Math.round(((sample - region.sampleStart) * 1000) / region.sampleRate);
      const ranges = findDeletedRanges(db, {
        trackRunId: region.trackRunId,
        sampleStart: span.from,
        sampleEnd: span.to,
        wallStartMs: toMs(span.from),
        wallEndMs: toMs(span.to),
      });
      const list = deleted.get(region.trackRunId) ?? [];
      for (const range of ranges) list.push(deletedSamples(range, region));
      deleted.set(region.trackRunId, list);
    }
  }
  return {
    episodeId,
    state: oneOfValues(episode, "state", episodeStates),
    context: nullableEnum(episode, "context", episodeContexts),
    inputGeneration: int(episode, "input_generation"),
    regions,
    deleted,
  };
}

/** Engine peak RSS measured by recent runs of an engine (`metrics.peakRssBytes`), or null. */
export function measuredPeakRss(db: Database, engineId: string, limit = 20): number | null {
  const row = db
    .statement(
      `SELECT max(json_extract(metrics, '$.peakRssBytes')) AS peak FROM (
         SELECT metrics FROM analysis_runs
         WHERE engine_id = ? AND stage = 'asr' AND json_extract(metrics, '$.peakRssBytes') IS NOT NULL
         ORDER BY id DESC LIMIT ?)`,
    )
    .get(engineId, limit);
  if (row === undefined || row["peak"] === null) return null;
  return num(row, "peak");
}

// Read models (API)

export interface EpisodeSummaryRow {
  readonly id: number;
  readonly state: EpisodeState;
  /** The user ended it (ADR 044); it closes in a few seconds, once its audio is imported. */
  readonly ending: boolean;
  readonly context: EpisodeContext | null;
  readonly size: EpisodeSize | null;
  readonly sizeState: ClassificationState;
  readonly analysisState: AnalysisState;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly voicedMs: number;
  /** Text of the first segment of the current transcript, if any. */
  readonly firstText: string | null;
  readonly speakerCount: number;
  /** Its text is near-live: a live run and no final transcript yet. */
  readonly live: boolean;
  /** The page its media came from (ADR 023). */
  readonly pageKey: string | null;
  /** Recorded by the iPhone app (ADR 032), with the name typed on the phone (M5.3); null otherwise. */
  readonly phone: { readonly timeUncertain: boolean; readonly name: string | null } | null;
  /** The same meeting recorded by the other device too (ADR 032); null otherwise. */
  readonly alsoRecordedBy: SameMomentSource | null;
  /** « Garder les 2 dernières minutes » reached its speech: when, the first time; null otherwise. */
  readonly keptAtMs: number | null;
}

/** The columns `toSummary` reads, over `episodes e`. */
export const summaryColumns = `e.id, e.state, ${endingSql("e")} AS ending, e.context, e.size, e.size_state, e.analysis_state,
  e.started_at_ms, e.ended_at_ms, e.voiced_ms, e.page_key,
  (SELECT s.text FROM segments s WHERE s.episode_id = e.id ORDER BY s.start_ms, s.seq LIMIT 1) AS first_text,
  (SELECT count(*) FROM episode_speakers sp JOIN episode_analysis ea ON ea.run_id = sp.run_id
     WHERE ea.episode_id = e.id AND ea.stage = 'asr') AS speaker_count,
  (EXISTS (SELECT 1 FROM episode_analysis ea WHERE ea.episode_id = e.id AND ea.stage = 'asr_live')
   AND NOT EXISTS (SELECT 1 FROM episode_analysis ea
     WHERE ea.episode_id = e.id AND ea.stage = 'asr')) AS live,
  (SELECT json_array(p.time_uncertain, p.name) FROM episode_regions per
     JOIN speech_regions pr ON pr.id = per.speech_region_id
     JOIN phone_recordings p ON p.track_run_id = pr.track_run_id
     WHERE per.episode_id = e.id LIMIT 1) AS phone_recording,
  ${alsoRecordedBySql} AS also_recorded_by,
  (SELECT min(k.created_at_ms) FROM episode_regions ker
     JOIN speech_regions kr ON kr.id = ker.speech_region_id
     JOIN kept_audio k ON k.track_run_id = kr.track_run_id AND k.origin = 'moment'
       AND k.sample_start < coalesce(ker.slice_sample_end, kr.sample_end, ${Number.MAX_SAFE_INTEGER})
       AND k.sample_end > ker.slice_sample_start
     WHERE ker.episode_id = e.id) AS kept_at_ms`;

/**
 * Where an episode shows in the timeline (ADR 007): media in its own lane
 * whatever its size; everything else by size, `mixed` and unknown contexts
 * included, like in-person speech; an episode with no size yet is a moment.
 */
export const timelineLanes = [
  "conversations",
  "moments",
  "media",
  "dictations",
  "imports",
  "traces",
] as const;
export type TimelineLane = (typeof timelineLanes)[number];

/** `TimelineLane` of `episodes e` in SQL. */
export const timelineLaneSql = `CASE WHEN e.context = 'media' THEN 'media'
  WHEN e.context = 'dictation' THEN 'dictations'
  WHEN e.context = 'imported' THEN 'imports'
  WHEN e.size = 'conversation' THEN 'conversations'
  WHEN e.size = 'trace' THEN 'traces' ELSE 'moments' END`;

/** A published transcript (final or near-live) exists for `episodes e`. */
export const transcribedSql = `EXISTS (SELECT 1 FROM episode_analysis ea
  WHERE ea.episode_id = e.id AND ea.stage IN ('asr', 'asr_live'))`;

/** A position in the newest-first episode order; the next page starts after it. */
export interface EpisodeCursor {
  readonly startedAtMs: number;
  readonly id: number;
}

export interface EpisodeListRange {
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
  readonly lane?: TimelineLane;
  /** Continue after this episode (keyset paging: stable while episodes are added). */
  readonly after?: EpisodeCursor;
}

export interface EpisodeListPage {
  readonly episodes: readonly EpisodeSummaryRow[];
  /** The last episode returned, when more follow. */
  readonly next: EpisodeCursor | null;
}

/** Episodes starting in `[fromMs, toMs)`, newest first, optionally in one lane. */
export function listEpisodes(db: Database, range: EpisodeListRange): EpisodeListPage {
  const rows = db
    .statement(
      `SELECT ${summaryColumns} FROM episodes e
       WHERE e.started_at_ms >= :from AND e.started_at_ms < :to
         AND (:lane IS NULL OR ${timelineLaneSql} = :lane)
         AND (:afterStart IS NULL OR e.started_at_ms < :afterStart OR e.id < :afterId)
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT :limit`,
    )
    .all({
      from: range.fromMs,
      // The cursor bounds the index range, so a later page does not rescan earlier ones.
      to:
        range.after === undefined ? range.toMs : Math.min(range.toMs, range.after.startedAtMs + 1),
      lane: range.lane ?? null,
      afterStart: range.after?.startedAtMs ?? null,
      afterId: range.after?.id ?? null,
      limit: range.limit + 1,
    })
    .map(toSummary);
  const episodes = rows.slice(0, range.limit);
  const last = episodes.at(-1);
  return {
    episodes,
    next:
      rows.length > range.limit && last !== undefined
        ? { startedAtMs: last.startedAtMs, id: last.id }
        : null,
  };
}

/** The summaries of these episodes, by id; unknown ids are left out. */
export function loadEpisodeSummaries(
  db: Database,
  ids: readonly number[],
): Map<number, EpisodeSummaryRow> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .statement(
        `SELECT ${summaryColumns} FROM episodes e WHERE e.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids))
      .map((row) => {
        const summary = toSummary(row);
        return [summary.id, summary];
      }),
  );
}

/** `[time_uncertain, name]` of the phone recording an episode holds, as `summaryColumns` reads it. */
function phoneOf(json: string | null): EpisodeSummaryRow["phone"] {
  if (json === null) return null;
  const [uncertain, name] = JSON.parse(json) as [unknown, unknown];
  return { timeUncertain: uncertain === 1, name: typeof name === "string" ? name : null };
}

function toSummary(row: Row): EpisodeSummaryRow {
  return {
    id: int(row, "id"),
    state: oneOfValues(row, "state", episodeStates),
    ending: int(row, "ending") === 1,
    context: nullableEnum(row, "context", episodeContexts),
    size: nullableEnum(row, "size", episodeSizes),
    sizeState: oneOfValues(row, "size_state", classificationStates),
    analysisState: oneOfValues(row, "analysis_state", analysisStates),
    startedAtMs: int(row, "started_at_ms"),
    endedAtMs: intOrNull(row, "ended_at_ms"),
    voicedMs: int(row, "voiced_ms"),
    firstText: strOrNull(row, "first_text"),
    speakerCount: int(row, "speaker_count"),
    live: int(row, "live") === 1,
    pageKey: strOrNull(row, "page_key"),
    phone: phoneOf(strOrNull(row, "phone_recording")),
    alsoRecordedBy: nullableEnum(row, "also_recorded_by", sameMomentSources),
    keptAtMs: intOrNull(row, "kept_at_ms"),
  };
}

export interface EpisodeDetail {
  readonly episode: EpisodeSummaryRow;
  readonly tracks: readonly {
    readonly trackRunId: number;
    readonly trackKey: string;
    readonly sourceKind: TrackSourceKind;
  }[];
  readonly speakers: readonly RunSpeaker[];
  readonly segments: readonly {
    readonly id: number;
    readonly trackRunId: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly speakerLabel: string | null;
    readonly text: string;
    readonly lang: string | null;
    /** The user corrected its text (the engine's is kept). */
    readonly edited: boolean;
    /** The app in front on the Mac while it was said (ADR 022); null when none was. */
    readonly app: EpisodeApp | null;
  }[];
  readonly analysis: {
    readonly runId: number;
    readonly engineId: string;
    readonly coverage: number | null;
    readonly publishedAtMs: number;
  } | null;
}

export function getEpisodeDetail(db: Database, episodeId: number): EpisodeDetail | null {
  const row = db
    .statement(`SELECT ${summaryColumns} FROM episodes e WHERE e.id = ?`)
    .get(episodeId);
  if (row === undefined) return null;
  const tracks = db
    .statement(
      `SELECT DISTINCT t.id, t.track_key, t.source_kind, t.started_wall_ms
       FROM episode_regions er
       JOIN speech_regions r ON r.id = er.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE er.episode_id = ? ORDER BY t.started_wall_ms, t.id`,
    )
    .all(episodeId)
    .map((track) => ({
      trackRunId: int(track, "id"),
      trackKey: str(track, "track_key"),
      sourceKind: oneOfValues(track, "source_kind", trackSourceKinds),
    }));
  const current = db
    .statement(
      `SELECT ea.run_id, ea.published_at_ms, r.engine_id, r.coverage
       FROM episode_analysis ea JOIN analysis_runs r ON r.id = ea.run_id
       WHERE ea.episode_id = ? AND ea.stage = 'asr'`,
    )
    .get(episodeId);
  const runId = current === undefined ? null : int(current, "run_id");
  const speakers = runId === null ? [] : loadRunSpeakers(db, runId);
  const segments = db
    .statement(
      `SELECT s.id, s.track_run_id, s.start_ms, s.end_ms, s.speaker_label, s.text, s.lang,
         s.original_text IS NOT NULL AS edited, ${appColumns("a")}
       FROM segments s LEFT JOIN apps a ON a.id = ${segmentAppIdSql("s")}
       WHERE s.episode_id = ? ORDER BY s.start_ms, s.seq, s.id`,
    )
    .all(episodeId)
    .map((segment) => ({
      id: int(segment, "id"),
      trackRunId: int(segment, "track_run_id"),
      startMs: int(segment, "start_ms"),
      endMs: int(segment, "end_ms"),
      speakerLabel: strOrNull(segment, "speaker_label"),
      text: str(segment, "text"),
      lang: strOrNull(segment, "lang"),
      edited: int(segment, "edited") === 1,
      app: appOf(segment),
    }));
  return {
    episode: toSummary(row),
    tracks,
    speakers,
    segments,
    analysis:
      current === undefined || runId === null
        ? null
        : {
            runId,
            engineId: str(current, "engine_id"),
            coverage: current["coverage"] === null ? null : num(current, "coverage"),
            publishedAtMs: int(current, "published_at_ms"),
          },
  };
}

function nullableEnum<const T extends string>(
  row: Row,
  key: string,
  values: readonly T[],
): T | null {
  return row[key] === null ? null : oneOfValues(row, key, values);
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
