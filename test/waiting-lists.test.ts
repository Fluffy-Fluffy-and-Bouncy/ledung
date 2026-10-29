// Waiting for you lists only what waits for the user; a question a manager is handling is in no list,
// with no "With managers" group, yet still opens on its own (issue #96).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionInfo } from '../src/shared/protocol.ts';
import { waitingLists } from '../web/src/waitingLists.ts';

const FIVE = ['Blocks a finished PR', 'Blocks a card from Ready', 'Process', 'Housekeeping', 'Record only'];

function question(id: number, sessionId: string, addressedTo: string, tier: string, extra: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    id, sessionId, askedAt: id, question: `Question ${id}`, options: null, addressedTo, status: 'open', answer: null,
    answeredAt: null, answeredBy: null, aboutQuestion: null, forwardedFrom: null, aboutRequest: null, shots: null,
    deliveredAt: null, details: { tier }, ...extra,
  } as QuestionInfo;
}

test("a question a manager is handling is in no list, yet opens on its own; the manager's question about it waits for you", () => {
  const questions = [
    question(7, 'worker', 'mgr', 'Process'),
    question(8, 'mgr', 'user', 'Blocks a finished PR', { aboutQuestion: 7 }),
    question(9, 'worker', 'user', 'Housekeeping', { status: 'answered', answer: 'Yes', answeredAt: 20, answeredBy: 'user' }),
  ];
  const { items, forYou, done, listFor } = waitingLists(questions, () => 'p', () => FIVE, () => true, FIVE);

  assert.deepEqual(forYou.map((i) => i.q.id), [8]);
  assert.deepEqual(done.map((i) => i.q.id), [9]);
  const seven = items.find((i) => i.q.id === 7);
  assert.ok(seven, 'question #7 is still there to open');
  assert.deepEqual(listFor(seven).map((i) => i.q.id), [7], 'it opens alone, not as one of a list');
  assert.equal(seven.tier, 'Process');
  assert.deepEqual(listFor(forYou[0]!).map((i) => i.q.id), [8]);
  assert.deepEqual(listFor(done[0]!).map((i) => i.q.id), [9]);
});
