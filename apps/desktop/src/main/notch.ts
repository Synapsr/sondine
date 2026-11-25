import { spawn, type ChildProcess } from "node:child_process";
import {
  NOTCH_LINE_MAX,
  NotchCommand,
  NotchEvent,
  createJsonLinesDecoder,
  encodeJsonLine,
} from "@sondine/protocol";
import type { IslandView } from "../shared/call-island";

// The island beside the notch (ADR 025, ADR 036). While there is something to
// show (a call, whom it may be with, a card), main runs `sondine-notch` and
// writes it one `show` line per change; the helper says what the user clicked,
// and when a card has had its time. Closing its stdin hides it and it exits,
// so it never outlives main. One helper is current at a time; one being closed
// is killed if it has not exited after a grace period.
// Each `show` has a number, and a click names the one it was made on: a
// click on a view since replaced or hidden does nothing.

export interface NotchActions {
  openEpisode(episodeId: number): void;
  openPerson(personId: number): void;
  dismissCall(callId: number): void;
  /** The call's switch: listen to it, or not. */
  setCall(callId: string, on: boolean): void;
  muteCall(callId: string): void;
  endEpisode(episodeId: number): void;
  resume(): void;
  /** The card has had its time, or was answered. */
  cardDone(key: string): void;
}

type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface NotchOptions {
  /** `sondine-notch`; null when this build has none. */
  readonly binary: string | null;
  readonly actions: NotchActions;
  /** The app's icon, a small PNG in base64; null while unknown. */
  readonly icon: (bundleId: string) => string | null;
  /** Whether it can show anything has changed (`available`). */
  readonly onAvailable: () => void;
  /** Events and categories only: never a name or words. */
  readonly log: (event: string, fields?: LogFields) => void;
  readonly spawn?: (binary: string) => ChildProcess;
  readonly stopGraceMs?: number;
}

export interface Notch {
  /** What it shows now; null hides the notch. */
  update(view: IslandView | null): void;
  /**
   * Whether the island is there for what is shown now: false without a notch
   * or a working helper, so main says it another way; null while it is not known.
   */
  available(): boolean | null;
  /** The island has said this call, or this card, beside a notch. */
  said(subject: string): boolean;
  /** A display came, went or changed: a notch may be there now. */
  screensChanged(): void;
  /** Hides it and waits for the helper to exit. */
  stop(): Promise<void>;
}

interface Helper {
  readonly process: ChildProcess;
  readonly startedAtMs: number;
  readonly gone: Promise<void>;
  /** Ends its stdin, which hides it; kills it if it has not exited after the grace period. */
  readonly close: () => void;
  closing: boolean;
  /** It said no screen has a notch. */
  noNotch: boolean;
  /** It said it shows beside a notch. */
  ready: boolean;
  /** The displays' generation when it looked for a notch. */
  readonly screens: number;
}

const spawnHelper = (binary: string) =>
  spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: {} });

export function createNotch(options: NotchOptions): Notch {
  const start = options.spawn ?? spawnHelper;
  const graceMs = options.stopGraceMs ?? 2_000;
  const { log } = options;
  /** The view main wants shown, and its JSON to skip repeats. */
  let wanted: IslandView | null = null;
  let wantedKey: string | null = null;
  /** The view the current helper shows, and its number; clicks must name it. */
  let shown: { readonly view: IslandView; readonly number: number } | null = null;
  let numbers = 0;
  let current: Helper | null = null;
  const live = new Set<Helper>();
  /** No screen has a notch: wait for the displays to change. */
  let noNotch = false;
  /** Counts display changes, so one during a helper's last moments is not lost. */
  let screens = 0;
  /** The helper failed during this call or card: not again before the next one. */
  let failedFor: string | null = null;
  let stopped = false;
  /** Calls and cards the island has said: not said again by the next helper, or as a notification. */
  const said = new Set<string>();

  function spawnOne(binary: string): Helper | null {
    let child: ChildProcess;
    try {
      child = start(binary);
    } catch {
      log("notch.spawn-error");
      return null;
    }
    const gone = Promise.withResolvers<void>();
    let killer: NodeJS.Timeout | null = null;
    const helper: Helper = {
      process: child,
      startedAtMs: Date.now(),
      gone: gone.promise,
      closing: false,
      noNotch: false,
      ready: false,
      screens,
      close() {
        if (helper.closing) return;
        helper.closing = true;
        child.stdin?.end();
        killer = setTimeout(() => {
          log("notch.kill");
          child.kill("SIGKILL");
        }, graceMs);
      },
    };
    live.add(helper);
    let finished = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      if (killer !== null) clearTimeout(killer);
      live.delete(helper);
      gone.resolve();
      if (current === helper) {
        current = null;
        shown = null;
      }
      log("notch.exit", { code, signal });
      if (helper.closing || stopped) {
        // Retired: the next view waited for it to go.
      } else if (helper.noNotch) {
        // The displays changed since it looked: look again.
        noNotch = helper.screens === screens;
      } else {
        failedFor = wanted === null ? null : subjectOf(wanted);
        log("notch.failed");
      }
      deliver();
      options.onAvailable();
    };
    // An EPIPE only means the helper is already gone.
    child.stdin?.on("error", () => undefined);
    const events = createJsonLinesDecoder(NotchEvent, { maxLineBytes: NOTCH_LINE_MAX });
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const result of events.push(chunk)) {
        if (result.ok) heard(helper, result.value);
        else log("notch.bad-event", { kind: result.error.kind });
      }
    });
    // The helper writes `sondine-notch: <category>`; only the category is kept.
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const category = /^sondine-notch: ([a-z-]{1,40})$/u.exec(line.trim())?.[1];
        if (category !== undefined) log("notch.warning", { category });
      }
    });
    child.once("spawn", () => log("notch.spawned", { pid: child.pid ?? null }));
    child.on("error", () => {
      // Without a pid it never started; with one, a failed kill is not an exit.
      if (child.pid === undefined) {
        log("notch.spawn-error");
        finish(null, null);
      }
    });
    // After its output is read: a last `no-notch` is heard before the end.
    child.once("close", (code, signal) => finish(code, signal));
    return helper;
  }

  function heard(helper: Helper, event: NotchEvent): void {
    if (helper !== current) return;
    switch (event.type) {
      case "ready":
        helper.ready = true;
        if (shown !== null) saying(shown.view);
        log("notch.ready", { ms: Date.now() - helper.startedAtMs });
        options.onAvailable();
        return;
      case "no-notch":
        helper.noNotch = true;
        log("notch.no-notch");
        return;
      default:
        break;
    }
    const view = shown;
    // A card's time is up whatever the view has become: its icon may have come since.
    if (event.type === "done" && event.key === view?.view.card?.key) {
      options.actions.cardDone(event.key);
      return;
    }
    if (view === null || event.view !== view.number) {
      log("notch.stale-click");
      return;
    }
    const { call, card } = view.view;
    switch (event.type) {
      case "open-person":
        if (view.view.people.some((person) => person.personId === event.personId)) {
          options.actions.openPerson(event.personId);
          return;
        }
        break;
      case "open-episode":
        if (
          call?.episode?.episodeId === event.episodeId ||
          card?.actions.some(
            (action) => action.action === "open-episode" && action.episodeId === event.episodeId,
          ) === true ||
          view.view.people.some((person) =>
            person.conversations.some((conversation) => conversation.episodeId === event.episodeId),
          )
        ) {
          options.actions.openEpisode(event.episodeId);
          return;
        }
        break;
      case "dismiss":
        if (event.callId === view.view.dismiss?.callId) {
          options.actions.dismissCall(event.callId);
          return;
        }
        break;
      case "toggle":
        if (event.callId === call?.callId) {
          // Asked for what it already is: the view has moved on.
          if (event.on !== call.on) options.actions.setCall(event.callId, event.on);
          return;
        }
        break;
      case "mute":
        if (event.callId === call?.callId) {
          options.actions.muteCall(event.callId);
          return;
        }
        break;
      case "end-episode":
        if (
          call?.episode?.episodeId === event.episodeId ||
          card?.actions.some(
            (action) => action.action === "end-episode" && action.episodeId === event.episodeId,
          ) === true
        ) {
          options.actions.endEpisode(event.episodeId);
          return;
        }
        break;
      case "resume":
        if (card?.actions.some((action) => action.action === "resume") === true) {
          options.actions.resume();
          return;
        }
        break;
      case "done":
        break;
    }
    log("notch.unknown-click", { type: event.type });
  }

  /** Shows `wanted` in the current helper, starting one when needed. */
  function deliver(): void {
    const view = wanted;
    const binary = options.binary;
    if (stopped || view === null || binary === null || noNotch) return;
    if (failedFor === subjectOf(view)) return;
    // One helper at a time: a retiring one is waited for (its end delivers again).
    if (current !== null && current.closing) return;
    if ([...live].some((helper) => helper.closing)) return;
    shown = null;
    const number = ++numbers;
    const announce = view.call !== null && view.call.announce && !said.has(view.call.callId);
    const encoded = encodeJsonLine(NotchCommand, command(view, number, announce, options.icon), {
      maxLineBytes: NOTCH_LINE_MAX,
    });
    if (!encoded.ok) {
      // Nothing stale stays up: the menu bar still shows the call.
      log("notch.bad-view", { kind: encoded.error.kind });
      failedFor = subjectOf(view);
      current?.close();
      options.onAvailable();
      return;
    }
    current ??= spawnOne(binary);
    if (current === null) return;
    current.process.stdin?.write(encoded.line);
    shown = { view, number };
    if (current.ready) saying(view);
  }

  /** Beside a notch for sure: what the view announces has been said. */
  function saying(view: IslandView): void {
    if (view.call?.announce === true) said.add(view.call.callId);
    else if (view.card !== null) said.add(view.card.key);
  }

  function hide(): void {
    shown = null;
    current?.close();
  }

  return {
    update(view) {
      // The icon comes a moment after the view, which is then sent again.
      const bundleId = view?.call?.bundleId ?? view?.card?.bundleId ?? null;
      const key =
        view === null
          ? null
          : JSON.stringify([view, bundleId !== null && options.icon(bundleId) !== null]);
      if (key === wantedKey) return;
      wanted = view;
      wantedKey = key;
      if (view === null) {
        hide();
        return;
      }
      if (failedFor !== null && failedFor !== subjectOf(view)) failedFor = null;
      deliver();
    },
    screensChanged() {
      screens += 1;
      if (!noNotch) return;
      noNotch = false;
      deliver();
    },
    available() {
      if (options.binary === null || noNotch) return false;
      if (wanted !== null && failedFor === subjectOf(wanted)) return false;
      return current?.ready === true && !current.closing ? true : null;
    },
    said: (subject) => said.has(subject),
    async stop() {
      stopped = true;
      hide();
      for (const helper of live) helper.close();
      await Promise.all([...live].map((helper) => helper.gone));
    },
  };
}

/** The call or the card it is about. */
const subjectOf = (view: IslandView) =>
  view.call?.callId ?? view.card?.key ?? `people:${view.dismiss?.callId ?? 0}`;

/** The view as the helper reads it. */
function command(
  view: IslandView,
  number: number,
  announce: boolean,
  icon: NotchOptions["icon"],
): NotchCommand {
  const { call, card } = view;
  return {
    type: "show",
    view: number,
    call:
      call === null
        ? null
        : {
            callId: call.callId,
            title: call.title,
            detail: call.detail,
            icon: icon(call.bundleId),
            monogram: call.monogram,
            on: call.on,
            toggle: call.toggle,
            announce,
            episode:
              call.episode === null
                ? null
                : {
                    episodeId: call.episode.episodeId,
                    open: call.episode.open,
                    end: call.episode.end,
                  },
            mute: call.mute,
          },
    people: view.people.map((person) => ({
      personId: person.personId,
      label: person.label,
      monogram: person.monogram,
      conversations: person.conversations.map(({ episodeId, when, words }) => ({
        episodeId,
        when,
        words,
      })),
      none: person.none,
    })),
    dismiss: view.dismiss === null ? null : { ...view.dismiss },
    card:
      card === null
        ? null
        : {
            key: card.key,
            title: card.title,
            detail: card.detail,
            icon: card.bundleId === null ? null : icon(card.bundleId),
            monogram: card.monogram,
            actions: card.actions.map((action) => ({ ...action })),
          },
    openOnHover: view.openOnHover,
  };
}
