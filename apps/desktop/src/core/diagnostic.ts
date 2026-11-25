import type { ModelsStatus, Status } from "@sondine/api";
import type { FailureCount, JobCounts } from "@sondine/db";
import { usageError } from "@sondine/protocol";

// « Envoyer un diagnostic » (ADR 042): the text the user reads whole, then
// mails or copies, or not. A closed list: versions, the Mac, permissions,
// models, queues and failures by code. Never a message, a path, a name, a
// log line or a span attribute; every string below is an enum, a catalog id
// or a version that fits its pattern. In English: developers read it.

/** Failures this recent are counted. */
export const DIAGNOSTIC_DAYS = 7;

export interface DiagnosticFacts {
  readonly status: Status;
  readonly models: ModelsStatus;
  readonly queue: JobCounts;
  readonly failures: readonly FailureCount[];
  readonly appVersion: string;
  readonly macosVersion: string;
  /** The processor as macOS names it, `Apple M5`. */
  readonly processor: string;
}

const only = (pattern: RegExp, value: string | null) =>
  value !== null && pattern.test(value) ? value : "unknown";
const VERSION = /^\d{1,3}(?:\.\d{1,4}){1,3}(?:-[a-z0-9]{1,12})?$/u;
const CODE = /^[a-z0-9_.-]{1,48}$/u;

export function diagnosticText(facts: DiagnosticFacts): string {
  const { status, models, queue } = facts;
  const { helper, permissions, analysis } = status;
  const failures = new Map<string, number>();
  for (const { area, code, times } of facts.failures) {
    const name = usageError(area, code);
    failures.set(name, (failures.get(name) ?? 0) + times);
  }
  const recent = [
    ...[...failures].map(([name, times]) => `${name} ${times}`),
    ...(helper.lastError === null ? [] : [`helper ${only(CODE, helper.lastError.code)}`]),
    ...new Set(status.spool.map((problem) => `spool ${problem.code}`)),
    ...(status.updates.problem === null ? [] : [`update ${status.updates.problem}`]),
  ];
  const lines = [
    `Sondine ${only(VERSION, facts.appVersion)}, helper ${only(VERSION, helper.version)}, macOS ${only(VERSION, facts.macosVersion)}`,
    `Mac: ${only(/^Apple M\d{1,2}(?: (?:Pro|Max|Ultra))?$/u, facts.processor)}, ${Math.round(models.memoryBytes / 1024 ** 3)} GB of memory`,
    `Permissions: microphone ${permissions?.microphone.status ?? "unknown"}, system audio ${permissions?.systemAudio.status ?? "unknown"}`,
    ...models.artifacts.map(
      (model) =>
        `Model ${only(CODE, model.artifactId)}: ${model.phase}${model.problem === null ? "" : `, ${model.problem.code}`}`,
    ),
    `Queue: ${queue.queued} queued, ${queue.running} running, ${queue.failed} failed; worker ${analysis.worker}, waits for ${analysis.waitingFor.join(", ") || "nothing"}`,
    `Errors in ${DIAGNOSTIC_DAYS} days: ${recent.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}
