import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { periodStart, UsageQueries } from '../src/usage/queries.ts';
import type { UsageRecord } from '../src/usage/recorder.ts';

function setup() {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 'mgr', project: 'ledung', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'auto', role: 'manager' });
  store.createSession({ id: 'w1', project: 'ledung', runner: 'local', title: 'Worker', parentId: 'mgr', permissionMode: 'auto' });
  store.createSession({ id: 'solo', project: 'site', runner: 'local', title: 'Solo', parentId: null, permissionMode: 'auto' });
  const now = Date.now();
  let n = 0;
  const add = (sessionId: string, model: string, tokens: number, extra: Partial<UsageRecord> = {}) =>
    store.addUsage({
      sessionId, messageId: `m${n++}`, at: now, model, input: tokens, cacheWrite: 0, cacheRead: 0, output: 0, thinking: null, cost: tokens / 1e6,
      project: sessionId === 'solo' ? 'site' : 'ledung', role: sessionId === 'mgr' ? 'manager' : 'session', team: sessionId === 'solo' ? null : 'mgr',
      subagent: null, branch: 'main', trigger: 'user', machine: 'pc', ...extra,
    });
  add('mgr', 'claude-opus-5-5', 100);
  add('w1', 'claude-sonnet-5-5', 300);
  add('w1', 'claude-sonnet-5-5', 100, { subagent: 'Explore' });
  add('solo', 'claude-haiku-5-5-20260101', 50, { trigger: 'answer' });
  return { store, q: new UsageQueries(db) };
}

test('totals, the project × model matrix and roles', () => {
  const { store, q } = setup();
  const r = q.report({ period: 'all' }, store.listSessions(), []);
  assert.equal(r.totals.tokens, 550);
  assert.equal(r.totals.sessions, 3);
  assert.deepEqual(r.models, ['sonnet-5-5', 'opus-5-5', 'haiku-5-5']);
  const ledung = r.matrix.find((m) => m.project === 'ledung')!;
  assert.deepEqual(ledung.byModel, { 'opus-5-5': 100, 'sonnet-5-5': 400 });
  assert.equal(ledung.subagentShare, 100 / 500);
  assert.deepEqual(ledung.roles.map((x) => [x.role, x.tokens]), [['manager', 100], ['session', 400]]);
});

test('daily figures and recent sessions, grouped per day and per session (#356)', () => {
  const { store, q } = setup();
  const r = q.report({ period: 'all' }, store.listSessions(), []);
  // The four records of setup(), all made now: one day.
  assert.equal(r.daily.length, 1);
  assert.equal(r.daily[0]!.tokens, 550);
  assert.deepEqual(r.daily[0]!.byProject, { ledung: 500, site: 50 });
  assert.deepEqual(r.daily[0]!.byModel, { 'opus-5-5': 100, 'sonnet-5-5': 400, 'haiku-5-5': 50 });
  assert.deepEqual(r.daily[0]!.byTrigger, { user: 500, answer: 50 });
  const recent = (id: string) => r.recent.find((s) => s.sessionId === id)!;
  assert.equal(r.recent.length, 3);
  assert.deepEqual([recent('w1').calls, recent('w1').tokens, recent('w1').subagentShare], [2, 400, 100 / 400]);
  assert.deepEqual([recent('mgr').calls, recent('mgr').tokens, recent('mgr').role], [1, 100, 'manager']);
  assert.deepEqual([recent('solo').calls, recent('solo').tokens, recent('solo').project], [1, 50, 'site']);
  assert.deepEqual(recent('w1').models, ['sonnet-5-5']);
});

test('filters narrow the figures but not the choices', () => {
  const { store, q } = setup();
  const r = q.report({ period: 'all', trigger: 'answer' }, store.listSessions(), []);
  assert.equal(r.totals.tokens, 50);
  assert.deepEqual(r.options.projects, ['ledung', 'site']);
});

test('per session and today', () => {
  const { q } = setup();
  assert.equal(q.session('w1').totals.tokens, 400);
  assert.equal(q.session('w1').calls[1]!.subagent, 'Explore');
  assert.equal(q.perSession().w1!.today, 400);
  assert.equal(q.todayTotal(), 550);
});

test('"since weekly reset" starts a week before the next reset', () => {
  const reset = Date.UTC(2026, 9, 14, 8);
  assert.equal(periodStart('week', [{ account: 'default', kind: 'seven_day', status: 'allowed', utilization: 0.4, resetsAt: reset, at: 0 }]), reset - 7 * 24 * 3600 * 1000);
});
