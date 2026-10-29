// "Go to conversation" (issue #61): the conversation a question is answered in, its address, and the
// questions of other sessions woven into a manager's conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFromHash, conversationHash, conversationOf, insertByTime, shownWoven, wovenQuestions } from '../web/src/conversation.ts';

// A project with manager M running session S, and a session U the user started without a manager.
const q = (id: number, sessionId: string, addressedTo: string, askedAt = id) => ({ id, sessionId, addressedTo, askedAt });

test('a question opens the conversation of the manager who owns it', () => {
  assert.equal(conversationOf(q(1, 'M', 'user')), 'M', "a manager's own question");
  assert.equal(conversationOf(q(2, 'S', 'M')), 'M', "a session's question its manager handles");
  // A manager's question about a session's question is asked by the manager, addressed to the user.
  const about = { ...q(3, 'M', 'user'), aboutQuestion: 2 };
  assert.equal(conversationOf(about), 'M', "a manager's question about a session's question");
  assert.equal(conversationOf(q(4, 'U', 'user')), 'U', 'a session no manager runs: its own conversation');
});

test('the address opens a conversation scrolled to a question, and reads back', () => {
  assert.equal(conversationHash('abc-1', 7), '#/s/abc-1/q/7');
  assert.equal(conversationHash('abc-1'), '#/s/abc-1');
  assert.deepEqual(conversationFromHash('#/s/abc-1/q/7'), { sessionId: 'abc-1', questionId: 7 });
  assert.deepEqual(conversationFromHash('#/s/abc-1'), { sessionId: 'abc-1', questionId: null });
  assert.equal(conversationFromHash('#/waiting/q/7'), null);
  assert.equal(conversationFromHash('#/s/abc-1/q/x'), null);
});

test("a manager's conversation shows its sessions' questions, not its own twice nor others'", () => {
  const all = [q(5, 'S', 'M', 50), q(1, 'M', 'user', 10), q(2, 'S', 'M', 20), q(3, 'S2', 'OTHER', 30), q(4, 'U', 'user', 40)];
  assert.deepEqual(wovenQuestions(all, 'M', null).map((x) => x.id), [2, 5]);
  // The session's own conversation already has its question as a message.
  assert.deepEqual(wovenQuestions(all, 'S', null).map((x) => x.id), []);
  // Older than the earliest loaded message: shown after "Load earlier messages".
  assert.deepEqual(wovenQuestions(all, 'M', 30).map((x) => x.id), [5]);
});

test("a session's question to its manager shows only with technical messages or when opened at it (issue #112)", () => {
  const woven = wovenQuestions([q(2, 'S', 'M', 20), q(5, 'S', 'M', 50)], 'M', null);
  assert.deepEqual(shownWoven(woven, false, null), [], 'hidden by default');
  assert.deepEqual(shownWoven(woven, true, null).map((x) => x.id), [2, 5], 'Show tool calls brings them back');
  // Go to conversation from Waiting for you still lands on its card.
  assert.deepEqual(shownWoven(woven, false, 5).map((x) => x.id), [5]);
});

test('woven entries go in by time, after entries of the same time', () => {
  const list = [{ at: 10, k: 'a' }, { at: 20, k: 'b' }, { at: 30, k: 'c' }];
  const out = insertByTime(list, [{ at: 5, k: 'x' }, { at: 20, k: 'y' }, { at: 99, k: 'z' }]);
  assert.deepEqual(out.map((e) => e.k), ['x', 'a', 'b', 'y', 'c', 'z']);
  assert.deepEqual(list.map((e) => e.k), ['a', 'b', 'c'], 'the list given is left as it was');
});
