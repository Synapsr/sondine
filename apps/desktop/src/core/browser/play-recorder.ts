import { cleanTitle, webPageOf, type MediaMark, type WebPage } from "@sondine/core";
import {
  addWebPlayMark,
  endWebPlay,
  startWebPlay,
  transaction,
  updateWebPlay,
  upsertApp,
  type Database,
} from "@sondine/db";
import type { AudibleTab, BrowserMessage } from "@sondine/protocol";
import { silentTrace, type LinkTrace, type PlayEndReason } from "./link-trace";

// What one browser's extension says, as plays (ADR 023). A browser may hold
// several links at once: Yab starts a second worker while the first still
// runs, and leaves ports open after their worker went. Each `tabs` message
// is the whole set of tabs that play now as that link sees it; a tab plays
// while any open link's latest list has it, with the address and title of
// the link heard last. A tab no link lists stopped; a tab whose page
// changes starts a new play. On YouTube a video keeps its page while the
// tab shows another address (the mini player plays on). Marks of a video's
// position join the tab's current play, or wait for it: the video starts
// before the tab is audible.

/** How far a browser's clock may be from core's before its times are taken as core's. */
const CLOCK_SLACK_PAST_MS = 5 * 60_000;
const CLOCK_SLACK_FUTURE_MS = 5_000;

export interface ConnectedBrowser {
  readonly bundleId: string;
  readonly name: string;
}

interface OpenTab {
  readonly playId: number;
  readonly page: WebPage;
  url: string;
  title: string;
  /** The latest list, of any link, that had it: it never ends before. */
  confirmedAtMs: number;
}

type TabsMessage = Extract<BrowserMessage, { type: "tabs" }>;
type MediaMessage = Extract<BrowserMessage, { type: "media" }>;

export interface BrowserPlays {
  /** A link's latest list of the tabs that play. */
  readonly tabs: (link: number, message: TabsMessage) => void;
  /** A YouTube page's report; true when it marked a play. */
  readonly media: (link: number, message: MediaMessage) => boolean;
  /** A link went away: what it alone listed ends at `atMs`. */
  readonly leave: (link: number, atMs: number, reason: PlayEndReason) => void;
  /** How many of its tabs play now. */
  readonly playing: () => number;
}

/** The time a message gives, unless the browser's clock is too far from ours. */
function clamp(atMs: number, nowMs: number): number {
  return atMs < nowMs - CLOCK_SLACK_PAST_MS || atMs > nowMs + CLOCK_SLACK_FUTURE_MS ? nowMs : atMs;
}

export function openBrowserPlays(
  db: Database,
  browser: ConnectedBrowser,
  now: () => number,
  trace: LinkTrace = silentTrace,
): BrowserPlays {
  const appId = upsertApp(db, {
    bundleId: browser.bundleId,
    name: browser.name,
    seenAtMs: now(),
  }).appId;
  /** Each link's latest list, and when it was heard. */
  const lists = new Map<number, { heardAtMs: number; tabs: ReadonlyMap<number, AudibleTab> }>();
  const open = new Map<number, OpenTab>();
  /** The latest position of each tab's video, kept until its play starts. */
  const lastMedia = new Map<number, MediaMessage>();

  const markOf = (message: MediaMessage, nowMs: number): MediaMark => ({
    wallMs: clamp(message.at, nowMs),
    positionMs: message.positionMs,
    rate: message.rate,
    durationMs: message.durationMs,
    ad: message.ad,
  });

  /** A video's mark belongs to the play of that video, not to whatever the tab shows next. */
  const fits = (message: MediaMessage, tab: OpenTab) =>
    tab.page.video &&
    (message.videoId === null || tab.page.pageKey.endsWith(`?v=${message.videoId}`));

  const startPlay = (
    tabId: number,
    page: WebPage,
    tab: AudibleTab,
    atMs: number,
    nowMs: number,
    link: number,
  ) => {
    const title = cleanTitle(page.site, tab.title);
    const playId = startWebPlay(db, { appId, page, url: tab.url, title, atMs, nowMs });
    const entry: OpenTab = { playId, page, url: tab.url, title, confirmedAtMs: atMs };
    open.set(tabId, entry);
    trace.record({ event: "play", play: playId, tab: tabId, change: "opened", link });
    const pending = lastMedia.get(tabId);
    if (pending !== undefined && fits(pending, entry)) {
      addWebPlayMark(db, playId, markOf(pending, nowMs));
    }
  };

  const endPlay = (
    tabId: number,
    entry: OpenTab,
    atMs: number,
    nowMs: number,
    why: PlayEndReason,
  ) => {
    // A stale link's end never undoes what a fresher link confirmed.
    endWebPlay(db, entry.playId, Math.max(atMs, entry.confirmedAtMs), nowMs);
    open.delete(tabId);
    trace.record({ event: "play", play: entry.playId, tab: tabId, change: "ended", reason: why });
  };

  /** Every listed tab, as the link heard last lists it, with that link. */
  const listed = () => {
    const out = new Map<number, { tab: AudibleTab; link: number; heardAtMs: number }>();
    for (const [link, list] of lists) {
      for (const [tabId, tab] of list.tabs) {
        const known = out.get(tabId);
        if (known === undefined || known.heardAtMs < list.heardAtMs) {
          out.set(tabId, { tab, link, heardAtMs: list.heardAtMs });
        }
      }
    }
    return out;
  };

  /** Brings the plays in line with the links' lists, as of `atMs`. */
  const reconcile = (atMs: number, nowMs: number, why: PlayEndReason) => {
    const current = listed();
    transaction(db, () => {
      for (const [tabId, entry] of open) {
        if (!current.has(tabId)) endPlay(tabId, entry, atMs, nowMs, why);
      }
      for (const [tabId, { tab, link, heardAtMs }] of current) {
        const page = webPageOf(tab.url);
        if (page === null) continue;
        const entry = open.get(tabId);
        if (entry === undefined) {
          startPlay(tabId, page, tab, atMs, nowMs, link);
          continue;
        }
        entry.confirmedAtMs = Math.max(entry.confirmedAtMs, heardAtMs);
        // The mini player: YouTube shows another of its pages, the video plays on.
        const sameVideo = entry.page.video && !page.video && entry.page.site === page.site;
        if (sameVideo) continue;
        if (entry.page.pageKey === page.pageKey) {
          const title = cleanTitle(page.site, tab.title);
          if (entry.url !== tab.url || entry.title !== title) {
            updateWebPlay(db, entry.playId, { url: tab.url, title, nowMs });
            entry.url = tab.url;
            entry.title = title;
          }
          continue;
        }
        endPlay(tabId, entry, atMs, nowMs, "list");
        startPlay(tabId, page, tab, atMs, nowMs, link);
      }
    });
  };

  /**
   * The open play a report belongs to: its tab's, else the one open play of
   * its video (a browser that gives the page another tab id than its list).
   */
  const playOf = (message: MediaMessage): OpenTab | undefined => {
    const entry = open.get(message.tab);
    if (entry !== undefined && fits(message, entry)) return entry;
    if (message.videoId === null) return undefined;
    const same = [...open.values()].filter((candidate) => fits(message, candidate));
    return same.length === 1 ? same[0] : undefined;
  };

  return {
    tabs(link, message) {
      const nowMs = now();
      const atMs = clamp(message.at, nowMs);
      lists.set(link, {
        heardAtMs: atMs,
        tabs: new Map(message.tabs.map((tab) => [tab.tab, tab])),
      });
      reconcile(atMs, nowMs, "list");
    },
    media(_link, message) {
      lastMedia.set(message.tab, message);
      const entry = playOf(message);
      if (entry === undefined) return false;
      addWebPlayMark(db, entry.playId, markOf(message, now()));
      return true;
    },
    leave(link, atMs, reason) {
      if (!lists.delete(link)) return;
      reconcile(atMs, now(), reason);
      if (lists.size === 0) lastMedia.clear();
    },
    playing: () => open.size,
  };
}
