import type { AnalysisInput, AnalysisRegion } from "@sondine/db";
import type { AsrResult, AsrSegment } from "@sondine/engines";
import { describe, expect, it } from "vitest";
import {
  cutTurns,
  deriveTurns,
  echoTracks,
  mapResult,
  MAX_REQUEST_MS,
  planRequests,
  splitRequest,
  type RequestPlan,
} from "./requests";

const RATE = 16_000;
const s = (sec: number) => Math.round(sec * RATE);
const PRE = s(1.5);
const POST = s(0.8);

function region(
  trackRunId: number,
  startSec: number,
  endSec: number,
  options: Partial<AnalysisRegion> = {},
): AnalysisRegion {
  return {
    regionId: trackRunId * 1000 + startSec,
    trackRunId,
    trackKey: "input:mic",
    sourceKind: "input",
    sampleRate: RATE,
    sampleStart: s(startSec),
    sampleEnd: s(endSec),
    sliceStart: s(startSec),
    sliceEnd: null,
    wallStartMs: 1_000_000 + startSec * 1000,
    runStartedWallMs: 1_000_000 + trackRunId,
    runState: "closed",
    runSampleEnd: null,
    ...options,
  };
}

function input(
  regions: readonly AnalysisRegion[],
  deleted: Record<number, [number, number][]> = {},
): AnalysisInput {
  return {
    episodeId: 1,
    state: "closed",
    context: "in_person",
    inputGeneration: 1,
    regions,
    deleted: new Map(Object.entries(deleted).map(([run, ranges]) => [Number(run), ranges])),
  };
}

const extents = (plan: readonly RequestPlan[]) => plan.map((request) => request.extents);

describe("planRequests", () => {
  it("widens regions by roll and merges those closer than the grouping gap", () => {
    const plan = planRequests(input([region(1, 10, 20), region(1, 30, 40), region(1, 100, 110)]));
    expect(extents(plan)).toEqual([
      [
        { trackRunId: 1, sampleStart: s(10) - PRE, sampleEnd: s(40) + POST },
        { trackRunId: 1, sampleStart: s(100) - PRE, sampleEnd: s(110) + POST },
      ],
    ]);
    expect(plan[0]).toMatchObject({ trackKey: "input:mic", index: 1 });
    expect(plan[0]?.samples).toBe(s(30) + PRE + POST + s(10) + PRE + POST);
  });

  it("clamps roll to the run and adds none at a slice cut", () => {
    const plan = planRequests(
      input([
        region(1, 0.5, 10, { runSampleEnd: s(10.2) }),
        region(2, 20, 40, { sliceStart: s(25), sliceEnd: s(35) }),
      ]),
    );
    expect(extents(plan)).toEqual([
      [
        { trackRunId: 1, sampleStart: 0, sampleEnd: s(10.2) },
        { trackRunId: 2, sampleStart: s(25), sampleEnd: s(35) },
      ],
    ]);
  });

  it("cuts at a capture restart and keeps runs in capture order", () => {
    const plan = planRequests(
      input([
        region(2, 1, 3, { runStartedWallMs: 2_000_000 }),
        region(1, 50, 52, { runStartedWallMs: 1_000_000 }),
      ]),
    );
    expect(extents(plan)[0]?.map((extent) => extent.trackRunId)).toEqual([1, 2]);
  });

  it("makes one request per source track", () => {
    const plan = planRequests(
      input([region(1, 10, 20), region(2, 10, 20, { trackKey: "system:other" })]),
    );
    expect(plan.map((request) => [request.trackKey, request.index])).toEqual([
      ["input:mic", 1],
      ["system:other", 1],
    ]);
  });

  it("never sends deleted samples", () => {
    const plan = planRequests(input([region(1, 10, 40)], { 1: [[s(20), s(25)]] }));
    expect(extents(plan)).toEqual([
      [
        { trackRunId: 1, sampleStart: s(10) - PRE, sampleEnd: s(20) },
        { trackRunId: 1, sampleStart: s(25), sampleEnd: s(40) + POST },
      ],
    ]);
    const all = planRequests(input([region(1, 10, 40)], { 1: [[0, s(100)]] }));
    expect(all).toEqual([]);
  });

  it("cuts a long track at its longest silence within 55 min", () => {
    const maxSamples = (MAX_REQUEST_MS / 1000) * RATE;
    // 20 min, 30 s silence, 20 min, 40 s silence, 20 min: one merged extent of 61+ min.
    const longest = planRequests(
      input([region(1, 0, 1200), region(1, 1230, 2430), region(1, 2470, 3670)]),
    );
    expect(longest).toHaveLength(2);
    for (const request of longest) expect(request.samples).toBeLessThanOrEqual(maxSamples);
    expect(longest[0]?.extents.at(-1)?.sampleEnd).toBe(s(2450));
    expect(longest[1]?.extents[0]?.sampleStart).toBe(s(2450));
    expect(longest[1]?.index).toBe(2);

    // The 40 s silence lies past 55 min: the 30 s one is the longest within reach.
    const reach = planRequests(
      input([region(1, 0, 1200), region(1, 1230, 3500), region(1, 3540, 4000)]),
    );
    expect(reach.map((request) => request.extents[0]?.sampleStart)).toEqual([0, s(1215)]);
  });

  it("cuts uninterrupted speech at exactly 55 min", () => {
    const plan = planRequests(input([region(1, 0, 4000)]));
    expect(plan.map((request) => request.samples)).toEqual([
      (MAX_REQUEST_MS / 1000) * RATE,
      s(4000) + POST - (MAX_REQUEST_MS / 1000) * RATE,
    ]);
  });

  it("keeps each request within a shorter engine's limit (Parakeet: 10 min)", () => {
    const plan = planRequests(input([region(1, 0, 1500)]), { maxRequestSeconds: 600 });
    expect(plan.length).toBe(3);
    expect(plan.every((request) => request.samples <= s(600))).toBe(true);
  });
});

describe("splitRequest", () => {
  it("halves a truncated request at the longest silence of its middle half", () => {
    // One extent [0, 440.8 s): silences 100-120 s and 400-420 s lie outside the
    // middle half (110.2 to 330.6 s); 300-305 s is inside.
    const [request] = planRequests(
      input([region(1, 0, 100), region(1, 120, 300), region(1, 305, 400), region(1, 420, 440)]),
    );
    if (request === undefined) throw new Error("no request");
    expect(request.extents).toHaveLength(1);
    const split = splitRequest(request);
    expect(split?.at).toBe(s(302.5));
    const [first, second] = split?.parts ?? [];
    expect(first).toMatchObject({
      name: "1.1",
      index: 1,
      extents: [{ trackRunId: 1, sampleStart: 0, sampleEnd: s(302.5) }],
      samples: s(302.5),
    });
    expect(second).toMatchObject({
      name: "1.2",
      extents: [{ trackRunId: 1, sampleStart: s(302.5), sampleEnd: s(440) + POST }],
    });
    expect(second?.speech.map((span) => span.sampleStart)).toEqual([s(305), s(420)]);
    if (second === undefined) throw new Error("no part");
    // Each half splits again on its own speech, and keeps its name.
    expect(splitRequest(second)?.parts.map((part) => part.name)).toEqual(["1.2.1", "1.2.2"]);
  });

  it("halves uninterrupted speech at its middle, and never makes a part under a minute", () => {
    const [long] = planRequests(input([region(1, 0, 200)]));
    if (long === undefined) throw new Error("no request");
    const split = splitRequest(long);
    expect(split?.parts.map((part) => part.samples)).toEqual([long.samples / 2, long.samples / 2]);
    const [short] = planRequests(input([region(1, 0, 110)]));
    if (short === undefined) throw new Error("no request");
    expect(splitRequest(short)).toBeNull();
  });
});

function result(segments: AsrSegment[]): AsrResult {
  return {
    requestId: "r",
    text: segments.map((segment) => segment.text).join(" "),
    stop: "complete",
    segments,
    languages: ["fr"],
    provenance: {
      engineId: "fake",
      engineVersion: "1",
      runtime: "fake",
      adapterClass: "probe",
      modelSha256: "0",
      config: {},
    },
    metrics: { audioMs: 14_000, computeMs: 100 },
  };
}

describe("mapResult", () => {
  const wallMsAt = (trackRunId: number, sample: number) =>
    trackRunId * 1_000_000 + Math.round((sample * 1000) / RATE);

  // Extent A: run 1 [10 s, 20 s); extent B: run 2 [100 s, 104 s). Request time: A 0-10 s, B 10-14 s.
  const request: RequestPlan = {
    trackKey: "input:mic",
    index: 2,
    name: "2",
    sampleRate: RATE,
    extents: [
      { trackRunId: 1, sampleStart: s(10), sampleEnd: s(20) },
      { trackRunId: 2, sampleStart: s(100), sampleEnd: s(104) },
    ],
    speech: [],
    samples: s(14),
  };

  it("splits a segment at an extent boundary by its tokens", () => {
    const mapped = mapResult(
      request,
      result([
        {
          startSec: 8,
          endSec: 11.5,
          text: " bonjour à tous",
          speaker: 0,
          tokens: [
            { startSec: 8, endSec: 8.6, text: " bonjour" },
            { startSec: 8.7, endSec: 9.2, text: " à" },
            { startSec: 10.2, endSec: 11.5, text: " tous" },
          ],
        },
      ]),
      { wallMsAt },
    );
    expect(mapped).toEqual([
      {
        trackRunId: 1,
        sampleStart: s(18),
        sampleEnd: s(19.2),
        startMs: 1_000_000 + 18_000,
        endMs: 1_000_000 + 19_200,
        text: "bonjour à",
        speakerLabel: "input:mic/2/1",
        lang: "fr",
        words: [
          { charStart: 0, charEnd: 7, startMs: 0, endMs: 600 },
          { charStart: 8, charEnd: 9, startMs: 700, endMs: 1_200 },
        ],
      },
      {
        trackRunId: 2,
        sampleStart: s(100.2),
        sampleEnd: s(101.5),
        startMs: 2_000_000 + 100_200,
        endMs: 2_000_000 + 101_500,
        text: "tous",
        speakerLabel: "input:mic/2/1",
        lang: "fr",
        words: [{ charStart: 0, charEnd: 4, startMs: 0, endMs: 1_300 }],
      },
    ]);
  });

  it("gives a dictation's segments its track's only voice, whatever the request", () => {
    const segment = { startSec: 1, endSec: 2, text: " oui", speaker: null, tokens: [] };
    const labels = (plan: RequestPlan) =>
      mapResult(plan, result([segment]), { wallMsAt, oneVoice: true }).map((s) => s.speakerLabel);
    expect(labels(request)).toEqual(["input:mic/voice/1"]);
    expect(labels({ ...request, name: "2.1" })).toEqual(["input:mic/voice/1"]);
  });

  it("keeps word times inside their segment and drops a token outside it", () => {
    const mapped = mapResult(
      { ...request, name: "2.1" },
      result([
        {
          startSec: 8,
          endSec: 10.9,
          text: " bonjour là oui",
          speaker: 1,
          tokens: [
            { startSec: 8, endSec: 8.6, text: " bonjour" },
            // Placed in A by its middle; its end runs into B.
            { startSec: 9.5, endSec: 10.3, text: " là" },
            { startSec: 10.3, endSec: 10.9, text: " oui" },
          ],
        },
        {
          startSec: 1,
          endSec: 3,
          text: " a b c",
          speaker: 0,
          tokens: [
            { startSec: 1, endSec: 1.5, text: " a" },
            // Out of order: past the piece the first and last tokens span.
            { startSec: 2.6, endSec: 2.9, text: " b" },
            { startSec: 1.6, endSec: 2, text: " c" },
          ],
        },
      ]),
      { wallMsAt },
    );
    expect(mapped).toEqual([
      expect.objectContaining({
        sampleStart: s(11),
        sampleEnd: s(12),
        text: "a c",
        speakerLabel: "input:mic/2.1/1",
        words: [
          { charStart: 0, charEnd: 1, startMs: 0, endMs: 500 },
          { charStart: 2, charEnd: 3, startMs: 600, endMs: 1_000 },
        ],
      }),
      expect.objectContaining({
        trackRunId: 1,
        sampleStart: s(18),
        sampleEnd: s(20),
        text: "bonjour là",
        speakerLabel: "input:mic/2.1/2",
        words: [
          { charStart: 0, charEnd: 7, startMs: 0, endMs: 600 },
          { charStart: 8, charEnd: 10, startMs: 1_500, endMs: 2_000 },
        ],
      }),
      expect.objectContaining({
        trackRunId: 2,
        sampleStart: s(100.3),
        sampleEnd: s(100.9),
        text: "oui",
        words: [{ charStart: 0, charEnd: 3, startMs: 0, endMs: 600 }],
      }),
    ]);
  });

  it("places a segment without tokens by its midpoint and clamps it to its extent", () => {
    const mapped = mapResult(
      request,
      result([{ startSec: 9, endSec: 12, text: " salut", speaker: null, tokens: [] }]),
      { wallMsAt },
    );
    expect(mapped).toEqual([
      expect.objectContaining({
        trackRunId: 2,
        sampleStart: s(100),
        sampleEnd: s(102),
        text: "salut",
        speakerLabel: null,
        words: null,
      }),
    ]);
  });
});

const seg = (start: number, end: number, label: string | null) => ({
  trackRunId: 1,
  sampleStart: s(start),
  sampleEnd: s(end),
  startMs: start * 1000,
  endMs: end * 1000,
  text: "x",
  speakerLabel: label,
});

describe("echoTracks", () => {
  it("tells microphones from the sound the Mac played", () => {
    const plans = planRequests(
      input([
        region(1, 10, 20),
        region(2, 10, 20, { trackKey: "system:other", sourceKind: "system" }),
        region(3, 10, 20, { trackKey: "app:us.zoom.xos", sourceKind: "app" }),
      ]),
    );
    const tracks = echoTracks(plans);
    expect([...tracks.heard]).toEqual([1]);
    expect([...tracks.played].toSorted()).toEqual([2, 3]);
  });
});

describe("cutTurns", () => {
  it("takes echo stretches out of turns, keeping their times in step", () => {
    const turn = {
      trackRunId: 1,
      sampleStart: s(10),
      sampleEnd: s(20),
      startMs: 10_000,
      endMs: 20_000,
      speakerLabel: "input:mic/1/1",
    };
    expect(
      cutTurns(
        [turn, { ...turn, trackRunId: 2 }],
        [
          { trackRunId: 1, sampleStart: s(12), sampleEnd: s(15) },
          { trackRunId: 1, sampleStart: s(18), sampleEnd: s(25) },
        ],
      ).map((part) => [part.trackRunId, part.startMs, part.endMs]),
    ).toEqual([
      [1, 10_000, 12_000],
      [1, 15_000, 18_000],
      [2, 10_000, 20_000],
    ]);
  });
});

describe("deriveTurns", () => {
  it("joins consecutive segments of a speaker and splits on a change or a long pause", () => {
    const turns = deriveTurns(
      [
        seg(0, 2, "a"),
        seg(2.5, 4, "a"),
        seg(4, 6, "b"),
        seg(10, 12, "b"),
        seg(12, 13, null),
        seg(13, 13, "a"),
      ],
      [{ trackRunId: 1, sampleStart: 0, sampleEnd: s(20) }],
    );
    expect(turns.map((turn) => [turn.speakerLabel, turn.startMs, turn.endMs])).toEqual([
      ["a", 0, 4_000],
      ["b", 4_000, 6_000],
      ["b", 10_000, 12_000],
    ]);
  });

  it("never joins across extents, whose gap may be a deleted range", () => {
    // A tombstone over [3.5 s, 4 s): the segments on either side stay two turns.
    const turns = deriveTurns(
      [seg(2, 3.5, "a"), seg(4, 5, "a")],
      [
        { trackRunId: 1, sampleStart: 0, sampleEnd: s(3.5) },
        { trackRunId: 1, sampleStart: s(4), sampleEnd: s(10) },
      ],
    );
    expect(turns.map((turn) => [turn.startMs, turn.endMs])).toEqual([
      [2_000, 3_500],
      [4_000, 5_000],
    ]);
  });
});
