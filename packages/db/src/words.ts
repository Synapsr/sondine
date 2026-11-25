/**
 * Word timings stored as one BLOB per segment (about 6 bytes per word instead
 * of one row each). Character offsets index the segment text; times are
 * milliseconds from the segment start.
 */
export interface WordTiming {
  readonly charStart: number;
  readonly charEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  /** 0..1, stored with 1/254 resolution. */
  readonly confidence?: number | null;
}

const formatVersion = 1;
const noConfidence = 255;

export class WordsFormatError extends Error {
  override readonly name = "WordsFormatError";
}

// Layout: u8 version, varint count, then per word:
// zigzag(charStart - previous charEnd), varint(charEnd - charStart),
// zigzag(startMs - previous endMs), varint(endMs - startMs), u8 confidence.
// Deltas from the previous end keep typical words to one byte per field
// except the duration.
export function packWords(words: readonly WordTiming[]): Uint8Array {
  const out: number[] = [formatVersion];
  writeVarint(out, words.length);
  let previousCharEnd = 0;
  let previousEndMs = 0;
  for (const word of words) {
    for (const value of [word.charStart, word.charEnd, word.startMs, word.endMs]) {
      if (!Number.isSafeInteger(value))
        throw new RangeError(`Word field is not an integer: ${value}`);
    }
    if (word.charEnd < word.charStart) throw new RangeError("Word charEnd is before charStart");
    if (word.endMs < word.startMs) throw new RangeError("Word endMs is before startMs");
    writeVarint(out, zigzag(word.charStart - previousCharEnd));
    writeVarint(out, word.charEnd - word.charStart);
    writeVarint(out, zigzag(word.startMs - previousEndMs));
    writeVarint(out, word.endMs - word.startMs);
    out.push(encodeConfidence(word.confidence));
    previousCharEnd = word.charEnd;
    previousEndMs = word.endMs;
  }
  return Uint8Array.from(out);
}

export function unpackWords(blob: Uint8Array): WordTiming[] {
  const reader = { bytes: blob, offset: 0 };
  const version = readByte(reader);
  if (version !== formatVersion) throw new WordsFormatError(`Unsupported words format ${version}`);
  const count = readVarint(reader);
  const words: WordTiming[] = [];
  let previousCharEnd = 0;
  let previousEndMs = 0;
  for (let index = 0; index < count; index++) {
    const charStart = previousCharEnd + unzigzag(readVarint(reader));
    const charEnd = charStart + readVarint(reader);
    const startMs = previousEndMs + unzigzag(readVarint(reader));
    const endMs = startMs + readVarint(reader);
    const confidenceByte = readByte(reader);
    words.push({
      charStart,
      charEnd,
      startMs,
      endMs,
      confidence: confidenceByte === noConfidence ? null : confidenceByte / 254,
    });
    previousCharEnd = charEnd;
    previousEndMs = endMs;
  }
  if (reader.offset !== blob.length)
    throw new WordsFormatError("Trailing bytes after word timings");
  return words;
}

function encodeConfidence(confidence: number | null | undefined): number {
  if (confidence === null || confidence === undefined) return noConfidence;
  if (!(confidence >= 0 && confidence <= 1))
    throw new RangeError(`Confidence out of range: ${confidence}`);
  return Math.round(confidence * 254);
}

const zigzag = (value: number): number => (value >= 0 ? value * 2 : -value * 2 - 1);
const unzigzag = (value: number): number => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);

function writeVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

interface Reader {
  readonly bytes: Uint8Array;
  offset: number;
}

function readByte(reader: Reader): number {
  const byte = reader.bytes[reader.offset];
  if (byte === undefined) throw new WordsFormatError("Truncated word timings");
  reader.offset += 1;
  return byte;
}

function readVarint(reader: Reader): number {
  let value = 0;
  let scale = 1;
  for (let shift = 0; shift < 8; shift++) {
    const byte = readByte(reader);
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 0x80;
  }
  throw new WordsFormatError("Varint too long");
}
