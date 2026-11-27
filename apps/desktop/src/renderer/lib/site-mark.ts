import type { EpisodeWebPage } from "@sondine/api";
import type { Brand } from "@sondine/ui/icon";

/**
 * The sites whose mark the window shows in place of the browser's icon,
 * embedded in the app (Téo, 2026-11-27), by their exact site: the host
 * without `www.` or `m.`. YouTube Music (`music.youtube.com`), a private zone
 * by default, and every other site keep the browser.
 */
const MARKS: Readonly<Record<string, Brand>> = {
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "vimeo.com": "vimeo",
  "twitch.tv": "twitch",
};

export function siteMark(page: EpisodeWebPage | null): Brand | null {
  return page === null ? null : (MARKS[page.site] ?? null);
}
