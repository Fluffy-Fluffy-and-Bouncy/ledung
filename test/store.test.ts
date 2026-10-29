import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';

function freshStore(): Store {
  return new Store(openDatabase(':memory:'));
}

test('a status that changes restarts its clock; the same status again keeps it (issue #265)', () => {
  const store = freshStore();
  const before = Date.now();
  const s = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'New session', parentId: null, permissionMode: 'default' });
  assert.equal(s.statusSince, s.createdAt, 'a new session has been starting since it was made');
  store.database.prepare('UPDATE sessions SET status_since = 5 WHERE id = ?').run('s1');
  store.updateSession('s1', { status: 'starting', title: 'x' });
  assert.equal(store.getSession('s1')!.statusSince, 5, 'same status: the clock goes on');
  store.updateSession('s1', { title: 'y' });
  assert.equal(store.getSession('s1')!.statusSince, 5, 'no status given: the clock goes on');
  store.updateSession('s1', { status: 'running' });
  assert.ok(store.getSession('s1')!.statusSince! >= before, 'a new status: the clock restarts');
  store.database.prepare('UPDATE sessions SET status_since = 5 WHERE id = ?').run('s1');
  store.markUnfinishedSessionsEnded('Ledung stopped');
  const ended = store.getSession('s1')!;
  assert.equal(ended.statusSince, ended.endedAt, 'ended by the sweep: since then');
});

test('the latest user message time, for the time line (issue #265)', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'New session', parentId: null, permissionMode: 'default' });
  assert.equal(store.lastUserMessageAt('s1'), null);
  const first = store.addMessage('s1', 'user', { text: 'hi' });
  store.addMessage('s1', 'event', { text: 'later, not a prompt' });
  assert.equal(store.lastUserMessageAt('s1'), first.at);
});

test('stores sessions and their messages in order, with paging', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'New session', parentId: null, permissionMode: 'default' });
  for (let i = 0; i < 5; i++) store.addMessage('s1', 'user', { text: `m${i}` });
  const last3 = store.listMessages('s1', { limit: 3 });
  assert.deepEqual(last3.map((m) => m.data.text), ['m2', 'm3', 'm4']);
  const before = store.listMessages('s1', { beforeId: last3[0]!.id, limit: 10 });
  assert.deepEqual(before.map((m) => m.data.text), ['m0', 'm1']);
});

test('pages forward from a message, oldest first, for a reconnect (issue #178)', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'New session', parentId: null, permissionMode: 'default' });
  store.createSession({ id: 's2', project: 'p', runner: 'local', title: 'Other', parentId: null, permissionMode: 'default' });
  const ids = [0, 1, 2, 3, 4].map((i) => store.addMessage('s1', 'user', { text: `m${i}` }).id);
  store.addMessage('s2', 'user', { text: 'elsewhere' });
  assert.deepEqual(store.listMessages('s1', { afterId: ids[1], limit: 2 }).map((m) => m.data.text), ['m2', 'm3']);
  assert.deepEqual(store.listMessages('s1', { afterId: ids[3] }).map((m) => m.data.text), ['m4']);
  assert.deepEqual(store.listMessages('s1', { afterId: ids[4] }), []);
});

test('updates only the given session fields', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'docker', title: 'New session', parentId: null, permissionMode: 'default' });
  store.updateSession('s1', { status: 'idle', claudeSessionId: 'abc' });
  const s = store.getSession('s1')!;
  assert.equal(s.status, 'idle');
  assert.equal(s.claudeSessionId, 'abc');
  assert.equal(s.title, 'New session');
});

test('a permission can be decided only once', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  store.createPermission({ id: 'p1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, title: null, reason: null });
  assert.equal(store.pendingPermissions().length, 1);
  assert.equal(store.decidePermission('p1', 'allowed', 'simon', null), true);
  assert.equal(store.decidePermission('p1', 'denied', 'simon', 'no'), false);
  assert.equal(store.getPermission('p1')!.status, 'allowed');
  assert.equal(store.pendingPermissions().length, 0);
});

test('after a crash, unfinished sessions are marked ended and their prompts cancelled', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  store.createSession({ id: 's2', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  store.updateSession('s2', { status: 'ended' });
  store.createPermission({ id: 'p1', sessionId: 's1', toolName: 'Bash', input: {}, title: null, reason: null });
  assert.equal(store.markUnfinishedSessionsEnded('crash'), 1);
  assert.equal(store.getSession('s1')!.status, 'ended');
  assert.equal(store.getSession('s1')!.endReason, 'crash');
  assert.equal(store.getPermission('p1')!.status, 'cancelled');
});

test('remembers each session\'s permission mode', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'auto' });
  assert.equal(store.getSession('s1')!.permissionMode, 'auto');
  store.updateSession('s1', { permissionMode: 'plan' });
  assert.equal(store.getSession('s1')!.permissionMode, 'plan');
});

test('questions: numbered, answered once, waiting until delivered', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const a = store.createQuestion({ sessionId: 's1', question: 'Tabs or spaces?', options: ['tabs', 'spaces'], addressedTo: 'user' });
  const b = store.createQuestion({ sessionId: 's1', question: 'Ship it?', options: null, addressedTo: 'user' });
  assert.equal(b.id, a.id + 1);
  assert.deepEqual(store.getQuestion(a.id)!.options, ['tabs', 'spaces']);
  assert.deepEqual(store.listQuestions().filter((q) => q.status === 'open').map((q) => q.id), [a.id, b.id]);

  assert.equal(store.answerQuestion(a.id, 'spaces', 'user'), true);
  assert.equal(store.answerQuestion(a.id, 'tabs', 'user'), false, 'an answered question cannot be answered again');
  assert.equal(store.getQuestion(a.id)!.answer, 'spaces');
  assert.equal(store.getQuestion(a.id)!.answeredBy, 'user');
  assert.deepEqual(store.undeliveredAnswers('s1').map((q) => q.id), [a.id]);
  store.markDelivered([a.id]);
  assert.deepEqual(store.undeliveredAnswers('s1'), []);
  assert.ok(store.getQuestion(a.id)!.deliveredAt);

  assert.equal(store.withdrawQuestion(b.id, 'No longer needed.'), true);
  assert.equal(store.answerQuestion(b.id, 'yes', 'user'), false, 'a withdrawn question cannot be answered');
  assert.equal(store.getQuestion(b.id)!.status, 'withdrawn');
});

test("keeps the model a session was started with, apart from the model Claude Code reports", () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', requestedModel: 'sonnet' });
  store.createSession({ id: 's2', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  store.updateSession('s1', { model: 'claude-sonnet-5-5' });
  assert.equal(store.getSession('s1')!.requestedModel, 'sonnet');
  assert.equal(store.getSession('s1')!.model, 'claude-sonnet-5-5');
  assert.equal(store.getSession('s2')!.requestedModel, null);
});

test('last reply: the short line after ask_user shows the question instead', () => {
  const store = freshStore();
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const say = (content: unknown[]) => store.addMessage('s1', 'sdk', { type: 'assistant', message: { content } });
  say([{ type: 'text', text: 'Looking into it.' }]);
  say([{ type: 'tool_use', id: 'a', name: 'mcp__ledung__ask_user', input: { question: 'Release now?' } }]);
  say([{ type: 'text', text: 'Waiting for your answer.' }]);
  assert.equal(store.lastReply('s1')!.text, 'Release now?');
  // After the answer, the next turn's short reply is a real reply.
  store.addMessage('s1', 'user', { text: 'yes' });
  say([{ type: 'text', text: 'Done.' }]);
  assert.equal(store.lastReply('s1')!.text, 'Done.');
});
