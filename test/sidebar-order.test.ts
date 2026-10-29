// Dragging projects and sessions into order in the sidebar (issue #88): the order is kept in Ledung's database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { dropSlot, moved, siblingOrder, staysPut, type Placed } from '../web/src/sidebarOrder.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const config = parseConfig({
  userName: 'Simon',
  projects: ['alpha', 'beta', 'gamma'].map((name) => ({ name, runner: 'local', path: `C:/p/${name}` })),
});

/** A Ledung on a database file, so a test can close it and open it again as a restart does. */
function open(file: string) {
  const db = openDatabase(file);
  const store = new Store(db);
  const published: string[] = [];
  const manager = refuseRealSignInStores(new SessionManager(config, store, (e) => { if (e.type === 'session') published.push(e.session.id); else published.push(e.type); }));
  return { db, store, manager, published, projects: new ProjectStore(db) };
}

function tempFile(): { file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-order-'));
  return { file: path.join(dir, 'ledung.db'), done: () => removeTemp(dir) };
}

test('projects keep the order they were dragged into, after a restart too', () => {
  const tmp = tempFile();
  try {
    const first = open(tmp.file);
    assert.deepEqual(first.manager.projects().map((p) => p.name), ['alpha', 'beta', 'gamma'], 'as added before any drag');
    const after = first.manager.setProjectOrder(['gamma', 'alpha', 'beta']);
    assert.deepEqual(after.map((p) => p.name), ['gamma', 'alpha', 'beta']);
    assert.ok(first.published.includes('projects'), 'every open page hears of it');
    first.db.close();

    const again = open(tmp.file);
    assert.deepEqual(again.manager.projects().map((p) => p.name), ['gamma', 'alpha', 'beta']);
    // A project added later comes last; one left out of an order keeps its place after the named ones.
    again.projects.add({ name: 'delta', runner: 'local', path: 'C:/p/delta', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
    assert.deepEqual(again.manager.projects().map((p) => p.name), ['gamma', 'alpha', 'beta', 'delta']);
    again.manager.setProjectOrder(['delta', 'beta']);
    assert.deepEqual(again.manager.projects().map((p) => p.name), ['delta', 'beta', 'gamma', 'alpha']);
    again.db.close();
  } finally {
    tmp.done();
  }
});

test("a database that already ran migration 23 (the message board) gets the order columns from 24", () => {
  const tmp = tempFile();
  try {
    // A database as main left it before this change: everything up to 23, no position columns.
    const before = openDatabase(tmp.file);
    before.exec('ALTER TABLE projects DROP COLUMN position; ALTER TABLE sessions DROP COLUMN position; ALTER TABLE sessions DROP COLUMN work_dir; ALTER TABLE sessions DROP COLUMN status_since; ALTER TABLE devices DROP COLUMN kind; ALTER TABLE devices DROP COLUMN partitioned; ALTER TABLE devices DROP COLUMN logged_on_at; ALTER TABLE devices DROP COLUMN cookie_at; ALTER TABLE devices DROP COLUMN old_cookie_hash; ALTER TABLE devices DROP COLUMN old_cookie_until; ALTER TABLE devices DROP COLUMN paired_via; ALTER TABLE sessions DROP COLUMN claude_program; ALTER TABLE accounts DROP COLUMN container_dir; ALTER TABLE accounts DROP COLUMN containers; ALTER TABLE sessions DROP COLUMN trimmed_at; ALTER TABLE limits DROP COLUMN seen_at; ALTER TABLE questions DROP COLUMN earlier; ALTER TABLE questions DROP COLUMN sources; PRAGMA user_version = 23;');
    // And without 26's added columns (its rebuilt tables take either shape).
    before.exec('ALTER TABLE board_projects DROP COLUMN repo; ALTER TABLE board_projects DROP COLUMN allow; ALTER TABLE board_outbox DROP COLUMN board; DROP TABLE board_boards; ALTER TABLE board_outbox DROP COLUMN attachments; DROP TABLE board_attachments;');
    // And without 30's (issue #263).
    before.exec('ALTER TABLE questions DROP COLUMN answered_here; DROP TABLE words_used;');
    // And without 38's daily usage totals (issue #362).
    before.exec('DROP TRIGGER usage_daily_insert; DROP TRIGGER usage_daily_update; DROP TRIGGER usage_daily_delete; DROP TABLE usage_daily; DROP INDEX usage_by_branch; DROP INDEX usage_by_session; CREATE INDEX usage_by_session ON usage(session_id, at);');
    before.close();
    const after = open(tmp.file);
    assert.equal((after.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 40);
    const columns = (table: string) => (after.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns('projects').includes('position'));
    assert.ok(columns('sessions').includes('position'));
    assert.ok(after.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'board_threads'").get(), "23's tables are untouched");
    after.manager.setProjectOrder(['beta']);
    assert.deepEqual(after.manager.projects().map((p) => p.name), ['beta', 'alpha', 'gamma']);
    after.db.close();
  } finally {
    tmp.done();
  }
});

test('a project order naming an unknown project or one twice is refused, and nothing changes', () => {
  const { manager, db } = open(':memory:');
  assert.throws(() => manager.setProjectOrder(['alpha', 'nope']), /no project named "nope"/);
  assert.throws(() => manager.setProjectOrder(['alpha', 'alpha']), /twice/);
  assert.throws(() => manager.setProjectOrder('alpha'), /list of project names/);
  assert.deepEqual(manager.projects().map((p) => p.name), ['alpha', 'beta', 'gamma']);
  db.close();
});

test('sessions keep the order they were dragged into, after a restart too', () => {
  const tmp = tempFile();
  try {
    const first = open(tmp.file);
    for (const id of ['s1', 's2', 's3']) first.store.createSession({ id, project: 'alpha', runner: 'local', title: id, parentId: null, permissionMode: 'default' });
    assert.equal(first.store.getSession('s1')!.position, null, 'never dragged');
    first.manager.setSessionOrder(['s3', 's1', 's2']);
    assert.deepEqual(['s1', 's2', 's3'].map((id) => first.store.getSession(id)!.position), [1, 2, 0]);
    assert.deepEqual(first.published.filter((p) => p.startsWith('s')).sort(), ['s1', 's2', 's3'], 'every open page hears of each');
    first.db.close();

    const again = open(tmp.file);
    assert.deepEqual(['s1', 's2', 's3'].map((id) => again.store.getSession(id)!.position), [1, 2, 0]);
    assert.deepEqual(again.store.listSessions().sort(siblingOrder).map((s) => s.id), ['s3', 's1', 's2']);
    again.db.close();
  } finally {
    tmp.done();
  }
});

test("sessions are ordered only within their project, and a project's manager can't be moved", () => {
  const { manager, store, projects, db } = open(':memory:');
  store.createSession({ id: 'mgr', project: 'alpha', runner: 'local', title: 'm', parentId: null, permissionMode: 'default', role: 'manager' });
  projects.setManager('alpha', 'mgr');
  store.createSession({ id: 'a1', project: 'alpha', runner: 'local', title: 'a1', parentId: null, permissionMode: 'default' });
  store.createSession({ id: 'b1', project: 'beta', runner: 'local', title: 'b1', parentId: null, permissionMode: 'default' });
  assert.throws(() => manager.setSessionOrder(['a1', 'b1']), /within their own project/);
  assert.throws(() => manager.setSessionOrder(['a1', 'mgr']), /manager stays first/);
  assert.throws(() => manager.setSessionOrder(['a1', 'gone']), /No such session/);
  assert.throws(() => manager.setSessionOrder(['a1', 'a1']), /twice/);
  assert.throws(() => manager.setSessionOrder([]), /list of session ids/);
  for (const id of ['mgr', 'a1', 'b1']) assert.equal(store.getSession(id)!.position, null, 'nothing changed');
  db.close();
});

const s = (id: string, createdAt: number, status: string, position: number | null = null): Placed & { id: string } => ({ id, createdAt, status, position });

test('nothing dragged: running sessions newest first, then ended ones newest first, as before', () => {
  const list = [s('old', 1, 'idle'), s('ended-new', 4, 'ended'), s('new', 3, 'running'), s('ended-old', 2, 'ended')];
  assert.deepEqual(list.sort(siblingOrder).map((x) => x.id), ['new', 'old', 'ended-new', 'ended-old']);
});

test('dragged sessions keep their place when they end; a new one appears on top; an undragged ended one goes last', () => {
  const list = [
    s('b', 1, 'ended', 1), // dragged second, then ended: stays second among the dragged
    s('a', 2, 'idle', 0),
    s('c', 3, 'idle', 2),
    s('fresh', 9, 'starting'), // started after the drag
    s('quit', 8, 'ended'), // started after the drag and already ended
  ];
  assert.deepEqual(list.sort(siblingOrder).map((x) => x.id), ['fresh', 'a', 'b', 'c', 'quit']);
});

test('moving a row to a slot: before the row at that index in the old list, or last', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moved(ids, 'a', 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moved(ids, 'a', 4), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moved(ids, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moved(ids, 'c', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moved(ids, 'x', 1), ids, 'not a sibling: unchanged');
  // The slot just above or just below a row is where it already is.
  assert.equal(staysPut(ids, 'b', 1), true);
  assert.equal(staysPut(ids, 'b', 2), true);
  assert.equal(staysPut(ids, 'b', 0), false);
  assert.equal(staysPut(ids, 'b', 3), false);
});

test('the drop slot is before the first row whose middle is below the pointer', () => {
  const middles = [10, 30, 50];
  assert.equal(dropSlot(middles, 0), 0);
  assert.equal(dropSlot(middles, 15), 1);
  assert.equal(dropSlot(middles, 49), 2);
  assert.equal(dropSlot(middles, 80), 3);
});
