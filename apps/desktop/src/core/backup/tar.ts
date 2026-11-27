// The few parts of ustar a backup needs (ADR 048): regular files with a
// relative name and a size, in 512-byte blocks, ended by two empty blocks.
// Decrypted, a backup's body is an ordinary tar (`tar -tf` lists it).

export const BLOCK = 512;
/** Eleven octal digits: up to 8 GiB per file. */
const MAX_SIZE = 8 ** 11 - 1;

export class TarError extends Error {
  override readonly name = "TarError";
}

function field(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new TarError(`tar field too long: ${value}`);
  bytes.copy(target, offset);
}

const octal = (value: number, digits: number) => `${value.toString(8).padStart(digits, "0")}\0`;

/** The header block of a regular file `name` of `size` bytes. */
export function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) {
    throw new TarError(`file too large for the backup: ${name}`);
  }
  const header = Buffer.alloc(BLOCK);
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes <= 100) field(header, 0, 100, name);
  else {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) {
      throw new TarError(`name too long: ${name}`);
    }
    field(header, 0, 100, name.slice(cut + 1));
    field(header, 345, 155, name.slice(0, cut));
  }
  field(header, 100, 8, octal(0o600, 7));
  field(header, 108, 8, octal(0, 7));
  field(header, 116, 8, octal(0, 7));
  field(header, 124, 12, octal(size, 11));
  field(header, 136, 12, octal(Math.max(0, Math.floor(mtimeMs / 1000)), 11));
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** Zero bytes after a file of `size` bytes, up to its last block. */
export const tarPadding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** The two empty blocks that end an archive. */
export const tarEnd = (): Buffer => Buffer.alloc(BLOCK * 2);

const text = (block: Buffer, offset: number, length: number) => {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
};

/** A header block's file; null for an empty block (the end). */
export function parseTarHeader(block: Buffer): { name: string; size: number } | null {
  if (block.length !== BLOCK) throw new TarError("short tar block");
  if (block.every((byte) => byte === 0)) return null;
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  const stored = Number.parseInt(text(block, 148, 8).trim(), 8);
  if (stored !== sum) throw new TarError("tar header checksum");
  if (text(block, 257, 6) !== "ustar") throw new TarError("not a ustar header");
  const type = text(block, 156, 1);
  if (type !== "0" && type !== "") throw new TarError("only regular files are expected");
  const prefix = text(block, 345, 155);
  const base = text(block, 0, 100);
  const size = Number.parseInt(text(block, 124, 12).trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new TarError("tar size");
  return { name: prefix === "" ? base : `${prefix}/${base}`, size };
}
