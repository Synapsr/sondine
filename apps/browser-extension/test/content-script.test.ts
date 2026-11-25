// Runs the built YouTube content script against a fake page.

import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { asJson, FakeEvent, script } from "./bundled.ts";

class FakeClassList {
  readonly tokens: Set<string>;

  constructor(...tokens: string[]) {
    this.tokens = new Set(tokens);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

class FakePlayer {
  readonly classList = new FakeClassList("html5-video-player");
}

class FakeVideo {
  paused = true;
  muted = false;
  volume = 1;
  ended = false;
  currentTime = 0;
  duration = 212;
  playbackRate = 1;
  readyState = 4;
  currentSrc = "blob:https://www.youtube.com/1";
  isConnected = true;
  readonly player: FakePlayer | null;

  constructor(player: FakePlayer | null) {
    this.player = player;
  }

  closest(selector: string): FakePlayer | null {
    return selector === ".html5-video-player" ? this.player : null;
  }

  play(): void {
    this.paused = false;
  }
}

class FakeTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, target: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target });
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }
}

const code = script("youtube");

const EXTENSION_ID = "nnieeegenbmpfllllldjpkolkldjmmdb";
/** What WXT's context dispatches on the document as a copy of the script starts. */
const STARTED = `${EXTENSION_ID}:youtube:wxt:content-script-started`;

function page(href: string, videos: FakeVideo[] = []) {
  const document = Object.assign(new FakeTarget(), {
    querySelectorAll: (selector: string) => (selector === "video" ? videos : []),
    title: "Une vidéo - YouTube",
  });
  /** The page's repeating timers, run by hand. */
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const toPage: unknown[] = [];
  const window = Object.assign(new FakeTarget(), {
    postMessage: (message: unknown) => toPage.push(message),
  });
  const location = { href };
  const sent: unknown[] = [];
  const onMessage = new FakeEvent<[unknown]>();
  const runtime = {
    id: EXTENSION_ID,
    orphan: false,
    /** The browser refuses the message by a rejected promise instead of a throw. */
    refuses: false,
    sendMessage(message: unknown): Promise<void> {
      if (runtime.orphan) throw new Error("Extension context invalidated.");
      if (runtime.refuses) return Promise.reject(new Error("Extension context invalidated."));
      sent.push(message);
      return Promise.resolve();
    },
    onMessage,
  };
  const observers: { callback: () => void; target: unknown }[] = [];
  class FakeObserver {
    readonly entry: { callback: () => void; target: unknown };
    constructor(callback: () => void) {
      this.entry = { callback, target: null };
      observers.push(this.entry);
    }
    observe(target: unknown): void {
      this.entry.target = target;
    }
    disconnect(): void {
      this.entry.target = null;
    }
  }
  const context = createContext({
    chrome: { runtime },
    document,
    window,
    location,
    HTMLVideoElement: FakeVideo,
    MutationObserver: FakeObserver,
    setInterval: (run: () => void) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearInterval: (id: number) => timers.delete(id),
    URL,
    // WXT's content script context.
    AbortController,
    CustomEvent,
    Event,
  });
  new Script(code).runInContext(context);

  return {
    document,
    window,
    location,
    runtime,
    onMessage,
    toPage,
    /** The reports sent, without their time or what the page says of itself. */
    reports: () =>
      asJson(sent).map((report) => {
        if (typeof report !== "object" || report === null) return report;
        const { at, page: _page, ...rest } = { at: 0, page: null, ...report };
        expect(typeof at).toBe("number");
        return rest;
      }),
    /** What each report said of the page. */
    pages: () =>
      asJson(sent).map((report) =>
        typeof report === "object" && report !== null && "page" in report ? report.page : null,
      ),
    /** Runs the page's repeating timers once. */
    tick: () => {
      for (const run of timers.values()) run();
    },
    timers,
    fire: (video: FakeVideo, type: string) => document.dispatch(type, video),
    /** The player's classes changed: the observers watching it run. */
    mutate: (player: FakePlayer) => {
      for (const observer of observers) if (observer.target === player) observer.callback();
    },
  };
}

const playingVideo = (player = new FakePlayer()) => {
  const video = new FakeVideo(player);
  video.play();
  video.currentTime = 42;
  return video;
};

const report = (fields: Record<string, unknown> = {}) => ({
  type: "media",
  videoId: "dQw4w9WgXcQ",
  positionMs: 42000,
  durationMs: 212000,
  rate: 1,
  ad: false,
  ...fields,
});

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("YouTube content script", () => {
  it("reports a video already playing when it starts", () => {
    const tab = page(WATCH, [playingVideo()]);
    expect(tab.reports()).toEqual([report()]);
  });

  it("stays quiet while nothing plays", () => {
    const tab = page(WATCH, [new FakeVideo(new FakePlayer())]);
    expect(tab.reports()).toEqual([]);
  });

  it("reports media events of the followed video, once per still state", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    video.paused = true;
    tab.fire(video, "pause");
    tab.fire(video, "pause");
    video.currentTime = 10;
    tab.fire(video, "seeked");
    video.paused = false;
    tab.fire(video, "play");
    tab.fire(video, "playing");
    expect(tab.reports()).toEqual([
      report(),
      report({ rate: 0 }),
      report({ rate: 0, positionMs: 10000 }),
      report({ positionMs: 10000 }),
      report({ positionMs: 10000 }),
    ]);
  });

  it("follows another video only once it plays aloud inside YouTube's player", () => {
    const main = new FakeVideo(new FakePlayer());
    const tab = page(WATCH, [main]);
    const preview = playingVideo();
    preview.muted = true;
    tab.fire(preview, "playing");
    const bare = new FakeVideo(null);
    bare.play();
    tab.fire(bare, "playing");
    tab.fire(new FakeVideo(new FakePlayer()), "pause");
    tab.document.dispatch("playing", {});
    expect(tab.reports()).toEqual([]);

    const aloud = playingVideo();
    tab.fire(aloud, "playing");
    expect(tab.reports()).toEqual([report()]);
    // Once followed, its pause counts.
    aloud.paused = true;
    tab.fire(aloud, "pause");
    expect(tab.reports()).toEqual([report(), report({ rate: 0 })]);
  });

  it("keeps the video's id in the miniplayer, until its source changes", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    tab.location.href = "https://www.youtube.com/";
    tab.document.dispatch("yt-navigate-finish", tab.document);
    video.paused = true;
    tab.fire(video, "pause");
    video.currentSrc = "blob:https://www.youtube.com/2";
    video.currentTime = 0;
    tab.fire(video, "emptied");
    expect(tab.reports()).toEqual([
      report(),
      report({ rate: 0 }),
      report({ rate: 0, positionMs: 0, videoId: null }),
    ]);
  });

  it("reports at once when the address names another video", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    tab.location.href = "https://www.youtube.com/watch?v=next";
    tab.document.dispatch("yt-navigate-finish", tab.document);
    tab.location.href = "https://m.youtube.com/shorts/short1";
    tab.window.dispatch("popstate", tab.window);
    tab.document.dispatch("state-navigateend", tab.document);
    expect(tab.reports()).toEqual([
      report(),
      report({ videoId: "next" }),
      report({ videoId: "short1" }),
    ]);
  });

  it("reports when an ad starts or ends", () => {
    const player = new FakePlayer();
    const tab = page(WATCH, [playingVideo(player)]);
    tab.mutate(player);
    player.classList.tokens.add("ad-showing");
    tab.mutate(player);
    player.classList.tokens.delete("ad-showing");
    tab.mutate(player);
    expect(tab.reports()).toEqual([report(), report({ ad: true }), report()]);
  });

  it("answers the background's request, even with nothing new", () => {
    const video = playingVideo();
    video.paused = true;
    const tab = page(WATCH, [video]);
    expect(tab.reports()).toEqual([]);
    tab.onMessage.fire({ type: "other" });
    expect(tab.reports()).toEqual([]);

    video.paused = false;
    tab.onMessage.fire({ type: "sondine-report" });
    tab.onMessage.fire({ type: "sondine-report" });
    expect(tab.reports()).toEqual([report(), report()]);
  });

  it("says with each report where the page is and whether it is heard", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    video.muted = true;
    tab.fire(video, "volumechange");
    const [first, second] = tab.pages();
    expect(first).toMatchObject({ url: WATCH, title: "Une vidéo - YouTube", aloud: true });
    expect(second).toMatchObject({ url: WATCH, aloud: false });
    // One id for the page, above any tab id the browser gives.
    const ids = tab.pages().map((said) => (said as { id: number }).id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeGreaterThanOrEqual(2 ** 30);
  });

  it("says it plays aloud every 30 s while it does, and stops saying once paused", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    expect(tab.timers.size).toBe(1);
    tab.tick();
    tab.tick();
    expect(tab.reports()).toEqual([report(), report(), report()]);
    video.paused = true;
    tab.fire(video, "pause");
    expect(tab.timers.size).toBe(0);
    expect(tab.pages().at(-1)).toMatchObject({ aloud: false });
  });

  it("says at once that it plays no more when the page goes", () => {
    const tab = page(WATCH, [playingVideo()]);
    tab.window.dispatch("pagehide", tab.window);
    expect(tab.pages().map((said) => (said as { aloud: boolean }).aloud)).toEqual([true, false]);
    expect(tab.reports().at(-1)).toMatchObject({ rate: 0 });
    expect(tab.timers.size).toBe(0);
  });

  it("stops saying it plays once the browser refuses its messages as an orphan's", async () => {
    const tab = page(WATCH, [playingVideo()]);
    expect(tab.timers.size).toBe(1);
    tab.runtime.refuses = true;
    tab.tick();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(tab.timers.size).toBe(0);
    expect(tab.document.count()).toBe(0);
  });

  it("stops listening once the extension is gone", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    expect(tab.document.count()).toBeGreaterThan(0);
    tab.runtime.orphan = true;
    video.paused = true;
    tab.fire(video, "pause");
    expect(tab.document.count()).toBe(0);
    expect(tab.window.count()).toBe(0);
    expect(tab.onMessage.listeners.size).toBe(0);
  });

  it("stops listening when a newer copy of the script starts", () => {
    const video = playingVideo();
    const tab = page(WATCH, [video]);
    tab.document.dispatchEvent(
      new CustomEvent(STARTED, { detail: { contentScriptName: "other", messageId: "a" } }),
    );
    expect(tab.document.count()).toBeGreaterThan(0);
    tab.document.dispatchEvent(
      new CustomEvent(STARTED, { detail: { contentScriptName: "youtube", messageId: "a" } }),
    );
    expect(tab.document.count()).toBe(0);
    expect(tab.window.count()).toBe(0);
    expect(tab.onMessage.listeners.size).toBe(0);
    video.paused = true;
    tab.fire(video, "pause");
    expect(tab.reports()).toEqual([report()]);
  });

  it("posts nothing to the page", () => {
    const tab = page(WATCH, [playingVideo()]);
    expect(tab.reports()).toEqual([report()]);
    expect(tab.toPage).toEqual([]);
  });
});
