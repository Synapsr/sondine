import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createEnvelopeDetector } from "@sondine/engines";
import { FAR, hear, NEAR, speechLike, SYNTHETIC_RATE } from "@sondine/engines/synthetic";
import {
  deleteEpisode,
  importRecording,
  openDatabase,
  sameMomentsOf,
  type ImportedChunk,
  type OpenedDatabase,
} from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { crc32 } from "../audio/pcm-io";
import { createTrackAudioReader } from "../audio/read-track-audio";
import { SAME_MOMENT_RETRY_MS, SameMomentWork } from "./same-moment-work";

// The same meeting heard by the Mac and the phone (ADR 032, M5.7), end to
// end in core: synthetic PCM written as the import and the capture keep it,
// read back by the episode's own extents, compared, linked. No audio is
// committed: every sample is made here.

const MAC_START = Date.UTC(2026, 10, 13, 9, 0, 0);
const silent = { info: () => undefined, warn: () => undefined };

let data: TempDataDir;
let db: OpenedDatabase;
let uid = 0;
beforeEach(() => {
  data = tempDataDir();
  db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
});
afterEach(() => {
  db.close();
  data.cleanup();
});

/** Stores `pcm` as a recording: the phone's (its header's id), or the Mac microphone's. */
function store(kind: "phone" | "mac", startedWallMs: number, pcm: Int16Array) {
  uid += 1;
  const relPath = `archive/test/rec-${uid}/0001.pcm`;
  const path = join(data.dir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  writeFileSync(path, bytes);
  const chunks: ImportedChunk[] = [];
  for (let start = 0; start < pcm.length; start += 2 * SYNTHETIC_RATE) {
    const count = Math.min(2 * SYNTHETIC_RATE, pcm.length - start);
    chunks.push({
      sampleStart: start,
      sampleCount: count,
      byteOffset: start * 2,
      crc32: crc32(bytes.subarray(start * 2, (start + count) * 2)),
    });
  }
  const { episodeId, trackRunId } = importRecording(db, {
    uid: `rec-${uid}`,
    fileName: "rec.m4a",
    sampleRate: SYNTHETIC_RATE,
    sampleCount: pcm.length,
    startedWallMs,
    archiveRelPath: relPath,
    spoolRelPath: `spool/test/rec-${uid}/0001.pcm`,
    chunks,
    nowMs: MAC_START + 3_600_000,
    ...(kind === "phone"
      ? {
          phone: {
            recordingId: `7f9c2b1e-4d3a-4c8e-9b6f-${String(uid).padStart(12, "0")}`,
            deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
            sha256: "a".repeat(64),
            timeUncertain: false,
          },
        }
      : {}),
  });
  if (kind === "mac") {
    // The Mac's microphone: what capture stores, under the same chunk rows.
    db.statement("UPDATE track_runs SET source_kind = 'input', track_key = ? WHERE id = ?").run(
      `input:Mic-${uid}`,
      trackRunId,
    );
    db.statement("UPDATE episodes SET context = 'in_person', label = NULL WHERE id = ?").run(
      episodeId,
    );
  }
  return { episodeId, path };
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const minutes = (n: number) => Math.round(n * 60 * SYNTHETIC_RATE);

describe("the same meeting on both, in core", () => {
  it("links a phone recording to the Mac's, the offset within 100 ms, both files unchanged", async () => {
    const room = speechLike(101, 6 * 60);
    const phoneFrom = 1;
    const clockAheadMs = 40_000;
    const driftPpm = 30;
    const mac = store("mac", MAC_START, hear(room, 0, minutes(5), { seed: 1, ...NEAR }));
    const phoneStart = MAC_START + phoneFrom * 60_000 + clockAheadMs;
    const phone = store(
      "phone",
      phoneStart,
      hear(room, minutes(phoneFrom), minutes(3), { seed: 2, ...FAR, driftPpm }),
    );
    const before = [sha(mac.path), sha(phone.path)];
    const reader = createTrackAudioReader(db, data.dir);
    const work = new SameMomentWork({
      db,
      reader: () => reader,
      detector: createEnvelopeDetector(),
      log: silent,
    });
    await work.wake();

    const [link] = sameMomentsOf(db, phone.episodeId);
    expect(link).toMatchObject({ otherEpisodeId: mac.episodeId, by: "mac" });
    if (link === undefined) throw new Error("no link");
    // The room sample the phone heard at its anchor, on the Mac's clock.
    const j = ((link.anchorMs - phoneStart) * SYNTHETIC_RATE) / 1000;
    const roomSample = minutes(phoneFrom) + j * (1 + driftPpm / 1e6);
    const truth = MAC_START + (roomSample * 1000) / SYNTHETIC_RATE - link.anchorMs;
    expect(Math.abs(link.offsetMs - truth)).toBeLessThan(100);
    expect(sameMomentsOf(db, mac.episodeId)[0]).toMatchObject({
      otherEpisodeId: phone.episodeId,
      by: "phone",
    });
    expect([sha(mac.path), sha(phone.path)]).toEqual(before);
    // Compared once: nothing waits now.
    expect(await work.compareNext()).toBeNull();

    // Deleting the phone recording removes the link; the Mac's bytes stay as they were.
    deleteEpisode(db, phone.episodeId, { origin: "app", checkpoint: false });
    expect(sameMomentsOf(db, mac.episodeId)).toEqual([]);
    expect(sha(mac.path)).toBe(before[0]);
  });

  it("does not link two rooms recorded at the same hour", async () => {
    const mac = store(
      "mac",
      MAC_START,
      hear(speechLike(201, 300), 0, minutes(5), { seed: 3, ...NEAR }),
    );
    const phone = store(
      "phone",
      MAC_START + 20_000,
      hear(speechLike(202, 300), 0, minutes(4), { seed: 4, ...NEAR }),
    );
    const reader = createTrackAudioReader(db, data.dir);
    const work = new SameMomentWork({
      db,
      reader: () => reader,
      detector: createEnvelopeDetector(),
      log: silent,
    });
    const compared = await work.compareNext();
    expect(compared?.kind === "compared" ? compared.verdict : null).toMatchObject({
      linked: false,
    });
    expect(sameMomentsOf(db, phone.episodeId)).toEqual([]);
    expect(sameMomentsOf(db, mac.episodeId)).toEqual([]);
    expect(
      db
        .statement("SELECT linked FROM same_moment_links")
        .all()
        .map((row) => row["linked"]),
    ).toEqual([0]);
  });

  it("leaves a comparison core's closing stopped to do, and stores nothing", async () => {
    const room = speechLike(401, 4 * 60);
    store("mac", MAC_START, hear(room, 0, minutes(3), { seed: 7, ...NEAR }));
    store("phone", MAC_START, hear(room, 0, minutes(3), { seed: 8, ...FAR }));
    const reader = createTrackAudioReader(db, data.dir);
    const closing = new SameMomentWork({
      db,
      reader: () => reader,
      detector: createEnvelopeDetector(),
      log: silent,
      // Core closes while the first minute is read.
      pause: async () => void closing.close(),
    });
    expect(await closing.compareNext()).toMatchObject({ kind: "cancelled" });
    expect(db.statement("SELECT count(*) AS n FROM same_moment_links").get()).toEqual({ n: 0 });
    // At the next start it is compared.
    const next = new SameMomentWork({
      db,
      reader: () => reader,
      detector: createEnvelopeDetector(),
      log: silent,
    });
    expect(await next.compareNext()).toMatchObject({ kind: "compared", verdict: { linked: true } });
  });

  it("tries a comparison that failed again later, never storing it as no link", async () => {
    const room = speechLike(501, 4 * 60);
    store("mac", MAC_START, hear(room, 0, minutes(3), { seed: 9, ...NEAR }));
    store("phone", MAC_START, hear(room, 0, minutes(3), { seed: 10, ...FAR }));
    const reader = createTrackAudioReader(db, data.dir);
    let nowMs = MAC_START + 3_600_000;
    let broken = true;
    const work = new SameMomentWork({
      db,
      reader: () =>
        broken
          ? () => {
              throw new Error("disk");
            }
          : reader,
      detector: createEnvelopeDetector(),
      log: silent,
      now: () => nowMs,
    });
    expect(await work.compareNext()).toMatchObject({
      kind: "failed",
      retryAtMs: nowMs + SAME_MOMENT_RETRY_MS,
    });
    expect(db.statement("SELECT count(*) AS n FROM same_moment_links").get()).toEqual({ n: 0 });
    // Waiting: nothing to compare until then.
    expect(await work.compareNext()).toBeNull();
    // Failing again waits three times longer.
    nowMs += SAME_MOMENT_RETRY_MS;
    expect(await work.compareNext()).toMatchObject({
      kind: "failed",
      retryAtMs: nowMs + 3 * SAME_MOMENT_RETRY_MS,
    });
    broken = false;
    nowMs += 3 * SAME_MOMENT_RETRY_MS;
    expect(await work.compareNext()).toMatchObject({ kind: "compared", verdict: { linked: true } });
    expect(db.statement("SELECT linked FROM same_moment_links").get()).toEqual({ linked: 1 });
  });
});
