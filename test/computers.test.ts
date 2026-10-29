// Issue #232: the computer tabs and the remote frame (mockup variant A). The list comes from the config's
// "computers"; this computer is the entry with its own public name; tabs only with more than one computer.
// Issue #240: this computer's tab first; names and colours changed in the page go over the config's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseConfig } from '../src/config.ts';
import { COMPUTER_COLOURS, computerList, editComputer, readComputerEdits, shortHostName, withEdits, type ComputerInfo } from '../src/shared/computers.ts';
import { NAME_COLOURS } from '../src/shared/name-colours.ts';
import { computerFrame, computerStyle, inFrame, showsHere, tabWaiting } from '../web/src/computerFrame.ts';

const PC = { name: 'PC', colour: 'purple' as const, publicName: 'copper7meadow4.l.example.test' };
const MAC = { name: 'Mac', colour: 'green' as const, publicName: 'amber3fox9.l.example.test' };
const NAS = { name: 'NAS', colour: 'teal' as const, publicName: 'slate2owl5.l.example.test' };

test('the same list on every computer: this one is the entry with its own public name, and its tab comes first (#240)', () => {
  const onMac = computerList([PC, MAC], MAC.publicName, 'magto-macbenack.local');
  assert.deepEqual(onMac, [
    { id: MAC.publicName, name: 'Mac', colour: 'green', url: 'https://amber3fox9.l.example.test/', here: true, config: { name: 'Mac', colour: 'green' } },
    { id: PC.publicName, name: 'PC', colour: 'purple', url: 'https://copper7meadow4.l.example.test/', here: false, config: { name: 'PC', colour: 'purple' } },
  ]);
  const onPc = computerList([PC, MAC], PC.publicName.toUpperCase(), 'DESKTOP-PC');
  assert.deepEqual(onPc.map((c) => [c.name, c.here]), [['PC', true], ['Mac', false]]);
  // Martin, 2026-10-20 00:39: "the current computer to always be on the left most tab"; the others keep the list's order.
  assert.deepEqual(computerList([PC, NAS, MAC], MAC.publicName, 'h').map((c) => c.name), ['Mac', 'PC', 'NAS']);
  assert.deepEqual(computerList([PC, NAS, MAC], NAS.publicName, 'h').map((c) => c.name), ['NAS', 'PC', 'Mac']);
});

test('a computer not in its own list comes first, named after its host, with no link', () => {
  assert.deepEqual(computerList([PC], undefined, 'magto-macbenack.local'), [
    { id: '', name: 'magto-macbenack', colour: 'green', url: null, here: true, config: { name: 'magto-macbenack', colour: 'green' } },
    { id: PC.publicName, name: 'PC', colour: 'purple', url: 'https://copper7meadow4.l.example.test/', here: false, config: { name: 'PC', colour: 'purple' } },
  ]);
  // With a relay but left out of the list: its own public name is still its address.
  assert.equal(computerList([PC], 'mine.l.example.test', 'h')[0]!.url, 'https://mine.l.example.test/');
  // No list at all: one computer, so no tabs, but the remote frame still has a name for its label.
  assert.deepEqual(computerList([], 'mine.l.example.test', 'DESKTOP-PC').map((c) => [c.name, c.here]), [['DESKTOP-PC', true]]);
  assert.equal(shortHostName(''), 'This computer');
});

test('a computer with no colour gets the first one nobody has', () => {
  const settings = [{ name: 'A', publicName: 'a.example.test' }, { name: 'B', colour: 'green' as const, publicName: 'b.example.test' }, { name: 'C', publicName: 'c.example.test' }];
  const list = computerList(settings, 'b.example.test', 'h');
  assert.deepEqual(list.map((c) => [c.name, c.colour]), [['B', 'green'], ['A', 'purple'], ['C', 'teal']]);
  // Handed out in the config's order, not the tabs': a computer has the same colour whichever computer shows it.
  assert.deepEqual(computerList(settings, 'c.example.test', 'h').map((c) => [c.name, c.colour]), [['C', 'teal'], ['A', 'purple'], ['B', 'green']]);
});

test('computer colours are never blue (the accent, lockdown A) or red (danger, lockdown B), and come from the name colours', () => {
  assert.ok(!COMPUTER_COLOURS.includes('blue' as never) && !COMPUTER_COLOURS.includes('red' as never));
  for (const c of COMPUTER_COLOURS) assert.ok(Object.hasOwn(NAME_COLOURS, c), c);
  assert.equal(new Set(COMPUTER_COLOURS).size, Object.keys(NAME_COLOURS).length - 2);
});

test('the config takes computers, and refuses a colour outside them, a name that is not one DNS name, or one twice', () => {
  const parsed = parseConfig({ computers: [{ ...PC, publicName: ' Copper7Meadow4.L.Example.Test ' }, MAC] }).computers;
  assert.equal(parsed[0]!.publicName, PC.publicName);
  assert.deepEqual(parseConfig({}).computers, []);
  assert.throws(() => parseConfig({ computers: [{ ...PC, colour: 'blue' }] }), /colour/);
  assert.throws(() => parseConfig({ computers: [{ ...PC, colour: 'red' }] }), /colour/);
  for (const bad of ['*.example.test', 'https://pc.example.test', 'pc.example.test:443', '10.0.0.1', 'pc']) {
    assert.throws(() => parseConfig({ computers: [{ ...PC, publicName: bad }] }), /publicName/, bad);
  }
  assert.throws(() => parseConfig({ computers: [PC, { ...MAC, publicName: PC.publicName }] }), /Two computers/);
  assert.throws(() => parseConfig({ computers: [{ ...PC, name: ' ' }] }));
});

test('tabs only with more than one computer; the frame only through the public name, whatever the tabs', () => {
  const two = computerList([PC, MAC], MAC.publicName, 'h');
  const one = computerList([], MAC.publicName, 'Mac');
  assert.deepEqual(computerFrame(two, false), { tabs: two, remote: false, here: two[0] });
  assert.equal(computerFrame(two, true).remote, true);
  assert.deepEqual(computerFrame(one, true), { tabs: null, remote: true, here: one[0] });
  assert.equal(computerFrame(one, false).tabs, null);
  assert.deepEqual(computerStyle(two[1]!), { '--cc-light': NAME_COLOURS.purple.light, '--cc-dark': NAME_COLOURS.purple.dark });
});

test("a name and colour from the page go over the config's; empty or null goes back, and only computer colours", () => {
  const list = computerList([PC, MAC], MAC.publicName, 'h');
  let edits = editComputer({}, list, { id: PC.publicName, name: '  Office ' });
  edits = editComputer(edits, list, { id: PC.publicName, colour: 'amber' });
  assert.deepEqual(edits, { [PC.publicName]: { name: 'Office', colour: 'amber' } });
  assert.deepEqual(withEdits(list, edits).map((c) => [c.name, c.colour]), [['Mac', 'green'], ['Office', 'amber']]);
  // The colour alone back to the config's keeps the name; both back drops the computer's entry.
  edits = editComputer(edits, list, { id: PC.publicName, colour: null });
  assert.deepEqual(edits, { [PC.publicName]: { name: 'Office' } });
  assert.deepEqual(editComputer(edits, list, { id: PC.publicName, name: ' ' }), {});
  // The config's own name or colour is not an edit: the config changing later still shows.
  assert.deepEqual(editComputer({}, list, { id: MAC.publicName, name: 'Mac', colour: 'green' }), {});
  // This computer without a public name is id ''.
  assert.deepEqual(editComputer({}, computerList([PC], undefined, 'host'), { id: '', name: 'Here' }), { '': { name: 'Here' } });
  assert.throws(() => editComputer({}, list, { id: PC.publicName, colour: 'blue' }), /colour/);
  assert.throws(() => editComputer({}, list, { id: PC.publicName, colour: 'red' }), /colour/);
  assert.throws(() => editComputer({}, list, { id: PC.publicName, name: 'x'.repeat(25) }), /24/);
  assert.throws(() => editComputer({}, list, { id: PC.publicName, name: 7 }), /text/);
  assert.throws(() => editComputer({}, list, { id: 'other.example.test', name: 'X' }), /No such computer/);
  assert.throws(() => editComputer({}, list, { id: '__proto__', name: 'X' }), /No such computer/);
});

test('kept edits are read leniently: a value this version does not allow, or a computer no longer listed, is left out', () => {
  const list = computerList([PC, MAC], MAC.publicName, 'h');
  assert.deepEqual(readComputerEdits(null), {});
  assert.deepEqual(readComputerEdits('not json'), {});
  assert.deepEqual(readComputerEdits('[1]'), {});
  const kept = readComputerEdits(JSON.stringify({ [PC.publicName]: { name: 'Office', colour: 'blue' }, [MAC.publicName]: { name: '', colour: 'pink' }, 'gone.example.test': { name: 'Old' } }));
  assert.deepEqual(kept, { [PC.publicName]: { name: 'Office' }, [MAC.publicName]: { colour: 'pink' }, 'gone.example.test': { name: 'Old' } });
  assert.deepEqual(withEdits(list, kept).map((c) => [c.name, c.colour]), [['Mac', 'pink'], ['Office', 'purple']]);
});

test('Settings → Computers changes a tab from the page (#240)', () => {
  const settings = readFileSync(new URL('../web/src/components/SettingsView.tsx', import.meta.url), 'utf8');
  assert.match(settings, /<ComputersSettings computers=\{props\.computers\} run=\{props\.run\} \/>/);
  const view = readFileSync(new URL('../web/src/components/ComputersSettings.tsx', import.meta.url), 'utf8');
  assert.match(view, /api\.editComputer\(c\.id, \{ name: name\.trim\(\) \|\| null \}\)/);
  assert.match(view, /COMPUTER_COLOURS\.map/);
});

test('another computer\'s tab shows its own page here in a frame, and stays a link to it (issue #241)', () => {
  const view = readFileSync(new URL('../web/src/components/ComputerTabs.tsx', import.meta.url), 'utf8');
  // Still a link to that computer's own page, so a middle click opens it in a tab of its own.
  assert.match(view, /<a key=\{c\.id\} className=\{`ctab\$\{on \? ' on' : ''\}`\} style=\{computerStyle\(c\)\} href=\{c\.url\} target="_blank" rel="noopener noreferrer"/);
  assert.equal(view.match(/target=/g)?.length, 1, 'only the other computers\' links open a new tab');
  // Nothing of this page goes into the frame, and it may use only its own passkey. The one exchange is the fixed
  // "paired?" question to the frame's own window at its computer's address, and the framed page's "paired" to the page
  // that frames it (#286, Martin on Ledung question #245, 2026-10-21 10:55: "a — Ask the frame"); nothing else, on
  // either side (review 293, Important 1).
  assert.doesNotMatch(view, /window\.open/);
  assert.equal(view.match(/contentWindow/g)?.length, 2, 'the frame\'s window: only to tell its answer apart and to ask it');
  assert.match(view, /e\.source === frames\.current\[c\.id\]\?\.contentWindow/);
  assert.match(view, /contentWindow\?\.postMessage\(frameAsk\(\), new URL\(c\.url!\)\.origin\)/);
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /frameAnswer\(e\.data, e\.source === window\.parent\)/, 'answers only the page that frames it');
  assert.match(app, /window\.parent\.postMessage\(answer, e\.origin\)/, 'and only to the origin that asked');
  // Every message anywhere in the page: these two.
  const sources = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
    f.isDirectory() ? sources(new URL(`${f.name}/`, dir)) : /\.tsx?$/.test(f.name) ? [readFileSync(new URL(f.name, dir), 'utf8')] : []);
  assert.equal(sources(new URL('../web/src/', import.meta.url)).join('\n').match(/postMessage/g)?.length, 2, 'the question and the answer only');
  assert.match(view, /<iframe [^>]*src=\{c\.url!\}/);
  assert.match(view, /allow="publickey-credentials-get; publickey-credentials-create"/);
  assert.match(view, /className="ctab on"[^>]*aria-current="page"/);
  assert.doesNotMatch(view.match(/<span key=\{c\.id\} className="ctab on"[^\n]*/)![0], /target=|href=/, 'this computer stays as it is');
});

test('tabs are told apart by id, never by name: a rename can make two names the same (review-242)', () => {
  // A name changed in the page may equal another computer's, or swap with it; a tab keyed by name then left a
  // ghost tab until a reload. Ids are the public names (unique in the config) and '' for this computer without one.
  const named = computerList([PC, NAS, MAC], MAC.publicName, 'h');
  const same = withEdits(named, { [PC.publicName]: { name: 'NAS' } });
  assert.deepEqual(same.map((c) => c.name), ['Mac', 'NAS', 'NAS']);
  assert.equal(new Set(same.map((c) => c.id)).size, same.length);
  const swapped = withEdits(named, { [PC.publicName]: { name: 'NAS' }, [NAS.publicName]: { name: 'PC' } });
  assert.deepEqual(swapped.map((c) => [c.id, c.name]), [[MAC.publicName, 'Mac'], [PC.publicName, 'NAS'], [NAS.publicName, 'PC']]);
  const unlisted = withEdits(computerList([PC, NAS], undefined, 'PC'), { '': { name: 'NAS' } });
  assert.equal(new Set(unlisted.map((c) => c.id)).size, unlisted.length, "this computer's '' is no public name");
  for (const file of ['ComputerTabs.tsx', 'ComputersSettings.tsx']) {
    const view = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8');
    const keys = [...view.matchAll(/key=\{([^}]+)\}/g)].map((m) => m[1]).filter((k) => k !== 'k');
    assert.ok(keys.length > 0 && keys.every((k) => k === 'c.id'), `${file}: ${keys.join(', ')}`);
  }
});

test('a plain left click shows the computer here; any other click follows the link', () => {
  const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(showsHere(click), true);
  for (const other of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    assert.equal(showsHere({ ...click, ...other }), false, JSON.stringify(other));
  }
});

test('a page in a frame on another computer\'s page draws no tabs and no remote frame: that page draws them', () => {
  const two = computerList([PC, MAC], PC.publicName, 'h');
  assert.deepEqual(computerFrame(two, true, true), { tabs: null, remote: false, here: two[0] });
  const top = {};
  assert.equal(inFrame({ self: top, top }), false);
  assert.equal(inFrame({ self: {}, top }), true);
});

test('the label shortens to "Remote" on a narrow screen, and the remote frame is a smooth line, not the lockdown\'s', () => {
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@container \(max-width: 400px\) \{ \.remote-tag \.long \{ display: none; \}/);
  assert.match(css, /\.page\.remote \{ border: 3px solid var\(--cc\); \}/);
});

test("this computer's tab counts what waits for you here while another computer's page shows (#291)", () => {
  const [mac, pc] = computerList([PC, MAC], MAC.publicName, 'h') as [ComputerInfo, ComputerInfo];
  assert.equal(mac.here, true);
  const linked = { ...pc, waiting: 2 };
  // Another computer's page shows: this tab carries the Waiting for you count, hidden at 0.
  assert.equal(tabWaiting(mac, pc.id, 3), 3);
  assert.equal(tabWaiting(mac, pc.id, 0), 0);
  // This computer's own page shows: the sidebar already counts it, so the tab stays quiet.
  assert.equal(tabWaiting(mac, null, 3), 0);
  // Another computer's tab keeps what that computer told over the link (#273), whatever shows, and never this count.
  assert.equal(tabWaiting(linked, null, 3), 2);
  assert.equal(tabWaiting(linked, pc.id, 3), 2);
  assert.equal(tabWaiting(pc, pc.id, 3), 0, 'not known or offline: no badge');
  // The page hands the tabs the same count Waiting for you shows, and the tab draws its badge from tabWaiting.
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<ComputerTabs [^>]*waiting=\{waiting\}/);
  assert.match(app, /const waiting = waitingCount\(/);
  const view = readFileSync(new URL('../web/src/components/ComputerTabs.tsx', import.meta.url), 'utf8');
  assert.match(view, /const count = tabWaiting\(c, shown, hereWaiting\);/);
});
