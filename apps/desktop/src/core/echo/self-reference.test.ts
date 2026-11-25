import { describe, expect, it } from "vitest";
import type { SelfEnvelopeEvent } from "@sondine/protocol";
import { SELF_REFERENCE_RETENTION_MS, SelfReference } from "./self-reference";

const event = (startMs: number, levels: readonly number[]): SelfEnvelopeEvent => ({
  type: "self.envelope",
  start: { hostTicks: BigInt(startMs) * 24_000n, continuousNs: BigInt(startMs) * 1_000_000n },
  levels: [...levels],
});

describe("self:playback reference", () => {
  it("places frames on a 10 ms grid, silence as holes, the rest as not captured", () => {
    const reference = new SelfReference();
    reference.add(event(1_000, [-300, -1200, -255]));
    reference.add(event(1_050, [-400]));
    expect(reference.latestMs).toBe(1_060);
    const { reference: envelope, captured } = reference.window(990, 8);
    expect(envelope.startMs).toBe(990);
    expect([...captured]).toEqual([0, 1, 1, 1, 0, 0, 1, 0]);
    expect(envelope.db[1]).toBeCloseTo(-30);
    expect(Number.isNaN(envelope.db[2] ?? 0)).toBe(true);
    expect(envelope.db[3]).toBeCloseTo(-25.5);
    expect(envelope.db[6]).toBeCloseTo(-40);
    expect(Number.isNaN(envelope.db[0] ?? 0)).toBe(true);
  });

  it("forgets what is older than its retention behind the newest frame", () => {
    const reference = new SelfReference();
    reference.add(
      event(
        0,
        Array.from({ length: 100 }, () => -300),
      ),
    );
    reference.add(event(SELF_REFERENCE_RETENTION_MS + 2_000, [-300]));
    expect(reference.frames).toBe(1);
    expect([...reference.window(0, 100).captured].every((value) => value === 0)).toBe(true);
    reference.clear();
    expect(reference.latestMs).toBeNull();
  });

  it("takes events out of order", () => {
    const reference = new SelfReference();
    reference.add(event(2_000, [-300]));
    reference.add(event(1_000, [-300]));
    expect(reference.latestMs).toBe(2_010);
    expect([...reference.window(1_000, 101).captured].filter((value) => value === 1)).toHaveLength(
      2,
    );
  });
});
