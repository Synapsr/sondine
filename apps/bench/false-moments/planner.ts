import { GROUPING_V4 } from "@sondine/core";
import { planEpisodes } from "../../desktop/src/core/episodes/episode-plan.ts";
import {
  analysisPriorities,
  applyEpisodePlan,
  closeSpeechRegion,
  openDatabase,
  openSpeechRegion,
  loadCallsBetween,
  recordCallActive,
  recordSpanEnded,
  upsertTrackRun,
  type StoredRegion,
} from "../../../packages/db/src/index.ts";

/** The file helper's speech bounds, not its pre/post-roll retention bounds. */
export interface SegmentRegion {
  readonly speechStartSample: number;
  readonly speechEndSample: number;
  readonly voicedMs: number;
  readonly startSample?: number;
  readonly endSample?: number;
}

/** Explicit fixture annotations, not calls inferred from a file's audio. */
export interface SyntheticCall {
  readonly bundleId: string;
  readonly startMs: number;
  /** Null means the call remains active at the grouping pass. */
  readonly endMs: number | null;
}

export interface EpisodeCountInput {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly regions: readonly SegmentRegion[];
  /** Ambient TV heard by the mic is still input; system means a system track. */
  readonly sourceKind?: "input" | "system";
  /** Logical time after EOF. Never added to the measured audio duration. */
  readonly quietMs?: number;
  /** Synthetic controls only. Corpus file runs leave this empty. */
  readonly calls?: readonly SyntheticCall[];
}

const BOOT_WALL_MS = Date.UTC(2026, 10, 6);
const RUN_UID = "00000000-0000-4000-8000-000000000001";

/**
 * Reconstructs one complete file as a closed capture stream, with no previous
 * size/hysteresis state. Imports the real planner and applies its real writes
 * to a fresh in-memory database; no worker, audio file or app is opened.
 *
 * The mapping follows ManifestRegion.init(region:) in manifest-records.swift:
 * speech bounds only, with a one-sample minimum, and the helper's voiced
 * samples, which the product sizes episodes on.
 */
export function countEpisodes(input: EpisodeCountInput) {
  validate(input);
  const sourceKind = input.sourceKind ?? "input";
  const gapNs = sourceKind === "system" ? GROUPING_V4.mediaGapNs : GROUPING_V4.inPersonGapNs;
  const logicalQuietMs = input.quietMs ?? Number(gapNs / 1_000_000n) + 1;
  const audioDurationMs = (input.sampleCount * 1000) / input.sampleRate;
  const nowMs = BOOT_WALL_MS + Math.ceil(audioDurationMs + logicalQuietMs);
  const trackKey = `${sourceKind}:false-moments-benchmark`;
  const db = openDatabase(":memory:");

  try {
    const { trackRunId } = upsertTrackRun(db, {
      uid: RUN_UID,
      trackKey,
      sourceKind,
      sampleRate: input.sampleRate,
      startedWallMs: BOOT_WALL_MS,
      state: "closed",
      endedWallMs: BOOT_WALL_MS + Math.round(audioDurationMs),
      sampleEnd: input.sampleCount,
      endReason: "stopped",
      nowMs: BOOT_WALL_MS,
    });
    const byId = new Map<number, SegmentRegion>();
    const regions: StoredRegion[] = input.regions
      .toSorted((a, b) => a.speechStartSample - b.speechStartSample)
      .map((region) => {
        const sampleStart = region.speechStartSample;
        const sampleEnd = Math.max(region.speechEndSample, sampleStart + 1);
        // As ManifestRegion.init(region:): the helper's voice, at most the span.
        const voicedSamples = Math.min(
          Math.max(0, Math.round((region.voicedMs * input.sampleRate) / 1000)),
          sampleEnd - sampleStart,
        );
        const wallStartMs = BOOT_WALL_MS + Math.round((sampleStart * 1000) / input.sampleRate);
        const wallEndMs = BOOT_WALL_MS + Math.round((sampleEnd * 1000) / input.sampleRate);
        const opened = openSpeechRegion(db, {
          trackRunId,
          sampleStart,
          wallStartMs,
          vadVersion: "benchmark-file/1",
        });
        if (opened.speechRegionId === null || opened.status !== "inserted") {
          throw new Error(`Benchmark region import failed: ${opened.status}`);
        }
        const closed = closeSpeechRegion(db, {
          trackRunId,
          sampleStart,
          sampleEnd,
          wallEndMs,
          endReason: "silence",
          voicedSamples,
        });
        if (closed.speechRegionId !== opened.speechRegionId) {
          throw new Error(`Benchmark region close failed: ${closed.status}`);
        }
        byId.set(opened.speechRegionId, region);
        return {
          id: opened.speechRegionId,
          trackRunId,
          trackKey,
          sourceKind,
          appId: null,
          bundleId: null,
          attributedBundleId: null,
          sampleRate: input.sampleRate,
          sampleStart,
          from: sampleStart,
          sampleEnd,
          voicedSamples,
          wallStartMs,
          wallEndMs,
          continuousStartUs: null,
          continuousEndUs: null,
          // One exact synthetic capture clock. The planner converts sample
          // offsets to ns, avoiding an intermediate rounded microsecond clock.
          chunkClock: { sampleStart: 0, continuousUs: 0, wallMs: BOOT_WALL_MS },
        };
      });

    for (const [index, call] of (input.calls ?? []).entries()) {
      const uid = `false-moments-call-${index}`;
      const opened = recordCallActive(db, {
        uid,
        sessionId: RUN_UID,
        bundleId: call.bundleId,
        via: "call_app",
        inputDeviceUid: null,
        at: { wallMs: BOOT_WALL_MS + call.startMs, continuousUs: call.startMs * 1000 },
        nowMs,
      });
      if (opened.status !== "inserted") throw new Error("Benchmark call import failed");
      if (call.endMs !== null) {
        const closed = recordSpanEnded(db, "calls", {
          uid,
          at: { wallMs: BOOT_WALL_MS + call.endMs, continuousUs: call.endMs * 1000 },
          nowMs,
        });
        if (closed.spanId !== opened.spanId || closed.status !== "updated") {
          throw new Error("Benchmark call close failed");
        }
      }
    }
    const calls = loadCallsBetween(db, BOOT_WALL_MS, nowMs);
    if (calls.length !== (input.calls?.length ?? 0)) {
      throw new Error("Benchmark call accounting disagrees with DB");
    }

    const result = planEpisodes({
      regions,
      openEpisodes: [],
      openRuns: [], // The complete file has been imported and its run closed.
      closedEpisodes: [],
      calls,
      nowMs,
    });
    if (result.unplaced.length > 0) throw new Error("Benchmark left regions without a clock");
    const applied = applyEpisodePlan(db, result.plan, nowMs);
    const jobs = db
      .statement(
        "SELECT j.episode_id, j.priority, e.size FROM jobs j JOIN episodes e ON e.id = j.episode_id ORDER BY j.id",
      )
      .all()
      .map((row) => {
        const episodeId = row["episode_id"];
        const priority = row["priority"];
        const size = row["size"];
        if (
          typeof episodeId !== "number" ||
          typeof priority !== "number" ||
          (size !== "trace" && size !== "moment" && size !== "conversation")
        ) {
          throw new Error("Unexpected analysis job shape");
        }
        return { episodeId, priority, size };
      });
    const jobsCreated = applied.enqueued.filter((entry) => entry.outcome === "created").length;
    if (jobs.length !== jobsCreated) throw new Error("Analysis job accounting disagrees with DB");

    const counts = { trace: 0, moment: 0, conversation: 0 };
    const episodes = result.plan.writes.map((write) => {
      counts[write.size] += 1;
      let helperVoicedMs = 0;
      let hasSlice = false;
      for (const member of write.members) {
        const region = byId.get(member.regionId);
        if (region === undefined) throw new Error("Episode references an unknown region");
        if (member.sliceStart !== region.speechStartSample || member.sliceEnd !== null) {
          // The helper lacks per-frame positions, so do not invent how its
          // voicedMs should be distributed across a split region.
          hasSlice = true;
        }
        helperVoicedMs += region.voicedMs;
      }
      return {
        groupingKey: write.groupingKey,
        size: write.size,
        context: write.context,
        closed: write.close,
        productVoicedMs: write.voicedMs,
        helperVoicedMs: hasSlice ? null : helperVoicedMs,
        helperVoicedAttribution: hasSlice ? "unknown-with-slices" : "whole-regions",
        startMs: write.startedAtMs - BOOT_WALL_MS,
        endMs: write.endedAtMs === null ? null : write.endedAtMs - BOOT_WALL_MS,
        members: write.members,
        kindInputs: write.kindInputs,
      };
    });

    return {
      mode: "closed-stream-reconstruction" as const,
      groupingVersion: result.plan.groupingVersion,
      classifierVersion: result.plan.classifierVersion,
      sourceKind,
      audioDurationMs,
      logicalQuietMs,
      regionCount: regions.length,
      helperVoicedMs: input.regions.reduce((sum, region) => sum + region.voicedMs, 0),
      productVoicedMs: episodes.reduce((sum, episode) => sum + episode.productVoicedMs, 0),
      counts,
      openCount: result.openAfter,
      closedCount: episodes.filter((episode) => episode.closed).length,
      episodes,
      jobsCreated,
      traceJobsCreated: jobs.filter((job) => job.priority === analysisPriorities.trace).length,
      otherJobsCreated: jobs.filter((job) => job.priority !== analysisPriorities.trace).length,
      jobs,
      transcriptionsExecuted: 0,
      // Closed trace candidates have real queued jobs above. This pool does
      // not measure work executable within a warm residency window: duration,
      // admission and inference are not simulated.
      warmTraceCandidates: episodes.filter((episode) => episode.closed && episode.size === "trace")
        .length,
      warmTracePolicy: "candidate-pool-execution-not-measured" as const,
    };
  } finally {
    db.close();
  }
}

function validate(input: EpisodeCountInput): void {
  if (input.sampleRate !== 16_000) throw new RangeError("Helper output must be 16 kHz");
  if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 0) {
    throw new RangeError("Invalid output sample count");
  }
  if (input.quietMs !== undefined && (!Number.isSafeInteger(input.quietMs) || input.quietMs < 0)) {
    throw new RangeError("quietMs must be a non-negative safe integer");
  }
  const audioDurationMs = (input.sampleCount * 1000) / input.sampleRate;
  for (const call of input.calls ?? []) {
    if (
      call.bundleId.trim().length === 0 ||
      !Number.isSafeInteger(call.startMs) ||
      call.startMs < 0 ||
      call.startMs > audioDurationMs ||
      (call.endMs !== null &&
        (!Number.isSafeInteger(call.endMs) ||
          call.endMs < call.startMs ||
          call.endMs > audioDurationMs))
    ) {
      throw new RangeError("Invalid or out-of-file synthetic call interval");
    }
  }
  let previousEnd = -1;
  for (const region of input.regions.toSorted(
    (a, b) => a.speechStartSample - b.speechStartSample,
  )) {
    if (
      !Number.isSafeInteger(region.speechStartSample) ||
      !Number.isSafeInteger(region.speechEndSample) ||
      region.speechStartSample < 0 ||
      region.speechEndSample < region.speechStartSample ||
      Math.max(region.speechEndSample, region.speechStartSample + 1) > input.sampleCount ||
      region.speechStartSample < previousEnd
    ) {
      throw new RangeError("Invalid, overlapping or out-of-file speech bounds");
    }
    if (!Number.isFinite(region.voicedMs) || region.voicedMs < 0) {
      throw new RangeError("Invalid helper voicedMs");
    }
    previousEnd = Math.max(region.speechEndSample, region.speechStartSample + 1);
  }
}
