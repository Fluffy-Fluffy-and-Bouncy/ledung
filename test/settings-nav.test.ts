import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLeaves, isSettingsView, leaveSettings, stepsInto, type SettingsSteps } from '../web/src/settingsNav.ts';

// A browser history in miniature: each entry the page opens records its steps the way App's open() does.
function browse(first: string | null, firstSteps: SettingsSteps = { depth: 0, root: false }) {
  const entries: { id: string | null; steps: SettingsSteps }[] = [{ id: first, steps: firstSteps }];
  let at = 0;
  const current = () => entries[at]!;
  return {
    open(id: string | null) {
      const steps = stepsInto(current().id, current().steps, id);
      entries.splice(at + 1, Infinity, { id, steps });
      at++;
    },
    back() { at--; },
    /** Escape or the ⚙ again; returns the screen it lands on. */
    leave(): string | null {
      const to = leaveSettings(current().steps);
      if ('back' in to) at -= to.back;
      else this.open(null);
      return current().id;
    },
  };
}

test('Escape or ⚙ from Settings goes back to the screen it was opened from (issue #78, Done 1 and 2)', () => {
  for (const from of ['session-1', 'overview', 'usage', 'waiting', 'q:4', 'ps:demo', null]) {
    const b = browse(from);
    b.open('settings');
    assert.equal(b.leave(), from, `from ${from}`);
  }
});

test('from Accounts or Add project opened through Settings it goes back past Settings (Done 3)', () => {
  for (const page of ['accounts', 'add']) {
    const b = browse('session-1');
    b.open('overview');
    b.open('settings');
    b.open(page);
    assert.equal(b.leave(), 'overview', `from ${page}`);
  }
});

test('after Back from Accounts to Settings, leaving still goes to the screen before Settings', () => {
  const b = browse('usage');
  b.open('settings');
  b.open('accounts');
  b.back();
  assert.equal(b.leave(), 'usage');
});

test('Settings opened directly by address leaves to the start page (Done 5)', () => {
  // The first entry is marked as a root entry when it shows Settings, as App does on load.
  for (const first of ['settings', 'accounts', 'add']) {
    const b = browse(first, { depth: 1, root: true });
    assert.equal(b.leave(), null, `direct ${first}`);
  }
  const b = browse('settings', { depth: 1, root: true });
  b.open('add');
  assert.equal(b.leave(), null);
});

test('leaving Settings for another screen and coming back starts a fresh count', () => {
  const b = browse('overview');
  b.open('settings');
  b.open('session-2');
  b.open('settings');
  assert.equal(b.leave(), 'session-2');
});

test('only Settings, Accounts and Add project count as Settings', () => {
  assert.deepEqual(['settings', 'accounts', 'add', 'overview', 'ps:demo', null].map(isSettingsView), [true, true, true, false, false, false]);
});

test('Escape leaves unless a field already used it or a composition is under way (Done 4)', () => {
  assert.equal(escapeLeaves({ key: 'Escape', defaultPrevented: false, isComposing: false }), true);
  assert.equal(escapeLeaves({ key: 'Escape', defaultPrevented: true, isComposing: false }), false);
  assert.equal(escapeLeaves({ key: 'Escape', defaultPrevented: false, isComposing: true }), false);
  assert.equal(escapeLeaves({ key: 'Enter', defaultPrevented: false, isComposing: false }), false);
});
