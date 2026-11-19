// Draws Ledung's PNG app icons from web/public/icon.svg (issue #388): icon-512.png and icon-256.png on a transparent
// background, so the corners outside the rounded square are see-through (the old PNGs had been rendered onto white,
// which showed as white corners in the taskbar, the tray and the installed page), and apple-touch-icon.png opaque,
// its corners filled with the icon's own dark background (iOS draws transparency as black and rounds the icon
// itself, so no white can peek out at its corners either).
// The shapes below are icon.svg's, in its 512 units; change both together. Plain Node, like tray-mac-icon.ts: no
// image library. Run: node scripts/app-icons.ts
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Pt = [number, number];
type Rgb = [number, number, number];
const BG: Rgb = [0x16, 0x18, 0x1d];
const BACK: Rgb = [0x4d, 0x6a, 0xa6];
const FRONT: Rgb = [0x7a, 0xa2, 0xf7];

// <g id="boat">, around its own origin.
const BOAT: Pt[][] = [
  [[-9, -300], [9, -300], [9, -50], [-9, -50]],
  [[-22, -275], [-22, -82], [-124, -82]],
  [[22, -275], [22, -82], [124, -82]],
  [[-134, -62], [134, -62], [92, 0], [-92, 0]],
];
const boatAt = (tx: number, ty: number, s: number): Pt[][] => BOAT.map((poly) => poly.map(([x, y]): Pt => [tx + x * s, ty + y * s]));
const backBoats = [...boatAt(124, 436, 0.68), ...boatAt(388, 436, 0.68)];
const frontBoat = boatAt(256, 462, 1);
// The front boat's 22-wide stroke in the background colour, painted under its fill: a band 11 units round it.
const FRONT_EDGE = 11;

// The waves: "M28 y q28-20 56 0 t56 0 …", eight quadratic arcs of 56 units, alternately up and down by 20 at the
// control point, with round caps. Each arc's x runs evenly from start to end, so it is flattened by x.
const WAVE_START = 28;
const WAVE_ARC = 56;
const WAVE_ARCS = 8;
function waveLine(baseY: number): Pt[] {
  const pts: Pt[] = [];
  const steps = 32;
  for (let k = 0; k < WAVE_ARCS; k++) {
    const lift = k % 2 === 0 ? -20 : 20;
    for (let i = k === 0 ? 0 : 1; i <= steps; i++) {
      const t = i / steps;
      pts.push([WAVE_START + WAVE_ARC * (k + t), baseY + 2 * (1 - t) * t * lift]);
    }
  }
  return pts;
}
const backWave = { pts: waveLine(430), half: 9 };
const frontWave = { pts: waveLine(474), half: 10 };

function inside(poly: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function segDist2(x: number, y: number, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  const ex = ax + t * dx - x;
  const ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

function nearPolys(polys: Pt[][], x: number, y: number, r: number): boolean {
  for (const poly of polys) {
    if (inside(poly, x, y)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segDist2(x, y, poly[j]!, poly[i]!) <= r * r) return true;
  }
  return false;
}

function onWave(wave: { pts: Pt[]; half: number }, x: number, y: number): boolean {
  if (x < WAVE_START - wave.half || x > WAVE_START + WAVE_ARC * WAVE_ARCS + wave.half) return false;
  // Only the points within reach in x: the line runs left to right at a fixed step.
  const step = WAVE_ARC / 32;
  const from = Math.max(0, Math.floor((x - wave.half - WAVE_START) / step) - 1);
  const to = Math.min(wave.pts.length - 1, Math.ceil((x + wave.half - WAVE_START) / step) + 1);
  for (let i = from; i < to; i++) if (segDist2(x, y, wave.pts[i]!, wave.pts[i + 1]!) <= wave.half * wave.half) return true;
  return false;
}

// <rect width="512" height="512" rx="112">.
function inRoundedSquare(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x > 512 || y > 512) return false;
  const cx = Math.min(Math.max(x, 112), 400);
  const cy = Math.min(Math.max(y, 112), 400);
  return (x - cx) ** 2 + (y - cy) ** 2 <= 112 * 112;
}

// The colour at one point, painted in icon.svg's order; undefined where nothing is drawn.
function colourAt(x: number, y: number, fullSquare: boolean): Rgb | undefined {
  let c: Rgb | undefined = fullSquare || inRoundedSquare(x, y) ? BG : undefined;
  if (y > 200 && y < 445 && nearPolys(backBoats, x, y, 0)) c = BACK;
  if (onWave(backWave, x, y)) c = BACK;
  if (y > 150 && y < 475 && x > 110 && x < 402) {
    // paint-order="stroke" works per shape: each part paints its band and then its fill, so the hull's band cuts
    // the gap between the mast's foot and the hull.
    for (const part of frontBoat) {
      if (nearPolys([part], x, y, FRONT_EDGE)) c = BG;
      if (nearPolys([part], x, y, 0)) c = FRONT;
    }
  }
  if (onWave(frontWave, x, y)) c = FRONT;
  return c;
}

export function renderIcon(size: number, opts: { opaque?: boolean } = {}): Buffer {
  const samples = Math.max(4, Math.ceil(2048 / size));
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = colourAt(((px + (sx + 0.5) / samples) * 512) / size, ((py + (sy + 0.5) / samples) * 512) / size, opts.opaque === true);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          n++;
        }
      }
      // Straight (not premultiplied) alpha: the colour is the average of the covered samples only.
      const o = 1 + px * 4;
      if (n > 0) {
        row[o] = Math.round(r / n);
        row[o + 1] = Math.round(g / n);
        row[o + 2] = Math.round(b / n);
      }
      row[o + 3] = Math.round((255 * n) / (samples * samples));
    }
    rows.push(row);
  }
  return encodePng(size, rows);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size: number, rows: Buffer[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // 8 bits per channel
  ihdr.writeUInt8(6, 9); // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (import.meta.main) {
  const dir = path.join(import.meta.dirname, '..', 'web', 'public');
  for (const [name, size, opaque] of [
    ['icon-512.png', 512, false],
    ['icon-256.png', 256, false],
    ['apple-touch-icon.png', 180, true],
  ] as const) {
    const png = renderIcon(size, { opaque });
    fs.writeFileSync(path.join(dir, name), png);
    console.log(`Wrote ${name} (${size}×${size}, ${png.length} bytes).`);
  }
}
