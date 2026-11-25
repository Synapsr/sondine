import { describe, expect, it } from "vitest";
import { meterLevel, samplesOf, voicedPieces } from "./voice-read-audio";

const RATE = 16_000;

/** `[seconds, amplitude]` stretches of a 220 Hz tone, one after the other. */
function signal(stretches: readonly (readonly [number, number])[]): Int16Array {
  const out: number[] = [];
  for (const [seconds, amplitude] of stretches) {
    for (let index = 0; index < seconds * RATE; index++) {
      out.push(Math.round(amplitude * 32_767 * Math.sin((2 * Math.PI * 220 * index) / RATE)));
    }
  }
  return Int16Array.from(out);
}

describe("the voice read's audio", () => {
  it("keeps the voiced stretches, bridging short pauses and dropping long silences", () => {
    const pieces = voicedPieces(
      signal([
        [1, 0],
        [2, 0.3],
        [0.2, 0],
        [2, 0.3],
        [3, 0.0005],
        [1.5, 0.25],
        [0.5, 0],
        [0.5, 0.3],
      ]),
    );
    // The first two sentences are one piece (a 200 ms pause), the next its own,
    // the last too short; 100 ms kept around each.
    expect(pieces.map((piece) => Math.round((piece.length / RATE) * 10) / 10)).toEqual([4.4, 1.7]);
  });

  it("finds nothing in silence", () => {
    expect(voicedPieces(signal([[5, 0]]))).toEqual([]);
    expect(voicedPieces(new Int16Array())).toEqual([]);
  });

  it("reads PCM16 little-endian and maps a level to the meter", () => {
    expect([...samplesOf(Uint8Array.from([0x01, 0x00, 0xff, 0xff, 0x07]))]).toEqual([1, -1]);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0.01)).toBeCloseTo(0.4, 5);
  });
});
