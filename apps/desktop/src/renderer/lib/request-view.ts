import type { AnalysisStatus, EpisodeSummary } from "@sondine/api";
import { behindRunning, waitingForOf } from "../../shared/queue-line";

// What an episode's row says of its transcription when there is something to
// say beyond « not transcribed yet »: a request that waits, and why, or a
// failure, and what it was. A running one shows its progress where it is.

export type RequestView =
  | {
      readonly kind: "waiting";
      /** Why: the queue waits on this very episode, or on another job ahead. */
      readonly cause:
        | {
            readonly kind: "reasons";
            readonly analysis: AnalysisStatus;
            readonly episode: Pick<EpisodeSummary, "context" | "size">;
          }
        | { readonly kind: "after-running" }
        | { readonly kind: "behind" }
        | { readonly kind: "starting" };
    }
  | {
      readonly kind: "failed";
      /** The last failed attempt's code when the user asked; null otherwise. */
      readonly failure: string | null;
    };

export function requestView(
  analysis: AnalysisStatus,
  episode: Pick<EpisodeSummary, "id" | "state" | "analysisState" | "context" | "size">,
): RequestView | null {
  if (episode.state !== "closed") return null;
  if (analysis.running?.episodeId === episode.id) return null;
  const request = analysis.requests.find((entry) => entry.episodeId === episode.id);
  if (episode.analysisState === "failed" && request?.state !== "queued") {
    return { kind: "failed", failure: request?.state === "failed" ? request.failure : null };
  }
  if (request?.state !== "queued") return null;
  // A server's job and a dictation's wait for their own reasons (ADR 040).
  const held = waitingForOf(analysis, episode).length > 0;
  if (held && analysis.waitingEpisodeId === episode.id) {
    return { kind: "waiting", cause: { kind: "reasons", analysis, episode } };
  }
  if (behindRunning(analysis, episode)) {
    return { kind: "waiting", cause: { kind: "after-running" } };
  }
  if (held) return { kind: "waiting", cause: { kind: "behind" } };
  return { kind: "waiting", cause: { kind: "starting" } };
}
