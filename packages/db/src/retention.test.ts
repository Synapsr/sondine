import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSpeechRegion,
  closeSpoolFile,
  openSpeechRegion,
  recordGap,
  recordSpoolCommit,
  recordSpoolFile,
} from "./capture-import";
import { deleteEpisode } from "./delete-episode";
import {
  commitLeftOut,
  durableTransaction,
  expireSpoolFile,
  markArchiveScrubbed,
  planArchive,
  recordArchive,
  regionImportState,
  RetentionStateError,
  spoolBytes,
  trackAudioRows,
  unarchiveSpoolFile,
  unscrubbedChunks,
} from "./retention";
import { at, seedEpisode, seedTrackRun, t0, tempDatabase, type TempDatabase } from "./test-helpers";

// One spool file of 20 blocks of 0.5 s (8 000 samples); the rolls are 1.5 s
// (3 blocks) before a region and 0.8 s (1.6 blocks) after it.
const BLOCK = 8_000;
const BLOCKS = 20;

describe("retention helpers", () => {
  let temp: TempDatabase;
  beforeEach(() => {
    temp = tempDatabase();
  });
  afterEach(() => temp.cleanup());

  function spoolFile(trackRunId: number, options: { closed?: boolean } = {}) {
    const { spoolFileId } = recordSpoolFile(temp.db, {
      trackRunId,
      seq: 0,
      relPath: `spool/input-Mic/run-${trackRunId}/0000.pcm`,
      sampleStart: 0,
      createdWallMs: t0,
    });
    const chunkIds: number[] = [];
    for (let block = 0; block < BLOCKS; block++) {
      const chunk = recordSpoolCommit(temp.db, {
        spoolFileId,
        byteOffset: block * BLOCK * 2,
        byteLength: BLOCK * 2,
        sampleStart: block * BLOCK,
        wallMs: t0 + block * 500,
        crc32: 1_000 + block,
      });
      if (chunk.chunkId !== null) chunkIds.push(chunk.chunkId);
    }
    if (options.closed !== false)
      closeSpoolFile(temp.db, { spoolFileId, closedWallMs: t0 + 10_000 });
    return { spoolFileId, chunkIds };
  }

  function region(trackRunId: number, start: number, end: number | null) {
    openSpeechRegion(temp.db, { trackRunId, sampleStart: start, wallStartMs: t0, vadVersion: "v" });
    if (end === null) return;
    closeSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: start,
      sampleEnd: end,
      wallEndMs: t0 + 1,
      endReason: "silence",
    });
  }

  const blocksOf = (plan: ReturnType<typeof planArchive>) =>
    plan?.selected.map((chunk) => chunk.sampleStart / BLOCK);

  function archiveAll(spoolFileId: number) {
    const plan = planArchive(temp.db, spoolFileId);
    if (plan === undefined) throw new Error("no plan");
    let offset = 0;
    recordArchive(temp.db, {
      spoolFileId,
      archiveRelPath: "archive/input-Mic/x/0000.pcm",
      placements: plan.selected.map((chunk) => {
        const placement = { chunkId: chunk.id, crc32: chunk.crc32, archiveByteOffset: offset };
        offset += chunk.byteLength;
        return placement;
      }),
    });
    return plan;
  }

  it("selects the chunks a closed region reaches with its rolls", () => {
    const run = seedTrackRun(temp.db);
    const { spoolFileId } = spoolFile(run);
    // [4 s, 5 s) widened to [2.5 s, 5.8 s): blocks 5 to 11.
    region(run, at(4), at(5));
    const plan = planArchive(temp.db, spoolFileId);
    expect(blocksOf(plan)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(plan).toMatchObject({
      openRegions: 0,
      lost: 0,
      span: { start: 0, end: BLOCKS * BLOCK },
    });
    // A region near the start clamps its pre-roll at sample 0.
    region(run, at(0.2), at(0.4));
    expect(blocksOf(planArchive(temp.db, spoolFileId))).toEqual([0, 1, 2, 5, 6, 7, 8, 9, 10, 11]);
    // An open region reaching the file is counted, not selected.
    region(run, at(9), null);
    expect(planArchive(temp.db, spoolFileId)?.openRegions).toBe(1);
  });

  it("leaves deleted chunks out and counts expired ones as lost", () => {
    const run = seedTrackRun(temp.db);
    const { spoolFileId, chunkIds } = spoolFile(run);
    region(run, at(4), at(5));
    temp.db
      .statement("UPDATE chunks SET audio_state = 'deleted' WHERE id = ?")
      .run(chunkIds[6] ?? -1);
    temp.db
      .statement("UPDATE chunks SET audio_state = 'expired' WHERE id = ?")
      .run(chunkIds[7] ?? -1);
    const plan = planArchive(temp.db, spoolFileId);
    expect(blocksOf(plan)).toEqual([5, 8, 9, 10, 11]);
    expect(plan?.lost).toBe(1);
  });

  it("archives all chunks or none, then expires the rest of the file", () => {
    const run = seedTrackRun(temp.db);
    const { spoolFileId, chunkIds } = spoolFile(run);
    region(run, at(4), at(5));
    // Refused while a selected chunk is not archived.
    expect(() => expireSpoolFile(temp.db, spoolFileId)).toThrow(RetentionStateError);

    const plan = planArchive(temp.db, spoolFileId);
    if (plan === undefined) throw new Error("no plan");
    temp.db
      .statement("UPDATE chunks SET audio_state = 'deleted' WHERE id = ?")
      .run(chunkIds[11] ?? -1);
    expect(() =>
      recordArchive(temp.db, {
        spoolFileId,
        archiveRelPath: "archive/input-Mic/x/0000.pcm",
        placements: plan.selected.map((chunk, index) => ({
          chunkId: chunk.id,
          crc32: chunk.crc32,
          archiveByteOffset: index * BLOCK * 2,
        })),
      }),
    ).toThrow(RetentionStateError);
    expect(
      temp.db.statement("SELECT count(*) AS n FROM chunks WHERE audio_state = 'archived'").get(),
    ).toEqual({
      n: 0,
    });

    archiveAll(spoolFileId);
    expect(spoolBytes(temp.db)).toBe(BLOCKS * BLOCK * 2);
    expect(expireSpoolFile(temp.db, spoolFileId)).toEqual({ expiredChunks: BLOCKS - 6 - 1 });
    expect(spoolBytes(temp.db)).toBe(0);
    expect(() => unarchiveSpoolFile(temp.db, spoolFileId)).toThrow(RetentionStateError);
  });

  it("refuses to expire an open file or one an open region reaches", () => {
    const run = seedTrackRun(temp.db);
    const open = spoolFile(run, { closed: false });
    expect(() => expireSpoolFile(temp.db, open.spoolFileId)).toThrow(/is open/);
    const other = seedTrackRun(temp.db);
    const reached = spoolFile(other);
    region(other, at(9.5), null);
    expect(() => expireSpoolFile(temp.db, reached.spoolFileId)).toThrow(/open region/);
  });

  it("puts archived chunks back on the spool while it still holds them", () => {
    const run = seedTrackRun(temp.db);
    const { spoolFileId } = spoolFile(run);
    region(run, at(4), at(5));
    archiveAll(spoolFileId);
    expect(unarchiveSpoolFile(temp.db, spoolFileId)).toEqual({ chunks: 7 });
    expect(
      planArchive(temp.db, spoolFileId)?.selected.every((c) => c.audioState === "present"),
    ).toBe(true);
  });

  it("runs durable transactions with synchronous=FULL and restores NORMAL", () => {
    const synchronous = () => temp.db.client.prepare("PRAGMA synchronous").get()?.["synchronous"];
    expect(synchronous()).toBe(1);
    const inside = durableTransaction(temp.db, () => synchronous());
    expect(inside).toBe(2);
    expect(synchronous()).toBe(1);
    expect(() =>
      durableTransaction(temp.db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(synchronous()).toBe(1);
    temp.db.client.exec("BEGIN");
    expect(() => durableTransaction(temp.db, () => 1)).toThrow(RetentionStateError);
    temp.db.client.exec("ROLLBACK");
  });

  it("finds deleted chunks whose bytes may remain, until their archive bytes are scrubbed", () => {
    const seeded = seedEpisode(temp.db, [[4, 5]]);
    const { spoolFileId } = spoolFile(seeded.trackRunId);
    archiveAll(spoolFileId);
    const result = deleteEpisode(temp.db, seeded.episodeId, { origin: "app" });
    if (!result.deleted) throw new Error("not deleted");
    const archived = result.chunks.filter((chunk) => chunk.archiveRelPath !== null);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((chunk) => chunk.archiveByteOffset !== null)).toBe(true);
    // The spool file still holds them, and so does the archive.
    expect(
      unscrubbedChunks(temp.db)
        .map((chunk) => chunk.chunkId)
        .toSorted(),
    ).toEqual(result.chunks.map((chunk) => chunk.chunkId).toSorted());
    markArchiveScrubbed(
      temp.db,
      archived.map((chunk) => chunk.chunkId),
    );
    expect(expireSpoolFileAfterDelete(spoolFileId)).toBe(true);
    expect(unscrubbedChunks(temp.db)).toEqual([]);
  });

  /** The spool file goes (no selected chunk is left): its deleted chunks are no longer on disk. */
  function expireSpoolFileAfterDelete(spoolFileId: number): boolean {
    expireSpoolFile(temp.db, spoolFileId);
    return (
      temp.db.statement("SELECT state FROM spool_files WHERE id = ?").get(spoolFileId)?.[
        "state"
      ] === "expired"
    );
  }

  it("tells imported, deleted and missing manifest regions and commits apart", () => {
    const seeded = seedEpisode(temp.db, [[4, 5]]);
    const run = seeded.trackRunId;
    region(run, at(7), null);
    expect(regionImportState(temp.db, run, at(4))).toBe("closed");
    expect(regionImportState(temp.db, run, at(7))).toBe("open");
    expect(regionImportState(temp.db, run, at(8))).toBe("missing");
    deleteEpisode(temp.db, seeded.episodeId, { origin: "app" });
    expect(regionImportState(temp.db, run, at(4))).toBe("deleted");

    const span = (start: number, end: number) => ({
      trackRunId: run,
      sampleStart: at(start),
      sampleEnd: at(end),
      wallStartMs: t0 + 60_000,
      wallEndMs: t0 + 60_001,
    });
    expect(commitLeftOut(temp.db, span(4, 4.5))).toBe(true);
    expect(commitLeftOut(temp.db, span(8, 8.5))).toBe(false);
    recordGap(temp.db, {
      trackRunId: run,
      trackKey: "input:BuiltInMicrophoneDevice",
      reason: "recovery_truncated",
      wallStartMs: t0 + 8_000,
      wallEndMs: t0 + 9_000,
      sampleStart: at(8),
      sampleEnd: at(9),
    });
    expect(commitLeftOut(temp.db, span(8, 8.5))).toBe(true);
  });

  it("returns the chunks, gaps and tombstones a read of a range needs", () => {
    const run = seedTrackRun(temp.db);
    spoolFile(run);
    recordGap(temp.db, {
      trackRunId: run,
      trackKey: "input:BuiltInMicrophoneDevice",
      reason: "helper_exit",
      wallStartMs: t0 + 10_000,
      wallEndMs: t0 + 20_000,
      sampleStart: BLOCKS * BLOCK,
    });
    const rows = trackAudioRows(temp.db, run, BLOCK + 10, BLOCKS * BLOCK + 100);
    expect(rows.chunks.map((chunk) => chunk.sampleStart / BLOCK)).toEqual(
      Array.from({ length: BLOCKS - 1 }, (_, index) => index + 1),
    );
    expect(rows.chunks[0]?.spoolState).toBe("closed");
    // An open-ended gap runs to the end of the range.
    expect(rows.gaps).toEqual([{ sampleStart: BLOCKS * BLOCK, sampleEnd: BLOCKS * BLOCK + 100 }]);
    expect(rows.deleted).toEqual([]);
  });
});
