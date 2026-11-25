import { describe, expect, it } from "vitest";
import { analysisPriorities } from "../../../packages/db/src/index.ts";
import { countEpisodes, type SegmentRegion } from "./planner.ts";

function region(startMs: number, endMs: number, voicedMs = endMs - startMs): SegmentRegion {
  return { speechStartSample: startMs * 16, speechEndSample: endMs * 16, voicedMs };
}

function count(regions: readonly SegmentRegion[], durationMs = 10_000) {
  return countEpisodes({ sampleRate: 16_000, sampleCount: durationMs * 16, regions });
}

describe("file regions through the real episode planner and queue", () => {
  it("excludes pre-roll and post-roll from voiced time and queues a trace job", () => {
    const result = count([{ ...region(2000, 2300), startSample: 500 * 16, endSample: 3100 * 16 }]);
    expect(result.counts).toEqual({ trace: 1, moment: 0, conversation: 0 });
    expect(result.episodes[0]).toMatchObject({ productVoicedMs: 300, startMs: 2000, endMs: 2300 });
    expect(result.groupingVersion).toBe("grouping/6");
    expect(result.jobsCreated).toBe(1);
    expect(result.traceJobsCreated).toBe(1);
    expect(result.otherJobsCreated).toBe(0);
    expect(result.jobs).toEqual([
      { episodeId: 1, priority: analysisPriorities.trace, size: "trace" },
    ]);
    expect(result.warmTraceCandidates).toBe(1);
    expect(result.transcriptionsExecuted).toBe(0);
  });

  it("sizes a region on the helper's voice, not on the pauses its span holds", () => {
    const merged = count([region(0, 1800, 500)]);
    expect(merged.helperVoicedMs).toBe(500);
    expect(merged.productVoicedMs).toBe(500);
    expect(merged.counts.trace).toBe(1);
    expect(merged.jobsCreated).toBe(1);
    expect(merged.jobs[0]?.priority).toBe(analysisPriorities.trace);
    expect(merged.traceJobsCreated).toBe(1);
    expect(merged.otherJobsCreated).toBe(0);

    const separated = count([region(0, 250), region(1550, 1800)]);
    expect(separated.counts.trace).toBe(1);
    expect(separated.productVoicedMs).toBe(500);
    expect(separated.jobsCreated).toBe(1);
    expect(separated.traceJobsCreated).toBe(1);
    expect(separated.otherJobsCreated).toBe(0);
  });

  it("uses the exact fresh-classification boundary, without rounding a short span upward", () => {
    const below = count([{ speechStartSample: 0, speechEndSample: 23_999, voicedMs: 1499.9375 }]);
    const at = count([region(0, 1500)]);
    expect(below.counts.trace).toBe(1);
    expect(below.jobsCreated).toBe(1);
    expect(below.jobs[0]?.priority).toBe(analysisPriorities.trace);
    expect(below.traceJobsCreated).toBe(1);
    expect(below.otherJobsCreated).toBe(0);
    expect(at.counts.moment).toBe(1);
    expect(at.jobsCreated).toBe(1);
    expect(at.jobs[0]?.priority).toBe(analysisPriorities.moment);
    expect(at.traceJobsCreated).toBe(0);
    expect(at.otherJobsCreated).toBe(1);
  });

  it("waits for the input quiet cutoff without adding logical quiet to the audio denominator", () => {
    const input = { sampleRate: 16_000, sampleCount: 32_000, regions: [region(0, 2000)] };
    const before = countEpisodes({ ...input, quietMs: 44_999 });
    const after = countEpisodes({ ...input, quietMs: 45_001 });
    expect(before.openCount).toBe(1);
    expect(before.jobsCreated).toBe(0);
    expect(after.closedCount).toBe(1);
    expect(after.jobsCreated).toBe(1);
    expect(before.audioDurationMs).toBe(2000);
    expect(after.audioDurationMs).toBe(2000);
  });

  it("counts an actual media job separately and honors its longer quiet cutoff", () => {
    const input = {
      sampleRate: 16_000,
      sampleCount: 32_000,
      regions: [region(0, 2000)],
      sourceKind: "system" as const,
    };
    expect(countEpisodes({ ...input, quietMs: 45_001 }).jobsCreated).toBe(0);
    const result = countEpisodes(input);
    expect(result.episodes[0]?.context).toBe("media");
    expect(result.jobsCreated).toBe(1);
    expect(result.jobs[0]?.priority).toBe(analysisPriorities.media);
    expect(result.logicalQuietMs).toBe(120_001);
  });

  it("creates one job for several regions in a single episode, not one per region", () => {
    const result = count([region(1000, 2000), region(4000, 5000), region(7000, 8000)]);
    expect(result.regionCount).toBe(3);
    expect(result.counts.moment).toBe(1);
    expect(result.jobsCreated).toBe(1);
    expect(result.episodes[0]?.members).toHaveLength(3);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("keeps independent episodes on a long timeline and ignores input enumeration order", () => {
    const regions = [region(0, 2000), region(60_000, 62_000)];
    const first = count(regions, 65_000);
    const second = count(regions.toReversed(), 65_000);
    expect(first.counts.moment).toBe(2);
    expect(first.jobsCreated).toBe(2);
    expect(second).toEqual(first);
  });

  it("has no episodes, jobs or trace candidates when the helper detected nothing", () => {
    const result = count([]);
    expect(result.counts).toEqual({ trace: 0, moment: 0, conversation: 0 });
    expect(result.episodes).toEqual([]);
    expect(result.jobsCreated).toBe(0);
    expect(result.warmTraceCandidates).toBe(0);
  });

  it("rejects overlapping regions instead of double-counting them in the product", () => {
    expect(() => count([region(0, 1000), region(500, 2000)])).toThrow(/overlapping/);
    expect(() => count([region(9000, 11_000)])).toThrow(/out-of-file/);
    expect(() => count([region(0, 1000, Number.NaN)])).toThrow(/voicedMs/);
  });
});

describe("synthetic call annotations through the real calls table and grouping", () => {
  const bundleId = "org.sondine.benchmark.call";

  it("makes the same two-second mic region a call conversation only with a covering call", () => {
    const input = { sampleRate: 16_000, sampleCount: 10_000 * 16, regions: [region(2000, 4000)] };
    const withoutCall = countEpisodes(input);
    const duringCall = countEpisodes({
      ...input,
      calls: [{ bundleId, startMs: 1000, endMs: 5000 }],
    });
    expect(withoutCall.groupingVersion).toBe("grouping/6");
    expect(withoutCall.episodes[0]).toMatchObject({ context: "in_person", size: "moment" });
    expect(withoutCall.jobs[0]?.priority).toBe(analysisPriorities.moment);
    expect(duringCall.groupingVersion).toBe("grouping/6");
    expect(duringCall.counts).toEqual({ trace: 0, moment: 0, conversation: 1 });
    expect(duringCall.episodes[0]).toMatchObject({
      context: "call",
      size: "conversation",
      closed: true,
      productVoicedMs: 2000,
    });
    expect(duringCall.jobsCreated).toBe(1);
    expect(duringCall.traceJobsCreated).toBe(0);
    expect(duringCall.otherJobsCreated).toBe(1);
    expect(duringCall.jobs[0]?.priority).toBe(analysisPriorities.conversation);
    expect(duringCall.transcriptionsExecuted).toBe(0);
  });

  it.each([
    { startMs: 1000, endMs: 2999, context: "in_person" },
    { startMs: 1000, endMs: 3000, context: "call" },
    { startMs: 3000, endMs: 5000, context: "call" },
    { startMs: 3001, endMs: 5000, context: "in_person" },
  ])("assigns a region by its midpoint at inclusive call boundaries: $startMs–$endMs", (call) => {
    const result = countEpisodes({
      sampleRate: 16_000,
      sampleCount: 10_000 * 16,
      regions: [region(2000, 4000)],
      calls: [{ bundleId, startMs: call.startMs, endMs: call.endMs }],
    });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      context: call.context,
      productVoicedMs: 2000,
      startMs: 2000,
      endMs: 4000,
    });
  });

  it("waits for 45 seconds after a call ends before creating its job", () => {
    const input = {
      sampleRate: 16_000,
      sampleCount: 5000 * 16,
      regions: [region(2000, 4000)],
      calls: [{ bundleId, startMs: 1000, endMs: 5000 }],
    };
    const before = countEpisodes({ ...input, quietMs: 44_999 });
    const at = countEpisodes({ ...input, quietMs: 45_000 });
    expect(before.episodes[0]).toMatchObject({ context: "call", closed: false });
    expect(before.jobsCreated).toBe(0);
    expect(at.episodes[0]).toMatchObject({ context: "call", closed: true });
    expect(at.jobsCreated).toBe(1);
    expect(at.jobs[0]?.priority).toBe(analysisPriorities.conversation);
  });

  it("keeps a short call in trace size and trace priority", () => {
    const result = countEpisodes({
      sampleRate: 16_000,
      sampleCount: 10_000 * 16,
      regions: [region(2000, 2300)],
      calls: [{ bundleId, startMs: 1000, endMs: 5000 }],
    });
    expect(result.counts).toEqual({ trace: 1, moment: 0, conversation: 0 });
    expect(result.episodes[0]).toMatchObject({ context: "call", size: "trace", closed: true });
    expect(result.jobsCreated).toBe(1);
    expect(result.traceJobsCreated).toBe(1);
    expect(result.otherJobsCreated).toBe(0);
    expect(result.jobs[0]?.priority).toBe(analysisPriorities.trace);
  });

  it("leaves speech before and after a call in separate in-person moments", () => {
    const regions = [region(1000, 3000), region(6000, 8000), region(13_000, 15_000)];
    const input = { sampleRate: 16_000, sampleCount: 20_000 * 16, regions };
    expect(countEpisodes(input).counts).toEqual({ trace: 0, moment: 1, conversation: 0 });
    const result = countEpisodes({
      ...input,
      calls: [{ bundleId, startMs: 5000, endMs: 12_000 }],
    });
    expect(
      result.episodes.map(({ context, size, startMs, endMs }) => ({
        context,
        size,
        startMs,
        endMs,
      })),
    ).toEqual([
      { context: "in_person", size: "moment", startMs: 1000, endMs: 3000 },
      { context: "call", size: "conversation", startMs: 6000, endMs: 8000 },
      { context: "in_person", size: "moment", startMs: 13_000, endMs: 15_000 },
    ]);
    expect(result.jobsCreated).toBe(3);
    expect(result.traceJobsCreated).toBe(0);
    expect(result.otherJobsCreated).toBe(3);
  });

  it("does not close an active call or enqueue it merely because the file ended", () => {
    const result = countEpisodes({
      sampleRate: 16_000,
      sampleCount: 10_000 * 16,
      regions: [region(2000, 4000)],
      calls: [{ bundleId, startMs: 1000, endMs: null }],
    });
    expect(result.episodes[0]).toMatchObject({ context: "call", closed: false });
    expect(result.openCount).toBe(1);
    expect(result.jobsCreated).toBe(0);
  });

  it("lets an unattributed system region join the call while the no-call control stays media", () => {
    const input = {
      sampleRate: 16_000,
      sampleCount: 10_000 * 16,
      regions: [region(2000, 4000)],
      sourceKind: "system" as const,
    };
    expect(countEpisodes(input).episodes[0]?.context).toBe("media");
    const result = countEpisodes({
      ...input,
      calls: [{ bundleId, startMs: 1000, endMs: 5000 }],
    });
    expect(result.episodes[0]).toMatchObject({ context: "call", size: "conversation" });
    expect(result.jobs[0]?.priority).toBe(analysisPriorities.conversation);
  });

  it("rejects synthetic call annotations outside the measured file or with reversed clocks", () => {
    const input = { sampleRate: 16_000, sampleCount: 10_000 * 16, regions: [region(2000, 4000)] };
    expect(() =>
      countEpisodes({ ...input, calls: [{ bundleId, startMs: 0, endMs: 11_000 }] }),
    ).toThrow(/synthetic call/);
    expect(() =>
      countEpisodes({ ...input, calls: [{ bundleId, startMs: 5000, endMs: 1000 }] }),
    ).toThrow(/synthetic call/);
  });
});
