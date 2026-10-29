// Searching Settings (issue #367): the matching against a fixed list, and the words the issue names against the real
// lists of every tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSettings, normalize, searchSettings, type SearchTab } from '../web/src/settingsSearch.ts';
import type { SettingsGroup } from '../web/src/settingsGroups.ts';

const groups: SettingsGroup[] = [
  {
    id: 'one', label: 'Update & restart', part: 'ledung',
    settings: [{ label: 'Restart now', about: 'Loads the newest release' }, { label: 'Colour scheme', keywords: ['theme', 'dark'], storedIn: 'browser' }],
  },
  { id: 'two', label: 'Remote', part: 'ledung', settings: [{ label: 'Phones' }, { label: 'Access', about: 'Reach it from anywhere', keywords: ['phone'] }] },
];
const fixed: SearchTab[] = [
  { id: 'a', label: 'Tab A', groups, viewOf: (g) => `a:${g}` },
  { id: 'b', label: 'Tab B', groups: [groups[1]!], viewOf: (g) => `b:${g}` },
];
const names = (q: string, current: string | null = null) => matchSettings(q, fixed, current).map((h) => `${h.tab}/${h.label}`);

test('an empty query or one of spaces and punctuation finds nothing', () => {
  assert.deepEqual(matchSettings('', fixed), []);
  assert.deepEqual(matchSettings('  & ', fixed), []);
});

test('a word finds the settings it begins a word of, in the name, a keyword, the group or the explanation', () => {
  assert.deepEqual(names('restart'), ['a/Restart now', 'a/Colour scheme']); // the name, then the group's name
  assert.deepEqual(names('theme'), ['a/Colour scheme']);
  assert.deepEqual(names('newest'), ['a/Restart now']);
  assert.deepEqual(names('tart'), [], 'inside a word is not a match');
});

test('every word must match; case, accents and punctuation do not matter', () => {
  assert.deepEqual(names('RESTART new'), ['a/Restart now']);
  assert.deepEqual(names('restart phone'), []);
  assert.deepEqual(names('cölour-SCHEME'), ['a/Colour scheme']);
  assert.equal(normalize("Chats' names"), 'chats names');
});

test('the name ranks before a keyword, ties keep the tabs order with the current tab first', () => {
  assert.deepEqual(names('phone'), ['a/Phones', 'b/Phones', 'a/Access', 'b/Access']);
  assert.deepEqual(names('phone', 'b'), ['b/Phones', 'a/Phones', 'b/Access', 'a/Access']);
});

test('a hit carries its tab, group and the view that opens the group', () => {
  assert.deepEqual(matchSettings('colour', fixed)[0], {
    tab: 'a', tabLabel: 'Tab A', group: 'one', groupLabel: 'Update & restart', label: 'Colour scheme', about: undefined, storedIn: 'browser', view: 'a:one',
  });
  assert.equal(matchSettings('access', fixed, 'b')[0]!.view, 'b:two');
});

test('no match is an empty list, never a guess', () => {
  assert.deepEqual(names('xylophone'), []);
  assert.deepEqual(searchSettings('xylophone', [{ name: 'Demo' }], 'ledung'), []);
});

// The issue's words, against every tab with one project ("Demo"): the settings Done looks like expects.
const real = (q: string, current: string | null = 'ledung') => searchSettings(q, [{ name: 'Demo' }], current).map((h) => `${h.tabLabel} › ${h.groupLabel} › ${h.label}`);

test('"restart" finds Restart Ledung first', () => {
  assert.equal(real('restart')[0], 'Ledung › Update & restart › Restart Ledung');
});

test('"phone" finds Phones and Remote access', () => {
  const hits = real('phone');
  assert.ok(hits.includes('Ledung › Remote & devices › Phones'));
  assert.ok(hits.includes('Ledung › Remote & devices › Remote access'));
  assert.equal(hits[0], 'Ledung › Remote & devices › Phones');
});

test('"theme" finds Appearance; "colour" finds it and a project\'s Look', () => {
  assert.equal(real('theme')[0], 'Ledung › Look & feel › Appearance');
  const colour = real('colour');
  assert.ok(colour.includes('Ledung › Look & feel › Appearance'));
  assert.ok(colour.includes('Demo › Look › Manager name'));
  assert.ok(colour.includes("Chats › Look › Chats' names"));
});

test('"skills" finds the Ledung default and the project\'s own; the open project\'s first', () => {
  assert.deepEqual(real('skills').slice(0, 2), ['Ledung › Sessions › Skills', 'Demo › Skills & profiles › Skills']);
  assert.equal(real('skills', 'ps:Demo')[0], 'Demo › Skills & profiles › Skills');
});

test('"usage" finds the usage stops and publishing usage, on the Ledung and the project tab', () => {
  const hits = real('usage');
  for (const want of ['Ledung › Claude & usage › Usage stops', 'Ledung › Claude & usage › Publish usage', 'Demo › General › Publish its usage under its name']) {
    assert.ok(hits.includes(want), want);
  }
});

test('"always goes to you" finds the Chats and project tab\'s lists, and nothing else first', () => {
  assert.deepEqual(real('always goes to you').slice(0, 2), ['Chats › What always goes to you › What always goes to you', 'Demo › What always goes to you › What always goes to you']);
});

test('every project gets its own hits, opening its own tab', () => {
  const hits = searchSettings('ticket pattern', [{ name: 'Demo' }, { name: 'Web' }], 'ps:Web');
  assert.deepEqual(hits.map((h) => h.view), ['ps:Web/tickets', 'ps:Demo/tickets']);
});
