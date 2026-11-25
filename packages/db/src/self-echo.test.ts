import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSpeechRegion, openSpeechRegion } from "./capture-import";
import {
  loadSelfEchoes,
  recordSelfEcho,
  regionsToJudge,
  selfEchoOf,
  selfEchoStretches,
  type SelfEchoJudgement,
} from "./self-echo";
import { notePlaying, noteStopped } from "./self-playback";
import { at, seedTrackRun, t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

/** A closed region of `run` over [start, end] seconds, with continuous times. */
function region(run: number, start: number, end: number, continuous = true): number {
  const opened = openSpeechRegion(temp.db, {
    trackRunId: run,
    sampleStart: at(start),
    wallStartMs: t0 + start * 1000,
    vadVersion: "silero-6.2",
    ...(continuous ? { continuousStartUs: 5_000_000 + start * 1e6 } : {}),
  });
  if (opened.speechRegionId === null) throw new Error("region refused");
  closeSpeechRegion(temp.db, {
    trackRunId: run,
    sampleStart: at(start),
    sampleEnd: at(end),
    wallEndMs: t0 + end * 1000,
    endReason: "silence",
    ...(continuous ? { continuousEndUs: 5_000_000 + end * 1e6 } : {}),
  });
  return opened.speechRegionId;
}

const judged = (regionId: number, over: Partial<SelfEchoJudgement> = {}): SelfEchoJudgement => ({
  regionId,
  method: "envelope-echo/1",
  kind: "near-end",
  voicedMs: 4_000,
  coveredMs: 4_000,
  echoMs: 1_500,
  nearEndMs: 2_500,
  lagMs: 120,
  correlation: 0.81,
  spans: [[at(10), at(11.5)]],
  judgedAtMs: t0 + 60_000,
  ...over,
});

describe("self echoes", () => {
  it("offers the mic regions heard during a playback on the speakers, until judged", () => {
    const run = seedTrackRun(temp.db);
    for (let ms = 9_000; ms < 30_000; ms += 3_000) {
      notePlaying(temp.db, { route: "speakers", nowMs: t0 + ms });
    }
    noteStopped(temp.db, t0 + 30_000);
    notePlaying(temp.db, { route: "headphones", nowMs: t0 + 40_000 });
    noteStopped(temp.db, t0 + 60_000);
    const during = region(run, 10, 14);
    region(run, 2, 4); // before
    region(run, 45, 50); // through headphones
    region(run, 20, 24, false); // no continuous times: ADR 020's rule
    const offered = regionsToJudge(temp.db, t0);
    expect(offered.map((r) => r.id)).toEqual([during]);
    expect(offered[0]).toMatchObject({
      sampleStart: at(10),
      sampleEnd: at(14),
      continuousStartUs: 15_000_000,
      continuousEndUs: 19_000_000,
      playbackEndedWallMs: t0 + 30_000,
      sampleRate: 16_000,
    });
    // Only what ended since the reference may still hold it.
    expect(regionsToJudge(temp.db, t0 + 15_000)).toEqual([]);

    recordSelfEcho(temp.db, judged(during));
    expect(regionsToJudge(temp.db, t0)).toEqual([]);
    expect(loadSelfEchoes(temp.db, [during, 999])).toEqual(new Map([[during, "near-end"]]));
    expect(selfEchoOf(temp.db, during)).toEqual(judged(during));
  });

  it("gives the echo stretches of the regions someone spoke in, and only those", () => {
    const run = seedTrackRun(temp.db);
    const other = seedTrackRun(temp.db);
    const spoke = region(run, 10, 14);
    const echo = region(run, 20, 24);
    const elsewhere = region(other, 10, 14);
    recordSelfEcho(
      temp.db,
      judged(spoke, {
        spans: [
          [at(12), at(13)],
          [at(10), at(11)],
        ],
      }),
    );
    recordSelfEcho(temp.db, judged(echo, { kind: "echo", spans: [] }));
    recordSelfEcho(temp.db, judged(elsewhere));
    expect(selfEchoStretches(temp.db, [run])).toEqual([
      { trackRunId: run, sampleStart: at(10), sampleEnd: at(11) },
      { trackRunId: run, sampleStart: at(12), sampleEnd: at(13) },
    ]);
    expect(selfEchoStretches(temp.db, [])).toEqual([]);
  });

  it("goes with its region, and refuses a verdict it does not know", () => {
    const run = seedTrackRun(temp.db);
    const id = region(run, 10, 14);
    recordSelfEcho(temp.db, judged(id, { kind: "echo", spans: [] }));
    expect(() => temp.db.client.prepare("UPDATE self_echoes SET verdict = 'maybe'").run()).toThrow(
      /CHECK/,
    );
    temp.db.client.prepare("DELETE FROM speech_regions WHERE id = ?").run(id);
    expect(loadSelfEchoes(temp.db, [id]).size).toBe(0);
  });
});
