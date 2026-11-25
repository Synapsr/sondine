import type { Status, UpdateWait } from "@sondine/api";
import type { CaptureGoingOn } from "@sondine/db";

// What an update would cut (ADR 045): it installs only when nothing is left
// here. `in-use` is the one wait a person may skip, with « Redémarrer et
// mettre à jour ».

/** The Mac counts as idle after this long without input, or with its screen locked. */
export const IDLE_FOR_UPDATE_SECONDS = 5 * 60;

export interface GoingOn {
  readonly status: Status;
  readonly capture: CaptureGoingOn;
  /** A phone's request is being answered, or a pairing is open. */
  readonly phone: boolean;
  /** The journal, an agent's answer, a voice read, a model, an action of the window, an export. */
  readonly task: boolean;
  readonly idle: { readonly idleSeconds: number | null; readonly locked: boolean };
}

export function updateWaits({ status, capture, phone, task, idle }: GoingOn): UpdateWait[] {
  const { listening, analysis, tracks, power } = status;
  const waits: UpdateWait[] = [];
  if (capture.call || listening.call !== null || listening.callOffer !== null) waits.push("call");
  if (capture.dictation) waits.push("dictation");
  if (capture.conversation || tracks.some((track) => track.speaking)) waits.push("conversation");
  if (
    analysis.running !== null ||
    analysis.worker === "loading" ||
    analysis.worker === "busy" ||
    analysis.worker === "unloading"
  )
    waits.push("transcription");
  if (phone) waits.push("sync");
  if (task || capture.playback) waits.push("task");
  const idleNow =
    idle.locked || (idle.idleSeconds !== null && idle.idleSeconds >= IDLE_FOR_UPDATE_SECONDS);
  // Half awake, the Mac could sleep again with Sondine stopped.
  if (!idleNow || power.suspended) waits.push("in-use");
  return waits;
}
