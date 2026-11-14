// A sidebar badge opens Waiting for you on its project for that visit only (issue #322).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHATS, type PermissionInfo, type QuestionInfo } from '../src/shared/protocol.ts';
import { badgeTitle, focusFilter, showAll, withManager } from '../web/src/waitingFocus.ts';
import { readFilter, waitingLists, writeFilter } from '../web/src/waitingLists.ts';

const q = (id: number, sessionId: string, addressedTo: string, status = 'open') =>
  ({ id, sessionId, askedAt: id, question: `Q${id}`, options: null, addressedTo, status, answer: null, answeredAt: null, answeredBy: null,
    aboutQuestion: null, forwardedFrom: null, aboutRequest: null, shots: null, deliveredAt: null, details: { tier: 'Process' } }) as unknown as QuestionInfo;
const perm = (id: number, sessionId: string, addressedTo: string, status = 'pending') => ({ id, sessionId, addressedTo, status, at: id }) as unknown as PermissionInfo;

test("a badge's project is shown alone, the hidden list kept; with no badge the kept filter is used as it is", () => {
  const saved = { mode: 'all' as const, one: 'Other', hidden: ['Quiet'] };
  assert.deepEqual(focusFilter(saved, { project: 'Ledung', sessions: ['m'], from: 'Manager' }), { mode: 'one', one: 'Ledung', hidden: ['Quiet'] });
  assert.equal(focusFilter(saved, null), saved);
  // Show all: every project the All filter shows.
  assert.deepEqual(showAll({ mode: 'one', one: 'Ledung', hidden: ['Quiet'] }), { mode: 'all', one: 'Ledung', hidden: ['Quiet'] });
});

test('opening from a badge leaves the filter kept in the browser alone (Done looks like 9)', () => {
  const store = new Map<string, string>();
  const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  writeFilter(s, { mode: 'all', one: '', hidden: [] });
  focusFilter(readFilter(s), { project: 'Ledung', sessions: [], from: 'Ledung' });
  assert.deepEqual(readFilter(s), { mode: 'all', one: '', hidden: [] });
});

test("the badge's count matches what the view shows for its project, and what is with a manager is counted apart (Done looks like 7)", () => {
  const projectOf = (id: string) => (id === 'chat' ? CHATS : id === 'x' ? 'Other' : 'Ledung');
  const questions = [q(1, 'mgr', 'user'), q(2, 'mgr', 'user'), q(3, 'worker', 'mgr'), q(4, 'x', 'user'), q(5, 'mgr', 'user', 'answered'), q(6, 'chat', 'user')];
  const permissions = [perm(1, 'mgr', 'user'), perm(2, 'worker', 'mgr'), perm(3, 'mgr', 'user', 'answered')];
  const filter = focusFilter({ mode: 'all', one: '', hidden: [] }, { project: 'Ledung', sessions: ['mgr'], from: 'Manager' });
  const shown = (p: string) => p === filter.one;
  const { forYou } = waitingLists(questions, projectOf, () => ['Process'], shown, ['Process']);
  const perms = permissions.filter((p) => p.status === 'pending' && p.addressedTo === 'user' && shown(projectOf(p.sessionId)));
  // The manager's badge counts its 2 open questions and 1 pending prompt: 3, and the view shows those 3.
  assert.deepEqual(forYou.map((i) => i.q.id), [1, 2]);
  assert.equal(forYou.length + perms.length, 3);
  // A worker's badge counts its question and prompt to its manager: Waiting for you says where they are.
  assert.equal(withManager({ project: 'Ledung', sessions: ['worker'], from: 'Worker' }, questions, permissions), 2);
  assert.equal(withManager({ project: 'Ledung', sessions: ['mgr'], from: 'Manager' }, questions, permissions), 0);
  // A folded project's badge is about the whole project: nothing to count apart.
  assert.equal(withManager({ project: 'Ledung', sessions: [], from: 'Ledung' }, questions, permissions), 0);
  // Chats are filtered like a project (Done looks like 8).
  const chats = waitingLists(questions, projectOf, () => [], (p) => p === CHATS, []).forYou;
  assert.deepEqual(chats.map((i) => i.q.id), [6]);
});

test("the badge's tooltip names the count and the project", () => {
  assert.equal(badgeTitle(3, 'Ledung'), '3 waiting in Ledung — open Waiting for you for it');
  assert.match(badgeTitle(1, CHATS), /^1 waiting in Chats/);
});
