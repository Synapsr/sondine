import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertToWav, DecodeError, IMPORT_SAMPLE_RATE, monoBlocks, readWavLayout } from "./decode";

const dir = mkdtempSync(join(tmpdir(), "sondine-decode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A 16-bit WAV of interleaved frames. */
function wav(path: string, rate: number, channels: number, samples: readonly number[]): void {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

function decoded(path: string, blockFrames = 4_000): Int16Array[] {
  const fd = openSync(path, "r");
  try {
    return [...monoBlocks(fd, readWavLayout(fd, fstatSync(fd).size), blockFrames)];
  } finally {
    closeSync(fd);
  }
}

describe("import decoding", () => {
  it("averages the channels of a stereo file into mono blocks", async () => {
    const input = join(dir, "stereo.wav");
    const frames = IMPORT_SAMPLE_RATE;
    wav(
      input,
      IMPORT_SAMPLE_RATE,
      2,
      Array.from({ length: frames * 2 }, (_, i) => (i % 2 === 0 ? 1_000 : 3_000)),
    );
    const output = join(dir, "stereo-16k.wav");
    await convertToWav(input, output);
    const blocks = decoded(output);
    expect(blocks.map((block) => block.length)).toEqual([4_000, 4_000, 4_000, 4_000]);
    expect(blocks.every((block) => block.every((sample) => Math.abs(sample - 2_000) <= 1))).toBe(
      true,
    );
  });

  it("resamples a compressed recording to 16 kHz", async () => {
    const input = join(dir, "speech.m4a");
    execFileSync("/usr/bin/say", ["-o", input, "--file-format=m4af", "Bonjour Sondine"]);
    const output = join(dir, "speech-16k.wav");
    await convertToWav(input, output);
    const fd = openSync(output, "r");
    const layout = readWavLayout(fd, fstatSync(fd).size);
    closeSync(fd);
    expect(layout.sampleRate).toBe(IMPORT_SAMPLE_RATE);
    const samples = decoded(output).reduce((sum, block) => sum + block.length, 0);
    expect(samples).toBeGreaterThan(IMPORT_SAMPLE_RATE / 2);
  });

  it("says a file it cannot read is unreadable", async () => {
    const input = join(dir, "notes.txt");
    writeFileSync(input, "not audio");
    await expect(convertToWav(input, join(dir, "notes.wav"))).rejects.toBeInstanceOf(DecodeError);
  });
});
