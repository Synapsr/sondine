import type { CaptureHold, Status } from "@sondine/api";
import type { HelperProcessInfo } from "../shared/core-messages";
import { TIMED_PAUSES_MS } from "../shared/timed-pause";

// What the menu bar item says. The recording indicator follows what the
// helper confirmed, never the user's request alone: recording while showing
// "paused" is the worst failure Sondine can have. A pause the helper has not
// confirmed (pending or rejected) shows separately, with a retry.

export type TrayLocale = "en" | "fr";

export function trayLocale(osLocale: string): TrayLocale {
  return osLocale.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export type TrayState =
  | "connecting"
  | "listening"
  /** A private zone holds all capture (ADR 029): nothing records, and it is not a pause. */
  | "held"
  | "paused"
  | "pause-unconfirmed"
  | "partial"
  | "disk-full"
  | "write-error"
  | "unavailable"
  | "crash-loop";

/**
 * @param status Core's status, or null while core is starting or restarting.
 * @param coreCrashLoop Core keeps exiting; main's supervisor says so.
 * @param dataDiskFull The data volume has no room left: a core that is down
 *   cannot open its database, which explains the crash loop.
 */
export function trayState(
  status: Status | null,
  helper: HelperProcessInfo | null,
  coreCrashLoop = false,
  dataDiskFull = false,
): TrayState {
  if (status === null && dataDiskFull) return "disk-full";
  if (helper?.state === "crash-loop" || coreCrashLoop) return "crash-loop";
  const pauseWanted = status?.listening.desired === "paused";
  // No helper process runs, so nothing records; core re-applies the pause on reconnect.
  const helperAway =
    helper?.state === "restarting" || helper?.state === "missing" || helper?.state === "stopped";
  if (pauseWanted && helperAway) return "paused";
  if (helper?.state === "missing" || helper?.state === "stopped") return "unavailable";
  if (status === null) return "connecting";
  if (status.helper.connection === "incompatible") return "unavailable";
  const connected = status.helper.connection === "connected";
  const effective = connected ? status.listening.effective : "unknown";
  if (pauseWanted && effective !== "paused") return "pause-unconfirmed";
  if (!connected) return "connecting";
  if (effective === "paused") return "paused";
  // Capture runs but its audio is not stored: that comes before any other state.
  if (status.spool.some((problem) => problem.code === "disk.full")) return "disk-full";
  if (status.spool.length > 0) return "write-error";
  if (effective === "partial") return "partial";
  if (effective !== "listening") return "connecting";
  return activeHolds(status).some((hold) => hold.scope === "all") ? "held" : "listening";
}

/** The holds of private zones not lifted with « Écouter quand même » (ADR 029). */
export function activeHolds(status: Status | null): readonly CaptureHold[] {
  return (status?.listening.holds ?? []).filter((hold) => !hold.lifted);
}

/**
 * The helper may be capturing: the menu bar shows the listening icon. A spool
 * that cannot write still has the microphone open.
 */
export function mayRecord(state: TrayState): boolean {
  return (
    state === "listening" ||
    state === "partial" ||
    state === "pause-unconfirmed" ||
    state === "disk-full" ||
    state === "write-error"
  );
}

/** `pause` lasts until a resume; the timed ones end on their own (`TIMED_PAUSE_MS`). */
export type TrayControl = "pause-15-min" | "pause-1-hour" | "pause" | "retry-pause" | "resume";

export const TIMED_PAUSE_MS = {
  "pause-15-min": TIMED_PAUSES_MS["15-min"],
  "pause-1-hour": TIMED_PAUSES_MS["1-hour"],
} as const satisfies Partial<Record<TrayControl, number>>;

const PAUSES: readonly TrayControl[] = ["pause-15-min", "pause-1-hour", "pause"];

export interface TrayControls {
  readonly items: readonly TrayControl[];
  /** Only core can pause or resume; without it the controls are unavailable. */
  readonly enabled: boolean;
}

export function trayControls(state: TrayState, status: Status | null): TrayControls {
  const enabled = status !== null;
  switch (state) {
    case "pause-unconfirmed":
      // Retry, or give up the pause the helper did not apply.
      return { items: ["retry-pause", "resume"], enabled };
    case "paused":
      // A timed pause can become open-ended.
      return {
        items:
          (status?.listening.pausedUntilMs ?? null) === null ? ["resume"] : ["resume", "pause"],
        enabled,
      };
    case "listening":
    case "held":
    case "partial":
    case "disk-full":
    case "write-error":
      return { items: PAUSES, enabled };
    default:
      return { items: status?.listening.desired === "paused" ? ["resume"] : PAUSES, enabled };
  }
}
