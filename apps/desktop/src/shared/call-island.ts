import type { Status } from "@sondine/api";
import { durationParts } from "../renderer/lib/time";
import { m } from "../renderer/paraglide/messages.js";
import { monogram, type CallPersonView, type CallView } from "./call-menu";
import { pauseEndLabel } from "./timed-pause";

// The island beside the notch (ADR 025, ADR 036), as one view: the call going
// on with its switch, whom it may be with, what may be done with its
// recording; or, with no call, a card (the call that has just ended, a pause
// forgotten). Made here with every word translated. Environment-free, so it is
// tested in Node.

export interface IslandCall {
  /** Core's id of the call, the same while it goes on. */
  readonly callId: string;
  readonly bundleId: string;
  readonly title: string;
  readonly detail: string;
  readonly monogram: string;
  /** Sondine may be recording it: the switch, and the dot beside the notch. */
  readonly on: boolean;
  readonly toggle: string;
  /** Core offers it: it is said once. */
  readonly announce: boolean;
  readonly episode: {
    readonly episodeId: number;
    readonly open: string;
    readonly end: string;
  } | null;
  readonly mute: string;
}

export interface IslandCardAction {
  readonly action: "open-episode" | "end-episode" | "resume";
  readonly label: string;
  readonly episodeId: number | null;
}

export interface IslandCard {
  readonly key: string;
  /** The app whose icon it shows; null for none. */
  readonly bundleId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly monogram: string | null;
  readonly actions: readonly IslandCardAction[];
}

export interface IslandView {
  readonly call: IslandCall | null;
  readonly people: readonly CallPersonView[];
  /** Hides the people for this call; null without any. */
  readonly dismiss: { readonly label: string; readonly callId: number } | null;
  readonly card: IslandCard | null;
  readonly openOnHover: boolean;
}

/** What the capture does now, as the menu bar says it. */
export interface CaptureView {
  /** Audio may be recorded: what the helper confirmed, never the request alone. */
  readonly mayRecord: boolean;
  /** Paused, and confirmed. */
  readonly paused: boolean;
  readonly label: string;
}

type Listening = Status["listening"];

/** A card is said at most this long after what it says. */
export const CARD_MAX_AGE_MS = 60_000;

function islandCall(
  listening: Listening,
  capture: CaptureView,
  locale: "en" | "fr",
): IslandCall | null {
  const { call, forCall, callOffer } = listening;
  // Neither listening nor paused for sure: no switch that could lie.
  if (call === null || capture.mayRecord === capture.paused) return null;
  const options = { locale };
  const detail =
    forCall?.kind === "skip" && capture.paused
      ? m.call_island_skipping({}, options)
      : forCall?.kind === "listen" && capture.mayRecord
        ? m.call_island_for_call({}, options)
        : capture.label;
  return {
    callId: call.callId,
    bundleId: call.bundleId,
    title: m.call_notice_body({ app: call.name }, options),
    detail,
    monogram: monogram(call.name, locale),
    on: capture.mayRecord,
    toggle: m.call_offer_listen({}, options),
    announce: callOffer?.callId === call.callId,
    episode:
      call.episodeId === null
        ? null
        : {
            episodeId: call.episodeId,
            open: m.call_island_open({}, options),
            end: m.episode_end({}, options),
          },
    mute: m.call_island_mute({ app: call.name }, options),
  };
}

function durationLabel(ms: number, locale: "en" | "fr"): string {
  const options = { locale };
  const parts = durationParts(ms);
  switch (parts.unit) {
    case "seconds":
      return m.duration_seconds({ seconds: String(parts.seconds) }, options);
    case "minutes":
      return m.duration_minutes({ minutes: String(parts.minutes) }, options);
    case "hours":
      return m.duration_hours(
        { hours: String(parts.hours), minutes: String(parts.minutes).padStart(2, "0") },
        options,
      );
  }
}

/** The call that has just ended, or the pause forgotten; null when there is nothing to say. */
export function islandCard(
  listening: Listening,
  locale: "en" | "fr",
  nowMs: number,
  /** The cards already said. */
  done: ReadonlySet<string>,
): IslandCard | null {
  const options = { locale };
  const ended = listening.callEnded;
  if (ended !== null && listening.call === null && nowMs - ended.endedAtMs < CARD_MAX_AGE_MS) {
    const key = `ended:${ended.endedAtMs}`;
    if (!done.has(key)) {
      const { recording, restored } = ended;
      const recorded =
        recording === null
          ? null
          : m.call_ended_recorded(
              { duration: durationLabel(recording.durationMs, locale) },
              options,
            );
      const back =
        restored === null
          ? null
          : restored === "paused"
            ? m.call_ended_paused({}, options)
            : m.call_ended_listening({}, options);
      return {
        key,
        bundleId: ended.bundleId,
        title: m.call_ended_title({ app: ended.name }, options),
        detail: [recorded, back].filter((part) => part !== null).join(" · "),
        monogram: monogram(ended.name, locale),
        actions:
          recording === null
            ? []
            : [
                {
                  action: "open-episode" as const,
                  label: m.call_island_open({}, options),
                  episodeId: recording.episodeId,
                },
                ...(recording.open
                  ? [
                      {
                        action: "end-episode" as const,
                        label: m.episode_end({}, options),
                        episodeId: recording.episodeId,
                      },
                    ]
                  : []),
              ],
      };
    }
  }
  const reminder = listening.pauseReminder;
  if (reminder === null || listening.call !== null) return null;
  const key = `paused:${reminder.sinceMs}`;
  if (done.has(key)) return null;
  return {
    key,
    bundleId: null,
    title: m.pause_reminder_title(
      { when: pauseEndLabel(reminder.sinceMs, nowMs, locale) },
      options,
    ),
    detail: m.pause_reminder_detail({}, options),
    monogram: null,
    actions: [{ action: "resume", label: m.tray_resume({}, options), episodeId: null }],
  };
}

/** What the island shows; null hides it. */
export function islandView(input: {
  readonly listening: Listening | null;
  readonly capture: CaptureView;
  /** Whom the call may be with (ADR 025). */
  readonly people: CallView | null;
  readonly card: IslandCard | null;
  readonly openOnHover: boolean;
  readonly locale: "en" | "fr";
}): IslandView | null {
  const { listening, people, openOnHover } = input;
  const call = listening === null ? null : islandCall(listening, input.capture, input.locale);
  if (call === null && people === null && input.card === null) return null;
  // A card waits for nobody: it shows when no call does.
  const card = call === null ? input.card : null;
  const shown = card === null ? people : null;
  return {
    call,
    people: shown?.people ?? [],
    dismiss:
      shown === null
        ? null
        : {
            // Beside the call's own rows, it says what it hides.
            label:
              call === null
                ? shown.dismiss
                : m.call_island_hide_people({}, { locale: input.locale }),
            callId: shown.callId,
          },
    card,
    openOnHover,
  };
}
