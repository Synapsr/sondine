import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetRange,
  importRecording,
  listImports,
  loadAnalysisInput,
  mergeEpisodes,
  setEpisodeKind,
  splitEpisode,
} from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rows, scalar, tempDb, type TempDb } from "../../../test/capture-fixture";
import { createTrackAudioReader } from "../audio/read-track-audio";
import { IMPORT_SAMPLE_RATE } from "./decode";
import {
  answerForArrival,
  discardImport,
  ImportFailure,
  parseAfinfo,
  parseAfinfoComment,
  phoneStartOf,
  prepareImport,
  publishImport,
  startOf,
  type ImportPaths,
  type PreparedImport,
} from "./import-audio";

let temp: TempDb;
let dataDir: string;
let paths: ImportPaths;
beforeEach(() => {
  temp = tempDb();
  dataDir = mkdtempSync(join(tmpdir(), "sondine-import-"));
  paths = {
    dataDir,
    spoolDir: "spool",
    archiveDir: "archive",
    stagingDir: join(dataDir, "import-staging"),
  };
});
afterEach(() => {
  temp.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A 16-bit stereo WAV: left 1000, right 3000, `seconds` long. */
function stereoWav(path: string, seconds: number): void {
  const frames = seconds * IMPORT_SAMPLE_RATE;
  const data = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame += 1) {
    data.writeInt16LE(1_000, frame * 4);
    data.writeInt16LE(3_000, frame * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(IMPORT_SAMPLE_RATE, 24);
  header.writeUInt32LE(IMPORT_SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

function store(prepared: PreparedImport) {
  return publishImport(prepared, () =>
    importRecording(temp.db, {
      uid: prepared.uid,
      fileName: prepared.fileName,
      sampleRate: IMPORT_SAMPLE_RATE,
      sampleCount: prepared.sampleCount,
      startedWallMs: prepared.startedWallMs,
      archiveRelPath: prepared.archiveRelPath,
      spoolRelPath: prepared.spoolRelPath,
      chunks: prepared.chunks,
      nowMs: Date.now(),
    }),
  );
}

describe("importing an audio file", () => {
  it("keeps the file as archived mono audio, one closed episode queued as a request", async () => {
    const file = join(dataDir, "réunion.wav");
    stereoWav(file, 5);
    const prepared = await prepareImport(file, paths, Date.now());
    expect(prepared.chunks.map((chunk) => chunk.sampleCount)).toEqual([32_000, 32_000, 16_000]);
    const { episodeId, trackRunId } = store(prepared);
    expect(existsSync(prepared.finalPath)).toBe(true);
    expect(readdirSync(paths.stagingDir)).toEqual([]);

    const audio = createTrackAudioReader(
      temp.db,
      dataDir,
    )({
      trackRunId,
      sampleStart: 0,
      sampleEnd: 5 * IMPORT_SAMPLE_RATE,
    });
    expect(audio.missing).toEqual([]);
    expect(audio.samples.every((sample) => sample === 2_000)).toBe(true);

    expect(rows(temp.db, "SELECT context, state, label FROM episodes")).toEqual([
      { context: "imported", state: "closed", label: "réunion.wav" },
    ]);
    expect(rows(temp.db, "SELECT priority, state FROM jobs")).toEqual([
      { priority: 10, state: "queued" },
    ]);
    const input = loadAnalysisInput(temp.db, episodeId);
    expect(input?.regions).toHaveLength(1);
    expect(listImports(temp.db, { limit: 10 }).imports).toMatchObject([
      { episodeId, fileName: "réunion.wav" },
    ]);
  });

  it("is left alone by a forget, and kept whole: no split, merge or kind change", async () => {
    const file = join(dataDir, "notes.wav");
    stereoWav(file, 4);
    const prepared = await prepareImport(file, paths, Date.now());
    const { episodeId, trackRunId } = store(prepared);
    const start = prepared.startedWallMs;
    forgetRange(temp.db, { fromWallMs: start - 60_000, toWallMs: start + 60_000, origin: "app" });
    expect(scalar(temp.db, "SELECT count(*) FROM episodes")).toBe(1);
    expect(scalar(temp.db, "SELECT count(*) FROM chunks WHERE audio_state = 'archived'")).toBe(2);
    // The forget's tombstone takes nothing out of what is analysed or played.
    expect(loadAnalysisInput(temp.db, episodeId)?.deleted.get(trackRunId) ?? []).toEqual([]);
    expect(splitEpisode(temp.db, { episodeId, atMs: start + 2_000, nowMs: Date.now() })).toEqual({
      ok: false,
      reason: "kept-whole",
    });
    expect(
      mergeEpisodes(temp.db, { episodeId, otherId: episodeId + 1, nowMs: Date.now() }),
    ).toMatchObject({ ok: false });
    expect(setEpisodeKind(temp.db, { episodeId, kind: "moment", nowMs: Date.now() })).toBe(false);
  });

  it("refuses what it cannot read and leaves nothing behind", async () => {
    const file = join(dataDir, "notes.txt");
    writeFileSync(file, "pas de l'audio");
    await expect(prepareImport(file, paths, Date.now())).rejects.toBeInstanceOf(ImportFailure);
    expect(readdirSync(paths.stagingDir)).toEqual([]);
    expect(existsSync(join(dataDir, "archive"))).toBe(false);
  });

  it("takes its file back when its rows cannot be written", async () => {
    const file = join(dataDir, "a.wav");
    stereoWav(file, 1);
    const prepared = await prepareImport(file, paths, Date.now());
    expect(() =>
      publishImport(prepared, () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(existsSync(prepared.finalPath)).toBe(false);
    discardImport(prepared);
  });

  it("dates a recording from its file, when that is plausible", async () => {
    const now = Date.UTC(2026, 10, 8, 15, 0, 0);
    expect(startOf(now - 60_000, 30_000, now)).toBe(now - 90_000);
    // A file changed in the future, or before 2000: it ends now.
    expect(startOf(now + 60_000, 30_000, now)).toBe(now - 30_000);
    expect(startOf(Date.UTC(1999, 0, 1), 30_000, now)).toBe(now - 30_000);
    // A file time's fraction of a millisecond is dropped.
    expect(startOf(now - 60_000 + 0.97, 30_000, now)).toBe(now - 90_000);
    const file = join(dataDir, "b.wav");
    stereoWav(file, 2);
    const modified = new Date(Date.now() - 3_600_000);
    utimesSync(file, modified, modified);
    const prepared = await prepareImport(file, paths, Date.now());
    expect(prepared.startedWallMs).toBe(modified.getTime() - 2_000);
    expect(Number.isInteger(prepared.startedWallMs)).toBe(true);
  });

  it("reads afinfo's length and channels", () => {
    expect(
      parseAfinfo("x.m4a, m4af, Num Tracks: 1\n----\n12.5 sec, format:   2 ch,  44100 Hz"),
    ).toEqual({
      seconds: 12.5,
      channels: 2,
    });
    expect(parseAfinfo("garbage")).toBeNull();
  });

  it("reads the comment tag afinfo -i prints, or none", () => {
    const header = '{"sondine":"phone-recording","v":1}';
    expect(
      parseAfinfoComment(
        `File:           a.m4a\nNum Tracks:     1\n----\ninfo dictionary:\n    approximate duration in seconds  : "12.032"\n    comments                         : "${header}"\n\n----\n`,
      ),
    ).toBe(header);
    expect(parseAfinfoComment("File: a.wav\nNum Tracks: 1\n")).toBeNull();
  });

  it("dates a phone recording from its header, unless that is not plausible", () => {
    const received = Date.UTC(2026, 10, 11, 15, 0, 0);
    const hour = 3_600_000;
    expect(phoneStartOf(received - 2 * hour, hour, received)).toEqual({
      startedWallMs: received - 2 * hour,
      uncertain: false,
    });
    // A phone clock a little ahead is tolerated, 5 minutes at most.
    expect(phoneStartOf(received - hour + 4 * 60_000, hour, received).uncertain).toBe(false);
    expect(phoneStartOf(received - hour + 6 * 60_000, hour, received)).toEqual({
      startedWallMs: received - hour,
      uncertain: true,
    });
    // Before the app existed: a phone whose clock was reset.
    expect(phoneStartOf(Date.UTC(2001, 0, 1), hour, received)).toEqual({
      startedWallMs: received - hour,
      uncertain: true,
    });
  });

  it("answers a phone recording already known without decoding it", () => {
    expect(answerForArrival({ kind: "new" })).toBeNull();
    expect(answerForArrival({ kind: "duplicate", episodeId: 4 })).toEqual({
      outcome: "already",
      episodeId: 4,
    });
    expect(answerForArrival({ kind: "conflict" })).toEqual({
      outcome: "failed",
      problem: "conflict",
    });
    expect(answerForArrival({ kind: "deleted" })).toEqual({
      outcome: "failed",
      problem: "deleted",
    });
  });
});
