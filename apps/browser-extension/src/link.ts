import type { AudibleTab, BrowserMessage, BrowserReadCause } from "@sondine/protocol";
import { fitTabs, sameTabs } from "./audible-tabs.ts";
import { isYoutubePage, youtubeVideoId, type MediaMessage } from "./youtube-state.ts";
import type { PageReport } from "./page-state.ts";

/** How long core has to answer once the port is open, before the link drops it. */
export const ANSWER_TIMEOUT_MS = 10_000;
/**
 * While the link is up, the background reads the tabs this often. Yab never
 * says when a tab starts or stops making sound (no `tabs.onUpdated` with
 * `audible`, 2026-11-10), so only a read sees it; and a worker that calls
 * the tabs API within 30 s stays loaded there.
 */
export const REFRESH_MS = 20_000;
/** The list goes to core at least this often, unchanged or not: the hello says so. */
export const HEARTBEAT_MS = 60_000;
/** After an open link is lost, the alarm keeps trying this long (Sondine restarting). */
export const LOST_RETRY_MS = 10 * 60_000;
/**
 * A YouTube page that said it plays aloud counts as a playing tab this long
 * after its last word; it speaks again every 30 s while it does.
 */
export const PAGE_FRESH_MS = 75_000;

/** The side of a native port the link writes to. */
export interface NativePort {
  postMessage(message: BrowserMessage): void;
  disconnect(): void;
}

export interface LinkDeps {
  /** Opens a port to Sondine's native host; null when the browser cannot. */
  open(): NativePort | null;
  /** Asks the YouTube page in a tab for a fresh media report. */
  requestMedia(tab: number): void;
  /** Turns the one-minute alarm on or off. */
  setAlarm(on: boolean): void;
  /** Starts or stops reading the tabs every `REFRESH_MS`. */
  setRefresh(on: boolean): void;
  /** The extension's version, sent in the hello. */
  version: string;
  now(): number;
}

/** What one read of the tabs found, as counts. */
export interface TabsRead {
  readonly cause: BrowserReadCause;
  /** Every tab the browser returned. */
  readonly tabs: number;
  /** Those it said make sound, before the filters. */
  readonly audible: number;
}

/** What a YouTube page said of itself, lately. */
interface PageClaim {
  /** The tab id its sender gave, if any: when the tabs API knows it, the read judges. */
  readonly said: number | undefined;
  readonly videoId: string | null;
  readonly url: string;
  readonly title: string;
  readonly aloud: boolean;
  readonly atMs: number;
}

type LinkState =
  | { kind: "down" }
  | { kind: "waiting"; port: NativePort; timer: ReturnType<typeof setTimeout> }
  | { kind: "up"; port: NativePort; sent: AudibleTab[] | null; sentAt: number };

export type Link = ReturnType<typeof createLink>;

/**
 * The link to Sondine: opens the native port, waits for core's answer, then
 * sends the hello, the audible tabs at each change and at least every
 * `HEARTBEAT_MS`, and the YouTube reports of listed tabs. The audible tabs
 * are the read's, and the YouTube pages that said lately they play aloud:
 * Yab runs the extension in its Chromium engine, whose tabs API lists none
 * of the tabs its WebKit engine shows (2026-11-10); Yab carries extensions'
 * content scripts into those pages, so they can say it themselves. It never retries
 * on its own: the background calls `retry` from the minute alarm, which runs
 * while the link is open, some tab plays, or an open link was lost (Sondine
 * restarted, or closed a link it took for gone): then each alarm tries again
 * for `LOST_RETRY_MS`, until Sondine refuses or answers.
 */
export function createLink(deps: LinkDeps) {
  let state: LinkState = { kind: "down" };
  /** The audible tabs as the last read found them; null before the first. */
  let queried: AudibleTab[] | null = null;
  /** The read behind `queried`. */
  let read: TabsRead | null = null;
  /** Every tab id the last read returned, heard or not: the tabs API knows them. */
  let seen: ReadonlySet<number> = new Set();
  /** YouTube pages that spoke of themselves, by their own id. */
  const claims = new Map<number, PageClaim>();
  /** The latest report of each YouTube tab, listed or not. */
  const media = new Map<number, MediaMessage>();
  /** Whether the alarm and the reads are on; null until first decided. */
  let alarm: boolean | null = null;
  let refreshing: boolean | null = null;
  /** Until when the alarm connects again after an open link closed; 0 when it does not. */
  let lostUntil = 0;
  const lost = () => lostUntil > deps.now();
  /** When the listed YouTube pages were last asked where their video is. */
  let mediaAskedAt = 0;

  /**
   * Whether a page stands for a tab the tabs API has: its sender's tab, or
   * a read tab on its video (Yab's WebKit engine gave content scripts'
   * senders other ids than its tabs API). Then the read judges it.
   */
  function readHas(claim: PageClaim): boolean {
    if (claim.said !== undefined && seen.has(claim.said)) return true;
    const { videoId } = claim;
    return (
      videoId !== null &&
      (queried ?? []).some(
        (entry) => isYoutubePage(entry.url) && youtubeVideoId(entry.url) === videoId,
      )
    );
  }

  /**
   * The tabs that play: the read's, then the pages that said within
   * `PAGE_FRESH_MS` they play aloud and that no read tab stands for, under
   * their own id. Null before anything was read or said. Stale pages go as
   * it runs, with their cached report.
   */
  function listed(): AudibleTab[] | null {
    const nowMs = deps.now();
    for (const [id, claim] of claims) {
      if (nowMs - claim.atMs <= PAGE_FRESH_MS) continue;
      claims.delete(id);
      media.delete(id);
    }
    if (queried === null && claims.size === 0) return null;
    const out = new Map((queried ?? []).map((entry) => [entry.tab, entry]));
    for (const [id, claim] of claims) {
      if (claim.aloud && !out.has(id) && !readHas(claim)) {
        out.set(id, { tab: id, url: claim.url, title: claim.title });
      }
    }
    return fitTabs([...out.values()]);
  }

  /** Pages a tab stood for: it closed or left YouTube. */
  function dropPagesOf(tab: number): void {
    for (const [id, claim] of claims) {
      if (id === tab || claim.said === tab) {
        claims.delete(id);
        media.delete(id);
      }
    }
  }

  const playing = () => (listed()?.length ?? 0) > 0;

  /** Applies a change to what plays, then sends it, or connects when sound starts. */
  function change(update: () => void, periodic: boolean): void {
    const wasSilent = !playing();
    update();
    if (state.kind === "down") {
      if (wasSilent && playing()) connect();
      schedule();
      return;
    }
    sync(periodic);
    schedule();
  }

  /** The alarm runs while the link is open, was lost, or some tab plays; the reads while it is up. */
  function schedule(): void {
    const wantsAlarm = state.kind !== "down" || lost() || playing();
    if (alarm !== wantsAlarm) {
      alarm = wantsAlarm;
      deps.setAlarm(wantsAlarm);
    }
    const wantsRefresh = state.kind === "up";
    if (refreshing !== wantsRefresh) {
      refreshing = wantsRefresh;
      deps.setRefresh(wantsRefresh);
    }
  }

  function connect(): void {
    if (state.kind !== "down") return;
    const port = deps.open();
    if (port === null) return;
    const timer = setTimeout(() => drop(port), ANSWER_TIMEOUT_MS);
    state = { kind: "waiting", port, timer };
    schedule();
  }

  /** A message on the port. The first is core's answer; nothing else comes. */
  function received(port: NativePort, message: unknown): void {
    if (state.kind !== "waiting" || state.port !== port) return;
    clearTimeout(state.timer);
    const accepted =
      typeof message === "object" && message !== null && "ok" in message && message.ok === true;
    if (!accepted) {
      // Refused (disabled, busy, bad hello) or not an answer. Only « not
      // running » may pass while Sondine restarts: the retries go on.
      const restarting =
        typeof message === "object" &&
        message !== null &&
        "reason" in message &&
        message.reason === "not-running";
      if (!restarting) lostUntil = 0;
      drop(port);
      return;
    }
    state = { kind: "up", port, sent: null, sentAt: 0 };
    lostUntil = 0;
    // The first list asks every YouTube page it has; the next ask is a heartbeat on.
    mediaAskedAt = deps.now();
    post({ type: "hello", extension: deps.version, refreshMs: HEARTBEAT_MS });
    sync(false);
    schedule();
  }

  /** The port closed: Sondine quit or refused, or no host is installed. */
  function closed(port: NativePort): void {
    if (state.kind === "down" || state.port !== port) return;
    if (state.kind === "waiting") clearTimeout(state.timer);
    // A lost open link may come back: Sondine restarted, or took it for gone.
    if (state.kind === "up") lostUntil = deps.now() + LOST_RETRY_MS;
    state = { kind: "down" };
    schedule();
  }

  function drop(port: NativePort): void {
    if (state.kind === "down" || state.port !== port) return;
    closed(port);
    try {
      port.disconnect();
    } catch {
      // Already closed.
    }
  }

  /**
   * The audible tabs, after a read. A read that found no tab at all while
   * some tab is listed is not believed (a worker the browser let go may see
   * none): a listed tab that closes leaves through `removed`.
   */
  function setTabs(next: AudibleTab[], found?: TabsRead, ids?: readonly number[]): void {
    if (found !== undefined && found.tabs === 0 && queried !== null && queried.length > 0) return;
    change(() => {
      queried = next;
      read = found ?? null;
      if (ids !== undefined) seen = new Set(ids);
    }, found?.cause === "refresh");
  }

  /** The alarm rang: connect again if some tab plays or an open link was lost. */
  function retry(): void {
    if (lost() || playing()) connect();
    else schedule();
  }

  /** A YouTube page's report: kept, and sent while its tab is listed. */
  function report(message: MediaMessage): void {
    media.set(message.tab, message);
    if (state.kind === "up" && state.sent?.some((entry) => entry.tab === message.tab)) {
      post(message);
    }
  }

  /** A tab left YouTube: its report is stale. */
  function forget(tab: number): void {
    media.delete(tab);
    if (![...claims.values()].some((claim) => claim.said === tab) && !claims.has(tab)) return;
    change(() => dropPagesOf(tab), false);
  }

  /** A tab closed: it plays no more, whatever the next read says. */
  function removed(tab: number): void {
    media.delete(tab);
    const pages = claims.has(tab) || [...claims.values()].some((claim) => claim.said === tab);
    if (!lists(tab) && !pages) return;
    change(() => {
      dropPagesOf(tab);
      if (queried !== null) queried = queried.filter((entry) => entry.tab !== tab);
      read = null;
    }, false);
  }

  /**
   * The tab a YouTube page's report belongs to. The sender's tab id when the
   * read lists it; else the one read tab on that video (Yab gave a content
   * script's sender an id its tabs API did not use); else the page's own id
   * (a page the tabs API does not list); for an older page without one, the
   * one read YouTube tab, then the sender's id. Null when nothing tells.
   */
  function tabOfReport(
    said: number | undefined,
    videoId: string | null,
    pageId: number | null = null,
  ): number | null {
    const read = queried ?? [];
    if (said !== undefined && read.some((entry) => entry.tab === said)) return said;
    const youtube = read.filter((entry) => isYoutubePage(entry.url));
    const same =
      videoId === null ? [] : youtube.filter((entry) => youtubeVideoId(entry.url) === videoId);
    if (same.length === 1) return same[0]?.tab ?? null;
    if (pageId !== null) return pageId;
    const only = youtube.length === 1 ? youtube[0] : undefined;
    return only?.tab ?? said ?? null;
  }

  /**
   * A YouTube page said where it is and whether it plays aloud. It counts
   * as a playing tab of its own while it says so and no read tab stands for
   * it; where the tabs API knows its tab, the read judges, muted tabs
   * included. Returns the tab its reports go under: the sender's when the
   * read has it, the read tab on its video, else the page's own id.
   */
  function page(said: number | undefined, videoId: string | null, report: PageReport): number {
    const claim: PageClaim = {
      said,
      videoId,
      url: report.url,
      title: report.title,
      aloud: report.aloud,
      atMs: deps.now(),
    };
    change(() => claims.set(report.id, claim), false);
    if (said !== undefined && seen.has(said)) return said;
    return tabOfReport(undefined, videoId, report.id) ?? report.id;
  }

  function lists(tab: number): boolean {
    return listed()?.some((entry) => entry.tab === tab) ?? false;
  }

  /**
   * Sends the audible list if core has not seen it, or on a periodic read
   * when the last went out a heartbeat ago; then the reports of tabs new to
   * core. A periodic read also asks the listed YouTube pages where their
   * video is once a heartbeat, whatever the list did meanwhile, so a missed
   * media event costs at most a minute of positions.
   */
  function sync(periodic: boolean): void {
    const tabs = listed();
    if (state.kind !== "up" || tabs === null) return;
    const before = state.sent;
    const nowMs = deps.now();
    const due = (since: number) => nowMs - since >= HEARTBEAT_MS - REFRESH_MS / 2;
    const changed = before === null || !sameTabs(before, tabs);
    const askAgain = periodic && due(mediaAskedAt);
    if (askAgain) mediaAskedAt = nowMs;
    if (changed || (periodic && due(state.sentAt))) {
      state.sent = tabs;
      state.sentAt = nowMs;
      post({
        type: "tabs",
        at: nowMs,
        tabs,
        ...(read === null ? {} : { read: { ...read, pages: claims.size } }),
      });
    }
    for (const { tab, url } of tabs) {
      if (!isYoutubePage(url)) continue;
      const known = before?.some((entry) => entry.tab === tab) ?? false;
      if (known && !askAgain) continue;
      const cached = media.get(tab);
      if (!known && cached !== undefined) post(cached);
      else deps.requestMedia(tab);
    }
  }

  function post(message: BrowserMessage): void {
    if (state.kind !== "up") return;
    const { port } = state;
    try {
      port.postMessage(message);
    } catch {
      drop(port);
    }
  }

  return {
    connect,
    received,
    closed,
    setTabs,
    retry,
    report,
    forget,
    removed,
    lists,
    tabOfReport,
    page,
  };
}
