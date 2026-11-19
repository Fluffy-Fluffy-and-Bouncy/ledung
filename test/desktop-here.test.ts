// "Open in the Ledung app" (#409): a browser on the computer Ledung runs on, with the desktop app made there, is told
// so in hello and may ask the running Ledung to open the app. Only that computer's own screen: a page from another
// computer on the network, or through the public name, is told nothing and is refused the open.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
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
import { LinkedNodes } from './linked-nodes.ts';
import { HANG_MS } from './limits.ts';

const TOKEN = 'e'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-desktop-here-'));
const webRoot = path.join(dir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
const db = openDatabase(path.join(dir, 'ledung.db'));
const store = new Store(db);
after(() => {
  db.close();
  removeTemp(dir);
});

/** A page at `address` (this computer by default): its hello, and the live connection kept open so its key counts. */
function openPage(port: number, address = '127.0.0.1'): Promise<{ hello: Record<string, unknown>; close: () => void }> {
  const origin = `http://${address}:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}:${port}/ws`, { headers: { cookie: COOKIE, origin } });
    ws.once('message', (data) => resolve({ hello: JSON.parse(String(data)) as Record<string, unknown>, close: () => ws.close() }));
    ws.on('error', reject);
  });
}

function requestAt(address: string, port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: address, port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `${address}:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

function networkAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

const errorOf = (res: { body: string }) => (JSON.parse(res.body) as { error?: string }).error ?? '';

/** A Ledung with a made app or none (`made`), counting the opens and answering each with `answer`. */
async function ledung(o: { made: () => boolean; answer?: () => string | null; lan?: string | null }) {
  const port = await freePort();
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  let opens = 0;
  const server = new LedungServer({
    port, token: TOKEN, store, manager, webRoot,
    canOpenDesktopApp: o.made,
    openDesktopApp: async () => {
      opens++;
      return o.answer?.() ?? null;
    },
    ...(o.lan ? { lanBind: o.lan, lanNames: [o.lan] } : {}),
  });
  await server.listen();
  return { port, server, opens: () => opens };
}

test('a page on this computer is told the app is made here; with no app made it is not', async () => {
  let made = true;
  const l = await ledung({ made: () => made });
  try {
    const page = await openPage(l.port);
    page.close();
    assert.equal(page.hello.type, 'hello');
    assert.equal(page.hello.desktopAppHere, true, 'made: told');
    const state = await requestAt('127.0.0.1', l.port, { path: '/api/state', headers: { cookie: COOKIE } });
    assert.equal((JSON.parse(state.body) as Record<string, unknown>).desktopAppHere, true, 'GET state says the same');
    made = false;
    const again = await openPage(l.port);
    again.close();
    assert.equal(again.hello.type, 'hello', 'a hello came');
    assert.equal('desktopAppHere' in again.hello, false, 'none made: nothing said');
  } finally {
    await l.server.close();
  }
  // Not the npm package: no such option, nothing said.
  const port = await freePort();
  const plain = new LedungServer({ port, token: TOKEN, store, manager: refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {})), webRoot });
  await plain.listen();
  try {
    const page = await openPage(port);
    page.close();
    assert.equal(page.hello.type, 'hello');
    assert.equal('desktopAppHere' in page.hello, false);
  } finally {
    await plain.close();
  }
});

test('"Open in the Ledung app" opens the app for the open page on this computer, and says why when it could not', async () => {
  let answer: string | null = null;
  const l = await ledung({ made: () => true, answer: () => answer });
  const page = await openPage(l.port);
  try {
    const origin = `http://127.0.0.1:${l.port}`;
    const post = (headers: Record<string, string>) => requestAt('127.0.0.1', l.port, { method: 'POST', path: '/api/open-desktop-app', headers: { 'content-type': 'application/json', cookie: COOKIE, origin, ...headers }, body: '{}' });
    const noPage = await post({});
    assert.equal(noPage.status, 403, noPage.body);
    assert.match(errorOf(noPage), /open page/);
    assert.equal(l.opens(), 0, 'not opened without the open page');
    const withKey = { 'x-ledung-page': String(page.hello.pageKey) };
    const opened = await post(withKey);
    assert.equal(opened.status, 200, opened.body);
    assert.equal(l.opens(), 1);
    answer = 'Could not open the desktop app: open exited with code 1.';
    const failed = await post(withKey);
    assert.equal(failed.status, 409, failed.body);
    assert.equal(errorOf(failed), answer, 'the line saying why reaches the page');
    assert.equal(l.opens(), 2);
  } finally {
    page.close();
    await l.server.close();
  }
});

test('a page from another computer on the network is told nothing and may not open the app (#409)', async (t) => {
  const ip = networkAddress();
  if (!ip) return t.skip('this computer has no network address to come from');
  const l = await ledung({ made: () => true, lan: ip });
  try {
    // The same server from this computer: told.
    const local = await requestAt('127.0.0.1', l.port, { path: '/api/state', headers: { cookie: COOKIE } });
    assert.equal(local.status, 200, local.body);
    assert.equal((JSON.parse(local.body) as Record<string, unknown>).desktopAppHere, true, 'this computer: told');
    // From this computer's network address, as another computer on the network would come.
    const lan = await requestAt(ip, l.port, { path: '/api/state', headers: { cookie: COOKIE } });
    assert.equal(lan.status, 200, lan.body);
    const state = JSON.parse(lan.body) as Record<string, unknown>;
    assert.equal(state.type, 'hello', 'its hello came');
    assert.equal('desktopAppHere' in state, false, 'the network: not told');
    // A live page of its own on the network, so its page key is good and only "this computer" can refuse it.
    const lanPage = await openPage(l.port, ip);
    try {
      assert.equal('desktopAppHere' in lanPage.hello, false, 'its live hello: not told either');
      const res = await requestAt(ip, l.port, { method: 'POST', path: '/api/open-desktop-app', headers: { cookie: COOKIE, origin: `http://${ip}:${l.port}`, 'content-type': 'application/json', 'x-ledung-page': String(lanPage.hello.pageKey) }, body: '{}' });
      assert.equal(res.status, 403, res.body);
      assert.match(errorOf(res), /opened on the computer Ledung runs on/);
      assert.equal(l.opens(), 0);
    } finally {
      lanPage.close();
    }
  } finally {
    await l.server.close();
  }
});

test('through the public name the page is told nothing about the app; its own page is told (#409)', { timeout: HANG_MS }, async () => {
  const nodes = new LinkedNodes();
  let opens = 0;
  try {
    const pc = await nodes.ledung('pc.desktop-here.test', undefined, undefined, undefined, {}, {
      canOpenDesktopApp: () => true,
      openDesktopApp: async () => { opens++; return null; },
    });
    const pcPage = await nodes.page(pc);
    assert.equal((await pcPage('GET', 'state')).json.desktopAppHere, true, 'its own page is told');
    const code = new URL((await pcPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
    const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!;
    const pageKey = await nodes.publicPage(pc, cookie);
    const headers = { origin: `https://${pc.name}`, cookie, 'x-ledung-page': pageKey };
    const remote = await nodes.viaTunnel(pc.name, '/api/state', { method: 'GET', headers });
    assert.equal(remote.status, 200, remote.body);
    const state = JSON.parse(remote.body) as Record<string, unknown>;
    assert.equal(state.throughPublicName, true, 'it came through the public name');
    assert.equal('desktopAppHere' in state, false);
    // The open through the public name, unlocked and signing, is refused in test/server-security.test.ts.
    assert.equal(opens, 0);
  } finally {
    await nodes.close();
  }
});
