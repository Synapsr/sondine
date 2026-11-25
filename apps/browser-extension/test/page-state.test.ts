import { describe, expect, it } from "vitest";
import { PAGE_ID_MIN, playsAloud, readPageReport } from "../src/page-state.ts";
import { mediaReport, readMediaReport, type VideoState } from "../src/youtube-state.ts";

const video = (fields: Partial<VideoState> = {}): VideoState => ({
  currentTime: 42,
  duration: 212,
  paused: false,
  ended: false,
  playbackRate: 1,
  readyState: 4,
  ...fields,
});

describe("readPageReport", () => {
  const said = (page: Record<string, unknown>) => ({
    ...mediaReport(video(), "a", false, 1000),
    page: {
      id: PAGE_ID_MIN + 1,
      url: "https://www.youtube.com/watch?v=a",
      title: "A",
      aloud: true,
      ...page,
    },
  });

  it("reads what a page says of itself", () => {
    expect(readPageReport(said({}))).toEqual({
      id: PAGE_ID_MIN + 1,
      url: "https://www.youtube.com/watch?v=a",
      title: "A",
      aloud: true,
    });
    // Core never sees it: the media message keeps the protocol's fields only.
    expect(readMediaReport(said({}), 1)).not.toHaveProperty("page");
  });

  it("reads any web page's word, not only YouTube's", () => {
    expect(
      readPageReport({
        type: "page",
        page: { id: PAGE_ID_MIN, url: "http://radio.example/live", title: "", aloud: false },
      }),
    ).toEqual({ id: PAGE_ID_MIN, url: "http://radio.example/live", title: "", aloud: false });
  });

  it("refuses a page that is not one", () => {
    for (const page of [
      { id: 7 },
      { id: 2 ** 31 },
      { url: "file:///Users/me/secret.html" },
      { url: "chrome-extension://nnieeegenbmpfllllldjpkolkldjmmdb/popup.html" },
      { url: `https://www.youtube.com/${"a".repeat(2048)}` },
      { title: "t".repeat(301) },
      { aloud: "yes" },
    ]) {
      expect(readPageReport(said(page))).toBeNull();
    }
    expect(readPageReport(mediaReport(video(), "a", false, 1000))).toBeNull();
  });
});

describe("playsAloud", () => {
  it("hears a video that plays, unmuted, above volume 0", () => {
    const heard = { paused: false, ended: false, muted: false, volume: 0.4 };
    expect(playsAloud(heard)).toBe(true);
    expect(playsAloud({ ...heard, paused: true })).toBe(false);
    expect(playsAloud({ ...heard, ended: true })).toBe(false);
    expect(playsAloud({ ...heard, muted: true })).toBe(false);
    expect(playsAloud({ ...heard, volume: 0 })).toBe(false);
  });
});
