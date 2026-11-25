import { describe, expect, it } from "vitest";
import { dayHeading, isoWeek, monthHeading, weekHeading } from "./period-heading";

// Messages and dates resolve to English in tests.

const TODAY = "2026-11-20";

describe("period headings", () => {
  it("gives every day a title and a line under it", () => {
    expect(dayHeading(TODAY, TODAY)).toEqual({ title: "Today", subtitle: "Friday November 20" });
    expect(dayHeading("2026-11-19", TODAY)).toEqual({
      title: "Yesterday",
      subtitle: "Thursday November 19",
    });
    expect(dayHeading("2026-11-18", TODAY)).toEqual({
      title: "Wednesday",
      subtitle: "November 18",
    });
    expect(dayHeading("2025-11-18", TODAY).subtitle).toBe("November 18, 2025");
  });

  it("numbers weeks as ISO 8601 does", () => {
    expect(isoWeek("2026-11-16")).toBe(47);
    expect(isoWeek("2025-12-29")).toBe(1);
    expect(isoWeek("2026-12-28")).toBe(53);
    expect(isoWeek("2027-01-04")).toBe(1);
    expect(weekHeading("2026-11-16", TODAY).subtitle).toBe("Week 47");
  });

  it("names a month over its year", () => {
    expect(monthHeading("2026-11-01")).toEqual({ title: "November", subtitle: "2026" });
  });
});
