import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ListeningStatus } from "@sondine/api";
import { islandCard, islandView } from "../shared/call-island";
import { monogram, whenLabel, type CallView } from "../shared/call-menu";
import { m } from "../renderer/paraglide/messages.js";
import {
  LAB_SCENARIOS,
  LAB_START,
  labReduce,
  type LabApp,
  type LabCommand,
  type LabState,
  type LabStep,
  type LabView,
} from "../shared/notch-lab";
import { createIslandIcons } from "./island-icons";
import { log } from "./log";
import { createNotch, type Notch } from "./notch";
import { trayLabel } from "./tray";
import { mayRecord } from "./tray-state";

// Development only (shared/notch-lab.ts): a second notch, with the real
// helper, views and icons, for a call that does not exist. It never reaches
// core: nothing is listened to, paused or recorded.

const APPS: Record<LabApp, { readonly bundleId: string; readonly name: string }> = {
  discord: { bundleId: "com.hnc.Discord", name: "Discord" },
  zoom: { bundleId: "us.zoom.xos", name: "Zoom" },
  facetime: { bundleId: "com.apple.FaceTime", name: "FaceTime" },
  // No icon, and a name that does not fit.
  long: { bundleId: "dev.sondine.lab", name: "Visioconférence de la Direction régionale" },
};

const PEOPLE = ["Marie", "Élodie", "Paul", "Anne-Charlotte de Saint-Exupéry"];
const WORDS = ["On reprend le budget de la semaine prochaine", null, "Bonjour, tu m’entends ?"];

/** How long core and the helper take to answer a click. */
const ANSWER_MS = 160;
const DAY_MS = 86_400_000;
const LOG_MAX = 60;

function peopleView(state: LabState, nowMs: number): CallView | null {
  const { people: count, locale, openOnHover } = state.settings;
  if (state.call === null || count === 0) return null;
  const options = { locale };
  const people = PEOPLE.slice(0, count).map((name, index) => {
    const conversations = WORDS.slice(index).map((words, n) => ({
      episodeId: index * 10 + n + 1,
      when: whenLabel(nowMs - (n * n + n + index) * DAY_MS, nowMs, locale),
      words,
    }));
    const none = index === 1;
    return {
      personId: index + 1,
      label: m.voice_guess({ name }, options),
      monogram: monogram(name, locale),
      conversations: none ? [] : conversations,
      none: none ? m.call_menu_none({}, options) : null,
    };
  });
  return {
    callId: state.call,
    title: people[0]?.label ?? "",
    people,
    dismiss: m.call_menu_dismiss({}, options),
    openOnHover,
  };
}

function listeningOf(state: LabState): ListeningStatus {
  const { capture, recording } = state.settings;
  const named = APPS[state.settings.app];
  const paused = capture === "paused";
  const call =
    state.call === null
      ? null
      : {
          callId: `lab-${state.call}`,
          ...named,
          sinceMs: 0,
          episodeId: recording ? 1_000 : null,
        };
  const { card } = state;
  return {
    desired: paused ? "paused" : "listening",
    effective: paused ? "paused" : "listening",
    microphonePaused: paused,
    systemAudioPaused: paused,
    changedAtMs: 0,
    pausedUntilMs: null,
    holds: [],
    callOffer:
      call !== null && state.offered
        ? { kind: paused ? "listen" : "skip", callId: call.callId, ...named, sinceMs: 0 }
        : null,
    forCall: state.answer === null ? null : { kind: state.answer.kind, ...named, sinceMs: 0 },
    call,
    callEnded:
      card?.kind === "ended"
        ? {
            callId: "lab-ended",
            ...named,
            endedAtMs: card.atMs,
            recording: card.recorded
              ? { episodeId: 1_000, durationMs: 32 * 60_000, open: card.open }
              : null,
            restored: card.restored,
          }
        : null,
    pauseReminder: card?.kind === "paused" ? { sinceMs: card.atMs - 3 * 3_600_000 } : null,
  };
}

export interface NotchLab {
  view(): LabView;
  run(command: LabCommand): LabView;
  /** The window closed: the island goes with it. */
  stop(): void;
}

/**
 * `helpers`: where the notch helper may be built. Given by index.ts, which
 * alone imports paths.ts: shared with this chunk, it would move, and the
 * folders it finds from its own place with it.
 */
export function createNotchLab(
  helpers: { readonly debug: string; readonly release: string | null },
  onChange: (view: LabView) => void,
): NotchLab {
  const debugHelper = () => (existsSync(helpers.debug) ? helpers.debug : null);
  let state = LAB_START;
  let lines: LabView["log"] = [];
  let problem: LabView["problem"] = null;
  let timers: NodeJS.Timeout[] = [];
  let notch: Notch | null = null;
  let slow = LAB_START.settings.slow;
  /** When the helper running was built. */
  let builtMs = 0;

  /** When the helper to run was built; 0 for none. */
  const buildOf = () => {
    const binary = debugHelper() ?? helpers.release;
    return binary === null || !existsSync(binary) ? 0 : statSync(binary).mtimeMs;
  };

  const view = (): LabView => ({ state, canSlow: debugHelper() !== null, problem, log: lines });
  const note = (line: string) => {
    lines = [{ atMs: Date.now(), line }, ...lines].slice(0, LOG_MAX);
  };

  const icon = createIslandIcons(() => show());

  function open(): Notch | null {
    const binary = debugHelper() ?? helpers.release;
    if (binary === null) {
      problem = "no-helper";
      return null;
    }
    problem = null;
    const factor = slow;
    /** A click, answered as late as core would. */
    const clicked = (line: string, step: LabStep) => {
      note(line);
      onChange(view());
      setTimeout(() => apply(step), ANSWER_MS);
    };
    const said = (line: string) => {
      note(line);
      onChange(view());
    };
    return createNotch({
      binary,
      spawn: (path) =>
        spawn(path, [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { SONDINE_NOTCH_SLOW: String(factor) },
        }),
      actions: {
        openEpisode: (episodeId) => said(`open-episode ${episodeId}`),
        openPerson: (personId) => said(`open-person ${personId}`),
        dismissCall: () => clicked("dismiss", { type: "dismiss" }),
        setCall: (_callId, on) => clicked(`toggle ${on ? "on" : "off"}`, { type: "toggle", on }),
        muteCall: () => clicked("mute", { type: "mute" }),
        endEpisode: () => clicked("end-episode", { type: "end-episode" }),
        resume: () => clicked("resume", { type: "resume" }),
        cardDone: () => {
          note("done");
          apply({ type: "card-done" });
        },
      },
      icon,
      onAvailable: () => {
        if (notch?.available() === false) problem = "no-notch";
        onChange(view());
      },
      log: (event, fields) => {
        log.info(`lab.${event}`, fields);
        note(fields === undefined ? event : `${event} ${JSON.stringify(fields)}`);
      },
    });
  }

  function show(): void {
    const build = buildOf();
    if (slow !== state.settings.slow || build !== builtMs) {
      // Its pace is set when it starts; a helper built since replaces it.
      slow = state.settings.slow;
      builtMs = build;
      void notch?.stop();
      notch = null;
    }
    const { capture, locale, openOnHover } = state.settings;
    const listening = listeningOf(state);
    const nowMs = Date.now();
    const next = islandView({
      listening,
      capture: {
        mayRecord: mayRecord(capture),
        paused: capture === "paused",
        label: trayLabel(capture, locale, null),
      },
      people: peopleView(state, nowMs),
      card: islandCard(listening, locale, nowMs, new Set()),
      openOnHover,
      locale,
    });
    if (next !== null) notch ??= open();
    notch?.update(next);
    onChange(view());
  }

  function apply(step: LabStep): void {
    state = labReduce(state, step, Date.now());
    show();
  }

  function cancel(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  return {
    view,
    run(command) {
      if (command.type === "scenario") {
        cancel();
        note(`— ${command.name}`);
        apply({ type: "hide" });
        // Once the island of before has gone.
        const gone = 700;
        for (const [atMs, step] of LAB_SCENARIOS[command.name]) {
          timers.push(setTimeout(() => apply(step), gone + atMs));
        }
      } else {
        if (command.type !== "set") cancel();
        apply(command);
      }
      return view();
    },
    stop() {
      cancel();
      state = { ...LAB_START, settings: state.settings };
      void notch?.stop();
      notch = null;
    },
  };
}
