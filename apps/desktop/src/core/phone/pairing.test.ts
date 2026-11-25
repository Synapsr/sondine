import { describe, expect, it } from "vitest";
import { PAIRING_ANSWER_MS, PAIRING_TOKEN_MS } from "@sondine/protocol";
import { makePairingDesk, type PairingClock, type PairingOutcome } from "./pairing";
import { pairingDigits } from "./pairing-digits";

const PIN = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const PHONE = "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b";
const OTHER = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";

/** A clock moved by hand: timers fire when it passes them. */
function manualClock(): PairingClock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    after(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].toSorted((a, b) => a.at - b.at)) {
        if (timer.at <= now && timers.delete(timer)) timer.fn();
      }
    },
  };
}

function desk() {
  const clock = manualClock();
  let changes = 0;
  const paired: string[] = [];
  const pairing = makePairingDesk({
    clock,
    complete(request) {
      paired.push(request.deviceId);
      return { credential: `sdp_${"A".repeat(43)}`, macId: OTHER };
    },
    changed: () => {
      changes += 1;
    },
  });
  return { clock, pairing, paired, changes: () => changes };
}

const ask = (deviceId: string, token: string) => ({ token, deviceId, deviceName: "iPhone de Téo" });

describe("a pairing", () => {
  it("shows the six digits once a phone asks, and pairs on « Appairer »", async () => {
    const { pairing, paired } = desk();
    const token = pairing.open(PIN);
    expect(pairing.view()).toMatchObject({ phase: "waiting", token });
    const outcome = pairing.present(ask(PHONE, token), {});
    expect(pairing.view()).toMatchObject({
      phase: "asked",
      deviceName: "iPhone de Téo",
      digits: pairingDigits(token, PHONE, PIN),
    });
    expect(pairing.answer(true)).toBe(true);
    await expect(outcome).resolves.toEqual({
      kind: "paired",
      answer: { credential: `sdp_${"A".repeat(43)}`, macId: OTHER },
    });
    expect(paired).toEqual([PHONE]);
    expect(pairing.view()).toBeNull();
  });

  it("consumes its token at the first presentation: a second phone, or a second try, is refused", async () => {
    const { pairing } = desk();
    const token = pairing.open(PIN);
    const first = pairing.present(ask(PHONE, token), {});
    await expect(pairing.present(ask(OTHER, token), {})).resolves.toEqual({
      kind: "refused",
      error: "pairing-used",
    });
    pairing.answer(false);
    await expect(first).resolves.toEqual({ kind: "refused", error: "pairing-refused" });
    await expect(pairing.present(ask(PHONE, token), {})).resolves.toEqual({
      kind: "refused",
      error: "pairing-used",
    });
  });

  it("refuses an expired token, and closes after 2 minutes without an answer", async () => {
    const { pairing, clock, changes } = desk();
    const expired = pairing.open(PIN);
    clock.advance(PAIRING_TOKEN_MS);
    expect(pairing.view()).toBeNull();
    await expect(pairing.present(ask(PHONE, expired), {})).resolves.toEqual({
      kind: "refused",
      error: "pairing-closed",
    });
    const token = pairing.open(PIN);
    const before = changes();
    const held: Promise<PairingOutcome> = pairing.present(ask(PHONE, token), {});
    clock.advance(PAIRING_ANSWER_MS - 1);
    expect(pairing.view()?.phase).toBe("asked");
    clock.advance(1);
    await expect(held).resolves.toEqual({ kind: "refused", error: "pairing-closed" });
    expect(pairing.view()).toBeNull();
    expect(changes()).toBeGreaterThan(before);
    expect(pairing.answer(true)).toBe(false);
  });

  it("ends when its connection closes, and one pairing replaces another", async () => {
    const { pairing } = desk();
    const connection = {};
    const token = pairing.open(PIN);
    const held = pairing.present(ask(PHONE, token), connection);
    pairing.connectionClosed({});
    expect(pairing.view()?.phase).toBe("asked");
    pairing.connectionClosed(connection);
    await expect(held).resolves.toEqual({ kind: "refused", error: "pairing-closed" });
    const old = pairing.open(PIN);
    const fresh = pairing.open(PIN);
    expect(fresh).not.toBe(old);
    await expect(pairing.present(ask(PHONE, old), {})).resolves.toEqual({
      kind: "refused",
      error: "pairing-closed",
    });
  });
});
