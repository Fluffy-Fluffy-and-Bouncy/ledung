// Browser notifications: which waiting items notify, what is new since the page loaded, what closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNotifications, stopItems, waitingItems } from '../web/src/notify.ts';
import type { PermissionInfo, QuestionInfo } from '../src/shared/protocol.ts';

const q = (id: number, over: Partial<QuestionInfo> = {}) =>
  ({ id, sessionId: 's1', question: 'Which database?\nMore detail', status: 'open', addressedTo: 'user', ...over }) as QuestionInfo;
const p = (id: string, over: Partial<PermissionInfo> = {}) =>
  ({ id, sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' }, title: null, reason: null, status: 'pending', addressedTo: 'user', sensitive: null, ...over }) as PermissionInfo;
const title = (id: string) => (id === 's1' ? 'Alpha' : 'Beta');

test('only open items addressed to the user, with the first line of the question', () => {
  const items = waitingItems(
    [q(1), q(2, { addressedTo: 'm1' }), q(3, { status: 'answered' })],
    [p('a'), p('b', { addressedTo: 'm1' }), p('c', { status: 'allowed' })],
    title,
  );
  assert.deepEqual(items.map((i) => i.id), ['q1', 'pa']);
  assert.equal(items[0]!.title, 'Question from Alpha');
  assert.equal(items[0]!.body, 'Which database?');
  assert.equal(items[1]!.title, 'Permission: Bash in Alpha');
  assert.equal(items[1]!.body, 'npm test');
});

test('sensitive prompts are marked, and long lines are shortened', () => {
  const [item] = waitingItems([], [p('a', { sensitive: 'git push', input: { command: 'x'.repeat(300) } })], title);
  assert.match(item!.body, /^Sensitive: x+…$/);
  assert.ok(item!.body.length < 170);
});

test('a multiple-choice question reads as a question', () => {
  const [item] = waitingItems([], [p('a', { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Pick one?' }] } })], title);
  assert.equal(item!.title, 'Question from Alpha');
  assert.equal(item!.body, 'Pick one?');
});

test('nothing notifies for what is there when the page loads', () => {
  const items = waitingItems([q(1)], [p('a')], title);
  const first = planNotifications(null, items);
  assert.deepEqual(first.show, []);
  assert.deepEqual([...first.open], ['q1', 'pa']);
});

test('a new item notifies once; the same list again (a reconnect) does not', () => {
  const base = planNotifications(null, waitingItems([q(1)], [], title)).open;
  const next = planNotifications(base, waitingItems([q(1), q(2)], [], title));
  assert.deepEqual(next.show.map((i) => i.id), ['q2']);
  assert.deepEqual(planNotifications(next.open, waitingItems([q(1), q(2)], [], title)).show, []);
});

test('answered items close their notification', () => {
  const base = planNotifications(null, waitingItems([q(1), q(2)], [], title)).open;
  const next = planNotifications(base, waitingItems([q(2)], [], title));
  assert.deepEqual(next.close, ['q1']);
  assert.deepEqual(next.show, []);
});

test('a usage stop that holds work notifies once per window and opens Settings (#278)', () => {
  const stop = { account: 'default', kind: 'seven_day', percent: 98, utilization: 0.98, resetsAt: 1000, reached: true, lifted: false, holding: true };
  const [item] = stopItems([stop, { ...stop, kind: 'five_hour', holding: false }]);
  assert.deepEqual(item, { id: 'stop:default:seven_day:1000', sessionId: 'settings', title: 'Usage stop reached: weekly 98%', body: 'New turns are held until you lift it in Settings or the window resets.' });
  const before = planNotifications(null, stopItems([stop])).open;
  assert.deepEqual(planNotifications(before, stopItems([stop])).show, [], 'the same window: not again');
  assert.equal(planNotifications(before, stopItems([{ ...stop, resetsAt: 2000 }])).show.length, 1, 'the next window: again');
});
