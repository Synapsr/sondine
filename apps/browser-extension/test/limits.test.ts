import * as protocol from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import * as limits from "../src/limits.ts";

describe("limits", () => {
  it("equal the protocol's", () => {
    expect(limits.BROWSER_HOST_NAME).toBe(protocol.BROWSER_HOST_NAME);
    expect(limits.BROWSER_URL_MAX).toBe(protocol.BROWSER_URL_MAX);
    expect(limits.BROWSER_TITLE_MAX).toBe(protocol.BROWSER_TITLE_MAX);
    expect(limits.BROWSER_TABS_MAX).toBe(protocol.BROWSER_TABS_MAX);
    expect(limits.BROWSER_LINE_MAX).toBe(protocol.BROWSER_LINE_MAX);
  });

  it("match the schemas' inline bounds", () => {
    const tab = { url: "https://example.com/", title: "" };
    expect(protocol.AudibleTab.safeParse({ ...tab, tab: limits.TAB_ID_MAX }).success).toBe(true);
    expect(protocol.AudibleTab.safeParse({ ...tab, tab: limits.TAB_ID_MAX + 1 }).success).toBe(
      false,
    );

    const media = {
      type: "media",
      at: 1,
      tab: 1,
      videoId: "a".repeat(64),
      positionMs: 0,
      durationMs: null,
      ad: false,
    };
    expect(protocol.BrowserMessage.safeParse({ ...media, rate: limits.RATE_MAX }).success).toBe(
      true,
    );
    expect(
      protocol.BrowserMessage.safeParse({ ...media, rate: limits.RATE_MAX + 0.01 }).success,
    ).toBe(false);
    expect(limits.VIDEO_ID.test(media.videoId)).toBe(true);
    expect(limits.VIDEO_ID.test("a".repeat(65))).toBe(false);
    const longId = { ...media, rate: 1, videoId: "a".repeat(65) };
    expect(protocol.BrowserMessage.safeParse(longId).success).toBe(false);

    for (const url of ["https://example.com/a b", "ftp://example.com/", "http://x"]) {
      const accepted = protocol.AudibleTab.safeParse({ ...tab, tab: 1, url }).success;
      expect(limits.PAGE_URL.test(url)).toBe(accepted);
    }
  });
});
