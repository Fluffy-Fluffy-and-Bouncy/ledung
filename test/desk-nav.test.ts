import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShotVerdict } from '../src/shared/protocol.ts';
import { afterVerdict, deskStepsInto, leaveShots, SEND_GUARD_MS, sendStep, sendsVerdicts, type DeskSteps } from '../web/src/deskNav.ts';

// The screenshot view in miniature: shots shown in `order`, verdicts given the way a key press or a click does.
function viewer(order: number[], start: Record<number, ShotVerdict> = {}) {
  const judged: Record<number, ShotVerdict | null> = { ...start };
  let k = 0;
  return {
    get at() { return k; },
    get judged() { return judged; },
    goTo(j: number) { k = j; },
    verdict(v: ShotVerdict) {
      const index = order[k]!;
      const r = afterVerdict(order, (i) => judged[i], k, judged[index], v);
      judged[index] = r.verdict;
      k = r.to;
    },
  };
}

test('a verdict marks the shot and shows the next one at once, by key or click alike (issue #92, Done: keys, clicks)', () => {
  const s = viewer([0, 1, 2, 3]);
  s.verdict('pass');
  assert.equal(s.at, 1);
  assert.equal(s.judged[0], 'pass');
  s.verdict('fail');
  assert.equal(s.at, 2);
  assert.equal(s.judged[1], 'fail');
  s.verdict('unsure');
  assert.equal(s.at, 3);
  assert.equal(s.judged[2], 'unsure');
});

test('on the last shot, with every other shot judged, a verdict is marked and the view stays (issue #92, Done: keys)', () => {
  // Every other shot judged since #138: with one left before it, the view now goes back to that one.
  const s = viewer([0, 1, 2], { 0: 'pass', 1: 'pass' });
  s.goTo(2);
  s.verdict('fail');
  assert.equal(s.at, 2);
  assert.equal(s.judged[2], 'fail');
});

test('a verdict wraps round to a shot before it with no verdict, so verdicts alone reach every shot (issue #138)', () => {
  // Issue #138, question #141: the view was past the first four shots and verdicts only ever moved it on,
  // so those four could not be reached by verdicts and went as "no verdict".
  const s = viewer([0, 1, 2, 3, 4, 5]);
  s.goTo(4);
  s.verdict('pass');
  assert.equal(s.at, 5);
  s.verdict('pass');
  assert.equal(s.at, 0);
  for (let n = 0; n < 4; n++) s.verdict('pass');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => s.judged[i]), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
});

test('sending with shots still without a verdict first shows the first of them, then sends on a later press (issue #138)', () => {
  const judged: Record<number, ShotVerdict> = { 0: 'pass', 1: 'pass', 3: 'pass' };
  const at = (i: number) => judged[i];
  // Shown "Looks off first": 3, 2, 0, 1, 4; shots 2 and 4 have none, 2 is first in the order shown.
  assert.deepEqual(sendStep([3, 2, 0, 1, 4], at, null, 1000), { send: false, to: 1, missing: 2 });
  assert.deepEqual(sendStep([3, 2, 0, 1, 4], at, 1000, 1000 + SEND_GUARD_MS), { send: true });
  assert.deepEqual(sendStep([0, 1], (i) => ({ 0: 'pass', 1: 'fail' } as Record<number, ShotVerdict>)[i], null, 1000), { send: true });
});

test('a double-click or key bounce on Send does not get past the shots without a verdict (#141 review, finding 1)', () => {
  const judged: Record<number, ShotVerdict> = { 0: 'pass' };
  const first = sendStep([0, 1, 2], (i) => judged[i], null, 5000);
  assert.deepEqual(first, { send: false, to: 1, missing: 2 });
  // The second click of a double-click, 120 ms later: ignored, nothing sent.
  assert.deepEqual(sendStep([0, 1, 2], (i) => judged[i], 5000, 5120), { send: false, tooSoon: true });
  assert.deepEqual(sendStep([0, 1, 2], (i) => judged[i], 5000, 5000 + SEND_GUARD_MS - 1), { send: false, tooSoon: true });
});

test('holding Ctrl+Enter sends once: its repeats never send, so they cannot get past the guard (#141 review round 2)', () => {
  assert.equal(sendsVerdicts({ ctrlKey: true, metaKey: false, key: 'Enter', repeat: false }), true);
  assert.equal(sendsVerdicts({ ctrlKey: false, metaKey: true, key: 'Enter', repeat: false }), true);
  assert.equal(sendsVerdicts({ ctrlKey: true, metaKey: false, key: 'Enter', repeat: true }), false);
  assert.equal(sendsVerdicts({ ctrlKey: false, metaKey: false, key: 'Enter', repeat: false }), false);
});

test('the move goes to the next shot not judged yet, skipping judged ones (issue #92, Decision comment)', () => {
  const s = viewer([0, 1, 2, 3], { 1: 'pass', 2: 'pass' });
  s.verdict('fail');
  assert.equal(s.at, 3);
  s.verdict('pass');
  // Judging again where every later shot has a verdict: on to the next one, not back to the start.
  s.goTo(1);
  s.verdict('fail');
  assert.equal(s.at, 2);
});

test('the move follows the order shown, not the order attached ("Looks off first")', () => {
  const s = viewer([2, 0, 3, 1]);
  s.verdict('pass');
  assert.equal(s.judged[2], 'pass');
  assert.equal(s.at, 1);
});

test('the same verdict again un-marks the shot and does not move (issue #92, Done: un-mark)', () => {
  const s = viewer([0, 1, 2], { 0: 'pass' });
  s.verdict('pass');
  assert.equal(s.at, 0);
  assert.equal(s.judged[0], null);
  // A different verdict on a judged shot changes it and moves on.
  const t = viewer([0, 1, 2], { 0: 'pass' });
  t.verdict('fail');
  assert.equal(t.judged[0], 'fail');
  assert.equal(t.at, 1);
});

// A browser history in miniature: each entry the page opens records its steps the way App's open() does;
// an entry the page did not open (the first load) that shows Waiting for you is step 0 of its own chain.
function browse(first: string) {
  const firstSteps: DeskSteps = first === 'waiting' || first.startsWith('q:') ? { depth: 0, root: true } : { depth: 0, root: false };
  const entries: { id: string; steps: DeskSteps }[] = [{ id: first, steps: firstSteps }];
  let at = 0;
  const current = () => entries[at]!;
  return {
    open(id: string) {
      const steps = deskStepsInto(current().id, current().steps, id);
      entries.splice(at + 1, Infinity, { id, steps });
      at++;
    },
    /** The verdicts are sent; returns the view it lands on. */
    send(): string {
      const to = leaveShots(current().steps.depth);
      if ('back' in to) at -= to.back;
      else this.open('waiting');
      return current().id;
    },
  };
}

test('after sending, the page returns to the view open before the screenshots (issue #92, Done: after sending)', () => {
  // From a session, the Overview, the queue, or another question.
  for (const before of ['session-1', 'overview', 'waiting', 'q:4']) {
    const b = browse('overview');
    if (before !== 'overview') b.open(before);
    b.open('q:7');
    assert.equal(b.send(), before, `opened from ${before}`);
  }
  // Through the queue from a session: back to the queue, which no longer offers the answered question first.
  const b = browse('session-1');
  b.open('waiting');
  b.open('q:7');
  assert.equal(b.send(), 'waiting');
});

test('after sending, a question that was the first page loaded goes to the queue, never itself (issue #92)', () => {
  const b = browse('q:7');
  assert.equal(b.send(), 'waiting');
});
