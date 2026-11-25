import { BrowserMessage, type AudibleTab } from "@sondine/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_TIMEOUT_MS,
  createLink,
  HEARTBEAT_MS,
  LOST_RETRY_MS,
  PAGE_FRESH_MS,
  REFRESH_MS,
  type NativePort,
  type TabsRead,
} from "../src/link.ts";
import type { MediaMessage } from "../src/youtube-state.ts";

class FakePort implements NativePort {
  posted: BrowserMessage[] = [];
  disconnected = false;
  broken = false;

  postMessage(message: BrowserMessage): void {
    if (this.broken) throw new Error("Attempting to use a disconnected port object");
    // Every message the link sends must pass core's schema.
    this.posted.push(BrowserMessage.parse(message));
  }

  disconnect(): void {
    this.disconnected = true;
  }

  types(): string[] {
    return this.posted.map((message) => message.type);
  }
}

function setup() {
  const ports: FakePort[] = [];
  const requests: number[] = [];
  const alarms: boolean[] = [];
  const refreshes: boolean[] = [];
  const host = { installed: true };
  const clock = { now: 1_762_700_000_000 };
  const link = createLink({
    version: "0.2.0",
    now: () => clock.now,
    open: () => {
      if (!host.installed) return null;
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    requestMedia: (tab) => requests.push(tab),
    setAlarm: (on) => alarms.push(on),
    setRefresh: (on) => refreshes.push(on),
  });
  const port = (index = -1): FakePort => {
    const found = ports.at(index);
    if (found === undefined) throw new Error("no port opened");
    return found;
  };
  return { link, ports, port, requests, alarms, refreshes, host, clock };
}

const HELLO = { type: "hello", extension: "0.2.0", refreshMs: HEARTBEAT_MS };
const read = (cause: TabsRead["cause"], tabs: number, audible: number): TabsRead => ({
  cause,
  tabs,
  audible,
});
/** A read as it goes out, with the pages that spoke. */
const sent = (cause: TabsRead["cause"], tabs: number, audible: number, pages = 0) => ({
  ...read(cause, tabs, audible),
  pages,
});

const tab = (id: number, url = `https://example.com/${id}`): AudibleTab => ({
  tab: id,
  url,
  title: `Tab ${id}`,
});
const youtube = (id: number): AudibleTab => tab(id, `https://www.youtube.com/watch?v=v${id}`);
const media = (id: number, positionMs = 1000): MediaMessage => ({
  type: "media",
  at: 1_762_700_000_000,
  tab: id,
  videoId: `v${id}`,
  positionMs,
  durationMs: 60_000,
  rate: 1,
  ad: false,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("link", () => {
  it("sends the hello, the audible tabs, then cached YouTube reports once core accepts", () => {
    const { link, port, requests } = setup();
    link.report(media(2));
    link.setTabs([tab(1), youtube(2), youtube(3)]);
    expect(port().posted).toEqual([]);

    link.received(port(), { ok: true });
    expect(port().posted).toEqual([
      HELLO,
      { type: "tabs", at: 1_762_700_000_000, tabs: [tab(1), youtube(2), youtube(3)] },
      media(2),
    ]);
    // Tab 3 plays YouTube but nothing is cached: its page is asked.
    expect(requests).toEqual([3]);
  });

  it("sends the tabs once known when core answers first", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    expect(port().types()).toEqual(["hello"]);
    link.setTabs([]);
    expect(port().posted.at(-1)).toEqual({ type: "tabs", at: 1_762_700_000_000, tabs: [] });
  });

  it("connects when the background starts and when sound starts, not at every change", () => {
    const { link, ports } = setup();
    link.connect();
    link.connect();
    expect(ports).toHaveLength(1);

    link.closed(ports[0] ?? new FakePort());
    link.setTabs([tab(1)]);
    expect(ports).toHaveLength(2);
    link.closed(ports[1] ?? new FakePort());
    link.setTabs([tab(1), tab(2)]);
    expect(ports).toHaveLength(2);
    link.setTabs([]);
    link.setTabs([tab(3)]);
    expect(ports).toHaveLength(3);
  });

  it("drops the port on a refusal and retries only from the alarm while sound plays", () => {
    const { link, ports, port } = setup();
    link.setTabs([tab(1)]);
    link.received(port(), { ok: false, reason: "disabled" });
    expect(port().disconnected).toBe(true);
    expect(port().posted).toEqual([]);

    link.setTabs([tab(1), tab(2)]);
    expect(ports).toHaveLength(1);
    link.retry();
    expect(ports).toHaveLength(2);

    link.closed(port());
    link.setTabs([]);
    link.retry();
    expect(ports).toHaveLength(2);
  });

  it("treats anything but an accepting answer as a refusal", () => {
    for (const answer of [null, "ok", { ok: "true" }, { reason: "busy" }, []]) {
      const { link, port } = setup();
      link.connect();
      link.received(port(), answer);
      expect(port().disconnected).toBe(true);
    }
  });

  it("drops a port that never answers", () => {
    const { link, port, ports } = setup();
    link.setTabs([tab(1)]);
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS - 1);
    expect(port().disconnected).toBe(false);
    vi.advanceTimersByTime(1);
    expect(port().disconnected).toBe(true);
    link.retry();
    expect(ports).toHaveLength(2);
  });

  it("does not time out once core has answered", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS * 2);
    expect(port().disconnected).toBe(false);
  });

  it("sends the list only when it changes", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([tab(1)]);
    link.setTabs([tab(1)]);
    link.setTabs([{ ...tab(1), title: "Renamed" }]);
    link.setTabs([]);
    link.setTabs([]);
    expect(port().posted.slice(1)).toEqual([
      { type: "tabs", at: 1_762_700_000_000, tabs: [tab(1)] },
      { type: "tabs", at: 1_762_700_000_000, tabs: [{ ...tab(1), title: "Renamed" }] },
      { type: "tabs", at: 1_762_700_000_000, tabs: [] },
    ]);
  });

  it("forwards reports of listed tabs, and keeps the others until their tab is listed", () => {
    const { link, port, requests } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([youtube(1)]);
    link.report(media(1, 5000));
    expect(port().posted.at(-1)).toEqual(media(1, 5000));

    // A video starts: its report comes before its tab is audible.
    link.report(media(2, 0));
    expect(port().types()).toEqual(["hello", "tabs", "media"]);
    link.setTabs([youtube(1), youtube(2)]);
    expect(port().posted.slice(-2)).toEqual([
      { type: "tabs", at: 1_762_700_000_000, tabs: [youtube(1), youtube(2)] },
      media(2, 0),
    ]);
    // Tab 1's page was asked once, when first listed without a report; never again.
    expect(requests).toEqual([1]);
  });

  it("forgets a tab's report", () => {
    const { link, port, requests } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.report(media(1));
    link.forget(1);
    link.setTabs([youtube(1)]);
    expect(port().types()).toEqual(["hello", "tabs"]);
    expect(requests).toEqual([1]);
  });

  it("asks no page that is not YouTube", () => {
    const { link, port, requests } = setup();
    link.setTabs([tab(1)]);
    link.received(port(), { ok: true });
    expect(requests).toEqual([]);
  });

  it("goes down when the port closes, and starts over on the next port", () => {
    const { link, ports } = setup();
    link.setTabs([youtube(1)]);
    const first = ports[0] ?? new FakePort();
    link.received(first, { ok: true });
    link.report(media(1));
    link.closed(first);

    link.report(media(1, 2000));
    expect(first.posted).toHaveLength(3);
    link.retry();
    const second = ports[1] ?? new FakePort();
    // A late message on the old port changes nothing.
    link.received(first, { ok: true });
    expect(second.posted).toEqual([]);
    link.received(second, { ok: true });
    expect(second.posted).toEqual([
      HELLO,
      { type: "tabs", at: 1_762_700_000_000, tabs: [youtube(1)] },
      media(1, 2000),
    ]);
  });

  it("ignores a second answer", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.received(port(), { ok: false, reason: "busy" });
    expect(port().disconnected).toBe(false);
    expect(port().types()).toEqual(["hello"]);
  });

  it("goes down when posting fails", () => {
    const { link, port, ports } = setup();
    link.setTabs([tab(1)]);
    port().broken = true;
    link.received(port(), { ok: true });
    expect(port().disconnected).toBe(true);
    link.retry();
    expect(ports).toHaveLength(2);
  });

  it("stays down when the browser cannot open a port", () => {
    const { link, ports, host } = setup();
    host.installed = false;
    link.setTabs([tab(1)]);
    link.retry();
    expect(ports).toHaveLength(0);
    host.installed = true;
    link.retry();
    expect(ports).toHaveLength(1);
  });

  it("keeps the alarm on while some tab plays or the link is open, and reads while it is up", () => {
    const { link, alarms, refreshes, port, host } = setup();
    host.installed = false;
    link.setTabs([]);
    link.setTabs([]);
    link.setTabs([tab(1)]);
    link.setTabs([tab(1), tab(2)]);
    link.setTabs([]);
    expect(alarms).toEqual([false, true, false]);
    expect(refreshes).toEqual([false]);

    // Open, the link keeps the alarm with nothing playing: Yab never says a tab started.
    host.installed = true;
    link.connect();
    expect(alarms.at(-1)).toBe(true);
    link.received(port(), { ok: true });
    expect(refreshes).toEqual([false, true]);
    // Lost, the link keeps the alarm for one more try; the reads stop.
    link.closed(port());
    expect(alarms.at(-1)).toBe(true);
    expect(refreshes).toEqual([false, true, false]);
  });

  it("sends the unchanged list on a periodic read once a heartbeat has passed", () => {
    const { link, port, requests, clock } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([youtube(1)], read("start", 3, 1));
    expect(requests).toEqual([1]);
    for (let elapsed = REFRESH_MS; elapsed <= HEARTBEAT_MS; elapsed += REFRESH_MS) {
      clock.now += REFRESH_MS;
      link.setTabs([youtube(1)], read("refresh", 3, 1));
    }
    // A change goes at once; an event's read never counts as a heartbeat.
    clock.now += REFRESH_MS;
    link.setTabs([youtube(1)], read("event", 3, 1));
    const tabsMessages = port().posted.filter((message) => message.type === "tabs");
    expect(tabsMessages).toEqual([
      { type: "tabs", at: 1_762_700_000_000, tabs: [youtube(1)], read: sent("start", 3, 1) },
      {
        type: "tabs",
        at: 1_762_700_000_000 + HEARTBEAT_MS,
        tabs: [youtube(1)],
        read: sent("refresh", 3, 1),
      },
    ]);
    // With the heartbeat, the page is asked where the video is.
    expect(requests).toEqual([1, 1]);
  });

  it("keeps trying for a while after losing an open link, until Sondine refuses", () => {
    const { link, ports, port, alarms, clock } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([]);
    // Sondine restarted: nothing plays, yet each alarm connects again.
    link.closed(port());
    expect(alarms.at(-1)).toBe(true);
    link.retry();
    expect(ports).toHaveLength(2);
    // Not back yet: the tries go on.
    link.received(port(), { ok: false, reason: "not-running" });
    expect(alarms.at(-1)).toBe(true);
    clock.now += 60_000;
    link.retry();
    expect(ports).toHaveLength(3);
    // The user turned the link off: no more tries while nothing plays.
    link.received(port(), { ok: false, reason: "disabled" });
    expect(alarms.at(-1)).toBe(false);
    link.retry();
    expect(ports).toHaveLength(3);
  });

  it("stops trying once the lost link's window has passed", () => {
    const { link, ports, port, alarms, clock } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([]);
    link.closed(port());
    clock.now += LOST_RETRY_MS + 1;
    link.retry();
    expect(ports).toHaveLength(1);
    expect(alarms.at(-1)).toBe(false);
  });

  it("asks the YouTube pages once a heartbeat, even while the list keeps changing", () => {
    const { link, port, requests, clock } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([youtube(1)], read("start", 3, 1));
    // A title that changes at every read (a page counting notifications).
    for (let index = 1; index <= 9; index++) {
      clock.now += REFRESH_MS;
      link.setTabs([{ ...youtube(1), title: `(${index}) Vidéo` }], read("refresh", 3, 1));
    }
    // 3 minutes of reads: the first ask, then one per heartbeat.
    expect(requests).toEqual([1, 1, 1, 1]);
  });

  it("lists a page that says it plays aloud under its own id, until it is quiet or stale", () => {
    const { link, port, clock } = setup();
    link.connect();
    link.received(port(), { ok: true });
    // Yab's Chromium engine lists none of its WebKit tabs.
    link.setTabs([], read("start", 1, 0));
    const pageId = 2 ** 30 + 5;
    const video = youtube(9);
    expect(
      link.page(undefined, "v9", { id: pageId, url: video.url, title: "Tab 9", aloud: true }),
    ).toBe(pageId);
    link.report({ ...media(9), tab: pageId });
    expect(port().posted.slice(-2)).toEqual([
      {
        type: "tabs",
        at: clock.now,
        tabs: [{ tab: pageId, url: video.url, title: "Tab 9" }],
        read: sent("start", 1, 0, 1),
      },
      { ...media(9), tab: pageId },
    ]);
    // The next read says how many pages spoke.
    clock.now += HEARTBEAT_MS;
    link.setTabs([], read("refresh", 1, 0));
    expect(port().posted.at(-1)).toMatchObject({ read: sent("refresh", 1, 0, 1) });
    // Silent past its freshness, the page plays no more.
    clock.now += PAGE_FRESH_MS + 1;
    link.setTabs([], read("refresh", 1, 0));
    expect(port().posted.at(-1)).toEqual({
      type: "tabs",
      at: clock.now,
      tabs: [],
      read: sent("refresh", 1, 0, 0),
    });
  });

  it("drops a page at once when it says it went quiet, and never lists a read tab twice", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([youtube(1)], read("start", 4, 1));
    const page = { id: 2 ** 30 + 7, url: youtube(1).url, title: "Tab 1", aloud: true };
    // The read already has the tab on that video: the page joins it.
    expect(link.page(42, "v1", page)).toBe(1);
    const other = { id: 2 ** 30 + 8, url: youtube(2).url, title: "Tab 2", aloud: true };
    link.page(undefined, "v2", other);
    link.page(undefined, "v2", { ...other, aloud: false });
    const lists = port()
      .posted.filter((message) => message.type === "tabs")
      .map((message) => (message.type === "tabs" ? message.tabs.map((entry) => entry.tab) : []));
    expect(lists).toEqual([[1], [1, other.id], [1]]);
  });

  it("lets the read judge a page whose tab it returns: a tab muted from its tab stays out", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    // Chrome: tab 5 is read, muted from the tab, so not listed; its video plays unmuted.
    link.setTabs([], read("start", 3, 1), [4, 5, 6]);
    const said = { id: 2 ** 30 + 1, url: youtube(5).url, title: "Tab 5", aloud: true };
    expect(link.page(5, "v5", said)).toBe(5);
    expect(link.lists(5)).toBe(false);
    expect(link.lists(said.id)).toBe(false);
  });

  it("gives a page to the read tab on its video once the read has it, without a second entry", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([], read("start", 1, 0), [1]);
    const said = { id: 2 ** 30 + 2, url: youtube(3).url, title: "Tab 3", aloud: true };
    link.page(undefined, "v3", said);
    expect(link.lists(said.id)).toBe(true);
    link.setTabs([youtube(3)], read("refresh", 2, 1), [1, 3]);
    expect(link.page(undefined, "v3", said)).toBe(3);
    expect(link.lists(said.id)).toBe(false);
    expect(link.lists(3)).toBe(true);
  });

  it("never leaves a page behind its tab: read first, then closed or navigated away", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([], read("start", 1, 0), [1]);
    const said = { id: 2 ** 30 + 3, url: youtube(7).url, title: "Tab 7", aloud: true };
    // The page speaks before the read sees its tab audible.
    link.page(7, "v7", said);
    expect(link.lists(said.id)).toBe(true);
    link.setTabs([youtube(7)], read("refresh", 2, 1), [1, 7]);
    // One entry: the read's.
    expect(link.lists(said.id)).toBe(false);
    expect(link.lists(7)).toBe(true);
    link.removed(7);
    expect(link.lists(7)).toBe(false);
    expect(link.lists(said.id)).toBe(false);

    // A tab the API does not list leaves YouTube: its page goes with it.
    link.page(8, "v8", { ...said, id: 2 ** 30 + 4, url: youtube(8).url });
    expect(link.lists(2 ** 30 + 4)).toBe(true);
    link.forget(8);
    expect(link.lists(2 ** 30 + 4)).toBe(false);
  });

  it("connects when a page says it plays, the link down", () => {
    const { link, ports, host } = setup();
    host.installed = false;
    link.setTabs([], read("start", 1, 0));
    host.installed = true;
    link.page(undefined, "v3", { id: 2 ** 30 + 9, url: youtube(3).url, title: "", aloud: true });
    expect(ports).toHaveLength(1);
  });

  it("does not believe a read that found no tab at all while some tab is listed", () => {
    const { link, port } = setup();
    link.connect();
    link.received(port(), { ok: true });
    link.setTabs([tab(1)], read("start", 5, 1));
    link.setTabs([], read("refresh", 0, 0));
    expect(link.lists(1)).toBe(true);
    link.setTabs([], read("refresh", 5, 0));
    expect(link.lists(1)).toBe(false);
    expect(port().posted.at(-1)).toEqual({
      type: "tabs",
      at: 1_762_700_000_000,
      tabs: [],
      read: sent("refresh", 5, 0),
    });
  });

  it("drops a closed tab from the list at once", () => {
    const { link, port } = setup();
    link.setTabs([tab(1), tab(2)]);
    link.received(port(), { ok: true });
    link.removed(2);
    link.removed(9);
    expect(port().posted.slice(1)).toEqual([
      { type: "tabs", at: 1_762_700_000_000, tabs: [tab(1), tab(2)] },
      { type: "tabs", at: 1_762_700_000_000, tabs: [tab(1)] },
    ]);
    link.closed(port());
    link.removed(1);
    expect(link.lists(1)).toBe(false);
  });

  it("finds the tab of a report whose sender's id the list does not use (Yab)", () => {
    const { link } = setup();
    expect(link.tabOfReport(7, "v1")).toBe(7);
    expect(link.tabOfReport(undefined, "v1")).toBeNull();
    link.setTabs([tab(3), youtube(1), youtube(2)]);
    // A listed sender id is trusted.
    expect(link.tabOfReport(2, "v1")).toBe(2);
    // Otherwise the one listed tab on the video, then the one YouTube tab.
    expect(link.tabOfReport(99, "v1")).toBe(1);
    expect(link.tabOfReport(undefined, "v2")).toBe(2);
    expect(link.tabOfReport(99, "zz")).toBe(99);
    link.setTabs([tab(3), youtube(1)]);
    expect(link.tabOfReport(99, null)).toBe(1);
  });

  it("knows which tabs are listed", () => {
    const { link } = setup();
    expect(link.lists(1)).toBe(false);
    link.setTabs([tab(1)]);
    expect(link.lists(1)).toBe(true);
    expect(link.lists(2)).toBe(false);
  });
});
