// Browsers become devices (Project-Ledung#482, step 1 of #477): a browser's sign-in is a devices row of kind 'browser',
// kept as a hash. A browser signed in before the update stays signed in through it; Settings lists browsers and phones,
// each renamed and removed there; Remove locks a browser out at once and closes its pages; its cookie is renewed daily
// like a computer device's, and a copy used after the renewal removes it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';
import { WAIT_MS } from './limits.ts';

const TOKEN = 'd'.repeat(64);
const PUBLIC = 'mac.example.test';
// The design's figures, not the code's constants: a day, a minute's grace (question 5 on #245, design #477 section 3).
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

let clock = 0;
let dir: string;
let webRoot: string;
const running: (() => Promise<void>)[] = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-browsers-'));
  webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
});
after(async () => {
  for (const stop of running) await stop();
  removeTemp(dir);
});

/** A Ledung on its own port over `file`, with a public name so phones can be paired too. */
async function serve(file: string) {
  const store = new Store(openDatabase(file));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ projects: [] }), store, () => {}));
  const port = await freePort();
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, publicName: PUBLIC, now: () => Date.now() + clock });
  await server.listen();
  const stop = async () => {
    await server.close();
    manager.detachAll();
    store.database.close();
  };
  running.push(stop);
  const origin = `http://127.0.0.1:${port}`;
  const request = (opts: { method?: string; path: string; cookie?: string; ua?: string; body?: unknown }) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
      if (opts.cookie) headers.cookie = opts.cookie;
      if (opts.ua) headers['user-agent'] = opts.ua;
      if (opts.method && opts.method !== 'GET') Object.assign(headers, { origin, 'content-type': 'application/json' });
      const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
    });
  /** Signs a browser in through the sign-in link, as the launcher opens it; returns its cookie. */
  const signIn = async (ua = FIREFOX_MAC) => {
    const res = await request({ path: `/login?token=${TOKEN}`, ua });
    assert.equal(res.status, 302);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };
  /** Opens the live connection as the browser with `cookie` does. */
  const page = (cookie: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin } });
    ws.once('message', () => resolve(ws));
    ws.once('error', reject);
  });
  const list = async (cookie: string) => JSON.parse((await request({ path: '/api/devices', cookie })).body) as {
    devices: { id: string; name: string; kind: string }[]; here: string | null;
  };
  return { server, store, stop, request, signIn, page, list, port };
}

const closed = (ws: WebSocket) => new Promise<number>((resolve) => {
  if (ws.readyState === ws.CLOSED) resolve(-1);
  ws.once('close', (code) => resolve(code));
});

test('a browser signed in before the update stays signed in through it: its #476 sign-in becomes a browser row with the same hash, and no sign-in hash stays in meta', async () => {
  clock = 0;
  const file = path.join(dir, 'upgrade.db');
  // A database as the release before left it (schema version 48), holding two #476 sign-ins and two entries that are
  // not sign-ins (a key that is no hash, a last use that is no number).
  const kept = crypto.randomBytes(32).toString('hex');
  const other = crypto.randomBytes(32).toString('hex');
  const usedAt = Date.now() - 2 * DAY;
  const before = openDatabase(file);
  before.exec('PRAGMA user_version = 48');
  const signIns = { [sha(kept)]: usedAt, [sha(other)]: usedAt - DAY, 'not-a-hash': usedAt, [sha('x')]: 'yesterday' };
  before.prepare("INSERT INTO meta (key, value) VALUES ('sign-ins', ?)").run(JSON.stringify(signIns));
  // The premise: the hash is in meta before the update.
  assert.ok(JSON.stringify(before.prepare('SELECT * FROM meta').all()).includes(sha(kept)));
  before.close();

  const { store, request, list } = await serve(file);
  assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 49);
  const rows = store.database.prepare('SELECT * FROM devices').all() as { cookie_hash: string; kind: string; name: string; revoked_at: number | null }[];
  assert.deepEqual(rows.map((r) => r.cookie_hash).sort(), [sha(kept), sha(other)].sort(), 'each sign-in is a row with the same hash; the two non-sign-ins are dropped');
  assert.ok(rows.every((r) => r.kind === 'browser' && r.revoked_at === null && r.name === 'Browser signed in before the update'));
  // No sign-in hash is left in meta: the entry is gone, and no other meta value holds a hash.
  assert.equal(store.getMeta('sign-ins'), null);
  const meta = JSON.stringify(store.database.prepare('SELECT * FROM meta').all());
  assert.ok(!meta.includes(sha(kept)) && !meta.includes(sha(other)), meta);

  // The same cookie still signs in: nobody is signed out. A made-up one does not.
  const first = await request({ path: '/api/state', cookie: `ledung_auth=${kept}`, ua: CHROME_WIN });
  assert.equal(first.status, 200);
  assert.equal((await request({ path: '/api/state', cookie: `ledung_auth=${'e'.repeat(64)}` })).status, 401);
  // Used for the first time, it is named after the browser (design #477 section 3); the other keeps its name until used.
  const names = (await list(`ledung_auth=${kept}`)).devices.map((d) => d.name).sort();
  assert.deepEqual(names, ['Browser signed in before the update', 'Chrome on Windows']);
});

test('Settings lists browsers and phones, marks this browser, and renames and removes each from this computer', async () => {
  clock = 0;
  const { server, request, signIn, list, port } = await serve(path.join(dir, 'list.db'));
  const firefox = await signIn(FIREFOX_MAC);
  const chrome = await signIn(CHROME_WIN);
  const phone = server.devices.pair(server.devices.newPairCode('phone').code, 'Pixel')!;
  const listed = await list(firefox);
  assert.deepEqual(listed.devices.map((d) => [d.name, d.kind]), [['Firefox on macOS', 'browser'], ['Chrome on Windows', 'browser'], ['Pixel', 'phone']]);
  const firefoxId = listed.devices[0]!.id;
  assert.equal(listed.here, firefoxId, 'the browser asking is marked');
  assert.equal((await list(chrome)).here, listed.devices[1]!.id);

  // Rename: a browser and a phone, from this computer's list.
  assert.equal((await request({ method: 'POST', path: `/api/devices/${firefoxId}/rename`, cookie: chrome, body: { name: '  Work laptop ' } })).status, 200);
  assert.equal((await request({ method: 'POST', path: `/api/devices/${phone.device.id}/rename`, cookie: chrome, body: { name: 'My phone' } })).status, 200);
  assert.deepEqual((await list(chrome)).devices.map((d) => d.name), ['Work laptop', 'Chrome on Windows', 'My phone']);
  assert.equal((await request({ method: 'POST', path: '/api/devices/nope/rename', cookie: chrome, body: { name: 'x' } })).status, 400);
  // Like every change: not without the page's own origin.
  const foreign = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: `/api/devices/${firefoxId}/rename`,
      headers: { host: `127.0.0.1:${port}`, cookie: chrome, origin: 'http://evil.example', 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end('{"name":"x"}');
  });
  assert.equal(foreign, 403);

  // Remove: the phone and a browser go from the list.
  assert.equal((await request({ method: 'POST', path: `/api/devices/${phone.device.id}/revoke`, cookie: chrome })).status, 200);
  assert.equal((await request({ method: 'POST', path: `/api/devices/${firefoxId}/revoke`, cookie: chrome })).status, 200);
  assert.deepEqual((await list(chrome)).devices.map((d) => d.name), ['Chrome on Windows']);
});

test('Remove on a browser locks it out at once and closes its open pages; another browser stays', async () => {
  clock = 0;
  const { request, signIn, page, list } = await serve(path.join(dir, 'remove.db'));
  const a = await signIn(FIREFOX_MAC);
  const b = await signIn(CHROME_WIN);
  const pageA = await page(a);
  const pageB = await page(b);
  const aId = (await list(a)).here!;
  const aClosed = closed(pageA);
  assert.equal((await request({ method: 'POST', path: `/api/devices/${aId}/revoke`, cookie: b })).status, 200);
  assert.equal(await Promise.race([aClosed, new Promise<number>((r) => setTimeout(() => r(0), WAIT_MS))]), 1008, 'its open page is closed');
  assert.equal((await request({ path: '/api/state', cookie: a })).status, 401, 'its cookie no longer signs in');
  assert.equal((await request({ path: '/', cookie: a })).status, 401);
  // The other browser and its page are untouched.
  assert.equal(pageB.readyState, WebSocket.OPEN);
  assert.equal((await request({ path: '/api/state', cookie: b })).status, 200);
  pageB.close();
});

test("a browser's cookie is renewed daily like a computer device's; a copy used after the renewal removes that browser", async () => {
  clock = 0;
  const { request, signIn, page, list } = await serve(path.join(dir, 'renew.db'));
  const first = await signIn();
  const other = await signIn(CHROME_WIN);
  assert.equal((await request({ path: '/api/state', cookie: first })).headers['set-cookie'], undefined, 'not renewed when fresh');
  clock += DAY - MIN;
  assert.equal((await request({ path: '/api/state', cookie: first })).headers['set-cookie'], undefined, 'not renewed before a day');
  clock += 2 * MIN;
  const renewedRes = await request({ path: '/api/state', cookie: first });
  assert.equal(renewedRes.status, 200);
  const set = String(renewedRes.headers['set-cookie']);
  assert.match(set, /^ledung_auth=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/, 'the same cookie, renewed in place');
  const second = set.split(';')[0]!;
  assert.notEqual(second, first);
  assert.equal((await request({ path: '/api/state', cookie: second })).status, 200, 'the new cookie signs in');
  assert.equal((await request({ path: '/api/state', cookie: second })).headers['set-cookie'], undefined, 'renewed once, not again');
  // The old one still works for the grace minute, for requests sent before the browser got the new one.
  assert.equal((await request({ path: '/api/state', cookie: first })).status, 200);
  const open = await page(second);
  const gone = closed(open);
  // After that, using the old one means a copy of it exists: the browser is removed, the copy and the real one alike.
  clock += 2 * MIN;
  assert.equal((await request({ path: '/api/state', cookie: first })).status, 401, 'the copy is refused');
  assert.equal((await request({ path: '/api/state', cookie: second })).status, 401, 'and the browser it was copied from is removed');
  assert.equal(await Promise.race([gone, new Promise<number>((r) => setTimeout(() => r(0), WAIT_MS))]), 1008, 'its open page is closed');
  assert.deepEqual((await list(other)).devices.map((d) => d.name), ['Chrome on Windows'], 'only the other browser is left');
});

test('the sign-in link opened in a browser already signed in keeps its row; a new browser gets one of its own', async () => {
  clock = 0;
  const { request, signIn, list } = await serve(path.join(dir, 'login.db'));
  const cookie = await signIn();
  // The launcher opens the link at every start, in the browser that is already signed in.
  const again = await request({ path: `/login?token=${TOKEN}`, cookie, ua: FIREFOX_MAC });
  assert.equal(again.status, 302);
  assert.equal(again.headers['set-cookie'], undefined, 'no new cookie');
  assert.equal((await list(cookie)).devices.length, 1, 'no second row');
  // Another browser, with no cookie: a row of its own.
  await signIn(CHROME_WIN);
  assert.equal((await list(cookie)).devices.length, 2);
});
