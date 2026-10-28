// Rasterises the extension icons into src/icons/. Deterministic: same input,
// same bytes, so the PNGs can be committed and reviewed as generated assets.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'src', 'icons');
const SIZES = [16, 32, 48, 128];
const ACCENT = [26, 115, 232, 255];
const INK = [255, 255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(size, rgba) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = Buffer.alloc(size * size * 4);
  }

  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a === 0) return;
    const i = (y * this.size + x) * 4;
    const dstA = this.data[i + 3] / 255;
    const srcA = a / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    const blend = (source, dest) => Math.round((source * srcA + dest * dstA * (1 - srcA)) / outA);
    this.data[i] = blend(r, this.data[i]);
    this.data[i + 1] = blend(g, this.data[i + 1]);
    this.data[i + 2] = blend(b, this.data[i + 2]);
    this.data[i + 3] = Math.round(outA * 255);
  }

  rect(x, y, width, height, color) {
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) this.set(px, py, color);
    }
  }

  roundRect(x, y, width, height, radius, color) {
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
        const cx = Math.max(x + radius, Math.min(px + 0.5, x + width - radius));
        const cy = Math.max(y + radius, Math.min(py + 0.5, y + height - radius));
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= radius * radius) this.set(px, py, color);
      }
    }
  }

  line(x0, y0, x1, y1, thickness, color) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3 + 1;
    const radius = thickness / 2;
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      for (let dy = -radius; dy <= radius; dy += 0.5) {
        for (let dx = -radius; dx <= radius; dx += 0.5) {
          this.set(Math.round(cx + dx), Math.round(cy + dy), color);
        }
      }
    }
  }
}

function draw(size) {
  const canvas = new Canvas(size);
  const u = (value) => value * size;
  canvas.roundRect(u(0.03), u(0.03), u(0.94), u(0.94), Math.max(1, u(0.22)), ACCENT);
  const stroke = Math.max(1.4, u(0.1));
  canvas.line(u(0.5), u(0.24), u(0.28), u(0.7), stroke, INK);
  canvas.line(u(0.5), u(0.24), u(0.72), u(0.7), stroke, INK);
  canvas.line(u(0.36), u(0.55), u(0.64), u(0.55), stroke * 0.8, INK);
  if (size >= 32) {
    canvas.rect(u(0.26), u(0.78), u(0.48), Math.max(1, u(0.055)), INK);
    canvas.rect(u(0.34), u(0.87), u(0.32), Math.max(1, u(0.055)), INK);
  }
  return encodePng(size, canvas.data);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, draw(size));
  console.log(`wrote ${path.replace(`${ROOT}/`, '')}`);
}
