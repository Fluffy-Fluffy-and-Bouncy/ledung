// work_history (issue #254): measured work time, wall time, tokens and plan use per session and kind, for estimates
// in session time instead of human days. Only the asking manager's own project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { duration, formatWorkHistory, kindOf, median, workHistory } from '../src/usage/work-history.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 12, 12, 0);
const T0 = NOW - 6 * 60 * MIN;

function setup() {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'auto', role: 'manager' });
  store.createSession({ id: 'b1', project: 'p', runner: 'local', title: 'Build the export page', parentId: 'mgr', permissionMode: 'auto' });
  store.createSession({ id: 'r1', project: 'p', runner: 'local', title: 'Review PR #12', parentId: 'mgr', permissionMode: 'auto' });
  store.createSession({ id: 'w1', project: 'p', runner: 'local', title: 'Something', parentId: 'mgr', permissionMode: 'auto' });
  store.createSession({ id: 'x1', project: 'secret', runner: 'local', title: 'Other project work', parentId: null, permissionMode: 'auto' });
  db.prepare("UPDATE sessions SET status = 'ended'").run();
  db.prepare("UPDATE sessions SET run_block = ? WHERE id = 'w1'").run(JSON.stringify({ run: '3', block: 'Build' }));
  const turn = (sessionId: string, project: string, startMin: number, minutes: number, role = 'session') =>
    store.addTurnResource({
      sessionId, project, role, model: 'claude-opus-5-5', trigger: 'user', startedAt: T0 + startMin * MIN, durationMs: minutes * MIN,
      cpuSeconds: 1, samples: 1, avgCores: 0, peakCores: 1, peakMem: 1, commands: [],
    });
  // b1: two turns of 20 and 30 min, an hour apart; a 10-minute permission wait inside the second.
  turn('b1', 'p', 0, 20);
  turn('b1', 'p', 80, 30);
  db.prepare("INSERT INTO permissions (id, session_id, at, tool_name, input, status, decided_at) VALUES ('q1', 'b1', ?, 'Bash', '{}', 'allowed', ?)")
    .run(T0 + 85 * MIN, T0 + 95 * MIN);
  turn('r1', 'p', 10, 8);
  turn('w1', 'p', 30, 40);
  turn('mgr', 'p', 0, 200, 'manager');
  turn('x1', 'secret', 0, 99);
  let n = 0;
  const use = (sessionId: string, project: string, at: number, tokens: number, cost: number) =>
    store.addUsage({
      sessionId, messageId: `m${n++}`, at: T0 + at * MIN, model: 'claude-opus-5-5', input: tokens, cacheWrite: 0, cacheRead: 0, output: 0, thinking: null,
      cost, project, role: 'session', team: null, subagent: null, branch: null, trigger: 'user', machine: 'pc', account: 'acct',
    });
  use('b1', 'p', 5, 2_000_000, 4);
  use('r1', 'p', 12, 500_000, 1);
  use('w1', 'p', 35, 1_000_000, 2);
  use('x1', 'secret', 40, 9_000_000, 3);
  // The account's weekly window rose 10 points over the $10 recorded between the figures: 1% per dollar.
  const resetsAt = NOW + 3 * 86_400_000;
  store.addLimit({ account: 'acct', at: T0, kind: 'seven_day', status: 'allowed', utilization: 0.2, resetsAt, data: {} });
  store.addLimit({ account: 'acct', at: T0 + 200 * MIN, kind: 'seven_day', status: 'allowed', utilization: 0.3, resetsAt, data: {} });
  return { db, store };
}

test('work is time in turns less permission waits; wall runs from the first turn to the last', () => {
  const { db } = setup();
  const h = workHistory(db, 'p', { now: NOW });
  const b1 = h.sessions.find((s) => s.id === 'b1')!;
  assert.equal(b1.workMs, 40 * MIN);
  assert.equal(b1.wallMs, 110 * MIN);
  assert.equal(b1.turns, 2);
  assert.equal(b1.tokens, 2_000_000);
});

test("only the project's own sessions, never its manager or another project's", () => {
  const { db } = setup();
  const h = workHistory(db, 'p', { now: NOW });
  assert.deepEqual(h.sessions.map((s) => s.id).sort(), ['b1', 'r1', 'w1']);
  const text = formatWorkHistory(h);
  assert.doesNotMatch(text, /Other project|secret|Manager: p/);
});

test('kinds come from the workflow block, else the title', () => {
  assert.equal(kindOf('Anything', JSON.stringify({ run: '1', block: 'Build' })), 'build');
  assert.equal(kindOf('Review PR #3', null), 'review');
  assert.equal(kindOf('Fix the cart', null), 'fix');
  assert.equal(kindOf('Bugfix: totals', null), 'fix');
  assert.equal(kindOf('Add export', null), 'other');
  assert.equal(kindOf('Build: subtract and multiply', null), 'build');
  assert.equal(kindOf('Add export', '{not json'), 'other');
  const { db } = setup();
  const kinds = Object.fromEntries(workHistory(db, 'p', { now: NOW }).kinds.map((k) => [k.kind, k]));
  assert.equal(kinds.all!.count, 3);
  assert.equal(kinds.all!.work.median, 40 * MIN);
  assert.deepEqual([kinds.all!.work.min, kinds.all!.work.max], [8 * MIN, 40 * MIN]);
  assert.equal(kinds.review!.count, 1);
  assert.equal(kinds.build!.count, 2, 'one from its block, one from its title');
});

test("plan use is the session's cost at the rate the account's window rose against its recorded cost", () => {
  const { db } = setup();
  const h = workHistory(db, 'p', { now: NOW });
  // $4 of the $10 that raised the weekly window 10 points: 4 points.
  assert.ok(Math.abs(h.sessions.find((s) => s.id === 'b1')!.shares.weekly! - 0.04) < 1e-9);
  assert.equal(h.sessions[0]!.shares['5-hour'], undefined, 'no 5-hour figures: no 5-hour share');
  assert.match(formatWorkHistory(h), /4\.0% of weekly/);
});

test('without enough window figures, plan use is left out and tokens remain', () => {
  const { db } = setup();
  db.prepare('DELETE FROM limits').run();
  const text = formatWorkHistory(workHistory(db, 'p', { now: NOW }));
  assert.doesNotMatch(text, /% of/);
  assert.match(text, /2\.0M tokens/);
  assert.match(text, /go by tokens/);
});

test('a project with nothing measured says so', () => {
  const { db } = setup();
  assert.match(formatWorkHistory(workHistory(db, 'empty', { now: NOW })), /nothing measured yet/);
});

test('turns before the period are left out', () => {
  const { db } = setup();
  assert.equal(workHistory(db, 'p', { now: NOW + 40 * 86_400_000, days: 30 }).sessions.length, 0);
});

test('median', () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

// Review of #254: the cases its first version got wrong.
test('a workflow block called "all" is a kind of its own and does not hang the call (finding 1)', () => {
  const { db } = setup();
  db.prepare("UPDATE sessions SET run_block = ? WHERE id = 'w1'").run(JSON.stringify({ run: '3', block: 'All' }));
  const kinds = workHistory(db, 'p', { now: NOW }).kinds;
  assert.deepEqual(kinds.map((k) => [k.kind, k.count]).sort(), [['all', 1], ['all', 3], ['build', 1], ['review', 1]].sort());
});

test('a session with a call Ledung could not price gets no plan share, and its gap leaves the rate alone (finding 2)', () => {
  const { db, store } = setup();
  store.addUsage({
    sessionId: 'r1', messageId: 'unpriced', at: T0 + 13 * MIN, model: 'some-new-model', input: 10, cacheWrite: 0, cacheRead: 0, output: 0, thinking: null,
    cost: null, project: 'p', role: 'session', team: null, subagent: null, branch: null, trigger: 'user', machine: 'pc', account: 'acct',
  });
  const h = workHistory(db, 'p', { now: NOW });
  assert.equal(h.sessions.find((s) => s.id === 'r1')!.shares.weekly, undefined);
  // The only pair now has an unpriced call in its gap: no rate at all, rather than one that reads high.
  assert.equal(h.rates.weekly, undefined);
});

test('two permission prompts open at once count as one wait (finding 3)', () => {
  const { db } = setup();
  db.prepare("INSERT INTO permissions (id, session_id, at, tool_name, input, status, decided_at) VALUES ('q2', 'b1', ?, 'Bash', '{}', 'allowed', ?)")
    .run(T0 + 87 * MIN, T0 + 93 * MIN);
  assert.equal(workHistory(db, 'p', { now: NOW }).sessions.find((s) => s.id === 'b1')!.workMs, 40 * MIN);
});

test('a session that began before the period is counted whole (finding 4)', () => {
  const { db } = setup();
  // 100 min after T0 only b1's second turn (from T0 + 80 min) is in a period that starts at T0 + 80 min.
  const h = workHistory(db, 'p', { now: T0 + 80 * MIN + 86_400_000, days: 1 });
  const b1 = h.sessions.find((s) => s.id === 'b1')!;
  assert.deepEqual([b1.turns, b1.workMs, b1.tokens], [2, 40 * MIN, 2_000_000]);
  assert.deepEqual(h.sessions.map((s) => s.id), ['b1']);
});

test('figures from different windows are never compared', () => {
  const { db, store } = setup();
  db.prepare('DELETE FROM limits').run();
  store.addLimit({ account: 'acct', at: T0, kind: 'seven_day', status: 'allowed', utilization: 0.9, resetsAt: NOW, data: {} });
  store.addLimit({ account: 'acct', at: T0 + 200 * MIN, kind: 'seven_day', status: 'allowed', utilization: 0.95, resetsAt: NOW + 7 * 86_400_000, data: {} });
  assert.equal(workHistory(db, 'p', { now: NOW }).rates.weekly, undefined);
});

test('sessions under way are listed but left out of the medians; limit 0 lists none', () => {
  const { db } = setup();
  db.prepare("UPDATE sessions SET status = 'queued' WHERE id = 'r1'").run();
  db.prepare("UPDATE sessions SET status = 'idle' WHERE id = 'w1'").run();
  const h = workHistory(db, 'p', { now: NOW });
  assert.equal(h.kinds.find((k) => k.kind === 'all')!.count, 2);
  assert.match(formatWorkHistory(h), /Review PR #12" \[review, still working\]/);
  assert.doesNotMatch(formatWorkHistory(h, 0), /Recent/);
});

test('durations under a minute show seconds', () => {
  assert.equal(duration(42_400), '42 s');
  assert.equal(duration(0), '0 s');
  assert.equal(duration(23 * MIN), '23 min');
});
