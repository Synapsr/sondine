import { GROUPING_V4, type EchoSpan, type EchoTracks } from "@sondine/core";
import {
  speechPostRollMs,
  speechPreRollMs,
  type AnalysisInput,
  type AnalysisRegion,
  type SegmentInput,
  type TurnInput,
  type WordTiming,
} from "@sondine/db";
import type { AsrResult, AsrSegment, AsrToken } from "@sondine/engines";

// ADR 016, "Requests" and "Mapping back". Pure: the scheduler reads the
// input and the audio, and calls the engine.

/** The longest audio one request carries. */
export const MAX_REQUEST_MS = 55 * 60_000;

/** A stretch of one track run sent to the engine, in run samples, half-open. */
export interface Extent {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

/** One engine request: one source track, extents in capture order. */
export interface RequestPlan {
  readonly trackKey: string;
  /** 1-based within its track. */
  readonly index: number;
  /**
   * The request in speaker labels: its index, then `.1` or `.2` for each
   * half a `model_limit` split made (`3.2.1`).
   */
  readonly name: string;
  readonly sampleRate: number;
  readonly extents: readonly Extent[];
  /** Speech inside the extents (region slices without roll), for cutting at silences. */
  readonly speech: readonly Extent[];
  /** Total samples sent: the sum of the extents. */
  readonly samples: number;
}

interface Span {
  from: number;
  to: number;
}

interface WorkingExtent {
  readonly trackRunId: number;
  from: number;
  to: number;
  /** Speech (region slices without roll) inside, for cutting at silences. */
  readonly speech: Span[];
}

interface RunGroup {
  readonly trackRunId: number;
  readonly startedWallMs: number;
  readonly sampleRate: number;
  readonly runSampleEnd: number | null;
  readonly spans: { readonly speech: Span; readonly sent: Span }[];
}

/**
 * Builds each source track's requests: region slices widened by roll (only at
 * a region's own edges), merged when closer than the grouping gap, never
 * across a run change, minus deleted ranges, then cut into requests of at most
 * 55 min (or the engine's limit, when shorter: Parakeet takes 10 min) at the
 * longest silence between regions, else at that length.
 */
export function planRequests(
  input: AnalysisInput,
  options: {
    readonly maxRequestSeconds?: number;
    /** No roll before a run's first speech or after its last: what is there may be another episode's. */
    readonly speechOnly?: boolean;
  } = {},
): RequestPlan[] {
  const maxRequestMs = Math.min(MAX_REQUEST_MS, (options.maxRequestSeconds ?? Infinity) * 1000);
  const gapMs = Number(
    (input.context === "media" ? GROUPING_V4.mediaGapNs : GROUPING_V4.inPersonGapNs) / 1_000_000n,
  );
  const byTrack = new Map<string, Map<number, RunGroup>>();
  for (const region of input.regions) {
    const spans = regionSpans(region);
    if (spans === null) continue;
    const runs = byTrack.get(region.trackKey) ?? new Map<number, RunGroup>();
    const run = runs.get(region.trackRunId) ?? {
      trackRunId: region.trackRunId,
      startedWallMs: region.runStartedWallMs,
      sampleRate: region.sampleRate,
      runSampleEnd: region.runSampleEnd,
      spans: [],
    };
    run.spans.push(spans);
    runs.set(region.trackRunId, run);
    byTrack.set(region.trackKey, runs);
  }

  const requests: RequestPlan[] = [];
  for (const trackKey of [...byTrack.keys()].toSorted()) {
    const runs = [...(byTrack.get(trackKey)?.values() ?? [])].toSorted(
      (a, b) => a.startedWallMs - b.startedWallMs || a.trackRunId - b.trackRunId,
    );
    const sampleRate = runs[0]?.sampleRate ?? 16_000;
    const extents = runs.flatMap((run) =>
      subtractDeleted(
        mergeRun(
          options.speechOnly === true ? withoutOuterRoll(run) : run,
          Math.round((gapMs * run.sampleRate) / 1000),
        ),
        input.deleted.get(run.trackRunId) ?? [],
      ),
    );
    const maxSamples = Math.round((maxRequestMs * sampleRate) / 1000);
    cutRequests(extents, maxSamples).forEach((parts, index) => {
      requests.push(
        toPlan({ trackKey, index: index + 1, name: String(index + 1), sampleRate }, parts),
      );
    });
  }
  return requests;
}

/** The longest audio one near-live request carries; a longer unit goes in pieces. */
export const MAX_LIVE_UNIT_MS = 5 * 60_000;

/** A near-live request: one finished stretch of speech of one track run. */
export interface LiveUnit extends Extent {
  readonly trackKey: string;
  readonly sampleRate: number;
  /** Stable while the stretch does not change: what its text is cached under. */
  readonly key: string;
}

/**
 * Near-live units (architecture §10): each finished region slice with its
 * roll, merged with a neighbour only where their rolls overlap (so no speech
 * goes twice), minus deleted ranges, in pieces of at most `MAX_LIVE_UNIT_MS`.
 * Unlike final requests, nearby regions stay apart, so a new sentence never
 * sends the ones before it again. Open slices wait for their end.
 */
export function planLiveUnits(input: AnalysisInput): LiveUnit[] {
  const runs = new Map<number, RunGroup & { readonly trackKey: string }>();
  for (const region of input.regions) {
    const spans = regionSpans(region);
    if (spans === null) continue;
    const run = runs.get(region.trackRunId) ?? {
      trackRunId: region.trackRunId,
      trackKey: region.trackKey,
      startedWallMs: region.runStartedWallMs,
      sampleRate: region.sampleRate,
      runSampleEnd: region.runSampleEnd,
      spans: [],
    };
    run.spans.push(spans);
    runs.set(region.trackRunId, run);
  }
  const units: LiveUnit[] = [];
  for (const run of runs.values()) {
    const max = Math.round((MAX_LIVE_UNIT_MS * run.sampleRate) / 1000);
    for (const extent of subtractDeleted(
      mergeRun(run, 0),
      input.deleted.get(run.trackRunId) ?? [],
    )) {
      for (let from = extent.from; from < extent.to; from += max) {
        const to = Math.min(extent.to, from + max);
        units.push({
          trackRunId: run.trackRunId,
          trackKey: run.trackKey,
          sampleRate: run.sampleRate,
          sampleStart: from,
          sampleEnd: to,
          key: `${run.trackRunId}:${from}:${to}`,
        });
      }
    }
  }
  return units;
}

/** The most of a sentence still being said that is sent again at each commit. */
export const MAX_OPEN_TAIL_MS = 30_000;

/**
 * The sentences still being said (open region slices), each up to what is
 * imported (`watermarks`, by run), with its pre-roll, minus deleted ranges,
 * at most the last `MAX_OPEN_TAIL_MS`: what near-live text shows as the line
 * being said, until the sentence ends and becomes a unit.
 */
export function openLiveTails(
  input: AnalysisInput,
  watermarks: ReadonlyMap<number, number>,
): LiveUnit[] {
  const tails: LiveUnit[] = [];
  for (const region of input.regions) {
    if (region.sampleEnd !== null || region.sliceEnd !== null) continue;
    const rate = region.sampleRate;
    const pre =
      region.sliceStart <= region.sampleStart ? Math.round((speechPreRollMs * rate) / 1000) : 0;
    const to = watermarks.get(region.trackRunId) ?? 0;
    const from = Math.max(
      0,
      region.sliceStart - pre,
      to - Math.round((MAX_OPEN_TAIL_MS * rate) / 1000),
    );
    if (to - from < rate) continue;
    const working: WorkingExtent = {
      trackRunId: region.trackRunId,
      from,
      to,
      speech: [{ from, to }],
    };
    for (const piece of subtractDeleted([working], input.deleted.get(region.trackRunId) ?? [])) {
      tails.push({
        trackRunId: region.trackRunId,
        trackKey: region.trackKey,
        sampleRate: rate,
        sampleStart: piece.from,
        sampleEnd: piece.to,
        key: `${region.trackRunId}:${piece.from}:${piece.to}`,
      });
    }
  }
  return tails;
}

function toPlan(
  head: Pick<RequestPlan, "trackKey" | "index" | "name" | "sampleRate">,
  parts: readonly WorkingExtent[],
): RequestPlan {
  const extents = parts.map((part) => ({
    trackRunId: part.trackRunId,
    sampleStart: part.from,
    sampleEnd: part.to,
  }));
  return {
    ...head,
    extents,
    speech: parts.flatMap((part) =>
      part.speech
        .toSorted((a, b) => a.from - b.from)
        .map((span) => ({
          trackRunId: part.trackRunId,
          sampleStart: span.from,
          sampleEnd: span.to,
        })),
    ),
    samples: extents.reduce((sum, extent) => sum + extent.sampleEnd - extent.sampleStart, 0),
  };
}

/** A request's extents back as working extents, each with the speech it holds. */
function workingExtentsOf(plan: RequestPlan): WorkingExtent[] {
  return plan.extents.map((extent) => ({
    trackRunId: extent.trackRunId,
    from: extent.sampleStart,
    to: extent.sampleEnd,
    speech: plan.speech.flatMap((span) => {
      if (span.trackRunId !== extent.trackRunId) return [];
      const clipped = {
        from: Math.max(span.sampleStart, extent.sampleStart),
        to: Math.min(span.sampleEnd, extent.sampleEnd),
      };
      return clipped.to > clipped.from ? [clipped] : [];
    }),
  }));
}

/** The shortest part a `model_limit` split may make. */
export const MIN_SPLIT_MS = 60_000;

/** How many times a request may be halved after `model_limit`. */
export const MAX_SPLIT_DEPTH = 3;

export interface RequestSplit {
  readonly parts: readonly [RequestPlan, RequestPlan];
  /** Request offset where the second part starts: its audio is the request's from here. */
  readonly at: number;
}

/**
 * Halves a request the engine truncated (`model_limit`): at the longest
 * silence between regions in its middle half (a capture restart first; the
 * one nearest the middle on a tie), else at the middle. Null when a part
 * would be shorter than `minMs`.
 */
export function splitRequest(plan: RequestPlan, minMs = MIN_SPLIT_MS): RequestSplit | null {
  const minSamples = Math.round((minMs * plan.sampleRate) / 1000);
  if (plan.samples < 2 * minSamples) return null;
  const extents = workingExtentsOf(plan);
  const middle = plan.samples / 2;
  const low = Math.max(minSamples, Math.ceil(plan.samples / 4));
  const high = Math.min(plan.samples - minSamples, Math.floor((plan.samples * 3) / 4));
  let best: Cut | null = null;
  for (const cut of cutsOf(extents)) {
    if (cut.silence <= 0 || cut.at < low || cut.at > high) continue;
    if (
      best === null ||
      cut.silence > best.silence ||
      (cut.silence === best.silence && Math.abs(cut.at - middle) < Math.abs(best.at - middle))
    ) {
      best = cut;
    }
  }
  const at = best?.at ?? Math.round(middle);
  const [first, second] = splitAt(extents, [at]);
  if (first === undefined || second === undefined) return null;
  const head = { trackKey: plan.trackKey, index: plan.index, sampleRate: plan.sampleRate };
  return {
    parts: [
      toPlan({ ...head, name: `${plan.name}.1` }, first),
      toPlan({ ...head, name: `${plan.name}.2` }, second),
    ],
    at,
  };
}

function regionSpans(region: AnalysisRegion): { speech: Span; sent: Span } | null {
  const regionEnd = region.sampleEnd;
  const from = region.sliceStart;
  const to = region.sliceEnd ?? regionEnd;
  // An open slice has no end yet: a closed episode never holds one.
  if (to === null || to <= from) return null;
  const rate = region.sampleRate;
  const pre = from <= region.sampleStart ? Math.round((speechPreRollMs * rate) / 1000) : 0;
  const post =
    regionEnd !== null && to >= regionEnd ? Math.round((speechPostRollMs * rate) / 1000) : 0;
  const limit = region.runSampleEnd ?? Number.POSITIVE_INFINITY;
  return {
    speech: { from, to },
    sent: { from: Math.max(0, from - pre), to: Math.min(limit, to + post) },
  };
}

function withoutOuterRoll(run: RunGroup): RunGroup {
  const from = Math.min(...run.spans.map(({ speech }) => speech.from));
  const to = Math.max(...run.spans.map(({ speech }) => speech.to));
  return {
    ...run,
    spans: run.spans.map(({ speech, sent }) => ({
      speech,
      sent: { from: Math.max(sent.from, from), to: Math.min(sent.to, to) },
    })),
  };
}

function mergeRun(run: RunGroup, gapSamples: number): WorkingExtent[] {
  const sorted = run.spans.toSorted((a, b) => a.sent.from - b.sent.from);
  const out: WorkingExtent[] = [];
  for (const { speech, sent } of sorted) {
    const last = out.at(-1);
    if (last !== undefined && sent.from - last.to < gapSamples) {
      last.to = Math.max(last.to, sent.to);
      last.speech.push({ ...speech });
    } else {
      out.push({
        trackRunId: run.trackRunId,
        from: sent.from,
        to: sent.to,
        speech: [{ ...speech }],
      });
    }
  }
  return out;
}

/** Removes tombstoned samples; an extent split by one becomes two. */
function subtractDeleted(
  extents: readonly WorkingExtent[],
  deleted: readonly (readonly [number, number])[],
): WorkingExtent[] {
  let pieces = [...extents];
  for (const [from, to] of deleted) {
    pieces = pieces.flatMap((extent): WorkingExtent[] => {
      if (to <= extent.from || from >= extent.to) return [extent];
      const out: WorkingExtent[] = [];
      const keep = (a: number, b: number) => {
        if (b <= a) return;
        out.push({
          trackRunId: extent.trackRunId,
          from: a,
          to: b,
          speech: extent.speech.flatMap((span) => {
            const clipped = { from: Math.max(span.from, a), to: Math.min(span.to, b) };
            return clipped.to > clipped.from ? [clipped] : [];
          }),
        });
      };
      keep(extent.from, Math.min(from, extent.to));
      keep(Math.max(to, extent.from), extent.to);
      return out;
    });
  }
  return pieces.filter((extent) => extent.to > extent.from);
}

interface Cut {
  /** Offset in the track's concatenated audio. */
  readonly at: number;
  /** Silence between the regions on either side; run changes rank highest. */
  readonly silence: number;
}

/**
 * Splits a track's extents into requests of at most `maxSamples`: each cut
 * goes to the longest silence between regions within reach (the latest on a
 * tie), else exactly at the limit.
 */
function cutRequests(extents: readonly WorkingExtent[], maxSamples: number): WorkingExtent[][] {
  const total = extents.reduce((sum, extent) => sum + extent.to - extent.from, 0);
  if (total <= maxSamples) return extents.length === 0 ? [] : [[...extents]];

  const cuts = cutsOf(extents);
  const points: number[] = [];
  let start = 0;
  while (total - start > maxSamples) {
    let best: Cut | null = null;
    for (const cut of cuts) {
      if (cut.at <= start || cut.at > start + maxSamples) continue;
      if (
        best === null ||
        cut.silence > best.silence ||
        (cut.silence === best.silence && cut.at > best.at)
      ) {
        best = cut;
      }
    }
    const at = best === null || best.silence <= 0 ? start + maxSamples : best.at;
    points.push(at);
    start = at;
  }
  return splitAt(extents, points);
}

/** Where a track's concatenated extents may be cut: silences between regions, and extent boundaries. */
function cutsOf(extents: readonly WorkingExtent[]): Cut[] {
  const cuts: Cut[] = [];
  let offset = 0;
  extents.forEach((extent, index) => {
    const speech = extent.speech.toSorted((a, b) => a.from - b.from);
    for (let i = 1; i < speech.length; i++) {
      const before = speech[i - 1];
      const after = speech[i];
      if (before === undefined || after === undefined || after.from <= before.to) continue;
      cuts.push({
        at: offset + Math.floor((before.to + after.from) / 2) - extent.from,
        silence: after.from - before.to,
      });
    }
    offset += extent.to - extent.from;
    const next = extents[index + 1];
    if (next === undefined) return;
    const lastSpeech = speech.at(-1)?.to ?? extent.to;
    const nextSpeech = next.speech.reduce((min, span) => Math.min(min, span.from), next.from);
    cuts.push({
      at: offset,
      silence:
        next.trackRunId === extent.trackRunId
          ? Math.max(0, nextSpeech - lastSpeech)
          : Number.MAX_SAFE_INTEGER,
    });
  });
  return cuts;
}

function splitAt(extents: readonly WorkingExtent[], points: readonly number[]): WorkingExtent[][] {
  const requests: WorkingExtent[][] = [[]];
  let offset = 0;
  let pointIndex = 0;
  for (const extent of extents) {
    let from = extent.from;
    while (from < extent.to) {
      const point = points[pointIndex];
      const limit = point === undefined ? Number.POSITIVE_INFINITY : point - offset;
      const to = Math.min(extent.to, from + Math.max(0, limit));
      if (to > from) {
        const speech = extent.speech.flatMap((span) => {
          const clipped = { from: Math.max(span.from, from), to: Math.min(span.to, to) };
          return clipped.to > clipped.from ? [clipped] : [];
        });
        requests.at(-1)?.push({ ...extent, from, to, speech });
        offset += to - from;
        from = to;
      }
      if (point !== undefined && offset >= point) {
        requests.push([]);
        pointIndex += 1;
      }
    }
  }
  return requests.filter((request) => request.length > 0);
}

// Mapping back

export interface MapContext {
  /** Wall-clock ms of a run sample. */
  readonly wallMsAt: (trackRunId: number, sample: number) => number;
  /** One voice per track (a dictation): every segment gets the track's only label, whatever its request. */
  readonly oneVoice?: boolean;
}

/** The label of a track's only voice, the same in every request and split. */
export const ONE_VOICE = "voice";

interface Placed {
  readonly extent: Extent;
  /** Request offset of the extent's first sample. */
  readonly offset: number;
}

/**
 * Places the engine's segments back on their track runs. Token times place
 * each word in its extent; a segment that crosses an extent boundary is split
 * there by its tokens, so no output covers audio that was not sent; word
 * times stay inside their segment. Speaker labels are
 * `<trackKey>/<request>/<n>`, `n` from 1, the request named as in
 * `RequestPlan.name`.
 */
export function mapResult(
  request: RequestPlan,
  result: AsrResult,
  context: MapContext,
): SegmentInput[] {
  const layout: Placed[] = [];
  let offset = 0;
  for (const extent of request.extents) {
    layout.push({ extent, offset });
    offset += extent.sampleEnd - extent.sampleStart;
  }
  const rate = request.sampleRate;
  const total = offset;
  const toSample = (sec: number) => Math.min(total, Math.max(0, Math.round(sec * rate)));
  const placeOf = (sample: number): Placed | undefined => {
    let found = layout[0];
    for (const placed of layout) {
      if (placed.offset <= sample) found = placed;
      else break;
    }
    return found;
  };
  const lang = result.languages[0] ?? null;

  const out: SegmentInput[] = [];
  for (const segment of result.segments) {
    const label =
      context.oneVoice === true
        ? `${request.trackKey}/${ONE_VOICE}/1`
        : segment.speaker === null
          ? null
          : `${request.trackKey}/${request.name}/${segment.speaker + 1}`;
    for (const piece of piecesOf(segment, toSample, placeOf)) {
      const extent = piece.placed.extent;
      const length = extent.sampleEnd - extent.sampleStart;
      const local = (sample: number) => Math.min(length, Math.max(0, sample - piece.placed.offset));
      const sampleStart = extent.sampleStart + local(piece.start);
      const sampleEnd = Math.max(sampleStart, extent.sampleStart + local(piece.end));
      const startMs = context.wallMsAt(extent.trackRunId, sampleStart);
      const endMs = Math.max(startMs, context.wallMsAt(extent.trackRunId, sampleEnd));
      const { text, words } = joinTokens(
        piece.tokens,
        toSample,
        { start: piece.start, end: Math.max(piece.start, piece.end) },
        rate,
      );
      const body = piece.tokens.length === 0 ? segment.text.trim() : text;
      if (body.length === 0) continue;
      out.push({
        trackRunId: extent.trackRunId,
        sampleStart,
        sampleEnd,
        startMs,
        endMs,
        text: body,
        speakerLabel: label,
        lang,
        words: piece.tokens.length === 0 ? null : words,
      });
    }
  }
  return out.toSorted((a, b) => a.startMs - b.startMs || a.trackRunId - b.trackRunId);
}

interface Piece {
  readonly placed: Placed;
  /** Request offsets, clamped to the piece's extent. */
  readonly start: number;
  readonly end: number;
  readonly tokens: readonly AsrToken[];
}

function piecesOf(
  segment: AsrSegment,
  toSample: (sec: number) => number,
  placeOf: (sample: number) => Placed | undefined,
): Piece[] {
  const clamp = (placed: Placed, sample: number) =>
    Math.min(
      placed.offset + placed.extent.sampleEnd - placed.extent.sampleStart,
      Math.max(placed.offset, sample),
    );
  if (segment.tokens.length === 0) {
    const start = toSample(segment.startSec);
    const end = toSample(segment.endSec);
    const placed = placeOf(Math.floor((start + end) / 2));
    if (placed === undefined) return [];
    return [{ placed, start: clamp(placed, start), end: clamp(placed, end), tokens: [] }];
  }
  const pieces: { placed: Placed; tokens: AsrToken[] }[] = [];
  for (const token of segment.tokens) {
    const mid = toSample((token.startSec + token.endSec) / 2);
    const placed = placeOf(mid);
    if (placed === undefined) continue;
    const last = pieces.at(-1);
    if (last !== undefined && last.placed === placed) last.tokens.push(token);
    else pieces.push({ placed, tokens: [token] });
  }
  return pieces.map(({ placed, tokens }) => {
    const first = tokens[0];
    const lastToken = tokens.at(-1);
    return {
      placed,
      start: clamp(placed, toSample(first?.startSec ?? 0)),
      end: clamp(placed, toSample(lastToken?.endSec ?? 0)),
      tokens,
    };
  });
}

/**
 * A piece's text from its tokens, with word timings relative to the segment
 * start. Token times are clamped to the piece first, so no word leaves its
 * segment; a token entirely outside the piece is dropped.
 */
function joinTokens(
  tokens: readonly AsrToken[],
  toSample: (sec: number) => number,
  bounds: { readonly start: number; readonly end: number },
  rate: number,
): { text: string; words: WordTiming[] } {
  let text = "";
  const words: WordTiming[] = [];
  const clamp = (sample: number) => Math.min(bounds.end, Math.max(bounds.start, sample));
  const msFrom = (sample: number) => Math.round(((clamp(sample) - bounds.start) * 1000) / rate);
  for (const token of tokens) {
    const tokenStart = toSample(token.startSec);
    const tokenEnd = toSample(token.endSec);
    if (tokenEnd < bounds.start || tokenStart > bounds.end) continue;
    const piece = text.length === 0 ? token.text.trimStart() : token.text;
    const lead = piece.length - piece.trimStart().length;
    const charStart = text.length + lead;
    text += piece;
    const charEnd = text.trimEnd().length;
    if (charEnd <= charStart) continue;
    const startMs = msFrom(tokenStart);
    words.push({ charStart, charEnd, startMs, endMs: Math.max(startMs, msFrom(tokenEnd)) });
  }
  const trimmed = text.trimEnd();
  return {
    text: trimmed,
    words: words.map((word) => ({ ...word, charEnd: Math.min(word.charEnd, trimmed.length) })),
  };
}

/**
 * Which track runs of a pass hear the room (a microphone: `input:` tracks)
 * and which carry sound the Mac played (`system:` and `app:` tracks), for
 * echo removal.
 */
export function echoTracks(plans: readonly RequestPlan[]): EchoTracks {
  const heard = new Set<number>();
  const played = new Set<number>();
  for (const plan of plans) {
    const into = plan.trackKey.startsWith("input:")
      ? heard
      : plan.trackKey.startsWith("system:") || plan.trackKey.startsWith("app:")
        ? played
        : null;
    for (const extent of plan.extents) into?.add(extent.trackRunId);
  }
  return { heard, played };
}

/**
 * Turns without the stretches echo removal took (`removeEcho`): a turn of
 * the far side heard on the mic goes, one of the user's keeps its parts
 * around the echo, its times kept in step with its samples.
 */
export function cutTurns(turns: readonly TurnInput[], spans: readonly EchoSpan[]): TurnInput[] {
  if (spans.length === 0) return [...turns];
  return turns.flatMap((turn) => {
    let parts: [number, number][] = [[turn.sampleStart, turn.sampleEnd]];
    for (const span of spans) {
      if (span.trackRunId !== turn.trackRunId) continue;
      parts = parts.flatMap(([a, b]): [number, number][] =>
        span.sampleEnd <= a || span.sampleStart >= b
          ? [[a, b]]
          : [
              ...(span.sampleStart > a ? [[a, span.sampleStart] as [number, number]] : []),
              ...(span.sampleEnd < b ? [[span.sampleEnd, b] as [number, number]] : []),
            ],
      );
    }
    const msPerSample =
      (turn.endMs - turn.startMs) / Math.max(1, turn.sampleEnd - turn.sampleStart);
    const msAt = (sample: number) =>
      turn.startMs + Math.round((sample - turn.sampleStart) * msPerSample);
    return parts
      .map(([a, b]) => ({
        ...turn,
        sampleStart: a,
        sampleEnd: b,
        startMs: msAt(a),
        endMs: msAt(b),
      }))
      .filter((part) => part.endMs > part.startMs);
  });
}

/**
 * Turns from consecutive same-speaker segments of a run: pauses under 2 s
 * join, but never across extents, whose gaps hold audio that was not sent
 * (deleted ranges among them).
 */
export function deriveTurns(
  segments: readonly SegmentInput[],
  extents: readonly Extent[],
  sampleRate = 16_000,
): TurnInput[] {
  const joinGap = 2 * sampleRate;
  const extentOf = (segment: SegmentInput) =>
    extents.findIndex(
      (extent) =>
        extent.trackRunId === segment.trackRunId &&
        extent.sampleStart <= segment.sampleStart &&
        segment.sampleStart < extent.sampleEnd,
    );
  const byRun = new Map<number, SegmentInput[]>();
  for (const segment of segments) {
    if (segment.speakerLabel === null || segment.speakerLabel === undefined) continue;
    if (segment.sampleEnd <= segment.sampleStart) continue;
    const list = byRun.get(segment.trackRunId) ?? [];
    list.push(segment);
    byRun.set(segment.trackRunId, list);
  }
  interface Turn {
    trackRunId: number;
    sampleStart: number;
    sampleEnd: number;
    startMs: number;
    endMs: number;
    speakerLabel: string;
  }
  const turns: Turn[] = [];
  for (const list of byRun.values()) {
    let current: Turn | undefined;
    let currentExtent = -1;
    for (const segment of list.toSorted((a, b) => a.sampleStart - b.sampleStart)) {
      const label = segment.speakerLabel ?? "";
      const extent = extentOf(segment);
      if (
        current !== undefined &&
        current.speakerLabel === label &&
        extent === currentExtent &&
        segment.sampleStart - current.sampleEnd <= joinGap
      ) {
        current.sampleEnd = Math.max(current.sampleEnd, segment.sampleEnd);
        current.endMs = Math.max(current.endMs, segment.endMs);
        continue;
      }
      current = {
        trackRunId: segment.trackRunId,
        sampleStart: segment.sampleStart,
        sampleEnd: segment.sampleEnd,
        startMs: segment.startMs,
        endMs: segment.endMs,
        speakerLabel: label,
      };
      currentExtent = extent;
      turns.push(current);
    }
  }
  return turns.toSorted((a, b) => a.startMs - b.startMs);
}
