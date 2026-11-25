import { ownsStretch, stretchCaptured } from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Boot, scalar, tempDb, type Run, type TempDb } from "../../../test/capture-fixture";
import { runEpisodePass } from "../episodes/episode-pass";

// What a dictation app's text may stand for (ADR 020): only what this episode heard.

const RATE = 16_000;
let temp: TempDb;
let boot: Boot;
let mic: Run;
let episodeId: number;

beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, Date.UTC(2026, 10, 5, 8, 0, 0));
  mic = boot.run({ startSec: 0 });
  // Captured for 120 s, but for 30 s to 40 s: a pause.
  boot.chunks(mic, 0, 30);
  boot.chunks(mic, 40, 120);
  boot.region(mic, 10, 20);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(120), fullScan: true });
  episodeId = Number(scalar(temp.db, "SELECT id FROM episodes"));
});
afterEach(() => temp.cleanup());

const owns = (fromSec: number, toSec: number) =>
  ownsStretch(temp.db, episodeId, {
    trackRunId: mic.trackRunId,
    sampleStart: fromSec * RATE,
    sampleEnd: toSec * RATE,
  });

describe("a stretch an episode may tell", () => {
  it("is all captured, its silences too", () => {
    expect(owns(8, 22)).toBe(true);
    expect(owns(8, 31)).toBe(false);
    expect(owns(8, 45)).toBe(false);
    expect(owns(-1, 20)).toBe(false);
    expect(owns(110, 125)).toBe(false);
    expect(owns(20, 20)).toBe(false);
  });

  it("is watched through other people's speech, not through a pause", () => {
    boot.region(mic, 24, 26);
    const captured = (toSec: number) =>
      stretchCaptured(temp.db, {
        trackRunId: mic.trackRunId,
        sampleStart: 10 * RATE,
        sampleEnd: toSec * RATE,
      });
    expect(captured(28)).toBe(true);
    expect(captured(32)).toBe(false);
  });

  it("holds no speech of another episode, nor of none", () => {
    boot.region(mic, 24, 26);
    expect(owns(8, 23)).toBe(true);
    expect(owns(8, 25)).toBe(false);
  });

  it("stops where the episode was cut, inside one stretch of speech", () => {
    temp.db
      .statement("UPDATE episode_regions SET slice_sample_start = ?, slice_sample_end = ?")
      .run(10 * RATE, 15 * RATE);
    expect(owns(10, 15)).toBe(true);
    expect(owns(10, 18)).toBe(false);
  });

  it("holds nothing the user deleted or corrected", () => {
    const run = temp.db.statement(
      `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin, created_at_ms)
       VALUES ('transcript_edit', ?, ?, ?, '{"text":"a","original":"b"}', 'app', 1)`,
    );
    run.run(mic.trackRunId, 12 * RATE, 13 * RATE);
    expect(owns(10, 20)).toBe(false);
    temp.db.statement("UPDATE user_assertions SET revoked_at_ms = 2").run();
    expect(owns(10, 20)).toBe(true);
    temp.db
      .statement(
        `INSERT INTO deleted_ranges (scope, wall_start_ms, wall_end_ms, origin, created_at_ms)
         VALUES ('all', ?, ?, 'app', 1)`,
      )
      .run(boot.wallMs(18), boot.wallMs(19));
    expect(owns(10, 20)).toBe(false);
  });
});
