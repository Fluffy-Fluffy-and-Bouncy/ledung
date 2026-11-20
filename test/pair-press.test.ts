// Pressing Pair (issue #466): the first press of Pair inside another computer's frame seemed to do nothing and the
// second said the link was not valid. Pressing Pair now leads to a page that says plainly whether this browser is
// paired, by whether its cookie came back; a pairing whose cookie never came back is removed and the link may pair this
// browser in its place; a second press of a used link says it was used and whether that pairing worked.
import { after, before, test } from 'node:test';
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

const TOKEN = 'd'.repeat(64);
const MAC = 'mac.example.test';
const PC = 'pc.example.test';
// The issue's figure for how long a code lives: 10 minutes (devices.ts, "10 minutes, used once").
const MIN = 60_000;

let clock = 0;
let port = 0;
let server: LedungServer;
let store: Store;
let manager: SessionManager;
let dir: string;

before(async () => {
  port = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-pair-press-'));
  const webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  // The built page carries web/public as it is: the Pair button's script.
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'web', 'public', 'pair.js'), path.join(webRoot, 'pair.js'));
  store = new Store(openDatabase(path.join(dir, 'ledung.db')));
  manager = refuseRealSignInStores(new SessionManager(parseConfig({ port, projects: [] }), store, () => {}));
  // The PC's page may frame this one, as when Martin pairs the mini inside its tab on Tubal Cain.
  server = new LedungServer({
    port, token: TOKEN, store, manager, webRoot, publicName: MAC, now: () => Date.now() + clock,
    computerSettings: [{ name: 'Mac', publicName: MAC }, { name: 'PC', publicName: PC }],
  });
  await server.listen();
});
after(async () => {
  await server.close();
  manager.detachAll();
  store.database.close();
  removeTemp(dir);
});

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const pub = (opts: Parameters<typeof request>[0]) => request({ ...opts, headers: { host: MAC, ...opts.headers } });
const FRAME = { 'sec-fetch-dest': 'iframe' };
const cookieIn = (res: Res) => /__Host-ledung_device=([0-9a-f]{64})/.exec(String(res.headers['set-cookie'] ?? ''))?.[1] ?? null;
const cookieOf = (res: Res) => `__Host-ledung_device=${cookieIn(res)}`;
const liveDevices = () => server.devices.list().filter((d) => d.kind !== 'browser');

/** A pairing code for a computer, made on this computer's open page (as Settings makes it). */
async function newCode(): Promise<string> {
  const local = `ledung_auth=${TOKEN}`;
  const origin = `http://127.0.0.1:${port}`;
  const page = await new Promise<{ key: string; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: local, origin } });
    ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close() }));
    ws.on('error', reject);
  });
  const made = await request({ method: 'POST', path: '/api/devices-pair', body: JSON.stringify({ kind: 'computer' }), headers: { cookie: local, origin, 'content-type': 'application/json', 'x-ledung-page': page.key } });
  page.close();
  assert.equal(made.status, 200, made.body);
  return new URL(JSON.parse(made.body).url).pathname.slice(3);
}

/** Pressing Pair: the form's POST, from inside the PC's frame unless `framed` is false. */
const press = (code: string, name: string, headers: Record<string, string> = {}, framed = true) => pub({
  method: 'POST', path: '/pair', body: new URLSearchParams({ code, name }).toString(),
  headers: { origin: `https://${MAC}`, 'content-type': 'application/x-www-form-urlencoded', ...(framed ? FRAME : {}), ...headers },
});

/** Where the answer to a press sends the browser: the page after pairing, by its one-time value. */
function after303(res: Res): string {
  assert.equal(res.status, 303, res.body);
  const location = String(res.headers.location);
  assert.match(location, /^\/pair\?done=[0-9a-f]{32}$/);
  return location;
}

test('one press of Pair inside a frame pairs, and the page after it says plainly this browser is paired and goes on to Settings', async () => {
  clock = 0;
  const code = await newCode();
  const form = await pub({ path: `/p/${code}`, headers: FRAME });
  assert.equal(form.status, 200);
  assert.match(form.body, /<form method="post" action="\/pair">/);
  // The button greys and says "Pairing…" once pressed, from a script of the page's own origin (CSP: no inline script).
  assert.match(form.body, /<script src="\/pair\.js"><\/script>/);
  // Served through the public name to a browser not yet paired, as the form needs it.
  const script = await pub({ path: '/pair.js', headers: FRAME });
  assert.equal(script.status, 200);
  assert.match(String(script.headers['content-type']), /^text\/javascript/);
  assert.match(script.body, /Pairing…/);

  const pressed = await press(code, 'Mac in the PC tab');
  const done = after303(pressed);
  // Paired in a frame: the cookie the browser keeps for that frame (#241).
  assert.match(String(pressed.headers['set-cookie']), /SameSite=None; Partitioned/);
  const page = await pub({ path: done, headers: { ...FRAME, cookie: cookieOf(pressed) } });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /<h2>Paired<\/h2><p>This browser is paired with Ledung as <b>Mac in the PC tab<\/b>/);
  assert.match(page.body, /set up its passkey/);
  assert.match(page.body, /<a href="\/#\/settings">Go on to Settings<\/a>/);
  assert.match(page.body, /<meta http-equiv="refresh" content="3;url=\/#\/settings">/);
  // The paired state is real: the device is there and its cookie lets the frame in.
  assert.deepEqual(liveDevices().map((d) => d.name), ['Mac in the PC tab']);
  assert.equal((await pub({ path: '/api/state', headers: { ...FRAME, cookie: cookieOf(pressed) } })).status, 200);
  server.devices.revoke(liveDevices()[0]!.id);
});

test('the page after pairing, when the frame\'s browser dropped the cookie: says it is not paired and why, removes the device, and Pair again works', async () => {
  clock = 0;
  const code = await newCode();
  const first = await press(code, 'Dropped');
  const done = after303(first);
  assert.equal(liveDevices().length, 1, 'the press made a device');
  // The browser kept no cookie for the frame: the page after pairing comes without one.
  const page = await pub({ path: done, headers: FRAME });
  assert.equal(page.status, 403);
  assert.match(page.body, /<h2>Not paired<\/h2>/);
  assert.match(page.body, /Browsers can refuse cookies to a page shown inside another site's page/);
  assert.ok(page.body.includes(`<a href="/p/${code}" target="_blank" rel="noopener">pair in a tab of its own</a>`), page.body);
  assert.ok(page.body.includes(`<input type="hidden" name="code" value="${code}">`) && page.body.includes('>Pair again</button>'), page.body);
  assert.deepEqual(liveDevices(), [], 'no device row is left that no browser holds');
  assert.equal((await pub({ path: '/api/state', headers: { ...FRAME, cookie: cookieOf(first) } })).status, 401, 'its cookie lets nothing in');
  // The same page again: the value was for that answer, and the device is gone, so it still says not paired.
  assert.match((await pub({ path: done, headers: FRAME })).body, /Not paired/);

  // Pair again, and this time the cookie comes back.
  const again = await press(code, 'Dropped');
  const done2 = after303(again);
  assert.notEqual(done2, done);
  const page2 = await pub({ path: done2, headers: { ...FRAME, cookie: cookieOf(again) } });
  assert.equal(page2.status, 200, page2.body);
  assert.match(page2.body, /This browser is paired with Ledung as <b>Dropped<\/b>/);
  assert.equal(liveDevices().length, 1);
  server.devices.revoke(liveDevices()[0]!.id);
});

test('a second press before the first one\'s answer arrived pairs this browser in place of the first, and says the link was used', async () => {
  clock = 0;
  const code = await newCode();
  // The first press reached Ledung, but a second press cut its answer off: its cookie never reached the browser.
  const first = await press(code, 'Twice');
  after303(first);
  const second = await press(code, 'Twice');
  const done = after303(second);
  assert.notEqual(cookieIn(second), cookieIn(first));
  const page = await pub({ path: done, headers: { ...FRAME, cookie: cookieOf(second) } });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /This browser is paired with Ledung as <b>Twice<\/b>/);
  assert.match(page.body, /This link had already paired <b>Twice<\/b> just before, but that pairing never reached a browser, so this browser was paired in its place/);
  assert.equal(liveDevices().length, 1, 'one device, the second; the first is removed');
  assert.equal((await pub({ path: '/api/state', headers: { ...FRAME, cookie: cookieOf(first) } })).status, 401, 'the first one\'s cookie lets nothing in');
  assert.equal((await pub({ path: '/api/state', headers: { ...FRAME, cookie: cookieOf(second) } })).status, 200);
  server.devices.revoke(liveDevices()[0]!.id);
});

test('a second press after the pairing worked says the link was used, and whether it was this browser; nothing more is paired', async () => {
  clock = 0;
  const code = await newCode();
  const first = await press(code, 'Worked');
  await pub({ path: after303(first), headers: { ...FRAME, cookie: cookieOf(first) } });
  clock += 2 * MIN;
  // The same browser presses again: it holds that pairing.
  const same = await press(code, 'Worked', { cookie: cookieOf(first) });
  assert.equal(same.status, 200, same.body);
  assert.match(same.body, /This pairing link was already used, 2 minutes ago, to pair <b>Worked<\/b>\. That is this browser: it is paired\./);
  // Another browser: told the pairing worked elsewhere and this one is not paired, not just "not valid any more".
  const other = await press(code, 'Other');
  assert.equal(other.status, 403);
  assert.match(other.body, /already used, 2 minutes ago, to pair <b>Worked<\/b>\. That pairing worked, in the browser that used it; this one is not paired by it\./);
  assert.equal(cookieIn(other), null);
  // Opening the link again only looks: the same words, and no form.
  const look = await pub({ path: `/p/${code}`, headers: FRAME });
  assert.equal(look.status, 403);
  assert.match(look.body, /That pairing worked/);
  assert.doesNotMatch(look.body, /<form/);
  assert.deepEqual(liveDevices().map((d) => d.name), ['Worked']);
  server.devices.revoke(liveDevices()[0]!.id);
});

test('opening a used link whose pairing never arrived only looks, and offers to pair; a link preview pairs nothing', async () => {
  clock = 0;
  const code = await newCode();
  after303(await press(code, 'Lost', {}, false));
  const look = await pub({ path: `/P/${code.toUpperCase()}` });
  assert.equal(look.status, 403);
  assert.match(look.body, /already used, a moment ago, to pair <b>Lost<\/b>\. That pairing never reached a browser/);
  assert.ok(look.body.includes('>Pair this browser</button>'), look.body);
  assert.equal(liveDevices().length, 1, 'looking removed nothing and paired nothing');
  const formCode = /name="code" value="([^"]+)"/.exec(look.body)![1]!;
  const pressed = await press(formCode, 'Lost', {}, false);
  assert.match(String(pressed.headers['set-cookie']), /SameSite=Strict/, 'not framed: the usual cookie');
  const page = await pub({ path: after303(pressed), headers: { cookie: cookieOf(pressed) } });
  assert.equal(page.status, 200, page.body);
  assert.equal(liveDevices().length, 1);
  server.devices.revoke(liveDevices()[0]!.id);
});

test('a used link stops after its 10 minutes, and a pairing removed in Settings is not made again by it', async () => {
  clock = 0;
  const code = await newCode();
  after303(await press(code, 'Expires'));
  clock += 10 * MIN;
  const late = await press(code, 'Expires');
  assert.equal(late.status, 403);
  assert.match(late.body, /This pairing link is not valid any more/);
  server.devices.revoke(liveDevices()[0]!.id);

  clock = 0;
  const code2 = await newCode();
  after303(await press(code2, 'Removed'));
  // The person removes it in Settings before its browser came back.
  server.devices.revoke(liveDevices()[0]!.id);
  const again = await press(code2, 'Removed');
  assert.equal(again.status, 403);
  assert.equal(cookieIn(again), null);
  assert.deepEqual(liveDevices(), []);
});

test('the pairing pages put a typed device name in as text, never as markup', async () => {
  clock = 0;
  const code = await newCode();
  const pressed = await press(code, '<img src=x onerror=alert(1)>');
  const page = await pub({ path: after303(pressed), headers: { ...FRAME, cookie: cookieOf(pressed) } });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('&#60;img src=x onerror=alert(1)&#62;'), page.body);
  assert.ok(!page.body.includes('<img'), 'no tag from the name');
  const other = await press(code, 'x');
  assert.ok(other.body.includes('&#60;img') && !other.body.includes('<img'), other.body);
  server.devices.revoke(liveDevices()[0]!.id);
});

test('the page after pairing opens only with the value its answer carried', async () => {
  clock = 0;
  for (const value of ['', 'x', '0'.repeat(32), 'g'.repeat(32)]) {
    const res = await pub({ path: `/pair?done=${value}` });
    assert.equal(res.status, 403, value);
    assert.match(res.body, /This page is not valid any more/);
  }
  // Only through the public name, as /pair always was.
  assert.equal((await request({ path: '/pair?done=' + '0'.repeat(32) })).status, 404);
  // The positive branch: the real value opens it.
  const code = await newCode();
  const pressed = await press(code, 'Real');
  assert.equal((await pub({ path: after303(pressed), headers: { cookie: cookieOf(pressed) } })).status, 200);
  server.devices.revoke(liveDevices()[0]!.id);
});
