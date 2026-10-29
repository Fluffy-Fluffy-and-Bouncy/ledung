// The message box in the name colour of whom you are writing to (issue #133), and each question in "Waiting for
// you" in the colour of whoever asked it, labelled "<tier> - <project>" (#135): which colour each gets, and that
// text, placeholder, label and focus border stay readable on the tint in both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAME_COLOURS, type ProjectColours } from '../src/shared/name-colours.ts';
import { CHATS } from '../src/shared/protocol.ts';
import { nameTint, questionLabel, withChatsColour } from '../web/src/nameTint.ts';

const project = (name: string, colours: ProjectColours) => ({ name, colours });
const projects = [
  project('acme', { manager: 'blue', sessions: 'teal' }),
  project('docs', { manager: 'amber', sessions: 'same' }),
  project('billing', { manager: 'pink', sessions: 'none' }),
  project('plain', { manager: null, sessions: 'same' }),
];
const pair = (key: keyof typeof NAME_COLOURS) => ({ '--name-light': NAME_COLOURS[key].light, '--name-dark': NAME_COLOURS[key].dark });

test('writing to a manager: the manager\'s name colour', () => {
  assert.deepEqual(nameTint({ project: 'acme', role: 'manager' }, projects), pair('blue'));
});

test('writing to a session: its sessions\' colour', () => {
  assert.deepEqual(nameTint({ project: 'acme', role: 'session' }, projects), pair('teal'));
});

test('sessions "same as the manager": the manager\'s colour', () => {
  assert.deepEqual(nameTint({ project: 'docs', role: 'session' }, projects), pair('amber'));
});

test('no colour: none, so the box falls back to the accent and no tint', () => {
  assert.equal(nameTint({ project: 'plain', role: 'manager' }, projects), undefined);
  assert.equal(nameTint({ project: 'plain', role: 'session' }, projects), undefined);
  assert.equal(nameTint({ project: 'billing', role: 'session' }, projects), undefined);
  assert.equal(nameTint({ project: 'removed', role: 'session' }, projects), undefined);
});

test("a chat: the chats' one colour (#222), none until one is chosen", () => {
  assert.deepEqual(nameTint({ project: CHATS, role: 'session' }, withChatsColour(projects, { colour: 'purple' })), pair('purple'));
  assert.equal(nameTint({ project: CHATS, role: 'session' }, withChatsColour(projects, { colour: null })), undefined);
  assert.equal(nameTint({ project: CHATS, role: 'session' }, withChatsColour(projects, null)), undefined, 'chats settings not loaded yet');
  assert.deepEqual(nameTint({ project: 'acme', role: 'session' }, withChatsColour(projects, { colour: 'purple' })), pair('teal'), 'projects keep their own');
});

test('a question from a session no longer known: no colour', () => {
  assert.equal(nameTint(undefined, projects), undefined);
});

test('the label on a question\'s border: "<tier> - <project>", the project alone with no tier', () => {
  assert.equal(questionLabel('Blocks a finished PR', 'Project Ledung'), 'Blocks a finished PR - Project Ledung');
  assert.equal(questionLabel(null, 'Project Ledung'), 'Project Ledung');
  assert.equal(questionLabel('Process', ''), 'Process');
});

test('the label is never empty: no tier and no known project reads "Question"', () => {
  assert.equal(questionLabel(null, ''), 'Question');
});

// WCAG 2 relative luminance and contrast ratio, from the definition.
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// color-mix(in srgb, c p%, bg), as the browser works it out.
const mix = (c: string, bg: string, p: number) => rgb(c).map((x, i) => x * p + rgb(bg)[i]! * (1 - p));

// The page colours and the tint's strength are read from the stylesheet, so a change to either is checked too.
const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'styles.css'), 'utf8');
function token(name: string): [string, string] {
  const m = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css);
  assert.ok(m, `${name} in the stylesheet`);
  return [m[1]!, m[2]!];
}
const tintRule = /\.composer\.tinted textarea \{[^}]*background: color-mix\(in srgb, var\(--nc\) (\d+(?:\.\d+)?)%, var\(--bg\)\)/.exec(css);
const messageTintRule = /\.msg\.assistant\.tinted \.msg-body \{[^}]*background: color-mix\(in srgb, var\(--nc\) (\d+(?:\.\d+)?)%, var\(--panel\)\)/.exec(css);
const questionTintRule = /\.name-tinted\.tinted \{[^}]*background: color-mix\(in srgb, var\(--nc\) (\d+(?:\.\d+)?)%, var\(--panel\)\)/.exec(css);

test('the tint is the mockup\'s 5% and the placeholder uses --muted', () => {
  assert.ok(tintRule, 'the tinted box\'s background in the stylesheet');
  assert.equal(Number(tintRule[1]), 5);
  assert.match(css, /\.composer textarea::placeholder \{[^}]*color: var\(--muted\)/);
});

test('a question has the same 5% tint, on the panel it sits on, and is not faded once answered', () => {
  assert.ok(questionTintRule, 'the tinted question\'s background in the stylesheet');
  assert.equal(Number(questionTintRule[1]), 5);
  const faded = /\.qrow\.done \{[^}]*opacity/;
  assert.match('.qrow.done { opacity: 0.8; }', faded, 'the check finds the fade it replaced');
  assert.doesNotMatch(css, faded);
});

test("the session's own messages: the same 5% tint on the panel, in its colour, and no coloured edge (#269)", () => {
  assert.ok(messageTintRule, "the tinted message's background in the stylesheet");
  assert.equal(Number(messageTintRule[1]), 5);
  assert.match(css, /\.msg\.assistant\.tinted \{[^}]*--nc: light-dark\(var\(--name-light\), var\(--name-dark\)\)/);
  const edge = /\.msg\.assistant[^{]*\{[^}]*border(-left)?(-color)?:/;
  assert.match('.msg.assistant.tinted .msg-body { border-left: 4px solid var(--nc); }', edge, 'the check finds an edge');
  assert.doesNotMatch(css, edge);
});

test('text and placeholder read at 4.5:1 or better on every tint, light and dark', () => {
  const [text, muted] = [token('--text'), token('--muted')];
  // The message box mixes with --bg, a question with --panel.
  for (const [what, base, rule] of [['message box', token('--bg'), tintRule], ['question', token('--panel'), questionTintRule], ['message', token('--panel'), messageTintRule]] as const) {
    const p = Number(rule![1]) / 100;
    for (const [key, c] of Object.entries(NAME_COLOURS)) {
      for (const side of [0, 1] as const) {
        const fill = mix(side ? c.dark : c.light, base[side], p);
        const theme = side ? 'dark' : 'light';
        assert.ok(contrast(rgb(text[side]), fill) >= 4.5, `text on ${what} ${key} ${theme}: ${contrast(rgb(text[side]), fill).toFixed(2)}`);
        assert.ok(contrast(rgb(muted[side]), fill) >= 4.5, `grey on ${what} ${key} ${theme}: ${contrast(rgb(muted[side]), fill).toFixed(2)}`);
      }
    }
  }
});

test('the border label reads at 4.5:1 or better: the name colour, or the grey with none, on the page behind it', () => {
  assert.match(css, /\.border-label \{[^}]*background: var\(--bg\);[^}]*color: var\(--muted\)/);
  assert.match(css, /\.name-tinted\.tinted \.border-label \{[^}]*color: var\(--nc\)/);
  const [bg, muted] = [token('--bg'), token('--muted')];
  for (const [key, c] of Object.entries(NAME_COLOURS)) {
    assert.ok(contrast(rgb(c.light), rgb(bg[0])) >= 4.5, `${key} label, light`);
    assert.ok(contrast(rgb(c.dark), rgb(bg[1])) >= 4.5, `${key} label, dark`);
  }
  assert.ok(contrast(rgb(muted[0]), rgb(bg[0])) >= 4.5 && contrast(rgb(muted[1]), rgb(bg[1])) >= 4.5, 'grey label');
});

test('the focus border reads at 3:1 or better against the panel, with a name colour or the accent', () => {
  assert.match(css, /\.composer textarea:focus \{[^}]*outline: none;[^}]*border-color: var\(--nc\)/);
  const panel = token('--panel');
  const accent = token('--accent');
  const borders = [...Object.values(NAME_COLOURS).map((c) => [c.light, c.dark] as const), [accent[0], accent[1]] as const];
  for (const [l, d] of borders) {
    assert.ok(contrast(rgb(l), rgb(panel[0])) >= 3, `${l} on the light panel`);
    assert.ok(contrast(rgb(d), rgb(panel[1])) >= 3, `${d} on the dark panel`);
  }
});
