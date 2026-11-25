import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { openDatabase, type OpenedDatabase } from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { DATA_LAYOUT } from "../../shared/data-layout";
import {
  ALIVE_EVERY_MS,
  EXPIRY_SLACK_MS,
  MAX_BROWSER_SESSIONS,
  makeBrowserHost,
  type BrowserHostHandle,
} from "./browser-host";
import type { TraceEvent } from "./link-trace";
import { openBrowserPlays } from "./play-recorder";

const T0 = Date.UTC(2026, 10, 9, 15, 0, 0);
const ORIGIN = "chrome-extension://nnieeegenbmpfllllldjpkolkldjmmdb/";
const HELIUM = { bundleId: "net.imput.helium", name: "Helium", path: "/Applications/Helium.app" };

let data: TempDataDir;
let db: OpenedDatabase;
let clock = T0;
beforeEach(() => {
  data = tempDataDir();
  db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
  clock = T0;
});
afterEach(() => {
  db.close();
  data.cleanup();
});

interface PlayRow {
  readonly page: string;
  readonly url: string;
  readonly title: string;
  readonly from: number;
  readonly to: number | null;
}

const playRows = (): PlayRow[] =>
  db
    .statement(
      "SELECT page_key, url, title, started_wall_ms, ended_wall_ms FROM web_plays ORDER BY id",
    )
    .all()
    .map((row) => ({
      page: String(row["page_key"]),
      url: String(row["url"]),
      title: String(row["title"]),
      from: Number(row["started_wall_ms"]) - T0,
      to: row["ended_wall_ms"] === null ? null : Number(row["ended_wall_ms"]) - T0,
    }));

const marks = () =>
  db
    .statement("SELECT play_id, wall_ms, position_ms, rate FROM web_play_marks ORDER BY wall_ms")
    .all()
    .map((row) => [
      Number(row["play_id"]),
      Number(row["wall_ms"]) - T0,
      row["position_ms"],
      row["rate"],
    ]);

const tab = (id: number, url: string, title = "Titre") => ({ tab: id, url, title });

/** One link's view of a browser's plays, as the old per-link session read. */
function linkOf(plays: ReturnType<typeof openBrowserPlays>, link = 1) {
  return {
    receive(message: Parameters<typeof plays.tabs>[1] | Parameters<typeof plays.media>[1]) {
      if (message.type === "tabs") plays.tabs(link, message);
      else plays.media(link, message);
    },
    close: () => plays.leave(link, clock, "link-closed"),
    playing: () => plays.playing(),
  };
}

describe("openBrowserPlays", () => {
  it("turns the audible tabs into plays, one per page in a tab", () => {
    const session = linkOf(
      openBrowserPlays(db, { bundleId: HELIUM.bundleId, name: "Helium" }, () => clock),
    );
    session.receive({
      type: "tabs",
      at: T0,
      tabs: [tab(1, "https://www.youtube.com/watch?v=a", "(2) Une vidéo - YouTube")],
    });
    // Same video, another address: the play keeps its page and takes the new address.
    clock = T0 + 5_000;
    session.receive({
      type: "tabs",
      at: clock,
      tabs: [tab(1, "https://www.youtube.com/watch?v=a&t=5", "Une vidéo - YouTube")],
    });
    // The mini player: YouTube's home page while the video plays on.
    clock = T0 + 8_000;
    session.receive({
      type: "tabs",
      at: clock,
      tabs: [tab(1, "https://www.youtube.com/", "YouTube")],
    });
    // Another video in the same tab, and a second tab.
    clock = T0 + 10_000;
    session.receive({
      type: "tabs",
      at: clock,
      tabs: [
        tab(1, "https://www.youtube.com/watch?v=b", "Autre - YouTube"),
        tab(2, "https://www.netflix.com/watch/81", "Netflix"),
      ],
    });
    clock = T0 + 20_000;
    session.receive({
      type: "tabs",
      at: clock,
      tabs: [tab(2, "https://www.netflix.com/watch/81", "Netflix")],
    });
    clock = T0 + 30_000;
    session.close();
    expect(playRows()).toEqual([
      {
        page: "youtube.com/watch?v=a",
        url: "https://www.youtube.com/watch?v=a&t=5",
        title: "Une vidéo",
        from: 0,
        to: 10_000,
      },
      {
        page: "youtube.com/watch?v=b",
        url: "https://www.youtube.com/watch?v=b",
        title: "Autre",
        from: 10_000,
        to: 20_000,
      },
      {
        page: "netflix.com/watch/81",
        url: "https://www.netflix.com/watch/81",
        title: "",
        from: 10_000,
        to: 30_000,
      },
    ]);
    expect(session.playing()).toBe(0);
  });

  it("gives a video's marks to its play, the one sent before the tab played included", () => {
    const session = linkOf(
      openBrowserPlays(db, { bundleId: HELIUM.bundleId, name: "Helium" }, () => clock),
    );
    const media = (at: number, videoId: string, positionMs: number, rate: number) => ({
      type: "media" as const,
      at: T0 + at,
      tab: 1,
      videoId,
      positionMs,
      durationMs: 600_000,
      rate,
      ad: false,
    });
    session.receive(media(0, "a", 60_000, 1));
    clock = T0 + 300;
    session.receive({
      type: "tabs",
      at: clock,
      tabs: [tab(1, "https://www.youtube.com/watch?v=a")],
    });
    clock = T0 + 5_000;
    session.receive(media(5_000, "a", 64_700, 0));
    // A mark of another video does not join this play.
    session.receive(media(6_000, "z", 0, 1));
    expect(marks()).toEqual([
      [1, 0, 60_000, 1],
      [1, 5_000, 64_700, 0],
    ]);
  });

  it("gives a report whose tab id matches no play to the open play of its video", () => {
    const session = linkOf(
      openBrowserPlays(db, { bundleId: HELIUM.bundleId, name: "Helium" }, () => clock),
    );
    session.receive({ type: "tabs", at: T0, tabs: [tab(1, "https://www.youtube.com/watch?v=a")] });
    const report = (tabId: number, videoId: string | null) => ({
      type: "media" as const,
      at: T0 + 1_000,
      tab: tabId,
      videoId,
      positionMs: 5_000,
      durationMs: null,
      rate: 1,
      ad: false,
    });
    session.receive(report(42, "a"));
    // Without a video id, nothing tells which play it is.
    session.receive({ ...report(43, null), at: T0 + 2_000 });
    expect(marks()).toEqual([[1, 1_000, 5_000, 1]]);
  });

  it("takes core's clock when the browser's is far off", () => {
    const session = linkOf(
      openBrowserPlays(db, { bundleId: HELIUM.bundleId, name: "Helium" }, () => clock),
    );
    session.receive({ type: "tabs", at: T0 - 3_600_000, tabs: [tab(1, "https://example.org/a")] });
    expect(playRows()[0]?.from).toBe(0);
  });
});

/** Yab's plays, as several of its links feed them. */
const yab = () => openBrowserPlays(db, { bundleId: "dev.serafim.fast", name: "Yab" }, () => clock);

describe("openBrowserPlays across links", () => {
  const video = tab(4, "https://www.youtube.com/watch?v=a", "Une vidéo - YouTube");
  const tabs = (at: number, list: ReturnType<typeof tab>[]) => ({
    type: "tabs" as const,
    at: T0 + at,
    tabs: list,
  });

  it("keeps one play while two links list the tab, until none does", () => {
    const browser = yab();
    browser.tabs(1, tabs(0, [video]));
    clock = T0 + 30_000;
    // A second worker's link (Yab) lists the same tab: no second play.
    browser.tabs(2, tabs(30_000, [video]));
    expect(db.statement("SELECT count(*) AS n FROM web_plays").get()?.["n"]).toBe(1);
    // The first link closes while the second still lists the tab: the play goes on.
    clock = T0 + 40_000;
    browser.leave(1, clock, "link-closed");
    expect(browser.playing()).toBe(1);
    clock = T0 + 90_000;
    browser.tabs(2, tabs(90_000, []));
    expect(playRows().map((play) => [play.from, play.to])).toEqual([[0, 90_000]]);
  });

  it("never ends a play before a fresher link confirmed it, when a stale link expires", () => {
    const browser = yab();
    browser.tabs(1, tabs(0, [video]));
    clock = T0 + 60_000;
    browser.tabs(2, tabs(60_000, [video]));
    clock = T0 + 120_000;
    // The second link says it stopped; the first, silent since 0 s, still lists it.
    browser.tabs(2, tabs(120_000, []));
    clock = T0 + 150_000;
    browser.leave(1, T0, "link-expired");
    expect(playRows().map((play) => [play.from, play.to])).toEqual([[0, 60_000]]);
  });

  it("ends a tab that only a closed link listed, and takes the address the latest link gives", () => {
    const browser = yab();
    browser.tabs(1, tabs(0, [video, tab(5, "https://example.org/a")]));
    clock = T0 + 10_000;
    browser.tabs(2, tabs(10_000, [{ ...video, url: "https://www.youtube.com/watch?v=a&t=10" }]));
    clock = T0 + 20_000;
    browser.leave(1, T0 + 15_000, "link-expired");
    expect(playRows().map((play) => [play.page, play.url, play.to])).toEqual([
      ["youtube.com/watch?v=a", "https://www.youtube.com/watch?v=a&t=10", null],
      ["example.org/a", "https://example.org/a", 15_000],
    ]);
  });
});

/** The relay's side of the socket: says hello, reads the answer, then writes lines. */
function relay(path: string, hello: string) {
  return new Promise<{ answer: Record<string, unknown>; socket: Socket; closed: Promise<void> }>(
    (settle, reject) => {
      const socket = connect(path);
      const closed = new Promise<void>((done) => socket.once("close", () => done()));
      let received = "";
      const onData = (chunk: Buffer) => {
        received += chunk.toString("utf8");
        const newline = received.indexOf("\n");
        if (newline === -1) return;
        socket.off("data", onData);
        settle({
          answer: JSON.parse(received.slice(0, newline)) as Record<string, unknown>,
          socket,
          closed,
        });
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${hello}\n`));
    },
  );
}

const send = (socket: Socket, message: unknown) => socket.write(`${JSON.stringify(message)}\n`);

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise((wait) => setTimeout(wait, 5));
  }
  throw new Error("timed out");
}

describe("makeBrowserHost", () => {
  let host: BrowserHostHandle;
  let socketPath: string;
  let traced: TraceEvent[];
  const yabHello = JSON.stringify({
    v: 1,
    origin: ORIGIN,
    browser: { bundleId: "dev.serafim.fast", name: "Yab", path: "/Applications/yab.app" },
  });
  beforeEach(() => {
    socketPath = join(data.dir, DATA_LAYOUT.browserSocket);
    // Each host its own: a previous host's sockets may close once the next test runs.
    const mine: TraceEvent[] = [];
    traced = mine;
    host = makeBrowserHost({
      socketPath,
      db,
      now: () => clock,
      muteMs: 300,
      trace: { record: (event) => mine.push(event) },
    });
  });
  afterEach(() => host.stop());

  it("records what a connected browser plays, and ends it when the browser goes", async () => {
    await host.setEnabled(true);
    const { answer, socket } = await relay(
      socketPath,
      JSON.stringify({ v: 1, origin: ORIGIN, browser: HELIUM }),
    );
    expect(answer).toEqual({ ok: true });
    send(socket, { type: "hello", extension: "0.1.0" });
    socket.write("not json\n");
    send(socket, { type: "tabs", at: T0, tabs: [tab(4, "https://www.youtube.com/watch?v=a")] });
    await until(() => playRows().length === 1);
    expect(host.browsers()).toEqual([
      {
        bundleId: "net.imput.helium",
        name: "Helium",
        links: 1,
        lastHeardAtMs: T0,
        extension: "0.1.0",
      },
    ]);
    clock = T0 + 42_000;
    socket.end();
    await until(() => playRows()[0]?.to !== null);
    expect(playRows()[0]?.to).toBe(42_000);
    await until(() => host.browsers()[0]?.links === 0);
    // Gone, the browser is still known with its last word.
    expect(host.browsers()[0]).toMatchObject({ links: 0, lastHeardAtMs: T0 });
  });

  it("traces links, reads and plays without a page", async () => {
    await host.setEnabled(true);
    const { socket } = await relay(socketPath, yabHello);
    send(socket, { type: "hello", extension: "0.2.0", refreshMs: 60_000 });
    const listed = {
      type: "tabs",
      at: T0,
      tabs: [tab(4, "https://www.youtube.com/watch?v=a", "Secret")],
    };
    send(socket, { ...listed, read: { cause: "start", tabs: 9, audible: 1 } });
    // The same list again is a heartbeat, not traced.
    send(socket, { ...listed, read: { cause: "refresh", tabs: 9, audible: 1 } });
    send(socket, {
      type: "tabs",
      at: T0,
      tabs: [],
      read: { cause: "refresh", tabs: 9, audible: 0 },
    });
    await until(() => playRows()[0]?.to !== null);
    // A message the schema refuses is traced by its issue's code, never its words.
    send(socket, { type: "tabs", at: T0, tabs: [], "https://private.example/secret": 1 });
    await until(() => traced.some((event) => event.event === "invalid"));
    socket.end();
    await until(() => traced.some((event) => event.event === "unlink"));
    expect(traced.map((event) => event.event)).toEqual([
      "listening",
      "link",
      "hello",
      "tabs",
      "play",
      "tabs",
      "play",
      "invalid",
      "unlink",
    ]);
    const text = JSON.stringify(traced);
    expect(text).not.toMatch(/youtube|Secret|secret|https?:/);
    expect(traced.find((event) => event.event === "unlink")).toMatchObject({
      reason: "closed",
      messages: 4,
    });
    expect(traced.find((event) => event.event === "invalid")).toMatchObject({
      issue: "unrecognized_keys",
    });
  });

  it("sums up what each link said every few minutes, so a link that repeats itself shows it lives", async () => {
    await host.setEnabled(true);
    const { socket } = await relay(socketPath, yabHello);
    send(socket, { type: "hello", extension: "0.2.0", refreshMs: 60_000 });
    for (let index = 0; index < 3; index++) {
      send(socket, {
        type: "tabs",
        at: T0,
        tabs: [],
        read: { cause: "refresh", tabs: 14, audible: 0 },
      });
    }
    await until(() => traced.some((event) => event.event === "tabs"));
    await new Promise((wait) => setTimeout(wait, 20));
    clock = T0 + ALIVE_EVERY_MS;
    host.sweep();
    expect(traced.filter((event) => event.event === "tabs")).toHaveLength(1);
    expect(traced.filter((event) => event.event === "alive")).toEqual([
      {
        event: "alive",
        link: 1,
        tabsMessages: 3,
        media: 0,
        read: { cause: "refresh", tabs: 14, audible: 0 },
        listed: 0,
      },
    ]);
  });

  it("closes an answered link that never says hello: nobody is behind it", async () => {
    await host.setEnabled(true);
    const { closed } = await relay(socketPath, yabHello);
    await closed;
    await until(() => traced.some((event) => event.event === "unlink"));
    expect(traced.at(-1)).toMatchObject({ event: "unlink", reason: "mute", messages: 0 });
  });

  it("expires a link that promised a refresh and fell silent, ending its plays at its last word", async () => {
    await host.setEnabled(true);
    const { socket, closed } = await relay(socketPath, yabHello);
    send(socket, { type: "hello", extension: "0.2.0", refreshMs: 60_000 });
    send(socket, { type: "tabs", at: T0, tabs: [tab(4, "https://www.youtube.com/watch?v=a")] });
    await until(() => playRows().length === 1);
    clock = T0 + 2 * 60_000 + EXPIRY_SLACK_MS;
    host.sweep();
    expect(playRows()[0]?.to).toBeNull();
    clock += 1;
    host.sweep();
    await closed;
    await until(() => playRows()[0]?.to !== null);
    expect(playRows()[0]?.to).toBe(0);
    expect(traced.filter((event) => event.event === "unlink")).toMatchObject([
      { reason: "expired" },
    ]);
  });

  it("gives a full house's stalest link's place to a new one", async () => {
    await host.setEnabled(true);
    const links = [];
    for (let index = 0; index < MAX_BROWSER_SESSIONS; index++) {
      const opened = await relay(socketPath, yabHello);
      send(opened.socket, { type: "hello", extension: "0.1.0" });
      links.push(opened);
      clock += 1_000;
    }
    await until(() => host.browsers()[0]?.links === MAX_BROWSER_SESSIONS);
    // Every link spoke within the minute: the next one is refused.
    expect((await relay(socketPath, yabHello)).answer).toEqual({ ok: false, reason: "busy" });
    clock += 60_000;
    expect((await relay(socketPath, yabHello)).answer).toEqual({ ok: true });
    await links[0]?.closed;
    expect(traced.filter((event) => event.event === "unlink")).toMatchObject([
      { link: 1, reason: "evicted" },
    ]);
  });

  it("refuses a bad hello, and every browser while the switch is off", async () => {
    await host.setEnabled(true);
    expect((await relay(socketPath, '{"v":1,"token":"x"}')).answer).toEqual({
      ok: false,
      reason: "bad-hello",
    });
    await host.setEnabled(false);
    expect(host.listening()).toBe(false);
    await expect(relay(socketPath, "{}")).rejects.toThrow();
  });

  it("ends the plays a previous core left open", () => {
    const session = linkOf(
      openBrowserPlays(db, { bundleId: HELIUM.bundleId, name: "Helium" }, () => clock),
    );
    session.receive({ type: "tabs", at: T0, tabs: [tab(1, "https://example.org/a")] });
    clock = T0 + 10_000;
    makeBrowserHost({ socketPath, db, now: () => clock });
    expect(playRows()[0]?.to).toBe(0);
  });
});
