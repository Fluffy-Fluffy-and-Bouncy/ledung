// Two kinds of device (issue #241; docs/steps/manager-link.md "Two kinds of device", Martin's decision 6 and question 5
// on #245): a phone works as before (read-only until a passkey unlocks it for 30 minutes); a computer, as which another
// computer's page shows this Ledung in a frame, logs on with its passkey and stays logged on until it logs out, is
// revoked or goes 14 days unused, through a restart too. Its cookie is renewed daily, and the old one used after that
// revokes it. A sensitive call is still signed each time by both: through the public name it is never the device's
// own computer's work (question 6). The kind is chosen on this computer when the code is made, never changed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { COMPUTER_IDLE_MS, COOKIE_RENEW_MS, OLD_COOKIE_GRACE_MS } from '../src/server/devices.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { FakePasskey } from './fake-passkey.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'c'.repeat(64);
const MAC = 'mac.example.test';
const PC = 'pc.example.test';
// Martin's figures, not the code's constants: 30 minutes (decision 8 of #160), 14 days and a day (question 5 on #245).
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let clock = 0;
let port = 0;
let server: LedungServer;
let stopServer: () => Promise<void>;
let dir: string;
let dbFile: string;
let webRoot: string;

async function startServer() {
  const store = new Store(openDatabase(dbFile));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port, projects: [] }), store, () => {}));
  server = new LedungServer({
    port, token: TOKEN, store, manager, webRoot, publicName: MAC, now: () => Date.now() + clock,
    computerSettings: [{ name: 'Mac', publicName: MAC }, { name: 'PC', publicName: PC }],
  });
  await server.listen();
  // Each start opens the database file afresh, as a restart does: closed again, or Windows can't remove it (#268).
  stopServer = async () => {
    await server.close();
    manager.detachAll();
    store.database.close();
  };
}

before(async () => {
  port = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-kinds-'));
  dbFile = path.join(dir, 'ledung.db');
  webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  await startServer();
});
after(async () => {
  await stopServer();
  removeTemp(dir);
});

function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
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
const pubChange = (p: string, body: string, cookie: string, extra: Record<string, string> = {}) =>
  pub({ method: 'POST', path: p, body, headers: { cookie, origin: `https://${MAC}`, 'content-type': 'application/json', ...extra } });
const live = (headers: Record<string, string>) => new Promise<{ key: string; close(): void; closed: Promise<number> }>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close(), closed }));
  ws.on('error', reject);
});
const local = { cookie: `ledung_auth=${TOKEN}`, origin: '' };
const errorOf = (res: { body: string }) => JSON.parse(res.body).error as string;
const cookieIn = (res: { headers: http.IncomingHttpHeaders }) => /__Host-ledung_device=([0-9a-f]{64})/.exec(String(res.headers['set-cookie'] ?? ''))?.[1] ?? null;

/** A pairing code made on this computer's open page for `kind` (sent as the page sends it). */
async function code(kind?: unknown): Promise<{ status: number; code: string; kind: string }> {
  const page = await live({ cookie: local.cookie, origin: `http://127.0.0.1:${port}` });
  const made = await request({ method: 'POST', path: '/api/devices-pair', body: JSON.stringify(kind === undefined ? {} : { kind }), headers: { cookie: local.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ledung-page': page.key } });
  page.close();
  const body = JSON.parse(made.body);
  return { status: made.status, code: made.status === 200 ? new URL(body.url).pathname.slice(3) : '', kind: body.kind };
}

/** A device of `kind` paired, its passkey set up, its page open (as a frame on the PC's page when `framed`). */
async function device(kind: 'phone' | 'computer', framed = false) {
  const made = await code(kind);
  assert.equal(made.kind, kind);
  const done = await pub({
    method: 'POST', path: '/pair', body: new URLSearchParams({ code: made.code, name: kind }).toString(),
    headers: { origin: `https://${MAC}`, 'content-type': 'application/x-www-form-urlencoded', ...(framed ? { 'sec-fetch-dest': 'iframe' } : {}) },
  });
  assert.equal(done.status, 303);
  const d = { cookie: `__Host-ledung_device=${cookieIn(done)}`, setCookie: String(done.headers['set-cookie']) };
  const page = await live({ host: MAC, cookie: d.cookie, origin: `https://${MAC}` });
  const key = new FakePasskey(MAC);
  const options = JSON.parse((await pubChange('/api/passkey-options', '{}', d.cookie, { 'x-ledung-page': page.key })).body);
  const opts = framed ? { framedIn: `https://${PC}` } : {};
  assert.equal((await pubChange('/api/passkey', JSON.stringify({ response: key.register(options, opts) }), d.cookie, { 'x-ledung-page': page.key })).status, 200);
  const state = { ...d, page, key };
  /** Keeps a renewed cookie, as the browser does. */
  const track = <R extends { headers: http.IncomingHttpHeaders }>(res: R): R => {
    const fresh = cookieIn(res);
    if (fresh) state.cookie = `__Host-ledung_device=${fresh}`;
    return res;
  };
  const sign = async (p: string, body: string) =>
    key.header(JSON.parse(track(await pubChange('/api/passkey-challenge', JSON.stringify({ method: 'POST', path: p, body }), state.cookie)).body), opts);
  return Object.assign(state, {
    sign,
    unlock: async () => {
      const header = await sign('/api/device-unlock', '{}');
      return track(await pubChange('/api/device-unlock', '{}', state.cookie, { 'x-ledung-page': state.page.key, 'x-ledung-passkey': header }));
    },
    /** An ordinary change: 403 "locked" while locked, else past the lock (the session doesn't exist: 4xx, not 403). */
    change: async () => track(await pubChange('/api/sessions/nope/pause', '{}', state.cookie)),
    me: async () => JSON.parse(track(await pub({ path: '/api/device', headers: { cookie: state.cookie } })).body),
  });
}
const locked = (res: { status: number; body: string }) => res.status === 403 && /locked/.test(errorOf(res));

test('the kind is chosen on this computer when the code is made: a phone unless it says computer, and never through the public name', async () => {
  assert.equal((await code()).kind, 'phone');
  assert.equal((await code('computer')).kind, 'computer');
  for (const odd of ['Computer', 'admin', 1, null]) assert.equal((await code(odd)).kind, 'phone', String(odd));
  // Through the public name no code is made at all, whatever kind is asked for.
  const phone = await device('phone');
  const asked = await pubChange('/api/devices-pair', JSON.stringify({ kind: 'computer' }), phone.cookie, { 'x-ledung-page': phone.page.key });
  assert.equal(asked.status, 403);
  // The kind shows in Settings, here and on the device; no route changes it.
  const computer = await device('computer');
  assert.equal((await computer.me()).device.kind, 'computer');
  assert.equal((await phone.me()).device.kind, 'phone');
  const listed = JSON.parse((await request({ path: '/api/devices', headers: { cookie: local.cookie } })).body).devices;
  assert.deepEqual(listed.filter((d: { name: string }) => ['phone', 'computer'].includes(d.name)).map((d: { kind: string }) => d.kind).sort(), ['computer', 'phone']);
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server', 'devices.ts'), 'utf8');
  const sets = [...source.matchAll(/UPDATE devices SET (.*?) WHERE/g)].map((m) => m[1]!);
  assert.ok(sets.length >= 5, 'the statements were read');
  assert.deepEqual(sets.filter((set) => /\bkind\b/.test(set)), [], 'no statement changes a kind');
  phone.page.close();
  computer.page.close();
});

test('a computer logs on with its passkey and stays logged on past 30 minutes, until it logs out; a phone locks after 30', async () => {
  clock = 0;
  const phone = await device('phone');
  const computer = await device('computer');
  assert.ok(locked(await phone.change()) && locked(await computer.change()), 'both start locked');
  assert.equal((await phone.unlock()).status, 200);
  assert.equal((await computer.unlock()).status, 200);
  assert.ok(!locked(await phone.change()) && !locked(await computer.change()), 'both unlocked');
  clock += 31 * MIN;
  assert.ok(locked(await phone.change()), 'the phone locks after 30 minutes');
  assert.ok(!locked(await computer.change()), 'the computer stays logged on');
  clock += 13 * DAY;
  assert.ok(!locked(await computer.change()), 'used now and then, it stays logged on');
  // Log out: open while logged on or not, and it logs the computer off at once.
  const out = await pubChange('/api/device-logout', '{}', computer.cookie);
  assert.equal(out.status, 200, out.body);
  assert.ok(locked(await computer.change()), 'logged off');
  assert.equal((await computer.me()).unlockedUntil, null);
  // It needs Origin like any change: a page of another site can't log it out.
  assert.equal((await pub({ method: 'POST', path: '/api/device-logout', body: '{}', headers: { cookie: computer.cookie, 'content-type': 'application/json' } })).status, 403);
  // Logging on takes the passkey again; the unlock alone, unsigned, does not.
  assert.match(errorOf(await pubChange('/api/device-unlock', '{}', computer.cookie, { 'x-ledung-page': computer.page.key })), /needs your passkey/);
  assert.equal((await computer.unlock()).status, 200);
  assert.ok(!locked(await computer.change()));
  phone.page.close();
  computer.page.close();
  clock = 0;
});

test('a logged-on computer still signs each sensitive call; the unlock covers only ordinary changes', async () => {
  const computer = await device('computer');
  assert.equal((await computer.unlock()).status, 200);
  // Away mode lets sensitive merges through, so it is signed on its own, as each sensitive decision is (relay.md
  // decision 9): logged on or not, a computer signs it, with one Touch ID or Windows Hello.
  const away = JSON.stringify({ kind: 'away' });
  assert.match(errorOf(await pubChange('/api/away', away, computer.cookie, { 'x-ledung-page': computer.page.key })), /needs your passkey/);
  const signed = await pubChange('/api/away', away, computer.cookie, { 'x-ledung-page': computer.page.key, 'x-ledung-passkey': await computer.sign('/api/away', away) });
  assert.doesNotMatch(signed.body, /needs your passkey|locked/, signed.body);
  await pub({ method: 'DELETE', path: '/api/away', headers: { cookie: computer.cookie, origin: `https://${MAC}` } });
  computer.page.close();
});

test('14 days unused logs a computer off; it logs on again with its passkey', async () => {
  clock = 0;
  const computer = await device('computer');
  assert.equal((await computer.unlock()).status, 200);
  clock += COMPUTER_IDLE_MS - 2 * MIN;
  assert.ok(!locked(await computer.change()), 'used just inside the 14 days');
  assert.equal(COMPUTER_IDLE_MS, 14 * DAY);
  clock += 14 * DAY + MIN;
  assert.ok(locked(await computer.change()), '14 days unused: logged off, the use that found it out does not count');
  assert.equal((await computer.me()).unlockedUntil, null);
  assert.equal((await computer.unlock()).status, 200, 'logs on again with its passkey');
  assert.ok(!locked(await computer.change()));
  computer.page.close();
  clock = 0;
});

test('a computer stays logged on through a restart; a phone locks', async () => {
  clock = 0;
  const phone = await device('phone');
  const computer = await device('computer');
  await phone.unlock();
  await computer.unlock();
  phone.page.close();
  computer.page.close();
  await stopServer();
  await startServer();
  assert.ok(locked(await phone.change()), 'the phone locks (its unlock lived in memory)');
  assert.ok(!locked(await computer.change()), 'the computer is still logged on');
});

test('a computer\'s cookie is renewed daily; the old one works a minute, then using it revokes the device', async () => {
  clock = 0;
  const computer = await device('computer');
  assert.equal((await computer.unlock()).status, 200);
  const first = computer.cookie;
  // Not yet a day: no new cookie.
  clock += COOKIE_RENEW_MS - MIN;
  assert.equal(cookieIn(await pub({ path: '/api/state', headers: { cookie: first } })), null);
  assert.equal(COOKIE_RENEW_MS, DAY);
  clock += 2 * MIN;
  const renewedRes = await pub({ path: '/api/state', headers: { cookie: first } });
  const renewed = cookieIn(renewedRes);
  assert.ok(renewed && `__Host-ledung_device=${renewed}` !== first, 'a new cookie after a day');
  assert.match(String(renewedRes.headers['set-cookie']), /; Secure; HttpOnly; SameSite=Strict; Path=\//);
  const second = `__Host-ledung_device=${renewed}`;
  // Requests the browser sent before it got the new one still count, for a minute.
  assert.equal((await pub({ path: '/api/state', headers: { cookie: first } })).status, 200);
  assert.equal(cookieIn(await pub({ path: '/api/state', headers: { cookie: first } })), null, 'renewed once, not again');
  assert.ok(!locked(await pubChange('/api/sessions/nope/pause', '{}', second)), 'still logged on with the new cookie');
  // After that, the old one in use again means two browsers had it: the device is revoked, its pages closed.
  clock += OLD_COOKIE_GRACE_MS + 1000;
  assert.equal(OLD_COOKIE_GRACE_MS, MIN);
  const page = await live({ host: MAC, cookie: second, origin: `https://${MAC}` });
  assert.equal((await pub({ path: '/api/state', headers: { cookie: first } })).status, 401);
  // Bounded, so a page left open fails here rather than hanging the run.
  assert.equal(await Promise.race([page.closed, new Promise((r) => setTimeout(() => r('still open'), 3000))]), 1008);
  assert.equal((await pub({ path: '/api/state', headers: { cookie: second } })).status, 401, 'the new one is out too');
  computer.page.close();
  clock = 0;
});

test('a phone keeps its cookie; a computer paired in a frame gets its renewed cookie Partitioned, as it was set', async () => {
  clock = 0;
  const phone = await device('phone');
  const framed = await device('computer', true);
  assert.match(framed.setCookie, /SameSite=None; Partitioned/);
  clock += 2 * DAY;
  assert.equal(cookieIn(await pub({ path: '/api/state', headers: { cookie: phone.cookie } })), null, 'a phone\'s cookie is not renewed');
  const res = await pub({ path: '/api/state', headers: { cookie: framed.cookie } });
  assert.match(String(res.headers['set-cookie']), /^__Host-ledung_device=[0-9a-f]{64}; Secure; HttpOnly; SameSite=None; Partitioned; Path=\//);
  phone.page.close();
  framed.page.close();
  clock = 0;
});

test('the log says when a framed cookie is renewed, and what a frame that shows as not paired sent: none, a removed device\'s, or an unknown one (#286)', async () => {
  clock = 0;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    const framed = await device('computer', true);
    const first = framed.cookie;
    clock += DAY + MIN;
    const renewed = cookieIn(await pub({ path: '/api/state', headers: { cookie: first } }));
    assert.ok(renewed);
    assert.ok(lines.some((l) => l === 'Devices: renewed the cookie of "computer" (paired in a frame).'), lines.join('\n'));
    const frameLoad = (cookie?: string) => pub({ path: '/', headers: { 'sec-fetch-dest': 'iframe', ...(cookie ? { cookie } : {}) } });
    const said = () => lines.filter((l) => l.startsWith('Devices: a frame on another computer\'s page'));
    // A paired frame's load says nothing.
    await frameLoad(`__Host-ledung_device=${renewed}`);
    assert.deepEqual(said(), []);
    await frameLoad();
    assert.deepEqual(said(), ['Devices: a frame on another computer\'s page opened this page with no device cookie, so it shows as not paired.']);
    // Each kind at most once every 10 minutes.
    await frameLoad();
    assert.equal(said().length, 1);
    // While that window is full, the other two still show (review 288, Minor 1). The replaced cookie after its
    // minute: the device is removed for it, and the line says so.
    clock += 2 * MIN;
    await frameLoad(first);
    assert.equal(said()[1], 'Devices: a frame on another computer\'s page opened this page with the cookie of a removed device, so it shows as not paired.');
    await frameLoad(`__Host-ledung_device=${'ab'.repeat(32)}`);
    assert.equal(said()[2], 'Devices: a frame on another computer\'s page opened this page with a device cookie this Ledung does not know, so it shows as not paired.');
    assert.ok(!lines.join('\n').includes(renewed!) && !lines.join('\n').includes(first.split('=')[1]!), 'no cookie value in the log');
    // After the window, the next one says how many were held back.
    clock += 10 * MIN;
    await frameLoad();
    assert.equal(said()[3], 'Devices: a frame on another computer\'s page opened this page with no device cookie, so it shows as not paired (and 1 more like it since the last such line).');
    // Not a frame: nothing.
    clock += 10 * MIN;
    await pub({ path: '/' });
    assert.equal(said().length, 4);
    framed.page.close();
  } finally {
    console.log = log;
    clock = 0;
  }
});

test('a device paired in a frame sets up its passkey on this Ledung\'s own page from a one-time link, as Safari needs; the code is the only proof', async () => {
  clock = 0;
  const made = await code('computer');
  const done = await pub({
    method: 'POST', path: '/pair', body: new URLSearchParams({ code: made.code, name: 'Mac Safari' }).toString(),
    headers: { origin: `https://${MAC}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-dest': 'iframe' },
  });
  const cookie = `__Host-ledung_device=${cookieIn(done)}`;
  const page = await live({ host: MAC, cookie, origin: `https://${MAC}` });
  const newLink = async () => pubChange('/api/passkey-enrol-link', '{}', cookie, { 'x-ledung-page': page.key });
  const codeOf = async () => (JSON.parse((await newLink()).body).url as string).split('#')[1]!;
  // The link: from the device's own open page only, the code in the fragment, five minutes.
  assert.equal((await pubChange('/api/passkey-enrol-link', '{}', cookie)).status, 403, 'no page key');
  const linkRes = await newLink();
  assert.equal(linkRes.status, 200, linkRes.body);
  const { url, expiresAt } = JSON.parse(linkRes.body);
  assert.match(url, new RegExp(`^https://${MAC.replaceAll('.', '\\.')}/enrol\\.html#[A-Za-z0-9_-]{32}$`));
  assert.ok(expiresAt <= Date.now() + 5 * MIN + 1000, 'five minutes');
  const first = url.split('#')[1];
  // The enrol calls: public name only, its own page's Origin only, a valid code only; no cookie needed.
  const enrol = (p: string, body: unknown, headers: Record<string, string> = { origin: `https://${MAC}` }) =>
    pub({ method: 'POST', path: p, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  assert.equal((await request({ method: 'POST', path: '/enrol/options', body: JSON.stringify({ code: first }), headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } })).status, 404, 'not locally');
  assert.equal((await enrol('/enrol/options', { code: first }, { origin: `https://${PC}` })).status, 403, 'not from another page');
  assert.equal((await enrol('/enrol/options', { code: first }, {})).status, 403, 'no Origin');
  assert.equal((await enrol('/enrol/options', { code: 'x'.repeat(32) })).status, 403, 'a wrong code');
  assert.equal((await pub({ path: '/enrol/options' })).status, 405);
  // A new link makes the one before it stop working.
  const second = await codeOf();
  assert.equal((await enrol('/enrol/options', { code: first })).status, 403, 'replaced');
  const options = JSON.parse((await enrol('/enrol/options', { code: second })).body);
  assert.equal(options.rp.id, MAC);
  // Made at the top level of this Ledung's own page; one made inside a frame on another site is refused, and the try
  // uses the code up.
  const key = new FakePasskey(MAC);
  assert.equal((await enrol('/enrol/finish', { code: second, response: key.register(options, { framedIn: 'https://evil.example.test' }) })).status, 403);
  assert.equal((await enrol('/enrol/options', { code: second })).status, 403, 'used up by the failed try');
  const fresh = await codeOf();
  const freshOptions = JSON.parse((await enrol('/enrol/options', { code: fresh })).body);
  const ok = await enrol('/enrol/finish', { code: fresh, response: key.register(freshOptions) });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(JSON.parse(ok.body).name, 'Mac Safari');
  assert.equal((await enrol('/enrol/finish', { code: fresh, response: key.register(freshOptions) })).status, 403, 'used once');
  // The frame's device has its passkey and logs on with it from inside the frame (Safari can use one there, and does
  // not name the page around it).
  assert.equal(JSON.parse((await pub({ path: '/api/device', headers: { cookie } })).body).device.passkey, true);
  const challenge = JSON.parse((await pubChange('/api/passkey-challenge', JSON.stringify({ method: 'POST', path: '/api/device-unlock', body: '{}' }), cookie)).body);
  assert.equal((await pubChange('/api/device-unlock', '{}', cookie, { 'x-ledung-page': page.key, 'x-ledung-passkey': key.header(challenge, { framedIn: null }) })).status, 200);
  assert.match(errorOf(await newLink()), /already has its passkey/);
  page.close();
});

test('an enrol link runs out after five minutes, and only works in the 10 minutes after pairing', async () => {
  clock = 0;
  const made = await code('phone');
  const done = await pub({ method: 'POST', path: '/pair', body: new URLSearchParams({ code: made.code, name: 'late' }).toString(), headers: { origin: `https://${MAC}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = `__Host-ledung_device=${cookieIn(done)}`;
  const page = await live({ host: MAC, cookie, origin: `https://${MAC}` });
  const link = async () => pubChange('/api/passkey-enrol-link', '{}', cookie, { 'x-ledung-page': page.key });
  const first = (JSON.parse((await link()).body).url as string).split('#')[1]!;
  clock += 5 * MIN + 1000;
  assert.equal((await pub({ method: 'POST', path: '/enrol/options', body: JSON.stringify({ code: first }), headers: { origin: `https://${MAC}`, 'content-type': 'application/json' } })).status, 403, 'run out');
  clock += 5 * MIN;
  assert.match(errorOf(await link()), /10 minutes after pairing/);
  page.close();
  clock = 0;
});

test('strict rotation: a renewal whose reply was lost costs a pairing again; the old cookie is never accepted after the minute (round 6 of #244)', async () => {
  // The manager's decision on review round 6 of #244 (Martin allowed it, question #217): no grace for a lost reply.
  clock = 0;
  const computer = await device('computer');
  assert.equal((await computer.unlock()).status, 200);
  const old = computer.cookie;
  clock += COOKIE_RENEW_MS + MIN;
  // The renewal happens; its reply (with the new cookie) is lost on the way.
  const lost = cookieIn(await pub({ path: '/api/state', headers: { cookie: old } }));
  assert.ok(lost, 'a new cookie was sent');
  // Within the minute the old cookie still counts, for requests the browser sent before the reply came.
  assert.equal((await pub({ path: '/api/state', headers: { cookie: old } })).status, 200);
  // After it, the browser that lost the reply is taken for a second holder: the device is removed, and the cookie it
  // never got is refused too. Pairing again is the way back.
  clock += OLD_COOKIE_GRACE_MS + 1000;
  assert.equal((await pub({ path: '/api/state', headers: { cookie: old } })).status, 401);
  assert.equal((await pub({ path: '/api/state', headers: { cookie: `__Host-ledung_device=${lost}` } })).status, 401, 'removed');
  computer.page.close();
  clock = 0;
});
