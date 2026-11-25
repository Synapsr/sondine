import type { BrowserMessage } from "@sondine/protocol";
import { RATE_MAX, TAB_ID_MAX, VIDEO_ID } from "./limits.ts";

export type MediaMessage = Extract<BrowserMessage, { type: "media" }>;
/** What a YouTube page reports; the background adds the tab. */
export type MediaReport = Omit<MediaMessage, "tab">;

/** The YouTube sites the content script runs on (https only). */
export const YOUTUBE_HOSTS = ["www.youtube.com", "m.youtube.com", "music.youtube.com"] as const;
const youtubeHosts: ReadonlySet<string> = new Set(YOUTUBE_HOSTS);

/** What the background sends a YouTube page to ask for a fresh report. */
export const REPORT_REQUEST = { type: "sondine-report" } as const;

/** HTMLMediaElement.HAVE_FUTURE_DATA: below it, a playing video waits for data. */
const HAVE_FUTURE_DATA = 3;

/** The parts of a `<video>` element a report reads. */
export interface VideoState {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
}

export function isYoutubePage(url: string): boolean {
  const parsed = parse(url);
  return parsed !== null && parsed.protocol === "https:" && youtubeHosts.has(parsed.hostname);
}

/** The video a YouTube address names: its `v` parameter, or `/shorts/<id>` and `/live/<id>`. */
export function youtubeVideoId(url: string): string | null {
  const parsed = parse(url);
  if (parsed === null || !youtubeHosts.has(parsed.hostname)) return null;
  const id =
    parsed.searchParams.get("v") ?? /^\/(?:shorts|live)\/([^/]+)/.exec(parsed.pathname)?.[1];
  return id !== undefined && VIDEO_ID.test(id) ? id : null;
}

/** Whether YouTube's player element shows an ad in the video's place. */
export function adShowing(playerClasses: { contains(token: string): boolean }): boolean {
  return playerClasses.contains("ad-showing") || playerClasses.contains("ad-interrupting");
}

/** A report of where the video is, at `at`. */
export function mediaReport(
  video: VideoState,
  videoId: string | null,
  ad: boolean,
  at: number,
): MediaReport {
  const moving = !video.paused && !video.ended && video.readyState >= HAVE_FUTURE_DATA;
  return {
    type: "media",
    at,
    videoId,
    positionMs: milliseconds(video.currentTime) ?? 0,
    durationMs: milliseconds(video.duration),
    rate: moving ? clamp(video.playbackRate, 0, RATE_MAX) : 0,
    ad,
  };
}

/** Two reports that say the same thing, whenever they were made. */
export function sameReport(a: MediaReport, b: MediaReport): boolean {
  return (
    a.videoId === b.videoId &&
    a.positionMs === b.positionMs &&
    a.durationMs === b.durationMs &&
    a.rate === b.rate &&
    a.ad === b.ad
  );
}

/**
 * Reads a report sent by the content script and adds its tab; null when it
 * is not one (the background trusts nothing that crosses a process).
 */
export function readMediaReport(value: unknown, tab: number): MediaMessage | null {
  if (!isRecord(value) || value.type !== "media") return null;
  const { at, videoId, positionMs, durationMs, rate, ad } = value;
  if (!Number.isInteger(tab) || tab < 0 || tab > TAB_ID_MAX) return null;
  if (!isCount(at) || !isCount(positionMs)) return null;
  if (durationMs !== null && !isCount(durationMs)) return null;
  if (videoId !== null && (typeof videoId !== "string" || !VIDEO_ID.test(videoId))) return null;
  if (typeof rate !== "number" || !(rate >= 0 && rate <= RATE_MAX)) return null;
  if (typeof ad !== "boolean") return null;
  return { type: "media", at, tab, videoId, positionMs, durationMs, rate, ad };
}

export function isReportRequest(value: unknown): boolean {
  return isRecord(value) && value.type === REPORT_REQUEST.type;
}

function milliseconds(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
