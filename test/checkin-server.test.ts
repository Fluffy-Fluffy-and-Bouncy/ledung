// The check-in's notice and Settings switch through the server (#220): reading it needs the sign-in, changing it also
// Ledung's own origin and its open page (as Publish usage, which also sends data out), and the choice is kept in this
// Ledung's database.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { CheckIn, NOTICE_KEY, SWITCH_KEY } from '../src/update/checkin.ts';
import type { CheckInView } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'e'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-checkin-server-'));
const webRoot = path.join(dir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
after(() => removeTemp(dir));

test('the check-in notice and switch: signed in to read, own origin and open page to change, kept in the database', async () => {
  const port = await freePort();
  const db = openDatabase(path.join(dir, 'ledung.db'));
  const store = new Store(db);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const checkIn = new CheckIn({ meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) }, version: '2.1.0', channel: () => 'public', os: 'linux', env: {}, packaged: true, send: async () => {} });
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, checkIn });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const call = (method: string, headers: Record<string, string>, body?: unknown) =>
    fetch(`${origin}/api/checkin`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const page = await new Promise<{ key: string; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: COOKIE, origin } });
    ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close() }));
    ws.on('error', reject);
  });
  const fromPage = { cookie: COOKIE, origin, 'x-ledung-page': page.key };
  try {
    assert.equal((await call('GET', {})).status, 401);
    const first = (await (await call('GET', { cookie: COOKIE })).json()) as CheckInView;
    assert.deepEqual([first.on, first.notice, first.sends], [true, true, false], 'on by default, the notice not yet answered');
    assert.deepEqual(Object.keys(first.payload).sort(), ['channel', 'id', 'os', 'version']);

    assert.equal((await call('POST', {}, { action: 'off' })).status, 401);
    assert.equal((await call('POST', { cookie: COOKIE }, { action: 'off' })).status, 403);
    assert.equal((await call('POST', { cookie: COOKIE, origin: 'https://evil.example' }, { action: 'off' })).status, 403);
    assert.equal((await call('POST', { cookie: COOKIE, origin }, { action: 'off' })).status, 403, 'not from the open page');
    assert.equal(store.getMeta(SWITCH_KEY), null, 'refused requests changed nothing');
    const bad = await call('POST', fromPage, { action: 'maybe' });
    assert.equal(bad.status, 400);

    const off = (await (await call('POST', fromPage, { action: 'off' })).json()) as CheckInView;
    assert.deepEqual([off.on, off.notice, off.sends], [false, false, false]);
    assert.equal(store.getMeta(SWITCH_KEY), 'off');
    assert.equal(store.getMeta(NOTICE_KEY), 'seen');
    const on = (await (await call('POST', fromPage, { action: 'on' })).json()) as CheckInView;
    assert.deepEqual([on.on, on.sends], [true, true]);
  } finally {
    page.close();
    await server.close();
    db.close();
  }
});
