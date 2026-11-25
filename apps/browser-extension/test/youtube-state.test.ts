import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrowserMessage } from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import {
  adShowing,
  isReportRequest,
  isYoutubePage,
  mediaReport,
  readMediaReport,
  REPORT_REQUEST,
  sameReport,
  youtubeVideoId,
  type VideoState,
} from "../src/youtube-state.ts";

const fixtures = resolve(import.meta.dirname, "../../../packages/protocol/fixtures");

describe("youtubeVideoId", () => {
  it("reads the v parameter, Shorts and live addresses", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://m.youtube.com/watch?app=m&v=abc_DEF-123")).toBe("abc_DEF-123");
    expect(youtubeVideoId("https://music.youtube.com/watch?v=xyz&list=RD1")).toBe("xyz");
    expect(youtubeVideoId("https://www.youtube.com/shorts/Ab12_-x")).toBe("Ab12_-x");
    expect(youtubeVideoId("https://www.youtube.com/live/Live1?si=2")).toBe("Live1");
  });

  it("is null when the address names no video", () => {
    expect(youtubeVideoId("https://www.youtube.com/")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=not%20an%20id")).toBeNull();
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${"a".repeat(65)}`)).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/@channel/videos")).toBeNull();
    expect(youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeVideoId("not a url")).toBeNull();
  });
});

describe("isYoutubePage", () => {
  it("accepts the content script's sites, over https", () => {
    expect(isYoutubePage("https://www.youtube.com/watch?v=a")).toBe(true);
    expect(isYoutubePage("https://music.youtube.com/")).toBe(true);
    expect(isYoutubePage("https://m.youtube.com/")).toBe(true);
    expect(isYoutubePage("http://www.youtube.com/")).toBe(false);
    expect(isYoutubePage("https://youtube.com.example.com/")).toBe(false);
    expect(isYoutubePage("https://studio.youtube.com/")).toBe(false);
    expect(isYoutubePage("")).toBe(false);
  });
});

const video = (state: Partial<VideoState> = {}): VideoState => ({
  currentTime: 42.0004,
  duration: 212.5,
  paused: false,
  ended: false,
  playbackRate: 1.5,
  readyState: 4,
  ...state,
});

describe("mediaReport", () => {
  it("gives the position in milliseconds and the speed while playing", () => {
    expect(mediaReport(video(), "dQw4w9WgXcQ", false, 1000)).toEqual({
      type: "media",
      at: 1000,
      videoId: "dQw4w9WgXcQ",
      positionMs: 42000,
      durationMs: 212500,
      rate: 1.5,
      ad: false,
    });
  });

  it("says rate 0 while paused, waiting for data, or ended", () => {
    expect(mediaReport(video({ paused: true }), null, false, 0).rate).toBe(0);
    expect(mediaReport(video({ readyState: 2 }), null, false, 0).rate).toBe(0);
    expect(mediaReport(video({ ended: true, paused: true }), null, false, 0).rate).toBe(0);
    expect(mediaReport(video({ ended: true }), null, false, 0).rate).toBe(0);
  });

  it("has no duration for a live stream or before metadata", () => {
    expect(
      mediaReport(video({ duration: Number.POSITIVE_INFINITY }), null, false, 0).durationMs,
    ).toBeNull();
    expect(mediaReport(video({ duration: Number.NaN }), null, false, 0).durationMs).toBeNull();
  });

  it("keeps values in the protocol's bounds", () => {
    const report = mediaReport(
      video({ currentTime: Number.NaN, playbackRate: 20 }),
      null,
      true,
      Date.now(),
    );
    expect(report.positionMs).toBe(0);
    expect(report.rate).toBe(16);
    expect(BrowserMessage.safeParse({ ...report, tab: 1 }).success).toBe(true);
  });
});

describe("sameReport", () => {
  it("ignores when the report was made", () => {
    const a = mediaReport(video({ paused: true }), "a", false, 1);
    expect(sameReport(a, { ...a, at: 2 })).toBe(true);
    expect(sameReport(a, { ...a, positionMs: a.positionMs + 1 })).toBe(false);
    expect(sameReport(a, { ...a, ad: true })).toBe(false);
    expect(sameReport(a, { ...a, videoId: "b" })).toBe(false);
  });
});

describe("readMediaReport", () => {
  it("adds the tab to a content script's report", () => {
    const report = mediaReport(video(), "dQw4w9WgXcQ", false, 1000);
    const message = readMediaReport(report, 412);
    expect(message).toEqual({ ...report, tab: 412 });
    expect(BrowserMessage.safeParse(message).success).toBe(true);
  });

  it("reads back the protocol's media fixtures", () => {
    const lines = readFileSync(resolve(fixtures, "browser-messages.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const messages = lines.map((line) => BrowserMessage.parse(JSON.parse(line)));
    const media = messages.filter((message) => message.type === "media");
    expect(media.length).toBeGreaterThan(0);
    for (const message of media) {
      const { tab, ...report } = message;
      expect(readMediaReport(report, tab)).toEqual(message);
    }
  });

  it("refuses anything else", () => {
    const report = mediaReport(video(), "a", false, 1000);
    const bad: unknown[] = [
      null,
      "media",
      { ...report, type: "tabs" },
      { ...report, at: -1 },
      { ...report, at: 1.5 },
      { ...report, positionMs: "0" },
      { ...report, durationMs: Number.NaN },
      { ...report, videoId: "a b" },
      { ...report, videoId: 3 },
      { ...report, rate: -1 },
      { ...report, rate: 17 },
      { ...report, rate: Number.NaN },
      { ...report, ad: "no" },
    ];
    for (const value of bad) expect(readMediaReport(value, 1)).toBeNull();
    expect(readMediaReport(report, -1)).toBeNull();
    expect(readMediaReport(report, 2 ** 31)).toBeNull();
  });

  it("copies only the protocol's fields", () => {
    const report = { ...mediaReport(video(), "a", false, 1000), extra: "page data" };
    expect(readMediaReport(report, 1)).not.toHaveProperty("extra");
  });
});

const classList = (...tokens: string[]) => ({
  contains: (token: string) => tokens.includes(token),
});

describe("adShowing", () => {
  it("reads the player's ad classes", () => {
    expect(adShowing(classList("html5-video-player", "ad-showing"))).toBe(true);
    expect(adShowing(classList("html5-video-player", "ad-interrupting"))).toBe(true);
    expect(adShowing(classList("html5-video-player", "playing-mode"))).toBe(false);
  });
});

describe("isReportRequest", () => {
  it("recognises the background's request only", () => {
    expect(isReportRequest(REPORT_REQUEST)).toBe(true);
    expect(isReportRequest({ type: "media" })).toBe(false);
    expect(isReportRequest(undefined)).toBe(false);
  });
});
