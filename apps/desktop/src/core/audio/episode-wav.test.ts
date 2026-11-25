import type { AnalysisInput, AnalysisRegion } from "@sondine/db";
import { describe, expect, it } from "vitest";
import { MEDIA_SLICE_BYTES } from "../../shared/byte-range";
import { planRequests } from "../analysis/requests";
import {
  mixTimeline,
  planEpisodeTimeline,
  readTimelineBytes,
  WAV_HEADER_BYTES,
  wavByteLength,
  type EpisodeTimeline,
  type WallMsAt,
} from "./episode-wav";
import type { MissingSpan, ReadTrackAudio, TrackAudioRange } from "./track-audio";

// Samples are generated here; no audio file is read or written.

const RATE = 16_000;
const s = (sec: number) => Math.round(sec * RATE);
const T0 = 1_793_610_000_000;

const trackKeys: Record<number, string> = { 1: "input:mic", 2: "system:other", 3: "app:com.zoom" };

function region(
  trackRunId: number,
  startSec: number,
  endSec: number,
  options: Partial<AnalysisRegion> = {},
): AnalysisRegion {
  return {
    regionId: trackRunId * 100_000 + startSec,
    trackRunId,
    trackKey: trackKeys[trackRunId] ?? `app:${trackRunId}`,
    sourceKind: trackRunId === 1 ? "input" : "system",
    sampleRate: RATE,
    sampleStart: s(startSec),
    sampleEnd: s(endSec),
    sliceStart: s(startSec),
    sliceEnd: null,
    wallStartMs: T0 + startSec * 1000,
    runStartedWallMs: T0,
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

/** Every run starts at T0 on the wall clock (plus `startsAtSec` for some runs). */
const wallMsAt =
  (startsAtSec: Record<number, number> = {}): WallMsAt =>
  (trackRunId, sample) =>
    T0 + (startsAtSec[trackRunId] ?? 0) * 1000 + (sample * 1000) / RATE;

/**
 * A reader where `fill` gives each sample's value and `missing` the spans it
 * zero-fills. Records every read.
 */
function source(
  fill: (trackRunId: number, sample: number) => number,
  missing: (range: TrackAudioRange) => MissingSpan[] = () => [],
) {
  const reads: TrackAudioRange[] = [];
  const read: ReadTrackAudio = (range) => {
    reads.push(range);
    const samples = new Int16Array(range.sampleEnd - range.sampleStart);
    const gaps = missing(range);
    for (let i = 0; i < samples.length; i++) {
      const sample = range.sampleStart + i;
      const hole = gaps.some((gap) => gap.sampleStart <= sample && sample < gap.sampleEnd);
      samples[i] = hole ? 0 : fill(range.trackRunId, sample);
    }
    return { samples, missing: gaps };
  };
  return { read, reads };
}

/** Sample values that tell runs and positions apart. */
const stepFill = (run: number, sample: number) => run * 1_000 + (sample % 7);
const rampFill = (run: number, sample: number) => ((sample * (run + 3)) % 60_001) - 30_000;
/** Loud enough that three tracks clip where they overlap. */
const loudFill = (run: number, sample: number) => ((sample * (run * 7 + 1)) % 50_001) - 25_000;

const wav = (timeline: EpisodeTimeline, read: ReadTrackAudio) =>
  readTimelineBytes(timeline, read, 0, wavByteLength(timeline));

const pcm = (bytes: Uint8Array) =>
  new Int16Array(bytes.buffer, bytes.byteOffset + WAV_HEADER_BYTES, bytes.length / 2 - 22);

/**
 * What the timeline must hold, computed without the timeline: each run's
 * audible samples (what transcription reads, deleted ranges cut out) placed
 * by the run's wall clock from the earliest extent before deletion, summed
 * and clamped.
 */
function oracle(
  episode: AnalysisInput,
  fill: (trackRunId: number, sample: number) => number,
  startsAtSec: Record<number, number> = {},
) {
  const audible = planRequests(episode).flatMap((plan) => plan.extents);
  const all = planRequests({ ...episode, deleted: new Map() }).flatMap((plan) => plan.extents);
  const runStart = (run: number) => T0 + (startsAtSec[run] ?? 0) * 1000;
  const originMs = Math.min(
    ...all.map((e) => runStart(e.trackRunId) + (e.sampleStart * 1000) / RATE),
  );
  const shift = (run: number) => Math.round(((runStart(run) - originMs) * RATE) / 1000);
  return (position: number) => {
    let sum = 0;
    for (const extent of audible) {
      const sample = position - shift(extent.trackRunId);
      if (sample >= extent.sampleStart && sample < extent.sampleEnd) {
        sum += fill(extent.trackRunId, sample);
      }
    }
    return Math.max(-32_768, Math.min(32_767, sum));
  };
}

describe("episode timeline", () => {
  it("writes a mono 16 kHz PCM16 WAV of the extents", () => {
    // One 70 s region: extent [8.5 s, 80.8 s) with roll.
    const { read } = source((_run, sample) => sample % 1000);
    const timeline = planEpisodeTimeline(input([region(1, 10, 80)]), wallMsAt());
    const total = s(80.8) - s(8.5);
    expect(timeline).toMatchObject({ startedAtMs: T0 + 8_500, samples: total });
    const bytes = wav(timeline, read);

    const view = new DataView(bytes.buffer);
    const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + total * 2);
    expect(text(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + total * 2);
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(total * 2);
    const samples = pcm(bytes);
    for (const at of [0, s(30), total - 1]) {
      expect(samples[at], `sample ${at}`).toBe((s(8.5) + at) % 1000);
    }
  });

  it("places tracks on one wall-clock timeline and mixes them without overflow", () => {
    // Mic speech 2-4 s (extent 0.5-4.8 s), system speech 3-5 s (extent 1.5-5.8 s).
    const episode = input([region(1, 2, 4), region(2, 3, 5)]);
    const timeline = planEpisodeTimeline(episode, wallMsAt());
    expect(timeline).toMatchObject({ startedAtMs: T0 + 500, samples: s(5.3) });
    const mixed = pcm(wav(timeline, source((run) => (run === 1 ? 30_000 : 10_000)).read));
    expect(mixed[0]).toBe(30_000);
    expect(mixed[s(1) - 1]).toBe(30_000);
    // Both tracks: 40,000 clamps instead of wrapping to a negative value.
    expect(mixed[s(1)]).toBe(32_767);
    expect(mixed[s(4.3) - 1]).toBe(32_767);
    expect(mixed[s(4.3)]).toBe(10_000);
    expect(mixed[s(5.3) - 1]).toBe(10_000);

    const negative = pcm(wav(timeline, source((run) => (run === 1 ? -30_000 : -10_000)).read));
    expect(negative[s(2)]).toBe(-32_768);
    const quiet = pcm(wav(timeline, source((run) => (run === 1 ? 1_200 : -200)).read));
    expect(quiet[s(2)]).toBe(1_000);
  });

  it("sums every track before clamping, so the order of the tracks never matters", () => {
    // 30 000 + 30 000 - 30 000 is 30 000, not a clamped 32 767 minus 30 000.
    const episode = input([region(1, 2, 4), region(2, 2, 4), region(3, 2, 4)]);
    const timeline = planEpisodeTimeline(episode, wallMsAt());
    const { read } = source((run) => (run === 3 ? -30_000 : 30_000));
    expect(mixTimeline(timeline, read, s(1), s(1) + 1)[0]).toBe(30_000);
  });

  it("places runs that started at different wall times", () => {
    // The system run started 2 s after the mic run: its sample 0 is at T0 + 2 s.
    const episode = input([region(1, 2, 4), region(2, 1, 3, { runStartedWallMs: T0 + 2_000 })]);
    const starts = { 2: 2 };
    const timeline = planEpisodeTimeline(episode, wallMsAt(starts));
    const expected = oracle(episode, stepFill, starts);
    const samples = pcm(wav(timeline, source(stepFill).read));
    for (let at = 0; at < samples.length; at += 97)
      expect(samples[at], `sample ${at}`).toBe(expected(at));
  });

  it("never reads a deleted range, plays it silent, and keeps every other offset", () => {
    // Speech 10-20 s with 14-16 s deleted: extents 8.5-14 s and 16-20.8 s.
    const deleted: [number, number] = [s(14), s(16)];
    const { read, reads } = source(() => 5_000);
    const timeline = planEpisodeTimeline(input([region(1, 10, 20)], { 1: [deleted] }), wallMsAt());
    const samples = pcm(wav(timeline, read));
    expect(reads.length).toBeGreaterThan(0);
    for (const range of reads) {
      expect(range.sampleEnd <= deleted[0] || range.sampleStart >= deleted[1]).toBe(true);
    }
    const at = (sec: number) => s(sec - 8.5);
    expect(samples.length).toBe(at(20.8));
    expect(samples[at(14) - 1]).toBe(5_000);
    expect(samples.subarray(at(14), at(16)).every((sample) => sample === 0)).toBe(true);
    expect(samples[at(16)]).toBe(5_000);
  });

  it("says where speech is, on which side, without roll or deleted ranges", () => {
    const episode = input([region(1, 10, 20), region(2, 12, 14), region(3, 30, 31)], {
      1: [[s(14), s(16)]],
    });
    expect(planEpisodeTimeline(episode, wallMsAt()).speech).toEqual([
      { startMs: T0 + 10_000, endMs: T0 + 14_000, track: "microphone" },
      { startMs: T0 + 12_000, endMs: T0 + 14_000, track: "computer" },
      { startMs: T0 + 16_000, endMs: T0 + 20_000, track: "microphone" },
      { startMs: T0 + 30_000, endMs: T0 + 31_000, track: "computer" },
    ]);
  });

  it("keeps the frame when a deletion cuts the timeline's head or tail", () => {
    // Mic 10-20 s, system 30-40 s; the mic's first 3 s and the system's last 2 s deleted.
    const regions = [region(1, 10, 20), region(2, 30, 40)];
    const before = planEpisodeTimeline(input(regions), wallMsAt());
    const deleted = {
      1: [[s(8), s(11.5)]] as [number, number][],
      2: [[s(39), s(41)]] as [number, number][],
    };
    const { read, reads } = source(() => 5_000);
    const after = planEpisodeTimeline(input(regions, deleted), wallMsAt());
    expect(after.startedAtMs).toBe(before.startedAtMs);
    expect(after.samples).toBe(before.samples);
    const samples = pcm(wav(after, read));
    const at = (sec: number) => s(sec - 8.5);
    expect(samples.subarray(0, at(11.5)).every((sample) => sample === 0)).toBe(true);
    expect(samples[at(11.5)]).toBe(5_000);
    expect(samples[at(39) - 1]).toBe(5_000);
    expect(samples.subarray(at(39)).every((sample) => sample === 0)).toBe(true);
    for (const range of reads) {
      const cuts = deleted[range.trackRunId as 1 | 2];
      for (const [from, to] of cuts) {
        expect(range.sampleEnd <= from || range.sampleStart >= to).toBe(true);
      }
    }
  });

  it("keeps a given frame and cuts what falls outside it", () => {
    const timeline = planEpisodeTimeline(
      input([region(1, 10, 20), region(2, 30, 40)]),
      wallMsAt(),
      {
        startedAtMs: T0 + 12_000,
        samples: s(20),
      },
    );
    expect(timeline.startedAtMs).toBe(T0 + 12_000);
    expect(timeline.samples).toBe(s(20));
    expect(timeline.extents).toEqual([
      { trackRunId: 1, sampleStart: s(12), sampleEnd: s(20.8), offset: 0 },
      { trackRunId: 2, sampleStart: s(28.5), sampleEnd: s(32), offset: s(16.5) },
    ]);
  });

  it("plays missing or expired audio as silence", () => {
    const expired = { sampleStart: s(12), sampleEnd: s(13), reason: "expired" as const };
    const { read } = source(
      () => 5_000,
      (range) =>
        range.sampleStart < expired.sampleEnd && expired.sampleStart < range.sampleEnd
          ? [expired]
          : [],
    );
    const samples = pcm(wav(planEpisodeTimeline(input([region(1, 10, 20)]), wallMsAt()), read));
    const at = (sec: number) => s(sec - 8.5);
    expect(samples[at(12) - 1]).toBe(5_000);
    expect(samples.subarray(at(12), at(13)).every((sample) => sample === 0)).toBe(true);
    expect(samples[at(13)]).toBe(5_000);
  });

  it("has nothing to hear while no region has ended, and reads nothing", () => {
    const { read, reads } = source(() => 5_000);
    const open = region(1, 10, 20, { sampleEnd: null });
    const timeline = planEpisodeTimeline({ ...input([open]), state: "open" }, wallMsAt());
    expect(timeline).toEqual({ startedAtMs: null, samples: 0, extents: [], speech: [] });
    expect(wav(timeline, read).byteLength).toBe(WAV_HEADER_BYTES);
    expect(reads).toEqual([]);
  });
});

describe("byte ranges of the timeline's WAV", () => {
  it("gives exactly the bytes of the whole file at any offset, odd ones included", () => {
    const episode = input([region(1, 2, 9), region(2, 5, 12), region(3, 20, 25)]);
    const timeline = planEpisodeTimeline(episode, wallMsAt());
    const fill = rampFill;
    const whole = wav(timeline, source(fill).read);
    const total = whole.byteLength;
    const expected = oracle(episode, fill);
    const samples = pcm(whole);
    for (let at = 0; at < samples.length; at += 13)
      expect(samples[at], `sample ${at}`).toBe(expected(at));
    for (const [start, end] of [
      [0, 1],
      [0, 44],
      [3, 47],
      [43, 46],
      [44, 45],
      [45, 46],
      [1_001, 70_003],
      [s(7) * 2 + 1, s(7) * 2 + 2],
      [total - 3, total],
      [total, total],
    ] as const) {
      const part = readTimelineBytes(timeline, source(fill).read, start, end);
      expect(part.byteLength).toBe(end - start);
      expect(part.buffer.byteLength, "the slice owns its whole buffer").toBe(end - start);
      expect(
        Buffer.from(part).equals(Buffer.from(whole.subarray(start, end))),
        `${start}-${end}`,
      ).toBe(true);
    }
    expect(() => readTimelineBytes(timeline, source(fill).read, 0, total + 1)).toThrow(RangeError);
    expect(() => readTimelineBytes(timeline, source(fill).read, 10, 9)).toThrow(RangeError);
  });

  it("seeks into a 3 h, three-track episode: the slice's bytes, read from only what it covers", () => {
    // Every 70 s the mic speaks 10 s, the system 25 s later, a call app 50 s
    // later: about 460 extents over 3 h (gaps beyond the 45 s in-person gap).
    const regions: AnalysisRegion[] = [];
    for (let at = 10; at + 60 < 3 * 3600; at += 70) {
      regions.push(
        region(1, at, at + 10),
        region(2, at + 25, at + 33),
        region(3, at + 50, at + 55),
      );
    }
    const deleted = { 2: [[s(5_400 + 25 + 2), s(5_400 + 25 + 4)]] as [number, number][] };
    const episode = input(regions, deleted);
    const fill = loudFill;

    let started = performance.now();
    const timeline = planEpisodeTimeline(episode, wallMsAt());
    const planMs = performance.now() - started;
    expect(timeline.samples).toBeGreaterThan(s(3 * 3600 - 80));
    expect(timeline.extents.length).toBeGreaterThan(400);

    // Mid-episode, at an odd byte, a full slice.
    const start = WAV_HEADER_BYTES + 2 * s(5_400) + 1;
    const { read, reads } = source(fill);
    started = performance.now();
    const slice = readTimelineBytes(timeline, read, start, start + MEDIA_SLICE_BYTES);
    const sliceMs = performance.now() - started;

    const expected = oracle(episode, fill);
    const first = (start - WAV_HEADER_BYTES - 1) / 2;
    const view = new DataView(slice.buffer);
    // Byte 0 is the high byte of sample `first`; then whole samples.
    expect(slice[0]).toBe((expected(first) >> 8) & 0xff);
    for (let i = 1; i + 1 < slice.length; i += 2) {
      const position = first + 1 + (i - 1) / 2;
      expect(view.getInt16(i, true), `sample ${position}`).toBe(expected(position));
    }
    // Only the samples under the slice were asked for, never the deleted ones.
    const window = MEDIA_SLICE_BYTES / 2 + 1;
    for (const range of reads) {
      expect(range.sampleEnd - range.sampleStart).toBeLessThanOrEqual(window);
      for (const [from, to] of deleted[range.trackRunId as 2] ?? []) {
        expect(range.sampleEnd <= from || range.sampleStart >= to).toBe(true);
      }
    }
    const asked = reads.reduce((sum, range) => sum + range.sampleEnd - range.sampleStart, 0);
    expect(asked).toBeLessThanOrEqual(3 * window);
    // Generous bounds: planning and one slice must never stall core.
    expect(planMs).toBeLessThan(500);
    expect(sliceMs).toBeLessThan(250);
  });
});
