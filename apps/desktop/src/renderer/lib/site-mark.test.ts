import type { EpisodeWebPage } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { siteMark } from "./site-mark";

const page = (site: string): EpisodeWebPage => ({
  site,
  name: site,
  title: "",
  url: `https://${site}/`,
  video: false,
});

describe("site mark", () => {
  it("marks YouTube, from its short links too", () => {
    expect(siteMark(page("youtube.com"))).toBe("youtube");
    expect(siteMark(page("youtu.be"))).toBe("youtube");
  });

  it("marks Vimeo, not its player embedded elsewhere", () => {
    expect(siteMark(page("vimeo.com"))).toBe("vimeo");
    expect(siteMark(page("player.vimeo.com"))).toBeNull();
  });

  it("marks Twitch, not its clips' own host", () => {
    expect(siteMark(page("twitch.tv"))).toBe("twitch");
    expect(siteMark(page("clips.twitch.tv"))).toBeNull();
  });

  it("leaves YouTube Music, other sites and no page to the browser's icon", () => {
    expect(siteMark(page("music.youtube.com"))).toBeNull();
    expect(siteMark(page("netflix.com"))).toBeNull();
    expect(siteMark(null)).toBeNull();
  });
});
