// The voice read's audio (ADR 034): 16 kHz PCM16 mono the recorder wrote to
// a file, cut into the stretches where the user's voice is, for
// `sondine-voice`, which pools its windows by length: silence between
// sentences would weigh as much as speech.

export const READ_RATE = 16_000;
/** 20 ms frames. */
const FRAME = 320;
/** A frame this far under the read's loud frames is a pause. */
const RELATIVE_DB = 30;
/** And never quieter than this. */
const FLOOR_DB = -50;
/** Pauses shorter than this stay inside a piece (between two words). */
const BRIDGE_FRAMES = 15;
/** Kept around each piece (a consonant's onset). */
const PAD_FRAMES = 5;
/** sondine-voice leaves out shorter pieces. */
const MIN_PIECE_SAMPLES = READ_RATE;

/** The level the live counter takes for voice: a block louder than this, in dBFS. */
export const VOICED_DB = -45;

export const toDb = (amplitude: number) => 20 * Math.log10(Math.max(amplitude, 1e-6));

/** The meter's 0 to 1, from an RMS amplitude: -60 dBFS is empty, -10 dBFS full. */
export function meterLevel(rms: number): number {
  return Math.min(1, Math.max(0, (toDb(rms) + 60) / 50));
}

/** PCM16 little-endian bytes as samples (a trailing odd byte is dropped). */
export function samplesOf(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Int16Array.from({ length: Math.floor(bytes.byteLength / 2) }, (_, index) =>
    view.getInt16(index * 2, true),
  );
}

/**
 * The stretches of a read where the voice is: 20 ms frames within 30 dB of
 * its loud frames (its 95th percentile) and above -50 dBFS, pauses under
 * 300 ms bridged, 100 ms kept around each, at least 1 s each.
 */
export function voicedPieces(samples: Int16Array): Int16Array[] {
  const frames = Math.floor(samples.length / FRAME);
  if (frames === 0) return [];
  const levels = Array.from({ length: frames }, (_, frame) => {
    let sum = 0;
    for (let index = frame * FRAME; index < (frame + 1) * FRAME; index++) {
      const value = (samples[index] ?? 0) / 32_768;
      sum += value * value;
    }
    return toDb(Math.sqrt(sum / FRAME));
  });
  const loud = levels.toSorted((a, b) => a - b)[Math.floor(0.95 * (frames - 1))] ?? FLOOR_DB;
  const gate = Math.max(FLOOR_DB, loud - RELATIVE_DB);
  const runs: [number, number][] = [];
  for (let frame = 0; frame < frames; frame++) {
    if ((levels[frame] ?? -Infinity) < gate) continue;
    const last = runs.at(-1);
    if (last !== undefined && frame - last[1] <= BRIDGE_FRAMES) last[1] = frame + 1;
    else runs.push([frame, frame + 1]);
  }
  return runs
    .map(([start, end]) =>
      samples.subarray(
        Math.max(0, start - PAD_FRAMES) * FRAME,
        Math.min(frames, end + PAD_FRAMES) * FRAME,
      ),
    )
    .filter((piece) => piece.length >= MIN_PIECE_SAMPLES);
}

/** One piece as sondine-voice reads it: base64 PCM16 little-endian. */
export function pieceBase64(piece: Int16Array): string {
  const bytes = Buffer.alloc(piece.length * 2);
  piece.forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  return bytes.toString("base64");
}
