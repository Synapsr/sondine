import type { Database, FarRegion, OngoingCall, VoiceMatch } from "@sondine/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadTrackAudio } from "../audio/track-audio";
import {
  CallVoices,
  farSpeech,
  latestSpeech,
  nextWindow,
  unconsumed,
  type CallState,
  type FarPiece,
} from "./call-voices";
import type { VoiceAnswer } from "./voice-tool";

// What the database answers, set by each test.
const world = vi.hoisted(() => ({
  call: null as OngoingCall | null,
  regions: [] as FarRegion[],
  allowed: true,
  matches: [] as (VoiceMatch | null)[],
}));

vi.mock("@sondine/db", () => ({
  ongoingCall: () => world.call,
  farSideRegions: () => world.regions,
  loadOpenRunClocks: () => [],
  recognitionEnabled: () => world.allowed,
  namingAllowed: () => true,
  appMayBeIdentified: () => true,
  anyoneToRecognize: () => true,
  intersectsDeletedRange: () => false,
  knownVoices: () => new Map(),
  recognizeVoice: () => world.matches.shift() ?? null,
}));

const RATE = 16_000;
const T0 = Date.UTC(2026, 10, 9, 14, 0, 0);

/** A closed far-side region from `from` to `to` seconds. */
const region = (from: number, to: number | null, trackRunId = 1): FarRegion => ({
  trackRunId,
  sampleRate: RATE,
  sampleStart: from * RATE,
  sampleEnd: to === null ? null : to * RATE,
  sliceStart: from * RATE,
  sliceEnd: null,
  wallStartMs: T0 + from * 1000,
});

const marie: VoiceMatch = {
  person: { id: 2, name: "Marie", isSelf: false },
  similarity: 0.8,
  confidence: 0.999,
  references: 3,
  dictations: 0,
  reads: 0,
  zone: "suggested",
};

describe("the far side's speech", () => {
  it("trims each region, reads an open one up to what is imported, drops short ones", () => {
    const pieces = farSpeech(
      [region(10, 14), region(20, 21), region(30, null, 2)],
      new Map([[2, 36 * RATE]]),
    );
    expect(pieces.map((piece) => [piece.trackRunId, piece.ms, piece.wallStartMs - T0])).toEqual([
      [1, 3_500, 10_250],
      [2, 5_750, 30_250],
    ]);
  });

  it("takes the latest seconds, the newest piece cut at its start", () => {
    const pieces: FarPiece[] = [
      { trackRunId: 1, sampleStart: 0, sampleEnd: 4 * RATE, wallStartMs: T0, ms: 4_000 },
      {
        trackRunId: 1,
        sampleStart: 10 * RATE,
        sampleEnd: 13 * RATE,
        wallStartMs: T0 + 10_000,
        ms: 3_000,
      },
    ];
    expect(latestSpeech(pieces, 5_000)).toEqual([
      {
        trackRunId: 1,
        sampleStart: 2 * RATE,
        sampleEnd: 4 * RATE,
        wallStartMs: T0 + 2_000,
        ms: 2_000,
      },
      pieces[1],
    ]);
  });

  it("embeds each 3 s of new speech over the first 30 s, then the latest 10 s of each 30 s", () => {
    expect(nextWindow(2_000, 0)).toBeNull();
    expect(nextWindow(3_000, 0)).toBe(3_000);
    expect(nextWindow(11_000, 3_000)).toBe(10_000);
    expect(nextWindow(2_000, 27_000)).toBeNull();
    expect(nextWindow(3_000, 28_000)).toBe(3_000);
    expect(nextWindow(19_000, 31_000)).toBeNull();
    expect(nextWindow(30_000, 31_000)).toBe(10_000);
  });

  it("keeps only speech no window saw, whatever order it arrives in", () => {
    const pieces = farSpeech([region(0, 10.5), region(20, 23.5)], new Map());
    expect(
      unconsumed(pieces, new Map([[1, [[2 * RATE, 9 * RATE] as const]]])).map((piece) => [
        piece.sampleStart / RATE,
        piece.sampleEnd / RATE,
        piece.ms,
        piece.wallStartMs - T0,
      ]),
    ).toEqual([
      [0.25, 2, 1_750, 250],
      [9, 10.25, 1_250, 9_000],
      [20.25, 23.25, 3_000, 20_250],
    ]);
  });
});

describe("live identity in a call", () => {
  let states: (CallState | null)[];
  let voices: CallVoices;
  let release: (() => void)[];

  /** The stretches each window read, in seconds. */
  let reads: [number, number][];
  const read: ReadTrackAudio = (range) => {
    reads.push([range.sampleStart / RATE, range.sampleEnd / RATE]);
    return { samples: new Int16Array(range.sampleEnd - range.sampleStart), missing: [] };
  };
  const answer: VoiceAnswer = {
    modelVersion: "wespeaker-v2:test",
    speakers: [{ key: "far", embedding: Array.from({ length: 256 }, () => 0), speechMs: 3_000 }],
    errors: [],
  };
  /** Lets the embeddings in flight answer, then their matches run. */
  const settle = async () => {
    for (const done of release.splice(0)) done();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const heard = (seconds: number) => {
    world.regions = [region(0, seconds + 0.5)];
  };
  const last = () => states.at(-1);

  beforeEach(() => {
    world.call = {
      callId: 5,
      bundleId: "us.zoom.xos",
      appId: 3,
      startedWallMs: T0,
      episodeId: 7,
    };
    reads = [];
    world.regions = [];
    world.allowed = true;
    world.matches = [];
    states = [];
    release = [];
    voices = new CallVoices({
      db: {} as Database,
      tool: { binary: "sondine-voice", model: "model" },
      readAudio: () => read,
      onChange: (state) => states.push(state),
      log: { info: () => undefined, warn: () => undefined },
      now: () => T0 + 60_000,
      embed: () =>
        new Promise((resolve) => {
          release.push(() => resolve(answer));
        }),
    });
  });

  it("suggests a person once two windows agree, and forgets the call when it ends", async () => {
    voices.nudge();
    expect(last()).toEqual({
      callId: 5,
      startedAtMs: T0,
      episodeId: 7,
      suggestions: [],
      dismissed: false,
    });
    heard(3.5);
    world.matches = [marie];
    voices.nudge();
    await settle();
    expect(last()?.suggestions).toEqual([]);
    heard(7);
    world.matches = [marie];
    voices.nudge();
    await settle();
    expect(last()?.suggestions).toEqual([
      { personId: 2, similarity: 0.8, confidence: 0.999, recognizedAtMs: T0 + 60_000 },
    ]);
    world.call = null;
    voices.nudge();
    expect(last()).toBeNull();
  });

  it("drops a window read before a deletion, and stops once hidden", async () => {
    heard(3.5);
    world.matches = [marie, marie];
    voices.nudge();
    voices.reset();
    await settle();
    heard(7);
    voices.nudge();
    await settle();
    // The first window was dropped: one vote only.
    expect(last()?.suggestions).toEqual([]);
    voices.dismiss(5);
    expect(last()).toMatchObject({ dismissed: true, suggestions: [] });
    heard(20);
    voices.nudge();
    expect(release).toEqual([]);
  });

  it("clears its suggestions when recognition is turned off", async () => {
    world.matches = [marie, marie];
    heard(3.5);
    voices.nudge();
    await settle();
    heard(7);
    voices.nudge();
    await settle();
    expect(last()?.suggestions).toHaveLength(1);
    world.allowed = false;
    voices.nudge();
    expect(last()?.suggestions).toEqual([]);
  });

  it("never sends the same audio twice, when older speech arrives late or the episode is cut", async () => {
    world.regions = [region(10, 13.5)];
    voices.nudge();
    await settle();
    // An older stretch is imported late, then the 3 h cut moves the call to a new episode.
    world.regions = [region(0, 3.5), region(10, 13.5)];
    voices.nudge();
    await settle();
    world.call = { ...world.call!, episodeId: 8 };
    world.regions = [region(10, 13.5), region(20, 23.5)];
    voices.nudge();
    await settle();
    expect(reads).toEqual([
      [10.25, 13.25],
      [0.25, 3.25],
      [20.25, 23.25],
    ]);
    expect(last()?.episodeId).toBe(8);
  });

  it("drops a window whose call ended while it was embedded", async () => {
    world.matches = [marie, marie];
    heard(3.5);
    voices.nudge();
    await settle();
    heard(7);
    voices.nudge();
    world.call = null;
    await settle();
    expect(last()?.suggestions).toEqual([]);
    voices.nudge();
    expect(last()).toBeNull();
  });
});
