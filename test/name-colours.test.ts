// Name colours (issue #83): only palette colours, each readable on the page's surfaces in both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAME_COLOURS, nameColourFor, parseColours } from '../src/shared/name-colours.ts';

// WCAG 2 relative luminance and contrast ratio, from the definition.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// The surfaces a name sits on (page, sidebar, an open sidebar row), read from the stylesheet so a
// theme change is checked too: each is a light-dark() pair (#113), its first value light, its second dark.
const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'styles.css'), 'utf8');
function surfaces(side: 1 | 2): string[] {
  return ['--bg', '--panel', '--panel-2'].map((name) => {
    const m = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css);
    assert.ok(m, `${name} in the stylesheet`);
    return m[side]!;
  });
}
const light = surfaces(1);
const dark = surfaces(2);

test('every name colour reads at 4.5:1 or better on the light and dark surfaces', () => {
  for (const [key, c] of Object.entries(NAME_COLOURS)) {
    for (const bg of light) assert.ok(contrast(c.light, bg) >= 4.5, `${key} light ${c.light} on ${bg}: ${contrast(c.light, bg).toFixed(2)}`);
    for (const bg of dark) assert.ok(contrast(c.dark, bg) >= 4.5, `${key} dark ${c.dark} on ${bg}: ${contrast(c.dark, bg).toFixed(2)}`);
  }
});

test('only palette colours are accepted; sessions default to the manager\'s', () => {
  assert.deepEqual(parseColours({}), { manager: null, sessions: 'same' });
  assert.deepEqual(parseColours({ manager: 'teal', sessions: 'pink' }), { manager: 'teal', sessions: 'pink' });
  assert.deepEqual(parseColours({ manager: 'teal', sessions: 'none' }), { manager: 'teal', sessions: 'none' });
  for (const bad of [{ manager: '#ff0000' }, { manager: 'red; background: url(x)' }, { sessions: 'toString' }, { manager: 3 }]) {
    assert.throws(() => parseColours(bad), /not one of the name colours/, JSON.stringify(bad));
  }
});

test("a session's name takes its sessions' colour, the manager's when 'same', none when 'none'", () => {
  assert.equal(nameColourFor({ manager: 'blue', sessions: 'same' }, 'manager'), 'blue');
  assert.equal(nameColourFor({ manager: 'blue', sessions: 'same' }, 'session'), 'blue');
  assert.equal(nameColourFor({ manager: 'blue', sessions: 'green' }, 'session'), 'green');
  assert.equal(nameColourFor({ manager: 'blue', sessions: 'none' }, 'session'), null);
  assert.equal(nameColourFor({ manager: null, sessions: 'red' }, 'manager'), null);
  assert.equal(nameColourFor({ manager: null, sessions: 'red' }, 'session'), 'red');
  assert.equal(nameColourFor(undefined, 'session'), null);
});
