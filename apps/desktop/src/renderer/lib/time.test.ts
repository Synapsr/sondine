import { describe, expect, it } from "vitest";
import { durationParts, formatClock, formatOffset } from "./time";

describe("time", () => {
  it("formats a position like a player", () => {
    expect(formatOffset(0)).toBe("00:00");
    expect(formatOffset(-400)).toBe("00:00");
    expect(formatOffset(374_900)).toBe("06:14");
    expect(formatOffset(24 * 60_000 + 3_000)).toBe("24:03");
    expect(formatOffset(3_723_000)).toBe("1:02:03");
  });

  it("rounds a length the way it is said", () => {
    expect(durationParts(0)).toEqual({ unit: "seconds", seconds: 0 });
    expect(durationParts(300)).toEqual({ unit: "seconds", seconds: 1 });
    expect(durationParts(6_400)).toEqual({ unit: "seconds", seconds: 6 });
    expect(durationParts(59_400)).toEqual({ unit: "seconds", seconds: 59 });
    expect(durationParts(59_600)).toEqual({ unit: "minutes", minutes: 1 });
    expect(durationParts(11 * 60_000 + 20_000)).toEqual({ unit: "minutes", minutes: 11 });
    expect(durationParts(59 * 60_000 + 40_000)).toEqual({ unit: "hours", hours: 1, minutes: 0 });
    expect(durationParts(65 * 60_000)).toEqual({ unit: "hours", hours: 1, minutes: 5 });
  });

  it("formats a wall-clock time in the locale", () => {
    const at = new Date(2026, 10, 6, 9, 5).getTime();
    expect(formatClock(at, "fr")).toBe("09:05");
    expect(formatClock(at, "en").replace(/\s/gu, " ")).toBe("9:05 AM");
  });
});
