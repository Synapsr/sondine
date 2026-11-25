import * as z from "zod";
import { BundleId, VersionText } from "./primitives";
import { described, named } from "./registry";

// The browser link (ADR 023): Sondine's browser extension reports which tab
// plays sound, through the browser's native messaging, to the relay
// `sondine-browser`, which copies it to core's socket `run/browser.sock`.
//
//   relay → core   BrowserHello, one line
//   core → relay   BrowserAnswer, one line; the relay hands it to the extension
//   extension → core   BrowserMessage, one per line (native messages, framed
//                      by the browser, turned into lines by the relay)
//
// The browser says what plays; nothing here is guessed. Only audible tabs
// outside private windows are reported, and only their address and title;
// on YouTube, the video's position too. Nothing goes back to the extension
// but the answer.

/** Unix time in milliseconds, as `Date.now()` gives it in the browser. */
export const UnixMs = named(
  "UnixMs",
  "Unix time in milliseconds (Date.now()).",
  z.int().min(0).max(Number.MAX_SAFE_INTEGER),
);

/** The browser's id of a tab, unique while the browser runs. */
export const TabId = named(
  "TabId",
  "The browser's tab id.",
  z
    .int()
    .min(0)
    .max(2 ** 31 - 1),
);

/** Longest address and title the extension sends; it cuts longer ones. */
export const BROWSER_URL_MAX = 2048;
export const BROWSER_TITLE_MAX = 300;
/** Most audible tabs one `tabs` message lists. */
export const BROWSER_TABS_MAX = 32;
/** Longest line on the browser socket, newline excluded (a native message from the extension). */
export const BROWSER_LINE_MAX = 64 * 1024;
/** The native messaging host's name, in its manifest and in `connectNative`. */
export const BROWSER_HOST_NAME = "app.sondine.browser";

const PageUrl = named(
  "PageUrl",
  "An http or https address, at most 2048 characters.",
  z
    .string()
    .max(BROWSER_URL_MAX)
    .regex(/^https?:\/\/[^\s]+$/),
);

/** The relay's first line: which extension started it, and from which browser. */
export const BrowserHello = named(
  "BrowserHello",
  "First line the relay sends to core.",
  z.strictObject({
    v: z.literal(1),
    /** What the browser passed the relay: `chrome-extension://<id>/`. */
    origin: z.string().regex(/^chrome-extension:\/\/[A-Za-z0-9-]{1,64}\/$/),
    /** The app that started the relay (its nearest ancestor inside an app bundle); null when none. */
    browser: described(
      "The browser that started the relay; null when the relay found no app bundle above it.",
      z
        .strictObject({
          bundleId: BundleId,
          name: z.string().min(1).max(120),
          /** The `.app` bundle's path. */
          path: z.string().min(1).max(1024),
        })
        .nullable(),
    ),
  }),
);
export type BrowserHello = z.output<typeof BrowserHello>;

export const BrowserRefusal = z.enum([
  /** The user turned the browser link off in Settings. */
  "disabled",
  /** Too many browsers are connected. */
  "busy",
  /** The relay's first line was not a hello. */
  "bad-hello",
  /** Written by the relay itself: Sondine is not running, or its socket is closed. */
  "not-running",
]);
export type BrowserRefusal = z.output<typeof BrowserRefusal>;

/** Core's one answer line, which the relay also hands to the extension. */
export const BrowserAnswer = named(
  "BrowserAnswer",
  "Core's answer to the hello.",
  z.union([
    z.strictObject({ ok: z.literal(true) }),
    z.strictObject({ ok: z.literal(false), reason: BrowserRefusal }),
  ]),
);
export type BrowserAnswer = z.output<typeof BrowserAnswer>;

/** One audible tab. */
export const AudibleTab = named(
  "AudibleTab",
  "A tab that plays sound, outside private windows.",
  z.strictObject({
    tab: TabId,
    url: PageUrl,
    title: z.string().max(BROWSER_TITLE_MAX),
  }),
);
export type AudibleTab = z.output<typeof AudibleTab>;

/** Longest period between two `tabs` messages an extension may promise. */
export const BROWSER_REFRESH_MAX_MS = 10 * 60_000;

const HelloMessage = z.strictObject({
  type: z.literal("hello"),
  /** The extension's version (its manifest's). */
  extension: VersionText,
  /**
   * The extension reads its tabs again and sends them at least this often
   * while it runs, unchanged or not: a link silent much longer is gone.
   * Absent from extensions before 0.2.0, which send only changes.
   */
  refreshMs: z.int().min(1_000).max(BROWSER_REFRESH_MAX_MS).optional(),
});

/** Why the extension read its tabs. */
export const BrowserReadCause = z.enum([
  /** Its worker started. */
  "start",
  /** A tab changed (an event). */
  "event",
  /** Its periodic read, which also says it still runs. */
  "refresh",
]);
export type BrowserReadCause = z.output<typeof BrowserReadCause>;

/** What one read of the tabs found, as counts: never a page. */
const TabsRead = z.strictObject({
  cause: BrowserReadCause,
  /** Tabs the browser returned, private windows excluded. */
  tabs: z.int().min(0).max(100_000),
  /** Of them, the ones it said make sound (before the filters: muted, not a web page). */
  audible: z.int().min(0).max(100_000),
  /**
   * YouTube pages that spoke of themselves lately (from 0.3.0): Yab's
   * Chromium engine lists none of its WebKit tabs, whose pages can say they
   * play.
   */
  pages: z.int().min(0).max(100_000).optional(),
});

/**
 * Every tab that plays sound now: sent after the hello, at each change (a
 * tab starts or stops, or one that plays changes address or title), and at
 * each periodic read when the hello announced one. A tab no longer listed
 * stopped at `at`.
 */
const TabsMessage = z.strictObject({
  type: z.literal("tabs"),
  at: UnixMs,
  tabs: z.array(AudibleTab).max(BROWSER_TABS_MAX),
  /** The read behind this list (extensions from 0.2.0). */
  read: TabsRead.optional(),
});

/**
 * Where a YouTube video is, from its page: sent when it plays, pauses,
 * seeks, waits, changes speed or ends. Between two, the position moves at
 * `rate` from `positionMs` (0 while paused or waiting).
 */
const MediaMessage = z.strictObject({
  type: z.literal("media"),
  at: UnixMs,
  tab: TabId,
  /** The video's id (`v=`), null when the page names none. */
  videoId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
  positionMs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Null for a live stream or before the video's length is known. */
  durationMs: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  /** Playback speed while playing, 0 while paused or waiting. */
  rate: z.number().min(0).max(16),
  /** An ad plays in the video's place: its position is the ad's. */
  ad: z.boolean(),
});

export const BrowserMessage = named(
  "BrowserMessage",
  "One message from the extension to core.",
  z.discriminatedUnion("type", [HelloMessage, TabsMessage, MediaMessage]),
);
export type BrowserMessage = z.output<typeof BrowserMessage>;
export type BrowserMessageType = BrowserMessage["type"];

export const BROWSER_MESSAGE_TYPES: readonly BrowserMessageType[] = BrowserMessage.options.map(
  (option) => option.shape.type.value,
);
