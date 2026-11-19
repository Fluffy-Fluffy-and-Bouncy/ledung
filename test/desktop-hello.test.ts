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
