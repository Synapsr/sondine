// Content Security Policy for the renderer (ADR 010). Production serves the
// bundle from `sondine://app`: only same-origin scripts, styles and fonts,
// no network at all (oRPC travels on a MessagePort, not fetch). Media plays
// only from `sondine-media:`, which main serves from core by byte ranges
// (architecture §11); images added to a conversation show from it too
// (ADR 024). No Blob URLs.

import { GRAPHICAL_ORIGIN } from "./graphical";

const common = [
  "default-src 'none'",
  "img-src 'self' data: sondine-media:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "media-src sondine-media:",
];

/** The policy in index.html's <meta> tag. */
export const PRODUCTION_CSP = [
  ...common,
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'none'",
].join("; ");

/** The same policy as a response header, plus what only a header can carry. */
export const PRODUCTION_CSP_HEADER = `${PRODUCTION_CSP}; frame-ancestors 'none'`;

/**
 * Vite's dev server injects an inline React Refresh preamble and style tags,
 * and talks to the page over a WebSocket; Graphical's theme editor, mounted
 * in development only (ADR 033), signs in to its account service and loads
 * preview fonts and images from it. The policy loosens only for those.
 */
export function developmentCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, "ws");
  const graphical = (directive: string) =>
    directive.startsWith("img-src ") || directive.startsWith("font-src ")
      ? `${directive} ${GRAPHICAL_ORIGIN}`
      : directive;
  return [
    ...common.map(graphical),
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${devOrigin} ${ws} ${GRAPHICAL_ORIGIN}`,
  ].join("; ");
}
