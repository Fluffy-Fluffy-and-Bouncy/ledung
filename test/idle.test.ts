// Idle stop (docs/steps/idle-stop-and-archive.md): only a session with nothing going on, for the whole idle time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleReason, idleStopBlocker, type IdleState } from '../src/sessions/idle.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';

const HOUR = 3600_000;
const NOW = 10 * HOUR;

function idle(over: Partial<IdleState> = {}, info: Partial<IdleState['info']> = {}): IdleState {
  return {
    info: { role: 'session', status: 'idle', paused: false, ...info },
    turnOpen: false, pendingPermissions: 0, openQuestions: 0, waitingDeliveries: 0, backgroundTasks: 0,
    facts: { backgroundTasks: 0, crons: 0 }, lastActivity: NOW - HOUR - 1, ...over,
  };
}

test('an idle session with nothing going on is stopped after the idle time, not before', () => {
  assert.equal(idleStopBlocker(idle(), NOW, HOUR), null);
  assert.equal(idleStopBlocker(idle({}, { status: 'starting' }), NOW, HOUR), null, 'resumed or started but never spoken to');
  assert.equal(idleStopBlocker(idle({ lastActivity: NOW - HOUR + 1000 }), NOW, HOUR), 'active recently');
});

test('managers, paused, queued, working and waiting sessions are never stopped', () => {
  assert.equal(idleStopBlocker(idle({}, { role: 'manager' }), NOW, HOUR), 'a manager');
  assert.equal(idleStopBlocker(idle({}, { paused: true }), NOW, HOUR), 'paused');
  for (const status of ['queued', 'running', 'waiting', 'stopping', 'ended'] as const) {
    assert.equal(idleStopBlocker(idle({}, { status }), NOW, HOUR), `status ${status}`);
  }
  assert.equal(idleStopBlocker(idle({ turnOpen: true }), NOW, HOUR), 'in a turn');
});

test('nothing waiting for or from the session: prompts, open questions, held messages, answers', () => {
  assert.notEqual(idleStopBlocker(idle({ pendingPermissions: 1 }), NOW, HOUR), null);
  assert.equal(idleStopBlocker(idle({ openQuestions: 1 }), NOW, HOUR), 'it has an open question');
  assert.equal(idleStopBlocker(idle({ waitingDeliveries: 2 }), NOW, HOUR), 'a message is waiting for it');
});

test('background work, ambient tasks and scheduled wake-ups keep a session; not knowing does too', () => {
  assert.equal(idleStopBlocker(idle({ backgroundTasks: 1 }), NOW, HOUR), 'background work', 'a Monitor counts though it is ambient');
  assert.equal(idleStopBlocker(idle({ facts: { backgroundTasks: 1, crons: 0 } }), NOW, HOUR), 'background work');
  assert.equal(idleStopBlocker(idle({ facts: { backgroundTasks: 0, crons: 1 } }), NOW, HOUR), 'a wake-up is scheduled');
  assert.equal(idleStopBlocker(idle({ facts: { backgroundTasks: 0, crons: null } }), NOW, HOUR), 'not known whether anything is scheduled');
  assert.match(idleStopBlocker(idle({ facts: null }), NOW, HOUR)!, /not known/);
});

test('the end reason names the idle time', () => {
  assert.equal(idleReason(60), 'Stopped after 1 h idle.');
  assert.equal(idleReason(1), 'Stopped after 1 min idle.');
  assert.equal(idleReason(90), 'Stopped after 90 min idle.');
});

test('idle facts and open questions are kept per session', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  assert.equal(store.idleFacts('s'), null);
  store.setIdleFacts('s', { backgroundTasks: 0, crons: 2 });
  assert.deepEqual(store.idleFacts('s'), { backgroundTasks: 0, crons: 2 });
  const q = store.createQuestion({ sessionId: 's', question: '?', options: null, addressedTo: 'user' });
  assert.equal(store.openQuestionCount('s'), 1);
  store.answerQuestion(q.id, 'yes', 'user');
  assert.equal(store.openQuestionCount('s'), 0);
});

test('a turn end is a pause while anything runs in the background or is scheduled', async () => {
  const { pauseReason } = await import('../src/sessions/idle.ts');
  assert.equal(pauseReason(0, { backgroundTasks: 0, crons: 0 }), null, 'nothing running: done or waiting for someone');
  assert.equal(pauseReason(0, null), null, 'nothing known');
  assert.equal(pauseReason(0, { backgroundTasks: 0, crons: null }), null, 'a Claude Code that does not report its schedule: wake');
  assert.match(pauseReason(1, { backgroundTasks: 0, crons: 0 })!, /background/, 'live tasks, ambient ones included');
  assert.match(pauseReason(0, { backgroundTasks: 2, crons: 0 })!, /background/, "the Stop hook's list");
  assert.match(pauseReason(0, { backgroundTasks: 0, crons: 1 })!, /wake-up is scheduled/);
});
