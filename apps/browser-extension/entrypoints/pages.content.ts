// The page script (a classic script once built), on every site but
// YouTube's (whose own script says this and more), in each page's top frame
// and isolated world. When a video or a sound of the page starts or stops
// being heard, and every 30 s while one is, it says the page's address and
// title: Yab runs the extension in its Chromium engine, whose tabs API lists
// none of its WebKit tabs (ADR 023). It reads the media elements' play state
// and volume, the address and the document's title (the tab's); never the
// page's text. A silent page only has its listeners: nothing runs, nothing
// is sent.

import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { defineContentScript } from "wxt/utils/define-content-script";
import { cut } from "../src/cut.ts";
import { extensionApi, type Runtime } from "../src/extension-api.ts";
import { BROWSER_TITLE_MAX, BROWSER_URL_MAX } from "../src/limits.ts";
import { newPageId, PAGE_REPORT_MS, playsAloud, type PageReport } from "../src/page-state.ts";
import { YOUTUBE_HOSTS } from "../src/youtube-state.ts";

/** A media element's events that may change whether the page is heard. */
const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "volumechange"] as const;

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  excludeMatches: YOUTUBE_HOSTS.map((host) => `https://${host}/*`),
  runAt: "document_idle",
  // WXT would also tell the page, by postMessage, that the script started.
  noScriptStartedPostMessage: true,
  main(ctx) {
    const api = extensionApi();
    if (api !== undefined) watch(api.runtime, ctx);
  },
});

/** Whether some audio or video element of the page plays and can be heard. */
function heard(): boolean {
  for (const media of document.querySelectorAll("video, audio")) {
    if (media instanceof HTMLMediaElement && playsAloud(media)) return true;
  }
  return false;
}

function watch(runtime: Runtime, ctx: ContentScriptContext): void {
  const id = newPageId();
  /** What the page said last; null before it first had something heard. */
  let said: PageReport | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  /** A refused message from an orphan (the extension was reloaded): this script stops. */
  function orphaned(error: unknown): void {
    const message =
      typeof error === "object" && error !== null && "message" in error ? error.message : null;
    if (typeof message === "string" && /context invalidated/i.test(message)) {
      ctx.abort("Extension context invalidated");
    }
  }

  function send(page: PageReport): void {
    try {
      runtime.sendMessage({ type: "page", page })?.catch(orphaned);
    } catch {
      // The extension was reloaded or removed: this script is an orphan.
      ctx.abort("Extension context invalidated");
    }
  }

  /** Says the page is heard every `PAGE_REPORT_MS` while it is. */
  function keepSaying(aloud: boolean): void {
    if (aloud && beat === null) beat = setInterval(() => say(true), PAGE_REPORT_MS);
    if (!aloud && beat !== null) {
      clearInterval(beat);
      beat = null;
    }
  }

  /**
   * Says where the page is while it is heard (when that changed, or
   * `force`), and once that it stopped, with the address it last said. A
   * silent page reads and says nothing more.
   */
  function say(force: boolean): void {
    if (!heard()) {
      keepSaying(false);
      if (said === null || !said.aloud) return;
      said = { ...said, aloud: false };
      send(said);
      return;
    }
    const title = typeof document.title === "string" ? document.title : "";
    const next: PageReport = {
      id,
      url: cut(location.href, BROWSER_URL_MAX),
      title: cut(title, BROWSER_TITLE_MAX),
      aloud: true,
    };
    keepSaying(true);
    const same = said !== null && said.aloud && said.url === next.url && said.title === next.title;
    if (same && !force) return;
    said = next;
    send(next);
  }

  function onMedia(event: Event): void {
    if (event.target instanceof HTMLMediaElement) say(false);
  }

  /** The page goes (another address, the tab closes): it is heard no more, said at once. */
  function onPageHide(): void {
    if (said === null || !said.aloud) return;
    keepSaying(false);
    said = { ...said, aloud: false };
    send(said);
  }

  function stop(): void {
    keepSaying(false);
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMedia, true);
    window.removeEventListener("pagehide", onPageHide);
  }

  // Media events do not bubble; a capturing listener on the document hears every element's.
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, onMedia, { capture: true, passive: true });
  }
  window.addEventListener("pagehide", onPageHide, { passive: true });
  ctx.onInvalidated(stop);

  // Something may already play when this script runs (document_idle).
  say(false);
}
