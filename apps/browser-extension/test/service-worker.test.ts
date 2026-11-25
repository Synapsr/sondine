// Runs the built service worker against fake tabs, alarms and native port.

import { createContext, Script } from "node:vm";
import { BrowserMessage } from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import type { MessageSender, Tab, TabChange } from "../src/extension-api.ts";
import { asJson, FakeEvent, script, settle } from "./bundled.ts";

const code = script("background");

class FakeNativePort {
  readonly name: string;
  readonly posted: unknown[] = [];
  disconnected = false;
  readonly onMessage = new FakeEvent<[unknown]>();
  readonly onDisconnect = new FakeEvent<[]>();

  constructor(name: string) {
    this.name = name;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** What core received, checked against its schema. */
  messages(): BrowserMessage[] {
    return asJson(this.posted).map((message) => BrowserMessage.parse(message));
  }
}

function browser(initial: Tab[]) {
  const state = { tabs: initial, queries: 0, lastErrorReads: 0 };
  const ports: FakeNativePort[] = [];
  const alarms = new Map<string, number>();
  const asked: [number, unknown][] = [];
  /** The worker's repeating timers, run by hand. */
  const intervals = new Map<number, { run: () => void; every: number }>();
  let nextInterval = 1;
  const runtime = {
    id: "nnieeegenbmpfllllldjpkolkldjmmdb",
    getManifest: () => ({ version: "0.1.0" }),
    get lastError() {
      state.lastErrorReads += 1;
      return { message: "Specified native messaging host not found." };
    },
    connectNative(name: string): FakeNativePort {
      const port = new FakeNativePort(name);
      ports.push(port);
      return port;
    },
    sendMessage: () => Promise.resolve(),
    onMessage: new FakeEvent<[unknown, MessageSender, ((response: unknown) => void)?]>(),
  };
  const tabs = {
    query: () => {
      state.queries += 1;
      return Promise.resolve(state.tabs.map((tab) => ({ ...tab })));
    },
    sendMessage(tab: number, message: unknown): Promise<unknown> {
      asked.push([tab, message]);
      return Promise.reject(
        new Error("Could not establish connection. Receiving end does not exist."),
      );
    },
    onUpdated: new FakeEvent<[number, TabChange, Tab | undefined]>(),
    onRemoved: new FakeEvent<[number]>(),
    onReplaced: new FakeEvent<[number, number]>(),
  };
  const alarmApi = {
    create(name: string, info: { periodInMinutes: number }): Promise<void> {
      alarms.set(name, info.periodInMinutes);
      return Promise.resolve();
    },
    clear(name: string): Promise<boolean> {
      return Promise.resolve(alarms.delete(name));
    },
    onAlarm: new FakeEvent<[{ name: string }]>(),
  };
  const context = createContext({
    chrome: { runtime, tabs, alarms: alarmApi },
    setTimeout,
    clearTimeout,
    setInterval: (run: () => void, every: number) => {
      const id = nextInterval++;
      intervals.set(id, { run, every });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
    TextEncoder,
    URL,
  });
  new Script(code).runInContext(context);

  const port = (index = -1): FakeNativePort => {
    const found = ports.at(index);
    if (found === undefined) throw new Error("no port opened");
    return found;
  };
  /** Runs every repeating timer once, as if their period passed. */
  const tick = () => {
    for (const { run } of intervals.values()) run();
  };
  return { state, ports, port, alarms, asked, runtime, tabs, alarmApi, intervals, tick };
}

const youtubeTab: Tab = {
  id: 7,
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Une vidéo - YouTube",
  audible: true,
  incognito: false,
  mutedInfo: { muted: false },
};
const silentTab: Tab = {
  id: 8,
  url: "https://example.com/",
  title: "Example",
  audible: false,
  incognito: false,
};
const listed = (tab: Tab) => ({ tab: tab.id, url: tab.url, title: tab.title });
const report = (fields: Record<string, unknown> = {}) => ({
  type: "media",
  at: 1_762_700_000_100,
  videoId: "dQw4w9WgXcQ",
  positionMs: 42000,
  durationMs: 212000,
  rate: 1,
  ad: false,
  ...fields,
});
const fromPage = (id: number, extra: Partial<MessageSender> = {}): MessageSender => ({
  id: "nnieeegenbmpfllllldjpkolkldjmmdb",
  tab: { id, incognito: false },
  frameId: 0,
  ...extra,
});

describe("service worker", () => {
  it("links to Sondine when it starts and sends what plays", async () => {
    const page = browser([youtubeTab, silentTab]);
    expect(page.ports.map((port) => port.name)).toEqual(["app.sondine.browser"]);
    await settle();
    expect(page.alarms.get("sondine-link")).toBe(1);

    page.port().onMessage.fire({ ok: true });
    const messages = page.port().messages();
    expect(messages.map((message) => message.type)).toEqual(["hello", "tabs"]);
    expect(messages[0]).toEqual({ type: "hello", extension: "0.1.0", refreshMs: 60_000 });
    expect(messages[1]).toMatchObject({
      type: "tabs",
      tabs: [listed(youtubeTab)],
      read: { cause: "start", tabs: 2, audible: 1 },
    });
    // No report cached yet: the YouTube page is asked for one.
    expect(page.asked).toEqual([[7, { type: "sondine-report" }]]);
  });

  it("forwards YouTube reports to the listed tab on their video, outside private windows", async () => {
    const page = browser([youtubeTab]);
    await settle();
    page.port().onMessage.fire({ ok: true });
    page.runtime.onMessage.fire(report(), fromPage(7));
    page.runtime.onMessage.fire(report({ positionMs: 1 }), fromPage(7, { frameId: 3 }));
    page.runtime.onMessage.fire(
      report({ positionMs: 2 }),
      fromPage(7, { tab: { id: 7, incognito: true } }),
    );
    page.runtime.onMessage.fire(report({ positionMs: 3 }), fromPage(9));
    page.runtime.onMessage.fire({ type: "media", positionMs: "nope" }, fromPage(7));
    page.runtime.onMessage.fire(report({ positionMs: 4 }), {
      id: "nnieeegenbmpfllllldjpkolkldjmmdb",
    });

    const media = page
      .port()
      .messages()
      .filter((message) => message.type === "media");
    // Yab gives a content script's sender ids its tabs API does not use, or
    // none: the listed tab on the same video stands in.
    expect(media).toEqual([
      { ...report(), tab: 7 },
      { ...report({ positionMs: 1 }), tab: 7 },
      { ...report({ positionMs: 3 }), tab: 7 },
      { ...report({ positionMs: 4 }), tab: 7 },
    ]);
  });

  it("re-reads the tabs when sound starts or stops, not when a silent tab renames", async () => {
    const page = browser([youtubeTab, silentTab]);
    await settle();
    page.port().onMessage.fire({ ok: true });
    const queries = page.state.queries;

    page.tabs.onUpdated.fire(8, { title: "(1) Example" }, { ...silentTab, title: "(1) Example" });
    await settle();
    expect(page.state.queries).toBe(queries);

    page.state.tabs = [youtubeTab, { ...silentTab, audible: true }];
    page.tabs.onUpdated.fire(8, { audible: true }, { ...silentTab, audible: true });
    await settle();
    expect(page.port().messages().at(-1)).toMatchObject({
      type: "tabs",
      tabs: [listed(youtubeTab), listed(silentTab)],
    });

    // A closed tab leaves the list without a read.
    const reads = page.state.queries;
    page.tabs.onRemoved.fire(7);
    expect(page.port().messages().at(-1)).toMatchObject({
      type: "tabs",
      tabs: [listed(silentTab)],
    });
    expect(page.state.queries).toBe(reads);
    // The link is open: the alarm stays, to start a worker the browser let go.
    expect(page.alarms.get("sondine-link")).toBe(1);
  });

  it("reads the tabs every 20 s while linked, which sees a tab start without an event", async () => {
    const page = browser([silentTab]);
    await settle();
    expect(page.intervals.size).toBe(0);
    page.port().onMessage.fire({ ok: true });
    expect([...page.intervals.values()].map((timer) => timer.every)).toEqual([20_000]);

    // Yab says nothing when a tab starts making sound: the next read finds it.
    page.state.tabs = [youtubeTab, silentTab];
    page.tick();
    await settle();
    expect(page.port().messages().at(-1)).toMatchObject({
      type: "tabs",
      tabs: [listed(youtubeTab)],
      read: { cause: "refresh", tabs: 2, audible: 1 },
    });

    page.port().onDisconnect.fire();
    expect(page.intervals.size).toBe(0);
  });

  it("lists a YouTube page the tabs API does not have when it says it plays aloud (Yab)", async () => {
    const page = browser([silentTab]);
    await settle();
    page.port().onMessage.fire({ ok: true });
    const pageId = 2 ** 30 + 11;
    const said = {
      ...report(),
      page: { id: pageId, url: youtubeTab.url, title: youtubeTab.title, aloud: true },
    };
    // Relayed from a WebKit page: no tab the Chromium engine knows.
    page.runtime.onMessage.fire(said, { id: "nnieeegenbmpfllllldjpkolkldjmmdb" });
    const messages = page.port().messages();
    expect(messages.slice(-2)).toEqual([
      expect.objectContaining({ type: "tabs", tabs: [{ ...listed(youtubeTab), tab: pageId }] }),
      { ...report(), tab: pageId },
    ]);
  });

  it("lists any page that says it is heard, and answers it", async () => {
    const page = browser([silentTab]);
    await settle();
    page.port().onMessage.fire({ ok: true });
    const pageId = 2 ** 30 + 12;
    const answers: unknown[] = [];
    const said = (aloud: boolean) => ({
      type: "page",
      page: { id: pageId, url: "https://www.example.org/radio", title: "La radio", aloud },
    });
    page.runtime.onMessage.fire(said(true), { id: "nnieeegenbmpfllllldjpkolkldjmmdb" }, (answer) =>
      answers.push(answer),
    );
    expect(page.port().messages().at(-1)).toMatchObject({
      type: "tabs",
      tabs: [{ tab: pageId, url: "https://www.example.org/radio", title: "La radio" }],
    });
    page.runtime.onMessage.fire(said(false), { id: "nnieeegenbmpfllllldjpkolkldjmmdb" });
    expect(page.port().messages().at(-1)).toMatchObject({ type: "tabs", tabs: [] });
    expect(answers).toEqual([true]);
  });

  it("answers a YouTube page's report, so Yab's page knows the worker heard it", async () => {
    const page = browser([youtubeTab]);
    await settle();
    page.port().onMessage.fire({ ok: true });
    const answers: unknown[] = [];
    page.runtime.onMessage.fire(report(), fromPage(7), (answer) => answers.push(answer));
    page.runtime.onMessage.fire({ type: "other" }, fromPage(7), (answer) => answers.push(answer));
    expect(answers).toEqual([true]);
  });

  it("retries from the alarm while sound plays, after the host went away", async () => {
    const page = browser([youtubeTab]);
    await settle();
    page.port().onDisconnect.fire();
    expect(page.state.lastErrorReads).toBe(1);
    expect(page.ports).toHaveLength(1);

    page.alarmApi.onAlarm.fire({ name: "other" });
    expect(page.ports).toHaveLength(1);
    page.alarmApi.onAlarm.fire({ name: "sondine-link" });
    expect(page.ports).toHaveLength(2);
    page.port().onMessage.fire({ ok: false, reason: "not-running" });
    expect(page.port().disconnected).toBe(true);
    expect(page.port().posted).toEqual([]);
  });

  it("forgets a tab's report when the tab leaves YouTube", async () => {
    const page = browser([]);
    await settle();
    page.port().onMessage.fire({ ok: true });
    page.runtime.onMessage.fire(report(), fromPage(7));
    page.tabs.onUpdated.fire(7, { url: "https://example.com/" }, { id: 7, audible: false });

    const elsewhere = { ...youtubeTab, url: "https://example.com/" };
    page.state.tabs = [elsewhere];
    page.tabs.onUpdated.fire(7, { audible: true }, elsewhere);
    await settle();
    expect(
      page
        .port()
        .messages()
        .map((message) => message.type),
    ).toEqual(["hello", "tabs", "tabs"]);
    expect(page.asked).toEqual([]);
  });
});
