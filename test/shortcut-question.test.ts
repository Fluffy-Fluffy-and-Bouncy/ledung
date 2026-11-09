// The first-run question about a Ledung icon (issue #415; Martin, 2026-10-29 13:58, Ledung question #939): asked
// once on this computer's own page, in the words Martin gave, and not again once answered or once an icon is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShortcutsView } from '../src/shared/protocol.ts';
import { asksFirstRun, placesText, questionText, settingsText, stopRefusal } from '../web/src/shortcuts.ts';

// Start at sign-in and the log (issue #456) don't change when the question is asked.
const extra = { signIn: { available: true, reason: null, label: 'Start Ledung when I sign in to Windows', on: false, file: null }, log: { file: 'ledung.log', active: false } };

const windows: ShortcutsView = {
  kind: 'windows', available: true, reason: null, asked: false, ...extra,
  places: [
    { id: 'desktop', label: 'Desktop', file: 'C:\\Users\\u\\Desktop\\Ledung.lnk', present: false },
    { id: 'start-menu', label: 'Start menu', file: 'C:\\Users\\u\\Programs\\Ledung.lnk', present: false },
  ],
};
const mac: ShortcutsView = { kind: 'mac', available: true, reason: null, asked: false, ...extra, places: [{ id: 'applications', label: 'Applications', file: '/Applications/Ledung.app', present: false }] };

test('the question names the places: Desktop and Start menu on Windows, Applications on macOS', () => {
  assert.equal(questionText(windows), 'Add a Ledung icon to your Desktop and Start menu?');
  assert.equal(questionText(mac), 'Add a Ledung icon to Applications?');
  assert.equal(placesText(mac), 'Applications');
  assert.equal(settingsText(windows), 'A Ledung icon on your Desktop and in the Start menu.');
  assert.equal(settingsText(mac), 'A Ledung icon in Applications.');
});

test('asked on a first run, on this computer\'s own page', () => {
  assert.equal(asksFirstRun(windows, false), true);
  assert.equal(asksFirstRun(mac, false), true);
  assert.equal(asksFirstRun(windows, true), false, "a framed page is another computer's");
  assert.equal(asksFirstRun(null, false), false, 'Ledung refused the view: a phone or another computer');
});

test('never again once answered, Yes or No, or once an icon is there', () => {
  assert.equal(asksFirstRun({ ...windows, asked: true }, false), false);
  assert.equal(asksFirstRun({ ...windows, places: [{ ...windows.places[0]!, present: true }, windows.places[1]!] }, false), false);
});

test('not asked where Ledung makes no shortcuts', () => {
  assert.equal(asksFirstRun({ kind: 'other', available: false, reason: 'Shortcuts are made on Windows and macOS.', asked: false, places: [], ...extra }, false), false);
});

// Stop Ledung (#456) works only on this computer's own page; elsewhere Settings says where instead of showing nothing,
// which its search still led to (2026-11-09).
test("Stop Ledung: this computer's own page may; any other page is told where it works", () => {
  assert.equal(stopRefusal(false, { protocol: 'http:', hostname: '127.0.0.1', port: '41579' }), null);
  assert.equal(stopRefusal(false, { protocol: 'http:', hostname: 'localhost', port: '41579' }), null);
  assert.equal(stopRefusal(false, { protocol: 'http:', hostname: '172.20.4.143', port: '41579' }),
    'Stop Ledung only works on the page at http://127.0.0.1:41579 on the computer Ledung runs on.');
  assert.equal(stopRefusal(false, { protocol: 'https:', hostname: 'ledung.example.org', port: '' }),
    'Stop Ledung only works on the page at http://127.0.0.1 on the computer Ledung runs on.', 'through the public name the port is not known');
  assert.match(stopRefusal(true, { protocol: 'http:', hostname: '127.0.0.1', port: '41579' })!, /^This is another computer's page/);
});
