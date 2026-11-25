import { MIB } from "../src/budget/caps.ts";
import type { ProcessRole } from "../src/budget/discovery.ts";
import type { Host } from "../src/budget/host.ts";
import type {
  BudgetResult,
  GroupId,
  ResultGroup,
  ResultProcess,
} from "../src/budget/result-schema.ts";
import { statsSchema, type Stats } from "../src/meter/meter-schema.ts";

export interface StatsInput {
  readonly footprintMiB?: number;
  readonly cpuPercent?: number;
  readonly interruptPerS?: number;
  readonly idlePerS?: number;
  readonly milliwatts?: number;
  readonly slopeMiBPerHour?: number;
}

/** Meter statistics with only the fields a test cares about; the rest stay null. */
export function stats(input: StatsInput = {}): Stats {
  return statsSchema.parse({
    samples: 60,
    coveredS: 60,
    cpu: { meanPercent: input.cpuPercent ?? null },
    wakeups: { interruptPerS: input.interruptPerS ?? null, idlePerS: input.idlePerS ?? null },
    footprint: {
      maxBytes: input.footprintMiB === undefined ? null : input.footprintMiB * MIB,
      slopeMiBPerHour: input.slopeMiBPerHour ?? null,
    },
    energy: { milliwatts: input.milliwatts ?? null },
    disk: {},
  });
}

export function group(id: GroupId, pids: number[], input: StatsInput): ResultGroup {
  return { id, pids, stats: stats(input) };
}

export function processOf(pid: number, role: ProcessRole, input: StatsInput = {}): ResultProcess {
  return {
    pid,
    startUs: 1,
    role,
    name: role,
    path: null,
    access: "rusage",
    exited: false,
    stats: stats(input),
  };
}

/** A Sondine install inside every cap of the S0 column. */
export function healthyGroups(): ResultGroup[] {
  return [
    group("sondine-audio", [101], {
      footprintMiB: 30,
      cpuPercent: 0.2,
      interruptPerS: 20,
      milliwatts: 4,
    }),
    group("coreaudiod", [50], { cpuPercent: 0.5, interruptPerS: 40 }),
    group("electron-main", [100], {
      footprintMiB: 80,
      cpuPercent: 0.05,
      interruptPerS: 0.5,
      milliwatts: 1,
    }),
    group("chromium-services", [102, 103], { footprintMiB: 60, interruptPerS: 0.5 }),
    group("core", [104], { footprintMiB: 90, cpuPercent: 0.05, interruptPerS: 1, milliwatts: 1 }),
    group("sondine-total", [100, 101, 102, 103, 104], {
      footprintMiB: 260,
      cpuPercent: 0.3,
      milliwatts: 6,
    }),
  ];
}

export const host: Host = {
  chip: "Apple M5",
  model: "Mac17,2",
  cores: { logical: 10, physical: 10, performance: 4, efficiency: 6 },
  memoryBytes: 32 * 1024 * MIB,
  os: { productVersion: "27.0.1", buildVersion: "26A434" },
  lowPowerMode: false,
  power: {
    start: { source: "ac", batteryPercent: 100, raw: "Now drawing from 'AC Power'" },
    end: { source: "ac", batteryPercent: 100, raw: "Now drawing from 'AC Power'" },
  },
  thermal: {
    start: { warningLevel: null, performanceWarningLevel: null, cpuSpeedLimit: null, raw: "" },
    end: { warningLevel: null, performanceWarningLevel: null, cpuSpeedLimit: null, raw: "" },
  },
};

export function result(overrides: Partial<BudgetResult> = {}): BudgetResult {
  return {
    schema: "sondine.budget-result",
    schemaVersion: 1,
    id: "20261103T100000Z-S0-test",
    label: "test",
    scenario: { id: "S0", title: "Silence, mic only" },
    startedAt: "2026-11-03T10:00:00.000Z",
    endedAt: "2026-11-03T10:30:00.000Z",
    requestedDurationS: 1800,
    settleS: 60,
    measuredS: 1800,
    sleptS: 0,
    interrupted: false,
    harness: {
      version: "0.1.0",
      capsVersion: "architecture-5-draft-2",
      git: { commit: null, dirty: null },
      meter: {
        path: "/x/sondine-meter",
        version: "1",
        intervalMs: 1000,
        privilegedIntervalS: 60,
        overhead: null,
      },
      argv: ["budget", "run", "--scenario", "S0"],
    },
    host,
    processes: [processOf(101, "audio-helper", { footprintMiB: 30 })],
    groups: healthyGroups(),
    assertions: { polls: 60, intervalS: 30, sondine: [] },
    baseline: null,
    checks: [],
    verdict: { status: "pass", pass: 0, fail: 0, notMeasured: 0, notEvaluated: 0 },
    warnings: [],
    files: { samples: "x.samples.jsonl", summary: "x.summary.json" },
    ...overrides,
  };
}
