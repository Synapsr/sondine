import { EpisodePlayback } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  contextMediaUrl,
  episodeMediaUrl,
  parseContextMediaUrl,
  parseEpisodeMediaUrl,
} from "./media-url";

describe("episode media URLs", () => {
  it("names an episode and its generation, in the shape episodes.playback promises", () => {
    const url = episodeMediaUrl({ episodeId: 42, generation: 3 });
    expect(url).toBe("sondine-media://episode/42?g=3");
    expect(parseEpisodeMediaUrl(url)).toEqual({ episodeId: 42, generation: 3 });
    expect(
      EpisodePlayback.shape.src.safeParse(url).success,
      "the API schema accepts the URL core makes",
    ).toBe(true);
  });

  it("refuses every other URL", () => {
    for (const url of [
      "sondine-media://episode/42",
      "sondine-media://episode/42?g=0",
      "sondine-media://episode/0?g=1",
      "sondine-media://episode/042?g=1",
      "sondine-media://episode/42?g=1&x=2",
      "sondine-media://episode/42/?g=1",
      "sondine-media://episode/42?g=1#t=5",
      "sondine-media://episode/../42?g=1",
      "sondine-media://other/42?g=1",
      "sondine://app/42?g=1",
      "sondine-media://episode/-1?g=1",
      `sondine-media://episode/${"9".repeat(17)}?g=1`,
      "",
    ]) {
      expect(parseEpisodeMediaUrl(url), url).toBeNull();
    }
  });
});

describe("context media URLs", () => {
  it("names one item's preview by its id and the start of its hash", () => {
    const url = contextMediaUrl({ itemId: 12, version: "0123456789abcdef" });
    expect(url).toBe("sondine-media://context/12?v=0123456789abcdef");
    expect(parseContextMediaUrl(url)).toEqual({ itemId: 12, version: "0123456789abcdef" });
    expect(parseEpisodeMediaUrl(url)).toBeNull();
  });

  it("refuses every other URL", () => {
    for (const url of [
      "sondine-media://context/12",
      "sondine-media://context/12?v=0123",
      "sondine-media://context/12?v=0123456789ABCDEF",
      "sondine-media://context/0?v=0123456789abcdef",
      "sondine-media://context/12?v=0123456789abcdef&x=1",
      "sondine-media://context/../12?v=0123456789abcdef",
      "sondine-media://episode/12?v=0123456789abcdef",
    ]) {
      expect(parseContextMediaUrl(url), url).toBeNull();
    }
  });
});
