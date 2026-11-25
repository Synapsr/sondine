import { describe, expect, it } from "vitest";
import { evaluateBudget } from "../src/budget/evaluate.ts";
import {
  attributeIncarnations,
  sondineMatchPattern,
  type SampledIncarnation,
} from "../src/budget/membership.ts";
import type { Discovery, DiscoveredProcess } from "../src/budget/discovery.ts";
import { sampleArguments } from "../src/meter/meter.ts";
import { group, healthyGroups } from "./fixtures.ts";

const app = "/Applications/Sondine.app/Contents";
const audioPath = `${app}/Resources/bin/sondine-audio`;
const helperPath = `${app}/Frameworks/Sondine Helper.app/Contents/MacOS/Sondine Helper`;

function known(pid: number, role: DiscoveredProcess["role"], path: string): DiscoveredProcess {
  return { pid, ppid: 100, startUs: pid * 10, name: path.split("/").at(-1) ?? "", path, role };
}

function sampled(process: DiscoveredProcess): SampledIncarnation {
  return { pid: process.pid, startUs: process.startUs, name: process.name, path: process.path };
}

const main = known(100, "main", `${app}/MacOS/Sondine`);
const audio = known(101, "audio-helper", audioPath);
const core = known(104, "core", helperPath);
const coreaudiod = known(50, "coreaudiod", "/usr/sbin/coreaudiod");

function discovery(sondine: DiscoveredProcess[]): Discovery {
  return { sondine, coreaudiod, warnings: [] };
}

describe("sampling membership", () => {
  it("asks the meter to rediscover Sondine and coreaudiod during the run", () => {
    const args = sampleArguments({
      pids: [50, 100],
      intervalMs: 1000,
      durationS: 60,
      privilegedIntervalS: 60,
      out: "x.jsonl",
      match: sondineMatchPattern("Sondine"),
      rediscoverS: 10,
    });
    expect(args).toContain("--match");
    expect(args[args.indexOf("--rediscover-s") + 1]).toBe("10");
    const pattern = new RegExp(sondineMatchPattern("Sondine"));
    for (const candidate of [audioPath, helperPath, "sondine-audio", "/usr/sbin/coreaudiod"])
      expect(pattern.test(candidate)).toBe(true);
    for (const candidate of ["sondine-meter", "/Applications/Safari.app/Contents/MacOS/Safari"])
      expect(pattern.test(candidate)).toBe(false);
  });

  it("assigns a restarted audio helper to its row", () => {
    const restarted = known(201, "audio-helper", audioPath);
    const membership = attributeIncarnations(
      [main, audio, core, coreaudiod, restarted].map(sampled),
      [discovery([main, audio, core]), discovery([main, restarted, core])],
      "Sondine",
    );
    expect(membership.roles.get("201:2010")).toBe("audio-helper");
    expect(membership.incomplete.size).toBe(0);
  });

  it("names a native helper that lived only between two listings", () => {
    const shortLived = known(202, "audio-helper", audioPath);
    const membership = attributeIncarnations(
      [main, audio, core, coreaudiod, shortLived].map(sampled),
      [discovery([main, audio, core]), discovery([main, audio, core])],
      "Sondine",
    );
    expect(membership.roles.get("202:2020")).toBe("audio-helper");
    expect(membership.incomplete.size).toBe(0);
  });

  it("marks Sondine rows incomplete when a sampled helper cannot be assigned", () => {
    const unknownHelper = known(203, "core", helperPath);
    const membership = attributeIncarnations(
      [main, audio, core, coreaudiod, unknownHelper].map(sampled),
      [discovery([main, audio, core]), discovery([main, audio, core])],
      "Sondine",
    );
    expect(membership.roles.has("203:2030")).toBe(false);
    expect([...membership.incomplete].toSorted()).toEqual([
      "chromium-services",
      "core",
      "electron-main",
      "sondine-audio",
      "sondine-total",
    ]);
  });

  it("marks a row incomplete when a process alive at the end was never sampled", () => {
    const restarted = known(201, "audio-helper", audioPath);
    const membership = attributeIncarnations(
      [main, audio, core, coreaudiod].map(sampled),
      [discovery([main, audio, core]), discovery([main, restarted, core])],
      "Sondine",
    );
    expect([...membership.incomplete].toSorted()).toEqual(["sondine-audio", "sondine-total"]);
    expect(membership.warnings.some((warning) => warning.includes("pid 201"))).toBe(true);
  });
});

describe("incomplete coverage", () => {
  it("does not judge a row whose processes were not all measured", () => {
    const { checks, verdict } = evaluateBudget({
      scenario: "S0",
      measuredS: 1800,
      processes: [],
      groups: healthyGroups(),
      assertions: [],
      baseline: null,
      incompleteGroups: new Set(["sondine-audio"]),
    });
    const audioChecks = checks.filter((check) => check.subject === "sondine-audio");
    expect(audioChecks.length).toBeGreaterThan(0);
    for (const check of audioChecks.filter((candidate) => candidate.metric !== "ring-overflows")) {
      expect(check).toMatchObject({ status: "not-evaluated", coverage: "partial" });
      expect(check.note).toContain("not every sondine-audio process was measured");
    }
    expect(verdict.status).toBe("incomplete");
  });
});

describe("partial system power", () => {
  it("keeps Sondine's CPU energy as a reading but does not judge the system cap with it", () => {
    const { checks } = evaluateBudget({
      scenario: "S0",
      measuredS: 1800,
      processes: [],
      groups: healthyGroups(),
      assertions: [],
      baseline: { id: "base", groups: [group("sondine-total", [100], { milliwatts: 2 })] },
    });
    expect(checks.find((check) => check.id === "sondine-total.power-delta")).toMatchObject({
      value: 4,
      status: "not-evaluated",
      coverage: "partial",
    });
  });
});

describe("diagnostic CPU", () => {
  it("does not fail the verdict on CPU when wakeups and energy are inside their caps", () => {
    const groups = healthyGroups().map((candidate) =>
      candidate.id === "sondine-audio"
        ? group("sondine-audio", [101], {
            footprintMiB: 30,
            cpuPercent: 0.5,
            interruptPerS: 20,
            milliwatts: 4,
          })
        : candidate,
    );
    const { checks, verdict } = evaluateBudget({
      scenario: "S0",
      measuredS: 1800,
      processes: [],
      groups,
      assertions: [],
      baseline: null,
    });
    expect(checks.find((check) => check.id === "sondine-audio.cpu-mean")?.status).toBe("fail");
    expect(verdict.status).not.toBe("fail");
    expect(verdict.fail).toBe(0);
  });
});
