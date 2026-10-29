// Issue #177: judging screenshots on a phone. Pass / Fail / Unsure in a bar under the image, both pinned at the
// top while the slip scrolls under them, and the full-screen image clear of a notch (phone audit, finding 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PIN_SHARE, pinsShotTop } from '../web/src/shotPin.ts';

const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const view = readFileSync(new URL('../web/src/components/ScreenshotView.tsx', import.meta.url), 'utf8');

/** The bodies of every `@media <condition> { … }` block, braces balanced. */
function mediaBodies(condition: string): string[] {
  const bodies = [];
  const head = `@media ${condition}`;
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { bodies.push(css.slice(open + 1, i)); break; }
    }
  }
  return bodies;
}

/** The CSS outside every @media block: what applies on a wide screen. */
function baseCss(): string {
  let out = '';
  let depth = 0;
  let inMedia = 0;
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('@media', i) && depth === 0) inMedia = 1;
    const c = css[i];
    if (c === '{') depth++;
    if (!inMedia) out += c;
    if (c === '}' && --depth === 0) inMedia = 0;
  }
  return out;
}

/** The value of `property` for `selector` in `text`, found alone or anywhere in a selector list; the last one wins. */
function valueFor(text: string, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    const d = (m[2] ?? '').match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (d?.[1]) value = d[1].trim();
  }
  return value;
}

// The screenshot view stacks into one scrolling column at 900 px and below, so that block is what a 390 px phone gets.
const narrow = () => mediaBodies('(max-width: 900px)').join('\n');

test('at 390 px the image and the verdict bar stick to the top of the scrolling page, when the page says it fits', () => {
  assert.equal(valueFor(narrow(), '.shots.pin .shot-top', 'position'), 'sticky');
  assert.ok(valueFor(narrow(), '.shots.pin .shot-top', 'top') !== undefined, 'sticky needs a top to stick at');
  // A sticky box only sticks inside its parent: .shot-main must give up its box, or the image scrolls away
  // with the strip as soon as the slip comes up.
  assert.equal(valueFor(narrow(), '.shot-main', 'display'), 'contents');
  assert.match(valueFor(narrow(), '.shots.pin .shot-top', 'background') ?? '', /\S/, 'the slip scrolls under it: it needs a background');
  // The class is the page's to set, from the measured heights.
  assert.match(view, /className=\{`shots\$\{pinned \? ' pin' : ''\}`\}/);
  assert.match(view, /setPinned\(pinsShotTop\(/);
});

// #191 review, finding 1: on a short window (a phone held sideways, 844 × 390; a narrow laptop window, 800 × 600)
// the pinned part was taller than the area it scrolls in, so the note and Send stayed under it for good.
test('without the page saying it fits, nothing is pinned: a short window scrolls the picture away', () => {
  assert.equal(valueFor(narrow(), '.shot-top', 'position'), undefined);
  assert.equal(valueFor(narrow(), '.shot-top', 'top'), undefined);
});

test('the pinned part is pinned only while it leaves the slip at least the rest of the area', () => {
  assert.equal(PIN_SHARE, 0.6);
  // A phone held upright: 300 px of picture and bar in a 700 px area leaves 400 px for the slip.
  assert.equal(pinsShotTop(300, 700), true);
  // Exactly at the share still pins: 60 of 100.
  assert.equal(pinsShotTop(60, 100), true);
  assert.equal(pinsShotTop(61, 100), false);
  // A phone held sideways: the area is shorter than the picture and bar, so pinning would cover the slip for good.
  assert.equal(pinsShotTop(300, 270), false);
  // A narrow laptop window: 520 px of picture and bar in a 490 px area.
  assert.equal(pinsShotTop(520, 490), false);
  // Nothing measured yet (no layout): not pinned.
  assert.equal(pinsShotTop(0, 700), false);
  assert.equal(pinsShotTop(300, 0), false);
});

test('at 900 px and below the picture is capped by the window height too, with a floor', () => {
  // 56vw alone gives a 472 px picture on a phone held sideways (844 px wide), taller than its 390 px screen.
  assert.match(valueFor(narrow(), '.shots .stage', 'height') ?? '', /^min\(56vw, \d+dvh\)$/);
  assert.match(valueFor(narrow(), '.shots .stage', 'min-height') ?? '', /^\d+px$/);
});

// #191 review, finding 2: the hint was styled only inside the slip, and the bar is outside it.
test('the "carried over" hint is styled wherever it shows, in the bar as in the slip', () => {
  assert.equal(valueFor(baseCss(), '.slip .carried-hint', 'color'), undefined);
  assert.equal(valueFor(baseCss(), '.carried-hint', 'color'), 'var(--dot-waiting)');
  assert.equal(valueFor(baseCss(), '.carried-hint', 'margin'), '0 0 0.2rem');
});

test('at 390 px the bar shows the verdict buttons at a finger size, and the slip does not show them twice', () => {
  assert.equal(valueFor(narrow(), '.shot-vbar', 'display'), 'flex');
  assert.equal(valueFor(narrow(), '.shot-vbar .vbtns button', 'min-height'), '44px');
  // `.slip .sblk` sets display: flex, so the hiding rule needs at least its weight.
  assert.equal(valueFor(narrow(), '.slip .slip-verdict', 'display'), 'none');
});

test('on a wide screen the bar is hidden and the slip keeps its buttons', () => {
  assert.equal(valueFor(baseCss(), '.shot-vbar', 'display'), 'none');
  assert.equal(valueFor(baseCss(), '.slip .slip-verdict', 'display'), undefined);
});

test('the verdict bar sits under the image, inside the pinned part, before the strip', () => {
  const topAt = view.indexOf('className="shot-top"');
  const stageAt = view.indexOf('className="stage"', topAt);
  const barAt = view.indexOf('className="shot-vbar"', topAt);
  const stripAt = view.indexOf('className="strip"');
  assert.ok(topAt >= 0 && stageAt > topAt && barAt > stageAt && stripAt > barAt, 'expected .shot-top > .stage, then .shot-vbar, then the strip outside');
  // The next-shot arrows are on the image, so they are pinned with it.
  assert.ok(view.indexOf('aria-label="Next screenshot"', stageAt) < barAt);
});

test('the full-screen image keeps its close button clear of a notch', () => {
  const padding = valueFor(baseCss(), '.rev-large', 'padding') ?? '';
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(padding, new RegExp(`env\\(safe-area-inset-${side}`), side);
});
