import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteEpisode, importRecording, phoneArrival } from "@sondine/db";
import { parsePhoneRecordingHeader } from "@sondine/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scalar, tempDb, type TempDb } from "../../../test/capture-fixture";
import { createTrackAudioReader } from "../audio/read-track-audio";
import { IMPORT_SAMPLE_RATE } from "./decode";
import {
  answerForArrival,
  prepareImport,
  publishImport,
  readPhoneFile,
  type ImportPaths,
  type PhoneFile,
  type PreparedImport,
} from "./import-audio";

// The cross-language test (ADR 032): the Swift writer the iPhone app uses
// (`sondine-phone-fixture`, SondinePhone's AssetPartWriter) writes a
// fragmented m4a with Sondine's header and is killed mid-write; this import
// reads it. The files are made here, never committed. `pnpm test:native`
// builds the writer and runs this file with SONDINE_PHONE_FIXTURE set; plain
// `pnpm test` skips it.

const fixture = process.env["SONDINE_PHONE_FIXTURE"];

let temp: TempDb;
let dataDir: string;
let paths: ImportPaths;
beforeEach(() => {
  temp = tempDb();
  dataDir = mkdtempSync(join(tmpdir(), "sondine-phone-file-"));
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

/** Runs the Swift writer; the header it printed. */
function write(file: string, args: readonly string[]): string {
  const run = spawnSync(fixture ?? "", ["--out", file, ...args], { encoding: "utf8" });
  if (run.error !== undefined) throw run.error;
  const killed = args.includes("--kill-after");
  expect(run.signal).toBe(killed ? "SIGKILL" : null);
  if (!killed) expect(run.status).toBe(0);
  return run.stdout.trim();
}

/** What the import's layer answers before decoding: null to import it. */
const answer = (phone: PhoneFile) =>
  answerForArrival(
    phoneArrival(temp.db, { recordingId: phone.header.recordingId, sha256: phone.sha256 }),
  );

/** What the import's layer does with a phone file once it is new. */
async function importPhone(file: string, phone: PhoneFile, nowMs: number) {
  const prepared: PreparedImport = await prepareImport(file, paths, nowMs, phone.header);
  return {
    prepared,
    ...publishImport(prepared, () =>
      importRecording(temp.db, {
        uid: prepared.uid,
        fileName: prepared.fileName,
        sampleRate: IMPORT_SAMPLE_RATE,
        sampleCount: prepared.sampleCount,
        startedWallMs: prepared.startedWallMs,
        archiveRelPath: prepared.archiveRelPath,
        spoolRelPath: prepared.spoolRelPath,
        chunks: prepared.chunks,
        nowMs,
        phone: {
          recordingId: phone.header.recordingId,
          deviceId: phone.header.deviceId,
          sha256: phone.sha256,
          timeUncertain: prepared.timeUncertain,
        },
      }),
    ),
  };
}

describe.skipIf(fixture === undefined)(
  "a file the iPhone app's writer made, read by the Mac's import",
  () => {
    it("has the writer it was given", () => {
      expect(existsSync(fixture ?? "")).toBe(true);
    });

    it("is a phone recording up to its last seconds after a kill, at the hour it was made", async () => {
      const id = "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f";
      const startedMs = Date.now() - 3_600_000;
      const file = join(dataDir, "Enregistrement 14-32.m4a");
      const printed = write(file, [
        "--seconds",
        "60",
        "--kill-after",
        "21",
        "--recording-id",
        id,
        "--started-ms",
        String(startedMs),
      ]);
      const phone = await readPhoneFile(file);
      expect(phone?.header).toEqual(parsePhoneRecordingHeader(printed));
      expect(phone?.header).toMatchObject({ recordingId: id, startedWallMs: startedMs, part: 1 });
      expect(phone?.sha256).toBe(
        execFileSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" }).split(" ")[0],
      );
      if (phone === null) return;
      expect(answer(phone)).toBeNull();

      const { prepared, episodeId, trackRunId } = await importPhone(file, phone, Date.now());
      // Killed after 21 s: the last fragment (2 s) may be lost, nothing more.
      const seconds = prepared.sampleCount / IMPORT_SAMPLE_RATE;
      expect(seconds).toBeGreaterThanOrEqual(18.5);
      expect(seconds).toBeLessThanOrEqual(21);
      expect(prepared.startedWallMs).toBe(startedMs);
      expect(prepared.timeUncertain).toBe(false);
      expect(
        temp.db.client
          .prepare("SELECT context, started_at_ms FROM episodes WHERE id = ?")
          .get(episodeId),
      ).toEqual({ context: "in_person", started_at_ms: startedMs });

      // The tone the writer wrote, at a quarter of full scale (RMS 5657), decoded losslessly.
      const audio = createTrackAudioReader(
        temp.db,
        dataDir,
      )({ trackRunId, sampleStart: 0, sampleEnd: prepared.sampleCount });
      expect(audio.missing).toEqual([]);
      const rms = Math.sqrt(
        audio.samples.reduce((sum, sample) => sum + sample * sample, 0) / audio.samples.length,
      );
      expect(rms).toBeGreaterThan(5_600);
      expect(rms).toBeLessThan(5_700);

      // The same file again: one recording.
      const again = await readPhoneFile(file);
      if (again === null) throw new Error("no header");
      expect(answer(again)).toEqual({
        outcome: "already",
        episodeId,
      });
      // The same id with other bytes: refused.
      const other = join(dataDir, "other.m4a");
      write(other, ["--seconds", "4", "--recording-id", id, "--hertz", "880"]);
      const conflicting = await readPhoneFile(other);
      if (conflicting === null) throw new Error("no header");
      expect(answer(conflicting)).toEqual({
        outcome: "failed",
        problem: "conflict",
      });
      // Deleted here, then sent again: refused, so it never comes back.
      deleteEpisode(temp.db, episodeId, { origin: "app" });
      expect(answer(again)).toEqual({
        outcome: "failed",
        problem: "deleted",
      });
      expect(scalar(temp.db, "SELECT count(*) FROM episodes")).toBe(0);
    });

    it("ends when it arrived when the phone's clock is not plausible", async () => {
      const file = join(dataDir, "future.m4a");
      const nowMs = Date.now();
      write(file, ["--seconds", "5", "--codec", "aac", "--started-ms", String(nowMs + 86_400_000)]);
      const phone = await readPhoneFile(file);
      if (phone === null) throw new Error("no header");
      const { prepared } = await importPhone(file, phone, nowMs);
      expect(prepared.timeUncertain).toBe(true);
      expect(prepared.startedWallMs).toBe(nowMs - 5_000);
      expect(scalar(temp.db, "SELECT time_uncertain FROM phone_recordings")).toBe(1);
    });

    it("leaves a file without the header an ordinary import", async () => {
      const recorded = join(dataDir, "recorded.m4a");
      write(recorded, ["--seconds", "2"]);
      // Converted by another app: the audio stays, the comment tag does not.
      const file = join(dataDir, "plain.wav");
      execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", recorded, file]);
      expect(await readPhoneFile(file)).toBeNull();
    });
  },
);
