import type { EpisodePlayback } from "@sondine/api";
import { resumeSeconds, secondsAt, type Timeline } from "./player-time";

// The app's one player (architecture §11): a single audio element streams
// the episode's timeline from its `sondine-media:` URL, which main serves by
// byte ranges from core. Every play button, the transcript and the player
// bar drive it through this store.
//
// The element cannot read the status of a failed response, so any media
// error asks core for a fresh plan: a newer generation (the old URL answers
// 409) resumes at the same wall-clock time, a NOT_FOUND means the episode was
// deleted, and the same generation is a real failure. Stopping clears the
// element's source, which drops what it buffered.

/** The part of an audio element the player uses; HTMLAudioElement fits. */
export interface PlayerAudio extends EventTarget {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export const PLAYBACK_RATES = [1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";
/** Why nothing plays: no audio kept, the episode deleted, or the stream failed. */
export type PlayerProblem = "nothing" | "gone" | "failed";

export interface PlayerSnapshot {
  readonly episodeId: number | null;
  readonly status: PlayerStatus;
  readonly problem: PlayerProblem | null;
  readonly timeline: Timeline | null;
  /** Position on the timeline. */
  readonly seconds: number;
  readonly rate: PlaybackRate;
}

export interface PlayerOptions {
  /** A fresh plan from core (never cached). */
  readonly fetchPlan: (episodeId: number) => Promise<EpisodePlayback>;
  /** The call failed because the episode no longer exists. */
  readonly isGone: (error: unknown) => boolean;
}

interface Session {
  readonly episodeId: number;
  plan: (EpisodePlayback & { readonly startedAtMs: number }) | null;
  /** Play once loaded or recovered; false after a pause. */
  wantsPlay: boolean;
  /** A recovery is running for the current source; another error fails. */
  recovering: boolean;
  /** A new source is loading: its position reads 0 until it seeks. */
  settling: boolean;
  /** It has played; an episode only cued for its page has not. */
  played: boolean;
}

const IDLE: PlayerSnapshot = {
  episodeId: null,
  status: "idle",
  problem: null,
  timeline: null,
  seconds: 0,
  rate: 1,
};

const timelineOf = (plan: EpisodePlayback & { startedAtMs: number }): Timeline => ({
  startedAtMs: plan.startedAtMs,
  durationMs: plan.durationMs,
  speech: plan.speech,
});

export class Player {
  readonly #audio: PlayerAudio;
  readonly #options: PlayerOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: PlayerSnapshot = IDLE;
  #session: Session | null = null;

  constructor(audio: PlayerAudio, options: PlayerOptions) {
    this.#audio = audio;
    this.#options = options;
    audio.preservesPitch = true;
    const on = (type: string, handler: (session: Session) => void) =>
      audio.addEventListener(type, () => {
        if (this.#session !== null) handler(this.#session);
      });
    const position = (session: Session) => {
      if (!session.settling) this.#update({ seconds: audio.currentTime });
    };
    on("timeupdate", position);
    on("seeked", position);
    on("playing", (session) => {
      session.recovering = false;
      session.played = true;
      this.#update({ status: "playing", seconds: audio.currentTime });
    });
    on("pause", () => {
      if (this.#snapshot.status === "playing") this.#update({ status: "paused" });
    });
    on("ended", (session) => {
      session.wantsPlay = false;
      this.#update({ status: "ended", seconds: audio.currentTime });
    });
    on("error", (session) => void this.#recover(session));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): PlayerSnapshot => this.#snapshot;

  /**
   * Plays an episode, from `atWallMs` when given (a segment's or a hit's
   * start), else from where it is (its start for a new episode).
   */
  async play(episodeId: number, atWallMs?: number): Promise<void> {
    const current = this.#session;
    if (current?.episodeId === episodeId && current.plan !== null) {
      current.wantsPlay = true;
      if (atWallMs !== undefined) this.#seekTo(secondsAt(atWallMs, timelineOf(current.plan)));
      else if (this.#snapshot.status === "ended") this.#seekTo(0);
      this.#start(current);
      return;
    }
    await this.#open(episodeId, atWallMs, true);
  }

  /**
   * Loads an episode paused at its start, for its page, unless something is
   * already loaded: the player bar shows it and Space plays it.
   */
  async cue(episodeId: number): Promise<void> {
    if (this.#session !== null) return;
    await this.#open(episodeId, undefined, false);
  }

  /** Forgets a cued episode that never played (its page closed). */
  releaseCue(episodeId: number): void {
    const session = this.#session;
    if (session?.episodeId === episodeId && !session.played && !session.wantsPlay) this.stop();
  }

  async #open(episodeId: number, atWallMs: number | undefined, wantsPlay: boolean): Promise<void> {
    this.#release();
    const session: Session = {
      episodeId,
      plan: null,
      wantsPlay,
      recovering: false,
      settling: false,
      played: false,
    };
    this.#session = session;
    this.#set({
      ...IDLE,
      rate: this.#snapshot.rate,
      episodeId,
      status: wantsPlay ? "loading" : "paused",
    });
    let plan: EpisodePlayback;
    try {
      plan = await this.#options.fetchPlan(episodeId);
    } catch (error) {
      if (this.#session === session) this.#fail(this.#options.isGone(error) ? "gone" : "failed");
      return;
    }
    if (this.#session !== session) return;
    if (plan.startedAtMs === null) {
      this.#fail("nothing");
      return;
    }
    const playable = { ...plan, startedAtMs: plan.startedAtMs };
    const seconds = atWallMs === undefined ? 0 : secondsAt(atWallMs, timelineOf(playable));
    this.#load(session, playable, seconds);
  }

  /** Plays or pauses; `episodeId` plays that episode when another one is loaded. */
  toggle(episodeId?: number): void {
    const session = this.#session;
    if (episodeId !== undefined && session?.episodeId !== episodeId) {
      void this.play(episodeId);
      return;
    }
    if (session === null) return;
    if (this.#snapshot.status === "playing" || this.#snapshot.status === "loading") this.pause();
    else void this.play(session.episodeId);
  }

  pause(): void {
    const session = this.#session;
    if (session === null) return;
    session.wantsPlay = false;
    this.#audio.pause();
    if (this.#snapshot.status === "loading" || this.#snapshot.status === "playing")
      this.#update({ status: "paused" });
  }

  /** Moves to a position of the timeline, in seconds. */
  seek(seconds: number): void {
    if (this.#session?.plan == null) return;
    this.#seekTo(seconds);
  }

  seekBy(deltaSeconds: number): void {
    this.seek(this.#snapshot.seconds + deltaSeconds);
  }

  /** Moves to a wall-clock time of the loaded episode. */
  seekToWall(wallMs: number): void {
    const plan = this.#session?.plan;
    if (plan == null) return;
    this.#seekTo(secondsAt(wallMs, timelineOf(plan)));
  }

  setRate(rate: PlaybackRate): void {
    this.#applyRate(rate);
    this.#update({ rate });
  }

  /**
   * Something was deleted: when the episode's audio changed (a newer
   * generation), what the element buffered goes and playback resumes at the
   * same wall-clock time; when the episode is gone, it stops.
   */
  async revalidate(): Promise<void> {
    const session = this.#session;
    const previous = session?.plan;
    if (session === null || previous === null || previous === undefined) return;
    let plan: EpisodePlayback;
    try {
      plan = await this.#options.fetchPlan(session.episodeId);
    } catch (error) {
      if (this.#session === session && this.#options.isGone(error)) this.stop();
      return;
    }
    if (this.#session !== session || session.plan !== previous) return;
    if (plan.generation === previous.generation) return;
    if (plan.startedAtMs === null) {
      this.stop();
      return;
    }
    const next = { ...plan, startedAtMs: plan.startedAtMs };
    const seconds = resumeSeconds(timelineOf(previous), this.#snapshot.seconds, timelineOf(next));
    this.#load(session, next, seconds);
  }

  /** Stops and forgets the episode, dropping what the element buffered. */
  stop(): void {
    this.#release();
    this.#set({ ...IDLE, rate: this.#snapshot.rate });
  }

  #seekTo(seconds: number): void {
    const timeline = this.#snapshot.timeline;
    if (timeline === null) return;
    const clamped = Math.min(Math.max(seconds, 0), timeline.durationMs / 1000);
    this.#audio.currentTime = clamped;
    const ended = this.#snapshot.status === "ended";
    this.#update({ seconds: clamped, ...(ended ? { status: "paused" } : {}) });
  }

  #load(
    session: Session,
    plan: EpisodePlayback & { readonly startedAtMs: number },
    seconds: number,
  ): void {
    session.plan = plan;
    session.settling = true;
    const audio = this.#audio;
    const loaded = () => {
      audio.removeEventListener("loadedmetadata", loaded);
      if (this.#session !== session || session.plan !== plan) return;
      session.settling = false;
      audio.currentTime = seconds;
      this.#applyRate(this.#snapshot.rate);
      if (session.wantsPlay) this.#start(session);
    };
    audio.addEventListener("loadedmetadata", loaded);
    this.#update({
      timeline: timelineOf(plan),
      seconds,
      status: session.wantsPlay ? "loading" : "paused",
      problem: null,
    });
    audio.src = plan.src;
    audio.load();
  }

  #start(session: Session): void {
    this.#audio.play().catch((error: unknown) => {
      // A newer load or a pause interrupts a pending play(); that is not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (this.#session === session) this.#fail("failed");
    });
  }

  async #recover(session: Session): Promise<void> {
    const previous = session.plan;
    if (previous === null || session.recovering) {
      this.#fail("failed");
      return;
    }
    session.recovering = true;
    let plan: EpisodePlayback;
    try {
      plan = await this.#options.fetchPlan(session.episodeId);
    } catch (error) {
      if (this.#session === session) this.#fail(this.#options.isGone(error) ? "gone" : "failed");
      return;
    }
    if (this.#session !== session) return;
    if (plan.startedAtMs === null) {
      this.#fail("nothing");
      return;
    }
    if (plan.generation === previous.generation) {
      this.#fail("failed");
      return;
    }
    const next = { ...plan, startedAtMs: plan.startedAtMs };
    const seconds = resumeSeconds(timelineOf(previous), this.#snapshot.seconds, timelineOf(next));
    this.#load(session, next, seconds);
  }

  #applyRate(rate: PlaybackRate): void {
    this.#audio.defaultPlaybackRate = rate;
    this.#audio.playbackRate = rate;
    this.#audio.preservesPitch = true;
  }

  #fail(problem: PlayerProblem): void {
    const episodeId = this.#session?.episodeId ?? null;
    this.#release();
    this.#set({ ...IDLE, rate: this.#snapshot.rate, episodeId, status: "error", problem });
  }

  /** Forgets the session and clears the element, which drops its buffer. */
  #release(): void {
    this.#session = null;
    const audio = this.#audio;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  #update(patch: Partial<PlayerSnapshot>): void {
    this.#set({ ...this.#snapshot, ...patch });
  }

  #set(next: PlayerSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
