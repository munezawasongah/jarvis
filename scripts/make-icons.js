// Generates the PNG app icons (no dependencies). Run: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// orbScale: radius of the orb as a fraction of the half-size (smaller for maskable safe zone)
function render(size, orbScale) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2, R = (size / 2) * orbScale;
  const bg = [7, 11, 18];
  const stops = [[0, [198, 245, 255]], [0.32, [77, 216, 255]], [0.68, [11, 110, 156]], [1, [5, 42, 64]]];
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (t) => {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const k = (t - t0) / (t1 - t0);
        return c0.map((v, j) => lerp(v, c1[j], k));
      }
    }
    return stops[stops.length - 1][1];
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      let rgb = bg;
      // soft outer ring
      const ringR = R * 1.3;
      const ringA = Math.max(0, 1 - Math.abs(d - ringR) / (size * 0.006));
      if (ringA > 0) rgb = rgb.map((v, j) => lerp(v, [77, 216, 255][j], ringA * 0.4));
      if (d <= R) {
        const gx = (x - (cx - R * 0.28)), gy = (y - (cy - R * 0.4));
        const t = Math.min(1, Math.hypot(gx, gy) / (R * 1.45));
        const edge = Math.min(1, (R - d) / 1.5); // anti-alias
        const c = grad(t);
        rgb = rgb.map((v, j) => lerp(v, c[j], edge));
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const files = [
  ['icon-192.png', 192, 0.58],
  ['icon-512.png', 512, 0.58],
  ['icon-maskable-512.png', 512, 0.42], // keep the artwork inside the maskable safe zone
];
for (const [name, size, scale] of files) {
  fs.writeFileSync(path.join(out, name), render(size, scale));
  console.log('wrote', name);
}
