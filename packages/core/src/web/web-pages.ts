// Which page a browser tab plays, as Sondine names it (ADR 023). The browser
// extension reports an address and a title; these rules turn them into a
// site (what the user's rule applies to), a page key (what makes two plays
// the same page, so media of one page groups together), a display name and
// a cleaner title. Pure: core, the database and the window share them.

/** A page as Sondine keeps it. */
export interface WebPage {
  /** The host without `www.` or `m.`: `youtube.com`, `music.youtube.com`, `netflix.com`. */
  readonly site: string;
  /** `youtube.com/watch?v=<id>` for a video, else the host and path: `netflix.com/watch/81`. */
  readonly pageKey: string;
  /** The page is one video (YouTube): an address without one in the same tab keeps it (the mini player). */
  readonly video: boolean;
}

const YOUTUBE_SITES = new Set(["youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The site of a host: lower case, without a leading `www.` or `m.`. */
export function siteOfHost(host: string): string {
  return host.toLowerCase().replace(/^(?:www\.|m\.)/, "");
}

/**
 * The site a person typed: a host (« Netflix.com »), or any address on it
 * (« https://www.netflix.com/browse »). Null when it names no web site.
 */
export function siteOfInput(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "") return null;
  let host: string;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
  return siteOfHost(host);
}

/** The page an http(s) address shows, or null for any other address. */
export function webPageOf(url: string): WebPage | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname === "") return null;
  const site = siteOfHost(parsed.hostname);
  const videoId = youtubeVideoId(site, parsed);
  if (videoId !== null) {
    const host = site === "youtu.be" ? "youtube.com" : site;
    return { site: host, pageKey: `${host}/watch?v=${videoId}`, video: true };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { site, pageKey: `${site}${path}`, video: false };
}

function youtubeVideoId(site: string, url: URL): string | null {
  if (site === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }
  if (!YOUTUBE_SITES.has(site)) return null;
  const param = url.searchParams.get("v");
  if (url.pathname === "/watch" && param !== null && VIDEO_ID.test(param)) return param;
  const [, kind, id] = url.pathname.split("/");
  if ((kind === "shorts" || kind === "live" || kind === "embed") && id !== undefined) {
    return VIDEO_ID.test(id) ? id : null;
  }
  return null;
}

/** Names of the sites people know by name; any other site shows as its host. */
const SITE_NAMES: Readonly<Record<string, string>> = {
  "youtube.com": "YouTube",
  "music.youtube.com": "YouTube Music",
  "netflix.com": "Netflix",
  "primevideo.com": "Prime Video",
  "disneyplus.com": "Disney+",
  "canalplus.com": "Canal+",
  "tv.apple.com": "Apple TV",
  "music.apple.com": "Apple Music",
  "podcasts.apple.com": "Apple Podcasts",
  "open.spotify.com": "Spotify",
  "deezer.com": "Deezer",
  "soundcloud.com": "SoundCloud",
  "twitch.tv": "Twitch",
  "vimeo.com": "Vimeo",
  "dailymotion.com": "Dailymotion",
  "arte.tv": "ARTE",
  "france.tv": "france.tv",
  "radiofrance.fr": "Radio France",
  "x.com": "X",
  "tiktok.com": "TikTok",
  "instagram.com": "Instagram",
  "facebook.com": "Facebook",
  "linkedin.com": "LinkedIn",
  "reddit.com": "Reddit",
};

export function siteName(site: string): string {
  return SITE_NAMES[site] ?? site;
}

/**
 * The tab's title without what the site adds: a count of notifications
 * (« (3) »), the site's name after a dash or a bar. Empty when nothing else
 * is left (Netflix's player is titled « Netflix »).
 */
export function cleanTitle(site: string, title: string): string {
  const name = siteName(site);
  let text = title.replace(/^\(\d+\+?\)\s+/, "").trim();
  for (const separator of [" - ", " – ", " — ", " | ", " · "]) {
    if (text.endsWith(`${separator}${name}`)) {
      text = text.slice(0, -(separator.length + name.length)).trim();
      break;
    }
  }
  return text.toLowerCase() === name.toLowerCase() || text.toLowerCase() === site ? "" : text;
}

/** The page's address from its key, when the browser's own is not kept. */
export function pageUrlOf(pageKey: string): string {
  return `https://${pageKey.startsWith("youtube.com/") ? "www." : ""}${pageKey}`;
}

/**
 * The address that opens the page at `positionMs` when the site takes a
 * time (a YouTube video), else the page's address.
 */
export function pageLinkAt(page: WebPage, url: string, positionMs: number | null): string {
  if (!page.video || positionMs === null) return url;
  const host = page.site === "music.youtube.com" ? "music.youtube.com" : "www.youtube.com";
  const id = page.pageKey.slice(page.pageKey.indexOf("?v=") + 3);
  const seconds = Math.max(0, Math.floor(positionMs / 1000));
  return `https://${host}/watch?v=${id}&t=${seconds}s`;
}

/** A video's position at one instant, from the extension. */
export interface MediaMark {
  readonly wallMs: number;
  readonly positionMs: number;
  /** 0 while paused or waiting. */
  readonly rate: number;
  readonly durationMs: number | null;
  readonly ad: boolean;
}

/**
 * Where the video was at `wallMs`: from the latest mark at or before it,
 * moving at its rate, within the video's length. Null before the first mark,
 * during an ad, or when the latest mark is older than `maxAgeMs` (the page
 * may have changed without a mark).
 */
export function positionAt(
  marks: readonly MediaMark[],
  wallMs: number,
  maxAgeMs = 6 * 3_600_000,
): number | null {
  let latest: MediaMark | null = null;
  for (const mark of marks) {
    if (mark.wallMs <= wallMs && (latest === null || mark.wallMs >= latest.wallMs)) latest = mark;
  }
  if (latest === null || latest.ad || wallMs - latest.wallMs > maxAgeMs) return null;
  const position = latest.positionMs + (wallMs - latest.wallMs) * latest.rate;
  const capped = latest.durationMs === null ? position : Math.min(position, latest.durationMs);
  return Math.max(0, Math.round(capped));
}
