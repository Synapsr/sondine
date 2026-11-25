import type { AnalysisStatus, AnalysisWaitReason, EpisodeSummary } from "@sondine/api";
import { m } from "../renderer/paraglide/messages.js";
import { getLocale } from "../renderer/paraglide/runtime.js";
import { pauseEndLabel } from "./timed-pause";
import { TRACE_BATCH } from "./traces";

// The transcription queue in one line, at the bottom of the sidebar and in
// the menu bar: what runs, how many episodes wait, and the main reason they
// wait. Traces are left out of the count: they are transcribed only while the
// model is already loaded for something else, so they never wait for the Mac.

export type QueueReason = AnalysisWaitReason | "power-and-idle";

export type QueueLine =
  | { readonly kind: "running"; readonly waiting: number; readonly progress: number | null }
  | {
      readonly kind: "waiting";
      readonly waiting: number;
      readonly reason: QueueReason | null;
      /** Only dictations wait, on this Mac: a compute server takes the rest (ADR 040). */
      readonly dictations: boolean;
      /** When the next attempt may start, while it waits for one. */
      readonly retryAtMs: number | null;
    }
  | { readonly kind: "empty" };

export function queueLine(analysis: AnalysisStatus): QueueLine {
  const { requested, conversations, moments, media } = analysis.queued;
  const waiting = requested + conversations + moments + media;
  if (analysis.running !== null)
    return { kind: "running", waiting, progress: analysis.running.progress };
  if (waiting === 0) return { kind: "empty" };
  return {
    kind: "waiting",
    waiting,
    reason: mainReason(analysis.waitingFor),
    dictations: analysis.server !== null && analysis.server.waitingFor.length === 0,
    retryAtMs: analysis.retryAtMs,
  };
}

function mainReason(reasons: readonly AnalysisWaitReason[]): QueueReason | null {
  // Without a model nothing else matters.
  if (reasons.includes("no-model")) return "no-model";
  if (reasons.includes("on-battery") && reasons.includes("not-idle")) return "power-and-idle";
  return reasons[0] ?? null;
}

type MessageOptions = { readonly locale: "en" | "fr" } | undefined;

/** When the next attempt may start: the time, with the weekday on another day. */
export function retryTimeText(retryAtMs: number, locale?: "en" | "fr"): string {
  return pauseEndLabel(retryAtMs, Date.now(), locale ?? getLocale());
}

const reasonText: Record<
  QueueReason,
  (options: MessageOptions, retryAtMs: number | null) => string
> = {
  "no-model": (options) => m.queue_reason_no_model({}, options),
  "power-and-idle": (options) => m.queue_reason_power_and_idle({}, options),
  "on-battery": (options) => m.queue_reason_on_battery({}, options),
  "not-idle": (options) => m.queue_reason_not_idle({}, options),
  thermal: (options) => m.queue_reason_thermal({}, options),
  memory: (options) => m.queue_reason_memory({}, options),
  swap: (options) => m.queue_reason_swap({}, options),
  "retry-later": (options, retryAtMs) =>
    retryAtMs === null
      ? m.queue_reason_retry_later({}, options)
      : m.queue_reason_retry_at({ time: retryTimeText(retryAtMs, options?.locale) }, options),
  "server-offline": (options) => m.queue_reason_server_offline({}, options),
  "server-busy": (options) => m.queue_reason_server_busy({}, options),
  "server-refused": (options) => m.queue_reason_server_refused({}, options),
  "server-quota": (options) => m.queue_reason_server_quota({}, options),
};

type Waiting = Pick<EpisodeSummary, "context" | "size">;

const isDictation = (episode: Waiting) => episode.context === "dictation";

/**
 * What holds an episode's transcription back: a compute server's jobs and the
 * dictations, which stay on this Mac, do not wait for the same things.
 */
export function waitingForOf(
  analysis: AnalysisStatus,
  episode: Waiting,
): readonly AnalysisWaitReason[] {
  if (analysis.server === null) return analysis.waitingFor;
  return isDictation(episode) ? analysis.server.dictationsWaitingFor : analysis.server.waitingFor;
}

/** Another transcription runs, and this one waits its turn: a server's holds no dictation back. */
export function behindRunning(analysis: AnalysisStatus, episode: Waiting): boolean {
  return analysis.running !== null && !(analysis.server !== null && isDictation(episode));
}

/** Why an episode waits, in words; null when nothing says so. */
export function waitReasonText(
  analysis: AnalysisStatus,
  episode: Waiting,
  locale?: "en" | "fr",
): string | null {
  const options: MessageOptions = locale === undefined ? undefined : { locale };
  const reason = mainReason(waitingForOf(analysis, episode));
  const text = reason === null ? null : reasonText[reason](options, analysis.retryAtMs);
  if (analysis.server === null) return text;
  if (isDictation(episode)) {
    return text === null
      ? m.queue_reason_dictation_next({}, options)
      : m.queue_reason_dictations({ reason: text }, options);
  }
  if (text !== null) return text;
  return episode.size === "trace"
    ? m.queue_reason_server_trace({ count: String(TRACE_BATCH) }, options)
    : m.queue_reason_server_next({}, options);
}

/** The line's words; main passes its own `locale`, the window uses its language. */
export function queueLineText(line: QueueLine, locale?: "en" | "fr"): string {
  const options: MessageOptions = locale === undefined ? undefined : { locale };
  switch (line.kind) {
    case "empty":
      return m.queue_empty({}, options);
    case "waiting": {
      const count = String(line.waiting);
      if (line.reason === null) return m.queue_waiting({ count }, options);
      const reason = reasonText[line.reason](options, line.retryAtMs);
      return m.queue_waiting_because(
        {
          count,
          reason: line.dictations ? m.queue_reason_dictations({ reason }, options) : reason,
        },
        options,
      );
    }
    case "running":
      return line.waiting === 0
        ? m.queue_running({}, options)
        : m.queue_running_waiting({ count: String(line.waiting) }, options);
  }
}
