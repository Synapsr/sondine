import { and, eq, gte, lt } from "drizzle-orm";
import { closeSpeechRegion, type ImportStatus } from "./capture-import";
import { transaction, type Database } from "./database";
import { chunks, speechRegions, spoolFiles, trackRuns } from "./schema/capture";

export interface RecoveredRunEnd {
  readonly trackRunId: number;
  /** Run sample index after the last committed sample. */
  readonly sampleEnd: number;
  readonly endedWallMs: number;
  /** `helper_exit`: the helper that wrote the run is gone; `recovered`: core missed its close. */
  readonly endReason: "helper_exit" | "recovered";
  readonly nowMs?: number;
}

export interface RecoveredRunResult {
  readonly status: ImportStatus;
  readonly closedFiles: number;
  readonly closedRegions: number;
  /** Open regions that start at or after the run's end: none of their audio was committed. */
  readonly droppedRegions: number;
}

/**
 * Closes a track run that never received its `track.close`: the run ends at
 * its last committed sample, its open spool files close, and an open speech
 * region ends there too (`recovery`), or is dropped when none of its audio
 * was committed. One transaction; a run that is no longer open is left alone.
 */
export function closeRecoveredTrackRun(db: Database, input: RecoveredRunEnd): RecoveredRunResult {
  return transaction(db, () => {
    const none = { closedFiles: 0, closedRegions: 0, droppedRegions: 0 };
    const run = db.orm.select().from(trackRuns).where(eq(trackRuns.id, input.trackRunId)).get();
    if (run === undefined) return { status: "unknown", ...none };
    if (run.state !== "open") return { status: "unchanged", ...none };
    const endedWallMs = Math.max(input.endedWallMs, run.startedWallMs);
    db.orm
      .update(trackRuns)
      .set({
        state: "closed",
        endedWallMs,
        endReason: input.endReason,
        sampleEnd: input.sampleEnd,
        updatedAtMs: input.nowMs ?? Date.now(),
      })
      .where(eq(trackRuns.id, run.id))
      .run();
    const files = db.orm
      .update(spoolFiles)
      .set({ state: "closed", closedWallMs: endedWallMs })
      .where(and(eq(spoolFiles.trackRunId, run.id), eq(spoolFiles.state, "open")))
      .run();
    const open = db.orm
      .select({ id: speechRegions.id, sampleStart: speechRegions.sampleStart })
      .from(speechRegions)
      .where(and(eq(speechRegions.trackRunId, run.id), eq(speechRegions.state, "open")))
      .all();
    let closedRegions = 0;
    let droppedRegions = 0;
    for (const region of open) {
      if (region.sampleStart >= input.sampleEnd) {
        db.orm.delete(speechRegions).where(eq(speechRegions.id, region.id)).run();
        droppedRegions += 1;
        continue;
      }
      closeSpeechRegion(db, {
        trackRunId: run.id,
        sampleStart: region.sampleStart,
        sampleEnd: input.sampleEnd,
        wallEndMs: endedWallMs,
        endReason: "recovery",
      });
      closedRegions += 1;
    }
    return { status: "updated", closedFiles: Number(files.changes), closedRegions, droppedRegions };
  });
}

/**
 * Drops the chunks of a run that start inside [fromSample, toSample): the
 * helper's recovery cut those blocks from their file (a `recovery-truncated`
 * gap), so their bytes are gone. Each affected file's committed size shrinks
 * back to the first dropped block. One transaction.
 */
export function dropTruncatedChunks(
  db: Database,
  input: { readonly trackRunId: number; readonly fromSample: number; readonly toSample: number },
): { readonly dropped: number } {
  return transaction(db, () => {
    const inside = and(
      eq(chunks.trackRunId, input.trackRunId),
      gte(chunks.sampleStart, input.fromSample),
      lt(chunks.sampleStart, input.toSample),
    );
    const doomed = db.orm
      .select({ spoolFileId: chunks.spoolFileId, byteOffset: chunks.byteOffset })
      .from(chunks)
      .where(inside)
      .all();
    if (doomed.length === 0) return { dropped: 0 };
    const firstCut = new Map<number, number>();
    for (const chunk of doomed) {
      firstCut.set(
        chunk.spoolFileId,
        Math.min(firstCut.get(chunk.spoolFileId) ?? Infinity, chunk.byteOffset),
      );
    }
    db.orm.delete(chunks).where(inside).run();
    for (const [spoolFileId, offset] of firstCut) {
      const file = db.orm
        .select({ committedBytes: spoolFiles.committedBytes })
        .from(spoolFiles)
        .where(eq(spoolFiles.id, spoolFileId))
        .get();
      if (file !== undefined && file.committedBytes > offset) {
        db.orm
          .update(spoolFiles)
          .set({ committedBytes: offset })
          .where(eq(spoolFiles.id, spoolFileId))
          .run();
      }
    }
    return { dropped: doomed.length };
  });
}
