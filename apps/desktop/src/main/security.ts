import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { protocol, shell, type Session, type WebContents } from "electron";
import { PRODUCTION_CSP_HEADER } from "../shared/csp";
import { MEDIA_SCHEME } from "../shared/media-url";
import { log } from "./log";
import { APP_HOST, APP_SCHEME, type UrlGuard } from "./url-guard";

// Electron hardening that lives in main (ADR 010): the renderer is served
// from a private standard scheme instead of file://, may not navigate away,
// open windows, attach webviews, request permissions, or reach the network.
// The one way out is a listed link (a model's license), which opens in the
// default browser, never in Sondine.

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Must run before `app.whenReady()`, once: Electron takes a single list.
 * `sondine-media:` gets `stream` so audio elements accept a response that
 * arrives in slices; it does not bypass the CSP, and has no fetch or CORS.
 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, codeCache: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

/** Serves episode audio at `sondine-media://episode/<id>?g=<generation>` (see media-protocol.ts). */
export function serveEpisodeMedia(handle: (request: Request) => Promise<Response>): void {
  protocol.handle(MEDIA_SCHEME, handle);
}

/** Serves out/renderer at sondine://app/, with the CSP as a response header. */
export function serveRenderer(rendererDir: string): void {
  const root = resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST || request.method !== "GET")
      return new Response(null, { status: 404 });
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) return new Response(null, { status: 403 });
    const type = contentTypes[extname(file)];
    if (type === undefined) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: {
          "Content-Type": type,
          "Content-Security-Policy": PRODUCTION_CSP_HEADER,
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

/**
 * The one permission the window has: writing text to the clipboard (« Copier »
 * on an agent's setup command). It never reads the clipboard; the transcript
 * goes there through main (exports), not this way.
 */
const allowedPermission = (permission: string) => permission === "clipboard-sanitized-write";

export function hardenSession(session: Session, isAllowedRequest: UrlGuard): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    if (allowedPermission(permission)) {
      callback(true);
      return;
    }
    log.warn("security.permission-denied", { permission });
    callback(false);
  });
  session.setPermissionCheckHandler((_contents, permission) => allowedPermission(permission));
  session.setDevicePermissionHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequest(details.url);
    if (!allowed) log.warn("security.request-blocked", { url: details.url.slice(0, 200) });
    callback({ cancel: !allowed });
  });
}

export function hardenWebContents(
  contents: WebContents,
  isAppUrl: UrlGuard,
  isExternalLink: UrlGuard,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) {
      void shell.openExternal(url).catch((error: unknown) => {
        log.warn("security.external-link-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      log.warn("security.window-open-denied", { url: url.slice(0, 200) });
    }
    return { action: "deny" };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    log.warn("security.navigation-blocked", { url: url.slice(0, 200) });
  };
  contents.on("will-navigate", (event) => guard(event, event.url));
  contents.on("will-redirect", (event) => guard(event, event.url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
