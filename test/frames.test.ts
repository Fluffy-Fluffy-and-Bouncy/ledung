// The other computers' Ledungs in frames (issue #241, docs/steps/computer-tabs-in-page.md, steps 1 and 2): only the
// pages of this person's other computers, by exact origin, may frame this Ledung, and only through its public name; a
// device paired in such a frame gets a cookie the browser keeps for that frame; a passkey check made in a frame counts
// only from one of those pages. Everything else stays as before.
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
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { computerFrames, framingPages, otherComputers } from '../src/shared/computers.ts';
import { FakePasskey } from './fake-passkey.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';


const TOKEN = 'b'.repeat(64);
const MAC = 'mac.example.test';
const PC = 'pc.example.test';
// The same list on every computer (#232): this one is the Mac; the PC's Ledung runs on 4320 there.
const COMPUTERS = [{ name: 'Mac', publicName: MAC }, { name: 'PC', publicName: PC, port: 4320 }];
const PC_PAGES = [`https://${PC}`, 'http://127.0.0.1:4320', 'http://localhost:4320'];

/** A throwaway Ledung with a public name; `computers`: the config's list, or none (no frames, as before #241). */
async function start(computers: typeof COMPUTERS | []) {
  const port = await freePort();
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-frames-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port, projects: [] }), store, () => {}));
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, publicName: MAC, computerSettings: computers });
  await server.listen();
  const request = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  const pub = (opts: Parameters<typeof request>[0]) => request({ ...opts, headers: { host: MAC, ...opts.headers } });
  const pubChange = (p: string, body: string, cookie: string, extra: Record<string, string> = {}) =>
    pub({ method: 'POST', path: p, body, headers: { cookie, origin: `https://${MAC}`, 'content-type': 'application/json', ...extra } });
  const live = (headers: Record<string, string>) => new Promise<{ key: string; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close() }));
    ws.on('error', reject);
  });
  /** Pairs a device: a code from this computer's open page, the form on the public name; `fetchDest` as a browser says it. */
  const pair = async (fetchDest?: string) => {
    const page = await live({ cookie: `ledung_auth=${TOKEN}`, origin: `http://127.0.0.1:${port}` });
    const made = await request({ method: 'POST', path: '/api/devices-pair', body: '{}', headers: { cookie: `ledung_auth=${TOKEN}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ledung-page': page.key } });
    page.close();
    const code = new URL(JSON.parse(made.body).url).pathname.slice('/p/'.length);
    const done = await pub({
      method: 'POST', path: '/pair', body: new URLSearchParams({ code, name: 'Mac browser' }).toString(),
      headers: { origin: `https://${MAC}`, 'content-type': 'application/x-www-form-urlencoded', ...(fetchDest ? { 'sec-fetch-dest': fetchDest } : {}) },
    });
    assert.equal(done.status, 303, done.body);
    const setCookie = String(done.headers['set-cookie']);
    return { setCookie, cookie: /^(__Host-ledung_device=[0-9a-f]{64})/.exec(setCookie)![1]! };
  };
  /** A paired device with its passkey, registered as `framedIn` says (see FakePasskey), and its open page. */
  const withPasskey = async (framedIn?: string | null) => {
    const { cookie } = await pair(framedIn === undefined ? undefined : 'iframe');
    const page = await live({ host: MAC, cookie, origin: `https://${MAC}` });
    const key = new FakePasskey(MAC);
    const options = JSON.parse((await pubChange('/api/passkey-options', '{}', cookie, { 'x-ledung-page': page.key })).body);
    const registered = await pubChange('/api/passkey', JSON.stringify({ response: key.register(options, { framedIn }) }), cookie, { 'x-ledung-page': page.key });
    /** Unlocks the device with a passkey check signed as `signedIn` says (or with the client data `extra` gives). */
    const unlock = async (signedIn?: string | null, extra: { topOriginOnly?: string } = {}) => {
      const challenge = JSON.parse((await pubChange('/api/passkey-challenge', JSON.stringify({ method: 'POST', path: '/api/device-unlock', body: '{}' }), cookie)).body);
      return pubChange('/api/device-unlock', '{}', cookie, { 'x-ledung-page': page.key, 'x-ledung-passkey': key.header(challenge, { framedIn: signedIn, ...extra }) });
    };
    return { cookie, page, registered, unlock };
  };
  return { server, request, pub, pair, withPasskey, close: async () => {
    await server.close();
    removeTemp(webRoot);
  } };
}

let framed: Awaited<ReturnType<typeof start>>;
let plain: Awaited<ReturnType<typeof start>>;
before(async () => {
  framed = await start(COMPUTERS);
  plain = await start([]);
});
after(async () => {
  await framed.close();
  await plain.close();
});

const csp = (res: { headers: http.IncomingHttpHeaders }) => String(res.headers['content-security-policy']);
const directive = (res: { headers: http.IncomingHttpHeaders }, name: string) => csp(res).split('; ').find((d) => d.startsWith(`${name} `)) ?? null;

test('the pages that may frame this Ledung are exactly the other computers\' pages, from the config', () => {
  assert.deepEqual(otherComputers(COMPUTERS, MAC).map((c) => c.name), ['PC'], 'this computer is not among them');
  assert.deepEqual(framingPages(otherComputers(COMPUTERS, MAC)), PC_PAGES);
  // Without a port its Ledung's default; two computers on the same port list it once.
  assert.deepEqual(framingPages([{ name: 'A', publicName: 'A.example.test' }, { name: 'B', publicName: 'b.example.test' }]),
    ['https://a.example.test', 'http://127.0.0.1:4317', 'http://localhost:4317', 'https://b.example.test']);
  assert.deepEqual(computerFrames(COMPUTERS, MAC), { sources: [`https://${PC}`], ancestors: PC_PAGES });
  assert.deepEqual(computerFrames([], MAC), { sources: [], ancestors: [] });
  // The config takes a port and refuses one that isn't.
  assert.equal(parseConfig({ computers: [{ name: 'PC', publicName: PC, port: 4320 }] }).computers[0]!.port, 4320);
  for (const port of [0, 70000, 4320.5, '4320']) assert.throws(() => parseConfig({ computers: [{ name: 'PC', publicName: PC, port }] }), String(port));
});

test('through the public name only the other computers\' pages may frame this Ledung, by exact origin; locally nobody', async () => {
  for (const p of ['/', '/api/state', '/p/nope']) {
    const res = await framed.pub({ path: p });
    assert.equal(directive(res, 'frame-ancestors'), `frame-ancestors ${PC_PAGES.join(' ')}`, p);
    assert.equal(res.headers['x-frame-options'], undefined, `${p}: the old header can't list pages`);
    assert.doesNotMatch(csp(res), /\*/, `${p}: never a wildcard`);
  }
  // The computer's own screen is never framed, not even by the other computers.
  const local = await framed.request({ path: '/' });
  assert.equal(directive(local, 'frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(local.headers['x-frame-options'], 'DENY');
  // Both may show the PC's page in a frame, and nothing else: no http, no other name.
  for (const res of [local, await framed.pub({ path: '/' })]) assert.equal(directive(res, 'frame-src'), `frame-src 'self' https://${PC}`);
  // Without other computers, nothing changes from before #241.
  for (const res of [await plain.pub({ path: '/' }), await plain.request({ path: '/' })]) {
    assert.equal(directive(res, 'frame-ancestors'), "frame-ancestors 'none'");
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(directive(res, 'frame-src'), null);
  }
});

test('a device paired inside a frame gets a Partitioned cookie; anywhere else, or with no other computers, Strict as before', async () => {
  const top = await framed.pair();
  assert.match(top.setCookie, /; Secure; HttpOnly; SameSite=Strict; Path=\//);
  assert.doesNotMatch(top.setCookie, /Partitioned/);
  const inFrame = await framed.pair('iframe');
  assert.match(inFrame.setCookie, /^__Host-ledung_device=[0-9a-f]{64}; Secure; HttpOnly; SameSite=None; Partitioned; Path=\//);
  // Nobody may frame this one, so no cookie for a frame, whatever the request says.
  assert.match((await plain.pair('iframe')).setCookie, /SameSite=Strict/);
  // The framed device signs in like any other, and only through the public name.
  assert.equal((await framed.pub({ path: '/api/state', headers: { cookie: inFrame.cookie } })).status, 200);
  assert.equal((await framed.request({ path: '/api/state', headers: { cookie: inFrame.cookie } })).status, 401);
  // A browser with both (paired at the top and in a frame) sends both: either live one signs in, a revoked one doesn't.
  const both = `${top.cookie}; ${inFrame.cookie}`;
  assert.equal((await framed.pub({ path: '/api/state', headers: { cookie: both } })).status, 200);
  const topId = framed.server.devices.byCookie(top.cookie.split('=')[1]!)!.id;
  const frameId = framed.server.devices.byCookie(inFrame.cookie.split('=')[1]!)!.id;
  framed.server.revokeDevice(topId);
  assert.equal(JSON.parse((await framed.pub({ path: '/api/device', headers: { cookie: both } })).body).device.id, frameId);
  framed.server.revokeDevice(frameId);
  assert.equal((await framed.pub({ path: '/api/state', headers: { cookie: both } })).status, 401);
});

test("a passkey check made in a frame counts only from one of the other computers' pages", async () => {
  // In a frame on the PC's local page: registered and unlocked.
  const d = await framed.withPasskey('http://127.0.0.1:4320');
  assert.equal(d.registered.status, 200, d.registered.body);
  assert.equal((await d.unlock('http://127.0.0.1:4320')).status, 200);
  // Every page of the PC, and the top level as ever.
  for (const page of PC_PAGES) assert.equal((await d.unlock(page)).status, 200, page);
  assert.equal((await d.unlock()).status, 200, 'not framed');
  // Safari leaves out which page framed it: frame-ancestors already limited that to the PC's pages.
  assert.equal((await d.unlock(null)).status, 200, 'framed, page not said');
  // Any other page around the frame: refused, also a lookalike, a port the PC's Ledung isn't on, or plain http.
  for (const page of ['https://evil.example.test', `https://${PC}.evil.test`, 'http://127.0.0.1:4317', 'http://localhost:4321', `http://${PC}`]) {
    const res = await d.unlock(page);
    assert.equal(res.status, 403, page);
    assert.match(JSON.parse(res.body).error, /other computers' pages/, page);
  }
  // A page around it named without the frame (crossOrigin false): no browser sends that; refused, even a listed page.
  const odd = await d.unlock(undefined, { topOriginOnly: `https://${PC}` });
  assert.equal(odd.status, 403);
  assert.match(JSON.parse(odd.body).error, /could not be read/);
  // Registering in a frame on another page: refused (the library checks the page around it only for an assertion).
  const stranger = await framed.withPasskey('https://evil.example.test');
  assert.equal(stranger.registered.status, 403, stranger.registered.body);
  assert.equal(framed.server.devices.byCookie(stranger.cookie.split('=')[1]!)!.credentialId, null);
  d.page.close();
  stranger.page.close();
});

test('with no other computers, a passkey check made in any frame is refused, as nobody may frame this Ledung', async () => {
  const d = await plain.withPasskey();
  assert.equal(d.registered.status, 200);
  assert.equal((await d.unlock()).status, 200);
  for (const page of [`https://${PC}`, null]) {
    const res = await d.unlock(page);
    assert.equal(res.status, 403, String(page));
    assert.match(JSON.parse(res.body).error, /inside another page is not accepted/);
  }
  const framedIn = await plain.withPasskey(`https://${PC}`);
  assert.equal(framedIn.registered.status, 403);
  d.page.close();
  framedIn.page.close();
});

test('the not-paired page through the public name takes the pairing code or the whole link, so a frame can pair in place', async () => {
  const page = await framed.pub({ path: '/' });
  assert.equal(page.status, 401);
  assert.match(page.body, /<form method="get" action="\/pair">/);
  // Locally there is nothing to pair: the sign-in link is the way in.
  assert.doesNotMatch((await framed.request({ path: '/' })).body, /<form/);
  // A code made on this computer, typed in as the QR code shows it (capitals) or pasted as the whole link.
  const made = framed.server.devices.newPairCode();
  for (const typed of [made.code.toUpperCase(), ` https://${MAC}/p/${made.code.toUpperCase()} `]) {
    const form = await framed.pub({ path: `/pair?code=${encodeURIComponent(typed)}` });
    assert.equal(form.status, 200, typed);
    assert.match(form.body, /<form method="post" action="\/pair">/);
  }
  assert.equal((await framed.pub({ path: `/pair?code=${encodeURIComponent(`https://${MAC}/p/wrong`)}` })).status, 403);
});

test('with every computer on the default port, this computer\'s own local address is among the framers: that is the PC\'s local page too', async () => {
  // The usual setup: no "port" anywhere, so the Mac and the PC both run Ledung on 4317. The PC's local page and the
  // Mac's own local page are then the same origin, http://127.0.0.1:4317, and nothing can tell them apart by name.
  // Refusing it would refuse the PC's local page, the main case (#241). Allowing it adds nothing: on the Mac that
  // origin is the Mac's own Ledung page, signed in with the install token and so able to do more than its public page;
  // anything else on that port is a program on the Mac, outside the threat model (docs/steps/computer-tabs-in-page.md,
  // "What F still costs").
  const sameport = [{ name: 'Mac', publicName: MAC }, { name: 'PC', publicName: PC }];
  assert.deepEqual(computerFrames(sameport, MAC).ancestors, [`https://${PC}`, 'http://127.0.0.1:4317', 'http://localhost:4317']);
  // Never this computer's own public name, whatever the ports.
  assert.ok(!computerFrames(sameport, MAC).ancestors.includes(`https://${MAC}`));
  const onDefault = await start(sameport as typeof COMPUTERS);
  try {
    const res = await onDefault.pub({ path: '/' });
    assert.equal(directive(res, 'frame-ancestors'), `frame-ancestors https://${PC} http://127.0.0.1:4317 http://localhost:4317`);
    const d = await onDefault.withPasskey('http://127.0.0.1:4317');
    assert.equal(d.registered.status, 200, d.registered.body);
    for (const page of ['http://127.0.0.1:4317', 'http://localhost:4317', `https://${PC}`]) assert.equal((await d.unlock(page)).status, 200, page);
    for (const page of [`https://${MAC}`, 'http://127.0.0.1:4318']) assert.equal((await d.unlock(page)).status, 403, page);
    d.page.close();
  } finally {
    await onDefault.close();
  }
});
