// Draws the Mac menu bar icon (issue #347, choice G): a one-colour silhouette of Ledung's mark, the middle boat and
// its wave from web/public/icon.svg, black on transparent. macOS shows it as a "template" image: it uses only the
// alpha and paints it in the menu bar's own colour, black on a light bar and white on a dark one.
// Run: node scripts/tray-mac-icon.ts (writes web/public/tray-mac.png, 36 pixels: 18 points at Retina's 2×).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZE = 36;
const SAMPLES = 8;

// The boat as icon.svg defines it, around its own origin, then placed at (256, 462) as the middle boat is.
type Pt = [number, number];
const place = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [x + 256, y + 462]);
const shapes: Pt[][] = [
  place([[-9, -300], [9, -300], [9, -50], [-9, -50]]),
  place([[-22, -275], [-22, -82], [-124, -82]]),
  place([[22, -275], [22, -82], [124, -82]]),
  place([[-134, -62], [134, -62], [92, 0], [-92, 0]]),
];
// The wave under it, lowered a little so a gap stays between hull and wave (the coloured icon keeps it with a stroke
// in the background colour, which a silhouette has not), and as wide as the hull.
const WAVE_Y = 490;
const WAVE_HALF = 12;
const wave = (x: number) => WAVE_Y - 10 * Math.sin((Math.PI * (x - 28)) / 56);
// The part of the icon's 512 units shown: the boat's top to the wave's bottom, square.
const TOP = 152;
const SPAN = 364;
const LEFT = 256 - SPAN / 2;

function inside(poly: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function covered(x: number, y: number): boolean {
  if (shapes.some((s) => inside(s, x, y))) return true;
  return x >= 112 && x <= 400 && Math.abs(y - wave(x)) <= WAVE_HALF;
}

const rows: Buffer[] = [];
for (let py = 0; py < SIZE; py++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let px = 0; px < SIZE; px++) {
    let n = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const x = LEFT + ((px + (sx + 0.5) / SAMPLES) * SPAN) / SIZE;
        const y = TOP + ((py + (sy + 0.5) / SAMPLES) * SPAN) / SIZE;
        if (covered(x, y)) n++;
      }
    }
    row.writeUInt8(Math.round((255 * n) / (SAMPLES * SAMPLES)), 1 + px * 4 + 3);
  }
  rows.push(row);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8); // 8 bits per channel
ihdr.writeUInt8(6, 9); // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(import.meta.dirname, '..', 'web', 'public', 'tray-mac.png');
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes).`);
