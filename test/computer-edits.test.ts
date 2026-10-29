// Issue #240: a computer tab's name and colour changed from the page. Kept by this Ledung in its database, so a
// restart (a new server on the same database file) still shows them; changes need the sign-in and Ledung's origin.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import WebSocket from 'ws';
import { computerList, type ComputerInfo } from '../src/shared/computers.ts';
import type { ServerEvent } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'e'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-computers-'));
const webRoot = path.join(dir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
const dbFile = (name: string) => path.join(dir, `${name}.db`);
const MAC = { name: 'Mac', colour: 'green' as const, publicName: 'amber3fox9.l.example.test' };
const PC = { name: 'PC', colour: 'purple' as const, publicName: 'copper7meadow4.l.example.test' };
const COMPUTERS = computerList([PC, MAC], MAC.publicName, 'h');


/** A Ledung on a database file of its own; starting another on the same file after closing the first is a restart. */
async function start(file: string) {
  const port = await freePort();
  const db = openDatabase(dbFile(file));
  const store = new Store(db);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, computers: COMPUTERS });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    post: (body: unknown, headers: Record<string, string> = { cookie: COOKIE, origin }) =>
      fetch(`${origin}/api/computers`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    state: async () => ((await (await fetch(`${origin}/api/state`, { headers: { cookie: COOKIE } })).json()) as { computers: ComputerInfo[] }).computers,
    stop: async () => {
      await server.close();
      db.close();
    },
  };
}

after(() => removeTemp(dir));

async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('an open page is sent the new list as soon as a computer is renamed, so its tabs change at once', async () => {
  const l = await start('live');
  const ws = new WebSocket(`${l.origin.replace('http', 'ws')}/ws`, { headers: { cookie: COOKIE, origin: l.origin } });
  try {
    const events: ServerEvent[] = [];
    ws.on('message', (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await until(() => events.some((e) => e.type === 'hello'));
    assert.equal((await l.post({ id: PC.publicName, name: 'Office', colour: 'amber' })).status, 200);
    await until(() => events.some((e) => e.type === 'computers'));
    const sent = events.find((e) => e.type === 'computers');
    assert.deepEqual(sent?.type === 'computers' && sent.computers.map((c) => [c.name, c.colour, c.here]), [['Mac', 'green', true], ['Office', 'amber', false]]);
    // A refused change sends nothing.
    const count = events.length;
    assert.equal((await l.post({ id: PC.publicName, colour: 'red' })).status, 400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(events.length, count);
    assert.equal((await l.post({ id: PC.publicName, name: null, colour: null })).status, 200);
  } finally {
    ws.close();
    await l.stop();
  }
});

test("a computer's name and colour from the page need the sign-in and Ledung's origin, and only allowed values", async () => {
  const l = await start('checks');
  try {
    const rename = { id: PC.publicName, name: 'Office' };
    assert.equal((await l.post(rename, {})).status, 401);
    assert.equal((await l.post(rename, { cookie: COOKIE })).status, 403);
    assert.equal((await l.post(rename, { cookie: COOKIE, origin: 'https://evil.example' })).status, 403);
    // Only the computer colours: never blue or red (the lockdown frames), nor anything that could carry CSS.
    for (const colour of ['blue', 'red', 'red;}body{display:none']) assert.equal((await l.post({ id: PC.publicName, colour })).status, 400, colour);
    assert.equal((await l.post({ id: PC.publicName, name: 'x'.repeat(25) })).status, 400, 'longer than the config allows');
    assert.equal((await l.post({ id: 'nobody.example.test', name: 'X' })).status, 400);
    assert.deepEqual((await l.state()).map((c) => [c.name, c.colour]), [['Mac', 'green'], ['PC', 'purple']], 'nothing refused was kept');
  } finally {
    await l.stop();
  }
});

test('a name and colour changed in the page survive a restart, and an empty name goes back to the config\'s', async () => {
  const first = await start('restart');
  try {
    const ok = await first.post({ id: PC.publicName, name: '  Office  ' });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as ComputerInfo[]).map((c) => c.name), ['Mac', 'Office']);
    assert.equal((await first.post({ id: MAC.publicName, colour: 'teal' })).status, 200);
  } finally {
    await first.stop();
  }
  const second = await start('restart');
  try {
    const after = await second.state();
    assert.deepEqual(after.map((c) => [c.name, c.colour, c.here]), [['Mac', 'teal', true], ['Office', 'purple', false]]);
    assert.deepEqual(after[1]!.config, { name: 'PC', colour: 'purple' }, 'the config\'s name is still known, to go back to');
    assert.equal((await second.post({ id: PC.publicName, name: '' })).status, 200);
    assert.equal((await second.post({ id: MAC.publicName, colour: null })).status, 200);
    assert.deepEqual((await second.state()).map((c) => [c.name, c.colour]), [['Mac', 'green'], ['PC', 'purple']]);
  } finally {
    await second.stop();
  }
});
