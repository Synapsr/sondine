import type { Stats } from "../meter/meter-schema.ts";
import { regressionThresholds } from "./caps.ts";
import { diagnosticMetrics, footprintMiB, wakeupsPerS } from "./evaluate.ts";
import { sameConditions } from "./host.ts";
import type { BudgetResult, Check, GroupId } from "./result-schema.ts";
import { GROUP_IDS } from "./result-schema.ts";

/** Left-aligned first column, right-aligned numbers, two spaces between columns. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatNumber(value: number | null, digits = 2): string {
  if (value === null) return "—";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(digits);
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.round(seconds % 60);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes > 0) return `${minutes} min ${String(rest).padStart(2, "0")} s`;
  return `${rest} s`;
}

const statusLabels: Readonly<Record<Check["status"], string>> = {
  pass: "pass",
  fail: "FAIL",
  "not-measured": "not measured",
  "not-evaluated": "not evaluated",
};

interface MetricColumn {
  readonly title: string;
  readonly read: (stats: Stats) => number | null;
  readonly digits: number;
  readonly threshold: number | null;
}

const metricColumns: readonly MetricColumn[] = [
  {
    title: "footprint MiB",
    read: footprintMiB,
    digits: 1,
    threshold: regressionThresholds.footprint,
  },
  {
    title: "CPU mean %",
    read: (stats) => stats.cpu.meanPercent,
    digits: 3,
    threshold: regressionThresholds.cpu,
  },
  { title: "CPU p95 %", read: (stats) => stats.cpu.p95Percent, digits: 3, threshold: null },
  {
    title: "wakeups/s",
    read: (stats) => wakeupsPerS(stats).value,
    digits: 1,
    threshold: regressionThresholds.wakeups,
  },
  {
    title: "energy mW",
    read: (stats) => stats.energy.milliwatts,
    digits: 2,
    threshold: regressionThresholds.energy,
  },
];

function groupStats(result: BudgetResult, id: GroupId): Stats | null {
  return result.groups.find((group) => group.id === id)?.stats ?? null;
}

function header(result: BudgetResult): string {
  const power = result.host.power.start;
  const powerText =
    power.source === "battery" && power.batteryPercent !== null
      ? `battery ${power.batteryPercent} %`
      : power.source;
  return (
    `${result.id}\n` +
    `  ${result.scenario.id} ${result.scenario.title} · label "${result.label}" · ${formatDuration(result.measuredS)} measured` +
    `${result.interrupted ? " (interrupted)" : ""}\n` +
    `  ${result.host.chip} · macOS ${result.host.os.productVersion} (${result.host.os.buildVersion}) · ${powerText}`
  );
}

export function formatResult(result: BudgetResult): string {
  const groupRows = GROUP_IDS.flatMap((id) => {
    const stats = groupStats(result, id);
    return stats === null
      ? []
      : [[id, ...metricColumns.map((column) => formatNumber(column.read(stats), column.digits))]];
  });
  const checkRows = result.checks.map((check) => [
    check.id,
    formatNumber(check.value, 3),
    `≤ ${formatNumber(check.limit, 3)} ${check.unit}`,
    diagnosticMetrics.has(check.metric)
      ? `${statusLabels[check.status]} (diagnostic)`
      : statusLabels[check.status],
    check.basis === "inferred" ? "inferred" : "",
    check.coverage === "partial" ? "partial" : "",
  ]);
  const notes = result.checks.flatMap((check) =>
    check.note === null ? [] : [`  ${check.id}: ${check.note}`],
  );
  const { verdict } = result;
  const lines = [
    header(result),
    "",
    table([["group", ...metricColumns.map((column) => column.title)], ...groupRows]),
    "",
    table([["check", "value", "cap", "status", "basis", "coverage"], ...checkRows]),
    "",
    `verdict: ${verdict.status} (${verdict.pass} pass, ${verdict.fail} fail, ${verdict.notMeasured} not measured, ${verdict.notEvaluated} not evaluated)`,
  ];
  if (notes.length > 0) lines.push("", "notes:", ...notes);
  if (result.warnings.length > 0)
    lines.push("", "warnings:", ...result.warnings.map((warning) => `  ${warning}`));
  return lines.join("\n");
}

function change(
  before: number | null,
  after: number | null,
): { delta: number | null; ratio: number | null } {
  if (before === null || after === null) return { delta: null, ratio: null };
  return {
    delta: after - before,
    ratio: before === 0 ? null : (after - before) / Math.abs(before),
  };
}

function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  const percent = ratio * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)} %`;
}

function statusOf(result: BudgetResult, id: string): string {
  const check = result.checks.find((candidate) => candidate.id === id);
  return check === undefined ? "—" : statusLabels[check.status];
}

export interface Comparison {
  readonly text: string;
  readonly regressions: readonly string[];
}

/** a → b, with architecture §13 regression flags (footprint +5 %, CPU, wakeups and energy +10 %). */
export function compareResults(a: BudgetResult, b: BudgetResult): Comparison {
  const regressions: string[] = [];
  const rows: string[][] = [["group", "metric", "a", "b", "Δ", "Δ %", ""]];
  for (const id of GROUP_IDS) {
    const before = groupStats(a, id);
    const after = groupStats(b, id);
    if (before === null && after === null) continue;
    for (const column of metricColumns) {
      const x = before === null ? null : column.read(before);
      const y = after === null ? null : column.read(after);
      if (x === null && y === null) continue;
      const { delta, ratio } = change(x, y);
      const regressed = column.threshold !== null && ratio !== null && ratio > column.threshold;
      if (regressed) regressions.push(`${id} ${column.title} ${formatRatio(ratio)}`);
      rows.push([
        id,
        column.title,
        formatNumber(x, column.digits),
        formatNumber(y, column.digits),
        delta === null ? "—" : `${delta >= 0 ? "+" : ""}${formatNumber(delta, column.digits)}`,
        formatRatio(ratio),
        regressed ? `regression (> +${(column.threshold ?? 0) * 100} %)` : "",
      ]);
    }
  }

  const checkIds = [
    ...new Set([...a.checks.map((check) => check.id), ...b.checks.map((check) => check.id)]),
  ];
  const checkRows = checkIds.map((id) => [id, statusOf(a, id), statusOf(b, id)]);

  const warnings: string[] = [];
  if (a.scenario.id !== b.scenario.id)
    warnings.push(`different scenarios: ${a.scenario.id} vs ${b.scenario.id}`);
  if (!sameConditions(a.host, b.host))
    warnings.push("different chip, macOS build or power source: deltas mix machine conditions");
  if (a.harness.capsVersion !== b.harness.capsVersion)
    warnings.push(`different caps: ${a.harness.capsVersion} vs ${b.harness.capsVersion}`);

  const lines = [
    `a: ${header(a)}`,
    `b: ${header(b)}`,
    "",
    table(rows),
    "",
    table([["check", "a", "b"], ...checkRows]),
    "",
    `verdict: a ${a.verdict.status}, b ${b.verdict.status}`,
  ];
  if (regressions.length > 0)
    lines.push("", "regressions:", ...regressions.map((line) => `  ${line}`));
  if (warnings.length > 0) lines.push("", "warnings:", ...warnings.map((line) => `  ${line}`));
  return { text: lines.join("\n"), regressions };
}
