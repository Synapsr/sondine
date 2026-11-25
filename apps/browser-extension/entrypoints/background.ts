// The extension's service worker (a background script in Firefox), a
// classic script: watches which tabs play sound and links to Sondine through
// native messaging. WXT runs `main` as the script starts, so the listeners
// are added in its first turn and the browser can wake a sleeping worker
// with them. While the link is up the worker reads the tabs every 20 s,
// which also keeps it loaded (Chrome counts each call, Yab keeps a worker
// that calls the tabs API); the minute alarm starts a worker the browser
// let go. With no link and nothing playing, it may sleep.

import type { BrowserReadCause } from "@sondine/protocol";
import { defineBackground } from "wxt/utils/define-background";
import { audibleTabs, tabChangeMatters } from "../src/audible-tabs.ts";
import {
  extensionApi,
  quietly,
  type Alarms,
  type Port,
  type Runtime,
  type Tabs,
} from "../src/extension-api.ts";
import { BROWSER_HOST_NAME } from "../src/limits.ts";
import { createLink, REFRESH_MS, type Link, type NativePort } from "../src/link.ts";
import {
  isYoutubePage,
  readMediaReport,
  REPORT_REQUEST,
  youtubeVideoId,
} from "../src/youtube-state.ts";
import { readPageReport } from "../src/page-state.ts";

/** The one alarm: each minute while the link is open or some tab plays, it reads the tabs and retries the link. */
const ALARM = "sondine-link";

export default defineBackground(() => {
  const api = extensionApi();
  if (api?.tabs !== undefined && api.alarms !== undefined) start(api.runtime, api.tabs, api.alarms);
});

function start(runtime: Runtime, tabs: Tabs, alarms: Alarms): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const link: Link = createLink({
    version: runtime.getManifest().version,
    now: () => Date.now(),
    open: () => openPort(runtime, link),
    requestMedia: (tab) => quietly(() => tabs.sendMessage(tab, REPORT_REQUEST)),
    setAlarm: (on) =>
      quietly(() => (on ? alarms.create(ALARM, { periodInMinutes: 1 }) : alarms.clear(ALARM))),
    setRefresh: (on) => {
      if (timer !== null) clearInterval(timer);
      timer = on ? setInterval(() => void refresh("refresh"), REFRESH_MS) : null;
    },
  });

  // One query at a time; a read asked during one runs after it, with the latest cause.
  let querying = false;
  let again: BrowserReadCause | null = null;
  async function refresh(cause: BrowserReadCause): Promise<void> {
    if (querying) {
      again = again === "refresh" ? "refresh" : cause;
      return;
    }
    querying = true;
    try {
      let next: BrowserReadCause | null = cause;
      while (next !== null) {
        again = null;
        const found = await tabs.query({});
        link.setTabs(
          audibleTabs(found),
          {
            cause: next,
            tabs: found.length,
            audible: found.filter((tab) => tab.audible === true).length,
          },
          found.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        );
        next = again;
      }
    } catch {
      // The query failed; the next change, read or alarm asks again.
    } finally {
      querying = false;
    }
  }

  tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url !== undefined && !isYoutubePage(change.url)) link.forget(tabId);
    if (tabChangeMatters(change, tab, link.lists(tabId))) void refresh("event");
  });
  tabs.onRemoved.addListener((tabId) => link.removed(tabId));
  tabs.onReplaced.addListener((_added, removed) => {
    link.removed(removed);
    void refresh("event");
  });
  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    void refresh("refresh");
    link.retry();
  });
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    // The content scripts run in top frames only, never in private windows.
    if (sender.tab?.incognito === true) return;
    // An answer tells the page the worker heard it: Yab's pages otherwise
    // ping a worker that stays silent, and start it over when it seems gone.
    const answer = () => {
      try {
        sendResponse?.(true);
      } catch {
        // The page went away meanwhile.
      }
    };
    // A page that says where it is plays as a tab of its own when the read does not list it.
    const page = readPageReport(message);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "page"
    ) {
      if (page === null) return;
      link.page(sender.tab?.id, youtubeVideoId(page.url), page);
      answer();
      return;
    }
    const videoId =
      typeof message === "object" && message !== null && "videoId" in message
        ? message.videoId
        : null;
    const video = typeof videoId === "string" ? videoId : null;
    const tab =
      page === null
        ? link.tabOfReport(sender.tab?.id, video)
        : link.page(sender.tab?.id, video, page);
    if (tab === null) return;
    const report = readMediaReport(message, tab);
    if (report === null) return;
    link.report(report);
    answer();
  });

  link.connect();
  void refresh("start");
}

function openPort(runtime: Runtime, link: Link): NativePort | null {
  let port: Port;
  try {
    if (runtime.connectNative === undefined) return null;
    port = runtime.connectNative(BROWSER_HOST_NAME);
  } catch {
    return null;
  }
  port.onMessage.addListener((message) => link.received(port, message));
  port.onDisconnect.addListener(() => {
    // Reading the error marks it handled; "host not found" just means Sondine is not installed.
    void runtime.lastError;
    link.closed(port);
  });
  return port;
}
