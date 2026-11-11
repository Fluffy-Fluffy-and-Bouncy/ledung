// The check-in endpoint (#220, checkin-worker/): the Worker's own code runs here under Node, against node:sqlite
// with its real schema.sql in place of D1. It keeps only the four fields and the days, counts unique installs and
// those active in 1/7/30 days with the version, channel and OS split, and serves the counts only with the token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dayOf, handle, parseCheckIn, type D1Database, type D1Statement, type Env } from '../checkin-worker/worker.ts';

const SCHEMA = fs.readFileSync(path.join(import.meta.dirname, '..', 'checkin-worker', 'schema.sql'), 'utf8');
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-11T12:00:00Z');
const TOKEN = 'counts-token';
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];

/** D1's statement calls over node:sqlite: the database D1 itself is (SQLite), not the Worker under test. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const stmt: D1Statement = {
        bind: (...v) => { values = v; return stmt; },
        run: async () => db.prepare(sql).run(...(values as never[])),
        first: async <T,>() => (db.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
        all: async <T,>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
      };
      return stmt;
    },
  };
}

function setup(): { db: DatabaseSync; env: Env } {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return { db, env: { DB: d1(db), COUNTS_TOKEN: TOKEN } };
}

const checkIn = (env: Env, body: unknown, now: number) => handle(new Request('https://checkin.example/v1/checkin', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' }, body: JSON.stringify(body),
}), env, now);

test('a check-in is stored as the four fields and the days; nothing else, no IP address', async () => {
  const { db, env } = setup();
  const res = await checkIn(env, { id: ids[0], version: '2.1.0', channel: 'dev', os: 'win32', hostname: 'my-pc', email: 'a@b.c' }, T0);
  assert.equal(res.status, 204);
  const rows = db.prepare('SELECT * FROM installs').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: ids[0], first_day: '2026-11-11', last_day: '2026-11-11', version: '2.1.0', channel: 'dev', os: 'win32' }]);
  const columns = (db.prepare('PRAGMA table_info(installs)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, ['id', 'first_day', 'last_day', 'version', 'channel', 'os']);
  const everything = JSON.stringify(db.prepare('SELECT * FROM installs').all());
  for (const leak of ['203.0.113.7', 'my-pc', 'a@b.c']) assert.ok(!everything.includes(leak), leak);
  // The same probe finds what was sent.
  assert.ok(everything.includes(ids[0]!));
});

test('a later check-in moves last seen and the version; first seen stays', async () => {
  const { db, env } = setup();
  await checkIn(env, { id: ids[0], version: '2.0.0', channel: 'public', os: 'linux' }, T0);
  await checkIn(env, { id: ids[0], version: '2.1.0', channel: 'dev', os: 'linux' }, T0 + 3 * DAY);
  assert.deepEqual({ ...db.prepare('SELECT * FROM installs').get() }, { id: ids[0], first_day: '2026-11-11', last_day: '2026-11-14', version: '2.1.0', channel: 'dev', os: 'linux' });
});

test('anything but a check-in is refused and stores nothing', async () => {
  const { db, env } = setup();
  const good = { id: ids[0], version: '2.1.0', channel: 'public', os: 'darwin' };
  for (const bad of [{ ...good, id: 'not-an-id' }, { ...good, channel: 'beta' }, { ...good, os: 'Windows 11; DROP TABLE' }, { ...good, version: '' }, 'x', null]) {
    assert.equal((await checkIn(env, bad, T0)).status, 400, JSON.stringify(bad));
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM installs').get() as { n: number }).n, 0);
  assert.equal((await handle(new Request('https://checkin.example/v1/checkin'), env, T0)).status, 405);
  assert.equal((await checkIn(env, { ...good, pad: 'x'.repeat(2000) }, T0)).status, 413);
  assert.equal((await checkIn(env, good, T0)).status, 204);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM installs').get() as { n: number }).n, 1);
  assert.deepEqual(parseCheckIn(good), good);
});

test('the counts: unique, active in 1/7/30 days, and the split of the 30-day active, only with the token', async () => {
  const { env } = setup();
  // Last seen today, 3 days ago, 20 days ago and 40 days ago.
  await checkIn(env, { id: ids[0], version: '2.1.0', channel: 'dev', os: 'win32' }, T0);
  await checkIn(env, { id: ids[1], version: '2.0.0', channel: 'public', os: 'darwin' }, T0 - 3 * DAY);
  await checkIn(env, { id: ids[2], version: '2.0.0', channel: 'public', os: 'linux' }, T0 - 20 * DAY);
  await checkIn(env, { id: ids[3], version: '1.0.0', channel: 'public', os: 'win32' }, T0 - 40 * DAY);
  const ask = (auth?: string) => handle(new Request('https://checkin.example/v1/counts', { headers: auth ? { Authorization: auth } : {} }), env, T0);
  assert.equal((await ask()).status, 404);
  assert.equal((await ask('Bearer wrong')).status, 404);
  assert.equal((await handle(new Request('https://checkin.example/v1/counts', { headers: { Authorization: `Bearer ${TOKEN}` } }), { DB: env.DB }, T0)).status, 404, 'no token set: no counts');
  const res = await ask(`Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    day: dayOf(T0),
    unique: 4,
    active: { 1: 1, 7: 2, 30: 3 },
    byVersion: { '2.0.0': 2, '2.1.0': 1 },
    byChannel: { public: 2, dev: 1 },
    byOs: { win32: 1, darwin: 1, linux: 1 },
  });
});
