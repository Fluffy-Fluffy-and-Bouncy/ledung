// Resuming an ended session (issue #23): a session paused when it was stopped must not stay paused,
// or the message that resumed it waits until someone unpauses it by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumedState } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';

function ended(paused: boolean, archived = false) {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  // Paused by hand, then stopped: what the store holds when the message arrives.
  store.updateSession('s', { paused, status: 'ended', endedAt: 1, endReason: 'Stopped.', archivedAt: archived ? 2 : null });
  return store;
}

test('pause, stop, then a message: the resumed session is no longer paused, and says so', () => {
  const store = ended(true);
  const { update, events } = resumedState(store.getSession('s')!);
  store.updateSession('s', update);
  const after = store.getSession('s')!;
  assert.equal(after.paused, false, 'a paused session holds back every delivery');
  assert.equal(after.status, 'starting');
  assert.deepEqual(events, ['No longer paused: the session is resumed.']);
});

test('a session that was not paused resumes with no pause event; an archived one is unarchived', () => {
  const store = ended(false, true);
  const { update, events } = resumedState(store.getSession('s')!);
  store.updateSession('s', update);
  const after = store.getSession('s')!;
  assert.equal(after.paused, false);
  assert.equal(after.archivedAt, null);
  assert.equal(after.endReason, null);
  assert.deepEqual(events, ['Unarchived: the session is resumed.']);
});
