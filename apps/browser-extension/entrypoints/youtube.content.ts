// The YouTube content script (a classic script once built), in the page's
// isolated world. It reports where the video that plays aloud is, at each of
// its media events, when the page's address names another video, and every
// 30 s while it plays aloud; each report also says the page's address and
// title and whether it is heard, for a browser whose tabs API does not list
// the tab (Yab's Chromium engine and its WebKit tabs). It reads the video
// element, the address, the document's title (the tab's) and the player's
// ad classes; never the page's text.

import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { defineContentScript } from "wxt/utils/define-content-script";
import { cut } from "../src/cut.ts";
import { extensionApi, type Runtime } from "../src/extension-api.ts";
import { BROWSER_TITLE_MAX, BROWSER_URL_MAX } from "../src/limits.ts";
import { newPageId, PAGE_REPORT_MS, playsAloud, type PageReport } from "../src/page-state.ts";
import {
  adShowing,
  isReportRequest,
  mediaReport,
  sameReport,
  youtubeVideoId,
  YOUTUBE_HOSTS,
  type MediaReport,
} from "../src/youtube-state.ts";

const MEDIA_EVENTS = [
  "play",
  "playing",
  "pause",
  "seeked",
  "ratechange",
  "waiting",
  "ended",
  "loadedmetadata",
  "durationchange",
  "emptied",
  "volumechange",
] as const;
/** YouTube's own events after an in-page navigation (desktop and Music, then mobile). */
const NAVIGATION_EVENTS = ["yt-navigate-finish", "state-navigateend"] as const;
/** YouTube's player element, around each of its videos. */
const PLAYER = ".html5-video-player";

export default defineContentScript({
  matches: YOUTUBE_HOSTS.map((host) => `https://${host}/*`),
  runAt: "document_idle",
  // WXT would also tell the page, by postMessage, that the script started,
  // naming the extension's id.
  noScriptStartedPostMessage: true,
  main(ctx) {
    const api = extensionApi();
    if (api !== undefined) watch(api.runtime, ctx);
  },
});

/** A video that plays aloud inside YouTube's player, or null. */
function playingVideo(): { video: HTMLVideoElement; player: Element } | null {
  for (const candidate of document.querySelectorAll("video")) {
    if (candidate.paused || candidate.muted) continue;
    const around = candidate.closest(PLAYER);
    if (around !== null) return { video: candidate, player: around };
  }
  return null;
}

/** Watches the page until `ctx` is invalidated: the extension went away or a newer copy started. */
function watch(runtime: Runtime, ctx: ContentScriptContext): void {
  /** The video reported: the last one that played aloud. */
  let video: HTMLVideoElement | null = null;
  let player: Element | null = null;
  let last: MediaReport | null = null;
  /**
   * The id the address last named for this video's source. YouTube's
   * miniplayer keeps playing a video on pages whose address names none.
   */
  let named: { videoId: string; src: string } | null = null;
  /** This page's own id, for a tab the browser's tabs API does not list. */
  const pageId = newPageId();
  let page: PageReport | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const adObserver = new MutationObserver(() => {
    if (player !== null && last !== null && adShowing(player.classList) !== last.ad) report(true);
  });

  function follow(next: HTMLVideoElement, nextPlayer: Element): void {
    video = next;
    last = null;
    named = null;
    observe(nextPlayer);
  }

  function observe(nextPlayer: Element): void {
    if (nextPlayer === player) return;
    player = nextPlayer;
    adObserver.disconnect();
    adObserver.observe(nextPlayer, { attributes: true, attributeFilter: ["class"] });
  }

  function videoId(current: HTMLVideoElement): string | null {
    const fromAddress = youtubeVideoId(location.href);
    if (fromAddress !== null) {
      named = { videoId: fromAddress, src: current.currentSrc };
      return fromAddress;
    }
    if (named !== null && named.src === current.currentSrc) return named.videoId;
    named = null;
    return null;
  }

  /** A refused message from an orphan (the extension was reloaded): this script stops. */
  function orphaned(error: unknown): void {
    const message =
      typeof error === "object" && error !== null && "message" in error ? error.message : null;
    if (typeof message === "string" && /context invalidated/i.test(message)) {
      ctx.abort("Extension context invalidated");
    }
  }

  /** Says the page plays aloud every `PAGE_REPORT_MS` while it does. */
  function keepSaying(aloud: boolean): void {
    if (aloud && beat === null) beat = setInterval(() => report(true), PAGE_REPORT_MS);
    if (!aloud && beat !== null) {
      clearInterval(beat);
      beat = null;
    }
  }

  /** Sends where the video is; a still video that says nothing new is not sent twice. */
  function report(force: boolean): void {
    if (video === null) return;
    const around = video.closest(PLAYER);
    if (around !== null) observe(around);
    const ad = player !== null && adShowing(player.classList);
    const next = mediaReport(video, videoId(video), ad, Date.now());
    const title = typeof document.title === "string" ? document.title : "";
    const nextPage: PageReport = {
      id: pageId,
      url: cut(location.href, BROWSER_URL_MAX),
      title: cut(title, BROWSER_TITLE_MAX),
      aloud: playsAloud(video),
    };
    const samePage =
      page !== null &&
      page.url === nextPage.url &&
      page.title === nextPage.title &&
      page.aloud === nextPage.aloud;
    keepSaying(nextPage.aloud);
    if (!force && last !== null && next.rate === 0 && sameReport(last, next) && samePage) return;
    last = next;
    page = nextPage;
    try {
      runtime.sendMessage({ ...next, page: nextPage })?.catch(orphaned);
    } catch {
      // The extension was reloaded or removed: this script is an orphan.
      ctx.abort("Extension context invalidated");
    }
  }

  function onMedia(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    if (target !== video) {
      // Another video (a muted preview, a hidden paused player) is followed once it plays aloud.
      if (target.paused || target.muted) return;
      const around = target.closest(PLAYER);
      if (around === null) return;
      follow(target, around);
    }
    report(false);
  }

  function onNavigation(): void {
    if (video !== null && last !== null && videoId(video) !== last.videoId) report(true);
  }

  /** The background lost its copy (it slept) or a tab started playing: report now. */
  function onMessage(message: unknown): void {
    if (!isReportRequest(message)) return;
    if (video === null || !video.isConnected || video.paused) {
      const found = playingVideo();
      if (found !== null) follow(found.video, found.player);
    }
    report(true);
  }

  /** The page goes (another site, the tab closes): it plays no more, said at once. */
  function onPageHide(): void {
    if (last === null || page === null || !page.aloud) return;
    keepSaying(false);
    try {
      runtime
        .sendMessage({ ...last, at: Date.now(), rate: 0, page: { ...page, aloud: false } })
        ?.catch(orphaned);
    } catch {
      // The extension is gone.
    }
  }

  function stop(): void {
    keepSaying(false);
    window.removeEventListener("pagehide", onPageHide);
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMedia, true);
    for (const type of NAVIGATION_EVENTS) document.removeEventListener(type, onNavigation, true);
    window.removeEventListener("popstate", onNavigation);
    adObserver.disconnect();
    try {
      runtime.onMessage.removeListener(onMessage);
    } catch {
      // The extension context is gone.
    }
  }

  // Media events do not bubble; a capturing listener on the document sees every video's.
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, onMedia, { capture: true, passive: true });
  }
  for (const type of NAVIGATION_EVENTS) {
    document.addEventListener(type, onNavigation, { capture: true, passive: true });
  }
  window.addEventListener("popstate", onNavigation, { passive: true });
  window.addEventListener("pagehide", onPageHide, { passive: true });
  runtime.onMessage.addListener(onMessage);
  ctx.onInvalidated(stop);

  // The video may already play when this script runs (document_idle).
  const found = playingVideo();
  if (found !== null) {
    follow(found.video, found.player);
    report(true);
  }
}
