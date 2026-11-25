import { describe, expect, it } from "vitest";
import { AssertionTracker, parseAssertions } from "../src/budget/assertions.ts";
import {
  parseLowPowerMode,
  parsePowerSource,
  parseSwVers,
  parseThermal,
  sameConditions,
} from "../src/budget/host.ts";
import { parseDuration } from "../src/duration.ts";
import { host } from "./fixtures.ts";

const assertionsText = `Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 385(powerd): [0x0004bb8c000191eb] 05:56:59 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"  
   pid 412(coreaudiod): [0x0004bb8c000191ec] 00:10:00 PreventUserIdleSystemSleep named: "com.apple.audio.context.preventuseridlesleep"  
	Created for PID: 101.
   pid 101(sondine-audio): [0x0004bb8c000191ed] 00:00:03 BackgroundTask named: "spool"  
   pid 100(Sondine): [0x0004bb8c000191ee] 00:00:01 NoIdleSleepAssertion named: "Electron"  
	Timeout will fire in 1198 secs Action=TimeoutActionRelease
No kernel assertions.
`;

describe("pmset -g assertions", () => {
  it("parses owners, types, names and the pid an assertion was created for", () => {
    const parsed = parseAssertions(assertionsText);
    expect(parsed).toHaveLength(4);
    expect(parsed[1]).toEqual({
      ownerPid: 412,
      ownerName: "coreaudiod",
      type: "PreventUserIdleSystemSleep",
      name: "com.apple.audio.context.preventuseridlesleep",
      createdForPid: 101,
    });
    expect(parsed[3]?.createdForPid).toBeNull();
  });

  it("keeps only sleep assertions attributable to Sondine, across polls", () => {
    const tracker = new AssertionTracker([100, 101]);
    tracker.record(assertionsText, new Date("2026-11-03T10:00:00Z"));
    tracker.record(assertionsText, new Date("2026-11-03T10:00:30Z"));
    expect(tracker.polls).toBe(2);
    const seen = tracker.assertions.map((assertion) => [
      assertion.ownerName,
      assertion.type,
      assertion.polls,
      assertion.lastSeenAt,
    ]);
    expect(seen).toEqual([
      ["coreaudiod", "PreventUserIdleSystemSleep", 2, "2026-11-03T10:00:30.000Z"],
      ["Sondine", "NoIdleSleepAssertion", 2, "2026-11-03T10:00:30.000Z"],
    ]);
  });
});

describe("host parsers", () => {
  it("reads sw_vers", () => {
    expect(
      parseSwVers("ProductName:\t\tmacOS\nProductVersion:\t\t27.0.1\nBuildVersion:\t\t26A434\n"),
    ).toEqual({
      productVersion: "27.0.1",
      buildVersion: "26A434",
    });
    expect(parseSwVers("")).toEqual({ productVersion: "unknown", buildVersion: "unknown" });
  });

  it("reads the power source and battery level", () => {
    const battery = parsePowerSource(
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=25231459)\t59%; discharging; 2:43 remaining present: true\n",
    );
    expect(battery).toMatchObject({ source: "battery", batteryPercent: 59 });
    expect(parsePowerSource("Now drawing from 'AC Power'\n")).toMatchObject({
      source: "ac",
      batteryPercent: null,
    });
    expect(parsePowerSource("").source).toBe("unknown");
  });

  it("reads thermal levels only when macOS recorded them", () => {
    const none = parseThermal(
      "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n",
    );
    expect(none).toMatchObject({
      warningLevel: null,
      performanceWarningLevel: null,
      cpuSpeedLimit: null,
    });
    const hot = parseThermal(
      "Thermal Warning Level = 2\nPerformance Warning Level = 1\nCPU_Speed_Limit \t= 80\n",
    );
    expect(hot).toMatchObject({ warningLevel: 2, performanceWarningLevel: 1, cpuSpeedLimit: 80 });
  });

  it("reads Low Power Mode", () => {
    expect(parseLowPowerMode("System-wide power settings:\n lowpowermode         1\n")).toBe(true);
    expect(parseLowPowerMode(" lowpowermode 0\n")).toBe(false);
    expect(parseLowPowerMode("")).toBeNull();
  });

  it("compares results only on the same machine, build and power source", () => {
    expect(sameConditions(host, host)).toBe(true);
    expect(sameConditions(host, { ...host, os: { ...host.os, buildVersion: "26A999" } })).toBe(
      false,
    );
    const onBattery = {
      ...host,
      power: { ...host.power, start: { ...host.power.start, source: "battery" as const } },
    };
    expect(sameConditions(host, onBattery)).toBe(false);
  });
});

describe("parseDuration", () => {
  it("accepts units, combinations and plain seconds", () => {
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("8h")).toBe(28_800);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("20s")).toBe(20);
    expect(parseDuration("2min")).toBe(120);
    expect(parseDuration("45")).toBe(45);
  });

  it("rejects anything else", () => {
    for (const text of ["", "m", "30 minutes", "1d", "10m junk", "-5s"]) {
      expect(() => parseDuration(text), text).toThrow(/invalid duration/);
    }
  });
});
