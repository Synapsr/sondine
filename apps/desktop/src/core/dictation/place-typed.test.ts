import { describe, expect, it } from "vitest";
import type { Typed } from "./histories";
import { placeTyped } from "./place-typed";

const sec = (value: number) => value * 1000;
const span = (from: number, to: number) => ({ startMs: sec(from), endMs: sec(to) });
const came = (
  at: number,
  text: string,
  patch: { toMs?: number; spokeMs?: number } = {},
): Typed => ({
  kind: "came",
  fromMs: sec(at),
  toMs: patch.toMs ?? sec(at),
  spokeMs: patch.spokeMs ?? null,
  text,
});

describe("placing what an app typed", () => {
  it("keeps the times an app gives", () => {
    const spoken: Typed = { kind: "spoken", startMs: 1, endMs: 2, text: "a" };
    expect(placeTyped([spoken], [])).toEqual([{ startMs: 1, endMs: 2, text: "a" }]);
  });

  it("gives a text the microphone span that ended before it, one each", () => {
    expect(
      placeTyped([came(32, "b"), came(12, "a")], [span(5, 10), span(25, 30), span(40, 45)]),
    ).toEqual([
      { ...span(5, 10), text: "a", watchedUntilMs: sec(12) },
      { ...span(25, 30), text: "b", watchedUntilMs: sec(32) },
    ]);
  });

  it("gives none when two spans ended since the text before: one was cancelled, or is late", () => {
    expect(placeTyped([came(32, "b")], [span(5, 10), span(25, 30)])).toEqual([]);
    // Two dictations before either text came.
    expect(placeTyped([came(31, "a"), came(33, "b")], [span(5, 10), span(25, 30)])).toEqual([]);
  });

  it("gives none to a text without a span, too late, or longer than its span", () => {
    expect(placeTyped([came(12, "a")], [span(10, 20)])).toEqual([]);
    expect(placeTyped([came(400, "a")], [span(5, 10)])).toEqual([]);
    expect(placeTyped([came(12, "a", { spokeMs: 9_000 })], [span(5, 10)])).toEqual([]);
    expect(placeTyped([came(12, "a", { spokeMs: 3_000 })], [span(5, 10)])).toHaveLength(1);
  });

  it("gives none to two texts of the same second", () => {
    const same = [came(12, "a", { toMs: 12_999 }), came(12, "b", { toMs: 12_999 })];
    expect(placeTyped(same, [span(5, 10)])).toEqual([]);
  });
});
