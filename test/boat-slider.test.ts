import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROWS, SLIDER_SHIP, SLIDER_WIDTH, buoyX, render, sliderScene, sliderX } from '../web/src/components/shipFrames.ts';

// Issue #155: the Compact sidebar slider's handle is the ASCII ship, on a strip of water with a buoy at
// each of the four steps. The range input stays and lies over the drawing, so its thumb must be where the ship is.

const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', ...file.split('/')), 'utf8');

test('the ship stands where a range thumb of its width stands: left edge at the first step, right edge at the last', () => {
  // A range thumb's left edge moves over (track width − thumb width), evenly between the steps.
  const free = SLIDER_WIDTH - SLIDER_SHIP;
  assert.equal(sliderX(1, 4), 0);
  assert.equal(sliderX(4, 4), free);
  assert.equal(sliderX(2, 4), Math.round(free / 3));
  assert.equal(sliderX(3, 4), Math.round((2 * free) / 3));
});

test('every frame is four rows of the strip, with all four buoys showing, wherever the ship is and whichever way it sails', () => {
  const buoys = [1, 2, 3, 4].map((s) => buoyX(s, 4));
  assert.equal(new Set(buoys).size, 4);
  for (let x = 0; x <= SLIDER_WIDTH - SLIDER_SHIP; x++) {
    for (const facing of ['right', 'left'] as const) {
      for (const sailing of [true, false]) {
        const rows = render(sliderScene(x, 4, facing, sailing), x).split('\n');
        assert.equal(rows.length, ROWS);
        assert.ok(rows.every((r) => r.length === SLIDER_WIDTH));
        for (const b of buoys) assert.equal(rows[ROWS - 1]![b], 'o', `buoy at ${b} hidden with the ship at ${x} ${facing}`);
      }
    }
  }
});

test('a buoy is under the middle of the hull when the ship is at its step', () => {
  for (const s of [1, 2, 3, 4]) {
    const hull = render(sliderScene(sliderX(s, 4), 4, 'right', false), 0).split('\n')[ROWS - 2]!;
    const from = hull.indexOf('\\'), to = hull.lastIndexOf('/');
    assert.ok(from < buoyX(s, 4) && buoyX(s, 4) < to, `step ${s}`);
  }
});

test('the ship faces the way it sails, with the wake behind it', () => {
  const right = render(sliderScene(30, 4, 'right', true), 0).split('\n');
  const left = render(sliderScene(30, 4, 'left', true), 0).split('\n');
  assert.equal(right[0]!.slice(30, 36), '  |\\  ');
  assert.equal(left[0]!.slice(30, 36), '  /|  ');
  assert.equal(right[ROWS - 1]!.slice(28, 30), '==');
  assert.equal(left[ROWS - 1]!.slice(36, 38), '==');
});

test('the range input stays the control, over the drawing, with a thumb the ship\'s width and a visible focus', () => {
  const settings = read('web/src/components/SettingsView.tsx');
  // The input is the BoatSlider's child, unchanged: its name from the label, its value text the step's label.
  assert.match(settings, /<BoatSlider [^\n]*>\s*<input type="range" [^<]*aria-valuetext=\{label\}[^<]*\/>\s*<\/BoatSlider>/);
  assert.match(settings, /<span>Compact sidebar<\/span>/);
  const slider = read('web/src/components/BoatSlider.tsx');
  assert.match(slider, /'--boat-ship': SLIDER_SHIP/);
  assert.match(slider, /<pre className="sailing-ship" aria-hidden="true">/);
  assert.match(slider, /className="boat-marks" aria-hidden="true"/);
  const css = read('web/src/styles.css');
  assert.match(css, /\.boat-track input::-webkit-slider-thumb \{[^}]*width: calc\(var\(--boat-ship\) \* 1ch\)/);
  assert.match(css, /\.boat-track input::-moz-range-thumb \{[^}]*width: calc\(var\(--boat-ship\) \* 1ch\)/);
  assert.match(css, /\.boat-track:has\(input:focus-visible\) \{[^}]*outline: 2px solid/);
});
