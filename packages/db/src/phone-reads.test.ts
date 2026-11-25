import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRecording } from "./audio-import";
import { deleteEpisode } from "./delete-episode";
import { phoneRecordingEpisode } from "./phone-devices";
import { phoneRecordingsOfEpisodes } from "./phone-reads";
import { tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const PHONE = "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b";
const OTHER = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const MINE = "11111111-2222-4333-8444-555555555555";
const THEIRS = "66666666-7777-4888-8999-aaaaaaaaaaaa";

function received(recordingId: string, deviceId: string, startedWallMs: number) {
  importRecording(temp.db, {
    uid: `run-${recordingId}`,
    fileName: "a.m4a",
    sampleRate: 16_000,
    sampleCount: 32_000,
    startedWallMs,
    archiveRelPath: `archive/imports/${recordingId}/0001.pcm`,
    spoolRelPath: `spool/imports/${recordingId}/0001.pcm`,
    chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 7 }],
    nowMs: startedWallMs + 5_000,
    phone: { recordingId, deviceId, sha256: "a".repeat(64), timeUncertain: false },
  });
  const episodeId = phoneRecordingEpisode(temp.db, recordingId);
  if (episodeId === null) throw new Error("not stored");
  return episodeId;
}

describe("phone recordings of episodes", () => {
  it("names each episode's recording and its phone, and forgets a deleted one", () => {
    const mine = received(MINE, PHONE, 1_000);
    const theirs = received(THEIRS, OTHER, 100_000);
    expect(phoneRecordingsOfEpisodes(temp.db, [])).toEqual(new Map());
    expect(phoneRecordingsOfEpisodes(temp.db, [mine, theirs, 9_999])).toEqual(
      new Map([
        [mine, { recordingId: MINE, deviceId: PHONE }],
        [theirs, { recordingId: THEIRS, deviceId: OTHER }],
      ]),
    );
    expect(deleteEpisode(temp.db, theirs, { origin: "app" }).deleted).toBe(true);
    expect([...phoneRecordingsOfEpisodes(temp.db, [mine, theirs]).keys()]).toEqual([mine]);
  });
});
