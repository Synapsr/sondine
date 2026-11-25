import type { AnalysisInput } from "@sondine/db";
import { BYTES_PER_SAMPLE, SAMPLE_RATE } from "@sondine/protocol";
import { planRequests, type Extent, type RequestPlan } from "../analysis/requests";
import type { ReadTrackAudio } from "./track-audio";

// An episode's audio for playback, as a mono 16 kHz PCM16 WAV that exists
// only as a plan: the extents transcription would send (region slices with
// roll, deleted ranges cut out, ADR 016), every track placed on one
// wall-clock timeline. A byte range is mixed on demand from the samples it
// covers and nothing else: deleted ranges are never read, missing audio and
// the time between extents are silent. Never written to disk, never logged.

export const WAV_HEADER_BYTES = 44;

/** An extent and where its first sample sits on the timeline. */
export interface PlacedExtent extends Extent {
  readonly offset: number;
}

/** Where the timeline starts and how long it is; deleting audio never moves it. */
export interface TimelineFrame {
  /** Wall-clock ms of the timeline's first sample. */
  readonly startedAtMs: number;
  readonly samples: number;
}

/** Where the VAD heard speech, before any transcript, and on which side. */
export interface SpeechSpan {
  readonly startMs: number;
  readonly endMs: number;
  /** `microphone`: an input or phone track; `computer`: the Mac's own sound. */
  readonly track: "microphone" | "computer";
}

export interface EpisodeTimeline {
  /** Wall-clock ms of the timeline's first sample; null when there is nothing to hear. */
  readonly startedAtMs: number | null;
  /** Timeline length in samples; the WAV holds exactly this many. */
  readonly samples: number;
  /** The audible extents (deleted ranges cut out), by offset. */
  readonly extents: readonly PlacedExtent[];
  /** Speech without roll (deleted ranges cut out), by start. */
  readonly speech: readonly SpeechSpan[];
}

/** Wall-clock ms of a run sample. */
export type WallMsAt = (trackRunId: number, sample: number) => number;

/** The WAV's length in bytes, header included. */
export function wavByteLength(timeline: EpisodeTimeline): number {
  return WAV_HEADER_BYTES + timeline.samples * BYTES_PER_SAMPLE;
}

/**
 * Plans the timeline; reads no audio. Its frame comes from the extents as
 * they were before any deletion, so a deleted range (an edge included)
 * plays as silence and every other sample keeps its offset: a segment at
 * wall time `t` always plays at `(t - startedAtMs) / 1000` s. `frame` keeps
 * the frame of a plan already being played; extents outside it are cut.
 */
export function planEpisodeTimeline(
  input: AnalysisInput,
  wallMsAt: WallMsAt,
  frame?: TimelineFrame,
): EpisodeTimeline {
  const known = new Map<string, number>();
  const wall = (trackRunId: number, sample: number) => {
    const key = `${trackRunId}:${sample}`;
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const ms = wallMsAt(trackRunId, sample);
    known.set(key, ms);
    return ms;
  };
  const plans = planRequests(input);
  const audible = extentsOf(plans);
  if (audible.length === 0) {
    return frame === undefined
      ? { startedAtMs: null, samples: 0, extents: [], speech: [] }
      : { startedAtMs: frame.startedAtMs, samples: frame.samples, extents: [], speech: [] };
  }
  const outline = frame ?? frameOf(extentsOf(planRequests({ ...input, deleted: new Map() })), wall);
  const extents: PlacedExtent[] = [];
  for (const extent of audible) {
    const offset = Math.round(
      ((wall(extent.trackRunId, extent.sampleStart) - outline.startedAtMs) * SAMPLE_RATE) / 1000,
    );
    const from = Math.max(offset, 0);
    const to = Math.min(offset + extent.sampleEnd - extent.sampleStart, outline.samples);
    if (to <= from) continue;
    extents.push({
      trackRunId: extent.trackRunId,
      sampleStart: extent.sampleStart + from - offset,
      sampleEnd: extent.sampleStart + to - offset,
      offset: from,
    });
  }
  const speech = plans.flatMap((plan) =>
    plan.speech.map((span): SpeechSpan => ({
      startMs: wall(span.trackRunId, span.sampleStart),
      endMs: wall(span.trackRunId, span.sampleEnd),
      track:
        plan.trackKey.startsWith("input:") || plan.trackKey.startsWith("phone:")
          ? "microphone"
          : "computer",
    })),
  );
  return {
    startedAtMs: outline.startedAtMs,
    samples: outline.samples,
    extents: extents.toSorted((a, b) => a.offset - b.offset || a.trackRunId - b.trackRunId),
    speech: speech.toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
  };
}

function extentsOf(plans: readonly RequestPlan[]): Extent[] {
  return plans.flatMap((plan) => {
    if (plan.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Cannot mix a ${plan.sampleRate} Hz track into ${SAMPLE_RATE} Hz playback`);
    }
    return plan.extents;
  });
}

function frameOf(extents: readonly Extent[], wall: WallMsAt): TimelineFrame {
  const starts = extents.map((extent) => wall(extent.trackRunId, extent.sampleStart));
  const startedAtMs = starts.reduce((min, ms) => Math.min(min, ms), Number.POSITIVE_INFINITY);
  let samples = 0;
  extents.forEach((extent, index) => {
    const offset = Math.round(
      (((starts[index] ?? startedAtMs) - startedAtMs) * SAMPLE_RATE) / 1000,
    );
    samples = Math.max(samples, offset + extent.sampleEnd - extent.sampleStart);
  });
  return { startedAtMs, samples };
}

/**
 * Bytes `[start, end)` of the timeline's WAV, in a buffer of exactly that
 * length: header bytes from the header, PCM from the samples the range
 * covers (a range may start or end inside a sample).
 */
export function readTimelineBytes(
  timeline: EpisodeTimeline,
  read: ReadTrackAudio,
  start: number,
  end: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new RangeError(`Invalid byte range [${start}, ${end})`);
  }
  if (start < 0 || end < start || end > wavByteLength(timeline)) {
    throw new RangeError(`Byte range [${start}, ${end}) is outside the WAV`);
  }
  const out = new Uint8Array(end - start);
  if (start < WAV_HEADER_BYTES) {
    const header = new Uint8Array(WAV_HEADER_BYTES);
    writeWavHeader(header, timeline.samples);
    out.set(header.subarray(start, Math.min(end, WAV_HEADER_BYTES)));
  }
  const dataStart = Math.max(start, WAV_HEADER_BYTES) - WAV_HEADER_BYTES;
  const dataEnd = end - WAV_HEADER_BYTES;
  if (dataEnd <= dataStart) return out;
  const first = Math.floor(dataStart / BYTES_PER_SAMPLE);
  const last = Math.ceil(dataEnd / BYTES_PER_SAMPLE);
  const mix = mixTimeline(timeline, read, first, last);
  // WAV samples are little-endian, like the spool and every Mac Sondine runs on.
  const pcm = new Uint8Array(mix.buffer, dataStart - first * BYTES_PER_SAMPLE, dataEnd - dataStart);
  out.set(pcm, WAV_HEADER_BYTES + dataStart - start);
  return out;
}

/**
 * Timeline samples `[from, to)`: each extent that crosses them is read for
 * that stretch only, the tracks summed and clamped to int16 once, so
 * overlapping tracks never wrap and the order they are read in never matters.
 */
export function mixTimeline(
  timeline: EpisodeTimeline,
  read: ReadTrackAudio,
  from: number,
  to: number,
): Int16Array<ArrayBuffer> {
  const sum = new Int32Array(Math.max(0, to - from));
  for (const extent of timeline.extents) {
    if (extent.offset >= to) break;
    const a = Math.max(from, extent.offset);
    const b = Math.min(to, extent.offset + extent.sampleEnd - extent.sampleStart);
    if (b <= a) continue;
    const audio = read({
      trackRunId: extent.trackRunId,
      sampleStart: extent.sampleStart + a - extent.offset,
      sampleEnd: extent.sampleStart + b - extent.offset,
    });
    if (audio.samples.length !== b - a) {
      throw new Error("The audio reader returned a wrong length");
    }
    const at = a - from;
    for (let i = 0; i < audio.samples.length; i++) {
      sum[at + i] = (sum[at + i] ?? 0) + (audio.samples[i] ?? 0);
    }
  }
  const mix = new Int16Array(sum.length);
  for (let i = 0; i < sum.length; i++) {
    const value = sum[i] ?? 0;
    mix[i] = value > 32_767 ? 32_767 : value < -32_768 ? -32_768 : value;
  }
  return mix;
}

/** A canonical 44-byte RIFF/WAVE header for mono 16-bit PCM at 16 kHz. */
export function writeWavHeader(bytes: Uint8Array, samples: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, WAV_HEADER_BYTES);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const dataBytes = samples * BYTES_PER_SAMPLE;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
}
