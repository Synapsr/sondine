import { and, eq, lt } from "drizzle-orm";
import { transaction, type Database } from "./database";
import { findDeletedRanges, msToSamples, samplesToMs, type DeletedRange } from "./deleted-ranges";
import {
  apps,
  chunks,
  devices,
  epochs,
  gaps,
  speechRegions,
  spoolFiles,
  trackRuns,
} from "./schema/capture";
import type {
  DeviceTransport,
  EpochReason,
  GapReason,
  SpeechRegionEndReason,
  TrackRunEndReason,
  TrackRunState,
  TrackSourceKind,
} from "./schema/enums";

/**
 * - `inserted` / `updated`: the event changed the database.
 * - `unchanged` / `duplicate`: a replay of something already recorded.
 * - `skipped_deleted`: refused because it intersects a deleted range.
 * - `clamped`: a region close trimmed at the start of a deleted range.
 * - `unknown`: the event refers to a row that does not exist (or was deleted).
 */
export type ImportStatus =
  | "inserted"
  | "updated"
  | "unchanged"
  | "duplicate"
  | "skipped_deleted"
  | "clamped"
  | "unknown";

/** The event contradicts what is already recorded for the same identity. */
export class ImportConflictError extends Error {
  override readonly name = "ImportConflictError";
}

const conflict = (what: string, field: string): never => {
  throw new ImportConflictError(`${what}: ${field} differs from the recorded value`);
};

export interface DeviceInput {
  readonly uid: string;
  readonly name: string;
  readonly transport?: DeviceTransport;
  readonly hasInput?: boolean;
  readonly hasOutput?: boolean;
  readonly seenAtMs: number;
}

export function upsertDevice(
  db: Database,
  input: DeviceInput,
): { readonly deviceId: number; readonly status: ImportStatus } {
  return transaction(db, () => {
    const existing = db.orm.select().from(devices).where(eq(devices.uid, input.uid)).get();
    const fields = {
      name: input.name,
      transport: input.transport ?? existing?.transport ?? "unknown",
      hasInput: input.hasInput ?? existing?.hasInput ?? false,
      hasOutput: input.hasOutput ?? existing?.hasOutput ?? false,
    };
    if (existing === undefined) {
      const row = db.orm
        .insert(devices)
        .values({
          uid: input.uid,
          ...fields,
          firstSeenMs: input.seenAtMs,
          lastSeenMs: input.seenAtMs,
        })
        .returning({ id: devices.id })
        .get();
      return { deviceId: row.id, status: "inserted" };
    }
    const same =
      existing.name === fields.name &&
      existing.transport === fields.transport &&
      existing.hasInput === fields.hasInput &&
      existing.hasOutput === fields.hasOutput &&
      existing.lastSeenMs >= input.seenAtMs;
    if (same) return { deviceId: existing.id, status: "unchanged" };
    db.orm
      .update(devices)
      .set({ ...fields, lastSeenMs: Math.max(existing.lastSeenMs, input.seenAtMs) })
      .where(eq(devices.id, existing.id))
      .run();
    return { deviceId: existing.id, status: "updated" };
  });
}

export interface AppInput {
  readonly bundleId: string;
  readonly name?: string | null;
  readonly seenAtMs: number;
}

export function upsertApp(
  db: Database,
  input: AppInput,
): { readonly appId: number; readonly status: ImportStatus } {
  return transaction(db, () => {
    const existing = db.orm.select().from(apps).where(eq(apps.bundleId, input.bundleId)).get();
    const name = input.name ?? existing?.name ?? null;
    if (existing === undefined) {
      const row = db.orm
        .insert(apps)
        .values({
          bundleId: input.bundleId,
          name,
          firstSeenMs: input.seenAtMs,
          lastSeenMs: input.seenAtMs,
        })
        .returning({ id: apps.id })
        .get();
      return { appId: row.id, status: "inserted" };
    }
    if (existing.name === name && existing.lastSeenMs >= input.seenAtMs) {
      return { appId: existing.id, status: "unchanged" };
    }
    db.orm
      .update(apps)
      .set({ name, lastSeenMs: Math.max(existing.lastSeenMs, input.seenAtMs) })
      .where(eq(apps.id, existing.id))
      .run();
    return { appId: existing.id, status: "updated" };
  });
}

export interface TrackRunInput {
  /** The helper's run id: one continuous opening of a track. */
  readonly uid: string;
  readonly trackKey: string;
  readonly sourceKind: TrackSourceKind;
  readonly device?: DeviceInput;
  readonly app?: AppInput;
  readonly sampleRate?: number;
  readonly startedWallMs: number;
  readonly state?: TrackRunState;
  readonly endedWallMs?: number | null;
  readonly endReason?: TrackRunEndReason | null;
  readonly sampleEnd?: number | null;
  readonly nowMs?: number;
}

const stateRank: Record<TrackRunState, number> = { open: 0, closed: 1, sealed: 2 };

/**
 * Records a track run, or moves it forward (open, closed, sealed). Track runs
 * hold no audio, so they are recorded even inside a deleted range: content
 * that follows the range still needs them.
 */
export function upsertTrackRun(
  db: Database,
  input: TrackRunInput,
): { readonly trackRunId: number; readonly status: ImportStatus } {
  return transaction(db, () => {
    const nowMs = input.nowMs ?? Date.now();
    const deviceId = input.device === undefined ? null : upsertDevice(db, input.device).deviceId;
    const appId = input.app === undefined ? null : upsertApp(db, input.app).appId;
    const sampleRate = input.sampleRate ?? 16000;
    const state = input.state ?? "open";
    const end = {
      endedWallMs: input.endedWallMs ?? null,
      endReason: input.endReason ?? null,
      sampleEnd: input.sampleEnd ?? null,
    };
    const existing = db.orm.select().from(trackRuns).where(eq(trackRuns.uid, input.uid)).get();
    if (existing === undefined) {
      const row = db.orm
        .insert(trackRuns)
        .values({
          uid: input.uid,
          trackKey: input.trackKey,
          sourceKind: input.sourceKind,
          deviceId,
          appId,
          sampleRate,
          state,
          ...end,
          startedWallMs: input.startedWallMs,
          updatedAtMs: nowMs,
        })
        .returning({ id: trackRuns.id })
        .get();
      return { trackRunId: row.id, status: "inserted" };
    }
    const what = `track run ${input.uid}`;
    if (existing.trackKey !== input.trackKey) conflict(what, "track_key");
    if (existing.sourceKind !== input.sourceKind) conflict(what, "source_kind");
    if (existing.startedWallMs !== input.startedWallMs) conflict(what, "started_wall_ms");
    if (existing.sampleRate !== sampleRate) conflict(what, "sample_rate");

    // A replayed older state (open after closed) never moves a run backwards.
    const advances = stateRank[state] >= stateRank[existing.state];
    const endChanges =
      advances &&
      (existing.state !== state ||
        existing.endedWallMs !== end.endedWallMs ||
        existing.endReason !== end.endReason ||
        existing.sampleEnd !== end.sampleEnd);
    const fillsLinks =
      (existing.deviceId === null && deviceId !== null) ||
      (existing.appId === null && appId !== null);
    if (!endChanges && !fillsLinks) return { trackRunId: existing.id, status: "unchanged" };
    db.orm
      .update(trackRuns)
      .set({
        deviceId: existing.deviceId ?? deviceId,
        appId: existing.appId ?? appId,
        ...(endChanges ? { state, ...end } : {}),
        updatedAtMs: nowMs,
      })
      .where(eq(trackRuns.id, existing.id))
      .run();
    return { trackRunId: existing.id, status: "updated" };
  });
}

export interface EpochInput {
  readonly trackRunId: number;
  readonly seq: number;
  readonly reason: EpochReason;
  readonly sampleStart: number;
  readonly measuredRateHz?: number | null;
  readonly timebaseNumer: number;
  readonly timebaseDenom: number;
  /** mach_absolute_time ticks; may exceed 2^53. */
  readonly anchorHostTicks: bigint;
  readonly anchorContinuousUs: number;
  readonly anchorWallMs: number;
  readonly driftPpm?: number | null;
  readonly alignmentUncertaintyUs?: number | null;
}

export function recordEpoch(
  db: Database,
  input: EpochInput,
): { readonly epochId: number; readonly status: ImportStatus } {
  return transaction(db, () => {
    const existing = db.orm
      .select()
      .from(epochs)
      .where(and(eq(epochs.trackRunId, input.trackRunId), eq(epochs.seq, input.seq)))
      .get();
    if (existing !== undefined) {
      const what = `epoch ${input.trackRunId}/${input.seq}`;
      if (existing.sampleStart !== input.sampleStart) conflict(what, "sample_start");
      if (existing.anchorHostTicks !== input.anchorHostTicks) conflict(what, "anchor_host_ticks");
      return { epochId: existing.id, status: "duplicate" };
    }
    const row = db.orm
      .insert(epochs)
      .values({
        ...input,
        measuredRateHz: input.measuredRateHz ?? null,
        driftPpm: input.driftPpm ?? null,
        alignmentUncertaintyUs: input.alignmentUncertaintyUs ?? null,
      })
      .returning({ id: epochs.id })
      .get();
    return { epochId: row.id, status: "inserted" };
  });
}

export interface SpoolFileInput {
  readonly trackRunId: number;
  /** Rotation index of the file within its run. */
  readonly seq: number;
  /** Path relative to the data directory. */
  readonly relPath: string;
  readonly sampleStart: number;
  readonly createdWallMs: number;
}

/** Spool files are containers: recorded even when a deleted range covers them. */
export function recordSpoolFile(
  db: Database,
  input: SpoolFileInput,
): { readonly spoolFileId: number; readonly status: ImportStatus } {
  return transaction(db, () => {
    const existing = db.orm
      .select()
      .from(spoolFiles)
      .where(and(eq(spoolFiles.trackRunId, input.trackRunId), eq(spoolFiles.seq, input.seq)))
      .get();
    if (existing !== undefined) {
      const what = `spool file ${input.relPath}`;
      if (existing.relPath !== input.relPath) conflict(what, "rel_path");
      if (existing.sampleStart !== input.sampleStart) conflict(what, "sample_start");
      return { spoolFileId: existing.id, status: "duplicate" };
    }
    const row = db.orm.insert(spoolFiles).values(input).returning({ id: spoolFiles.id }).get();
    return { spoolFileId: row.id, status: "inserted" };
  });
}

export function closeSpoolFile(
  db: Database,
  input: { readonly spoolFileId: number; readonly closedWallMs: number },
): { readonly status: ImportStatus } {
  return transaction(db, () => {
    const changed = db.orm
      .update(spoolFiles)
      .set({ state: "closed", closedWallMs: input.closedWallMs })
      .where(and(eq(spoolFiles.id, input.spoolFileId), eq(spoolFiles.state, "open")))
      .run();
    if (changed.changes > 0) return { status: "updated" };
    const exists = db.orm
      .select({ id: spoolFiles.id })
      .from(spoolFiles)
      .where(eq(spoolFiles.id, input.spoolFileId))
      .get();
    return { status: exists === undefined ? "unknown" : "unchanged" };
  });
}

/**
 * Closes a run's open spool files that come before `beforeSeq`: the helper
 * writes only a run's newest file, so a core that missed a rotation (it
 * started mid-run, or lost events) left the older one open.
 */
export function closeEarlierSpoolFiles(
  db: Database,
  input: { readonly trackRunId: number; readonly beforeSeq: number; readonly closedWallMs: number },
): { readonly statuses: readonly ImportStatus[] } {
  return transaction(db, () => {
    const closed = db.orm
      .update(spoolFiles)
      .set({ state: "closed", closedWallMs: input.closedWallMs })
      .where(
        and(
          eq(spoolFiles.trackRunId, input.trackRunId),
          eq(spoolFiles.state, "open"),
          lt(spoolFiles.seq, input.beforeSeq),
        ),
      )
      .run();
    return { statuses: Array.from({ length: Number(closed.changes) }, () => "updated" as const) };
  });
}

export interface SpoolCommitInput {
  readonly spoolFileId: number;
  /** Offset of the block's first byte in the spool file. */
  readonly byteOffset: number;
  readonly byteLength: number;
  /** Index of the block's first sample within the track run. */
  readonly sampleStart: number;
  /** mach_absolute_time ticks; may exceed 2^53. */
  readonly hostTicks?: bigint | null;
  readonly continuousUs?: number | null;
  readonly wallMs: number;
  readonly crc32: number;
}

/**
 * Records one committed spool block as a chunk; idempotent on
 * (spool file, byte offset). The file's committed size advances even when the
 * block itself is refused for a deleted range, so recovery never truncates
 * the valid blocks that follow it.
 */
export function recordSpoolCommit(
  db: Database,
  input: SpoolCommitInput,
): { readonly chunkId: number | null; readonly status: ImportStatus } {
  if (input.byteLength <= 0 || input.byteLength % 2 !== 0) {
    throw new RangeError(`byteLength must be a positive even number, got ${input.byteLength}`);
  }
  return transaction(db, () => {
    const file = db.orm
      .select({
        id: spoolFiles.id,
        trackRunId: spoolFiles.trackRunId,
        committedBytes: spoolFiles.committedBytes,
        sampleRate: trackRuns.sampleRate,
      })
      .from(spoolFiles)
      .innerJoin(trackRuns, eq(trackRuns.id, spoolFiles.trackRunId))
      .where(eq(spoolFiles.id, input.spoolFileId))
      .get();
    if (file === undefined)
      throw new ImportConflictError(`Unknown spool file ${input.spoolFileId}`);

    const existing = db.orm
      .select({
        id: chunks.id,
        byteLength: chunks.byteLength,
        crc32: chunks.crc32,
        hostTicks: chunks.hostTicks,
      })
      .from(chunks)
      .where(
        and(eq(chunks.spoolFileId, input.spoolFileId), eq(chunks.byteOffset, input.byteOffset)),
      )
      .get();
    if (existing !== undefined) {
      const what = `chunk ${input.spoolFileId}@${input.byteOffset}`;
      if (existing.byteLength !== input.byteLength) conflict(what, "byte_length");
      if (existing.crc32 !== input.crc32) conflict(what, "crc32");
      // Bigints compare by value; null means the commit carried no host time.
      if (existing.hostTicks !== (input.hostTicks ?? null)) conflict(what, "host_ticks");
      return { chunkId: existing.id, status: "duplicate" };
    }

    const end = input.byteOffset + input.byteLength;
    if (end > file.committedBytes) {
      db.orm
        .update(spoolFiles)
        .set({ committedBytes: end })
        .where(eq(spoolFiles.id, file.id))
        .run();
    }

    const sampleCount = input.byteLength / 2;
    const deleted = findDeletedRanges(db, {
      trackRunId: file.trackRunId,
      sampleStart: input.sampleStart,
      sampleEnd: input.sampleStart + sampleCount,
      wallStartMs: input.wallMs,
      wallEndMs: input.wallMs + samplesToMs(sampleCount, file.sampleRate),
    });
    if (deleted.length > 0) return { chunkId: null, status: "skipped_deleted" };

    const row = db.orm
      .insert(chunks)
      .values({
        spoolFileId: input.spoolFileId,
        trackRunId: file.trackRunId,
        byteOffset: input.byteOffset,
        byteLength: input.byteLength,
        sampleStart: input.sampleStart,
        sampleCount,
        hostTicks: input.hostTicks ?? null,
        continuousUs: input.continuousUs ?? null,
        wallMs: input.wallMs,
        crc32: input.crc32,
      })
      .returning({ id: chunks.id })
      .get();
    return { chunkId: row.id, status: "inserted" };
  });
}

export interface SpeechRegionOpenInput {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly wallStartMs: number;
  readonly continuousStartUs?: number | null;
  readonly vadVersion: string;
  /** A `system:other` region: the app its attribution named at the open, if one. */
  readonly attributedAppId?: number | null;
}

/** Idempotent on (track run, first sample). */
export function openSpeechRegion(
  db: Database,
  input: SpeechRegionOpenInput,
): { readonly speechRegionId: number | null; readonly status: ImportStatus } {
  return transaction(db, () => {
    const existing = db.orm
      .select({ id: speechRegions.id })
      .from(speechRegions)
      .where(
        and(
          eq(speechRegions.trackRunId, input.trackRunId),
          eq(speechRegions.sampleStart, input.sampleStart),
        ),
      )
      .get();
    if (existing !== undefined) return { speechRegionId: existing.id, status: "duplicate" };

    const deleted = findDeletedRanges(db, {
      trackRunId: input.trackRunId,
      sampleStart: input.sampleStart,
      sampleEnd: input.sampleStart + 1,
      wallStartMs: input.wallStartMs,
      wallEndMs: input.wallStartMs + 1,
    });
    if (deleted.length > 0) return { speechRegionId: null, status: "skipped_deleted" };

    const row = db.orm
      .insert(speechRegions)
      .values({
        trackRunId: input.trackRunId,
        sampleStart: input.sampleStart,
        wallStartMs: input.wallStartMs,
        continuousStartUs: input.continuousStartUs ?? null,
        vadVersion: input.vadVersion,
        attributedAppId: input.attributedAppId ?? null,
      })
      .returning({ id: speechRegions.id })
      .get();
    return { speechRegionId: row.id, status: "inserted" };
  });
}

export interface SpeechRegionCloseInput {
  readonly trackRunId: number;
  /** First sample of the region being closed (its identity). */
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly wallEndMs: number;
  readonly continuousEndUs?: number | null;
  readonly endReason: Exclude<SpeechRegionEndReason, "deleted">;
  /** Samples the VAD heard as speech, at most the span; null when the helper did not say. */
  readonly voicedSamples?: number | null;
}

/**
 * Closes an open region; idempotent. If the closed span crosses a deleted
 * range, the region ends where the earliest range starts (`clamped`), or is
 * removed when the range covers its start (`skipped_deleted`).
 */
export function closeSpeechRegion(
  db: Database,
  input: SpeechRegionCloseInput,
): { readonly speechRegionId: number | null; readonly status: ImportStatus } {
  return transaction(db, () => {
    const region = db.orm
      .select({
        id: speechRegions.id,
        state: speechRegions.state,
        sampleEnd: speechRegions.sampleEnd,
        endReason: speechRegions.endReason,
        wallStartMs: speechRegions.wallStartMs,
        sampleRate: trackRuns.sampleRate,
      })
      .from(speechRegions)
      .innerJoin(trackRuns, eq(trackRuns.id, speechRegions.trackRunId))
      .where(
        and(
          eq(speechRegions.trackRunId, input.trackRunId),
          eq(speechRegions.sampleStart, input.sampleStart),
        ),
      )
      .get();
    if (region === undefined) return { speechRegionId: null, status: "unknown" };
    const voicedSamples = input.voicedSamples ?? null;
    if (
      voicedSamples !== null &&
      (!Number.isInteger(voicedSamples) ||
        voicedSamples < 0 ||
        voicedSamples > input.sampleEnd - input.sampleStart)
    ) {
      throw new RangeError(
        `Region voiced samples ${voicedSamples} do not fit [${input.sampleStart}, ${input.sampleEnd})`,
      );
    }
    if (region.state === "closed") {
      if (region.sampleEnd === input.sampleEnd || region.endReason === "deleted") {
        return { speechRegionId: region.id, status: "duplicate" };
      }
      return conflict(`speech region ${region.id}`, "sample_end");
    }
    if (input.sampleEnd <= input.sampleStart) {
      throw new RangeError(
        `Region end ${input.sampleEnd} is not after its start ${input.sampleStart}`,
      );
    }

    const deleted = findDeletedRanges(db, {
      trackRunId: input.trackRunId,
      sampleStart: input.sampleStart,
      sampleEnd: input.sampleEnd,
      wallStartMs: region.wallStartMs,
      wallEndMs: input.wallEndMs,
    });
    if (deleted.length === 0) {
      db.orm
        .update(speechRegions)
        .set({
          state: "closed",
          sampleEnd: input.sampleEnd,
          wallEndMs: input.wallEndMs,
          continuousEndUs: input.continuousEndUs ?? null,
          endReason: input.endReason,
          voicedSamples,
        })
        .where(eq(speechRegions.id, region.id))
        .run();
      return { speechRegionId: region.id, status: "updated" };
    }

    const cut = Math.min(
      ...deleted.map((range) =>
        firstDeletedSample(range, input.sampleStart, region.wallStartMs, region.sampleRate),
      ),
    );
    if (cut <= input.sampleStart) {
      db.orm.delete(speechRegions).where(eq(speechRegions.id, region.id)).run();
      return { speechRegionId: null, status: "skipped_deleted" };
    }
    db.orm
      .update(speechRegions)
      .set({
        state: "closed",
        sampleEnd: cut,
        wallEndMs: region.wallStartMs + samplesToMs(cut - input.sampleStart, region.sampleRate),
        endReason: "deleted",
        // The helper does not say where the voice was: the kept part gets its share.
        voicedSamples:
          voicedSamples === null
            ? null
            : Math.round(
                (voicedSamples * (cut - input.sampleStart)) / (input.sampleEnd - input.sampleStart),
              ),
      })
      .where(eq(speechRegions.id, region.id))
      .run();
    return { speechRegionId: region.id, status: "clamped" };
  });
}

function firstDeletedSample(
  range: DeletedRange,
  regionStart: number,
  regionWallStartMs: number,
  sampleRate: number,
): number {
  if (range.scope === "track_run" && range.sampleStart !== null) return range.sampleStart;
  return regionStart + msToSamples(range.wallStartMs - regionWallStartMs, sampleRate);
}

export interface GapInput {
  readonly trackRunId?: number | null;
  readonly trackKey?: string | null;
  readonly reason: GapReason;
  readonly wallStartMs: number;
  readonly wallEndMs: number;
  readonly sampleStart?: number | null;
  readonly sampleEnd?: number | null;
  readonly lostBytes?: number | null;
  /** A short machine-readable code; never transcript or audio content. */
  readonly detail?: string | null;
}

/** Idempotent on (track run or key, reason, start). */
export function recordGap(
  db: Database,
  input: GapInput,
): { readonly gapId: number | null; readonly status: ImportStatus } {
  return transaction(db, () => {
    const trackRunId = input.trackRunId ?? null;
    const sampleStart = input.sampleStart ?? null;
    const sampleEnd = input.sampleEnd ?? null;
    const deleted = findDeletedRanges(db, {
      trackRunId,
      sampleStart,
      sampleEnd,
      wallStartMs: input.wallStartMs,
      wallEndMs: input.wallEndMs,
    });
    if (deleted.length > 0) return { gapId: null, status: "skipped_deleted" };

    const row = db.orm
      .insert(gaps)
      .values({
        trackRunId,
        trackKey: input.trackKey ?? null,
        reason: input.reason,
        wallStartMs: input.wallStartMs,
        wallEndMs: input.wallEndMs,
        sampleStart,
        sampleEnd,
        lostBytes: input.lostBytes ?? null,
        detail: input.detail ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: gaps.id })
      .get();
    return row === undefined
      ? { gapId: null, status: "duplicate" }
      : { gapId: row.id, status: "inserted" };
  });
}
