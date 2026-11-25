let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table !== undefined) return table;
  table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

/**
 * CRC-32/ISO-HDLC (reflected polynomial 0xEDB88320, init and xorout
 * 0xFFFFFFFF), the same value as zlib's `crc32()`. Spool commit records carry
 * it for each committed block. Pass the previous result as `value` to
 * continue over several buffers. Plain TypeScript so the package needs no
 * Node built-ins.
 */
export function crc32(bytes: Uint8Array, value = 0): number {
  const lookup = crcTable();
  let crc = ~value >>> 0;
  for (const byte of bytes) {
    crc = (lookup[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}
