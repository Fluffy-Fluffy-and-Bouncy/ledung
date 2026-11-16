import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_THEME, THEMES, THEME_KEY, applyTheme, parseTheme, readTheme, saveTheme, type ThemeRoot, type ThemeStore } from '../web/src/theme.ts';

function memoryStore(): ThemeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

function fakeRoot(): ThemeRoot & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  return { attrs, setAttribute: (k: string, v: string) => { attrs.set(k, v); } };
}

test('nothing stored, a "system" from before, or anything unknown is Dark (the default, #345)', () => {
  assert.equal(DEFAULT_THEME, 'dark');
  for (const raw of [null, '', 'dark', 'Dark', 'blue', 'system', 'System']) assert.equal(parseTheme(raw), 'dark');
  const store = memoryStore();
  store.data.set(THEME_KEY, 'system'); // System, stored before #345, is gone
  assert.equal(readTheme(store), 'dark');
  assert.equal(readTheme(memoryStore()), 'dark');
});

test('a stored Light is kept: only the default changed (#345)', () => {
  assert.equal(parseTheme('light'), 'light');
  const store = memoryStore();
  store.data.set(THEME_KEY, 'light'); // stored before #345
  assert.equal(readTheme(store), 'light');
});

test('every choice is saved by name and read back, as after a reload; the default too', () => {
  const store = memoryStore();
  for (const theme of ['light', 'dark'] as const) {
    saveTheme(store, theme);
    assert.equal(store.data.get(THEME_KEY), theme);
    assert.equal(readTheme(store), theme);
  }
});

test('Settings offers Dark first, then Light (basic), and no System (question #2026)', () => {
  assert.deepEqual(THEMES.map((t) => t.id), ['dark', 'light']);
  assert.deepEqual(THEMES.map((t) => t.label), ['Dark', 'Light (basic)']);
});

test('a store that throws (private mode) neither breaks reading nor saving', () => {
  const broken: ThemeStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readTheme(broken), 'dark');
  assert.doesNotThrow(() => saveTheme(broken, 'light'));
});

test('applying marks the root with the choice', () => {
  const root = fakeRoot();
  for (const theme of ['dark', 'light'] as const) {
    applyTheme(root, theme);
    assert.equal(root.attrs.get('data-theme'), theme);
  }
});

// The page follows the choice only if no colour is picked by the computer's setting behind its back:
// a `prefers-color-scheme` rule ignores the mark the choice sets.
const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');

test('the stylesheet lets the mark decide: dark with no mark, light by its mark, and no rule asks the computer', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark;/, 'dark before the page code has run (#345)');
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.doesNotMatch(css, /color-scheme:\s*light dark/, 'no scheme left to the computer');
  assert.doesNotMatch(css, /prefers-color-scheme/);
});

test('the page is dark before its stylesheet loads, so the first paint is dark (#345)', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="color-scheme" content="dark"\s*\/?>/);
});

test('no page code asks the computer for its scheme either', () => {
  const src = new URL('../web/src/', import.meta.url);
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(tsx?|css)$/.test(f));
  assert.ok(files.length > 10, 'page sources found');
  const asking = files.filter((f) => /prefers-color-scheme/.test(readFileSync(new URL(f, src), 'utf8')));
  assert.deepEqual(asking, []);
});

test('the main colours have a light and a dark value', () => {
  for (const name of ['--bg', '--panel', '--panel-2', '--text', '--muted', '--border', '--accent', '--code-bg']) {
    assert.match(css, new RegExp(`${name}:\\s*light-dark\\(#[0-9a-f]{6}, #[0-9a-f]{6}\\);`), name);
  }
});
