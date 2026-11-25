import { describe, expect, it } from "vitest";
import fixtures from "./qr.fixtures.json" with { type: "json" };
import { encodeQr, qrCapacity } from "./qr";

// `qr.fixtures.json` holds matrices made by libqrencode 4.1.1:
// `qrencode -l M -8 -m 0 -t ASCII -o - <text>`, one row of 0 and 1 per line.
// Each fixture's mask is read from its format information, then our matrix
// with that mask must be the same, module for module.

const rows = (modules: readonly (readonly boolean[])[]) =>
  modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

/** Error correction level and mask from the format bits around the top-left finder. */
function formatOf(expected: readonly string[]): { level: number; mask: number } {
  const at = (x: number, y: number) => (expected[y]![x] === "1" ? 1 : 0);
  const bits = [
    ...[0, 1, 2, 3, 4, 5].map((i) => at(8, i)),
    at(8, 7),
    at(8, 8),
    at(7, 8),
    ...[9, 10, 11, 12, 13, 14].map((i) => at(14 - i, 8)),
  ].reduce((value, bit, i) => value | (bit << i), 0);
  const data = (bits ^ 0x5412) >>> 10;
  return { level: data >>> 3, mask: data & 7 };
}

describe("encodeQr", () => {
  for (const fixture of fixtures) {
    it(`matches libqrencode for ${fixture.text.length} characters`, () => {
      const { level, mask } = formatOf(fixture.rows);
      expect(level).toBe(0); // M
      const matrix = encodeQr(fixture.text, { mask });
      expect(matrix.size).toBe(fixture.rows.length);
      expect(matrix.version).toBe((fixture.rows.length - 17) / 4);
      expect(rows(matrix.modules)).toEqual(fixture.rows);
    });
  }

  it("picks a mask by penalty and keeps the same data", () => {
    const text = fixtures[3]!.text;
    const chosen = encodeQr(text);
    expect(chosen.mask).toBeGreaterThanOrEqual(0);
    expect(chosen.mask).toBeLessThan(8);
    expect(rows(chosen.modules)).toEqual(rows(encodeQr(text, { mask: chosen.mask }).modules));
  });

  it("knows level M's capacities in byte mode", () => {
    expect(qrCapacity(1)).toBe(14);
    expect(qrCapacity(10)).toBe(213);
    expect(qrCapacity(40)).toBe(2331);
  });

  it("refuses more than version 40 holds", () => {
    expect(() => encodeQr("a".repeat(2332))).toThrow(RangeError);
    expect(encodeQr("a".repeat(2331)).version).toBe(40);
  });
});
