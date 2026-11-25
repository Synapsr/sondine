import { describe, expect, it } from "vitest";
import { evaluateBudget } from "../src/budget/evaluate.ts";
import {
  budgetResultSchema,
  parseBudgetResult,
  RESULT_SCHEMA_VERSION,
} from "../src/budget/result-schema.ts";
import { resultId } from "../src/budget/run.ts";
import { meterSummarySchema } from "../src/meter/meter-schema.ts";
import { healthyGroups, result } from "./fixtures.ts";

describe("budget result schema", () => {
  it("is version 1", () => {
    expect(RESULT_SCHEMA_VERSION).toBe(1);
  });

  it("round-trips a result with evaluated checks through JSON", () => {
    const evaluation = evaluateBudget({
      scenario: "S0",
      measuredS: 1800,
      processes: [],
      groups: healthyGroups(),
      assertions: [],
      baseline: null,
    });
    const value = result({ checks: evaluation.checks, verdict: evaluation.verdict });
    expect(parseBudgetResult(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("rejects another schema version", () => {
    const parsed = budgetResultSchema.safeParse({ ...result(), schemaVersion: 2 });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown scenario, group or check status", () => {
    expect(
      budgetResultSchema.safeParse({ ...result(), scenario: { id: "S9", title: "x" } }).success,
    ).toBe(false);
    const [first] = healthyGroups();
    expect(
      budgetResultSchema.safeParse({ ...result(), groups: [{ ...first, id: "renderer" }] }).success,
    ).toBe(false);
    const evaluation = evaluateBudget({
      scenario: "S0",
      measuredS: 60,
      processes: [],
      groups: [],
      assertions: null,
      baseline: null,
    });
    const [check] = evaluation.checks;
    expect(
      budgetResultSchema.safeParse({ ...result(), checks: [{ ...check, status: "ok" }] }).success,
    ).toBe(false);
  });

  it("names the problem when a file is not a result", () => {
    expect(() => parseBudgetResult({ schema: "sondine.budget-result" })).toThrow(
      /not a sondine\.budget-result v1 file/,
    );
    const { host: _host, ...withoutHost } = result();
    expect(() => parseBudgetResult(withoutHost)).toThrow(/host/);
  });
});

describe("meter summary schema", () => {
  it("turns fields the meter omitted into nulls", () => {
    const summary = meterSummarySchema.parse({
      schema: "sondine.meter-summary",
      version: 1,
      input: {
        records: 3,
        intervalMs: 1000,
        startedAt: "2026-11-03T10:00:00Z",
        ticks: 2,
        durationS: 2,
        sleptS: 0,
      },
      windowS: 10,
      skipS: 0,
      processes: [
        {
          pid: 50,
          startUs: 1,
          name: "coreaudiod",
          access: "setuid-tools",
          exited: false,
          stats: {
            samples: 3,
            coveredS: 2,
            cpu: { meanPercent: 0.4 },
            wakeups: { idlePerS: 12 },
            footprint: {},
            energy: {},
            disk: {},
          },
        },
      ],
      groups: [],
      total: { samples: 3, coveredS: 2, cpu: {}, wakeups: {}, footprint: {}, energy: {}, disk: {} },
      warnings: [],
    });
    const [process] = summary.processes;
    expect(process?.path).toBeNull();
    expect(process?.stats.wakeups).toEqual({
      interruptPerS: null,
      interruptP95PerS: null,
      idlePerS: 12,
      idleP95PerS: null,
    });
    expect(process?.stats.energy.milliwatts).toBeNull();
    expect(summary.input.endReason).toBeNull();
  });
});

describe("resultId", () => {
  it("sorts by time and keeps a file-safe label", () => {
    expect(resultId(new Date("2026-11-03T10:04:05.678Z"), "S3", "Zoom call, AirPods!")).toBe(
      "20261103T100405Z-S3-zoom-call-airpods",
    );
    expect(resultId(new Date("2026-11-03T10:04:05.000Z"), "S6", "***")).toBe(
      "20261103T100405Z-S6-run",
    );
  });
});
