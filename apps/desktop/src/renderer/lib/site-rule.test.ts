import type { PrivacyZone } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { siteRule } from "./site-rule";

const site = (id: string, name: string, on = true, outcome: PrivacyZone["outcome"] = "nothing") =>
  ({
    id,
    builtin: false,
    on,
    outcome,
    situation: { kind: "site", site: name },
  }) satisfies PrivacyZone;
const media = (sites: { site: string; kept: boolean }[], on = true) =>
  ({
    id: "media",
    builtin: true,
    on,
    outcome: "nothing",
    situation: { kind: "media_sites", sites },
  }) satisfies PrivacyZone;

describe("siteRule", () => {
  it("keeps a site no zone leaves out", () => {
    expect(siteRule([], "youtube.com")).toEqual({ kept: true, zone: null });
  });

  it("leaves out a site whose zone is on and keeps nothing, else keeps it with that zone", () => {
    const zone = site("a", "youtube.com");
    expect(siteRule([zone], "youtube.com")).toEqual({ kept: false, zone });
    const off = site("a", "youtube.com", false);
    expect(siteRule([off], "youtube.com")).toEqual({ kept: true, zone: off });
    const textOnly = site("a", "youtube.com", true, "text_only");
    expect(siteRule([textOnly], "youtube.com")).toEqual({ kept: true, zone: textOnly });
  });

  it("reads the films, series and music zone's switch for its sites", () => {
    const zones = [
      media([
        { site: "netflix.com", kept: false },
        { site: "open.spotify.com", kept: true },
      ]),
    ];
    expect(siteRule(zones, "netflix.com").kept).toBe(false);
    expect(siteRule(zones, "open.spotify.com").kept).toBe(true);
    expect(
      siteRule([media([{ site: "netflix.com", kept: false }], false)], "netflix.com").kept,
    ).toBe(true);
  });
});
