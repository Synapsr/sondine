import type { AnalysisStatus, AnalysisWorkerState } from "@sondine/api";
import { Badge, type BadgeProps } from "@sondine/ui/components/badge";
import { Progress, ProgressLabel, ProgressValue } from "@sondine/ui/components/progress";
import { m } from "../../paraglide/messages.js";
import { AnalysisChecks, tracesText } from "./analysis-checks";
import { Section } from "./section";

// Transcription on the status screen: what the analysis queue does, and each
// condition it waits for (the sidebar sums it up in one line).

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const workerBadge: Record<AnalysisWorkerState, { variant: BadgeVariant; label: () => string }> = {
  absent: { variant: "neutral", label: () => m.analysis_worker_absent() },
  loading: { variant: "warning", label: () => m.analysis_worker_loading() },
  ready: { variant: "success", label: () => m.analysis_worker_ready() },
  busy: { variant: "success", label: () => m.analysis_worker_busy() },
  unloading: { variant: "neutral", label: () => m.analysis_worker_unloading() },
};

export function AnalysisSection({ analysis }: { analysis: AnalysisStatus }) {
  const badge = workerBadge[analysis.worker];
  const { requested, conversations, moments, media, traces } = analysis.queued;
  const waiting = requested + conversations + moments + media + traces;
  return (
    <Section title={m.analysis_heading()}>
      <div className="flex flex-wrap items-center gap-s">
        <Badge variant={badge.variant}>{badge.label()}</Badge>
        <span className="text-cte-text-muted">
          {waiting === 0
            ? m.analysis_queue_empty()
            : m.analysis_queue({
                list: [
                  requested === 0 ? null : m.analysis_queue_requested({ count: requested }),
                  conversations === 0
                    ? null
                    : m.analysis_queue_conversations({ count: conversations }),
                  moments === 0 ? null : m.analysis_queue_moments({ count: moments }),
                  media === 0 ? null : m.analysis_queue_media({ count: media }),
                  traces === 0 ? null : m.analysis_queue_traces_count({ count: traces }),
                ]
                  .filter((part) => part !== null)
                  .join(", "),
              })}
        </span>
      </div>
      {traces === 0 ? null : <p className="text-cte-text-muted">{tracesText(analysis)}</p>}
      {analysis.running === null ? null : (
        <Progress
          value={
            analysis.running.progress === null ? null : Math.round(analysis.running.progress * 100)
          }
          className="w-full max-w-[24rem]"
        >
          <ProgressLabel>{m.analysis_running()}</ProgressLabel>
          <ProgressValue>
            {(formatted, value) => (value === null ? m.analysis_running_starting() : formatted)}
          </ProgressValue>
        </Progress>
      )}
      <AnalysisChecks analysis={analysis} />
      {analysis.lastError === null ? null : (
        <p className="font-data text-body-xs text-cte-text-muted">
          {m.analysis_last_error({ code: analysis.lastError.code })}
        </p>
      )}
    </Section>
  );
}
