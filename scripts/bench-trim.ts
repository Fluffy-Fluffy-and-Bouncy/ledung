// Times the one-off shrink of old tool results and the VACUUM after it (issue #349) on a generated database, made in a
// temp folder in the shape of a real one from before #349: tool results whole, screenshots as base64, the structured
// copy of each result, no incremental vacuum. Never point it at a real data folder.
//
//   node scripts/bench-trim.ts [size in MB, default 3000] [share of sessions ended over 14 days ago, default 0.8]
//
// It prints how long each step took and how Ledung would have fared meanwhile: the longest the event loop was held,
// and the slowest write and read a live session and the page made during the shrink.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { compactAtStart, HistoryTrimmer } from '../src/store/trim.ts';

const DAY = 24 * 60 * 60 * 1000;
const targetMb = Number(process.argv[2] ?? 3000);
const oldShare = Number(process.argv[3] ?? 0.8);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-bench-trim-'));
const file = path.join(dir, 'ledung.db');
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const size = () => fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);

// A random generator with a seed, so two runs make the same database.
let seed = 349;
const rand = () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const words = 'the build passed test failed src file line error warning ok node npm git diff commit function return const'.split(' ');
const text = (n: number) => {
  let s = '';
  while (s.length < n) s += `${words[Math.floor(rand() * words.length)]} `;
  return s.slice(0, n);
};
const png = Buffer.alloc(225_000, 3).toString('base64'); // ~300 KB as base64, the issue's average screenshot.
// Result sizes as the issue measured them: mostly a few KB, a tail of logs and file reads.
const resultSize = () => {
  const r = rand();
  return r < 0.7 ? 200 + Math.floor(rand() * 4000) : r < 0.95 ? 5000 + Math.floor(rand() * 30_000) : 40_000 + Math.floor(rand() * 400_000);
};

const raw = new DatabaseSync(file);
raw.exec('PRAGMA auto_vacuum = NONE; CREATE TABLE before_349 (x)');
raw.close();
const db = openDatabase(file);
const store = new Store(db);
const now = Date.now();
const insert = db.prepare('INSERT INTO messages (session_id, at, kind, data, seq) VALUES (?, ?, ?, ?, ?)');

let t = Date.now();
let s = 0;
let rows = 0;
db.exec('BEGIN');
while (size() < targetMb * 1024 * 1024) {
  const id = `s${++s}`;
  const old = rand() < oldShare;
  store.createSession({ id, project: 'p', runner: 'local', title: id, parentId: null, permissionMode: 'default' });
  for (let i = 0; i < 400; i++) {
    const tid = `${id}-${i}`;
    insert.run(id, now, 'sdk', JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${tid}`, model: 'claude-haiku-5-5', content: [{ type: 'text', text: text(300) }, { type: 'tool_use', id: tid, name: 'Bash', input: { command: text(200) } }], usage: { input_tokens: 100, output_tokens: 50 } } }), ++rows);
    const image = rand() < 1 / 190;
    const out = image ? null : text(resultSize());
    insert.run(id, now, 'sdk', JSON.stringify({
      type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] : out }] },
      tool_use_result: image ? { type: 'image', file: { base64: png } } : { stdout: out, stderr: '' },
    }), ++rows);
  }
  store.updateSession(id, { status: 'ended', endedAt: old ? now - 20 * DAY : now - 2 * DAY });
  if (s % 20 === 0) {
    db.exec('COMMIT');
    db.exec('BEGIN');
  }
}
db.exec('COMMIT');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log(`Generated ${mb(size())}: ${s} sessions, ${rows} messages, in ${((Date.now() - t) / 1000).toFixed(1)} s.`);
// "keep" as a third argument: only make the database, and leave it for another look (delete the folder after).
if (process.argv[4] === 'keep') {
  db.close();
  console.log(file);
  process.exit(0);
}

// A live session writing its lines and the page reading a conversation, while the shrink runs.
store.createSession({ id: 'live', project: 'p', runner: 'local', title: 'live', parentId: null, permissionMode: 'default' });
let lag = 0;
let last = performance.now();
const loop = setInterval(() => {
  const n = performance.now();
  lag = Math.max(lag, n - last - 10);
  last = n;
}, 10);
let slowWrite = 0;
let slowRead = 0;
let seq = 0;
const live = setInterval(() => {
  let a = performance.now();
  store.addHostLine('live', ++seq, Date.now(), { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'working' }] } });
  slowWrite = Math.max(slowWrite, performance.now() - a);
  a = performance.now();
  store.listMessages('s1', { limit: 500 });
  slowRead = Math.max(slowRead, performance.now() - a);
}, 100);

const before = size();
t = Date.now();
const r = await new HistoryTrimmer(db, { days: () => 14, log: console.log }).run();
console.log(`Shrink: ${r.rows} rows of ${r.sessions} sessions, ${mb(r.chars)} less JSON, in ${((Date.now() - t) / 1000).toFixed(1)} s. ` +
  `Meanwhile: event loop held at most ${lag.toFixed(0)} ms; slowest live write ${slowWrite.toFixed(0)} ms, slowest page read ${slowRead.toFixed(0)} ms.`);
clearInterval(loop);
clearInterval(live);
console.log(`File ${mb(before)} → ${mb(size())} (no incremental vacuum yet; freed pages are reused by new rows).`);

// The next start.
t = Date.now();
const c = compactAtStart(db, { log: console.log });
console.log(`VACUUM at the next start: ${c ? `${mb(c.before)} → ${mb(c.after)} in ${(c.ms / 1000).toFixed(1)} s` : 'not due'}; file now ${mb(size())}.`);

// Later passes: the sessions ended 2 days ago come of age, and are given back bit by bit while Ledung runs.
lag = 0;
last = performance.now();
const loop2 = setInterval(() => {
  const n = performance.now();
  lag = Math.max(lag, n - last - 10);
  last = n;
}, 10);
t = Date.now();
const later = await new HistoryTrimmer(db, { days: () => 14, now: () => now + 15 * DAY }).run();
clearInterval(loop2);
console.log(`A later pass: ${later.rows} rows, ${mb(later.reclaimed)} given back in ${((Date.now() - t) / 1000).toFixed(1)} s, event loop held at most ${lag.toFixed(0)} ms; file now ${mb(size())}.`);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
