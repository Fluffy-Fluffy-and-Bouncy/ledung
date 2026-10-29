// Issue #173: answering in Waiting for you on a phone. Send in a bar pinned under the question page, the opinions
// before the options, 16 px text boxes, no keyboard hints on a touch screen, and Withdraw away from Send, asking first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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

/** The CSS outside every @media block: what applies on a wide screen with a mouse. */
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

const phone = () => mediaBodies('(max-width: 760px)').join('\n');
const touch = () => mediaBodies('(pointer: coarse)').join('\n');

test('at 390 px Send answer is in a bar pinned under the page, and the Send in the page is hidden', () => {
  assert.equal(valueFor(phone(), '.send-bar', 'display'), 'flex');
  assert.equal(valueFor(phone(), '.note-block .send', 'display'), 'none', 'two Send buttons on one screen');
});

test('wider than 760 px the pinned bar is hidden and Send stays under the Note', () => {
  assert.equal(valueFor(baseCss(), '.send-bar', 'display'), 'none');
  assert.equal(valueFor(baseCss(), '.note-block .send', 'display'), undefined);
});

test('at 390 px the opinions come before the options, so the choice sits by the Note and Send', () => {
  // The question page is a flex column; the options, the Note and the key list move after everything at order 0.
  for (const sel of ['.desk-body > .opts-block', '.desk-body > .note-block', '.desk-body > .keys']) {
    assert.equal(valueFor(phone(), sel, 'order'), '1', sel);
  }
  assert.equal(valueFor(baseCss(), '.desk-body > .opts-block', 'order'), undefined, 'a wide screen keeps the order it had');
});

test('at 390 px the text boxes in Waiting for you are 16 px, so iOS does not zoom when one gets the focus', () => {
  // 16 px is the size below which iOS Safari zooms in on a focused text field.
  assert.equal(valueFor(phone(), '.waiting-view textarea', 'font-size'), '16px');
  assert.equal(valueFor(phone(), '.waiting-view input', 'font-size'), '16px');
});

test('on a touch screen the keyboard hints are hidden; with a mouse they show', () => {
  for (const sel of ['.keys', '.send-hint', '.kbd-hint', '.vbtns kbd']) {
    assert.equal(valueFor(touch(), sel, 'display'), 'none', sel);
  }
  assert.equal(valueFor(baseCss(), '.keys', 'display'), 'flex');
});

// The class: every Withdraw in the page goes through the one that asks first, on its own row, never a button
// beside Send that withdraws on one tap.
const components = new URL('../web/src/components/', import.meta.url);
const sources = readdirSync(components).filter((f) => f.endsWith('.tsx') && f !== 'Withdraw.tsx')
  .map((f) => ({ f, text: readFileSync(new URL(f, components), 'utf8') }));

test('no button withdraws a question on one tap: each goes through the Withdraw that asks first', () => {
  for (const { f, text } of sources) {
    // The tag up to its own `>`, past the `=>` of the arrow functions in its attributes.
    for (const m of text.matchAll(/<button\b(?:[^>=]|=(?!>)|=>)*>/g)) {
      assert.doesNotMatch(m[0], /withdraw/i, `${f}: a button that withdraws at once: ${m[0].slice(0, 120)}`);
    }
  }
  const users = sources.filter((s) => s.text.includes('<Withdraw ')).map((s) => s.f).sort();
  assert.deepEqual(users, ['QuestionCard.tsx', 'ReviewView.tsx', 'ScreenshotView.tsx', 'WaitingView.tsx']);
});

test('the Withdraw that asks first only withdraws from its second button, and the safe one takes the focus', () => {
  const text = readFileSync(new URL('Withdraw.tsx', components), 'utf8');
  const first = text.match(/if \(!asking\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(first, /onClick=\{\(\) => setAsking\(true\)\}/, 'the first tap only asks');
  assert.doesNotMatch(first, /onWithdraw/, 'the first tap must not withdraw');
  assert.match(text, /ref=\{keep\}[^>]*onClick=\{\(\) => setAsking\(false\)\}/, '"Keep it" holds the focus and goes back');
});
