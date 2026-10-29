import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPOSER_HEIGHT_KEY, MAX_SHARE, dragHeight, heightForKey, heightLimits, readHeight, standardHeight, writeHeight, type HeightStore } from '../web/src/composerSize.ts';

function memoryStore(): HeightStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

// Today's minimum is the CSS min-height, 3.2rem at 16px = 51.2px; the box's padding (0.6rem + 0.8rem) and top border 1px.
const MIN = 51.2;
const CHROME = 9.6 + 12.8 + 1;

test('the whole message box takes at most three quarters of the chat column, so the transcript keeps a quarter', () => {
  assert.equal(MAX_SHARE, 0.75);
  const { min, max } = heightLimits(MIN, 800, CHROME);
  assert.equal(min, MIN);
  assert.equal(max, Math.floor(600 - CHROME));
  assert.ok(max + CHROME <= 800 * 0.75);
});

test('a column too short for any growth keeps the minimum', () => {
  assert.deepEqual(heightLimits(MIN, 60, CHROME), { min: MIN, max: MIN });
});

test('dragging up makes it taller, down smaller, never past the limits', () => {
  assert.equal(dragHeight(80, 500, 400, MIN, 576), 180);
  assert.equal(dragHeight(180, 400, 450, MIN, 576), 130);
  assert.equal(dragHeight(80, 500, 900, MIN, 576), Math.round(MIN));
  assert.equal(dragHeight(80, 500, -2000, MIN, 576), 576);
});

test('keys: up grows, down shrinks, Home and End go to the limits, others ignored', () => {
  assert.equal(heightForKey('ArrowUp', 100, MIN, 576), 120);
  assert.equal(heightForKey('ArrowDown', 100, MIN, 576), 80);
  assert.equal(heightForKey('ArrowUp', 570, MIN, 576), 576);
  assert.equal(heightForKey('Home', 300, MIN, 576), MIN);
  assert.equal(heightForKey('End', 100, MIN, 576), 576);
  assert.equal(heightForKey('a', 100, MIN, 576), null);
});

test('the chosen height is remembered, as after a reload or a session switch, and a reset forgets it', () => {
  const store = memoryStore();
  assert.equal(readHeight(store), null);
  writeHeight(store, 240);
  assert.equal(store.data.get(COMPOSER_HEIGHT_KEY), '240');
  assert.equal(readHeight(store), 240);
  writeHeight(store, null);
  assert.equal(store.data.has(COMPOSER_HEIGHT_KEY), false);
  assert.equal(readHeight(store), null);
});

test('a stored value that is not a positive number is the default', () => {
  const store = memoryStore();
  for (const bad of ['', 'abc', '0', '-5']) {
    store.data.set(COMPOSER_HEIGHT_KEY, bad);
    assert.equal(readHeight(store), null);
  }
});

test('a store that throws (private mode) reads as the default and writing does not throw', () => {
  const broken: HeightStore = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  assert.equal(readHeight(broken), null);
  assert.doesNotThrow(() => writeHeight(broken, 200));
});

test('the text box has no browser corner grip, and the message box has the top-edge grip', () => {
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.composer textarea \{[^}]*resize: none/);
  assert.match(css, /\.composer-grip \{[^}]*cursor: ns-resize/);
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /useComposerHeight\(\)/);
});

// Issue #125: the floor is the standard height, the one the box has with no height chosen. From styles.css: the page's
// font is 14px/1.5 (21px lines), the text box has rows={3}, 0.45rem padding top and bottom (7.2px each) and a 1px border.
const LINE = 21;
const PAD_Y = 7.2 * 2;
const BORDER_Y = 2;
// 63 + 14.4 + 2 = 79.4 (the default the #123 loopback measured, 79 px), up to the whole pixel so no drag ends below it.
const STANDARD = Math.ceil(LINE * 3 + PAD_Y + BORDER_Y);

test('the standard height is three rows with padding and border, above the CSS minimum', () => {
  assert.equal(standardHeight(MIN, LINE, 3, PAD_Y, BORDER_Y, 69), STANDARD);
  assert.ok(STANDARD > MIN);
});

test('the standard height is never shorter than the Stop + Send column beside it', () => {
  assert.equal(standardHeight(MIN, LINE, 3, PAD_Y, BORDER_Y, 90), 90);
  assert.equal(standardHeight(MIN, LINE, 1, 0, 0, 0), Math.ceil(MIN));
});

test('dragging down, ArrowDown and Home stop at the standard height, and growing upwards is as before', () => {
  const { min, max } = heightLimits(STANDARD, 800, CHROME);
  assert.equal(min, STANDARD);
  assert.equal(dragHeight(200, 500, 900, min, max), STANDARD);
  assert.ok(dragHeight(80, 500, 501, min, max) >= STANDARD);
  assert.equal(heightForKey('ArrowDown', 90, min, max), STANDARD);
  assert.equal(heightForKey('Home', 300, min, max), STANDARD);
  assert.equal(dragHeight(80, 500, 400, min, max), 180);
  assert.equal(heightForKey('End', 100, min, max), max);
});

test('the message box measures its floor as the standard height, not the CSS minimum', () => {
  const src = readFileSync(new URL('../web/src/components/ComposerResizer.tsx', import.meta.url), 'utf8');
  assert.match(src, /heightLimits\(min, column\.clientHeight, chrome\)/);
  assert.match(src, /const min = standardHeight\(/);
});
