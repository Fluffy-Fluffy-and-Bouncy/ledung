// Daily usage totals (issue #362): filled from the calls when the migration runs, kept up as calls are recorded, and the
// usage report built from them gives the same figures as adding up every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { UsageQueries } from '../src/usage/queries.ts';
import type { UsageRecord } from '../src/usage/recorder.ts';
import type { LimitInfo, UsageFilter } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** A local date as YYYY-MM-DD, written out here rather than taken from the code under test. */
function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const short = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
const tokens = (r: UsageRecord) => r.input + r.cacheWrite + r.cacheRead + r.output;

const PROJECTS = ['web', 'api', 'docs'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5-20260101'];
const TRIGGERS = ['user', 'answer', 'manager', 'ledung'] as const;

/**
 * Twelve sessions with calls over the last ten days at every hour of the day, across projects, models, roles,
 * triggers, branches, two accounts and subagents. Costs are whole 1/1024ths of a dollar, so sums are exact in
 * either order. Every fifth call is recorded again with larger figures, as a streamed reply is.
 */
function records(now: number): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (let n = 0; n < 600; n++) {
    const s = n % 12;
    const input = 100 + ((n * 37) % 900);
    out.push({
      sessionId: `s${s}`, messageId: `m${n}`, at: now - ((n * 7919 * 60_000) % (10 * DAY)), model: MODELS[(n * 5) % 3]!,
      input, cacheWrite: (n * 13) % 500, cacheRead: (n * 101) % 5000, output: (n * 17) % 700, thinking: n % 4 ? null : n,
      cost: ((n * 3) % 50) / 1024, project: PROJECTS[s % 3]!, role: s % 4 === 0 ? 'manager' : 'session', team: null,
      subagent: n % 6 === 0 ? 'Explore' : null, branch: s % 4 === 0 ? 'main' : `agent/b${s % 2}`, trigger: TRIGGERS[n % 4]!,
      machine: 'pc', account: s % 5 === 0 ? 'work' : 'default',
    });
  }
  return out;
}

function seed(store: Store, rs: UsageRecord[]): UsageRecord[] {
  for (let s = 0; s < 12; s++) {
    store.createSession({ id: `s${s}`, project: PROJECTS[s % 3]!, runner: 'local', title: `S${s}`, parentId: null, permissionMode: 'default', role: s % 4 === 0 ? 'manager' : 'session' });
  }
  const final: UsageRecord[] = [];
  rs.forEach((r, i) => {
    store.addUsage(r);
    if (i % 5) return void final.push(r);
    // Recorded again with larger figures; and once more with smaller ones, which the call keeps the larger of.
    const bigger = { ...r, output: r.output + 250, cacheRead: r.cacheRead + 1000, cost: (r.cost ?? 0) + 2 / 1024 };
    store.addUsage(bigger);
    store.addUsage({ ...r, output: 1 });
    final.push(bigger);
  });
  return final;
}

/** The figures the report should show, added up here call by call. */
function expected(rs: UsageRecord[], since: number, f: UsageFilter) {
  const kept = rs.filter((r) =>
    r.at >= since && (!f.project || r.project === f.project) && (!f.model || short(r.model) === f.model) &&
    (!f.branch || r.branch === f.branch) && (!f.role || r.role === f.role) && (!f.trigger || r.trigger === f.trigger) &&
    (!f.account || r.account === f.account));
  const sum = (xs: UsageRecord[], v: (r: UsageRecord) => number) => xs.reduce((n, r) => n + v(r), 0);
  const by = (xs: UsageRecord[], k: (r: UsageRecord) => string) => {
    const out: Record<string, number> = {};
    for (const r of xs) out[k(r)] = (out[k(r)] ?? 0) + tokens(r);
    return out;
  };
  const cell = (xs: UsageRecord[]) => {
    const t = sum(xs, tokens);
    return { byModel: by(xs, (r) => short(r.model)), tokens: t, cost: sum(xs, (r) => r.cost ?? 0), subagentShare: t ? sum(xs.filter((r) => r.subagent), tokens) / t : 0 };
  };
  const days = [...new Set(kept.map((r) => localDay(r.at)))].sort();
  const projects = [...new Set(kept.map((r) => r.project))];
  return {
    totals: {
      tokens: sum(kept, tokens), input: sum(kept, (r) => r.input), cacheWrite: sum(kept, (r) => r.cacheWrite), cacheRead: sum(kept, (r) => r.cacheRead),
      output: sum(kept, (r) => r.output), thinking: sum(kept, (r) => r.thinking ?? 0), cost: sum(kept, (r) => r.cost ?? 0), calls: kept.length,
      sessions: new Set(kept.map((r) => r.sessionId)).size, subagentTokens: sum(kept.filter((r) => r.subagent), tokens),
    },
    daily: days.map((day) => {
      const xs = kept.filter((r) => localDay(r.at) === day);
      return { day, tokens: sum(xs, tokens), byModel: by(xs, (r) => short(r.model)), byProject: by(xs, (r) => r.project), byTrigger: by(xs, (r) => r.trigger) };
    }),
    matrix: projects
      .map((project) => {
        const xs = kept.filter((r) => r.project === project);
        const roles = ['manager', 'session'].map((role) => ({ role, ...cell(xs.filter((r) => r.role === role)) })).filter((x) => x.tokens);
        return { project, ...cell(xs), roles };
      })
      .sort((a, b) => b.tokens - a.tokens),
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const now = Date.now();
  const rs = seed(store, records(now));
  return { db, store, rs, now, q: new UsageQueries(db) };
}

test('the report from the daily totals has the same figures as adding up every call, for every filter (#362)', () => {
  const { store, rs, q } = setup();
  const filters: UsageFilter[] = [
    { period: 'all' }, { period: '7d' }, { period: '30d' },
    { period: 'all', project: 'api' }, { period: 'all', model: 'haiku-5-5' }, { period: '7d', role: 'manager' },
    { period: 'all', trigger: 'answer' }, { period: 'all', account: 'work' }, { period: '7d', project: 'web', model: 'opus-5-5' },
    // A branch is not in the daily totals: the report adds up that branch's calls.
    { period: 'all', branch: 'main' }, { period: '7d', branch: 'agent/b1', trigger: 'user' },
  ];
  for (const f of filters) {
    const r = q.report(f, store.listSessions(), []);
    const want = expected(rs, r.since, f);
    assert.deepEqual(r.totals, want.totals, JSON.stringify(f));
    assert.deepEqual(r.daily, want.daily, JSON.stringify(f));
    assert.deepEqual(r.matrix, want.matrix, JSON.stringify(f));
    assert.ok(r.daily.length > 1 || f.period !== 'all', 'the records span several days');
  }
});

test('a period starting during a day counts that day from its start only (#362)', () => {
  const { store, rs, q, now } = setup();
  // The weekly limit resets at 13:37 local time in two days, so the period starts at 13:37 five days ago.
  const reset = new Date(now + 2 * DAY);
  reset.setHours(13, 37, 0, 0);
  const limits: LimitInfo[] = [{ account: 'default', kind: 'seven_day', status: 'allowed', utilization: 0.5, resetsAt: reset.getTime(), at: now }];
  const r = q.report({ period: 'week' }, store.listSessions(), limits);
  assert.equal(r.since, reset.getTime() - 7 * DAY);
  const want = expected(rs, r.since, { period: 'week' });
  assert.ok(rs.some((x) => x.at < r.since && localDay(x.at) === localDay(r.since)), 'some calls fall on the first day before the period starts');
  assert.deepEqual(r.totals, want.totals);
  assert.deepEqual(r.daily, want.daily);
  assert.deepEqual(r.matrix, want.matrix);
});

test('recent sessions and their figures come from the calls of the sessions shown (#362)', () => {
  const { store, rs, q } = setup();
  const f: UsageFilter = { period: 'all', project: 'api', trigger: 'user' };
  const r = q.report(f, store.listSessions(), []);
  const kept = rs.filter((x) => x.project === 'api' && x.trigger === 'user');
  const ids = [...new Set(kept.map((x) => x.sessionId))];
  assert.equal(r.recent.length, ids.length);
  for (const s of r.recent) {
    const xs = kept.filter((x) => x.sessionId === s.sessionId);
    assert.equal(s.calls, xs.length);
    assert.equal(s.tokens, xs.reduce((n, x) => n + tokens(x), 0));
    assert.equal(s.lastAt, Math.max(...xs.map((x) => x.at)));
  }
  assert.deepEqual(r.recent.map((s) => s.lastAt), [...r.recent.map((s) => s.lastAt)].sort((a, b) => b - a), 'newest first');
  // The choices still come from the whole period.
  assert.deepEqual(r.options.projects, ['api', 'docs', 'web']);
  assert.deepEqual(r.options.branches, ['agent/b0', 'agent/b1', 'main']);
  assert.deepEqual(r.options.accounts, ['default', 'work']);
});

/** The daily totals' rows, in a fixed order. */
const dailyRows = (db: ReturnType<typeof openDatabase>) => db.prepare('SELECT * FROM usage_daily ORDER BY day, account, machine, model, project, role, trigger').all();

test('a database from before the daily totals has them filled from its calls at the first start (#362)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-usage-daily-'));
  const file = path.join(dir, 'ledung.db');
  let db = openDatabase(file);
  seed(new Store(db), records(Date.now()));
  const kept = dailyRows(db);
  assert.ok(kept.length > 50);
  // Back to how migration 37 left it: no daily totals, the session index as it was.
  db.exec(`DROP TRIGGER usage_daily_insert; DROP TRIGGER usage_daily_update; DROP TRIGGER usage_daily_delete; DROP TABLE usage_daily;
    DROP INDEX usage_by_branch; DROP INDEX usage_by_session; CREATE INDEX usage_by_session ON usage(session_id, at); ALTER TABLE questions DROP COLUMN earlier; ALTER TABLE questions DROP COLUMN sources; PRAGMA user_version = 37;`);
  db.close();
  db = openDatabase(file);
  assert.deepEqual(dailyRows(db), kept);
  db.close();
  removeTemp(dir);
});

test('the daily totals keep up with a call recorded again, a renamed project and a removed call (#362)', () => {
  const { db, store } = setup();
  const projects = new ProjectStore(db);
  projects.add({ name: 'web', runner: 'local', path: 'C:/p/web', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
  const sumOf = (where: string, ...args: string[]) =>
    db.prepare(`SELECT SUM(input + cache_write + cache_read + output) AS tokens, SUM(calls) AS calls, SUM(cost) AS cost FROM usage_daily ${where}`).get(...args);
  const fromCalls = (where: string, ...args: string[]) =>
    db.prepare(`SELECT SUM(input + cache_write + cache_read + output) AS tokens, COUNT(*) AS calls, SUM(cost) AS cost FROM usage ${where}`).get(...args);
  assert.deepEqual(sumOf(''), fromCalls(''));
  const before = (sumOf('') as { tokens: number }).tokens;
  // A call recorded again: larger figures replace the call's, so the day grows by the difference only.
  const r: UsageRecord = { sessionId: 's1', messageId: 'again', at: Date.now(), model: 'claude-opus-5-5', input: 10, cacheWrite: 0, cacheRead: 0, output: 5, thinking: null, cost: 1 / 1024, project: 'api', role: 'session', team: null, subagent: null, branch: null, trigger: 'user', machine: 'pc' };
  store.addUsage(r);
  store.addUsage({ ...r, output: 50, cost: 4 / 1024 });
  assert.equal((sumOf('') as { tokens: number }).tokens, before + 60);
  assert.deepEqual(sumOf(''), fromCalls(''));
  // A renamed project's totals move with its calls.
  projects.rename('web', 'site');
  assert.deepEqual(sumOf('WHERE project = ?', 'site'), fromCalls('WHERE project = ?', 'site'));
  assert.equal((sumOf('WHERE project = ?', 'web') as { calls: number | null }).calls, null);
  // A removed call takes its figures with it, and a day with no calls left has no row.
  db.prepare("DELETE FROM usage WHERE message_id = 'again'").run();
  assert.equal((sumOf('') as { tokens: number }).tokens, before);
  db.exec('DELETE FROM usage');
  assert.equal(dailyRows(db).length, 0);
});

test('the report reads its totals, daily chart and table from the daily totals, not the calls (#362)', () => {
  const { db, store, q } = setup();
  const before = q.report({ period: 'all' }, store.listSessions(), []);
  // A change made to the daily totals alone shows in the report; adding up the calls would not see it.
  const { day } = db.prepare("SELECT day FROM usage_daily WHERE project = 'docs' LIMIT 1").get() as { day: string };
  db.prepare("UPDATE usage_daily SET output = output + 1000 WHERE rowid = (SELECT rowid FROM usage_daily WHERE project = 'docs' AND day = ? LIMIT 1)").run(day);
  const after = q.report({ period: 'all' }, store.listSessions(), []);
  assert.equal(after.totals.tokens, before.totals.tokens + 1000);
  assert.equal(after.daily.find((d) => d.day === day)!.tokens, before.daily.find((d) => d.day === day)!.tokens + 1000);
  assert.equal(after.matrix.find((m) => m.project === 'docs')!.tokens, before.matrix.find((m) => m.project === 'docs')!.tokens + 1000);
});
