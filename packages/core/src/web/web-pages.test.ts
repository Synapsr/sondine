import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  pageLinkAt,
  pageUrlOf,
  positionAt,
  siteName,
  siteOfInput,
  webPageOf,
  type MediaMark,
} from "./web-pages";

describe("webPageOf", () => {
  it("keys a YouTube video by its id, whatever else the address carries", () => {
    const a = webPageOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1");
    const b = webPageOf("https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ");
    const c = webPageOf("https://youtu.be/dQw4w9WgXcQ?si=abc");
    const short = webPageOf("https://www.youtube.com/shorts/abc_DEF-123");
    expect(a).toEqual({
      site: "youtube.com",
      pageKey: "youtube.com/watch?v=dQw4w9WgXcQ",
      video: true,
    });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(short?.pageKey).toBe("youtube.com/watch?v=abc_DEF-123");
    expect(webPageOf("https://music.youtube.com/watch?v=xyz")).toEqual({
      site: "music.youtube.com",
      pageKey: "music.youtube.com/watch?v=xyz",
      video: true,
    });
  });

  it("keys any other page by its host and path", () => {
    expect(webPageOf("https://www.netflix.com/watch/81234567?trackId=1#x")).toEqual({
      site: "netflix.com",
      pageKey: "netflix.com/watch/81234567",
      video: false,
    });
    expect(webPageOf("https://www.youtube.com/")?.pageKey).toBe("youtube.com");
    expect(webPageOf("http://Example.ORG/a/b/")?.pageKey).toBe("example.org/a/b");
  });

  it("refuses what is not a web page", () => {
    expect(webPageOf("file:///Users/me/a.html")).toBeNull();
    expect(webPageOf("chrome://settings")).toBeNull();
    expect(webPageOf("not a url")).toBeNull();
  });
});

describe("siteOfInput", () => {
  it("takes a host or any address on it", () => {
    expect(siteOfInput(" Netflix.com ")).toBe("netflix.com");
    expect(siteOfInput("https://www.netflix.com/browse")).toBe("netflix.com");
    expect(siteOfInput("m.youtube.com/watch?v=a")).toBe("youtube.com");
    expect(siteOfInput("music.youtube.com")).toBe("music.youtube.com");
  });

  it("refuses what names no web site", () => {
    expect(siteOfInput("")).toBeNull();
    expect(siteOfInput("netflix")).toBeNull();
    expect(siteOfInput("file:///Users/me")).toBeNull();
    expect(siteOfInput("not a site")).toBeNull();
  });
});

describe("names and titles", () => {
  it("names known sites and shows the others as their host", () => {
    expect(siteName("youtube.com")).toBe("YouTube");
    expect(siteName("netflix.com")).toBe("Netflix");
    expect(siteName("lemonde.fr")).toBe("lemonde.fr");
  });

  it("drops the notification count and the site's name from a title", () => {
    expect(cleanTitle("youtube.com", "(3) Une vidéo - YouTube")).toBe("Une vidéo");
    expect(cleanTitle("open.spotify.com", "Titre • Artiste | Spotify")).toBe("Titre • Artiste");
    expect(cleanTitle("netflix.com", "Netflix")).toBe("");
    expect(cleanTitle("lemonde.fr", "Un article")).toBe("Un article");
  });
});

describe("links", () => {
  const video = { site: "youtube.com", pageKey: "youtube.com/watch?v=abc", video: true };

  it("rebuilds a page's address from its key", () => {
    expect(pageUrlOf("youtube.com/watch?v=abc")).toBe("https://www.youtube.com/watch?v=abc");
    expect(pageUrlOf("netflix.com/watch/81")).toBe("https://netflix.com/watch/81");
  });

  it("opens a YouTube video at a time, and any other page as it is", () => {
    expect(pageLinkAt(video, "https://www.youtube.com/watch?v=abc&list=x", 754_900)).toBe(
      "https://www.youtube.com/watch?v=abc&t=754s",
    );
    expect(pageLinkAt(video, "https://www.youtube.com/watch?v=abc", null)).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
    const page = { site: "netflix.com", pageKey: "netflix.com/watch/81", video: false };
    expect(pageLinkAt(page, "https://www.netflix.com/watch/81", 1000)).toBe(
      "https://www.netflix.com/watch/81",
    );
  });
});

describe("positionAt", () => {
  const mark = (wallMs: number, positionMs: number, rate: number, ad = false): MediaMark => ({
    wallMs,
    positionMs,
    rate,
    durationMs: 600_000,
    ad,
  });

  it("moves at the rate of the latest mark", () => {
    const marks = [mark(1_000, 0, 1), mark(11_000, 10_000, 0), mark(20_000, 10_000, 2)];
    expect(positionAt(marks, 500)).toBeNull();
    expect(positionAt(marks, 6_000)).toBe(5_000);
    // Paused: the position stays.
    expect(positionAt(marks, 15_000)).toBe(10_000);
    // Twice the speed.
    expect(positionAt(marks, 25_000)).toBe(20_000);
    // Never past the end.
    expect(positionAt(marks, 2_000_000)).toBe(600_000);
  });

  it("says nothing during an ad or from a mark too old", () => {
    expect(positionAt([mark(0, 0, 1, true)], 1_000)).toBeNull();
    expect(positionAt([mark(0, 0, 0)], 7 * 3_600_000)).toBeNull();
  });
});
