import { join } from "node:path";
import type { Status } from "@sondine/api";
import {
  Menu,
  nativeImage,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { m } from "../renderer/paraglide/messages.js";
import type { CallMenu } from "../shared/call-menu";
import type { HelperProcessInfo } from "../shared/core-messages";
import { queueLine, queueLineText } from "../shared/queue-line";
import { pauseEndLabel } from "../shared/timed-pause";
import { holdLines } from "../shared/hold-lines";
import { KEEP_RECENT_SHORTCUT } from "../shared/keep-recent";
import { isReleasePage } from "../shared/updates";
import { log } from "./log";
import { PASTE_CONTEXT_SHORTCUT, PASTE_FEEDBACK_MS } from "./paste-context";
import {
  activeHolds,
  mayRecord,
  TIMED_PAUSE_MS,
  trayControls,
  trayState,
  type TrayControl,
  type TrayLocale,
  type TrayState,
} from "./tray-state";

// The menu bar item: during a call with someone recognized, « Marie ? » next
// to the icon and her last conversations first (ADR 025); the listening state
// (with the end of a timed pause), the transcription queue in one line, pause
// for 15 min, 1 h or until resumed, resume, open, add the clipboard to the
// conversation going on (⌃⌥⌘V, ADR 024), keep the last 2 minutes (⌃⌥⌘K),
// erase the last 5 min, 15 min or hour, quit. While a call goes on, its
// switch (ADR 036): « Écouter l'appel <app> » during a pause, « Ne pas écouter
// l'appel <app> » otherwise, as beside the notch. Labels come
// from the same Paraglide catalog as the renderer, in the OS locale.

/** « Effacer les N dernières minutes »: the choices offered. */
export const FORGET_MINUTES = [5, 15, 60] as const;
export type ForgetMinutes = (typeof FORGET_MINUTES)[number];

export interface TrayActions {
  /** `untilMs`: a timed pause's end; null pauses until a resume. */
  pause(untilMs: number | null): void;
  /** Confirms, then erases what was heard in the last `minutes`. */
  forget(minutes: ForgetMinutes): void;
  resume(): void;
  open(): void;
  /** Opens the window on a conversation, or a person's page. */
  openEpisode(episodeId: number): void;
  openPerson(personId: number): void;
  /** « Masquer pour cet appel ». */
  dismissCall(callId: number): void;
  /**
   * « Écouter l'appel <app> » listens until that call ends, « Ne pas écouter
   * l'appel <app> » pauses until it ends (ADR 036).
   */
  answerCall(callId: string, answer: "listen" | "skip"): void;
  /** « Écouter quand même »: lifts these holds of private zones until each ends (ADR 029). */
  lift(occurrenceIds: readonly string[]): void;
  /** « Redémarrer et mettre à jour »: a ready update, as soon as nothing is cut (ADR 045). */
  installUpdate(): void;
  /** « Ajouter le presse-papiers » (⌃⌥⌘V): to the conversation going on. */
  pasteContext(): void;
  /** « Garder les 2 dernières minutes » (⌃⌥⌘K). */
  keepRecent(): void;
  quit(): void;
}

/** What the menu bar says of the capture. */
export function trayLabel(
  state: TrayState,
  locale: TrayLocale,
  pausedUntilMs: number | null,
): string {
  const options = { locale };
  switch (state) {
    case "connecting":
      return m.tray_state_connecting({}, options);
    case "listening":
      return m.tray_state_listening({}, options);
    case "held":
      return m.tray_state_listening({}, options);
    case "paused":
      return pausedUntilMs === null
        ? m.tray_state_paused({}, options)
        : m.tray_state_paused_until(
            { time: pauseEndLabel(pausedUntilMs, Date.now(), locale) },
            options,
          );
    case "pause-unconfirmed":
      return m.tray_state_pause_unconfirmed({}, options);
    case "partial":
      return m.tray_state_partial({}, options);
    case "disk-full":
      return m.tray_state_disk_full({}, options);
    case "write-error":
      return m.tray_state_write_error({}, options);
    case "unavailable":
      return m.tray_state_unavailable({}, options);
    case "crash-loop":
      return m.tray_state_crash_loop({}, options);
  }
}

function loadTemplate(directory: string, name: string): NativeImage {
  // `<name>Template.png` with an `@2x` sibling: macOS tints it for the menu bar.
  const image = nativeImage.createFromPath(join(directory, `${name}Template.png`));
  image.setTemplateImage(true);
  return image;
}

export interface SondineTray {
  /**
   * `status` is null while core is down; `coreCrashLoop` when it keeps exiting;
   * `dataDiskFull` when the data volume has no room left.
   */
  update(
    status: Status | null,
    helper: HelperProcessInfo | null,
    coreCrashLoop?: boolean,
    dataDiskFull?: boolean,
    call?: CallMenu | null,
  ): void;
  /** Shows `text` next to the icon for a moment (what ⌃⌥⌘V or ⌃⌥⌘K did). */
  flash(text: string): void;
  destroy(): void;
}

export function createSondineTray(
  iconDirectory: string,
  locale: TrayLocale,
  actions: TrayActions,
): SondineTray {
  const icons = {
    listening: loadTemplate(iconDirectory, "tray"),
    paused: loadTemplate(iconDirectory, "trayPaused"),
  };
  const tray = new Tray(icons.paused);
  let last = "";
  // The call's name, or nothing; a flash shows over it for a moment.
  let title = "";
  let flashing: NodeJS.Timeout | undefined;

  const update: SondineTray["update"] = (
    status,
    helper,
    coreCrashLoop = false,
    dataDiskFull = false,
    call = null,
  ) => {
    const state = trayState(status, helper, coreCrashLoop, dataDiskFull);
    const controls = trayControls(state, status);
    const pausedUntilMs = status?.listening.pausedUntilMs ?? null;
    // Why nothing is transcribed yet, without opening the window.
    const queue = status === null ? null : queueLineText(queueLine(status.analysis), locale);
    const update = status?.updates.available ?? null;
    const updateReady = status?.updates.phase === "ready";
    const holds = activeHolds(status);
    const going = status?.listening.call ?? null;
    // Neither listening nor paused for sure: no switch that could lie.
    const callAnswer =
      going === null ? null : state === "paused" ? "listen" : mayRecord(state) ? "skip" : null;
    const forCall = status?.listening.forCall ?? null;
    const key = `${state}:${controls.items.join(",")}:${controls.enabled}:${pausedUntilMs}:${queue}:${update?.version ?? ""}:${updateReady}:${JSON.stringify(call)}:${JSON.stringify(holds)}:${callAnswer ?? ""}:${going?.callId ?? ""}:${forCall?.kind ?? ""}:${forCall?.bundleId ?? ""}`;
    if (key === last) return;
    last = key;
    log.info("tray.state", { state, timed: pausedUntilMs !== null, call: call !== null });
    const options = { locale };
    const control = (item: TrayControl) => {
      switch (item) {
        case "pause-15-min":
        case "pause-1-hour": {
          const durationMs = TIMED_PAUSE_MS[item];
          const label =
            item === "pause-15-min"
              ? m.tray_pause_15_min({}, options)
              : m.tray_pause_1_hour({}, options);
          return { label, click: () => actions.pause(Date.now() + durationMs) };
        }
        case "pause":
          return {
            label: m.tray_pause_until_resumed({}, options),
            click: () => actions.pause(null),
          };
        case "retry-pause":
          // The same pause again, timed or not.
          return {
            label: m.tray_retry_pause({}, options),
            click: () =>
              actions.pause(
                pausedUntilMs !== null && pausedUntilMs > Date.now() ? pausedUntilMs : null,
              ),
          };
        case "resume":
          return { label: m.tray_resume({}, options), click: actions.resume };
      }
    };
    const label =
      state === "held"
        ? (holdLines(holds, locale)[0] ?? "")
        : state === "listening" && forCall?.kind === "listen"
          ? m.tray_for_call({ app: forCall.name }, options)
          : state === "paused" && forCall?.kind === "skip"
            ? m.tray_skipping_call({ app: forCall.name }, options)
            : trayLabel(state, locale, pausedUntilMs);
    const switchItems: MenuItemConstructorOptions[] =
      going === null || callAnswer === null
        ? []
        : [
            {
              label:
                callAnswer === "listen"
                  ? m.tray_call_offer({ app: going.name }, options)
                  : m.tray_call_skip({ app: going.name }, options),
              click: () => actions.answerCall(going.callId, callAnswer),
            },
          ];
    // What else holds (the first says it when everything is held).
    const holdItems = (
      state === "held" ? holdLines(holds, locale).slice(1) : holdLines(holds, locale)
    ).map((line): MenuItemConstructorOptions => ({ label: line, enabled: false }));
    const liftItems: MenuItemConstructorOptions[] =
      holds.length === 0
        ? []
        : [
            {
              label: m.tray_lift({}, options),
              click: () => actions.lift(holds.map((hold) => hold.occurrenceId)),
            },
          ];
    tray.setImage(mayRecord(state) ? icons.listening : icons.paused);
    tray.setToolTip(`${m.app_name({}, options)} · ${label}`);
    title = call?.title ?? "";
    if (flashing === undefined) tray.setTitle(title);
    const callItems = (call?.items ?? []).map((item): MenuItemConstructorOptions => {
      switch (item.kind) {
        case "person":
          return { label: item.label, click: () => actions.openPerson(item.personId) };
        case "conversation":
          return { label: item.label, click: () => actions.openEpisode(item.episodeId) };
        case "none":
          return { label: item.label, enabled: false };
        case "dismiss":
          return { label: item.label, click: () => actions.dismissCall(item.callId) };
      }
    });
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(callItems.length === 0 ? [] : [...callItems, { type: "separator" as const }]),
        { label, enabled: false },
        ...switchItems,
        ...holdItems,
        ...liftItems,
        ...(queue === null ? [] : [{ label: queue, enabled: false }]),
        { type: "separator" },
        ...controls.items.map((item) => ({ ...control(item), enabled: controls.enabled })),
        { label: m.tray_open({}, options), click: actions.open },
        {
          label: m.tray_paste({}, options),
          accelerator: PASTE_CONTEXT_SHORTCUT,
          // Global: registered apart, shown here.
          registerAccelerator: false,
          enabled: status !== null,
          click: actions.pasteContext,
        },
        ...(update === null
          ? []
          : [
              {
                label: updateReady
                  ? m.tray_update_install({ version: update.version }, options)
                  : m.tray_update({ version: update.version }, options),
                // Only a release page of Sondine's repository opens.
                click: () => {
                  if (updateReady) actions.installUpdate();
                  else if (isReleasePage(update.url)) void shell.openExternal(update.url);
                },
              },
            ]),
        { type: "separator" },
        {
          label: m.tray_keep({}, options),
          accelerator: KEEP_RECENT_SHORTCUT,
          registerAccelerator: false,
          // Paused part-way, what was heard before still keeps.
          enabled: status !== null,
          click: actions.keepRecent,
        },
        {
          label: m.tray_forget({}, options),
          enabled: controls.enabled,
          submenu: FORGET_MINUTES.map((minutes) => ({
            label:
              minutes === 60
                ? m.tray_forget_hour({}, options)
                : m.tray_forget_minutes({ minutes: String(minutes) }, options),
            click: () => actions.forget(minutes),
          })),
        },
        { type: "separator" },
        { label: m.tray_quit({}, options), click: actions.quit, accelerator: "Command+Q" },
      ]),
    );
  };

  const flash = (text: string) => {
    clearTimeout(flashing);
    tray.setTitle(text);
    flashing = setTimeout(() => {
      flashing = undefined;
      tray.setTitle(title);
    }, PASTE_FEEDBACK_MS);
  };

  update(null, null);
  return {
    update,
    flash,
    destroy: () => {
      clearTimeout(flashing);
      tray.destroy();
    },
  };
}
