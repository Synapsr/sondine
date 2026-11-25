import type { AnalysisCheck, AnalysisStatus } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { checkRows, checkSummary, memoryBar } from "./analysis-check-view";

const GB = 1024 ** 3;

const ready: AnalysisCheck = {
  requested: false,
  waitFor: { power: true, idle: true, memory: true },
  remote: false,
  reasons: [],
  onBattery: false,
  idleSeconds: 300,
  idleRequiredSeconds: 120,
  locked: false,
  thermalState: "nominal",
  memoryPressure: "normal",
  swapRoomBytes: 80 * GB,
  swapRoomNeededBytes: 29 * GB,
  memoryUse: null,
};

const status = (
  queued: Partial<AnalysisStatus["queued"]> = {},
  running: AnalysisStatus["running"] = null,
): AnalysisStatus => ({
  worker: "absent",
  queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0, ...queued },
  running,
  waitingFor: [],
  waitingEpisodeId: null,
  server: null,
  requests: [],
  retryAtMs: null,
  lastError: null,
  models: [],
});

const unmet = (check: AnalysisCheck) =>
  checkRows(check)
    .filter((row) => !row.ok)
    .map((row) => [row.key, row.detail]);

describe("a compute server", () => {
  const remote: AnalysisCheck = {
    ...ready,
    remote: true,
    waitFor: { power: false, idle: false, memory: false },
    onBattery: true,
  };

  it("is the only condition, and power and idle are none", () => {
    expect(checkRows(remote)).toEqual([{ key: "server", ok: true, detail: null, waitedFor: null }]);
    expect(checkRows({ ...remote, reasons: ["server-offline"] })).toEqual([
      { key: "server", ok: false, detail: { kind: "server-offline" }, waitedFor: null },
    ]);
  });

  it("still says when the Mac itself is in trouble", () => {
    const rows = checkRows({ ...remote, reasons: ["memory"], memoryPressure: "critical" });
    expect(rows.map((row) => [row.key, row.ok, row.waitedFor])).toEqual([
      ["server", true, null],
      ["memory", false, null],
    ]);
  });
});

describe("why transcription waits", () => {
  it("names the one condition left while the user is at the Mac", () => {
    const check: AnalysisCheck = { ...ready, reasons: ["not-idle"], idleSeconds: 3 };
    expect(unmet(check)).toEqual([["idle", { kind: "used", seconds: 3 }]]);
    // Only idle stands in the way: « Transcrire maintenant » skips it.
    expect(checkSummary(status({ conversations: 2 }), check, checkRows(check))).toBe("request-now");
  });

  it("lists every condition, and says when all are met", () => {
    const rows = checkRows(ready);
    expect(rows.map((row) => row.key)).toEqual(["model", "power", "idle", "heat", "memory"]);
    expect(rows.every((row) => row.ok)).toBe(true);
    expect(rows.find((row) => row.key === "idle")?.detail).toEqual({ kind: "idle", seconds: 300 });
    expect(checkSummary(status({ moments: 1 }), ready, rows)).toBe("ready");
  });

  it("says why memory is short: the disk room for the load, then the pressure", () => {
    expect(
      unmet({ ...ready, reasons: ["memory"], swapRoomBytes: 12 * GB, memoryPressure: "warn" }),
    ).toEqual([["memory", { kind: "room", roomBytes: 12 * GB, neededBytes: 29 * GB }]]);
    expect(unmet({ ...ready, reasons: ["memory"], memoryPressure: "warn" })).toEqual([
      ["memory", { kind: "pressure", pressure: "warn", use: null }],
    ]);
    // Loaded: growth past the baseline, no room to check.
    expect(
      unmet({ ...ready, reasons: ["swap"], swapRoomBytes: null, swapRoomNeededBytes: null }),
    ).toEqual([["memory", { kind: "swap" }]]);
  });

  it("says when macOS gave no answer, rather than guessing", () => {
    const check: AnalysisCheck = {
      ...ready,
      reasons: ["on-battery", "not-idle", "thermal"],
      onBattery: null,
      idleSeconds: null,
      thermalState: "unknown",
    };
    expect(unmet(check)).toEqual([
      ["power", { kind: "unknown" }],
      ["idle", { kind: "unknown" }],
      ["heat", { kind: "unknown" }],
    ]);
    // Heat is not something a request skips.
    expect(checkSummary(status({ conversations: 1 }), check, checkRows(check))).toBeNull();
  });

  it("counts a locked screen as idle", () => {
    const rows = checkRows({ ...ready, locked: true, idleSeconds: 0 });
    expect(rows.find((row) => row.key === "idle")).toEqual({
      key: "idle",
      ok: true,
      detail: { kind: "locked" },
      waitedFor: true,
    });
  });

  it("explains an empty queue, traces waiting, and a running one", () => {
    const check: AnalysisCheck = { ...ready, reasons: ["not-idle"], idleSeconds: 0 };
    const rows = checkRows(check);
    expect(checkSummary(status(), check, rows)).toBe("nothing-queued");
    // Traces wait for a loaded engine, not for the Mac.
    expect(checkSummary(status({ traces: 4 }), check, rows)).toBe("traces");
    expect(
      checkSummary(
        status({}, { jobId: 1, episodeId: 2, progress: 0.4, startedAtMs: 0 }),
        ready,
        checkRows(ready),
      ),
    ).toBe("running");
  });

  it("never says ready while a retry delay holds the queue", () => {
    const check: AnalysisCheck = { ...ready, reasons: ["retry-later"] };
    const rows = checkRows(check);
    expect(rows.every((row) => row.ok)).toBe(true);
    expect(checkSummary(status({ conversations: 1 }), check, rows)).toBe("retry-later");
  });

  it("drops power and idle for the user's request, and never suggests requesting it", () => {
    const check: AnalysisCheck = {
      ...ready,
      requested: true,
      reasons: ["memory"],
      memoryPressure: "critical",
    };
    const rows = checkRows(check);
    expect(rows.map((row) => row.key)).toEqual(["model", "heat", "memory"]);
    expect(checkSummary(status({ requested: 1 }), check, rows)).toBeNull();
    const waiting: AnalysisCheck = { ...ready, requested: true };
    expect(checkSummary(status({ requested: 1 }), waiting, checkRows(waiting))).toBe("ready");
  });

  it("draws the compressed memory app by app, with the line and what to free", () => {
    const bar = memoryBar({
      countedBytes: 25 * GB,
      compressedBytes: 13 * GB,
      limitBytes: 10 * GB,
      apps: [
        { name: "Cursor", appPath: null, bytes: 4 * GB },
        { name: "Codex", appPath: null, bytes: 2 * GB },
        { name: "Yab", appPath: null, bytes: 1.5 * GB },
        { name: "ChatGPT", appPath: null, bytes: 1 * GB },
        { name: "Discord", appPath: null, bytes: 0.5 * GB },
      ],
    });
    expect(bar.segments.map((segment) => [segment.name, segment.bytes / GB])).toEqual([
      ["Cursor", 4],
      ["Codex", 2],
      ["Yab", 1.5],
      ["ChatGPT", 1],
      // The fifth app and what no app accounts for.
      [null, 4.5],
    ]);
    expect(bar.segments[0]?.share).toBeCloseTo(4 / 25);
    expect(bar.limitShare).toBeCloseTo(0.4);
    expect(bar.toFreeBytes).toBe(3 * GB);
    expect(
      memoryBar({ countedBytes: 25 * GB, compressedBytes: 9 * GB, limitBytes: 10 * GB, apps: [] })
        .toFreeBytes,
    ).toBe(0);
  });

  it("points to the model when none is installed", () => {
    expect(unmet({ ...ready, reasons: ["no-model"], swapRoomNeededBytes: null })).toEqual([
      ["model", { kind: "no-model" }],
    ]);
  });

  it("shows the conditions the user turned off, which no longer hold transcription", () => {
    const check: AnalysisCheck = {
      ...ready,
      waitFor: { power: true, idle: false, memory: false },
      idleSeconds: 0,
      memoryPressure: "warn",
    };
    const rows = checkRows(check);
    expect(rows.map((row) => [row.key, row.ok, row.waitedFor, row.detail?.kind ?? null])).toEqual([
      ["model", true, null, null],
      ["power", true, true, null],
      ["idle", true, false, "waived"],
      ["heat", true, null, null],
      ["memory", true, false, "waived"],
    ]);
    expect(checkSummary(status({ conversations: 1 }), check, rows)).toBe("ready");
    // Off, memory still stops a job once critical.
    const critical: AnalysisCheck = { ...check, reasons: ["memory"], memoryPressure: "critical" };
    expect(checkRows(critical).find((row) => row.key === "memory")?.detail).toEqual({
      kind: "pressure",
      pressure: "critical",
      use: null,
    });
  });
});
