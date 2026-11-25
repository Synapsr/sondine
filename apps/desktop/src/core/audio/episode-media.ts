import { loadAnalysisInput, wallMsAtSample, type Database as CoreDatabase } from "@sondine/db";
import { SAMPLE_RATE } from "@sondine/protocol";
import { Context, Effect, Layer } from "effect";
import { MEDIA_SLICE_BYTES, resolveByteRange } from "../../shared/byte-range";
import type { CoreToMain, MediaFailure, MediaReadRequest } from "../../shared/core-messages";
import { TrackAudioSource } from "../analysis/analysis-layer";
import { Database } from "../database";
import { log } from "../log";
import {
  planEpisodeTimeline,
  readTimelineBytes,
  wavByteLength,
  type EpisodeTimeline,
  type SpeechSpan,
} from "./episode-wav";
import { errorCode } from "./pcm-io";
import type { ReadTrackAudio } from "./track-audio";

// Playback for the `sondine-media:` scheme (architecture §11). `playback`
// plans an episode's timeline (no audio read) for `episodes.playback`;
// `read` serves one slice of its WAV for a `media-read` from main. Every
// read checks the episode, its generation and the deletions first, in the
// same synchronous step as the audio read, so nothing can be deleted
// between the check and the read: after a deletion the next read answers
// `not-found`, and no deleted sample is ever asked of the reader. Reads run
// one at a time, each in its own turn of the event loop, at most
// `MAX_MEDIA_JOBS` waiting; a slice is at most `MEDIA_SLICE_BYTES`. Nothing
// is cached but the plans, never the audio.

/** Plans kept, most recently used first: a few episodes being played or skipped between. */
export const MEDIA_TIMELINE_CACHE = 8;
/** Reads waiting or running; more are refused (`busy`). */
export const MAX_MEDIA_JOBS = 4;

export interface PlaybackPlan {
  readonly generation: number;
  /** Wall-clock ms of the timeline's first sample; null when there is nothing to hear. */
  readonly startedAtMs: number | null;
  readonly durationMs: number;
  readonly speech: readonly SpeechSpan[];
}

export type MediaReadReply =
  | {
      readonly ok: true;
      /** The WAV's length. */
      readonly total: number;
      readonly start: number;
      /** Last byte (inclusive) of the whole range asked for; `bytes` may stop earlier. */
      readonly end: number;
      readonly bytes: Uint8Array<ArrayBuffer>;
    }
  | { readonly ok: false; readonly reason: MediaFailure; readonly total: number | null };

export interface EpisodeMediaService {
  /** Plans the episode's playback; null for an unknown or deleted episode. */
  playback(episodeId: number): PlaybackPlan | null;
  read(request: MediaReadRequest): Promise<MediaReadReply>;
  /** Drops a read that has not started. */
  cancel(requestId: number): void;
  /** Refuses the reads still waiting (`unavailable`); later reads too. */
  close(): void;
}

export class EpisodeMedia extends Context.Service<EpisodeMedia, EpisodeMediaService>()(
  "sondine/core/EpisodeMedia",
) {}

export interface EpisodeMediaOptions {
  readonly db: CoreDatabase;
  /** The spool and archive reader; null when there is none. */
  readonly reader: () => ReadTrackAudio | null;
  /** Runs one unit of work as a recorded span; a plain call by default. */
  readonly trace?: <T>(name: string, work: () => T) => T;
  /** Runs the next read in a later turn, so other work runs between slices. */
  readonly defer?: (run: () => void) => void;
}

interface CachedPlan {
  readonly generation: number;
  /** The episode row's creation time: SQLite may give a deleted episode's id to a new one. */
  readonly createdAtMs: number;
  /** The newest tombstone the plan saw. */
  readonly revision: number;
  readonly timeline: EpisodeTimeline;
}

interface EpisodeRow {
  readonly state: string;
  readonly generation: number;
  readonly createdAtMs: number;
}

interface Job {
  readonly request: MediaReadRequest;
  readonly resolve: (reply: MediaReadReply) => void;
}

const failure = (reason: MediaFailure, total: number | null = null): MediaReadReply => ({
  ok: false,
  reason,
  total,
});

export function createEpisodeMedia(options: EpisodeMediaOptions): EpisodeMediaService {
  const { db } = options;
  const trace = options.trace ?? (<T>(_name: string, work: () => T) => work());
  const defer = options.defer ?? ((run: () => void) => void setImmediate(run));
  const plans = new Map<number, CachedPlan>();
  const queue: Job[] = [];
  let draining = false;
  let closed = false;

  const episodeRow = (episodeId: number): EpisodeRow | null => {
    const row = db
      .statement("SELECT state, input_generation, created_at_ms FROM episodes WHERE id = ?")
      .get(episodeId);
    const state = row?.["state"];
    const generation = row?.["input_generation"];
    const createdAtMs = row?.["created_at_ms"];
    if (
      typeof state !== "string" ||
      typeof generation !== "number" ||
      typeof createdAtMs !== "number"
    ) {
      return null;
    }
    return { state, generation, createdAtMs };
  };

  /** Grows with every tombstone (they are never removed): a new one may cut a planned extent. */
  const deletionRevision = (): number => {
    const revision = db
      .statement("SELECT coalesce(max(id), 0) AS revision FROM deleted_ranges")
      .get()?.["revision"];
    return typeof revision === "number" ? revision : 0;
  };

  /**
   * The episode's plan: the cached one while its generation and the
   * tombstones are unchanged (and, for `fresh`, the episode is closed),
   * else planned again, keeping the cached frame when the generation is the
   * same so a playback under way keeps its offsets.
   */
  const timelineOf = (
    episodeId: number,
    row: EpisodeRow,
    fresh: boolean,
  ): EpisodeTimeline | null => {
    const revision = deletionRevision();
    const cached = plans.get(episodeId);
    const same =
      cached !== undefined &&
      cached.generation === row.generation &&
      cached.createdAtMs === row.createdAtMs;
    plans.delete(episodeId);
    if (same && cached.revision === revision && !(fresh && row.state === "open")) {
      plans.set(episodeId, cached);
      return cached.timeline;
    }
    const input = loadAnalysisInput(db, episodeId);
    if (input === null) return null;
    const keep = same && !fresh ? cached.timeline : null;
    const timeline = trace("media.plan", () =>
      planEpisodeTimeline(
        input,
        (trackRunId, sample) => wallMsAtSample(db, trackRunId, sample),
        keep === null || keep.startedAtMs === null
          ? undefined
          : { startedAtMs: keep.startedAtMs, samples: keep.samples },
      ),
    );
    plans.set(episodeId, {
      generation: row.generation,
      createdAtMs: row.createdAtMs,
      revision,
      timeline,
    });
    for (const oldest of plans.keys()) {
      if (plans.size <= MEDIA_TIMELINE_CACHE) break;
      plans.delete(oldest);
    }
    return timeline;
  };

  const readSlice = (request: MediaReadRequest): MediaReadReply => {
    const row = episodeRow(request.episodeId);
    if (row === null) {
      plans.delete(request.episodeId);
      return failure("not-found");
    }
    if (row.generation !== request.generation) return failure("stale");
    const read = options.reader();
    if (read === null) return failure("unavailable");
    const timeline = timelineOf(request.episodeId, row, false);
    if (timeline === null) return failure("not-found");
    const total = wavByteLength(timeline);
    const range = resolveByteRange(request.range, total);
    if (range === null) return failure("unsatisfiable", total);
    const last = Math.min(range.end, range.start + MEDIA_SLICE_BYTES - 1);
    const bytes = trace("media.read", () =>
      readTimelineBytes(timeline, read, range.start, last + 1),
    );
    return { ok: true, total, start: range.start, end: range.end, bytes };
  };

  const drain = () => {
    const job = queue.shift();
    if (job === undefined) {
      draining = false;
      return;
    }
    let reply: MediaReadReply;
    try {
      reply = readSlice(job.request);
    } catch (error) {
      log.warn("media.read-failed", { error: errorCode(error) });
      reply = failure("failed");
    }
    job.resolve(reply);
    defer(drain);
  };

  return {
    playback(episodeId) {
      const row = episodeRow(episodeId);
      if (row === null) {
        plans.delete(episodeId);
        return null;
      }
      const timeline = timelineOf(episodeId, row, true);
      if (timeline === null) return null;
      return {
        generation: row.generation,
        startedAtMs: timeline.startedAtMs,
        durationMs: Math.round((timeline.samples * 1000) / SAMPLE_RATE),
        speech: timeline.speech,
      };
    },
    read(request) {
      if (closed) return Promise.resolve(failure("unavailable"));
      if (queue.length >= MAX_MEDIA_JOBS) return Promise.resolve(failure("busy"));
      return new Promise((resolve) => {
        queue.push({ request, resolve });
        if (draining) return;
        draining = true;
        defer(drain);
      });
    },
    cancel(requestId) {
      const index = queue.findIndex((job) => job.request.requestId === requestId);
      if (index === -1) return;
      const [job] = queue.splice(index, 1);
      job?.resolve(failure("cancelled"));
    },
    close() {
      closed = true;
      for (const job of queue.splice(0)) job.resolve(failure("unavailable"));
    },
  };
}

/** Core's answer to a `media-read`; null for a read the window already dropped. */
export function mediaReplyMessage(requestId: number, reply: MediaReadReply): CoreToMain | null {
  if (reply.ok) {
    return {
      type: "media-bytes",
      requestId,
      mediaType: "audio/wav",
      total: reply.total,
      start: reply.start,
      end: reply.end,
      bytes: reply.bytes,
    };
  }
  if (reply.reason === "cancelled") return null;
  return { type: "media-failed", requestId, reason: reply.reason, total: reply.total };
}

/** Core's playback service, on the spool and archive reader; its spans go to Diagnostics. */
export const episodeMediaLayer = Layer.effect(
  EpisodeMedia,
  Effect.gen(function* () {
    const db = yield* Database;
    const audio = yield* TrackAudioSource;
    // Captures the runtime's services, the recording tracer included.
    const context = yield* Effect.context<Database>();
    const runSync = Effect.runSyncWith(context);
    const media = createEpisodeMedia({
      db,
      reader: () => audio.reader(),
      trace: (name, work) => runSync(Effect.sync(work).pipe(Effect.withSpan(name))),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => media.close()));
    return EpisodeMedia.of(media);
  }),
);
