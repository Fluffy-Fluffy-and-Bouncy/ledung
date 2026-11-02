// Issue #461 through the server, as the page reaches it (test review of PR #13, finding 1): on an npm install the
// Settings buttons, Check for updates and Update Ledung, follow the channel chosen in About, and the choice is kept
// in this Ledung's database. npm itself is replaced by small node commands, as in update-channel.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Updater } from '../src/update/updater.ts';
import type { UpdateView } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'f'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-channel-server-'));
const webRoot = path.join(dir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
after(() => removeTemp(dir));

/** npm's dist-tags: a public v1 and a dev build v1.2, made up for the test. */
const TAGS = { latest: '1.0.0', dev: '1.2.0' };

test("an npm install's Check for updates and Update Ledung follow the channel chosen in Settings → About", async () => {
  const port = await freePort();
  const db = openDatabase(path.join(dir, 'ledung.db'));
  const store = new Store(db);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const installs: string[] = [];
  let restarts = 0;
  const updater = new Updater({
    appDir: path.join(dir, 'pkg'), dataDir: dir, configPath: path.join(dir, 'c.json'), npmVersion: '1.0.0',
    meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) },
    onRestart: () => { restarts++; },
    distTags: { cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(TAGS))})`] },
    npmInstall: (spec) => { installs.push(spec); return { cmd: process.execPath, args: ['-e', ''] }; },
  });
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, updater });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const api = async (method: string, route: string, body?: unknown): Promise<UpdateView> => {
    const res = await fetch(`${origin}/api/${route}`, { method, headers: { cookie: COOKIE, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.status, 200, `${method} ${route}: ${res.status}`);
    return (await res.json()) as UpdateView;
  };
  try {
    assert.equal((await api('GET', 'update')).channel, 'public');
    // Public: the check asks npm and offers latest, which is the installed version.
    const pub = await api('POST', 'update-check', {});
    assert.deepEqual([pub.npmCheck?.channel, pub.npmCheck?.offered, pub.npmCheck?.upToDate], ['public', '1.0.0', true]);

    // Choosing Dev is kept in the database, not only in the answer.
    assert.equal((await api('POST', 'update-channel', { channel: 'dev' })).channel, 'dev');
    assert.equal(store.getMeta('update-channel'), 'dev');

    const dev = await api('POST', 'update-check', {});
    assert.deepEqual([dev.npmCheck?.channel, dev.npmCheck?.offered, dev.npmCheck?.upToDate], ['dev', '1.2.0', false]);
    assert.equal(dev.check, null, 'no git check on an npm install');

    assert.equal((await api('POST', 'update', {})).updating, true);
    let v = await api('GET', 'update');
    for (const end = Date.now() + 30_000; v.updating && Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 50));
      v = await api('GET', 'update');
    }
    assert.equal(v.refused, null);
    assert.deepEqual(installs, ['ledung@1.2.0']);
    assert.equal(v.restarting, true);
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal(restarts, 1);
  } finally {
    await server.close();
    db.close();
  }
});
