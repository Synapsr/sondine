import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  encodePcm16Mono,
  finalizeMix,
  mixAt,
  normalizeRms,
  readPcm16Mono,
  rms,
  seededRandom,
} from "./signal.ts";

function chunk(id: string, payload: Buffer) {
  const bytes = Buffer.alloc(8 + payload.length + (payload.length % 2));
  bytes.write(id, 0, "ascii");
  bytes.writeUInt32LE(payload.length, 4);
  payload.copy(bytes, 8);
  return bytes;
}

function riff(chunks: Buffer[]) {
  const payload = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(payload.length + 4, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, payload]);
}

function format() {
  return encodePcm16Mono(new Float32Array()).subarray(20, 36);
}

describe("PCM16 WAV", () => {
  it("roundtrips every int16 value without rescaling its positive half", () => {
    const pcm = Buffer.alloc(65_536 * 2);
    for (let index = 0; index < 65_536; index += 1) pcm.writeInt16LE(index - 32_768, index * 2);
    const wav = riff([chunk("fmt ", format()), chunk("data", pcm)]);
    expect(encodePcm16Mono(readPcm16Mono(wav))).toEqual(wav);
  });

  it("accepts silence, empty audio, unknown odd chunks and their padding", () => {
    const wav = riff([
      chunk("JUNK", Buffer.from([7, 8, 9])),
      chunk("fmt ", format()),
      chunk("LIST", Buffer.from("test")),
      chunk("data", Buffer.alloc(6)),
    ]);
    expect(readPcm16Mono(wav)).toEqual(new Float32Array(3));
    expect(readPcm16Mono(encodePcm16Mono(new Float32Array()))).toHaveLength(0);
  });

  it("accepts a PCM format with an explicitly empty extension", () => {
    expect(
      readPcm16Mono(
        riff([
          chunk("fmt ", Buffer.concat([format(), Buffer.alloc(2)])),
          chunk("data", Buffer.alloc(2)),
        ]),
      ),
    ).toEqual(new Float32Array(1));
  });

  it("refuses other formats and inconsistent byte rate/block alignment", () => {
    const edits = [
      { offset: 0, value: 3 },
      { offset: 2, value: 2 },
      { offset: 4, value: 8_000 },
      { offset: 8, value: 16_000 },
      { offset: 12, value: 4 },
      { offset: 14, value: 8 },
    ];
    for (const edit of edits) {
      const invalid = Buffer.from(format());
      invalid.writeUInt16LE(edit.value, edit.offset);
      expect(() =>
        readPcm16Mono(riff([chunk("fmt ", invalid), chunk("data", Buffer.alloc(2))])),
      ).toThrow(/PCM16/);
    }
  });

  it("refuses malformed format, data, duplicates and missing required chunks", () => {
    const fmt = chunk("fmt ", format());
    const data = chunk("data", Buffer.alloc(2));
    for (const chunks of [
      [fmt],
      [data],
      [fmt, fmt, data],
      [fmt, data, data],
      [chunk("fmt ", Buffer.alloc(15)), data],
      [chunk("fmt ", Buffer.concat([format(), Buffer.alloc(1)])), data],
      [chunk("fmt ", Buffer.concat([format(), Buffer.from([1, 0])])), data],
      [fmt, chunk("data", Buffer.alloc(1))],
    ]) {
      expect(() => readPcm16Mono(riff(chunks))).toThrow();
    }
  });

  it("refuses RIFF length mismatches, partial headers and truncated payload/padding", () => {
    const valid = encodePcm16Mono(new Float32Array([0.25]));
    expect(() => readPcm16Mono(valid.subarray(0, 10))).toThrow(/RIFF/);
    expect(() => readPcm16Mono(Buffer.concat([valid, Buffer.from([0])]))).toThrow(/length/);
    expect(() => readPcm16Mono(valid.subarray(0, valid.length - 1))).toThrow(/length/);
    expect(() => readPcm16Mono(riff([Buffer.from("data")]))).toThrow(/header/);
    expect(() => readPcm16Mono(riff([chunk("data", Buffer.alloc(2)).subarray(0, 9)]))).toThrow(
      /Truncated/,
    );
    expect(() => readPcm16Mono(riff([chunk("JUNK", Buffer.from([1])).subarray(0, 9)]))).toThrow(
      /padding/,
    );
    const wrongSignature = Buffer.from(valid);
    wrongSignature.write("RIFX", 0, "ascii");
    expect(() => readPcm16Mono(wrongSignature)).toThrow(/RIFF/);
    const highBitSignature = Buffer.from(valid);
    highBitSignature[0] = 0xd2;
    expect(() => readPcm16Mono(highBitSignature)).toThrow(/RIFF/);
  });

  it("refuses nonfinite and unrepresentable samples instead of clipping", () => {
    for (const invalid of [NaN, Infinity, -Infinity, -1.01, 1, 1.01]) {
      expect(() => encodePcm16Mono(new Float32Array([0, invalid]))).toThrow(RangeError);
    }
  });
});

describe("constant gains and mixing", () => {
  it("measures RMS, including empty and silent signals", () => {
    expect(rms(new Float32Array())).toBe(0);
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBe(0.5);
    expect(() => rms(new Float32Array([NaN]))).toThrow(/finite/);
  });

  it("normalizes to the requested RMS without mutating the original", () => {
    const original = new Float32Array([0.25, -0.25]);
    const result = normalizeRms(original, -12);
    expect(rms(result.samples)).toBeCloseTo(10 ** (-12 / 20), 7);
    expect(result.appliedGain).toBeCloseTo(10 ** (-12 / 20) / 0.25, 10);
    expect(result.limitedByPeak).toBe(false);
    expect(original).toEqual(new Float32Array([0.25, -0.25]));
  });

  it("reports a peak-limited target and never boosts silence", () => {
    const limited = normalizeRms(new Float32Array([1, 0, 0, 0]), -3);
    expect(limited.appliedGain).toBe(0.9);
    expect(limited.limitedByPeak).toBe(true);
    expect(rms(limited.samples)).toBeCloseTo(0.45, 7);
    const silence = new Float32Array(3);
    const untouched = normalizeRms(silence, -12);
    expect(untouched).toEqual({ samples: silence, appliedGain: 1, limitedByPeak: false });
    expect(untouched.samples).not.toBe(silence);
  });

  it("keeps floating-point overrange values until one common attenuation preserves SNR", () => {
    const mix = new Float32Array(4);
    mixAt(mix, new Float32Array([1.5, 0, -1.5, 0]), 0, 1);
    mixAt(mix, new Float32Array([0.75, 0, -0.75]), 1, 1);
    expect(mix).toEqual(new Float32Array([1.5, 0.75, -1.5, -0.75]));
    expect(() => encodePcm16Mono(mix)).toThrow();
    const final = finalizeMix(mix);
    expect(final.appliedGain).toBe(0.95 / 1.5);
    expect(final.samples[0]).toBeCloseTo(0.95, 7);
    expect(final.samples[1]).toBeCloseTo(0.475, 7);
    const signalRms = rms(final.samples.filter((_, index) => index % 2 === 0));
    const noiseRms = rms(final.samples.filter((_, index) => index % 2 === 1));
    expect(signalRms / noiseRms).toBeCloseTo(2, 7);
    expect(() => encodePcm16Mono(final.samples)).not.toThrow();
    expect(mix[0]).toBe(1.5);
  });

  it("applies offsets and gain with a frozen source even when views overlap", () => {
    const target = new Float32Array([1, 2, 3]);
    mixAt(target, target.subarray(0, 2), 1, 0.5);
    expect(target).toEqual(new Float32Array([1, 2.5, 4]));
  });

  it("rejects invalid ranges, gains and float overflow before changing the target", () => {
    const target = new Float32Array([0.25, 0.5]);
    for (const offset of [-1, 0.5, 2, NaN, Infinity]) {
      expect(() => mixAt(target, new Float32Array([0.5]), offset, 1)).toThrow(RangeError);
    }
    expect(() => mixAt(target, new Float32Array([0.5, 0.5]), 1, 1)).toThrow(RangeError);
    expect(() => mixAt(target, new Float32Array([0.5]), 0, Infinity)).toThrow(RangeError);
    expect(() => mixAt(target, new Float32Array([0.5, NaN]), 0, 1)).toThrow(RangeError);
    expect(() => mixAt(target, new Float32Array([0.5, 1]), 0, 1e40)).toThrow(RangeError);
    expect(target).toEqual(new Float32Array([0.25, 0.5]));
  });

  it("does not amplify an already safe mix and refuses invalid normalization inputs", () => {
    const quiet = new Float32Array([0.2, -0.1]);
    expect(finalizeMix(quiet)).toEqual({ samples: quiet, appliedGain: 1 });
    expect(finalizeMix(quiet).samples).not.toBe(quiet);
    expect(finalizeMix(new Float32Array()).appliedGain).toBe(1);
    for (const db of [NaN, Infinity, -Infinity, -100_000]) {
      expect(() => normalizeRms(quiet, db)).toThrow(RangeError);
    }
    for (const peak of [0, -0.1, 1.1, NaN]) {
      expect(() => normalizeRms(quiet, -12, peak)).toThrow(RangeError);
    }
    expect(() => finalizeMix(new Float32Array([Infinity]))).toThrow(RangeError);
    expect(() => normalizeRms(new Float32Array([Infinity]), -12)).toThrow(RangeError);
  });
});

describe("seeded randomness", () => {
  it("pins Mulberry32 output and reproduces a sequence independently", () => {
    const random = seededRandom(1);
    expect([random(), random(), random()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
    const first = seededRandom(20261106);
    const second = seededRandom(20261106);
    expect(Array.from({ length: 100 }, first)).toEqual(Array.from({ length: 100 }, second));
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it("accepts the uint32 endpoints and rejects ambiguous seed coercion", () => {
    for (const seed of [0, 0xffff_ffff]) {
      const random = seededRandom(seed);
      for (let index = 0; index < 100; index += 1) {
        const value = random();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
    for (const seed of [-1, 0.5, 0x1_0000_0000, Infinity, NaN]) {
      expect(() => seededRandom(seed)).toThrow(RangeError);
    }
  });
});
