import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { THEME_KEY, applyTheme, parseTheme, readTheme, saveTheme, type ThemeRoot, type ThemeStore } from '../web/src/theme.ts';

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
  return { attrs, setAttribute: (k: string, v: string) => { attrs.set(k, v); }, removeAttribute: (k: string) => { attrs.delete(k); } };
}

test('nothing stored, or anything unknown, is System (the default)', () => {
  for (const raw of [null, '', 'system', 'Dark', 'blue']) assert.equal(parseTheme(raw), 'system');
  assert.equal(readTheme(memoryStore()), 'system');
});

test('a choice is saved and read back, as after a reload', () => {
  const store = memoryStore();
  saveTheme(store, 'dark');
  assert.equal(store.data.get(THEME_KEY), 'dark');
  assert.equal(readTheme(store), 'dark');
  saveTheme(store, 'light');
  assert.equal(readTheme(store), 'light');
  saveTheme(store, 'system');
  assert.equal(store.data.has(THEME_KEY), false);
  assert.equal(readTheme(store), 'system');
});

test('a store that throws (private mode) neither breaks reading nor saving', () => {
  const broken: ThemeStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readTheme(broken), 'system');
  assert.doesNotThrow(() => saveTheme(broken, 'dark'));
});

test('applying marks the root with Light or Dark, and System clears the mark', () => {
  const root = fakeRoot();
  applyTheme(root, 'dark');
  assert.equal(root.attrs.get('data-theme'), 'dark');
  applyTheme(root, 'light');
  assert.equal(root.attrs.get('data-theme'), 'light');
  applyTheme(root, 'system');
  assert.equal(root.attrs.has('data-theme'), false);
});

// The page follows the choice only if no colour is picked by the computer's setting behind its back:
// a `prefers-color-scheme` rule ignores the mark the choice sets.
const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');

test('the stylesheet lets the mark decide: each mark sets color-scheme, and no rule asks the computer', () => {
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark;/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
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
