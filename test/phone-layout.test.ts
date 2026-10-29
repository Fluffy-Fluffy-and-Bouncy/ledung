import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `@media (max-width: N px) { … }` block, whole and its body, braces balanced. */
function narrowBlocks(): { whole: string; body: string; width: number }[] {
  const blocks = [];
  for (const m of css.matchAll(/@media \(max-width: (\d+)px\)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        blocks.push({ whole: css.slice(m.index, i + 1), body: css.slice(open + 1, i), width: Number(m[1]) });
        break;
      }
    }
  }
  return blocks;
}

/** The rules that apply at 390 px on top of the base ones: every narrow block at least that wide. */
const phoneBlock = () => narrowBlocks().filter((b) => b.width >= 390).map((b) => b.body).join('\n}\n');

/** The last value of a property in the rules for exactly this selector (alone or in a selector list) in `text`. */
function ruleValue(text: string, selector: string, property: string): string | undefined {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let value: string | undefined;
  for (const m of text.matchAll(new RegExp(`(?:^|[},])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))) {
    const d = (m[1] ?? '').match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (d?.[1]) value = d[1].trim();
  }
  return value;
}

const desktopCss = () => narrowBlocks().reduce((text, b) => text.replace(b.whole, ''), css);

/** One property of a selector as it applies at 390 px: the phone block's rule wins over the base rule. */
function at390(selector: string, property: string): string | undefined {
  return ruleValue(phoneBlock(), selector, property) ?? ruleValue(desktopCss(), selector, property);
}

// Issue #169: at phone width .app is a column, and a flex item in a column is at least as tall as its content
// unless its min-height is 0 (or it scrolls itself). Each scroll area below is reached through such items; one
// without it grows to its content and the whole page scrolls instead, so the chat opened at its oldest message.
const chains: [string, string[]][] = [
  ['the message list', ['.main', '.session-body']],
  ['Waiting for you and a question page', ['.main', '.waiting-view']],
  ['Settings and the other pages', ['.main', '.page-view']],
  ['Usage and Overview', ['.main', '.overview']],
];

test('at 390 px the page is a column, so each column item must be allowed to shrink', () => {
  assert.equal(at390('.app', 'flex-direction'), 'column');
});

for (const [area, chain] of chains) {
  test(`at 390 px ${area} scrolls inside itself, not the page`, () => {
    for (const sel of chain) {
      const shrinks = at390(sel, 'min-height') === '0' || /auto|scroll|hidden/.test(at390(sel, 'overflow') ?? '');
      assert.ok(shrinks, `${sel} keeps the content's height at 390 px, so the page scrolls instead of ${area}`);
    }
  });
}

test('the fix is for the column only: on desktop .main is a row item and keeps its rule', () => {
  assert.equal(at390('.main', 'min-height'), '0');
  assert.equal(ruleValue(desktopCss(), '.main', 'min-height'), undefined);
});

// Issue #171 (Martin 2026-10-17, Ledung question #240): one pane at a time on a phone instead of the sidebar band.
/** The CSS in source order as it applies at 390 px: the phone blocks unwrapped in place, so a later rule wins. */
const inOrderAt390 = () => narrowBlocks().reduce((text, b) => text.replace(b.whole, b.width >= 390 ? `}\n${b.body}\n}` : ''), css);
/** The value at 390 px among rules of equal specificity: the last one in the file, wherever it sits. */
const last390 = (selector: string, property: string) => ruleValue(inOrderAt390(), selector, property);

test('at 390 px the list is the home screen and an open pane fills the screen instead', () => {
  assert.equal(at390('.app.phone-list .main', 'display'), 'none', 'with nothing open the main area must give the screen to the list');
  assert.equal(at390('.app.phone-pane .sidebar', 'display'), 'none', 'with a pane open the list must not take part of the screen');
  assert.equal(at390('.sidebar-resizer', 'display'), 'none', 'there is no band left to resize');
  assert.doesNotMatch(at390('.sidebar', 'height') ?? '', /sidebar-h/, 'the list is not the 55% band any more');
});

test('at 390 px Waiting for you comes first in the list', () => {
  assert.equal(at390('.sidebar > .waiting-entry', 'order'), '-1');
});

test('at 390 px the ← back and the bar that holds it show; wider they are hidden', () => {
  assert.equal(ruleValue(desktopCss(), '.phone-bar', 'display'), 'none');
  assert.equal(ruleValue(desktopCss(), '.session-head .phone-back', 'display'), 'none');
  assert.equal(last390('.phone-bar', 'display'), 'flex');
  assert.equal(last390('.session-head > .phone-back', 'display'), 'block');
});

test('at 390 px the session header is one line: ←, title cut short, ⚙, and the details only on a tap', () => {
  assert.equal(last390('.session-head', 'grid-template-columns'), 'auto minmax(0, 1fr) auto');
  assert.equal(last390('.session-head > .phone-back', 'grid-row'), '1');
  assert.equal(last390('.session-head > .session-head-text', 'grid-row'), '1');
  assert.equal(last390('.session-head > .session-corner', 'grid-column'), '3', 'the ⚙ must sit after the title, not on top of it');
  assert.equal(last390('.session-head h2', 'white-space'), 'nowrap');
  assert.equal(last390('.session-head h2', 'text-overflow'), 'ellipsis');
  assert.equal(last390('.session-head:not(.details) .session-head-text > .muted', 'display'), 'none');
});

test('wider than 760 px nothing of the one-pane layout applies', () => {
  assert.doesNotMatch(desktopCss(), /phone-list|phone-pane|waiting-entry\s*\{[^}]*order/);
  assert.equal(ruleValue(desktopCss(), '.session-head', 'grid-template-columns'), 'minmax(0, 1fr) auto');
});
