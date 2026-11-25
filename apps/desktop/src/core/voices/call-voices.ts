import {
  anyoneToRecognize,
  appMayBeIdentified,
  farSideRegions,
  intersectsDeletedRange,
  knownVoices,
  loadOpenRunClocks,
  namingAllowed,
  ongoingCall,
  recognitionEnabled,
  recognizeVoice,
  type Database,
  type FarRegion,
  type KnownVoices,
  type OngoingCall,
  type SpeechPiece,
} from "@sondine/db";
import type { ReadTrackAudio } from "../audio/track-audio";
import { embed, readPieces, type VoiceTool } from "./voice-tool";

// Live identity during calls (ADR 025). While a call goes on, the far side's
// speech of that call (the call app's own tap, or `system:other` where its
// attribution names the call app; never a microphone) is embedded by
// `sondine-voice` in windows that never share a sample: each 3 s of new
// speech over the first 30 s, then the latest 10 s of each 30 s. What a
// window saw is consumed by samples, per track run, so speech that arrives
// late or out of order, or an episode cut at 3 h, never sends audio twice.
// Each window is matched as any voice is (ADR 030), as heard by the Mac: the
// far side is a channel recognition was not measured on, so a window counts
// only from 99 % and never recognizes anyone. A person is suggested once two
// windows agree on them (« Marie ? »), and a window closest to the user's
// own voice counts for no one. Nothing is stored: each embedding is dropped
// once matched, the suggestions live here until the call ends, and the voice
// pass works on the final transcript as before.

/** A person the call may be with: a suggestion, never a name. */
export interface CallSuggestion {
  readonly personId: number;
  /** The best of the windows that matched them. */
  readonly similarity: number;
  /** That window's confidence (ADR 030), 0 to 1. */
  readonly confidence: number;
  /** When the second window agreed. */
  readonly recognizedAtMs: number;
}

/** The call going on, with whom it may be. */
export interface CallState {
  readonly callId: number;
  /** When the call began: conversations before it are the context. */
  readonly startedAtMs: number;
  /** The call's open episode; null until speech joined it. */
  readonly episodeId: number | null;
  readonly suggestions: readonly CallSuggestion[];
  /** The user hid the suggestions for this call. */
  readonly dismissed: boolean;
}

/** Trimmed off each end of a region (turn edges blur), as for suggestions. */
const EDGE_MS = 250;
/** Shorter stretches are left out (`sondine-voice` takes 1 s or more). */
const MIN_PIECE_MS = 1_000;
/** Over the call's first 30 s of far speech, a window each 3 s of it. */
const EARLY_SPAN_MS = 30_000;
const EARLY_STEP_MS = 3_000;
/** Then the latest 10 s, each 30 s of it: a voice joining a group call. */
const LATE_STEP_MS = 30_000;
const WINDOW_MS = 10_000;
/** Windows that must agree on a person before they are suggested. */
const AGREEING_WINDOWS = 2;
/** People suggested in one call, at most. */
const MAX_SUGGESTIONS = 4;
/** Everyone's named voices are read again after this long. */
const GALLERY_MS = 60_000;

/** One stretch of the far side, placed on the wall clock. */
export interface FarPiece extends SpeechPiece {
  readonly wallStartMs: number;
  readonly ms: number;
}

/**
 * The far side's speech: its regions without roll, trimmed at each end (an
 * open region only at its start, up to what is imported), stretches of 1 s
 * or more, in time order.
 */
export function farSpeech(
  regions: readonly FarRegion[],
  watermarks: ReadonlyMap<number, number>,
): FarPiece[] {
  const pieces: FarPiece[] = [];
  for (const region of regions) {
    const rate = region.sampleRate;
    const edge = Math.round((EDGE_MS * rate) / 1000);
    const end =
      region.sampleEnd === null
        ? (watermarks.get(region.trackRunId) ?? region.sampleStart)
        : region.sampleEnd - edge;
    const from = Math.max(region.sliceStart, region.sampleStart) + edge;
    const to = Math.min(region.sliceEnd ?? Number.MAX_SAFE_INTEGER, end);
    const ms = ((to - from) * 1000) / rate;
    if (ms < MIN_PIECE_MS) continue;
    pieces.push({
      trackRunId: region.trackRunId,
      sampleStart: from,
      sampleEnd: to,
      wallStartMs: region.wallStartMs + ((from - region.sampleStart) * 1000) / rate,
      ms,
    });
  }
  return pieces.toSorted((a, b) => a.wallStartMs - b.wallStartMs);
}

/** The latest `windowMs` of the pieces (a piece cut keeps its end), each 1 s or more. */
export function latestSpeech(pieces: readonly FarPiece[], windowMs: number): FarPiece[] {
  const taken: FarPiece[] = [];
  let left = windowMs;
  for (const piece of pieces.toReversed()) {
    if (left < MIN_PIECE_MS) break;
    if (piece.ms <= left) {
      taken.unshift(piece);
      left -= piece.ms;
      continue;
    }
    const keep = Math.round(((piece.sampleEnd - piece.sampleStart) * left) / piece.ms);
    taken.unshift({
      ...piece,
      sampleStart: piece.sampleEnd - keep,
      wallStartMs: piece.wallStartMs + piece.ms - left,
      ms: left,
    });
    left = 0;
  }
  return taken;
}

/**
 * How much of the new speech to embed now, given how much is new and how
 * much the call's windows consumed; null when no window is due.
 */
export function nextWindow(freshMs: number, consumedMs: number): number | null {
  const step = consumedMs < EARLY_SPAN_MS ? EARLY_STEP_MS : LATE_STEP_MS;
  return freshMs >= step ? Math.min(freshMs, WINDOW_MS) : null;
}

/** `[start, end)` samples of one track run. */
type Interval = readonly [number, number];

/**
 * The parts of the pieces no window consumed yet, each 1 s or more.
 * `consumed` holds, per track run, disjoint intervals sorted by start.
 */
export function unconsumed(
  pieces: readonly FarPiece[],
  consumed: ReadonlyMap<number, readonly Interval[]>,
): FarPiece[] {
  return pieces.flatMap((piece) => {
    const cuts = consumed.get(piece.trackRunId) ?? [];
    // The first interval ending after the piece starts (bisection: a long
    // call consumes thousands).
    let low = 0;
    let high = cuts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((cuts[middle]?.[1] ?? 0) <= piece.sampleStart) low = middle + 1;
      else high = middle;
    }
    const parts: Interval[] = [];
    let from = piece.sampleStart;
    for (let index = low; index < cuts.length; index++) {
      const [cutStart, cutEnd] = cuts[index] ?? [piece.sampleEnd, piece.sampleEnd];
      if (cutStart >= piece.sampleEnd) break;
      if (cutStart > from) parts.push([from, cutStart]);
      from = Math.max(from, cutEnd);
    }
    if (from < piece.sampleEnd) parts.push([from, piece.sampleEnd]);
    const msPerSample = piece.ms / (piece.sampleEnd - piece.sampleStart);
    return parts.flatMap(([a, b]): FarPiece[] => {
      const ms = (b - a) * msPerSample;
      return ms < MIN_PIECE_MS
        ? []
        : [
            {
              trackRunId: piece.trackRunId,
              sampleStart: a,
              sampleEnd: b,
              wallStartMs: piece.wallStartMs + (a - piece.sampleStart) * msPerSample,
              ms,
            },
          ];
    });
  });
}

type LogFields = Readonly<Record<string, string | number | boolean | null>>;

interface Logger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export interface CallVoicesOptions {
  readonly db: Database;
  readonly tool: VoiceTool;
  readonly readAudio: () => ReadTrackAudio | null;
  readonly onChange: (state: CallState | null) => void;
  readonly log: Logger;
  readonly now?: () => number;
  /** `sondine-voice embed`; tests answer it themselves. */
  readonly embed?: typeof embed;
}

interface Votes {
  count: number;
  similarity: number;
  confidence: number;
}

export class CallVoices {
  readonly #options: CallVoicesOptions;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  #state: CallState | null = null;
  /** The far speech this call's windows saw, by track run, and how long it is. */
  #consumed = new Map<number, Interval[]>();
  #consumedMs = 0;
  #votes = new Map<number, Votes>();
  #gallery: { readonly voices: KnownVoices; readonly atMs: number } | null = null;
  /** Bumped by anything that makes a window in flight stale. */
  #epoch = 0;
  #running = false;

  constructor(options: CallVoicesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  current(): CallState | null {
    return this.#state;
  }

  /** Each imported commit: is a call on, and is a window due? */
  nudge(): void {
    const { db } = this.#options;
    const call = ongoingCall(db, this.#now());
    if (call === null) {
      this.#end();
      return;
    }
    let state = this.#state;
    if (state?.callId !== call.callId) {
      this.#restart();
      state = {
        callId: call.callId,
        startedAtMs: call.startedWallMs,
        episodeId: call.episodeId,
        suggestions: [],
        dismissed: false,
      };
      this.#set(state);
    } else if (state.episodeId !== call.episodeId) {
      // Its episode was cut (3 h) or speech just joined it: same call.
      state = { ...state, episodeId: call.episodeId };
      this.#set(state);
    }
    if (!this.#allowed(call)) {
      if (state.suggestions.length > 0) {
        this.#restart();
        this.#set({ ...state, suggestions: [] });
      }
      return;
    }
    if (this.#running || state.dismissed || call.episodeId === null) return;
    const watermarks = new Map(
      loadOpenRunClocks(db).map((run) => [
        run.trackRunId,
        run.lastChunk === null ? 0 : run.lastChunk.sampleStart + run.lastChunk.sampleCount,
      ]),
    );
    const heard = farSpeech(
      farSideRegions(db, {
        episodeId: call.episodeId,
        bundleId: call.bundleId,
        sinceWallMs: call.startedWallMs,
      }),
      watermarks,
    );
    const fresh = unconsumed(heard, this.#consumed);
    const freshMs = fresh.reduce((sum, piece) => sum + piece.ms, 0);
    const windowMs = nextWindow(freshMs, this.#consumedMs);
    if (windowMs === null) return;
    // All of it is seen now; the window embeds its latest part.
    for (const piece of fresh) {
      const cuts = this.#consumed.get(piece.trackRunId) ?? [];
      cuts.push([piece.sampleStart, piece.sampleEnd]);
      this.#consumed.set(
        piece.trackRunId,
        cuts.toSorted((a, b) => a[0] - b[0]),
      );
    }
    this.#consumedMs += freshMs;
    const heardMs = this.#consumedMs;
    // Deleted speech is never sent, wherever the tombstone lies.
    const pieces = latestSpeech(fresh, windowMs).filter(
      (piece) =>
        !intersectsDeletedRange(db, {
          trackRunId: piece.trackRunId,
          sampleStart: piece.sampleStart,
          sampleEnd: piece.sampleEnd,
          wallStartMs: piece.wallStartMs,
          wallEndMs: piece.wallStartMs + piece.ms,
        }),
    );
    if (pieces.reduce((sum, piece) => sum + piece.ms, 0) < EARLY_STEP_MS) return;
    void this.#attempt(call, pieces, heardMs);
  }

  /** « Masquer pour cet appel »: nothing more is shown, nor embedded, for this call. */
  dismiss(callId: number): CallState | null {
    if (this.#state?.callId === callId && !this.#state.dismissed) {
      this.#epoch += 1;
      this.#set({ ...this.#state, suggestions: [], dismissed: true });
    }
    return this.#state;
  }

  /**
   * Something was deleted, or listening stopped: what was heard may be gone,
   * so the call starts over.
   */
  reset(): void {
    this.#restart();
    if (this.#state !== null && this.#state.suggestions.length > 0) {
      this.#set({ ...this.#state, suggestions: [] });
    }
  }

  stop(): void {
    this.#controller.abort();
  }

  /** Recognition on, the call and its app not under a « do not identify » rule, someone to find. */
  #allowed(call: OngoingCall): boolean {
    const { db } = this.#options;
    return (
      recognitionEnabled(db) &&
      appMayBeIdentified(db, call.appId) &&
      (call.episodeId === null || namingAllowed(db, call.episodeId)) &&
      anyoneToRecognize(db)
    );
  }

  #restart(): void {
    this.#epoch += 1;
    this.#consumed = new Map();
    this.#consumedMs = 0;
    this.#votes = new Map();
    this.#gallery = null;
  }

  #end(): void {
    if (this.#state === null) return;
    this.#restart();
    this.#set(null);
  }

  #voices(nowMs: number): KnownVoices {
    if (this.#gallery === null || nowMs - this.#gallery.atMs > GALLERY_MS) {
      this.#gallery = { voices: knownVoices(this.#options.db), atMs: nowMs };
    }
    return this.#gallery.voices;
  }

  async #attempt(call: OngoingCall, pieces: readonly FarPiece[], heardMs: number): Promise<void> {
    const { db, tool, log } = this.#options;
    const read = this.#options.readAudio();
    if (read === null || call.episodeId === null) return;
    const episodeId = call.episodeId;
    const epoch = this.#epoch;
    this.#running = true;
    const startedAtMs = this.#now();
    try {
      const audio = readPieces(read, pieces);
      if (audio.length === 0) return;
      const answer = await (this.#options.embed ?? embed)(
        tool,
        [{ key: "far", pieces: audio }],
        this.#controller.signal,
      );
      const [voice] = answer.speakers;
      // Read again after the wait: a deletion, a rule or the call's end since drops it.
      const state = this.#state;
      const nowMs = this.#now();
      if (
        voice === undefined ||
        epoch !== this.#epoch ||
        state?.callId !== call.callId ||
        state.dismissed ||
        ongoingCall(db, nowMs)?.callId !== call.callId ||
        !this.#allowed(call)
      ) {
        return;
      }
      const match = recognizeVoice(db, {
        episodeId,
        embedderVersion: answer.modelVersion,
        vector: voice.embedding,
        speechMs: voice.speechMs,
        // The far side, as the Mac heard it (ADR 025: never a microphone).
        channel: "computer",
        voices: this.#voices(nowMs),
      });
      const newest = pieces.at(-1);
      log.info("calls.window", {
        episodeId,
        heardMs: Math.round(heardMs),
        speechMs: voice.speechMs,
        embedMs: nowMs - startedAtMs,
        // From the end of the newest speech used to the match.
        afterSpeechMs:
          newest === undefined ? null : Math.round(nowMs - newest.wallStartMs - newest.ms),
        matched: match !== null,
        similarity: match === null ? null : Math.round(match.similarity * 1000) / 1000,
      });
      if (match === null) return;
      const votes = this.#votes.get(match.person.id) ?? {
        count: 0,
        similarity: -1,
        confidence: 0,
      };
      votes.count += 1;
      votes.similarity = Math.max(votes.similarity, match.similarity);
      votes.confidence = Math.max(votes.confidence, match.confidence);
      this.#votes.set(match.person.id, votes);
      const known = state.suggestions.find((entry) => entry.personId === match.person.id);
      if (votes.count < AGREEING_WINDOWS || known !== undefined) return;
      log.info("calls.recognized", {
        episodeId,
        heardMs: Math.round(heardMs),
        windows: votes.count,
        people: state.suggestions.length + 1,
      });
      this.#set({
        ...state,
        suggestions: [
          ...state.suggestions,
          {
            personId: match.person.id,
            similarity: votes.similarity,
            confidence: votes.confidence,
            recognizedAtMs: nowMs,
          },
        ].slice(0, MAX_SUGGESTIONS),
      });
    } catch (error) {
      if (!this.#controller.signal.aborted) {
        log.warn("calls.window-failed", {
          episodeId,
          message: error instanceof Error ? error.message : "error",
        });
      }
    } finally {
      this.#running = false;
    }
  }

  #set(state: CallState | null): void {
    this.#state = state;
    this.#options.onChange(state);
  }
}
