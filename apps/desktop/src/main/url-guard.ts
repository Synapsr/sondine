import { GRAPHICAL_ORIGIN } from "../shared/graphical";
import { CONTEXT_MEDIA_ORIGIN, MEDIA_ORIGIN } from "../shared/media-url";

// Which URLs Sondine's window may show and which requests its session may
// make (ADR 010). No Electron import, so the rules are unit-tested.

export const APP_SCHEME = "sondine";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export type UrlGuard = (url: string) => boolean;

/**
 * `scheme://host[:port]`. WHATWG `URL.origin` is "null" for schemes Node does
 * not know, such as `sondine:`, so it cannot be compared directly.
 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host === "" ? null : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function originGuard(origins: ReadonlySet<string>): UrlGuard {
  return (url) => {
    const origin = originOf(url);
    return origin !== null && origins.has(origin);
  };
}

/** Pages the window may show: the app's own origin, and the Vite dev server in development. */
export function appUrlGuard(devServerUrl: string | undefined): UrlGuard {
  const origins = new Set([APP_ORIGIN]);
  const dev = devServerUrl === undefined ? null : originOf(devServerUrl);
  if (dev !== null) origins.add(dev);
  return originGuard(origins);
}

/**
 * Requests the session may make: app pages, episode audio and the images
 * added to conversations (`sondine-media:`, never a page, ADR 024), plus the
 * dev server, its hot-reload socket and Graphical's account service, which
 * the development-only theme editor reaches (ADR 033).
 */
export function requestGuard(devServerUrl: string | undefined): UrlGuard {
  const origins = new Set([APP_ORIGIN, MEDIA_ORIGIN, CONTEXT_MEDIA_ORIGIN]);
  const development = devServerUrl !== undefined;
  if (development) {
    const dev = new URL(devServerUrl);
    origins.add(`${dev.protocol}//${dev.host}`);
    origins.add(`${dev.protocol === "https:" ? "wss:" : "ws:"}//${dev.host}`);
    // Dropped from production builds, so the packaged app never names it.
    if (import.meta.env.DEV) origins.add(GRAPHICAL_ORIGIN);
  }
  const allowed = originGuard(origins);
  return (url) =>
    allowed(url) || url.startsWith("data:") || (development && url.startsWith("devtools://"));
}

/**
 * Links the window may hand to the default browser: exactly the pages listed
 * (each model's license at its pinned revision), `https:` only, no prefix
 * match. Everything else stays denied.
 */
export function externalLinkGuard(urls: Iterable<string>): UrlGuard {
  const allowed = new Set([...urls].filter((url) => url.startsWith("https://")));
  return (url) => allowed.has(url);
}

/** Pages that may play episodes (`request.initiatorOrigin` of a media request): the app's own. */
export function mediaInitiatorGuard(
  devServerUrl: string | undefined,
): (origin: string | undefined) => boolean {
  const dev = devServerUrl === undefined ? null : originOf(devServerUrl);
  return (origin) => origin === APP_ORIGIN || (dev !== null && origin === dev);
}
