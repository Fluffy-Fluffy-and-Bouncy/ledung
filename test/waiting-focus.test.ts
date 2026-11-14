// A sidebar badge opens Waiting for you on its project for that visit only (issue #322).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHATS, type PermissionInfo, type QuestionInfo } from '../src/shared/protocol.ts';
import { asideCount, badgeTitle, focusFilter, showAll, withManager } from '../web/src/waitingFocus.ts';
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
  // A worker's badge counts its question and prompt to its manager: Waiting for you says whose they are and where.
  assert.deepEqual(withManager({ project: 'Ledung', sessions: ['worker'], from: 'Worker' }, questions, permissions, projectOf), [{ sessionId: 'worker', count: 2 }]);
  assert.deepEqual(withManager({ project: 'Ledung', sessions: ['mgr'], from: 'Manager' }, questions, permissions, projectOf), []);
  // A manager with its sessions folded counts the worker's too: named by the worker that asked, not the manager.
  assert.deepEqual(withManager({ project: 'Ledung', sessions: ['mgr', 'worker'], from: 'Manager' }, questions, permissions, projectOf), [{ sessionId: 'worker', count: 2 }]);
  // A folded project's badge (acceptance round 1: 4 counted, 3 shown, nothing said): every session of the project,
  // and only that project's.
  assert.deepEqual(withManager({ project: 'Ledung', sessions: [], from: 'Ledung' }, questions, permissions, projectOf), [{ sessionId: 'worker', count: 2 }]);
  assert.deepEqual(withManager({ project: 'Other', sessions: [], from: 'Other' }, [...questions, q(7, 'x', 'mgr')], permissions, projectOf), [{ sessionId: 'x', count: 1 }]);
  // So for the folded project: badge = shown + with a manager. The badge counts all 5 open ones in Ledung.
  const badge = questions.filter((x) => x.status === 'open' && projectOf(x.sessionId) === 'Ledung').length
    + permissions.filter((x) => x.status === 'pending' && projectOf(x.sessionId) === 'Ledung').length;
  assert.equal(badge, forYou.length + perms.length + 2);
  // Chats are filtered like a project (Done looks like 8).
  const chats = waitingLists(questions, projectOf, () => [], (p) => p === CHATS, []).forYou;
  assert.deepEqual(chats.map((i) => i.q.id), [6]);
});

test("the badge's tooltip names the count and the project", () => {
  assert.equal(badgeTitle(3, 'Ledung'), '3 waiting for you in Ledung — open');
  assert.match(badgeTitle(1, CHATS), /^1 waiting for you in Chats/);
  // What is with a manager is not called waiting for you.
  assert.equal(badgeTitle(4, 'Ledung', 1), '4 open in Ledung: 3 waiting for you, 1 with a manager — open');
  assert.equal(badgeTitle(1, 'Ledung', 1), '1 in Ledung is with a manager, not waiting for you — open Waiting for you on Ledung');
  const projectOf = (id: string) => (id === 'x' ? 'Other' : 'Ledung');
  assert.equal(asideCount({ project: 'Ledung', sessions: ['w1'], from: 'W' }, { w1: 1, w2: 2, x: 5 }, projectOf), 1);
  assert.equal(asideCount({ project: 'Ledung', sessions: [], from: 'Ledung' }, { w1: 1, w2: 2, x: 5 }, projectOf), 3);
});
