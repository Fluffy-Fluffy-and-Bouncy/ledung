// Issue #388: the app icons had opaque white corners (rendered onto white), shown in the taskbar, the Windows tray
// and the installed page. icon-512.png and icon-256.png must be see-through outside icon.svg's rounded square
// (rx 112 of 512); apple-touch-icon.png stays opaque, but dark, not white (iOS rounds it itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPng, type Png } from './png.ts';
import { renderIcon } from '../scripts/app-icons.ts';

const pub = path.join(import.meta.dirname, '..', 'web', 'public');
const load = (name: string): Png => readPng(fs.readFileSync(path.join(pub, name)));
// icon.svg's background, #16181d.
const BG = [0x16, 0x18, 0x1d];

function corners(png: Png): [number, number][] {
  const m = png.width - 1;
  return [[0, 0], [m, 0], [0, m], [m, m]];
}

// Points inside the rounded square in every icon: the middle of each side, just inside the edge, and the centre.
function insides(png: Png): [number, number][] {
  const s = png.width;
  const h = Math.floor(s / 2);
  return [[h, 1], [1, h], [s - 2, h], [h, s - 2], [h, h]];
}

function assertSeeThroughCorners(png: Png, what: string): void {
  for (const [x, y] of corners(png)) assert.equal(png.pixel(x, y)[3], 0, `${what} corner (${x},${y}) is ${png.pixel(x, y).join(',')}`);
  // The positive branch: the same reader finds the icon opaque where the rounded square is.
  for (const [x, y] of insides(png)) assert.equal(png.pixel(x, y)[3], 255, `${what} (${x},${y}) is ${png.pixel(x, y).join(',')}`);
  assert.deepEqual(png.pixel(Math.floor(png.width / 2), 1).slice(0, 3), BG, `${what} edge is the icon's background`);
}

for (const [name, size] of [['icon-512.png', 512], ['icon-256.png', 256]] as const) {
  test(`${name} has see-through corners and an opaque rounded square (#388)`, () => {
    const png = load(name);
    assert.equal(png.width, size);
    assert.equal(png.height, size);
    assertSeeThroughCorners(png, name);
  });
}

test('apple-touch-icon.png is opaque with dark corners, not white (#388)', () => {
  const png = load('apple-touch-icon.png');
  assert.equal(png.width, 180);
  for (const [x, y] of [...corners(png), ...insides(png)]) assert.equal(png.pixel(x, y)[3], 255, `(${x},${y}) is opaque`);
  for (const [x, y] of corners(png)) assert.deepEqual(png.pixel(x, y).slice(0, 3), BG, `corner (${x},${y}) is the icon's background`);
});

test('the icon script draws see-through corners and an opaque rounded square (#388)', () => {
  assertSeeThroughCorners(readPng(renderIcon(64)), 'renderIcon(64)');
  const opaque = readPng(renderIcon(64, { opaque: true }));
  assert.deepEqual(opaque.pixel(0, 0), [...BG, 255]);
});
