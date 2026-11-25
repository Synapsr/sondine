import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRecording, type ImportedChunk } from "./audio-import";
import { loadEpisodeSummaries } from "./episodes-store";
import { nameSpeaker } from "./people";
import { phoneNotes } from "./phone-notes";
import { publishAnalysis } from "./publish";
import { rate, segment, startRun, t0, tempDatabase, turn, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;
let uid = 0;

function blocks(seconds: number): ImportedChunk[] {
  const out: ImportedChunk[] = [];
  for (let start = 0; start < seconds * rate; start += 2 * rate) {
    const sampleCount = Math.min(2 * rate, seconds * rate - start);
    out.push({ sampleStart: start, sampleCount, byteOffset: start * 2, crc32: 0 });
  }
  return out;
}

/** A recording, by the phone or an ordinary import, transcribed with these voices. */
function recorded(phone: boolean, voices: readonly string[]): { episodeId: number; runId: number } {
  uid += 1;
  const { episodeId, trackRunId } = importRecording(temp.db, {
    uid: `import-${uid}`,
    fileName: `file-${uid}.m4a`,
    sampleRate: rate,
    sampleCount: 60 * rate,
    startedWallMs: t0,
    archiveRelPath: `archive/imports/import-${uid}/0001.pcm`,
    spoolRelPath: `spool/imports/import-${uid}/0001.pcm`,
    chunks: blocks(60),
    nowMs: s(3_600),
    ...(phone
      ? {
          phone: {
            recordingId: `0a1b2c3d-4e5f-4a6b-8c7d-${String(uid).padStart(12, "0")}`,
            deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
            sha256: String(uid).padStart(64, "0"),
            timeUncertain: false,
          },
        }
      : {}),
  });
  const runId = startRun(temp.db, episodeId, "asr");
  publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: voices.map((voice, index) =>
      segment(trackRunId, 10 + index * 10, 15 + index * 10, `phrase ${index}`, voice),
    ),
    turns: voices.map((voice, index) => turn(trackRunId, 10 + index * 10, 15 + index * 10, voice)),
  });
  return { episodeId, runId };
}

const isNote = (episodeId: number) =>
  phoneNotes(temp.db, [...loadEpisodeSummaries(temp.db, [episodeId]).values()]).has(episodeId);

const label = (runId: number, voice: string) =>
  String(
    temp.db.client
      .prepare("SELECT speaker_label FROM segments WHERE run_id = ? AND speaker_label LIKE ?")
      .get(runId, `%${voice}`)?.["speaker_label"],
  );

describe("a phone note (ADR 039)", () => {
  it("reads « Note » once its only voice is named as the user", () => {
    const { episodeId, runId } = recorded(true, ["A", "A"]);
    expect(isNote(episodeId)).toBe(false);
    nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: label(runId, "A"),
      person: { kind: "self", name: "Moi" },
      nowMs: s(4_000),
    });
    expect(isNote(episodeId)).toBe(true);
  });

  it("is not a note with someone else, or as an ordinary import", () => {
    const two = recorded(true, ["A", "B"]);
    nameSpeaker(temp.db, {
      episodeId: two.episodeId,
      runId: two.runId,
      label: label(two.runId, "A"),
      person: { kind: "self", name: "Moi" },
      nowMs: s(4_000),
    });
    expect(isNote(two.episodeId)).toBe(false);
    const file = recorded(false, ["A"]);
    nameSpeaker(temp.db, {
      episodeId: file.episodeId,
      runId: file.runId,
      label: label(file.runId, "A"),
      person: { kind: "self", name: "Moi" },
      nowMs: s(4_000),
    });
    expect(isNote(file.episodeId)).toBe(false);
  });
});
