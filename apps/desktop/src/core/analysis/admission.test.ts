import { describe, expect, it } from "vitest";
import {
  admit,
  admitCheap,
  SWAP_GROWTH_TOLERANCE_BYTES,
  SWAP_ROOM_MARGIN_BYTES,
  remainingMs,
  shouldCancel,
  type AdmissionInput,
  type SystemSample,
} from "./admission";

const GB = 1024 ** 3;

const ok: SystemSample = {
  onBattery: false,
  thermalState: "nominal",
  idleSeconds: 300,
  locked: false,
  memoryPressure: "normal",
  swapUsedBytes: 1 * GB,
  swapRoomBytes: 80 * GB,
};

/** Before a cold load. */
const base: AdmissionInput = {
  sample: ok,
  requested: false,
  warm: false,
  loading: false,
  peakBytes: 17 * GB,
  swapBaselineBytes: null,
};

const cases: readonly [string, Partial<SystemSample>, Partial<AdmissionInput>, string[]][] = [
  ["everything fine", {}, {}, []],
  ["on battery", { onBattery: true }, {}, ["on-battery"]],
  ["power source unknown", { onBattery: null }, {}, ["on-battery"]],
  ["user request on battery", { onBattery: true }, { requested: true }, []],
  ["thermal fair", { thermalState: "fair" }, {}, []],
  ["thermal serious", { thermalState: "serious" }, {}, ["thermal"]],
  ["thermal unknown", { thermalState: null }, {}, ["thermal"]],
  [
    "user request still waits for heat",
    { thermalState: "critical" },
    { requested: true },
    ["thermal"],
  ],
  ["memory pressure warn before a cold load", { memoryPressure: "warn" }, {}, ["memory"]],
  ["user request loads at warn pressure", { memoryPressure: "warn" }, { requested: true }, []],
  [
    "user request still needs swap room",
    { memoryPressure: "warn", swapRoomBytes: 1024 ** 3 },
    { requested: true },
    ["memory"],
  ],
  ["memory pressure unknown", { memoryPressure: null }, {}, ["memory"]],
  ["user request under pressure", { memoryPressure: "critical" }, { requested: true }, ["memory"]],
  [
    "not enough disk for swap before a cold load",
    { swapRoomBytes: 17 * GB + SWAP_ROOM_MARGIN_BYTES - 1 },
    {},
    ["memory"],
  ],
  ["just enough disk for swap", { swapRoomBytes: 17 * GB + SWAP_ROOM_MARGIN_BYTES }, {}, []],
  ["swap room unknown", { swapRoomBytes: null }, {}, ["memory"]],
  ["warm engine ignores swap room", { swapRoomBytes: 1 * GB }, { warm: true }, []],
  // Between two jobs as during one: the engine's own weights hold pressure at warn.
  ["warm engine holds pressure at warn", { memoryPressure: "warn" }, { warm: true }, []],
  [
    "critical pressure with a warm engine",
    { memoryPressure: "critical" },
    { warm: true },
    ["memory"],
  ],
  ["pressure unknown with a warm engine", { memoryPressure: null }, { warm: true }, []],
  [
    "swap grew once the engine was loaded",
    { swapUsedBytes: 1 * GB + SWAP_GROWTH_TOLERANCE_BYTES + 1 },
    { warm: true, swapBaselineBytes: 1 * GB },
    ["swap"],
  ],
  [
    "swap growth within tolerance",
    { swapUsedBytes: 1 * GB + SWAP_GROWTH_TOLERANCE_BYTES },
    { warm: true, swapBaselineBytes: 1 * GB },
    [],
  ],
  ["swap grows while loading", { swapUsedBytes: 30 * GB }, { warm: true }, []],
  [
    "critical pressure while loading",
    { memoryPressure: "critical" },
    { warm: true, loading: true },
    [],
  ],
  [
    "heat while loading",
    { memoryPressure: "critical", thermalState: "serious" },
    { warm: true, loading: true },
    ["thermal"],
  ],
  [
    "a cold check never counts swap growth",
    { swapUsedBytes: 30 * GB },
    { swapBaselineBytes: 1 * GB },
    [],
  ],
  ["warm engine on battery", { onBattery: true }, { warm: true }, ["on-battery"]],
  ["warm engine while in use", { idleSeconds: 30 }, { warm: true }, ["not-idle"]],
  [
    "user request with a warm engine while in use",
    { idleSeconds: 0 },
    { warm: true, requested: true },
    [],
  ],
  ["in use", { idleSeconds: 30 }, {}, ["not-idle"]],
  ["idle unknown", { idleSeconds: null }, {}, ["not-idle"]],
  ["locked while in use counts as idle", { idleSeconds: 3, locked: true }, {}, []],
  ["user request while in use", { idleSeconds: 0 }, { requested: true }, []],
  [
    "everything wrong at once",
    { onBattery: true, thermalState: "critical", memoryPressure: "critical", idleSeconds: 0 },
    {},
    ["on-battery", "thermal", "memory", "not-idle"],
  ],
];

describe("admission", () => {
  it.each(cases)("%s", (_name, sample, input, reasons) => {
    const decision = admit({ ...base, ...input, sample: { ...ok, ...sample } });
    expect(decision.admitted ? [] : decision.reasons).toEqual(reasons);
  });

  it("checks power, heat and idle without reading memory first", () => {
    const sample = { ...ok, memoryPressure: null, swapRoomBytes: null, swapUsedBytes: null };
    expect(admitCheap({ sample, requested: false })).toEqual({ admitted: true });
    expect(admitCheap({ sample: { ...sample, idleSeconds: 1 }, requested: false })).toEqual({
      admitted: false,
      reasons: ["not-idle"],
    });
  });
});

describe("mid-job cancellation", () => {
  const refused = { admitted: false, reasons: ["not-idle"] } as const;

  it("estimates the time left from progress", () => {
    expect(remainingMs(null, 10_000)).toBeNull();
    expect(remainingMs(0, 10_000)).toBeNull();
    expect(remainingMs(0.5, 10_000)).toBe(10_000);
    expect(remainingMs(0.8, 400_000)).toBeCloseTo(100_000);
    expect(remainingMs(1, 10_000)).toBe(0);
  });

  it("lets a job with less than 60 s left finish", () => {
    expect(shouldCancel({ admitted: true }, null)).toBe(false);
    expect(shouldCancel(refused, null)).toBe(true);
    expect(shouldCancel(refused, 60_000)).toBe(true);
    expect(shouldCancel(refused, 59_999)).toBe(false);
  });
});

describe("resource regression", () => {
  it.each(["memory", "swap", "thermal"] as const)("cancels %s at every ETA", (reason) => {
    for (const remaining of [null, 0, 1, 59_999, 60_000, Number.NaN]) {
      expect(shouldCancel({ admitted: false, reasons: [reason] }, remaining)).toBe(true);
    }
  });
  it("does not mask memory with a simultaneous activity refusal", () => {
    expect(shouldCancel({ admitted: false, reasons: ["memory", "not-idle"] }, 1)).toBe(true);
  });
  it.each(["not-idle", "on-battery"] as const)("keeps finite finish grace for %s", (reason) => {
    const refused = { admitted: false, reasons: [reason] } as const;
    expect(shouldCancel(refused, 59_999)).toBe(false);
    expect(shouldCancel(refused, 60_000)).toBe(true);
    expect(shouldCancel(refused, null)).toBe(true);
    expect(shouldCancel(refused, Number.NaN)).toBe(true);
  });
});

describe("conditions the user turned off", () => {
  const busy: SystemSample = { ...ok, onBattery: true, idleSeconds: 0, memoryPressure: "warn" };

  it("lets automatic jobs start on battery, while the Mac is used, or at warn pressure", () => {
    expect(admit({ ...base, sample: busy }).admitted).toBe(false);
    expect(
      admit({ ...base, sample: busy, waitFor: { power: false, idle: false, memory: false } }),
    ).toEqual({ admitted: true });
    expect(
      admit({ ...base, sample: busy, waitFor: { power: false, idle: true, memory: false } }),
    ).toEqual({ admitted: false, reasons: ["not-idle"] });
    expect(
      admitCheap({
        sample: busy,
        requested: false,
        waitFor: { power: false, idle: false, memory: true },
      }),
    ).toEqual({ admitted: true });
  });

  it("never lets heat, critical memory or a full disk through", () => {
    const off = { power: false, idle: false, memory: false };
    expect(admit({ ...base, sample: { ...ok, thermalState: "serious" }, waitFor: off })).toEqual({
      admitted: false,
      reasons: ["thermal"],
    });
    expect(admit({ ...base, sample: { ...ok, memoryPressure: "critical" }, waitFor: off })).toEqual(
      {
        admitted: false,
        reasons: ["memory"],
      },
    );
    expect(admit({ ...base, sample: { ...ok, swapRoomBytes: 5 * GB }, waitFor: off })).toEqual({
      admitted: false,
      reasons: ["memory"],
    });
  });
});
