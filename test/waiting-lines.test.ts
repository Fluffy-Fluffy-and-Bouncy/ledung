// "Waiting for you" lines in a manager's chat (issue #350): where they go, one per item, changed in place when decided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { openDatabase } from '../src/store/database.ts';
import { WaitingLines } from '../src/sessions/waiting-lines.ts';
import type { ServerEvent, StoredMessage } from '../src/shared/protocol.ts';
import { lineHead, lineOutcome, permissionLine, questionLine, type WaitingLine } from '../src/shared/waiting-line.ts';

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const sent: ServerEvent[] = [];
  const lines = new WaitingLines({ store, publish: (e) => sent.push(e), userName: () => 'Simon' });
  const publish = (e: ServerEvent) => lines.seen(e);
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'auto', role: 'manager' });
  store.createSession({ id: 'w1', project: 'p', runner: 'local', title: 'Build', parentId: 'mgr', permissionMode: 'auto' });
  store.createSession({ id: 'other', project: 'q', runner: 'local', title: 'Manager: q', parentId: null, permissionMode: 'auto', role: 'manager' });
  store.createSession({ id: 'stray', project: 'p', runner: 'local', title: 'Stray', parentId: 'other', permissionMode: 'auto' });
  const lineMessages = (id: string) => store.listMessages(id).filter((m) => m.kind === 'waiting');
  return { store, sent, publish, lineMessages };
}

const runTag = { run: 'run-1', block: 'review', runTitle: 'Cart', blockTitle: 'Review' };

test('a run person step Ledung asked gets one line in its coordinator chat, updated in place when accepted', () => {
  const t = setup();
  const q = t.store.createQuestion({ sessionId: 'mgr', question: 'q', options: null, addressedTo: 'user', details: { title: 'Review: Cart', review: { solving: 's', done: 'd' }, run: runTag } });
  t.publish({ type: 'question', question: q });
  t.publish({ type: 'question', question: q }); // sent again: no second line (Done looks like 8)
  const [m] = t.lineMessages('mgr');
  assert.equal(t.lineMessages('mgr').length, 1);
  const line = m!.data as WaitingLine;
  assert.equal(line.state, 'waiting');
  assert.equal(lineHead(line), `Review #${q.id} — Review: Cart`);
  t.store.answerQuestion(q.id, 'Accepted. Looks right.', 'user');
  t.publish({ type: 'question', question: t.store.getQuestion(q.id)! });
  const after = t.lineMessages('mgr');
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, m!.id, 'the same message, changed in place');
  assert.equal(lineOutcome(after[0]!.data), 'Accepted by Simon');
  const sent = t.sent.filter((e): e is { type: 'message'; message: StoredMessage } => e.type === 'message');
  assert.deepEqual(sent.map((e) => e.message.id), [m!.id, m!.id], 'sent when added and when changed, not when unchanged');
});

test("the coordinator's own write-up (ask_user) gets no line: its chat shows it already", () => {
  const t = setup();
  const q = t.store.createQuestion({ sessionId: 'mgr', question: 'q', options: null, addressedTo: 'user', details: { title: 'T', run: { ...runTag, writeUp: true } } });
  t.publish({ type: 'question', question: q });
  assert.equal(t.lineMessages('mgr').length, 0);
});

test("a worker's question to the person goes to its manager's chat; a manager's own question gets none", () => {
  const t = setup();
  const own = t.store.createQuestion({ sessionId: 'mgr', question: 'Mine?', options: null, addressedTo: 'user' });
  t.publish({ type: 'question', question: own });
  const q = t.store.createQuestion({ sessionId: 'w1', question: 'Which one?', options: ['Left', 'Right'], addressedTo: 'user' });
  t.publish({ type: 'question', question: q });
  const toManager = t.store.createQuestion({ sessionId: 'w1', question: 'For the manager', options: null, addressedTo: 'mgr' });
  t.publish({ type: 'question', question: toManager });
  assert.deepEqual(t.lineMessages('mgr').map((m) => (m.data as WaitingLine).ref), [String(q.id)]);
  assert.equal(t.lineMessages('w1').length, 0, "not in the asker's own chat");
  t.store.answerQuestion(q.id, 'Right', 'user');
  t.publish({ type: 'question', question: t.store.getQuestion(q.id)! });
  assert.equal(lineOutcome(t.lineMessages('mgr')[0]!.data), 'Answered by Simon: Right');
});

test('a question already decided when first seen gets no line, and one withdrawn says so', () => {
  const t = setup();
  const q = t.store.createQuestion({ sessionId: 'w1', question: 'Late?', options: null, addressedTo: 'user' });
  t.store.answerQuestion(q.id, 'yes', 'user');
  t.publish({ type: 'question', question: t.store.getQuestion(q.id)! });
  assert.equal(t.lineMessages('mgr').length, 0);
  const w = t.store.createQuestion({ sessionId: 'w1', question: 'Gone?', options: null, addressedTo: 'user' });
  t.publish({ type: 'question', question: w });
  t.store.withdrawQuestion(w.id, 'no longer needed');
  t.publish({ type: 'question', question: t.store.getQuestion(w.id)! });
  assert.equal(lineOutcome(t.lineMessages('mgr')[0]!.data), 'Withdrawn');
});

test("a worker's permission prompt for the person gets a line in its manager's chat, updated when denied", () => {
  const t = setup();
  const p = t.store.createPermission({ id: 'perm-1', sessionId: 'w1', toolName: 'Bash', input: { command: 'rm -rf build' }, title: null, reason: null });
  t.publish({ type: 'permission', permission: p });
  const [m] = t.lineMessages('mgr');
  assert.equal(lineHead(m!.data), 'Permission prompt — Bash: rm -rf build');
  t.store.decidePermission('perm-1', 'denied', 'user', 'no');
  t.publish({ type: 'permission', permission: t.store.getPermission('perm-1')! });
  assert.equal(lineOutcome(t.lineMessages('mgr')[0]!.data), 'Denied by Simon');
});

test('no line for a prompt addressed to a manager, nor across projects', () => {
  const t = setup();
  const p = t.store.createPermission({ id: 'perm-2', sessionId: 'w1', toolName: 'Bash', input: { command: 'ls' }, title: null, reason: null, addressedTo: 'mgr' });
  t.publish({ type: 'permission', permission: p });
  const s = t.store.createPermission({ id: 'perm-3', sessionId: 'stray', toolName: 'Bash', input: { command: 'ls' }, title: null, reason: null });
  t.publish({ type: 'permission', permission: s });
  const q = t.store.createQuestion({ sessionId: 'stray', question: 'x', options: null, addressedTo: 'user' });
  t.publish({ type: 'question', question: q });
  assert.equal(t.lineMessages('mgr').length + t.lineMessages('other').length, 0);
});

test('the line survives a new Ledung on the same database (Done looks like 7)', () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'M', parentId: null, permissionMode: 'auto', role: 'manager' });
  store.createSession({ id: 'w1', project: 'p', runner: 'local', title: 'W', parentId: 'mgr', permissionMode: 'auto' });
  const q = store.createQuestion({ sessionId: 'w1', question: 'x?', options: null, addressedTo: 'user' });
  new WaitingLines({ store, publish: () => {}, userName: () => 'Simon' }).seen({ type: 'question', question: q });
  const again = new Store(db);
  const second = new WaitingLines({ store: again, publish: () => {}, userName: () => 'Simon' });
  second.seen({ type: 'question', question: q });
  assert.equal(again.listMessages('mgr').filter((m) => m.kind === 'waiting').length, 1);
  assert.ok(again.waitingLineOf('question', String(q.id)));
});

test('a structured option is named by its label; a manager decision by its title', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'auto', role: 'manager' });
  const q = store.createQuestion({ sessionId: 'mgr', question: 'q', options: null, addressedTo: 'user', details: { title: 'Pick', options: [{ key: 'a', text: '**Merge** as one' }, { key: 'b', text: '**Split**' }] } });
  store.answerQuestion(q.id, 'b — Split', 'user');
  assert.equal(lineOutcome(questionLine(store.getQuestion(q.id)!, 'Simon', () => undefined)), 'Answered by Simon: Split');
  const p = store.createPermission({ id: 'x', sessionId: 'mgr', toolName: 'Edit', input: { file_path: 'a.ts' }, title: null, reason: null });
  store.decidePermission('x', 'allowed', 'mgr', null, 'once');
  assert.equal(lineOutcome(permissionLine(store.getPermission('x')!, 'Simon', (id) => store.getSession(id)?.title)), 'Allowed by Manager: p');
});
