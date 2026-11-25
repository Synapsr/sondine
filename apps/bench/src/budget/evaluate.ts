import type { Stats } from "../meter/meter-schema.ts";
import type { SondineAssertion } from "./assertions.ts";
import {
  capRows,
  MIB,
  scenarioProfiles,
  sleepAssertionScenarios,
  totalCaps,
  type CapBasis,
  type CapRow,
} from "./caps.ts";
import { rolesOutsideTotal } from "./discovery.ts";
import {
  groupIdSchema,
  type Check,
  type CheckMetric,
  type GroupId,
  type ResultGroup,
  type ResultProcess,
  type Verdict,
} from "./result-schema.ts";
import { BASELINE_SCENARIO, type ScenarioId } from "./scenarios.ts";

export interface EvaluationInput {
  readonly scenario: ScenarioId;
  readonly measuredS: number;
  readonly processes: readonly ResultProcess[];
  readonly groups: readonly ResultGroup[];
  /** null when assertions were not polled. */
  readonly assertions: readonly SondineAssertion[] | null;
  /** The S6 run deltas are taken against; null when there is none. */
  readonly baseline: { readonly id: string; readonly groups: readonly ResultGroup[] } | null;
  /** Groups some of whose processes were not measured for the whole run. */
  readonly incompleteGroups?: ReadonlySet<GroupId>;
}

export interface Evaluation {
  readonly checks: Check[];
  readonly verdict: Verdict;
}

/** Interrupt wakeups (every timer or interrupt wake-up, package-idle ones included) when
 * rusage is readable; otherwise the idle wakeups `top` reports (coreaudiod). */
export function wakeupsPerS(stats: Stats): { value: number | null; kind: "interrupt" | "idle" } {
  if (stats.wakeups.interruptPerS !== null)
    return { value: stats.wakeups.interruptPerS, kind: "interrupt" };
  return { value: stats.wakeups.idlePerS, kind: "idle" };
}

export function footprintMiB(stats: Stats): number | null {
  return stats.footprint.maxBytes === null ? null : stats.footprint.maxBytes / MIB;
}

interface Measurement {
  readonly value: number | null;
  readonly note?: string;
  readonly status?: "not-measured" | "not-evaluated";
}

function judge(
  base: Omit<Check, "value" | "status" | "note" | "coverage"> & { coverage?: Check["coverage"] },
  measurement: Measurement,
): Check {
  const { value } = measurement;
  const status =
    measurement.status ?? (value === null ? "not-measured" : value <= base.limit ? "pass" : "fail");
  return {
    ...base,
    coverage: base.coverage ?? "full",
    value: status === "not-measured" ? null : value,
    status,
    note: measurement.note ?? null,
  };
}

function group(groups: readonly ResultGroup[], id: GroupId): ResultGroup | undefined {
  return groups.find((candidate) => candidate.id === id && candidate.pids.length > 0);
}

export function evaluateBudget(input: EvaluationInput): Evaluation {
  const checks: Check[] = [];
  const profile = scenarioProfiles[input.scenario];
  const isBaseline = input.scenario === BASELINE_SCENARIO;

  for (const row of capRows) {
    const current = group(input.groups, row.group);
    const missing: Measurement = {
      value: null,
      note: `no ${row.label.replace(/ delta$/, "")} process was measured`,
    };

    if (row.footprintMiB !== null) {
      checks.push(
        judge(
          {
            id: `${row.group}.footprint-max`,
            subject: row.group,
            metric: "footprint-max",
            unit: "MiB",
            limit: row.footprintMiB,
            basis: "spec",
          },
          current === undefined ? missing : { value: footprintMiB(current.stats) },
        ),
      );
    }
    if (profile === null || (row.delta && isBaseline)) continue;
    if (row.cpuMeanPercent !== null) {
      checks.push(
        rateCheck(
          row,
          "cpu",
          row.cpuMeanPercent[profile.profile],
          profile.basis,
          current,
          input.baseline,
          missing,
        ),
      );
    }
    if (row.wakeupsPerS !== null) {
      checks.push(
        rateCheck(
          row,
          "wakeups",
          row.wakeupsPerS[profile.profile],
          profile.basis,
          current,
          input.baseline,
          missing,
        ),
      );
    }
  }

  const total = group(input.groups, "sondine-total");
  checks.push(
    judge(
      {
        id: "sondine-total.footprint-max",
        subject: "sondine-total",
        metric: "footprint-max",
        unit: "MiB",
        limit: totalCaps.footprintMiB,
        basis: "spec",
      },
      total === undefined
        ? { value: null, note: "no Sondine process was measured" }
        : { value: footprintMiB(total.stats) },
    ),
  );

  if (profile !== null && !isBaseline) {
    const limit = totalCaps.powerDeltaMilliwatts[profile.profile];
    const baselineTotal =
      input.baseline === null ? undefined : group(input.baseline.groups, "sondine-total");
    const coverageNote =
      "CPU energy of Sondine's processes (ri_energy_nj) only; coreaudiod and device power need root";
    const now = total?.stats.energy.milliwatts ?? null;
    const before = baselineTotal?.stats.energy.milliwatts ?? null;
    let measurement: Measurement;
    if (now === null) {
      measurement = { value: null, note: "no energy reading for Sondine's processes" };
    } else if (before === null) {
      measurement = {
        value: now,
        status: "not-evaluated",
        note: `no ${BASELINE_SCENARIO} baseline; absolute value shown`,
      };
    } else {
      // A partial reading cannot show the system delta is under its cap: shown, not judged.
      measurement = { value: now - before, status: "not-evaluated", note: coverageNote };
    }
    checks.push(
      judge(
        {
          id: "sondine-total.power-delta",
          subject: "sondine-total",
          metric: "power-delta",
          unit: "mW",
          limit,
          basis: profile.basis,
          coverage: "partial",
        },
        measurement,
      ),
    );
  }

  const slopeLimit = totalCaps.footprintSlopeMiBPerHour;
  if (input.measuredS >= totalCaps.slopeMinimumMeasuredS) {
    for (const process of input.processes) {
      if (rolesOutsideTotal.has(process.role)) continue;
      checks.push(
        judge(
          {
            id: `pid:${process.pid}.footprint-slope`,
            subject: `pid:${process.pid}`,
            metric: "footprint-slope",
            unit: "MiB/h",
            limit: slopeLimit,
            basis: "spec",
          },
          {
            value: process.stats.footprint.slopeMiBPerHour,
            note: `${process.role} (${process.name})`,
          },
        ),
      );
    }
  } else {
    checks.push(
      judge(
        {
          id: "sondine-total.footprint-slope",
          subject: "sondine-total",
          metric: "footprint-slope",
          unit: "MiB/h",
          limit: slopeLimit,
          basis: "spec",
        },
        {
          value: total?.stats.footprint.slopeMiBPerHour ?? null,
          status: "not-evaluated",
          note: `per-process slope needs at least ${totalCaps.slopeMinimumMeasuredS / 3600} h of samples (the cap is stated over 8 h)`,
        },
      ),
    );
  }

  checks.push(
    judge(
      {
        id: "sondine-audio.ring-overflows",
        subject: "sondine-audio",
        metric: "ring-overflows",
        unit: "count",
        limit: totalCaps.ringOverflows,
        basis: "spec",
      },
      {
        value: null,
        note: "not visible to sondine-meter: read sondine-audio's health events or ring-overflow gap records in the spool manifests",
      },
    ),
  );

  const assertionBasis = sleepAssertionScenarios[input.scenario];
  if (assertionBasis !== undefined) {
    const names = input.assertions?.map(
      (assertion) =>
        `${assertion.ownerName}(${assertion.ownerPid}) ${assertion.type} "${assertion.name}"`,
    );
    checks.push(
      judge(
        {
          id: "sondine-total.sleep-assertions",
          subject: "sondine-total",
          metric: "sleep-assertions",
          unit: "count",
          limit: 0,
          basis: assertionBasis,
        },
        input.assertions === null
          ? { value: null, note: "pmset -g assertions was not polled" }
          : {
              value: input.assertions.length,
              ...(names !== undefined && names.length > 0 ? { note: names.join("; ") } : {}),
            },
      ),
    );
  }

  const incomplete = input.incompleteGroups ?? new Set<GroupId>();
  const judged = checks.map((check): Check => {
    const subject = groupIdSchema.safeParse(check.subject);
    if (!subject.success || !incomplete.has(subject.data) || check.status === "not-measured")
      return check;
    const gap = `not every ${subject.data} process was measured for the whole run`;
    return {
      ...check,
      status: "not-evaluated",
      coverage: "partial",
      note: check.note === null ? gap : `${gap}; ${check.note}`,
    };
  });
  return { checks: judged, verdict: verdictOf(judged) };
}

/** Architecture §5: "Energy and wakeups are the gate; CPU time is diagnostic". */
export const diagnosticMetrics: ReadonlySet<CheckMetric> = new Set(["cpu-mean", "cpu-mean-delta"]);

function rateCheck(
  row: CapRow,
  kind: "cpu" | "wakeups",
  limit: number,
  basis: CapBasis,
  current: ResultGroup | undefined,
  baseline: EvaluationInput["baseline"],
  missing: Measurement,
): Check {
  const metric: CheckMetric = row.delta
    ? kind === "cpu"
      ? "cpu-mean-delta"
      : "wakeups-mean-delta"
    : kind === "cpu"
      ? "cpu-mean"
      : "wakeups-mean";
  const base = {
    id: `${row.group}.${metric}`,
    subject: row.group,
    metric,
    unit: kind === "cpu" ? "%" : "/s",
    limit,
    basis,
  } as const;
  if (current === undefined) return judge(base, missing);
  const read = (stats: Stats) =>
    kind === "cpu" ? { value: stats.cpu.meanPercent, kind: null } : wakeupsPerS(stats);
  const now = read(current.stats);
  const kindNote =
    now.kind === "idle"
      ? "package-idle wakeups (top); interrupt wakeups are not readable"
      : undefined;
  if (!row.delta)
    return judge(base, { value: now.value, ...(kindNote === undefined ? {} : { note: kindNote }) });

  const before = baseline === null ? undefined : group(baseline.groups, row.group);
  if (before === undefined || now.value === null) {
    return judge(base, {
      value: now.value,
      status: now.value === null ? "not-measured" : "not-evaluated",
      note: `no ${BASELINE_SCENARIO} baseline with ${row.group}; absolute value shown`,
    });
  }
  const then = read(before.stats);
  if (then.value === null || then.kind !== now.kind) {
    return judge(base, {
      value: now.value,
      status: "not-evaluated",
      note: `baseline ${baseline?.id ?? ""} has no comparable reading`,
    });
  }
  const delta = now.value - then.value;
  return judge(base, {
    value: delta,
    note: [`against ${baseline?.id ?? ""}`, kindNote].filter(Boolean).join("; "),
  });
}

/** Counts gating checks only: diagnostic ones are recorded but never decide the verdict. */
export function verdictOf(checks: readonly Check[]): Verdict {
  const gating = checks.filter((check) => !diagnosticMetrics.has(check.metric));
  const count = (status: Check["status"]) =>
    gating.filter((check) => check.status === status).length;
  const verdict = {
    pass: count("pass"),
    fail: count("fail"),
    notMeasured: count("not-measured"),
    notEvaluated: count("not-evaluated"),
  };
  const status =
    verdict.fail > 0
      ? "fail"
      : verdict.notMeasured + verdict.notEvaluated > 0
        ? "incomplete"
        : "pass";
  return { status, ...verdict };
}
