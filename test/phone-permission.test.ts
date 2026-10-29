// Issue #175: the permission card on a phone (phone audit, finding 7). The command and the diff wrap instead of
// scrolling sideways inside the scrolling page, Copy sits above the command, and the buttons stack full width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const phone = () => mediaBodies('(max-width: 760px)').join('\n');
const wraps = (v: string | undefined) => v === 'pre-wrap' || v === 'pre-line' || v === 'normal';

test('at 390 px a long command in a permission card wraps instead of scrolling sideways', () => {
  // The base rule keeps a pre on one line per line (white-space: pre), so a long command overflows its box.
  assert.ok(wraps(valueFor(phone(), '.card.permission .code-block pre', 'white-space')), 'the command must wrap');
  assert.equal(valueFor(phone(), '.card.permission .code-block pre', 'overflow-wrap'), 'anywhere', 'a long word or path must break too');
});

test('at 390 px Copy sits above the command, not over its first line', () => {
  // The base Copy is absolute in the top right corner of the code block, over the code.
  assert.equal(valueFor(baseCss(), '.copy-button', 'position'), 'absolute');
  assert.equal(valueFor(phone(), '.card.permission .copy-button', 'position'), 'static');
  assert.equal(valueFor(phone(), '.card.permission .code-block', 'flex-direction'), 'column', 'Copy first, then the command');
});

test('at 390 px Allow once, Allow for this session and Deny stack full width, each label on one line', () => {
  assert.equal(valueFor(baseCss(), '.card .actions', 'display'), 'flex');
  assert.equal(valueFor(phone(), '.card.permission .actions', 'flex-direction'), 'column');
  assert.equal(valueFor(phone(), '.card.permission .actions button', 'white-space'), 'nowrap');
});

test('at 390 px an Edit or Write diff wraps its lines, so it does not scroll both ways inside the page', () => {
  assert.equal(valueFor(baseCss(), '.diff span', 'white-space'), 'pre');
  assert.ok(wraps(valueFor(phone(), '.card.permission .diff span', 'white-space')));
  assert.equal(valueFor(phone(), '.card.permission .diff span', 'overflow-wrap'), 'anywhere');
});

test('wider than 760 px the permission card keeps its layout', () => {
  for (const sel of ['.card.permission .code-block pre', '.card.permission .copy-button', '.card.permission .actions', '.card.permission .diff span']) {
    assert.ok(!baseCss().includes(sel), `${sel} must only be set at phone width`);
  }
});

test('the selectors match the card the page draws', () => {
  // A renamed class would leave the phone rules matching nothing while the tests above still pass.
  const components = new URL('../web/src/components/', import.meta.url);
  const card = readFileSync(new URL('PermissionCard.tsx', components), 'utf8');
  const preview = readFileSync(new URL('ToolPreview.tsx', components), 'utf8');
  const markdown = readFileSync(new URL('Markdown.tsx', components), 'utf8');
  assert.match(card, /className="card permission"/);
  assert.match(card, /className="actions"/);
  assert.match(card, /<ToolPreview /);
  assert.match(preview, /className="code-block"[\s\S]*?<CopyButton [\s\S]*?<pre>/);
  assert.match(preview, /<pre className="diff">[\s\S]*?<span /);
  assert.match(markdown, /className="copy-button"/);
});
