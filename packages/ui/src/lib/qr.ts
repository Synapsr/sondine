// A QR code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1 to 40, written here so the pairing code needs no dependency.
// The tables and the mask penalty follow the standard; `qr.test.ts`
// compares the matrices with fixtures made by libqrencode.

/** A square of modules, `true` for dark, row by row. */
export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

// Level M, indexed by version (index 0 unused).
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
/** Level M in the format information. */
const FORMAT_LEVEL_M = 0b00;

/** Modules left for data and error correction once the function patterns are drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;
}

/** Bytes a version holds in byte mode at level M. */
export function qrCapacity(version: number): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      const next = j + 1 < degree ? result[j + 1]! : 0;
      result[j] = multiply(result[j]!, root) ^ next;
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] = result[i]! ^ multiply(coefficient, factor);
    });
  }
  return result;
}

/** The data codewords: mode, count, bytes, terminator and padding. */
function dataStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

/** Splits into blocks, adds each block's error correction and interleaves. */
function interleave(data: readonly number[], version: number): number[] {
  const blockCount = BLOCKS[version]!;
  const eccLength = ECC_PER_BLOCK[version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks: { data: number[]; ecc: number[] }[] = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: block, ecc: rsRemainder(block, divisor) });
  }
  const result: number[] = [];
  for (let i = 0; i <= shortLength - eccLength; i++) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]!);
  }
  for (let i = 0; i < eccLength; i++) for (const block of blocks) result.push(block.ecc[i]!);
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((cy, i) => {
      positions.forEach((cx, j) => {
        // Skip the three corners the finder patterns hold.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      });
    });
    this.drawFormat(0); // reserves the format areas; drawn again with the mask
    this.drawVersion();
  }

  drawFormat(mask: number) {
    const data = (FORMAT_LEVEL_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(codewords: readonly number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (this.reserved[y]![x] || i >= codewords.length * 8) continue;
          this.dark[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  applyMask(mask: number) {
    const test = MASKS[mask]!;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y]![x] && test(x, y)) this.dark[y]![x] = !this.dark[y]![x];
      }
    }
  }

  /** The standard's four penalty rules; the lowest score wins. */
  penalty(): number {
    const { size, dark } = this;
    let result = 0;
    const lines = (horizontal: boolean) => {
      for (let a = 0; a < size; a++) {
        let run = 0;
        let previous = false;
        const line: boolean[] = [];
        for (let b = 0; b < size; b++) {
          const module = horizontal ? dark[a]![b]! : dark[b]![a]!;
          line.push(module);
          if (b > 0 && module === previous) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            run = 1;
          }
          previous = module;
        }
        // 1:1:3:1:1 with four light modules on one side, the quiet zone counting as light.
        const at = (i: number) => (i < 0 || i >= size ? false : line[i]!);
        for (let b = -4; b < size; b++) {
          const core =
            at(b) && !at(b + 1) && at(b + 2) && at(b + 3) && at(b + 4) && !at(b + 5) && at(b + 6);
          if (!core) continue;
          const before = [1, 2, 3, 4].every((k) => !at(b - k));
          const after = [7, 8, 9, 10].every((k) => !at(b + k));
          if (before || after) result += 40;
        }
      }
    };
    lines(true);
    lines(false);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const module = dark[y]![x];
        if (
          module === dark[y]![x + 1] &&
          module === dark[y + 1]![x] &&
          module === dark[y + 1]![x + 1]
        ) {
          result += 3;
        }
      }
    }
    let darkCount = 0;
    for (const row of dark) for (const module of row) if (module) darkCount++;
    const total = size * size;
    result += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

/**
 * Encodes `text` (UTF-8) in the smallest version that holds it, at level M.
 * `mask` forces one of the eight masks; otherwise the lowest penalty wins.
 * Throws when the text is longer than version 40 holds (2,331 bytes).
 */
export function encodeQr(text: string, options: { mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (qrCapacity(version) < bytes.length) {
    version++;
    if (version > 40) throw new RangeError("Too long for a QR code.");
  }
  const codewords = interleave(dataStream(bytes, version), version);
  const draw = (mask: number) => {
    const grid = new Grid(version);
    grid.drawFunctionPatterns();
    grid.drawCodewords(codewords);
    grid.applyMask(mask);
    grid.drawFormat(mask);
    return grid;
  };
  let best: { grid: Grid; mask: number; penalty: number } | null = null;
  const masks = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  for (const mask of masks) {
    const grid = draw(mask);
    const penalty = masks.length === 1 ? 0 : grid.penalty();
    if (best === null || penalty < best.penalty) best = { grid, mask, penalty };
  }
  const { grid, mask } = best!;
  return { size: grid.size, version, mask, modules: grid.dark };
}
