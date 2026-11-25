import { DBFS_FLOOR } from "./constants";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard padded base64, without Node or DOM globals. */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const triple =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    text += ALPHABET.charAt((triple >>> 18) & 63) + ALPHABET.charAt((triple >>> 12) & 63);
    text += remaining > 1 ? ALPHABET.charAt((triple >>> 6) & 63) : "=";
    text += remaining > 2 ? ALPHABET.charAt(triple & 63) : "=";
  }
  return text;
}

/** Decodes standard padded base64; undefined when the text is not valid base64. */
export function base64ToBytes(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0) return undefined;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let index = 0; index < text.length; index += 4) {
    let triple = 0;
    for (let position = index; position < index + 4; position += 1) {
      // Trailing `=` decode as zero bits; an `=` anywhere else is invalid.
      const digit = position >= text.length - padding ? 0 : ALPHABET.indexOf(text.charAt(position));
      if (digit === -1) return undefined;
      triple = (triple << 6) | digit;
    }
    for (let shift = 16; shift >= 0 && written < bytes.length; shift -= 8) {
      bytes[written] = (triple >>> shift) & 0xff;
      written += 1;
    }
  }
  return bytes;
}

/**
 * Envelope values travel as base64 of little-endian Float32. This is the only
 * binary payload allowed in JSON, and only in spool manifests: 100 floats per
 * second per track, where base64 is about 4× smaller than decimal text.
 */
export function encodeEnvelopeValues(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(index * 4, values[index] ?? Number.NaN, true);
  }
  return bytesToBase64(bytes);
}

/** Decodes base64 Float32 LE; undefined when the text is not base64 of whole floats. */
export function decodeEnvelopeValues(data: string): Float32Array | undefined {
  const bytes = base64ToBytes(data);
  if (bytes === undefined || bytes.byteLength % 4 !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = view.getFloat32(index * 4, true);
  }
  return values;
}

/** Index of the first value outside [DBFS_FLOOR, 0] or not finite, or -1. */
export function findInvalidEnvelopeValue(values: Float32Array): number {
  return values.findIndex((value) => !(value >= DBFS_FLOOR && value <= 0));
}
