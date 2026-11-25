// Writes the menu bar template images (resources/tray/*Template{,@2x}.png):
// a five-bar waveform while listening, and the same bars flattened to dots
// while paused. Template images are black with alpha; macOS tints them.
// Usage: node scripts/generate-tray-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const outDir = fileURLToPath(new URL("../resources/tray/", import.meta.url));
const POINTS = 18;
const SUPERSAMPLE = 8;

// Bar heights as a fraction of the drawable height.
const shapes = {
  tray: [0.36, 0.68, 1, 0.68, 0.36],
  trayPaused: [0.14, 0.14, 0.14, 0.14, 0.14],
};

function coverage(size, heights) {
  const scale = size * SUPERSAMPLE;
  const unit = scale / POINTS;
  const barWidth = 2 * unit;
  const gap = 1.5 * unit;
  const total = heights.length * barWidth + (heights.length - 1) * gap;
  const left = (scale - total) / 2;
  const maxHeight = 14 * unit;
  const center = scale / 2;
  const alpha = new Float64Array(size * size);
  for (let y = 0; y < scale; y++) {
    for (let x = 0; x < scale; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const bar = Math.floor((px - left) / (barWidth + gap));
      if (bar < 0 || bar >= heights.length) continue;
      const x0 = left + bar * (barWidth + gap);
      if (px > x0 + barWidth) continue;
      // Rounded caps: a capsule of radius barWidth / 2.
      const radius = barWidth / 2;
      const half = Math.max(heights[bar] * maxHeight, barWidth) / 2;
      const cx = x0 + radius;
      const dy = Math.max(0, Math.abs(py - center) - (half - radius));
      if ((px - cx) ** 2 + dy ** 2 <= radius ** 2) {
        alpha[Math.floor(y / SUPERSAMPLE) * size + Math.floor(x / SUPERSAMPLE)] += 1;
      }
    }
  }
  return alpha.map((hits) => Math.round((255 * hits) / SUPERSAMPLE ** 2));
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, alpha) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x++) rows[row + 1 + x * 4 + 3] = alpha[y * size + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const [name, heights] of Object.entries(shapes)) {
  for (const [suffix, size] of [
    ["", POINTS],
    ["@2x", POINTS * 2],
  ]) {
    const file = `${outDir}${name}Template${suffix}.png`;
    writeFileSync(file, png(size, coverage(size, heights)));
    console.log(`wrote ${file}`);
  }
}
