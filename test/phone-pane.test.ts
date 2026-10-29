import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backToList, deskFallback, phoneClass } from '../web/src/phonePane.ts';

// Issue #171: on a phone the list is the home screen, anything opened from it a pane with a ← back to the list.

test('nothing open is the list; anything open is a pane', () => {
  assert.equal(phoneClass(null), 'phone-list');
  for (const id of ['waiting', 'q:3', 'settings', 'overview', 'abc123', 'p:Demo']) assert.equal(phoneClass(id), 'phone-pane');
});

test('← goes one step back when the pane was opened from the list, so the list is not stacked twice', () => {
  assert.deepEqual(backToList({ ledungFromList: true }), { back: 1 });
});

test('← opens the list when there is none behind the pane (a link, a bookmark, Go to conversation)', () => {
  assert.deepEqual(backToList(null), { open: null });
  assert.deepEqual(backToList({}), { open: null });
  assert.deepEqual(backToList({ ledungFromList: false }), { open: null });
});

test('closing Waiting for you with nothing before it: the list on a phone, the Overview as before when wider', () => {
  assert.equal(deskFallback(true), null);
  assert.equal(deskFallback(false), 'overview');
});
