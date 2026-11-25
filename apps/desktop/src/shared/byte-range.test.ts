import { describe, expect, it } from "vitest";
import { parseRangeHeader, resolveByteRange } from "./byte-range";

describe("Range header", () => {
  it("reads one byte range, open-ended, closed or a suffix", () => {
    expect(parseRangeHeader("bytes=0-")).toEqual({ kind: "range", start: 0, end: null });
    expect(parseRangeHeader("bytes=1000-1999")).toEqual({ kind: "range", start: 1000, end: 1999 });
    expect(parseRangeHeader("bytes=5-5")).toEqual({ kind: "range", start: 5, end: 5 });
    expect(parseRangeHeader("bytes=-500")).toEqual({ kind: "suffix", length: 500 });
    expect(parseRangeHeader(" Bytes = 12- ")).toEqual({ kind: "range", start: 12, end: null });
  });

  it("ignores what it does not serve, so the whole body is sent", () => {
    expect(parseRangeHeader(null)).toBeNull();
    // Another unit, several ranges, malformed or backwards ranges (RFC 9110 §14.2).
    for (const header of [
      "items=0-5",
      "bytes=0-5,10-20",
      "bytes=",
      "bytes=abc",
      "bytes=5",
      "bytes=--5",
      "bytes=1.5-2",
      "bytes=20-10",
      "0-5",
    ]) {
      expect(parseRangeHeader(header), header).toBeNull();
    }
  });

  it("keeps numbers past 2^53 safe instead of rounding them into a valid range", () => {
    expect(parseRangeHeader(`bytes=${"9".repeat(30)}-`)).toEqual({
      kind: "range",
      start: Number.MAX_SAFE_INTEGER,
      end: null,
    });
    expect(parseRangeHeader(`bytes=0-${"9".repeat(30)}`)).toEqual({
      kind: "range",
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
    });
  });

  it("resolves a range against the body's length, or finds it unsatisfiable", () => {
    const total = 1_000;
    expect(resolveByteRange({ kind: "range", start: 0, end: null }, total)).toEqual({
      start: 0,
      end: 999,
    });
    expect(resolveByteRange({ kind: "range", start: 100, end: 5_000 }, total)).toEqual({
      start: 100,
      end: 999,
    });
    expect(resolveByteRange({ kind: "range", start: 999, end: 999 }, total)).toEqual({
      start: 999,
      end: 999,
    });
    expect(resolveByteRange({ kind: "suffix", length: 10 }, total)).toEqual({
      start: 990,
      end: 999,
    });
    expect(resolveByteRange({ kind: "suffix", length: 5_000 }, total)).toEqual({
      start: 0,
      end: 999,
    });
    expect(resolveByteRange({ kind: "range", start: 1_000, end: null }, total)).toBeNull();
    expect(
      resolveByteRange({ kind: "range", start: Number.MAX_SAFE_INTEGER, end: null }, total),
    ).toBeNull();
    expect(resolveByteRange({ kind: "suffix", length: 0 }, total)).toBeNull();
    expect(resolveByteRange({ kind: "range", start: 0, end: null }, 0)).toBeNull();
  });
});
