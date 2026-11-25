import { Buffer } from "node:buffer";

const SAMPLE_RATE = 16_000;
const PCM_SCALE = 32_768;
const MAX_PCM_SAMPLE = 32_767 / PCM_SCALE;

function inspectSignal(samples: Float32Array) {
  let peak = 0;
  let sumSquares = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new RangeError("Audio samples must be finite");
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
  }
  return { peak, rms: samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length) };
}

/** Decode only little-endian RIFF/WAVE PCM16 mono at 16 kHz, without resampling. */
export function readPcm16Mono(bytes: Buffer): Float32Array {
  if (
    bytes.length < 12 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WAVE"
  ) {
    throw new Error("Expected a RIFF/WAVE file");
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error("RIFF length does not match the file length");
  }

  let hasFormat = false;
  let dataOffset: number | undefined;
  let dataLength = 0;
  let offset = 12;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error("Truncated WAV chunk header");
    const id = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length % 2);
    if (paddedEnd > bytes.length) throw new Error("Truncated WAV chunk or missing padding");

    if (id === "fmt ") {
      if (hasFormat) throw new Error("Duplicate WAV format chunk");
      if (length < 16 || length === 17) throw new Error("Invalid WAV format chunk length");
      if (length > 16 && bytes.readUInt16LE(start + 16) !== length - 18) {
        throw new Error("Invalid WAV format extension length");
      }
      if (
        bytes.readUInt16LE(start) !== 1 ||
        bytes.readUInt16LE(start + 2) !== 1 ||
        bytes.readUInt32LE(start + 4) !== SAMPLE_RATE ||
        bytes.readUInt32LE(start + 8) !== SAMPLE_RATE * 2 ||
        bytes.readUInt16LE(start + 12) !== 2 ||
        bytes.readUInt16LE(start + 14) !== 16
      ) {
        throw new Error("Expected PCM16 mono audio at 16000 Hz with consistent byte rate");
      }
      hasFormat = true;
    } else if (id === "data") {
      if (dataOffset !== undefined) throw new Error("Duplicate WAV data chunk");
      if (length % 2 !== 0) throw new Error("PCM16 data length must be even");
      dataOffset = start;
      dataLength = length;
    }
    offset = paddedEnd;
  }
  if (!hasFormat || dataOffset === undefined) throw new Error("Missing WAV format or data chunk");
  const samples = new Float32Array(dataLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(dataOffset + index * 2) / PCM_SCALE;
  }
  return samples;
}

/** Encode using the PCM /32768 convention; +1 is unrepresentable and rejected. */
export function encodePcm16Mono(samples: Float32Array): Buffer {
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < -1 || sample > MAX_PCM_SAMPLE) {
      throw new RangeError("PCM16 samples must be finite and within [-1, 32767/32768]");
    }
  }
  const dataLength = samples.length * 2;
  if (dataLength + 36 > 0xffff_ffff) throw new RangeError("Audio is too large for RIFF/WAVE");
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataLength, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataLength, 40);
  let offset = 44;
  for (const sample of samples) {
    bytes.writeInt16LE(Math.round(sample * PCM_SCALE), offset);
    offset += 2;
  }
  return bytes;
}

export function rms(samples: Float32Array): number {
  return inspectSignal(samples).rms;
}

/** Constant gain only. Silence stays silent; peak limiting never clips individual samples. */
export function normalizeRms(samples: Float32Array, targetDbFS: number, peakLimit = 0.9) {
  const targetRms = 10 ** (targetDbFS / 20);
  if (!Number.isFinite(targetDbFS) || !Number.isFinite(targetRms) || targetRms <= 0) {
    throw new RangeError("Target dBFS must yield a finite positive RMS");
  }
  if (!Number.isFinite(peakLimit) || peakLimit <= 0 || peakLimit > 1) {
    throw new RangeError("Peak limit must be within (0, 1]");
  }
  const signal = inspectSignal(samples);
  if (signal.rms === 0) {
    return { samples: samples.slice(), appliedGain: 1, limitedByPeak: false };
  }
  const desiredGain = targetRms / signal.rms;
  const peakGain = peakLimit / signal.peak;
  const appliedGain = Math.min(desiredGain, peakGain);
  return {
    samples: samples.map((sample) => sample * appliedGain),
    appliedGain,
    limitedByPeak: desiredGain > peakGain,
  };
}

/** Mulberry32, with an explicit uint32 seed and values in [0, 1). */
export function seededRandom(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Seed must be a uint32 integer");
  }
  let state = seed;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** Add into target in place. Preflight the whole operation so a refusal leaves target intact. */
export function mixAt(
  target: Float32Array,
  source: Float32Array,
  offsetSamples: number,
  gain: number,
): void {
  if (
    !Number.isSafeInteger(offsetSamples) ||
    offsetSamples < 0 ||
    offsetSamples > target.length ||
    source.length > target.length - offsetSamples
  ) {
    throw new RangeError("Mix lies outside the target sample range");
  }
  if (!Number.isFinite(gain)) throw new RangeError("Mix gain must be finite");
  inspectSignal(target);
  inspectSignal(source);
  // A separate buffer also makes overlapping source/target views deterministic.
  const mixed = new Float32Array(source.length);
  let index = 0;
  for (const sample of source) {
    const previous = target[offsetSamples + index];
    if (previous === undefined) throw new RangeError("Mix lies outside the target sample range");
    const value = Math.fround(previous + sample * gain);
    if (!Number.isFinite(value)) throw new RangeError("Mix exceeds the finite Float32 range");
    mixed[index] = value;
    index += 1;
  }
  target.set(mixed, offsetSamples);
}

/** A single common attenuation preserves the mixture's SNR, up to Float32 rounding. */
export function finalizeMix(samples: Float32Array) {
  const { peak } = inspectSignal(samples);
  const appliedGain = peak > 0.95 ? 0.95 / peak : 1;
  return { samples: samples.map((sample) => sample * appliedGain), appliedGain };
}
