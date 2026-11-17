// Writes a sample warped canvas scan and a sample chart into samples/,
// so the site can be tried without a real scan.
//   node tools/make-samples.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { makeCanvas } from './synth.mjs';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, channels, pixels, dpi) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * channels + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * channels, width * channels).copy(raw, y * (width * channels + 1) + 1);
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (dpi) {
    const p = Buffer.alloc(9);
    const ppm = Math.round(dpi / 0.0254);
    p.writeUInt32BE(ppm, 0); p.writeUInt32BE(ppm, 4); p[8] = 1;
    parts.push(chunk('pHYs', p));
  }
  parts.push(chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });

// --- scan: 13 mesh at 600 dpi, about 4.5 x 3.75 inches, gently warped
const W = 2700, H = 2250, DPI = 600;
const { gray } = makeCanvas({ width: W, height: H, dpi: DPI, mesh: 13, warp: 0.5, rotationDeg: 1.2, noise: 8, seed: 7 });
// tint to look like a real scan: warm off-white threads, near-black backing
const rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) {
  const g = gray[i];
  rgb[i * 3] = Math.min(255, g * 1.0 + 4);
  rgb[i * 3 + 1] = Math.min(255, g * 0.98 + 2);
  rgb[i * 3 + 2] = Math.min(255, g * 0.92);
}
writeFileSync(new URL('../samples/sample-scan-13mesh-600dpi.png', import.meta.url), png(W, H, 3, rgb, DPI));

// --- chart: 40 x 32 stitches, a strawberry with a near-white highlight
const cw = 40, ch = 32;
const px = new Uint8Array(cw * ch * 4);
const set = (x, y, [r, g, b]) => { const i = (y * cw + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
const RED = [205, 38, 62], DARK = [128, 18, 40], SEED = [246, 214, 92], LEAF = [46, 139, 70], WHITE = [252, 252, 250], SKY = [158, 205, 232];
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) set(x, y, SKY);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const nx = (x - 19.5) / 13, ny = (y - 17) / 13;
    const berry = nx * nx * (1.0 + 0.8 * ny) + ny * ny < 1 && y > 7;
    if (berry) {
      const edge = nx * nx * (1.0 + 0.8 * ny) + ny * ny > 0.82;
      set(x, y, edge ? DARK : RED);
      if (!edge && (x * 7 + y * 3) % 11 === 0) set(x, y, SEED);
    }
  }
}
for (let y = 5; y < 10; y++) for (let x = 13; x < 27; x++) {
  if (Math.abs(x - 19.5) < (10 - y) * 1.6 + 1 && ((x + y) % 3 !== 0 || y > 7)) set(x, y, LEAF);
}
for (const [x, y] of [[13, 13], [14, 13], [13, 14], [14, 12], [15, 12], [12, 15]]) set(x, y, WHITE);
writeFileSync(new URL('../samples/sample-chart-strawberry.png', import.meta.url), png(cw, ch, 4, px));
console.log('wrote samples/sample-scan-13mesh-600dpi.png and samples/sample-chart-strawberry.png');
