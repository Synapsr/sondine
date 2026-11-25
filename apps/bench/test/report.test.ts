import { describe, expect, it } from "vitest";
import { evaluateBudget } from "../src/budget/evaluate.ts";
import { compareResults, formatResult, table } from "../src/budget/report.ts";
import { group, healthyGroups, result } from "./fixtures.ts";

function evaluated(groups = healthyGroups()) {
  const evaluation = evaluateBudget({
    scenario: "S0",
    measuredS: 1800,
    processes: [],
    groups,
    assertions: [],
    baseline: null,
  });
  return result({ groups, checks: evaluation.checks, verdict: evaluation.verdict });
}

describe("table", () => {
  it("left-aligns the first column and right-aligns the others", () => {
    expect(
      table([
        ["group", "MiB"],
        ["core", "9.5"],
        ["sondine-audio", "120.0"],
      ]),
    ).toBe(["group            MiB", "core             9.5", "sondine-audio  120.0"].join("\n"));
  });
});

describe("formatResult", () => {
  it("shows groups, checks and the verdict", () => {
    const text = formatResult(evaluated());
    expect(text).toContain("S0 Silence, mic only");
    expect(text).toMatch(/sondine-audio\.footprint-max\s+30\.000\s+≤ 48\.000 MiB\s+pass/);
    expect(text).toContain(
      "verdict: incomplete (10 pass, 0 fail, 1 not measured, 3 not evaluated)",
    );
    expect(text).toMatch(/sondine-audio\.cpu-mean\s+0\.200\s+≤ 0\.400 %\s+pass \(diagnostic\)/);
  });
});

describe("compareResults", () => {
  it("flags the regressions of architecture §13", () => {
    const a = evaluated();
    const b = evaluated(
      healthyGroups().map((candidate) =>
        candidate.id === "core"
          ? group("core", [104], {
              footprintMiB: 95,
              cpuPercent: 0.05,
              interruptPerS: 1.5,
              milliwatts: 1,
            })
          : candidate,
      ),
    );
    const comparison = compareResults(a, { ...b, id: "b-run" });
    // 90 → 95 MiB is +5.6 % (over the 5 % footprint gate); wakeups 1 → 1.5 is +50 %.
    expect(comparison.regressions).toEqual(["core footprint MiB +5.6 %", "core wakeups/s +50.0 %"]);
    expect(comparison.text).toMatch(
      /core\s+footprint MiB\s+90\.0\s+95\.0\s+\+5\.0\s+\+5\.6 %\s+regression \(> \+5 %\)/,
    );
    expect(comparison.text).not.toContain("warnings:");
  });

  it("warns when the runs are not comparable", () => {
    const a = evaluated();
    const b = result({
      ...evaluated(),
      scenario: { id: "S3", title: "FaceTime or Zoom call" },
      host: { ...a.host, chip: "Apple M4" },
    });
    const { text } = compareResults(a, b);
    expect(text).toContain("different scenarios: S0 vs S3");
    expect(text).toContain("different chip, macOS build or power source");
  });
});
