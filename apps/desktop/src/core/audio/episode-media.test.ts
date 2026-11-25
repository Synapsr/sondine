import { join } from "node:path";
import { bumpInputGeneration, deleteEpisode, openDatabase, type OpenedDatabase } from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RATE, SpoolFixture, T0, type FixtureRun } from "../../../test/spool-fixture";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { MEDIA_SLICE_BYTES, type ByteRangeSpec } from "../../shared/byte-range";
import type { MediaReadRequest } from "../../shared/core-messages";
import {
  createEpisodeMedia,
  MAX_MEDIA_JOBS,
  mediaReplyMessage,
  type EpisodeMediaService,
  type MediaReadReply,
} from "./episode-media";
import { WAV_HEADER_BYTES } from "./episode-wav";
import { createTrackAudioReader } from "./read-track-audio";
import type { TrackAudioRange } from "./track-audio";

// Core's playback service on a real database and real spool files: the
// fixture writes known samples, so every byte read back is checked.

const s = (sec: number) => Math.round(sec * RATE);
const from = (start: number, end: number | null = null): ByteRangeSpec => ({
  kind: "range",
  start,
  end,
});

/** Byte offset of timeline sample `sample` in the WAV. */
const byteAt = (sample: number) => WAV_HEADER_BYTES + 2 * sample;

describe("episode media", () => {
  let data: TempDataDir;
  let db: OpenedDatabase;
  let run: FixtureRun;
  let reads: TrackAudioRange[];
  let pending: (() => void)[];
  let media: EpisodeMediaService;

  beforeEach(() => {
    data = tempDataDir();
    db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
    const spool = new SpoolFixture(db, data.dir, s(1));
    run = spool.run();
    run.file("B".repeat(120));
    run.close();
    const reader = createTrackAudioReader(db, data.dir);
    reads = [];
    pending = [];
    media = createEpisodeMedia({
      db,
      reader: () => (range) => {
        reads.push(range);
        return reader(range);
      },
      // Each read waits for `step()`, so the queue is observable.
      defer: (next) => pending.push(next),
    });
  });
  afterEach(() => {
    db.close();
    data.cleanup();
  });

  /** A closed episode over regions [start, end) in seconds of the fixture run. */
  function episode(regions: readonly (readonly [number, number])[]): number {
    for (const [start, end] of regions) run.region(s(start), s(end));
    const id = Number(
      db
        .statement(
          `INSERT INTO episodes (state, started_at_ms, ended_at_ms, grouping_version, classifier_version,
             created_at_ms, updated_at_ms)
           VALUES ('closed', ?, ?, 'g1', 'c1', ?, ?)`,
        )
        .run(T0, T0, T0, T0).lastInsertRowid,
    );
    for (const [start] of regions) {
      const regionId = db
        .statement("SELECT id FROM speech_regions WHERE track_run_id = ? AND sample_start = ?")
        .get(run.id, s(start))?.["id"];
      db.statement(
        `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
         VALUES (?, ?, 'g1', ?)`,
      ).run(id, Number(regionId), s(start));
    }
    return id;
  }

  /** Runs the queued reads one turn at a time. */
  function step(): void {
    while (pending.length > 0) pending.shift()?.();
  }

  let nextId = 0;
  function read(episodeId: number, range: ByteRangeSpec, generation = 1) {
    nextId += 1;
    const request: MediaReadRequest = {
      type: "media-read",
      requestId: nextId,
      episodeId,
      generation,
      range,
    };
    return { request, reply: media.read(request) };
  }

  async function readNow(
    episodeId: number,
    range: ByteRangeSpec,
    generation = 1,
  ): Promise<MediaReadReply> {
    const { reply } = read(episodeId, range, generation);
    step();
    return reply;
  }

  it("plans playback without reading audio, then serves the WAV slice by slice", async () => {
    // Regions 10-20 s and 70-80 s: extents 8.5-20.8 s and 68.5-80.8 s.
    const id = episode([
      [10, 20],
      [70, 80],
    ]);
    const plan = media.playback(id);
    expect(plan).toEqual({
      generation: 1,
      startedAtMs: T0 + 8_500,
      durationMs: 72_300,
      speech: [
        { startMs: T0 + 10_000, endMs: T0 + 20_000, track: "microphone" },
        { startMs: T0 + 70_000, endMs: T0 + 80_000, track: "microphone" },
      ],
    });
    expect(reads).toEqual([]);

    const total = byteAt(s(72.3));
    const first = await readNow(id, from(0));
    expect(first).toMatchObject({ ok: true, total, start: 0, end: total - 1 });
    if (!first.ok) return;
    expect(first.bytes.byteLength).toBe(MEDIA_SLICE_BYTES);
    expect(new TextDecoder().decode(first.bytes.subarray(0, 4))).toBe("RIFF");
    const samples = new Int16Array(first.bytes.buffer.slice(WAV_HEADER_BYTES));
    expect(samples.subarray(0, 4)).toEqual(run.expected(s(8.5), s(8.5) + 4));

    // Seek to 70 s on the wall clock: the second extent, every sample as captured.
    const seek = byteAt(s(70 - 8.5));
    const second = await readNow(id, from(seek, seek + 3_999));
    expect(second).toMatchObject({ ok: true, start: seek, end: seek + 3_999 });
    if (!second.ok) return;
    expect(new Int16Array(second.bytes.buffer)).toEqual(run.expected(s(70), s(70) + 2_000));
    // Between the extents: silence, and nothing read.
    reads.length = 0;
    const gap = await readNow(id, from(byteAt(s(30)), byteAt(s(30)) + 99));
    expect(gap.ok && gap.bytes.every((byte) => byte === 0)).toBe(true);
    expect(reads).toEqual([]);
    // The end, as a suffix.
    const tail = await readNow(id, { kind: "suffix", length: 10 });
    expect(tail).toMatchObject({ ok: true, start: total - 10, end: total - 1 });
  });

  it("answers an unknown episode, a stale generation and an unsatisfiable range without reading", async () => {
    const id = episode([[10, 20]]);
    const total = byteAt(s(12.3));
    expect(media.playback(999)).toBeNull();
    expect(await readNow(999, from(0))).toEqual({ ok: false, reason: "not-found", total: null });
    expect(await readNow(id, from(total))).toEqual({ ok: false, reason: "unsatisfiable", total });
    expect(await readNow(id, { kind: "suffix", length: 0 })).toMatchObject({
      reason: "unsatisfiable",
    });
    bumpInputGeneration(db, id);
    expect(await readNow(id, from(0))).toEqual({ ok: false, reason: "stale", total: null });
    expect(media.playback(id)?.generation).toBe(2);
    expect(await readNow(id, from(0), 2)).toMatchObject({ ok: true });
    expect(
      reads.every((range) => range.sampleEnd - range.sampleStart <= MEDIA_SLICE_BYTES / 2),
    ).toBe(true);
  });

  it("stops serving an episode deleted between two ranges, without reading its audio again", async () => {
    const id = episode([[10, 60]]);
    const first = await readNow(id, from(0));
    expect(first.ok).toBe(true);
    // Queued before the deletion, read after it.
    const { reply } = read(id, from(MEDIA_SLICE_BYTES));
    deleteEpisode(db, id, { origin: "app", checkpoint: false });
    reads.length = 0;
    step();
    expect(await reply).toEqual({ ok: false, reason: "not-found", total: null });
    expect(reads).toEqual([]);
    expect(media.playback(id)).toBeNull();
  });

  it("silences audio a later deletion covers without moving the rest, and never reads it", async () => {
    const id = episode([[10, 60]]);
    const before = await readNow(id, from(0));
    if (!before.ok) throw new Error("expected bytes");
    // Another deletion (a neighbour's, a "forget the last minutes") covers 30-32 s.
    db.statement(
      `INSERT INTO deleted_ranges (scope, track_run_id, sample_start, sample_end, wall_start_ms,
         wall_end_ms, origin, created_at_ms)
       VALUES ('track_run', ?, ?, ?, ?, ?, 'app', ?)`,
    ).run(run.id, s(30), s(32), T0 + 30_000, T0 + 32_000, T0);
    reads.length = 0;
    const at = byteAt(s(29 - 8.5));
    const after = await readNow(id, from(at, at + byteAt(s(4)) - WAV_HEADER_BYTES - 1));
    if (!after.ok) throw new Error("expected bytes");
    expect(after.total).toBe(before.total);
    const samples = new Int16Array(after.bytes.buffer);
    expect(samples.subarray(0, s(1))).toEqual(run.expected(s(29), s(30)));
    expect(samples.subarray(s(1), s(3)).every((sample) => sample === 0)).toBe(true);
    expect(samples.subarray(s(3))).toEqual(run.expected(s(32), s(33)));
    expect(reads.length).toBeGreaterThan(0);
    for (const range of reads) {
      expect(range.sampleEnd <= s(30) || range.sampleStart >= s(32)).toBe(true);
    }
  });

  it("caps the reads waiting, and skips a cancelled one", async () => {
    // 102.3 s of timeline: four slices.
    const id = episode([[10, 110]]);
    const queued = Array.from({ length: MAX_MEDIA_JOBS }, (_, index) =>
      read(id, from(index * MEDIA_SLICE_BYTES)),
    );
    expect(await read(id, from(0)).reply).toEqual({ ok: false, reason: "busy", total: null });
    const [, dropped] = queued;
    if (dropped === undefined) throw new Error("expected a queued read");
    media.cancel(dropped.request.requestId);
    expect(await dropped.reply).toEqual({ ok: false, reason: "cancelled", total: null });
    // A cancelled read is not answered at all; the window already gave up.
    expect(mediaReplyMessage(dropped.request.requestId, await dropped.reply)).toBeNull();
    step();
    const replies = await Promise.all(queued.map((entry) => entry.reply));
    expect(replies.map((reply) => (reply.ok ? reply.start : reply.reason))).toEqual([
      0,
      "cancelled",
      2 * MEDIA_SLICE_BYTES,
      3 * MEDIA_SLICE_BYTES,
    ]);
    // The cancelled slice's samples never reached the reader.
    const skippedFrom = s(8.5) + Math.ceil((MEDIA_SLICE_BYTES - WAV_HEADER_BYTES) / 2);
    const skippedTo = s(8.5) + Math.floor((2 * MEDIA_SLICE_BYTES - WAV_HEADER_BYTES) / 2);
    expect(reads.length).toBe(3);
    expect(
      reads.some((range) => range.sampleStart >= skippedFrom && range.sampleStart < skippedTo),
    ).toBe(false);
    // Room again once they ran.
    expect((await readNow(id, from(0))).ok).toBe(true);
    media.close();
    expect(await read(id, from(0)).reply).toMatchObject({ reason: "unavailable" });
  });

  it("refuses the reads still waiting when core closes", async () => {
    const id = episode([[10, 20]]);
    const { reply } = read(id, from(0));
    media.close();
    expect(await reply).toEqual({ ok: false, reason: "unavailable", total: null });
  });

  it("answers main with one bounded slice, or a failure with the WAV's length", async () => {
    const id = episode([[10, 60]]);
    const reply = await readNow(id, from(5));
    const message = mediaReplyMessage(7, reply);
    expect(message).toMatchObject({ type: "media-bytes", requestId: 7, start: 5 });
    if (message?.type !== "media-bytes") return;
    expect(message.bytes.byteLength).toBe(MEDIA_SLICE_BYTES);
    // A structured clone copies the whole buffer: the slice owns exactly its bytes.
    expect(message.bytes.buffer.byteLength).toBe(MEDIA_SLICE_BYTES);
    const failed = mediaReplyMessage(8, { ok: false, reason: "unsatisfiable", total: 99 });
    expect(failed).toEqual({
      type: "media-failed",
      requestId: 8,
      reason: "unsatisfiable",
      total: 99,
    });
  });
});
