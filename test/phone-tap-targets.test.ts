// Issue #176: Waiting for you on a touch screen. Every control at least 44 px, the row's go-to-conversation button
// visible without hover, Evidence a full-width bar, and what was only in a tooltip written out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compactRows, COMPACT_STEPS } from '../web/src/compactSidebar.ts';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const css = read('web/src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

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

/** The CSS outside every @media block: what applies with a mouse on a wide screen. */
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

/** The value of `property` for `selector` in `text`, alone or in a selector list; the last one wins. */
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

const touch = () => mediaBodies('(pointer: coarse)').join('\n');

test('every Waiting for you page carries the class the touch-screen sizes hang on', () => {
  const view = read('web/src/components/WaitingView.tsx');
  // The queue, the question, review and screenshot pages and the not-found page: five roots, none without it.
  assert.equal(view.match(/className="waiting-view desk-view"/g)?.length, 5);
  assert.equal(view.match(/className="waiting-view"/g), null);
});

test('on a touch screen every button in Waiting for you is at least 44 px tall, and the icon buttons 44 px wide', () => {
  // 44 px: the touch target size of Apple's guidelines, the audit's yardstick (finding 6).
  // One rule for all of them covers the toggle, the project chips, small buttons, Withdraw and the send bar.
  assert.equal(valueFor(touch(), '.desk-view button:not(.link)', 'min-height'), '44px');
  assert.equal(valueFor(touch(), '.desk-view button.icon', 'width'), '44px');
  assert.equal(valueFor(touch(), '.desk-view button.icon', 'height'), '44px');
  // Desktop sizes are out of scope: nothing of this outside the media query.
  assert.equal(valueFor(baseCss(), '.desk-view button:not(.link)', 'min-height'), undefined);
  assert.equal(valueFor(baseCss(), 'button.icon', 'width'), '2rem');
});

test("on a touch screen the row's go-to-conversation button is at full strength; with a mouse it waits for hover", () => {
  assert.equal(valueFor(touch(), '.desk-view .conv-row', 'opacity'), '1');
  assert.equal(valueFor(baseCss(), '.conv-row', 'opacity'), '0.45');
  // The row's text keeps clear of the larger button.
  assert.equal(valueFor(touch(), '.desk-view .qrow-wrap .qrow', 'padding-right'), '3.4rem');
});

test('on a touch screen Evidence is a full-width bar: the summary fills the box and is 44 px tall', () => {
  assert.equal(valueFor(touch(), '.desk-view details.ev', 'padding'), '0');
  assert.equal(valueFor(touch(), '.desk-view details.ev summary', 'min-height'), '44px');
  assert.equal(valueFor(baseCss(), 'details.ev', 'padding'), '0.5rem 0.8rem', 'with a mouse the fold is as before');
});

test('text written out for a touch screen is hidden with a mouse and shown on a touch screen', () => {
  assert.equal(valueFor(baseCss(), '.touch-only', 'display'), 'none');
  assert.equal(valueFor(touch(), '.touch-only', 'display'), 'revert');
  const view = read('web/src/components/WaitingView.tsx');
  // The tags on an option's border cut long names short: "Picked by" names them in full, on a touch screen only
  // when the tags are drawn, always when they are not.
  assert.match(view, /<span className=\{`picked-by\$\{split \? ' touch-only' : ''\}`\}><b>Picked by<\/b>/);
  // What the "plain question" chip's tooltip says.
  assert.match(view, /<span className="muted touch-only">· asked with text and option labels only<\/span>/);
});

// #207 undoes #176's touch exception here (Martin, 2026-10-18, question #288: "Steps work the same on the phone").
test('on a touch screen every compact step shows the same rows as with a mouse', () => {
  const mouse = COMPACT_STEPS.map(({ step }) => compactRows(step));
  const g = globalThis as { matchMedia?: unknown };
  const before = g.matchMedia;
  g.matchMedia = (query: string) => ({ matches: query === '(pointer: coarse)' });
  try {
    for (const [i, { step }] of COMPACT_STEPS.entries()) assert.deepEqual(compactRows(step), mouse[i], `step ${step}`);
  } finally {
    g.matchMedia = before;
  }
  assert.equal(compactRows(3).time, false, 'a step still hides the time row');
});
