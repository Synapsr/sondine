// The wire contract's limits, copied from packages/protocol/src/browser-messages.ts
// so the extension carries none of zod. test/limits.test.ts keeps them equal.

/** The native messaging host's name, in its manifest and in `connectNative`. */
export const BROWSER_HOST_NAME = "app.sondine.browser";
/** Longest address and title the extension sends; it cuts longer ones. */
export const BROWSER_URL_MAX = 2048;
export const BROWSER_TITLE_MAX = 300;
/** Most audible tabs one `tabs` message lists. */
export const BROWSER_TABS_MAX = 32;
/** Longest line on the browser socket, newline excluded. */
export const BROWSER_LINE_MAX = 64 * 1024;

/** Largest tab id the protocol accepts. */
export const TAB_ID_MAX = 2 ** 31 - 1;
/** Fastest playback rate the protocol accepts. */
export const RATE_MAX = 16;
/** A YouTube video id, as the protocol accepts it. */
export const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** An address the protocol accepts (before the length cut). */
export const PAGE_URL = /^https?:\/\/[^\s]+$/;
