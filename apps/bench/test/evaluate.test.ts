import { describe, expect, it } from "vitest";
import { capRows, scenarioProfiles, totalCaps } from "../src/budget/caps.ts";
import { evaluateBudget, verdictOf, type EvaluationInput } from "../src/budget/evaluate.ts";
import type { Check, ResultGroup } from "../src/budget/result-schema.ts";
import { SCENARIO_IDS } from "../src/budget/scenarios.ts";
import { group, healthyGroups, processOf } from "./fixtures.ts";

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    scenario: "S0",
    measuredS: 1800,
    processes: [],
    groups: healthyGroups(),
    assertions: [],
    baseline: null,
    ...overrides,
  };
}

function check(checks: readonly Check[], id: string): Check {
  const found = checks.find((candidate) => candidate.id === id);
  if (found === undefined)
    throw new Error(`no check ${id} in ${checks.map((candidate) => candidate.id).join(", ")}`);
  return found;
}

function replace(groups: ResultGroup[], replacement: ResultGroup): ResultGroup[] {
  return groups.map((candidate) => (candidate.id === replacement.id ? replacement : candidate));
}

const baselineGroups = [
  group("coreaudiod", [50], { cpuPercent: 0.3, interruptPerS: 20 }),
  group("sondine-total", [100], { milliwatts: 2 }),
];

describe("caps data", () => {
  it("matches the architecture §5 table", () => {
    const byGroup = Object.fromEntries(capRows.map((row) => [row.group, row]));
    expect(byGroup["sondine-audio"]).toMatchObject({
      footprintMiB: 48,
      cpuMeanPercent: { S0: 0.4, S3: 1.5 },
      wakeupsPerS: { S0: 30, S3: 80 },
    });
    expect(byGroup["coreaudiod"]).toMatchObject({
      delta: true,
      footprintMiB: null,
      cpuMeanPercent: { S0: 0.3, S3: 1 },
      wakeupsPerS: { S0: 25, S3: 60 },
    });
    expect(byGroup["electron-main"]).toMatchObject({
      footprintMiB: 100,
      cpuMeanPercent: { S0: 0.1, S3: 0.1 },
      wakeupsPerS: { S0: 1, S3: 1 },
    });
    expect(byGroup["chromium-services"]).toMatchObject({
      footprintMiB: 84,
      cpuMeanPercent: null,
      wakeupsPerS: { S0: 1, S3: 1 },
    });
    expect(byGroup["core"]).toMatchObject({
      footprintMiB: 120,
      cpuMeanPercent: { S0: 0.1, S3: 0.3 },
      wakeupsPerS: { S0: 2, S3: 5 },
    });
    expect(totalCaps).toMatchObject({
      footprintMiB: 362,
      powerDeltaMilliwatts: { S0: 30, S3: 120 },
      footprintSlopeMiBPerHour: 2,
      ringOverflows: 0,
    });
  });

  it("keeps the per-process footprint caps inside the total", () => {
    const sum = capRows.reduce((total, row) => total + (row.footprintMiB ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(totalCaps.footprintMiB);
  });

  it("states a profile for S0 and S3 and none for the scenarios no column covers", () => {
    expect(Object.keys(scenarioProfiles).toSorted()).toEqual([...SCENARIO_IDS].toSorted());
    expect(scenarioProfiles.S0).toEqual({ profile: "S0", basis: "spec" });
    expect(scenarioProfiles.S3).toEqual({ profile: "S3", basis: "spec" });
    expect(scenarioProfiles.S5).toBeNull();
    expect(scenarioProfiles.soak).toBeNull();
  });
});

describe("evaluateBudget", () => {
  it("passes a healthy S0 run and leaves what needs a baseline unevaluated", () => {
    const { checks, verdict } = evaluateBudget(input());
    expect(check(checks, "sondine-audio.footprint-max")).toMatchObject({
      value: 30,
      limit: 48,
      status: "pass",
      basis: "spec",
    });
    expect(check(checks, "sondine-audio.cpu-mean")).toMatchObject({
      value: 0.2,
      limit: 0.4,
      status: "pass",
    });
    expect(check(checks, "sondine-audio.wakeups-mean")).toMatchObject({
      value: 20,
      limit: 30,
      status: "pass",
    });
    expect(check(checks, "chromium-services.footprint-max").status).toBe("pass");
    expect(checks.some((candidate) => candidate.id === "chromium-services.cpu-mean")).toBe(false);
    expect(check(checks, "coreaudiod.cpu-mean-delta")).toMatchObject({
      value: 0.5,
      status: "not-evaluated",
    });
    expect(check(checks, "sondine-total.power-delta")).toMatchObject({
      value: 6,
      status: "not-evaluated",
      coverage: "partial",
    });
    expect(check(checks, "sondine-total.footprint-slope").status).toBe("not-evaluated");
    expect(check(checks, "sondine-audio.ring-overflows")).toMatchObject({
      value: null,
      status: "not-measured",
    });
    expect(check(checks, "sondine-total.sleep-assertions")).toMatchObject({
      value: 0,
      status: "pass",
    });
    expect(verdict).toEqual({
      status: "incomplete",
      pass: 10,
      fail: 0,
      notMeasured: 1,
      notEvaluated: 3,
    });
  });

  it("fails a footprint over its cap", () => {
    const groups = replace(
      healthyGroups(),
      group("core", [104], { footprintMiB: 121, cpuPercent: 0.05, interruptPerS: 1 }),
    );
    const { checks, verdict } = evaluateBudget(input({ groups }));
    expect(check(checks, "core.footprint-max")).toMatchObject({ value: 121, status: "fail" });
    expect(verdict.status).toBe("fail");
    expect(verdict.fail).toBe(1);
  });

  it("treats a value equal to its cap as a pass", () => {
    const groups = replace(
      healthyGroups(),
      group("sondine-audio", [101], { footprintMiB: 48, cpuPercent: 0.4, interruptPerS: 30 }),
    );
    const { checks } = evaluateBudget(input({ groups }));
    for (const id of [
      "sondine-audio.footprint-max",
      "sondine-audio.cpu-mean",
      "sondine-audio.wakeups-mean",
    ]) {
      expect(check(checks, id).status).toBe("pass");
    }
  });

  it("uses the column of the scenario", () => {
    const groups = replace(
      healthyGroups(),
      group("sondine-audio", [101], { footprintMiB: 30, cpuPercent: 1.2, interruptPerS: 70 }),
    );
    const s0 = evaluateBudget(input({ groups }));
    expect(check(s0.checks, "sondine-audio.cpu-mean")).toMatchObject({
      limit: 0.4,
      status: "fail",
    });
    expect(check(s0.checks, "sondine-audio.wakeups-mean")).toMatchObject({
      limit: 30,
      status: "fail",
    });
    const s3 = evaluateBudget(input({ scenario: "S3", groups }));
    expect(check(s3.checks, "sondine-audio.cpu-mean")).toMatchObject({
      limit: 1.5,
      status: "pass",
      basis: "spec",
    });
    expect(check(s3.checks, "sondine-audio.wakeups-mean")).toMatchObject({
      limit: 80,
      status: "pass",
    });
    const s2 = evaluateBudget(input({ scenario: "S2", groups }));
    expect(check(s2.checks, "sondine-audio.cpu-mean")).toMatchObject({
      limit: 1.5,
      basis: "inferred",
    });
    expect(s3.checks.some((candidate) => candidate.metric === "sleep-assertions")).toBe(false);
  });

  it("records S5 and the soak without CPU or wakeup caps", () => {
    for (const scenario of ["S5", "soak"] as const) {
      const { checks } = evaluateBudget(input({ scenario }));
      expect(
        checks.some(
          (candidate) => candidate.metric === "cpu-mean" || candidate.metric === "wakeups-mean",
        ),
      ).toBe(false);
      expect(checks.some((candidate) => candidate.metric === "power-delta")).toBe(false);
      expect(check(checks, "sondine-audio.footprint-max").status).toBe("pass");
    }
  });

  it("takes the coreaudiod and power deltas against the S6 baseline", () => {
    const { checks } = evaluateBudget(input({ baseline: { id: "base", groups: baselineGroups } }));
    expect(check(checks, "coreaudiod.cpu-mean-delta").value).toBeCloseTo(0.2);
    expect(check(checks, "coreaudiod.cpu-mean-delta").status).toBe("pass");
    expect(check(checks, "coreaudiod.wakeups-mean-delta")).toMatchObject({
      value: 20,
      limit: 25,
      status: "pass",
    });
    expect(check(checks, "sondine-total.power-delta")).toMatchObject({
      value: 4,
      limit: 30,
      status: "not-evaluated",
    });
  });

  it("fails a coreaudiod delta over its cap", () => {
    const groups = replace(
      healthyGroups(),
      group("coreaudiod", [50], { cpuPercent: 0.7, interruptPerS: 50 }),
    );
    const { checks } = evaluateBudget(
      input({ groups, baseline: { id: "base", groups: baselineGroups } }),
    );
    expect(check(checks, "coreaudiod.cpu-mean-delta").status).toBe("fail");
    expect(check(checks, "coreaudiod.wakeups-mean-delta")).toMatchObject({
      value: 30,
      status: "fail",
    });
  });

  it("does not subtract idle wakeups from interrupt wakeups", () => {
    const groups = replace(
      healthyGroups(),
      group("coreaudiod", [50], { cpuPercent: 0.5, idlePerS: 30 }),
    );
    const { checks } = evaluateBudget(
      input({ groups, baseline: { id: "base", groups: baselineGroups } }),
    );
    const wakeups = check(checks, "coreaudiod.wakeups-mean-delta");
    expect(wakeups).toMatchObject({ value: 30, status: "not-evaluated" });
  });

  it("checks no delta in the paused baseline itself", () => {
    const { checks } = evaluateBudget(input({ scenario: "S6" }));
    expect(checks.some((candidate) => candidate.subject === "coreaudiod")).toBe(false);
    expect(checks.some((candidate) => candidate.metric === "power-delta")).toBe(false);
    expect(check(checks, "sondine-total.sleep-assertions").basis).toBe("inferred");
  });

  it("marks missing processes as not measured", () => {
    const { checks, verdict } = evaluateBudget(input({ groups: [], assertions: null }));
    expect(check(checks, "sondine-audio.footprint-max")).toMatchObject({
      value: null,
      status: "not-measured",
    });
    expect(check(checks, "sondine-total.footprint-max").status).toBe("not-measured");
    expect(check(checks, "sondine-total.sleep-assertions").status).toBe("not-measured");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.pass).toBe(0);
  });

  it("fails a Sondine sleep assertion in S0", () => {
    const { checks } = evaluateBudget(
      input({
        assertions: [
          {
            type: "PreventUserIdleSystemSleep",
            ownerPid: 50,
            ownerName: "coreaudiod",
            createdForPid: 101,
            name: "audio",
            firstSeenAt: "2026-11-03T10:00:00.000Z",
            lastSeenAt: "2026-11-03T10:30:00.000Z",
            polls: 60,
          },
        ],
      }),
    );
    const assertions = check(checks, "sondine-total.sleep-assertions");
    expect(assertions).toMatchObject({ value: 1, status: "fail" });
    expect(assertions.note).toContain("coreaudiod(50)");
  });

  it("checks each process slope once a run is long enough, engine workers and coreaudiod excluded", () => {
    const processes = [
      processOf(101, "audio-helper", { slopeMiBPerHour: 0.5 }),
      processOf(104, "core", { slopeMiBPerHour: 3 }),
      processOf(200, "engine-worker", { slopeMiBPerHour: 400 }),
      processOf(50, "coreaudiod", { slopeMiBPerHour: 50 }),
    ];
    const { checks } = evaluateBudget(input({ scenario: "soak", measuredS: 8 * 3600, processes }));
    const slopes = checks.filter((candidate) => candidate.metric === "footprint-slope");
    expect(slopes.map((candidate) => [candidate.subject, candidate.status])).toEqual([
      ["pid:101", "pass"],
      ["pid:104", "fail"],
    ]);
  });
});

describe("verdictOf", () => {
  const base = {
    subject: "x",
    metric: "wakeups-mean",
    unit: "%",
    limit: 1,
    value: 0,
    basis: "spec",
    coverage: "full",
    note: null,
  } as const;
  it("passes only when every check passes", () => {
    expect(verdictOf([{ ...base, id: "a", status: "pass" }]).status).toBe("pass");
    expect(verdictOf([]).status).toBe("pass");
  });
  it("lets one failure win over unmeasured checks", () => {
    const verdict = verdictOf([
      { ...base, id: "a", status: "not-measured" },
      { ...base, id: "b", status: "fail" },
      { ...base, id: "c", status: "not-evaluated" },
    ]);
    expect(verdict).toEqual({ status: "fail", pass: 0, fail: 1, notMeasured: 1, notEvaluated: 1 });
  });
});
