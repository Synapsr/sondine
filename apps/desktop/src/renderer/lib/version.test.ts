import { describe, expect, it } from "vitest";
import { olderVersion } from "./version";

describe("olderVersion", () => {
  it("compares part by part, as numbers", () => {
    expect(olderVersion("0.1.0", "0.2.0")).toBe(true);
    expect(olderVersion("0.9.0", "0.10.0")).toBe(true);
    expect(olderVersion("0.2", "0.2.0")).toBe(false);
    expect(olderVersion("0.3.0", "0.2.0")).toBe(false);
    expect(olderVersion("0.2.0", "0.2.0")).toBe(false);
  });

  it("says nothing of a version that is not numbers", () => {
    expect(olderVersion("0.2.0-beta", "0.3.0")).toBe(false);
  });
});
