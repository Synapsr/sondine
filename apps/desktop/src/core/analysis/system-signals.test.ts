import { describe, expect, it } from "vitest";
import {
  createSystemSignals,
  parseMemoryPressure,
  parseSwapUsage,
  readMemoryState,
} from "./system-signals";

describe("macOS memory readings", () => {
  it("parses the pressure level", () => {
    expect(parseMemoryPressure("1\n")).toBe("normal");
    expect(parseMemoryPressure("2")).toBe("warn");
    expect(parseMemoryPressure("4")).toBe("critical");
    expect(parseMemoryPressure("")).toBeNull();
  });

  it("parses swap in use", () => {
    expect(
      parseSwapUsage("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n"),
    ).toBe(Math.round(1024.5 * 1024 ** 2));
    expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)")).toBe(0);
    expect(parseSwapUsage("total = 4.00G  used = 1.25G  free = 2.75G")).toBe(1.25 * 1024 ** 3);
    expect(parseSwapUsage("garbage")).toBeNull();
  });

  it("reads the room left for swap on this Mac", async () => {
    const state = await readMemoryState();
    expect(state.swapRoomBytes).toBeGreaterThan(0);
  });
});

describe("idle from main", () => {
  it("asks main and uses its answer", async () => {
    let queries = 0;
    const signals = createSystemSignals({
      power: () => ({ onBattery: false, suspended: false, thermalState: "nominal" }),
      queryIdle: () => {
        queries += 1;
        setTimeout(
          () => signals.receiveIdle({ idleSeconds: 200, locked: false, atMs: Date.now() }),
          5,
        );
      },
      readMemory: async () => ({ memoryPressure: "normal", swapUsedBytes: 0, swapRoomBytes: 1 }),
    });
    await expect(signals.cheap()).resolves.toMatchObject({
      onBattery: false,
      thermalState: "nominal",
      idleSeconds: 200,
      locked: false,
    });
    expect(queries).toBe(1);
  });

  it("treats a missing answer as unknown", async () => {
    let now = 1_000_000;
    const signals = createSystemSignals({
      power: () => ({ onBattery: null, suspended: false, thermalState: null }),
      queryIdle: () => undefined,
      now: () => now,
      idleReplyMs: 10,
    });
    signals.receiveIdle({ idleSeconds: 500, locked: true, atMs: now });
    now += 60_000;
    await expect(signals.cheap()).resolves.toMatchObject({ idleSeconds: null, locked: false });
  });

  it("waits for main's first power snapshot before it reads heat", async () => {
    // 2026-11-18: the first look at launch read null and said the Mac was hot.
    let power = {
      onBattery: null as boolean | null,
      suspended: false,
      thermalState: null as string | null,
    };
    let known = () => undefined as void;
    const signals = createSystemSignals({
      power: () => power,
      powerKnown: new Promise<void>((resolve) => {
        known = resolve;
      }),
      queryIdle: () => undefined,
      idleReplyMs: 1,
    });
    const reading = signals.cheap();
    setTimeout(() => {
      power = { onBattery: false, suspended: false, thermalState: "nominal" };
      known();
    }, 20);
    await expect(reading).resolves.toMatchObject({ onBattery: false, thermalState: "nominal" });
  });
});
