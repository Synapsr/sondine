import { describe, expect, it } from "vitest";
import { pauseEndLabel } from "./timed-pause";

describe("timed pause", () => {
  it("says when a timed pause ends, with the day when it is not today", () => {
    const now = new Date(2026, 10, 6, 14, 20).getTime();
    expect(pauseEndLabel(new Date(2026, 10, 6, 14, 35).getTime(), now, "fr")).toBe("14:35");
    // ICU puts a narrow no-break space before PM.
    expect(
      pauseEndLabel(new Date(2026, 10, 6, 14, 35).getTime(), now, "en").replace(/\s/gu, " "),
    ).toBe("2:35 PM");
    expect(pauseEndLabel(new Date(2026, 10, 7, 0, 5).getTime(), now, "fr")).toBe("samedi 00:05");
  });
});
