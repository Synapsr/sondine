import { cut } from "../src/cut.ts";
import { AudibleTab, BrowserMessage } from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import {
  audibleTabs,
  sameTabs,
  tabChangeMatters,
  TABS_MESSAGE_BUDGET,
} from "../src/audible-tabs.ts";
import type { Tab } from "../src/extension-api.ts";

const playing = (id: number, extra: Partial<Tab> = {}): Tab => ({
  id,
  url: `https://example.com/${id}`,
  title: `Tab ${id}`,
  audible: true,
  incognito: false,
  mutedInfo: { muted: false },
  ...extra,
});

describe("audibleTabs", () => {
  it("lists heard tabs on web pages, sorted by id", () => {
    const tabs = audibleTabs([
      playing(9),
      playing(3),
      playing(4, { audible: false }),
      playing(5, { mutedInfo: { muted: true } }),
      playing(6, { incognito: true }),
      playing(7, { url: "chrome://settings/" }),
      playing(8, { url: "file:///Users/me/a.mp3" }),
      playing(10, { url: "about:blank" }),
      playing(11, { url: "chrome-extension://abc/page.html" }),
      { id: 12, title: "No address", audible: true },
      playing(-1),
      { audible: true, url: "https://example.com/" },
      playing(3, { title: "Duplicate" }),
    ]);
    expect(tabs).toEqual([
      { tab: 3, url: "https://example.com/3", title: "Tab 3" },
      { tab: 9, url: "https://example.com/9", title: "Tab 9" },
    ]);
  });

  it("tolerates missing fields", () => {
    expect(audibleTabs([{ id: 1, audible: true, url: "http://example.com/" }])).toEqual([
      { tab: 1, url: "http://example.com/", title: "" },
    ]);
    expect(audibleTabs([{ id: 1, url: "https://example.com/" }])).toEqual([]);
  });

  it("cuts addresses and titles to the protocol's limits", () => {
    const [tab] = audibleTabs([
      playing(1, { url: `https://example.com/${"a".repeat(3000)}`, title: "t".repeat(400) }),
    ]);
    expect(tab?.url).toHaveLength(2048);
    expect(tab?.title).toHaveLength(300);
    expect(AudibleTab.safeParse(tab).success).toBe(true);
  });

  it("drops an address with whitespace, which the protocol refuses", () => {
    expect(audibleTabs([playing(1, { url: "https://example.com/a b" })])).toEqual([]);
  });

  it("lists at most 32 tabs and keeps the message under its budget", () => {
    const many = Array.from({ length: 40 }, (_, index) => playing(index + 1));
    expect(audibleTabs(many)).toHaveLength(32);

    const huge = Array.from({ length: 32 }, (_, index) =>
      playing(index + 1, {
        url: `https://example.com/${"a".repeat(3000)}`,
        title: "é".repeat(300),
      }),
    );
    const tabs = audibleTabs(huge);
    const message = { type: "tabs", at: Date.now(), tabs };
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.length).toBeLessThan(32);
    expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(
      TABS_MESSAGE_BUDGET,
    );
    expect(BrowserMessage.safeParse(message).success).toBe(true);
  });
});

describe("cut", () => {
  it("never splits a surrogate pair", () => {
    expect(cut("ab😀", 3)).toBe("ab");
    expect(cut("ab😀", 4)).toBe("ab😀");
    expect(cut("abcd", 2)).toBe("ab");
  });
});

describe("sameTabs", () => {
  const list = audibleTabs([playing(1), playing(2)]);
  it("compares ids, addresses and titles in order", () => {
    expect(sameTabs(list, audibleTabs([playing(2), playing(1)]))).toBe(true);
    expect(sameTabs(list, audibleTabs([playing(1)]))).toBe(false);
    expect(sameTabs(list, audibleTabs([playing(1), playing(2, { title: "New" })]))).toBe(false);
    expect(sameTabs(list, audibleTabs([playing(1), playing(2, { url: "https://a.b/" })]))).toBe(
      false,
    );
    expect(sameTabs([], [])).toBe(true);
  });
});

describe("tabChangeMatters", () => {
  it("re-reads tabs when sound starts or stops, or a playing tab changes", () => {
    expect(tabChangeMatters({ audible: false }, undefined, false)).toBe(true);
    expect(tabChangeMatters({ mutedInfo: { muted: true } }, undefined, false)).toBe(true);
    expect(tabChangeMatters({ discarded: true }, undefined, false)).toBe(true);
    expect(tabChangeMatters({ title: "(2) Inbox" }, { audible: true }, false)).toBe(true);
    expect(tabChangeMatters({ url: "https://a.b/" }, undefined, true)).toBe(true);
  });

  it("skips silent tabs' title changes and unrelated updates", () => {
    expect(tabChangeMatters({ title: "(2) Inbox" }, { audible: false }, false)).toBe(false);
    expect(tabChangeMatters({ title: "(2) Inbox" }, undefined, false)).toBe(false);
    expect(tabChangeMatters({}, { audible: true }, true)).toBe(false);
  });
});
