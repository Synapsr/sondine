import { describe, expect, it } from "vitest";
import { createRestartPolicy } from "./restart-policy";

describe("restart policy", () => {
  it("backs off 1 s to 30 s", () => {
    const policy = createRestartPolicy();
    const delays = Array.from(
      { length: 8 },
      (_, i) => policy.onCrash(i * 10 * 60_000, 100).delayMs,
    );
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("flags three crashes within five minutes as a crash loop", () => {
    const policy = createRestartPolicy();
    expect(policy.onCrash(0, 100).crashLoop).toBe(false);
    expect(policy.onCrash(60_000, 100).crashLoop).toBe(false);
    expect(policy.onCrash(120_000, 100)).toMatchObject({ crashLoop: true, recentCrashes: 3 });
    // The first crash leaves the window; two remain.
    expect(policy.onCrash(330_000, 100)).toMatchObject({ crashLoop: true, recentCrashes: 3 });
    expect(policy.onCrash(1_000_000, 100)).toMatchObject({ crashLoop: false, recentCrashes: 1 });
  });

  it("resets the backoff after a healthy run", () => {
    const policy = createRestartPolicy();
    policy.onCrash(0, 100);
    policy.onCrash(1_000, 100);
    expect(policy.onCrash(2_000, 100).delayMs).toBe(4_000);
    expect(policy.onCrash(500_000, 120_000).delayMs).toBe(1_000);
  });
});
