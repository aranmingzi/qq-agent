import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '..', 'assets');
const size = 256;
const png = new PNG({ width: size, height: size });

function blend(base, top, alpha) {
  return Math.round(base * (1 - alpha) + top * alpha);
}

function insideRoundedRect(x, y, radius = 54) {
  const left = radius;
  const right = size - radius - 1;
  const top = radius;
  const bottom = size - radius - 1;
  const cx = Math.max(left, Math.min(right, x));
  const cy = Math.max(top, Math.min(bottom, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const idx = (y * size + x) * 4;
    if (!insideRoundedRect(x, y)) {
      png.data[idx + 3] = 0;
      continue;
    }

    const t = (x + y) / (2 * size);
    png.data[idx] = blend(58, 121, t);
    png.data[idx + 1] = blend(94, 151, t);
    png.data[idx + 2] = blend(224, 255, t);
    png.data[idx + 3] = 255;

    const shine = Math.max(0, 1 - Math.hypot(x - 70, y - 54) / 125);
    if (shine > 0) {
      const a = shine * 0.18;
      png.data[idx] = blend(png.data[idx], 255, a);
      png.data[idx + 1] = blend(png.data[idx + 1], 255, a);
      png.data[idx + 2] = blend(png.data[idx + 2], 255, a);
    }

    const dx = x - 126;
    const dy = y - 118;
    const inBubble = dx * dx / (70 ** 2) + dy * dy / (54 ** 2) <= 1;
    const inTail = y >= 158 && y <= 202
      && x >= 88 + (y - 158) * 0.35
      && x <= 132 + (y - 158) * 0.15;
    if (inBubble || inTail) {
      png.data[idx] = 250;
      png.data[idx + 1] = 252;
      png.data[idx + 2] = 255;
    }
  }
}

const pngBuffer = PNG.sync.write(png);
const pngPath = path.join(assetsDir, 'icon-256.png');
const icoPath = path.join(assetsDir, 'icon.ico');

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry[0] = 0;
entry[1] = 0;
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(pngBuffer.length, 8);
entry.writeUInt32LE(22, 12);

fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(pngPath, pngBuffer);
fs.writeFileSync(icoPath, Buffer.concat([header, entry, pngBuffer]));
console.log(JSON.stringify({ pngPath, icoPath, bytes: pngBuffer.length }, null, 2));
