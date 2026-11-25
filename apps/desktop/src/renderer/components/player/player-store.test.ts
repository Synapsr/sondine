import type { EpisodePlayback } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { Player, type PlayerAudio } from "./player-store";

// A stand-in for the audio element: it records what the player asks and
// lets the test fire the media events. No audio is decoded.
class FakeAudio extends EventTarget implements PlayerAudio {
  src = "";
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  loads: string[] = [];

  play(): Promise<void> {
    this.paused = false;
    queueMicrotask(() => this.fire("playing"));
    return Promise.resolve();
  }
  pause(): void {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.fire("pause");
  }
  load(): void {
    this.loads.push(this.src);
    this.currentTime = 0;
  }
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

const T0 = 1_793_610_000_000;

const plan = (generation: number, startedAtMs: number | null = T0): EpisodePlayback => ({
  src: `sondine-media://episode/7?g=${generation}`,
  startedAtMs,
  durationMs: 600_000,
  generation,
  speech: [],
});

const GONE = new Error("gone");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(plans: (EpisodePlayback | Error)[]) {
  const audio = new FakeAudio();
  const asked: number[] = [];
  const player = new Player(audio, {
    fetchPlan: async (episodeId) => {
      asked.push(episodeId);
      const next = plans.shift();
      if (next === undefined) throw new Error("no plan left");
      if (next instanceof Error) throw next;
      return next;
    },
    isGone: (error) => error === GONE,
  });
  return { audio, asked, player };
}

describe("player", () => {
  it("plays an episode from a wall-clock time once its source has loaded", async () => {
    const { audio, player } = setup([plan(1)]);
    await player.play(7, T0 + 374_000);
    expect(player.getSnapshot()).toMatchObject({ episodeId: 7, status: "loading", seconds: 374 });
    expect(audio.src).toBe("sondine-media://episode/7?g=1");
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(374);
    await flush();
    expect(player.getSnapshot().status).toBe("playing");
    audio.currentTime = 375.5;
    audio.fire("timeupdate");
    expect(player.getSnapshot().seconds).toBe(375.5);
  });

  it("resumes at the same wall-clock time when the episode's generation moved on", async () => {
    const { audio, asked, player } = setup([plan(1), plan(2, T0 - 2_000)]);
    await player.play(7);
    audio.fire("loadedmetadata");
    await flush();
    audio.currentTime = 100;
    audio.fire("timeupdate");
    // The old URL now answers 409: the element reports a media error.
    audio.fire("error");
    await flush();
    expect(asked).toEqual([7, 7]);
    expect(audio.src).toBe("sondine-media://episode/7?g=2");
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(102);
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "playing", problem: null });
  });

  it("says the episode no longer exists when core does not know it", async () => {
    const { audio, player } = setup([plan(1), GONE]);
    await player.play(7);
    audio.fire("loadedmetadata");
    audio.fire("error");
    await flush();
    expect(player.getSnapshot()).toMatchObject({ episodeId: 7, status: "error", problem: "gone" });
    expect(audio.src).toBe("");
  });

  it("fails when the same generation errors, and when nothing was kept", async () => {
    const same = setup([plan(1), plan(1)]);
    await same.player.play(7);
    same.audio.fire("loadedmetadata");
    same.audio.fire("error");
    await flush();
    expect(same.player.getSnapshot()).toMatchObject({ status: "error", problem: "failed" });

    const silent = setup([plan(1, null)]);
    await silent.player.play(7);
    expect(silent.player.getSnapshot()).toMatchObject({ status: "error", problem: "nothing" });
  });

  it("ignores a plan that lands after another episode was asked for", async () => {
    const { audio, player } = setup([
      plan(1),
      { ...plan(5), src: "sondine-media://episode/8?g=5" },
    ]);
    const first = player.play(7);
    const second = player.play(8);
    await Promise.all([first, second]);
    expect(player.getSnapshot().episodeId).toBe(8);
    expect(audio.src).toBe("sondine-media://episode/8?g=5");
  });

  it("pauses, seeks within the timeline, keeps the rate, and stops", async () => {
    const { audio, player } = setup([plan(1)]);
    player.setRate(1.5);
    await player.play(7);
    audio.fire("loadedmetadata");
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.preservesPitch).toBe(true);
    await flush();
    player.toggle();
    expect(player.getSnapshot().status).toBe("paused");
    player.seekBy(-5);
    expect(player.getSnapshot().seconds).toBe(0);
    player.seek(10_000);
    expect(player.getSnapshot().seconds).toBe(600);
    player.seekToWall(T0 + 42_000);
    expect(audio.currentTime).toBe(42);
    player.stop();
    expect(player.getSnapshot()).toMatchObject({ episodeId: null, status: "idle", rate: 1.5 });
    expect(audio.src).toBe("");
  });

  it("cues an episode paused for its page, and forgets it if it never played", async () => {
    const { audio, player } = setup([plan(1), plan(1)]);
    await player.cue(7);
    audio.fire("loadedmetadata");
    await flush();
    expect(player.getSnapshot()).toMatchObject({ episodeId: 7, status: "paused", seconds: 0 });
    expect(audio.paused).toBe(true);
    player.releaseCue(7);
    expect(player.getSnapshot().status).toBe("idle");

    // Played once, it stays loaded when its page closes.
    await player.cue(7);
    audio.fire("loadedmetadata");
    player.toggle();
    await flush();
    player.pause();
    player.releaseCue(7);
    expect(player.getSnapshot()).toMatchObject({ episodeId: 7, status: "paused" });
  });

  it("never cues over an episode already loaded", async () => {
    const { player } = setup([plan(1)]);
    await player.play(7);
    await player.cue(8);
    expect(player.getSnapshot().episodeId).toBe(7);
  });

  it("plays an ended episode again from its start", async () => {
    const { audio, player } = setup([plan(1)]);
    await player.play(7);
    audio.fire("loadedmetadata");
    await flush();
    audio.currentTime = 600;
    audio.fire("ended");
    expect(player.getSnapshot().status).toBe("ended");
    player.toggle();
    expect(audio.currentTime).toBe(0);
    await flush();
    expect(player.getSnapshot().status).toBe("playing");
  });
});
