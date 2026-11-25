import type { Server, Socket } from "node:net";
import { endOpenWebPlays, type Database } from "@sondine/db";
import {
  BROWSER_LINE_MAX,
  BrowserHello,
  BrowserMessage,
  type BrowserAnswer,
  type BrowserRefusal,
} from "@sondine/protocol";
import { log } from "../log";

type TabsRead = NonNullable<Extract<BrowserMessage, { type: "tabs" }>["read"]>;
import { closePrivate, listenPrivate } from "../private-socket";
import { silentTrace, type LinkEndReason, type LinkTrace, type PlayEndReason } from "./link-trace";
import { openBrowserPlays, type BrowserPlays } from "./play-recorder";

// Core's side of the browser link (ADR 023). While the user's switch is on,
// core listens on `run/browser.sock` (0600 in the 0700 run directory). The
// relay a browser starts for Sondine's extension says hello (the
// extension's origin and the browser that started it); core answers one
// line, which the relay hands to the extension, then reads the extension's
// messages, one per line, into plays. Nothing goes back.
//
// Links of one browser share its plays (play-recorder). A link is closed
// when nobody is behind it: answered, it never says its hello (Yab answers
// some workers' ports into the void); or it promised a refresh and fell
// silent (Yab keeps a port open after its worker went). Closing it ends the
// relay.

/** Links open at once (a browser opens one per extension worker, Yab sometimes two). */
export const MAX_BROWSER_SESSIONS = 8;
const MAX_PENDING_HELLOS = 8;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_HELLO_BYTES = 2_048;
/** Invalid messages traced and logged per link; the rest only count. */
const LOGGED_INVALID = 3;
/** An answered link that says nothing this long has nobody behind it. */
export const MUTE_LINK_MS = 15_000;
/** A link that promised a refresh is gone after twice its period and this much silence. */
export const EXPIRY_SLACK_MS = 30_000;
/** How often links are checked for silence, while any is open. */
const SWEEP_MS = 15_000;
/** At capacity, a link silent this long gives its place to a new one. */
const EVICT_AFTER_MS = 60_000;
/** Each open link's words are summed up in the trace this often. */
export const ALIVE_EVERY_MS = 5 * 60_000;

export interface BrowserLinkInfo {
  readonly bundleId: string;
  readonly name: string;
  /** Links open now. */
  readonly links: number;
  /** When one of its links last said something, since core started; null before. */
  readonly lastHeardAtMs: number | null;
  /** The extension's version its latest link said; null before any hello. */
  readonly extension: string | null;
}

export interface BrowserHostOptions {
  readonly socketPath: string;
  readonly db: Database;
  readonly now?: () => number;
  readonly trace?: LinkTrace;
  /** How long an answered link may stay silent before its first word (tests shorten it). */
  readonly muteMs?: number;
  /** A browser connected or left. */
  readonly onChange?: () => void;
}

export interface BrowserHostHandle {
  /** Listens while `enabled`; turning it off closes every browser's link (their plays end). */
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly listening: () => boolean;
  /** Each browser heard since core started, connected now or not (unnamed ones aside). */
  readonly browsers: () => readonly BrowserLinkInfo[];
  /** Closes the links that fell silent; runs on a timer too. */
  readonly sweep: () => void;
}

interface Session {
  readonly id: number;
  readonly socket: Socket;
  readonly bundleId: string;
  readonly openedAtMs: number;
  readonly plays: BrowserPlays | null;
  heardAtMs: number | null;
  extension: string | null;
  refreshMs: number | null;
  messages: number;
  media: number;
  invalid: number;
  /** The last tabs message traced: its tab ids and its read's counts. */
  traced: string | null;
  /** Since the last `alive` summary: tabs and media messages, the latest read, and when. */
  summary: {
    atMs: number;
    tabs: number;
    media: number;
    read: TabsRead | null;
    listed: number;
  };
  /** Whether the last media message traced marked a play. */
  marked: boolean | null;
  /** Why core ends it, once it does. */
  ending: LinkEndReason | null;
  mute: ReturnType<typeof setTimeout> | null;
}

const PLAY_END: Record<LinkEndReason, PlayEndReason> = {
  closed: "link-closed",
  mute: "link-closed",
  expired: "link-expired",
  evicted: "link-expired",
  "switch-off": "switch-off",
};

function answer(socket: Socket, reply: BrowserAnswer): void {
  socket.write(`${JSON.stringify(reply)}\n`);
}

export function makeBrowserHost(options: BrowserHostOptions): BrowserHostHandle {
  const { db, socketPath } = options;
  const now = options.now ?? Date.now;
  const trace = options.trace ?? silentTrace;
  let server: Server | null = null;
  let enabled = false;
  let pendingHellos = 0;
  let nextLink = 1;
  let sweeper: ReturnType<typeof setInterval> | null = null;
  const sockets = new Set<Socket>();
  const sessions = new Map<Socket, Session>();
  /** Plays by browser, shared by its links. */
  const plays = new Map<string, BrowserPlays>();
  /** What each browser said last, kept after its links close. */
  const heard = new Map<
    string,
    { name: string; lastHeardAtMs: number | null; extension: string | null }
  >();
  let chain: Promise<void> = Promise.resolve();
  const serially = (step: () => Promise<void>) => {
    chain = chain.then(step, step);
    return chain;
  };
  const changed = () => options.onChange?.();

  const refuse = (socket: Socket, reason: BrowserRefusal) => {
    log.info("browser.refused", { reason });
    trace.record({ event: "refused", reason });
    socket.end(`${JSON.stringify({ ok: false, reason } satisfies BrowserAnswer)}\n`);
    setTimeout(() => socket.destroy(), 1_000).unref();
  };

  /** Core ends a link; its plays end once its socket has closed. */
  const end = (session: Session, reason: LinkEndReason) => {
    if (session.ending !== null) return;
    session.ending = reason;
    session.socket.destroy();
  };

  const playsOf = (bundleId: string, name: string): BrowserPlays => {
    const known = plays.get(bundleId);
    if (known !== undefined) return known;
    const created = openBrowserPlays(db, { bundleId, name }, now, trace);
    plays.set(bundleId, created);
    return created;
  };

  const receive = (session: Session, message: BrowserMessage) => {
    const nowMs = now();
    session.messages += 1;
    session.heardAtMs = nowMs;
    if (session.mute !== null) {
      clearTimeout(session.mute);
      session.mute = null;
    }
    const memory = heard.get(session.bundleId);
    if (memory !== undefined) memory.lastHeardAtMs = nowMs;
    switch (message.type) {
      case "hello": {
        session.extension = message.extension;
        session.refreshMs = message.refreshMs ?? null;
        if (memory !== undefined) memory.extension = message.extension;
        trace.record({
          event: "hello",
          link: session.id,
          extension: message.extension,
          refreshMs: session.refreshMs,
        });
        changed();
        return;
      }
      case "tabs": {
        const ids = message.tabs.map((tab) => tab.tab);
        session.summary.tabs += 1;
        session.summary.read = message.read ?? null;
        session.summary.listed = ids.length;
        const shape = `${ids.join(",")}|${message.read?.audible ?? ""}|${message.read?.tabs ?? ""}`;
        if (shape !== session.traced) {
          session.traced = shape;
          trace.record({ event: "tabs", link: session.id, tabs: ids, read: message.read ?? null });
        }
        session.plays?.tabs(session.id, message);
        return;
      }
      case "media": {
        session.media += 1;
        session.summary.media += 1;
        const marked = session.plays?.media(session.id, message) ?? false;
        if (marked !== session.marked) {
          session.marked = marked;
          trace.record({ event: "media", link: session.id, tab: message.tab, marked });
        }
        return;
      }
    }
  };

  /** After the hello: one message per line, at most `BROWSER_LINE_MAX` bytes each. */
  const follow = (session: Session, rest: Buffer) => {
    const { socket } = session;
    let buffered: Buffer = Buffer.alloc(0);
    const take = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      for (let newline = buffered.indexOf(0x0a); newline !== -1; newline = buffered.indexOf(0x0a)) {
        const line = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);
        if (line.trim() === "") continue;
        let parsed: ReturnType<typeof BrowserMessage.safeParse>;
        try {
          parsed = BrowserMessage.safeParse(JSON.parse(line));
        } catch {
          parsed = BrowserMessage.safeParse(undefined);
        }
        if (!parsed.success) {
          session.invalid += 1;
          if (session.invalid <= LOGGED_INVALID) {
            // The issue's code only: a message may quote a key the extension sent.
            const issue = parsed.error.issues[0]?.code ?? "unknown";
            log.warn("browser.invalid-message", { issue });
            trace.record({ event: "invalid", link: session.id, issue });
          }
          continue;
        }
        try {
          receive(session, parsed.data);
        } catch (error) {
          log.warn("browser.record-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (buffered.length > BROWSER_LINE_MAX) {
        log.warn("browser.line-too-long", { bytes: buffered.length });
        socket.destroy();
      }
    };
    socket.on("data", take);
    if (rest.length > 0) take(rest);
  };

  /**
   * Links that fell silent past what they promised go, and each link's words
   * are summed up every `ALIVE_EVERY_MS`; the timer runs while any is open.
   */
  const sweep = () => {
    const nowMs = now();
    for (const session of sessions.values()) {
      const { summary } = session;
      if (session.ending === null && nowMs - summary.atMs >= ALIVE_EVERY_MS) {
        trace.record({
          event: "alive",
          link: session.id,
          tabsMessages: summary.tabs,
          media: summary.media,
          read: summary.read,
          listed: summary.listed,
        });
        session.summary = { ...summary, atMs: nowMs, tabs: 0, media: 0 };
      }
      if (session.refreshMs === null || session.heardAtMs === null) continue;
      if (nowMs - session.heardAtMs > 2 * session.refreshMs + EXPIRY_SLACK_MS) {
        end(session, "expired");
      }
    }
  };
  const watch = () => {
    if (sessions.size > 0 && sweeper === null) {
      sweeper = setInterval(sweep, SWEEP_MS);
      sweeper.unref();
    } else if (sessions.size === 0 && sweeper !== null) {
      clearInterval(sweeper);
      sweeper = null;
    }
  };

  /** At capacity, the link silent the longest, if it has been silent a while. */
  const stalest = (): Session | null => {
    const nowMs = now();
    let found: Session | null = null;
    for (const session of sessions.values()) {
      if (session.ending !== null) continue;
      const quietSince = session.heardAtMs ?? session.openedAtMs;
      if (nowMs - quietSince < EVICT_AFTER_MS) continue;
      if (found === null || quietSince < (found.heardAtMs ?? found.openedAtMs)) found = session;
    }
    return found;
  };

  const greet = (socket: Socket, line: string, rest: Buffer, listener: Server) => {
    if (server !== listener || !enabled) return refuse(socket, "disabled");
    let hello: BrowserHello | null = null;
    try {
      const parsed = BrowserHello.safeParse(JSON.parse(line));
      hello = parsed.success ? parsed.data : null;
    } catch {
      hello = null;
    }
    if (hello === null) return refuse(socket, "bad-hello");
    if (sessions.size >= MAX_BROWSER_SESSIONS) {
      const evicted = stalest();
      if (evicted === null) return refuse(socket, "busy");
      end(evicted, "evicted");
    }
    answer(socket, { ok: true });
    const bundleId = hello.browser?.bundleId ?? "";
    const name = hello.browser?.name ?? "";
    // A browser Sondine cannot name has plays no region can be matched to: they are not kept.
    const session: Session = {
      id: nextLink++,
      socket,
      bundleId,
      openedAtMs: now(),
      plays: hello.browser === null ? null : playsOf(bundleId, name),
      heardAtMs: null,
      extension: null,
      refreshMs: null,
      messages: 0,
      media: 0,
      invalid: 0,
      traced: null,
      summary: { atMs: now(), tabs: 0, media: 0, read: null, listed: 0 },
      marked: null,
      ending: null,
      mute: null,
    };
    session.mute = setTimeout(() => end(session, "mute"), options.muteMs ?? MUTE_LINK_MS);
    session.mute.unref();
    if (bundleId !== "") {
      const known = heard.get(bundleId);
      heard.set(bundleId, {
        name,
        lastHeardAtMs: known?.lastHeardAtMs ?? null,
        extension: known?.extension ?? null,
      });
    }
    sessions.set(socket, session);
    socket.once("close", () => {
      sessions.delete(socket);
      if (session.mute !== null) clearTimeout(session.mute);
      const reason = session.ending ?? "closed";
      // A link that went silent stopped knowing at its last word.
      const atMs =
        reason === "expired" || reason === "evicted"
          ? (session.heardAtMs ?? session.openedAtMs)
          : now();
      try {
        session.plays?.leave(session.id, atMs, PLAY_END[reason]);
      } catch (error) {
        // The database may already be closed as core stops; the next start ends open plays.
        log.warn("browser.record-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      trace.record({
        event: "unlink",
        link: session.id,
        reason,
        afterMs: now() - session.openedAtMs,
        messages: session.messages,
        media: session.media,
      });
      log.info("browser.disconnected", { browser: bundleId, reason, sessions: sessions.size });
      watch();
      changed();
    });
    trace.record({ event: "link", link: session.id, browser: bundleId, links: sessions.size });
    log.info("browser.connected", {
      browser: bundleId,
      origin: hello.origin,
      sessions: sessions.size,
    });
    follow(session, rest);
    watch();
    changed();
  };

  const accept = (socket: Socket, listener: Server) => {
    if (pendingHellos >= MAX_PENDING_HELLOS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    pendingHellos += 1;
    let received = Buffer.alloc(0);
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      pendingHellos -= 1;
      clearTimeout(timer);
      socket.off("data", onData);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish()) refuse(socket, "bad-hello");
    }, HELLO_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) {
        if (received.length > MAX_HELLO_BYTES && finish()) refuse(socket, "bad-hello");
        return;
      }
      if (!finish()) return;
      greet(
        socket,
        received.subarray(0, newline).toString("utf8"),
        received.subarray(newline + 1),
        listener,
      );
    };
    socket.on("data", onData);
    socket.on("close", () => finish());
  };

  const start = () =>
    serially(async () => {
      if (server !== null || !enabled) return;
      const next = await listenPrivate(socketPath, "browser", accept);
      if (next === null) return;
      server = next;
      log.info("browser.listening", {});
      trace.record({ event: "listening" });
    }).catch((error: unknown) => {
      log.error("browser.listen-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  const stop = () =>
    serially(async () => {
      const current = server;
      server = null;
      // Every link closes: their plays end now.
      for (const session of sessions.values()) end(session, "switch-off");
      for (const socket of sockets) socket.destroy();
      if (current === null) return;
      await closePrivate(current, socketPath);
      log.info("browser.stopped", {});
      trace.record({ event: "stopped" });
    });

  // Plays a previous core left open end where they were last heard of.
  const ended = endOpenWebPlays(db, now());
  if (ended > 0) {
    log.info("browser.plays-ended-at-start", { plays: ended });
    trace.record({ event: "plays-ended-at-start", plays: ended });
  }

  return {
    setEnabled(next) {
      enabled = next;
      return next ? start() : stop();
    },
    stop,
    listening: () => server !== null,
    browsers() {
      return [...heard].map(([bundleId, memory]) => ({
        bundleId,
        name: memory.name,
        links: [...sessions.values()].filter(
          (session) => session.bundleId === bundleId && session.ending === null,
        ).length,
        lastHeardAtMs: memory.lastHeardAtMs,
        extension: memory.extension,
      }));
    },
    sweep,
  };
}
