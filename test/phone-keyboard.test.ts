// Issue #174: the message box on a phone. Enter adds a line on a touch keyboard and Send sends, the placeholder is
// short, the shell ends above the on-screen keyboard, and the box is 16 px so iOS does not zoom. Desktop keys unchanged.
// Issue #262: the shell fills the screen again when the keyboard goes without a resize of the visible part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { editable, enterSends, followKeyboard, keyboardInset, type FocusedElement } from '../web/src/phoneKeyboard.ts';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const css = read('web/src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** The bodies of every `@media (max-width: 760px) { … }` block, and the CSS outside every @media block. */
function split(): { phone: string; base: string } {
  let phone = '';
  let base = '';
  let depth = 0;
  let media: string | null = null;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (depth === 0 && css.startsWith('@media', i)) { media = css.slice(i, css.indexOf('{', i)).trim(); start = css.indexOf('{', i) + 1; }
    const c = css[i];
    if (c === '{') depth++;
    if (media === null) base += c;
    if (c === '}' && --depth === 0 && media !== null) {
      if (media === '@media (max-width: 760px)') phone += css.slice(start, i) + '\n';
      media = null;
    }
  }
  return { phone, base };
}

/** The value of `property` for `selector`, alone or in a selector list; the last one wins. */
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

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...mods });

test('with a mouse the keys are as before: Enter sends, Shift+Enter adds a line', () => {
  assert.equal(enterSends(key('Enter'), false), true);
  assert.equal(enterSends(key('Enter', { shiftKey: true }), false), false);
  assert.equal(enterSends(key('Enter', { ctrlKey: true }), false), true);
  assert.equal(enterSends(key('Enter', { isComposing: true }), false), false, 'Enter that ends a composed word');
  assert.equal(enterSends(key('a'), false), false);
});

test('on a touch keyboard Enter adds a line; only Ctrl/⌘+Enter from a tablet keyboard sends', () => {
  // A touch keyboard has no Shift+Enter (phone audit, finding 3), so Enter must be the new line there.
  assert.equal(enterSends(key('Enter'), true), false);
  assert.equal(enterSends(key('Enter', { shiftKey: true }), true), false);
  assert.equal(enterSends(key('Enter', { ctrlKey: true }), true), true);
  assert.equal(enterSends(key('Enter', { metaKey: true }), true), true);
  assert.equal(enterSends(key('Enter', { metaKey: true, isComposing: true }), true), false);
});

test('the message box asks the touch rule on every key, and says only "Message Claude" on a touch screen', () => {
  const app = read('web/src/App.tsx');
  const composer = app.slice(app.indexOf('function Composer('), app.indexOf('function ClearCountdown('));
  assert.match(composer, /onKeyDown=\{\(e\) => \{\s*if \(enterSends\(\{[^}]*\}, coarsePointer\(\)\)\)/);
  assert.doesNotMatch(composer, /e\.key === 'Enter'/, 'a second Enter rule beside enterSends');
  assert.match(composer, /coarsePointer\(\) \? 'Message Claude' : 'Message Claude \(Enter to send, Shift\+Enter for a new line\)'/);
});

test('the keyboard inset is what the keyboard covers of the layout, and nothing for a toolbar or a zoom', () => {
  // iPhone 390×844: the layout stays 844 tall, the visible part shrinks to 844 − 336 for the keyboard.
  assert.equal(keyboardInset(844, 508, 1), 336);
  // Android with resizes-content: the layout shrinks with the visible part.
  assert.equal(keyboardInset(508, 508, 1), 0);
  // Safari's bottom bar collapsing or showing moves the visible height by about 50 px; not a keyboard.
  assert.equal(keyboardInset(844, 794, 1), 0);
  assert.equal(keyboardInset(744, 794, 1), 0);
  // A pinch zoom ×2 halves the visible height; not a keyboard either.
  assert.equal(keyboardInset(844, 422, 2), 0);
});

/** An iPhone 390×844 as followKeyboard sees it: the visible part, the focus, the listeners and the timers, all by hand. */
function phone() {
  const vvListeners: Record<string, () => void> = {};
  const winListeners: Record<string, () => void> = {};
  const docListeners: Record<string, () => void> = {};
  const timers: (() => void)[] = [];
  const props = new Map<string, string>();
  const scrolled: number[][] = [];
  const vv = { height: 844, scale: 1, offsetTop: 0, addEventListener: (t: string, f: () => void) => { vvListeners[t] = f; } };
  const win = {
    visualViewport: vv,
    scrollY: 0,
    scrollTo: (x: number, y: number) => { scrolled.push([x, y]); win.scrollY = y; vv.offsetTop = 0; },
    addEventListener: (t: string, f: () => void) => { winListeners[t] = f; },
    setTimeout: (f: () => void) => { timers.push(f); },
    document: {
      activeElement: { tagName: 'BODY' } as FocusedElement | null,
      addEventListener: (t: string, f: () => void) => { docListeners[t] = f; },
      documentElement: { clientHeight: 844, style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } },
    },
  };
  /** Runs every timer that is due, as the browser would once the event has been handled. */
  const flush = () => { for (const f of timers.splice(0)) f(); };
  return { vv, win, vvListeners, winListeners, docListeners, props, scrolled, flush };
}

const box: FocusedElement = { tagName: 'TEXTAREA' };
const body: FocusedElement = { tagName: 'BODY' };

test('followKeyboard puts the keyboard height in --kb, scrolls a panned page back, and clears it when the keyboard goes', () => {
  const { vv, win, vvListeners: listeners, props, scrolled } = phone();
  win.document.activeElement = box;
  followKeyboard(win);
  assert.equal(props.has('--kb'), false, 'no keyboard at the start');

  // The keyboard comes up and iOS pans the page 200 px to show the box.
  vv.height = 508; vv.offsetTop = 200; win.scrollY = 200;
  listeners.resize!();
  assert.equal(props.get('--kb'), '336px');
  assert.deepEqual(scrolled, [[0, 0]]);

  vv.height = 844;
  listeners.resize!();
  assert.equal(props.has('--kb'), false);
  assert.deepEqual(scrolled, [[0, 0]], 'no scroll without a keyboard');
});

test('the keyboard goes with the focus: --kb is cleared on blur even when the visible part never reports a resize (#262)', () => {
  const p = phone();
  p.win.document.activeElement = box;
  followKeyboard(p.win);
  p.vv.height = 508;
  p.vvListeners.resize!();
  assert.equal(p.props.get('--kb'), '336px');

  // A sensitive Allow: the passkey dialog's button takes the focus, Face ID's sheet covers the page, the card goes.
  // iOS hides the keyboard, but the page gets no resize for it, and the visible height it reads is still the old one.
  p.win.document.activeElement = body;
  p.docListeners.focusout!();
  p.flush();
  assert.equal(p.props.has('--kb'), false, 'no field has the focus, so there is no keyboard');
});

test('a removed field leaves no focus behind, and the page coming back measures again (#262)', () => {
  const p = phone();
  p.win.document.activeElement = box;
  followKeyboard(p.win);
  p.vv.height = 508;
  p.vvListeners.resize!();
  assert.equal(p.props.get('--kb'), '336px');

  // The deny box goes with its card as the prompt is decided, the focus falls back to the body without a focusout
  // in some browsers, and the window gets its focus back as Face ID's sheet closes.
  p.win.document.activeElement = null;
  p.winListeners.focus!();
  p.flush();
  assert.equal(p.props.has('--kb'), false);

  // The same after the page was hidden and shown again, or turned, with the field still focused and no keyboard left.
  const events = { visibilitychange: p.docListeners, pageshow: p.winListeners, orientationchange: p.winListeners, resize: p.winListeners };
  for (const [type, on] of Object.entries(events)) {
    p.win.document.activeElement = box;
    p.vv.height = 508;
    p.vvListeners.resize!();
    assert.equal(p.props.get('--kb'), '336px', type);
    p.vv.height = 844;
    on[type]!();
    p.flush();
    assert.equal(p.props.has('--kb'), false, type);
  }
});

test('moving the focus from one field to another keeps the keyboard, and a late keyboard is caught once it settles', () => {
  const p = phone();
  p.win.document.activeElement = box;
  followKeyboard(p.win);
  p.vv.height = 508;
  p.vvListeners.resize!();

  // focusout fires while the focus is between the two; by the time the timer runs the next field has it.
  p.win.document.activeElement = body;
  p.docListeners.focusout!();
  p.win.document.activeElement = { tagName: 'INPUT', type: 'text' };
  p.docListeners.focusin!();
  p.flush();
  assert.equal(p.props.get('--kb'), '336px');

  // A field gets the focus with the keyboard still on its way up: the later measurement sees it.
  const q = phone();
  followKeyboard(q.win);
  q.win.document.activeElement = box;
  q.docListeners.focusin!();
  q.vv.height = 508;
  q.flush();
  assert.equal(q.props.get('--kb'), '336px');
});

test('only a field the keyboard types into counts as one', () => {
  assert.equal(editable({ tagName: 'TEXTAREA' }), true);
  assert.equal(editable({ tagName: 'INPUT' }), true, 'an input with no type is text');
  assert.equal(editable({ tagName: 'input', type: 'search' }), true);
  assert.equal(editable({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(editable({ tagName: 'BUTTON' }), false, "the passkey dialog's Continue, Allow once");
  assert.equal(editable({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(editable({ tagName: 'TEXTAREA', readOnly: true }), false);
  assert.equal(editable({ tagName: 'INPUT', disabled: true }), false);
  assert.equal(editable({ tagName: 'BODY' }), false);
  assert.equal(editable(null), false);
});

test('the shell is the screen less the keyboard, and Android resizes the layout for the keyboard', () => {
  // Only where dvh is known: a var() in the value would otherwise void the 100% fallback, not fall back to it.
  const supports = css.match(/@supports \(height: 100dvh\)\s*\{([^{}]*\{[^{}]*\})\s*\}/)?.[1] ?? '';
  assert.equal(valueFor(supports, '#root', 'height'), 'calc(100dvh - var(--kb, 0px))');
  const outside = split().base.replace(/@supports \(height: 100dvh\)\s*\{[^{}]*\{[^{}]*\}\s*\}/, '');
  assert.equal(valueFor(outside, '#root', 'height'), '100%', 'the fallback for a browser without dvh');
  const meta = read('web/index.html').match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? '';
  assert.ok(meta.split(',').map((s) => s.trim()).includes('interactive-widget=resizes-content'), meta);
  assert.match(read('web/src/main.tsx'), /^followKeyboard\(window\);$/m);
});

test('at 390 px the message box is 16 px, so iOS does not zoom when it gets the focus; wider it keeps the page size', () => {
  // 16 px is the size below which iOS Safari zooms in on a focused text field.
  const { phone, base } = split();
  assert.equal(valueFor(phone, '.composer textarea', 'font-size'), '16px');
  assert.equal(valueFor(base, '.composer textarea', 'font-size'), undefined);
});
