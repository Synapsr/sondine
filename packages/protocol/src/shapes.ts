import * as z from "zod";
import { BYTES_PER_SAMPLE } from "./constants";
import {
  ClockPoint,
  Count,
  Epoch,
  LevelStats,
  RegionCloseReason,
  SampleIndex,
  SpeechProbability,
  Uint32,
  Uuid,
  spoolBytes,
} from "./primitives";
import { described } from "./registry";

// Field groups and cross-field checks shared by events and manifest records.

export const commitShape = {
  seq: described("Commit number within the PCM file, starting at 0.", Count),
  epoch: Epoch,
  committedOffset: described(
    "Durable byte length of the PCM file after this commit. The block is [committedOffset - sampleCount × 2, committedOffset).",
    Count,
  ),
  sampleIndex: described("Run sample index of the block's first sample.", SampleIndex),
  sampleCount: described("Samples in the block.", z.int().min(1)),
  crc32: described("CRC-32/ISO-HDLC (as zlib's crc32) of the block's bytes.", Uint32),
  at: described("Clock of the block's first sample.", ClockPoint),
};

export function checkCommit(
  commit: { committedOffset: number; sampleCount: number },
  ctx: z.RefinementCtx,
): void {
  if (commit.committedOffset < spoolBytes(commit.sampleCount)) {
    ctx.addIssue({
      code: "custom",
      path: ["committedOffset"],
      message: "committedOffset must be >= sampleCount × 2",
    });
  } else if (commit.committedOffset % BYTES_PER_SAMPLE !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["committedOffset"],
      message: "committedOffset must be a whole number of samples",
    });
  }
}

export const regionSpanShape = {
  regionId: Uuid,
  startSample: described("Run sample index where speech starts, without pre-roll.", SampleIndex),
  endSample: described(
    "Run sample index after the last speech sample, without post-roll; > startSample.",
    SampleIndex,
  ),
  voicedSamples: described(
    "Samples the VAD heard as speech between the bounds, which also hold pauses shorter than the minimum silence; <= endSample - startSample. Absent from manifests written before it existed.",
    Count,
  ).optional(),
  closeReason: RegionCloseReason,
  speechProbability: SpeechProbability,
  level: LevelStats,
};

export function checkRegionSpan(
  region: { startSample: number; endSample: number; voicedSamples?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  if (region.endSample <= region.startSample) {
    ctx.addIssue({
      code: "custom",
      path: ["endSample"],
      message: "endSample must be > startSample",
    });
  } else if (
    region.voicedSamples !== undefined &&
    region.voicedSamples > region.endSample - region.startSample
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["voicedSamples"],
      message: "voicedSamples must be <= endSample - startSample",
    });
  }
}

/** Reports every entry of `items` whose `key` already appeared. */
export function checkUnique<T>(
  items: readonly T[],
  key: (item: T) => unknown,
  path: readonly PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<unknown>();
  items.forEach((item, index) => {
    const value = key(item);
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path: [...path, index], message: "duplicate entry" });
    }
    seen.add(value);
  });
}
