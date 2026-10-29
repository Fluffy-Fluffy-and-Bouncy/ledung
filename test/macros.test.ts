// Macros (issue #410, placement B, Martin 2026-10-29 in Ledung question #425): the keybind rules, placeholders, scope,
// what a click does, and the list the manager keeps from Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { CHATS, type ServerEvent } from '../src/shared/protocol.ts';
import { fillMacro, freeKeys, keyLabel, keyOf, keyProblem, macroAction, macrosFor, macrosProblem, moved, validKey, type Macro } from '../src/shared/macros.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const macro = (over: Partial<Macro> = {}): Macro => ({ id: 'm-1', name: 'Continue', text: 'Continue.', send: true, key: null, chip: true, project: null, ...over });
const press = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) =>
  ({ code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta });
const refused = (key: string, list: Macro[] = [], own: string | null = null) => {
  const p = keyProblem(key, list, own);
  return p && 'refused' in p ? p.refused : null;
};
const warning = (key: string) => {
  const p = keyProblem(key, [], null);
  return p && 'warning' in p ? p.warning : null;
};

test('a key press is read on the physical key, with its modifiers in one order', () => {
  assert.equal(keyOf(press('Digit1', { ctrl: true, shift: true })), 'Ctrl+Shift+1');
  // A Mac's Option+2 types @ on a Swedish keyboard; the code is still Digit2.
  assert.equal(keyOf(press('Digit2', { alt: true })), 'Alt+2');
  assert.equal(keyOf(press('KeyG', { shift: true, alt: true })), 'Alt+Shift+G');
  assert.equal(keyOf(press('KeyK', { meta: true })), 'Cmd+K');
  assert.equal(keyOf(press('KeyG')), null, 'no modifier: it types');
  assert.equal(keyOf(press('Enter', { ctrl: true })), null, 'not a letter or a digit');
  assert.equal(keyOf(press('Numpad1', { alt: true })), null, 'Alt with the number pad types a character on Windows');
  assert.ok(validKey('Ctrl+Shift+1'));
  assert.ok(!validKey('Shift+Ctrl+1'), 'modifiers out of order');
  assert.ok(!validKey('Ctrl+Ctrl+1'));
  assert.ok(!validKey('Ctrl+F5'));
  assert.equal(keyLabel('Ctrl+Shift+1', true), '⌃⇧1');
  assert.equal(keyLabel('Ctrl+Shift+1', false), 'Ctrl+Shift+1');
});

test('keybinds the browser, the system or Ledung keeps are refused, with the reason', () => {
  assert.match(refused('Ctrl+O')!, /tool calls in Ledung/);
  assert.match(refused('Ctrl+T')!, /browser/);
  assert.match(refused('Ctrl+Shift+I')!, /browser/, 'developer tools');
  assert.match(refused('Ctrl+Alt+2')!, /AltGr/, 'AltGr+2 is @ on a Swedish Windows keyboard');
  assert.match(refused('Cmd+1')!, /Cmd/);
  assert.match(refused('Alt+F')!, /menu/);
  assert.match(refused('Alt+D')!, /address bar/);
  assert.match(refused('Shift+1')!, /types/);
  const list = [macro({ id: 'm-1', name: 'Continue', key: 'Ctrl+Shift+1' })];
  assert.match(refused('Ctrl+Shift+1', list, 'm-2')!, /“Continue” has this keybind/);
  assert.equal(refused('Ctrl+Shift+1', list, 'm-1'), null, 'its own keybind is no clash');
});

test('keybinds that work on one system and not the other are allowed with a warning', () => {
  assert.match(warning('Ctrl+1')!, /Windows and Linux.*switches browser tabs/);
  assert.match(warning('Alt+2')!, /Mac.*@/);
  assert.match(warning('Alt+2')!, /Linux Alt\+1–9/);
  assert.doesNotMatch(warning('Alt+Shift+G')!, /Linux/);
  assert.equal(keyProblem('Ctrl+Shift+5', [], null), null, 'Ctrl+Shift with a digit types nothing on the Mac or Windows');
});

test('the free keybinds offered skip those taken', () => {
  assert.deepEqual(freeKeys([], null), ['Ctrl+Shift+1', 'Ctrl+Shift+2', 'Ctrl+Shift+3']);
  const list = [macro({ id: 'a', key: 'Ctrl+Shift+1' }), macro({ id: 'b', name: 'B', key: 'Ctrl+Shift+3' })];
  assert.deepEqual(freeKeys(list, null), ['Ctrl+Shift+2', 'Ctrl+Shift+4', 'Ctrl+Shift+5']);
  assert.deepEqual(freeKeys(list, 'a'), ['Ctrl+Shift+1', 'Ctrl+Shift+2', 'Ctrl+Shift+4'], 'its own keybind counts as free');
});

test('a session has the global macros and its own project\'s, in the list\'s order (Martin 2026-10-29 13:46: global or per project)', () => {
  const list = [macro({ id: 'a', project: 'Orchard' }), macro({ id: 'b' }), macro({ id: 'c', project: 'Lantern' }), macro({ id: 'd', project: CHATS })];
  assert.deepEqual(macrosFor(list, 'Orchard').map((m) => m.id), ['a', 'b']);
  assert.deepEqual(macrosFor(list, CHATS).map((m) => m.id), ['b', 'd']);
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
});

test('placeholders are filled from the session; one with no value stays and is reported', () => {
  const s = { project: 'Orchard', title: 'Fix the login', branch: 'agent/fix-408-away', pr: { number: 412 } as never, tickets: [] };
  assert.deepEqual(fillMacro('{issue} on {branch}, PR {pr} in {project} ({session})', s),
    { text: '#408 on agent/fix-408-away, PR #412 in Orchard (Fix the login)', missing: [] });
  assert.equal(fillMacro('{issue}', { ...s, tickets: [{ id: 'AB#77', url: 'x' }] }).text, 'AB#77', 'a ticket before the branch\'s number');
  assert.equal(fillMacro('{project}', { ...s, project: CHATS }).text, 'Chats');
  assert.deepEqual(fillMacro('Review {pr} for {issue} and {pr}', { ...s, pr: null, branch: 'main' }),
    { text: 'Review {pr} for {issue} and {pr}', missing: ['pr', 'issue'] });
  assert.equal(fillMacro('{unknown} stays', s).text, '{unknown} stays');
});

test('a click sends or inserts as the macro says; Shift does the other; "!" and unfilled text always go to the box', () => {
  const filled = { text: 'Continue.', missing: [] };
  assert.equal(macroAction(macro({ send: true }), filled, false), 'send');
  assert.equal(macroAction(macro({ send: true }), filled, true), 'insert');
  assert.equal(macroAction(macro({ send: false }), filled, false), 'insert');
  assert.equal(macroAction(macro({ send: false }), filled, true), 'send');
  assert.equal(macroAction(macro({ send: true }), { text: '!npm test', missing: [] }, false), 'insert', 'the shell command\'s own check (#212)');
  assert.equal(macroAction(macro({ send: true }), { text: 'Review {pr}', missing: ['pr'] }, false), 'insert');
});

test('a list with a macro nothing could use, a shared keybind or a refused one is not kept', () => {
  assert.equal(macrosProblem([macro({ key: 'Ctrl+Shift+1' }), macro({ id: 'm-2', chip: false, key: 'Ctrl+Shift+2' })]), null, 'a keybind with no chip is fine');
  assert.equal(macrosProblem([macro({ chip: true, key: null })]), null, 'a chip with no keybind is fine');
  assert.match(macrosProblem([macro({ chip: false, key: null })])!, /neither a chip nor a keybind/);
  assert.match(macrosProblem([macro({ key: 'Ctrl+Shift+1' }), macro({ id: 'm-2', name: 'Other', key: 'Ctrl+Shift+1' })])!, /same keybind/);
  assert.match(macrosProblem([macro({ key: 'Ctrl+O' })])!, /tool calls/);
  assert.equal(macrosProblem([macro({ key: 'Alt+2' })]), null, 'a warning does not stop it');
  assert.match(macrosProblem([macro(), macro()])!, /id/);
  assert.match(macrosProblem([macro({ name: '  ' })])!, /name/);
});

test('the manager keeps the list from Settings, tells every page, and refuses one that can\'t be kept', () => {
  const store = new Store(openDatabase(':memory:'));
  const events: ServerEvent[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon' }), store, (e) => events.push(e)));
  assert.deepEqual(manager.macros(), []);
  const list = [macro({ name: ' Continue ', key: 'Ctrl+Shift+1' }), macro({ id: 'm-2', name: 'Status?', text: 'Where do things stand?', send: false, chip: false, key: 'Ctrl+Shift+2', project: 'Orchard' })];
  const kept = manager.setMacros({ macros: list });
  assert.equal(kept[0]!.name, 'Continue', 'the name is trimmed');
  assert.deepEqual(manager.macros(), kept);
  const told = events.filter((e): e is Extract<ServerEvent, { type: 'macros' }> => e.type === 'macros').at(-1);
  assert.deepEqual(told?.macros, kept, 'the pages are told');
  assert.throws(() => manager.setMacros({ macros: [macro({ chip: false })] }), /neither a chip nor a keybind/);
  assert.throws(() => manager.setMacros({ macros: [{ ...macro(), extra: 1 }] }), /can't be kept/);
  assert.throws(() => manager.setMacros({}), /can't be kept/);
  assert.deepEqual(manager.macros(), kept, 'a refused list changes nothing');
  manager.setMacros({ macros: [] });
  assert.deepEqual(manager.macros(), []);
});
