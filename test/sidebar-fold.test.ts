// Folding sessions and projects in the sidebar (issue #149): which rows stay, which get a caret, what is added up on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLDED_KEY, FOLDED_SESSIONS_KEY, foldRows, readFolded, readFoldedSessions, toggleFolded, writeFolded, writeFoldedSessions, type FoldRow, type FoldStore } from '../web/src/sidebarFold.ts';

function memoryStore(): FoldStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

const row = (id: string, depth: number, drag: string | null, status: FoldRow['s']['status'] = 'idle', paused = false): FoldRow =>
  ({ s: { id, status, paused }, depth, drag });

// A project as the sidebar builds it: the manager with three sessions it runs, a session of your own with one,
// and a session of your own with none.
const rows: FoldRow[] = [
  row('mgr', 0, null),
  row('w1', 1, 'c:mgr', 'running'),
  row('w2', 1, 'c:mgr', 'waiting'),
  row('w3', 1, 'c:mgr', 'running', true),
  row('own', 0, 't:alpha'),
  row('own-sub', 1, 'c:own', 'idle'),
  row('lone', 0, 't:alpha', 'running'),
];
const ids = (v: { rows: FoldRow[] }) => v.rows.map((r) => r.s.id);
const none = { foldedSessions: [], folded: false, openId: null, pending: {} };

test('with nothing folded every row stays as it was, with nothing added up', () => {
  const v = foldRows(rows, none);
  assert.deepEqual(ids(v), ['mgr', 'w1', 'w2', 'w3', 'own', 'own-sub', 'lone']);
  assert.deepEqual(v.rows.map((r) => r.drag), rows.map((r) => r.drag));
  assert.ok(v.rows.every((r) => r.hidden === null && !r.folded));
  assert.equal(v.project, null);
});

test('only a row with sessions under it gets a caret: the manager and a session that runs one, not a lone session or a sub-session', () => {
  const v = foldRows(rows, none);
  assert.deepEqual(v.rows.filter((r) => r.folds).map((r) => r.s.id), ['mgr', 'own']);
});

test('folding the manager hides only its sessions; the other session keeps its own', () => {
  const v = foldRows(rows, { ...none, foldedSessions: ['mgr'] });
  assert.deepEqual(ids(v), ['mgr', 'own', 'own-sub', 'lone']);
  assert.equal(v.rows[0]!.folded, true);
  assert.equal(v.rows[0]!.hidden?.count, 3);
  assert.equal(v.rows[1]!.folded, false);
  assert.equal(v.rows[1]!.hidden, null);
  // Top-level sessions keep their drag group, so they can still be reordered.
  assert.equal(v.rows[1]!.drag, 't:alpha');
});

test('folding one session and leaving the manager open shows the manager\'s sessions', () => {
  const v = foldRows(rows, { ...none, foldedSessions: ['own'] });
  assert.deepEqual(ids(v), ['mgr', 'w1', 'w2', 'w3', 'own', 'lone']);
  assert.equal(v.rows[4]!.hidden?.count, 1);
});

test("a hidden session's pending questions and permissions go to the row it is folded under", () => {
  const v = foldRows(rows, { ...none, foldedSessions: ['mgr', 'own'], pending: { w2: 2, w3: 1, mgr: 1, 'own-sub': 4 } });
  // The manager's own 1 stays its own (the page adds it); only the hidden ones are rolled up.
  assert.equal(v.rows[0]!.hidden?.pending, 3);
  assert.equal(v.rows[1]!.hidden?.pending, 4);
});

test('a folded session says whether any of its hidden sessions works; a paused one does not count as working', () => {
  const v = foldRows(rows, { ...none, foldedSessions: ['mgr', 'own'] });
  assert.equal(v.rows[0]!.hidden?.working, true);
  assert.equal(v.rows[1]!.hidden?.working, false);
  const paused = foldRows([row('mgr', 0, null), row('w3', 1, 'c:mgr', 'running', true)], { ...none, foldedSessions: ['mgr'] });
  assert.equal(paused.rows[0]!.hidden?.working, false);
});

test('a folded project draws no rows and adds up all of them on the project row', () => {
  const v = foldRows(rows, { ...none, folded: true, pending: { mgr: 1, w2: 2 } });
  assert.deepEqual(ids(v), []);
  assert.deepEqual(v.project, { count: 7, pending: 3, working: true });
});

test('a folded project counts every session, whether its sessions are folded or not', () => {
  assert.deepEqual(foldRows(rows, { ...none, folded: true, foldedSessions: ['mgr'] }).project, { count: 7, pending: 0, working: true });
});

test('the open session stays under a folded parent, cannot be dragged, and its parent counts the rest', () => {
  const v = foldRows(rows, { ...none, foldedSessions: ['mgr'], openId: 'w2', pending: { w2: 2, w1: 1 } });
  assert.deepEqual(ids(v).slice(0, 2), ['mgr', 'w2']);
  assert.equal(v.rows[1]!.drag, null);
  // Its own questions show on its own row, so the parent adds up only the two still hidden.
  assert.deepEqual(v.rows[0]!.hidden, { count: 2, pending: 1, working: true });
});

test('the open session stays in a folded project, and the project row counts the rest', () => {
  const v = foldRows(rows, { ...none, folded: true, openId: 'own' });
  assert.deepEqual(ids(v), ['own']);
  assert.equal(v.rows[0]!.drag, null);
  assert.equal(v.project?.count, 6);
});

test('a folded project with only the open session in it still reads as folded', () => {
  assert.deepEqual(foldRows([row('mgr', 0, null)], { ...none, folded: true, openId: 'mgr' }).project, { count: 0, pending: 0, working: false });
});

test('folded projects and folded sessions are kept in the browser apart; anything unreadable means none folded', () => {
  const store = memoryStore();
  assert.deepEqual(readFolded(store), []);
  assert.deepEqual(readFoldedSessions(store), []);
  writeFolded(store, toggleFolded(toggleFolded([], 'alpha'), 'beta'));
  writeFoldedSessions(store, toggleFolded([], 'mgr'));
  assert.deepEqual(readFolded(store), ['alpha', 'beta']);
  assert.deepEqual(readFoldedSessions(store), ['mgr']);
  writeFolded(store, toggleFolded(readFolded(store), 'alpha'));
  assert.deepEqual(readFolded(store), ['beta']);
  writeFolded(store, []);
  assert.equal(store.data.has(FOLDED_KEY), false);
  assert.equal(store.data.has(FOLDED_SESSIONS_KEY), true);
  store.data.set(FOLDED_KEY, '{not json');
  assert.deepEqual(readFolded(store), []);
  store.data.set(FOLDED_SESSIONS_KEY, '["a", 3, null]');
  assert.deepEqual(readFoldedSessions(store), ['a']);
});

test('a fold drops names that no longer exist, so the stored list does not grow forever', () => {
  assert.deepEqual(toggleFolded(['gone', 'kept'], 'new', (n) => n !== 'gone'), ['kept', 'new']);
  assert.deepEqual(toggleFolded(['gone', 'kept'], 'kept', (n) => n !== 'gone'), []);
});

test('a store that throws (private mode) reads as nothing folded and writes nothing', () => {
  const broken: FoldStore = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  assert.deepEqual(readFolded(broken), []);
  assert.deepEqual(readFoldedSessions(broken), []);
  writeFolded(broken, ['a']);
  writeFoldedSessions(broken, ['a']);
});
