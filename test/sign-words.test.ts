// What the sign page says (#481, Martin's variant A, Ledung question #751): the intent, the rules and how long a
// log-on lasts, from the terms Ledung sends with the link. The figures are the decided ones: a computer stays logged on
// until it logs out or goes 14 days unused, through a restart (question 5 on #245); a phone unlocks for 30 minutes
// (Martin, 2026-10-17, PR #164); a sign link lives two minutes (#463). The button in Settings → Phones says "Log out".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALREADY_HAS_PASSKEY, ENROL_LINK_GONE, PASSKEY_WINDOW_PASSED } from '../src/server/passkeys.ts';

type Part = { text: string; bold?: boolean };
type Words = {
  title: string; lead: Part[]; request?: string; factsTitle: string; rules: Part[][]; button: string; fine: string;
  doneTitle: string; doneLead: Part[];
};
// A plain browser module with no types; imported by a computed path so the type check leaves it alone.
const modulePath = '../web/public/enrol-messages.js';
const { signWords, enrolLinkDead } = await import(modulePath) as {
  signWords(name: string, what: string, terms: unknown): Words;
  enrolLinkDead(message: unknown): boolean;
};

const text = (parts: Part[]) => parts.map((p) => p.text).join('');
const terms = (logOn: boolean, kind: string) => ({ logOn, kind, idleDays: 14, unlockMinutes: 30, linkMinutes: 2 });

test('a computer\'s log-on: the intent, 14 days unused, a restart doesn\'t log it out, log out in Settings → Phones, 2 minutes', () => {
  const w = signWords('Ledung app on the Mac', 'Log this device on', terms(true, 'computer'));
  assert.equal(w.title, 'Log this Mac on to Ledung');
  assert.equal(w.button, 'Log on with Touch ID');
  assert.deepEqual(w.lead[0], { text: 'Ledung app on the Mac', bold: true });
  const rules = w.rules.map(text).join('\n');
  assert.match(rules, /stays logged on until you log it out \(Settings → Phones\), remove it, or it goes 14 days unused\. A restart doesn't log it out\./);
  assert.match(rules, /sensitive prompt.*still ask for Touch ID each time/);
  assert.match(w.fine, /runs out in 2 minutes/);
  assert.equal(w.request, undefined, 'a log-on shows no request box');
  assert.equal(w.doneTitle, 'Logged on');
  assert.equal(text(w.doneLead), 'Ledung app on the Mac is logged on until you log it out, or 14 days without use.');
});

test('a phone\'s log-on is an unlock for 30 minutes, never "14 days"', () => {
  const w = signWords('Phone', 'Log this device on', terms(true, 'phone'));
  assert.equal(w.button, 'Unlock with Touch ID');
  const all = [w.title, text(w.lead), ...w.rules.map(text), w.fine, text(w.doneLead)].join('\n');
  assert.match(all, /stays unlocked for 30 minutes/);
  assert.doesNotMatch(all, /14 days/);
  assert.match([...signWords('Mac', 'Log this device on', terms(true, 'computer')).rules.map(text)].join('\n'), /14 days/, 'the probe finds it for a computer');
});

test('one change: the request as Ledung words it, signed once, and it does not log the app on', () => {
  const w = signWords('Ledung app on the Mac', 'POST /api/away', terms(false, 'computer'));
  assert.equal(w.title, 'Allow one change from the Ledung app');
  assert.equal(w.request, 'POST /api/away');
  assert.equal(w.button, 'Allow with Touch ID');
  const rules = w.rules.map(text).join('\n');
  assert.match(rules, /Signs this one request, once/);
  assert.match(rules, /It does not log the app on\./);
  assert.match(rules, /The link runs out in 2 minutes\./);
  assert.equal(w.doneTitle, 'Allowed');
});

// Test review of PR #486, finding 2: with only the decided figures, words written as fixed text would pass. Other
// figures must show as given, and one minute is singular.
test('the figures are the terms\' own: other terms give other words, and "1 minute" is singular', () => {
  const other = { idleDays: 7, unlockMinutes: 15, linkMinutes: 1 };
  const computer = signWords('Mac', 'Log this device on', { logOn: true, kind: 'computer', ...other });
  const computerText = [...computer.rules.map(text), computer.fine, text(computer.doneLead)].join('\n');
  assert.match(computerText, /goes 7 days unused/);
  assert.match(computerText, /or 7 days without use/);
  assert.match(computer.fine, /runs out in 1 minute\./);
  assert.doesNotMatch(computerText, /14 days|2 minutes|1 minutes/);
  const phone = signWords('Phone', 'Log this device on', { logOn: true, kind: 'phone', ...other });
  assert.match([...phone.rules.map(text), text(phone.doneLead)].join('\n'), /stays unlocked for 15 minutes/);
  assert.doesNotMatch([...phone.rules.map(text), phone.fine].join('\n'), /30 minutes/);
  const change = signWords('Mac', 'POST /api/away', { logOn: false, kind: 'computer', ...other });
  assert.match(change.rules.map(text).join('\n'), /The link runs out in 1 minute\./);
});

// Test review of PR #486, finding 3: the set-up page ends early only on Ledung's own words for a link that can set
// nothing up, read from the server's named refusals, so rewording one turns this red.
test('the set-up page ends early on each of Ledung\'s dead-link refusals, and not on a network error', () => {
  for (const refusal of [ENROL_LINK_GONE, ALREADY_HAS_PASSKEY, PASSKEY_WINDOW_PASSED]) assert.ok(enrolLinkDead(refusal), refusal);
  for (const passing of ['Ledung answered 502.', 'Failed to fetch', 'The passkey check was cancelled.', '', undefined]) {
    assert.equal(enrolLinkDead(passing), false, String(passing));
  }
});

test('a device\'s name is a text part, never markup', () => {
  const name = '<img src=x onerror=alert(1)>';
  for (const t of [terms(true, 'computer'), terms(true, 'phone'), terms(false, 'phone')]) {
    const w = signWords(name, 'POST /api/away', t);
    assert.ok([...w.lead, ...w.doneLead].some((p) => p.text === name && p.bold), 'the name is its own bold part');
  }
});
