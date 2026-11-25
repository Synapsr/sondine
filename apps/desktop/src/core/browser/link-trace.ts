import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log";

// The browser link's own trace (ADR 023): one JSON line per thing that
// happens on it, in the data directory's `diagnostics/`, kept when the
// installed app sends core's output nowhere. What links open and close,
// what each extension says it read (tab ids and counts), and why each play
// opens or ends, and every few minutes what each link said meanwhile (so a
// link that says the same thing all along still shows it lives). Never a
// site, an address or a title. Two files of `TRACE_ROTATE_BYTES` at most.

/** The trace rotates past this size, keeping the one before. */
export const TRACE_ROTATE_BYTES = 256 * 1024;

/** Why a play ended. */
export type PlayEndReason =
  /** No link's list has its tab any more (it stopped or closed), or its tab shows another page. */
  | "list"
  /** The last link listing it closed. */
  | "link-closed"
  /** The last link listing it said nothing for too long. */
  | "link-expired"
  /** The user turned the link off. */
  | "switch-off"
  /** A previous core left it open. */
  | "start";

/** Why a link ended. */
export type LinkEndReason =
  /** The relay closed it: the browser closed the port, or quit. */
  | "closed"
  /** Answered, it never said its hello (Yab leaves some ports with nobody behind). */
  | "mute"
  /** It announced a refresh and went silent past it. */
  | "expired"
  /** Every place was taken: the link silent the longest gave its own. */
  | "evicted"
  /** The user turned the link off, or core stopped. */
  | "switch-off";

export type TraceEvent =
  | { readonly event: "listening" }
  | { readonly event: "stopped" }
  | { readonly event: "refused"; readonly reason: string }
  | {
      readonly event: "link";
      readonly link: number;
      readonly browser: string;
      readonly links: number;
    }
  | {
      readonly event: "hello";
      readonly link: number;
      readonly extension: string;
      readonly refreshMs: number | null;
    }
  | {
      readonly event: "tabs";
      readonly link: number;
      readonly tabs: readonly number[];
      readonly read: {
        readonly cause: string;
        readonly tabs: number;
        readonly audible: number;
      } | null;
    }
  | {
      readonly event: "media";
      readonly link: number;
      readonly tab: number;
      readonly marked: boolean;
    }
  | {
      readonly event: "play";
      readonly play: number;
      readonly tab: number;
      readonly change: "opened";
      readonly link: number;
    }
  | {
      readonly event: "play";
      readonly play: number;
      readonly tab: number;
      readonly change: "ended";
      readonly reason: PlayEndReason;
    }
  | {
      readonly event: "unlink";
      readonly link: number;
      readonly reason: LinkEndReason;
      readonly afterMs: number;
      readonly messages: number;
      readonly media: number;
    }
  | {
      /** A link's words since its last summary, every `ALIVE_EVERY_MS`. */
      readonly event: "alive";
      readonly link: number;
      readonly tabsMessages: number;
      readonly media: number;
      /** The latest read it reported, if any. */
      readonly read: {
        readonly cause: string;
        readonly tabs: number;
        readonly audible: number;
      } | null;
      /** The tabs its latest list had. */
      readonly listed: number;
    }
  | { readonly event: "plays-ended-at-start"; readonly plays: number }
  | { readonly event: "invalid"; readonly link: number; readonly issue: string };

export interface LinkTrace {
  readonly record: (event: TraceEvent) => void;
}

/** A trace that writes nowhere (tests, and a core without a data directory). */
export const silentTrace: LinkTrace = { record: () => undefined };

export function fileTrace(path: string, now: () => number = Date.now): LinkTrace {
  let failed = false;
  return {
    record(event) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try {
          if (statSync(path).size > TRACE_ROTATE_BYTES) renameSync(path, `${path}.1`);
        } catch {
          // No file yet.
        }
        appendFileSync(path, `${JSON.stringify({ at: now(), ...event })}\n`, { mode: 0o600 });
        failed = false;
      } catch (error) {
        // Said once per failing spell: the link goes on without its trace.
        if (!failed) {
          log.warn("browser.trace-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        failed = true;
      }
    },
  };
}
