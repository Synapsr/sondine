import { describe, expect, it } from "vitest";
import {
  ackFrom,
  isNewer,
  isReleaseBuild,
  isReleasePage,
  LATEST_UPDATE_FEED,
  relaunchArgument,
  relaunchFrom,
  releasePage,
  testUpdateFeed,
  TEST_UPDATE_FEED,
  updateArchiveUrl,
  versionOfTag,
} from "./updates";

describe("releases", () => {
  it("reads a version from a release tag, and nothing else", () => {
    expect(versionOfTag("desktop-v0.3.1")).toBe("0.3.1");
    expect(versionOfTag("desktop-v01.2.3")).toBe("1.2.3");
    for (const tag of ["v0.3.1", "desktop-v0.3", "desktop-v0.3.1-beta", "mobile-v0.3.1", ""]) {
      expect(versionOfTag(tag)).toBeNull();
    }
  });

  it("compares versions by their numbers", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.1", "0.2.0")).toBe(false);
    expect(isNewer("", "0.2.0")).toBe(false);
  });

  it("reads the project's own repository (ADR 041)", () => {
    expect(LATEST_UPDATE_FEED).toBe(
      "https://github.com/Synapsr/sondine/releases/latest/download/sondine-mac.json",
    );
    expect(releasePage("0.8.0")).toBe(
      "https://github.com/Synapsr/sondine/releases/tag/desktop-v0.8.0",
    );
    // Where the versions up to 0.7.0 look, then archived.
    expect(
      isReleasePage("https://github.com/teo-goulois/sondine-releases/releases/tag/desktop-v0.7.0"),
    ).toBe(false);
  });

  it("lets the window open only the repository's release pages", () => {
    expect(isReleasePage(releasePage("0.3.0"))).toBe(true);
    for (const url of [
      releasePage("0.3.0").replace("/tag/desktop-v0.3.0", ""),
      "https://github.com/someone/else/releases/tag/desktop-v0.3.0",
      `${releasePage("0.3.0")}?x`,
      "https://github.com/",
    ]) {
      expect(isReleasePage(url)).toBe(false);
    }
  });

  it("names an archive in its own release, or beside a test feed", () => {
    expect(updateArchiveUrl("0.8.0", null)).toBe(
      `${releasePage("0.8.0").replace("/tag/", "/download/")}/Sondine-0.8.0-arm64.zip`,
    );
    expect(updateArchiveUrl("0.8.0", "http://127.0.0.1:8123/sondine-mac.json")).toBe(
      "http://127.0.0.1:8123/Sondine-0.8.0-arm64.zip",
    );
  });

  it("takes a test feed of this Mac alone, and none unless a build compiled it in", () => {
    for (const url of [
      "http://127.0.0.1.evil.example:80/sondine-mac.json",
      "https://github.com/sondine-mac.json",
      "http://127.0.0.1:80/other.json",
    ]) {
      expect(TEST_UPDATE_FEED.test(url)).toBe(false);
    }
    expect(testUpdateFeed()).toBeNull();
    expect(isReleaseBuild()).toBe(false);
  });
});

describe("the start after an update", () => {
  it("keeps the window as it was, on its page", () => {
    for (const relaunch of [
      { window: "closed", path: null },
      { window: "behind", path: "/episode/12" },
      { window: "front", path: "/" },
    ] as const) {
      expect(relaunchFrom(["/x/Sondine", relaunchArgument(relaunch)])).toEqual(relaunch);
    }
  });

  it("takes the acknowledgement's name alone, never a path", () => {
    const name = "sondine-update-11111111-1111-1111-1111-111111111111";
    expect(ackFrom([`--sondine-update-ack=${name}`])).toBe(name);
    expect(ackFrom([`--sondine-update-ack=../${name}`])).toBeNull();
    expect(ackFrom(["/x/Sondine"])).toBeNull();
  });

  it("takes only a plain page, and says nothing without an update", () => {
    expect(relaunchArgument({ window: "front", path: "/search?tag=x y" })).toBe(
      "--sondine-updated=front",
    );
    expect(relaunchFrom(["/x/Sondine"])).toBeNull();
    expect(relaunchFrom(["--sondine-updated=front//evil.example?x"])).toBeNull();
    expect(relaunchFrom(["--sondine-updated=other"])).toBeNull();
  });
});
