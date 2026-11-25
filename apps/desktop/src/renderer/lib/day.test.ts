import { describe, expect, it } from "vitest";
import { addDays, dayNoonMs, dayOf, isDay, relativeDay } from "./day";

describe("days", () => {
  it("names the local day of a time", () => {
    expect(dayOf(new Date(2026, 10, 6, 0, 0).getTime())).toBe("2026-11-06");
    expect(dayOf(new Date(2026, 10, 6, 23, 59).getTime())).toBe("2026-11-06");
    expect(dayOf(new Date(2026, 0, 3, 9).getTime())).toBe("2026-01-03");
  });

  it("steps across months, years and daylight saving changes", () => {
    expect(addDays("2026-11-06", -1)).toBe("2026-11-05");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    // Europe changes the clocks on the last Sundays of March and October.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24");
    expect(addDays("2026-11-06", -29)).toBe("2026-10-08");
  });

  it("accepts only real days", () => {
    expect(isDay("2026-11-06")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-11-6")).toBe(false);
    expect(isDay(20261106)).toBe(false);
    expect(dayOf(dayNoonMs("2026-11-06"))).toBe("2026-11-06");
  });

  it("names today and yesterday", () => {
    expect(relativeDay("2026-11-06", "2026-11-06")).toBe("today");
    expect(relativeDay("2026-11-05", "2026-11-06")).toBe("yesterday");
    expect(relativeDay("2026-11-04", "2026-11-06")).toBe("other");
    expect(relativeDay("2026-11-07", "2026-11-06")).toBe("other");
  });
});
