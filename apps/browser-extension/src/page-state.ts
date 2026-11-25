import { BROWSER_TITLE_MAX, BROWSER_URL_MAX, PAGE_URL, TAB_ID_MAX } from "./limits.ts";

// What a page says of itself (ADR 023, amendments of 2026-11-10): its
// address and title, as its tab has them, and whether something of it is
// heard. Yab runs the extension in its Chromium engine, whose tabs API lists
// none of its WebKit tabs; the pages still run the content scripts, so they
// say it themselves. The background takes such a page for a playing tab
// while it says so (`link.page`); core sees only the usual list of tabs.

/**
 * A page's own id, drawn at random at its start from above `PAGE_ID_MIN`:
 * it stands for its tab when the browser's tabs API does not list it.
 */
export const PAGE_ID_MIN = 2 ** 30;

/** While something of it is heard, a page says so this often (the background forgets it after 75 s). */
export const PAGE_REPORT_MS = 30_000;

export interface PageReport {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly aloud: boolean;
}

/** The parts of a media element that say whether it is heard. */
export interface HeardState {
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
}

/** A media element that plays and can be heard: not paused, ended, muted or at volume 0. */
export function playsAloud(media: HeardState): boolean {
  return !media.paused && !media.ended && !media.muted && media.volume > 0;
}

/** A fresh page id. */
export function newPageId(): number {
  return PAGE_ID_MIN + Math.floor(Math.random() * (TAB_ID_MAX - PAGE_ID_MIN));
}

/**
 * The page part of a content script's message (a YouTube report, or a
 * page's own word), or null when it has none or it is not one: an http or
 * https address and a title within the protocol's limits, an id from
 * `PAGE_ID_MIN` up.
 */
export function readPageReport(value: unknown): PageReport | null {
  if (!isRecord(value) || (value.type !== "media" && value.type !== "page")) return null;
  if (!isRecord(value.page)) return null;
  const { id, url, title, aloud } = value.page;
  if (typeof id !== "number" || !Number.isInteger(id) || id < PAGE_ID_MIN || id > TAB_ID_MAX) {
    return null;
  }
  if (typeof url !== "string" || url.length > BROWSER_URL_MAX || !PAGE_URL.test(url)) return null;
  if (typeof title !== "string" || title.length > BROWSER_TITLE_MAX) return null;
  if (typeof aloud !== "boolean") return null;
  return { id, url, title, aloud };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
