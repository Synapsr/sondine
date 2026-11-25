import type { AnalysisStatus } from "@sondine/api";
import { CircleCheckIcon, CircleXIcon } from "@sondine/ui/icon";
import { Switch } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { formatBytes } from "../../lib/bytes";
import { formatDuration } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import {
  checkRows,
  checkSummary,
  type AdjustableKey,
  type CheckDetail,
  type CheckKey,
  type CheckSummary,
} from "./analysis-check-view";
import { retryTimeText } from "../../../shared/queue-line";
import { TRACE_BATCH } from "../../../shared/traces";
import { MemoryBar } from "./memory-bar";

// Why transcription has not started: each condition the next job waits
// for, met or not, read from the Mac every few seconds while shown, with a
// switch to stop waiting for power, idle or calm memory; under memory
// pressure, the apps holding the memory (memory-bar.tsx).
// Opened from the queue line at the bottom of the sidebar, and on the status
// screen.

const CHECK_INTERVAL_MS = 3_000;

const conditionText: Record<CheckKey, (idleMs: number) => string> = {
  model: () => m.analysis_check_model(),
  server: () => m.analysis_check_server(),
  power: () => m.analysis_check_power(),
  idle: (idleMs) => m.analysis_check_idle({ duration: formatDuration(idleMs) }),
  heat: () => m.analysis_check_heat(),
  memory: () => m.analysis_check_memory(),
};

function detailText(detail: CheckDetail): string {
  switch (detail.kind) {
    case "no-model":
      return m.analysis_check_no_model();
    case "server-offline":
      return m.queue_reason_server_offline();
    case "server-busy":
      return m.queue_reason_server_busy();
    case "server-refused":
      return m.queue_reason_server_refused();
    case "server-quota":
      return m.queue_reason_server_quota();
    case "on-battery":
      return m.analysis_check_on_battery();
    case "locked":
      return m.analysis_check_locked();
    case "used":
      return m.analysis_check_used({ duration: formatDuration(detail.seconds * 1000) });
    case "idle":
      return m.analysis_check_idle_for({ duration: formatDuration(detail.seconds * 1000) });
    case "hot":
      return m.analysis_check_hot();
    case "pressure":
      return detail.pressure === "critical"
        ? m.analysis_check_pressure_critical()
        : m.analysis_check_pressure_warn();
    case "room":
      return m.analysis_check_room({
        room: formatBytes(detail.roomBytes, getLocale()),
        needed: formatBytes(detail.neededBytes, getLocale()),
      });
    case "swap":
      return m.analysis_check_swap();
    case "waived":
      return m.analysis_check_waived();
    case "unknown":
      return m.analysis_check_unknown();
  }
}

/** When traces are transcribed. */
export function tracesText(analysis: AnalysisStatus): string {
  return analysis.server === null
    ? m.analysis_queue_traces()
    : m.analysis_queue_traces_server({ count: String(TRACE_BATCH) });
}

const summaryText: Record<NonNullable<CheckSummary>, (analysis: AnalysisStatus) => string> = {
  running: () => m.analysis_check_running(),
  "retry-later": ({ retryAtMs }) =>
    retryAtMs === null
      ? m.analysis_check_retry()
      : m.analysis_check_retry_at({ time: retryTimeText(retryAtMs) }),
  "nothing-queued": () => m.analysis_check_nothing(),
  traces: tracesText,
  ready: () => m.analysis_check_ready(),
  "request-now": () => m.analysis_check_request(),
};

const adjustable = (key: CheckKey): key is AdjustableKey =>
  key === "power" || key === "idle" || key === "memory";

export function AnalysisChecks({ analysis }: { analysis: AnalysisStatus }) {
  const queryClient = useQueryClient();
  const check = useQuery({
    ...orpc.analysis.check.queryOptions(),
    refetchInterval: CHECK_INTERVAL_MS,
  });
  // A condition turned off applies at once: the queue looks again, and so does the list.
  const setWaitFor = useMutation(
    orpc.analysis.setWaitFor.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(orpc.analysis.check.queryKey(), next),
    }),
  );
  if (check.data === undefined) {
    return (
      <p className="text-body-xs text-cte-text-muted">
        {check.isError ? errorMessage(check.error) : m.analysis_check_reading()}
      </p>
    );
  }
  const rows = checkRows(check.data);
  const summary = checkSummary(analysis, check.data, rows);
  const idleMs = check.data.idleRequiredSeconds * 1000;
  return (
    <div className="flex flex-col gap-xs">
      <p>{check.data.requested ? m.analysis_check_lead_requested() : m.analysis_check_lead()}</p>
      <ul className="flex flex-col gap-xs">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-xs">
            {row.ok ? (
              <CircleCheckIcon aria-hidden className="mt-xxs shrink-0 text-success" />
            ) : (
              <CircleXIcon aria-hidden className="mt-xxs shrink-0 text-cte-text-muted" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span>
                {conditionText[row.key](idleMs)}
                <span className="sr-only">
                  {", "}
                  {row.ok ? m.analysis_check_met() : m.analysis_check_unmet()}
                </span>
              </span>
              {row.detail === null ? null : (
                <span className="text-body-xs text-cte-text-muted">{detailText(row.detail)}</span>
              )}
              {row.detail?.kind === "pressure" && row.detail.use !== null ? (
                <MemoryBar use={row.detail.use} />
              ) : null}
            </span>
            {row.waitedFor === null || !adjustable(row.key) ? null : (
              <Switch
                className="mt-xxs shrink-0 [--switch-size:var(--space-m)]"
                checked={row.waitedFor}
                disabled={setWaitFor.isPending}
                aria-label={m.analysis_check_wait_for({
                  condition: conditionText[row.key](idleMs),
                })}
                onCheckedChange={(checked) =>
                  adjustable(row.key) && setWaitFor.mutate({ condition: row.key, wait: checked })
                }
              />
            )}
          </li>
        ))}
      </ul>
      {summary === null ? null : (
        <p className="text-cte-text-muted">{summaryText[summary](analysis)}</p>
      )}
      {setWaitFor.error === null ? null : (
        <p role="alert" className="text-body-xs text-error">
          {errorMessage(setWaitFor.error)}
        </p>
      )}
    </div>
  );
}
