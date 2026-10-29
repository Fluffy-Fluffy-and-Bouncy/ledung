// Times the usage report (issues #356, #362) on a generated database in a temp folder: model calls spread over the
// last 90 days, across projects, models, roles, triggers, branches, two accounts and subagents. Never point it at a
// real data folder.
//
//   node scripts/bench-usage.ts [calls, default 149000] [days, default 90] [--keep]
//
// --keep leaves the database in place and prints where it is.
//
// It prints how long recording the calls took, and each period's report (fastest of five runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { UsageQueries } from '../src/usage/queries.ts';
import type { UsageFilter } from '../src/shared/protocol.ts';

const DAY = 24 * 60 * 60 * 1000;
const args = process.argv.slice(2).filter((a) => a !== '--keep');
const keep = process.argv.includes('--keep');
const calls = Number(args[0] ?? 149_000);
const days = Number(args[1] ?? 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-bench-usage-'));
const db = openDatabase(path.join(dir, 'ledung.db'));
const store = new Store(db);

// A random generator with a seed, so two runs make the same database.
let seed = 362;
const rand = () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

const projects = ['web', 'api', 'docs', 'mobile', 'infra'];
const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const triggers = ['user', 'answer', 'manager', 'ledung', 'unknown'] as const;
const now = Date.now();
const sessionCount = Math.max(1, Math.round(calls / 500));
const sessions = Array.from({ length: sessionCount }, (_, i) => {
  const project = pick(projects);
  const role = i % 8 === 0 ? 'manager' as const : 'session' as const;
  const start = now - Math.floor(rand() * days * DAY);
  return { id: `s${i}`, project, role, start, branch: role === 'manager' ? 'main' : `agent/fix-${i}`, account: rand() < 0.8 ? 'default' : 'work' };
});

let t = performance.now();
db.exec('BEGIN');
for (const s of sessions) store.createSession({ id: s.id, project: s.project, runner: 'local', title: `Session ${s.id}`, parentId: null, permissionMode: 'default', role: s.role });
for (let n = 0; n < calls; n++) {
  const s = sessions[n % sessions.length]!;
  const input = Math.floor(rand() * 2000);
  store.addUsage({
    sessionId: s.id, messageId: `m${n}`, at: Math.min(now, s.start + Math.floor(rand() * 6 * 3600 * 1000)), model: pick(models),
    input, cacheWrite: Math.floor(rand() * 5000), cacheRead: Math.floor(rand() * 80_000), output: Math.floor(rand() * 3000),
    thinking: rand() < 0.3 ? Math.floor(rand() * 1000) : null, cost: rand() / 10, project: s.project, role: s.role, team: null,
    subagent: rand() < 0.2 ? 'Explore' : null, branch: s.branch, trigger: pick([...triggers]), machine: 'bench', account: s.account,
  });
}
db.exec('COMMIT');
console.log(`Recorded ${calls} calls in ${sessionCount} sessions over ${days} days: ${(performance.now() - t).toFixed(0)} ms`);
console.log(`Daily totals: ${(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n} rows`);

const q = new UsageQueries(db);
const list = store.listSessions();
const time = (label: string, filter: UsageFilter) => {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    t = performance.now();
    q.report(filter, list, []);
    best = Math.min(best, performance.now() - t);
  }
  console.log(`${label.padEnd(28)} ${best.toFixed(1)} ms`);
};
time('90 days', { period: '90d' });
time('all', { period: 'all' });
time('7 days', { period: '7d' });
time('90 days, one project', { period: '90d', project: 'web' });
time('90 days, one model', { period: '90d', model: 'sonnet-5-5' });
time('90 days, one branch', { period: '90d', branch: 'main' });
db.close();
if (keep) console.log(`Kept: ${path.join(dir, 'ledung.db')}`);
else fs.rmSync(dir, { recursive: true, force: true });
