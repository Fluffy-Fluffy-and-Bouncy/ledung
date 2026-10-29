// Archive (docs/steps/idle-stop-and-archive.md): only ended sessions, never a manager; nothing deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const events: string[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon' }), store, (e) => {
    if (e.type === 'message' && e.message.kind === 'event') events.push((e.message.data as { text: string }).text);
  }));
  const mk = (id: string, role: 'session' | 'manager', status: 'ended' | 'idle', parentId: string | null = null) => {
    store.createSession({ id, project: 'p', runner: 'local', title: `t-${id}`, parentId, permissionMode: 'default', role });
    store.updateSession(id, { status });
  };
  mk('mgr', 'manager', 'ended');
  mk('done', 'session', 'ended', 'mgr');
  mk('solo', 'session', 'ended');
  mk('busy', 'session', 'idle');
  return { store, manager, events };
}

test('Simon archives any ended session, also one started outside a manager; nothing is deleted', () => {
  const { store, manager, events } = setup();
  store.addMessage('solo', 'user', { text: 'hello' });
  assert.ok(manager.archive('solo').archivedAt);
  assert.ok(manager.archive('done').archivedAt);
  assert.deepEqual(events, ['Archived by Simon.', 'Archived by Simon.']);
  assert.equal(store.listMessages('solo').filter((m) => m.kind === 'user').length, 1, 'history stays');
  assert.ok(store.getSession('solo'), 'the session stays');
});

test("a running session or a project's manager can't be archived", () => {
  const { manager } = setup();
  assert.throws(() => manager.archive('busy'), /Only an ended session/);
  assert.throws(() => manager.archive('mgr'), /manager can't be archived/);
});

test('unarchive puts it back, still ended', () => {
  const { store, manager } = setup();
  manager.archive('solo');
  const back = manager.unarchive('solo');
  assert.equal(back.archivedAt, null);
  assert.equal(store.getSession('solo')!.status, 'ended');
});
