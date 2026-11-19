// Updating Ledung with the desktop app open (#408): the page learns from hello that the made app runs an older
// Ledung's code, read from the app's stamp at each hello, so a page that connects after the app restarted is told it is
// up to date. A Ledung that is not the npm package says nothing about it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { desktopAppState, madePaths } from '../src/platform/desktop-app.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';
import { LinkedNodes } from './linked-nodes.ts';
import { HANG_MS } from './limits.ts';

const TOKEN = 'f'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-desktop-hello-'));
const webRoot = path.join(dir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
after(() => removeTemp(dir));

/** The hello a page gets when it connects. */
function hello(port: number): Promise<Record<string, unknown>> {
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: COOKIE, origin } });
    ws.once('message', (data) => {
      ws.close();
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.on('error', reject);
  });
}

test("hello tells the page the made app is out of date after an update, from the app's stamp at each hello", async () => {
  const data = path.join(dir, 'data');
  const paths = madePaths(data, 'linux');
  fs.mkdirSync(path.dirname(paths.exe), { recursive: true });
  fs.writeFileSync(paths.exe, 'electron');
  const stamp = (ledung: string) => fs.writeFileSync(paths.stamp, JSON.stringify({ electron: '45.4.1', platform: 'linux', arch: 'x64', ledung, config: { node: 'n', cli: 'c', env: {} } }));
  stamp('1.2');
  const db = openDatabase(path.join(dir, 'ledung.db'));
  const store = new Store(db);
  const port = await freePort();
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  // The core after Update Ledung: version 1.3, the app still made by 1.2.
  const server = new LedungServer({
    port, token: TOKEN, store, manager, webRoot,
    desktopApp: () => desktopAppState({ dataDir: data, ledungVersion: '1.3', platform: 'linux' }),
  });
  await server.listen();
  try {
    assert.deepEqual((await hello(port)).desktopApp, { stale: true, notice: null });
    // The app restarted: `ledung --after-app` wrote the new code and its stamp.
    stamp('1.3');
    assert.deepEqual((await hello(port)).desktopApp, { stale: false, notice: null });
  } finally {
    await server.close();
  }

  // Not the npm package: no such option, nothing in hello.
  const port2 = await freePort();
  const plain = new LedungServer({ port: port2, token: TOKEN, store, manager, webRoot });
  await plain.listen();
  try {
    const h = await hello(port2);
    assert.equal(h.type, 'hello', 'a hello came');
    assert.equal('desktopApp' in h, false);
  } finally {
    await plain.close();
    db.close();
  }
});

test('a page through the public name is not told about the desktop app; the same Ledung tells its own page (self-check round 2)', { timeout: HANG_MS }, async () => {
  const nodes = new LinkedNodes();
  try {
    const info = { stale: true, notice: 'The desktop app could not be made: /Users/someone/Library. Ledung opened in the browser instead.' };
    const pc = await nodes.ledung('pc.desktop-hello.test', undefined, undefined, undefined, {}, { desktopApp: () => info });
    const pcPage = await nodes.page(pc);
    assert.deepEqual((await pcPage('GET', 'state')).json.desktopApp, info, 'its own page is told');
    // A phone paired through the public name, as Settings → Phones pairs one.
    const code = new URL((await pcPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
    const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!;
    const pageKey = await nodes.publicPage(pc, cookie);
    const remote = await nodes.viaTunnel(pc.name, '/api/state', { method: 'GET', headers: { origin: `https://${pc.name}`, cookie, 'x-ledung-page': pageKey } });
    assert.equal(remote.status, 200, remote.body);
    const state = JSON.parse(remote.body) as Record<string, unknown>;
    assert.equal(state.throughPublicName, true, 'it came through the public name');
    assert.equal('desktopApp' in state, false);
  } finally {
    await nodes.close();
  }
});
