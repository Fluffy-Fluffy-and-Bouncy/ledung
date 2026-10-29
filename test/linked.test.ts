// Linked computers (issue #245, docs/steps/manager-link.md step 1): linking two Ledungs once with a code and a
// callback, and the /link/ routes' locks. Each Ledung reaches the other the way the relay would hand it a stream:
// over its tunnel connection, with TLS ending in that Ledung, trusting only its test certificate.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LINK_CODE_MS, LINKS_FILE, parseLinkCode } from '../src/remote/linked.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { selfSigned } from './self-signed.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'd'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});


let clock = Date.now();
const now = () => clock;

interface Node { name: string; server: LedungServer; port: number; dir: string; cert: string; store: Store }
/** Every test Ledung by public name, so each can reach the others through their tunnels. */
const nodes = new Map<string, Node>();

/** TLS to a Ledung's public name over its tunnel, as the relay would carry it; a name nobody holds: closed at once. */
function connect(name: string): tls.TLSSocket {
  const node = nodes.get(name);
  if (!node) {
    // Swallows what is written: a PassThrough would echo the ClientHello back, and when that arrives before the
    // close, TLS fails with ERR_SSL_UNEXPECTED_MESSAGE thrown out of the stream (on Windows every time).
    const dead = new Duplex({ read() {}, write: (_chunk, _enc, done) => done() });
    setImmediate(() => dead.destroy());
    return tls.connect({ socket: dead, servername: name });
  }
  return tls.connect({ socket: node.server.tunnelConnection(), servername: name, ca: node.cert, ALPNProtocols: ['http/1.1'] });
}

async function ledung(name: string, required = true): Promise<Node> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-linked-'));
  const pair = selfSigned(name);
  fs.writeFileSync(path.join(dir, 'tls.key'), pair.key);
  fs.writeFileSync(path.join(dir, 'tls.crt'), pair.cert);
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, publicName: name, tunnelTls: { dir, required }, now, linkConnect: connect });
  cleanup.push(() => server.close(), () => removeTemp(dir), () => removeTemp(webRoot));
  await server.listen();
  const node = { name, server, port, dir, cert: pair.cert, store };
  nodes.set(name, node);
  return node;
}

/** The local page: its key from the live connection, then API calls with the sign-in cookie and Origin. */
async function page(node: Node) {
  const origin = `http://127.0.0.1:${node.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${node.port}/ws`, { headers: { cookie: COOKIE, origin } });
  cleanup.push(() => ws.terminate());
  const key = await new Promise<string>((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data)).pageKey));
    ws.once('error', reject);
  });
  return async (method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${origin}/api/${route}`, {
      method, headers: { cookie: COOKIE, origin, 'content-type': 'application/json', 'x-ledung-page': key }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

/** One HTTPS request to a Ledung through its tunnel, as another computer or a stranger would send it. */
function viaTunnel(name: string, route: string, opts: { method?: string; headers?: Record<string, string>; body?: string; chunked?: boolean } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? '{}';
    const req = https.request({
      method: opts.method ?? 'POST', path: route, createConnection: () => connect(name),
      // Chunked: no length up front, the body in 1 KiB pieces, as a caller that streams it would send.
      headers: { host: name, 'content-type': 'application/json', ...(opts.chunked ? {} : { 'content-length': Buffer.byteLength(body) }), ...opts.headers },
    }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    // A refusal before the whole body is sent may end the request early; the answer still counts.
    req.on('error', (e) => (opts.chunked ? undefined : reject(e)));
    if (opts.method === 'GET') return void req.end();
    if (!opts.chunked) return void req.end(body);
    for (let at = 0; at < body.length; at += 1024) req.write(body.slice(at, at + 1024));
    req.end();
  });
}

/** The key `from` sends to `to`, from its links.json. */
function keyFor(from: Node, to: Node): string {
  const saved = JSON.parse(fs.readFileSync(path.join(from.dir, LINKS_FILE), 'utf8')) as { links: { publicName: string; sendKey: string }[] };
  return saved.links.find((l) => l.publicName === to.name)!.sendKey;
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a link code is the public name and a secret', () => {
  assert.deepEqual(parseLinkCode('mac.l.example.com/abcdefghijklmnopqrstuvwx'), { publicName: 'mac.l.example.com', secret: 'abcdefghijklmnopqrstuvwx' });
  assert.deepEqual(parseLinkCode(' https://Mac.L.example.com/abcdefghijklmnopqrstuvwx '), { publicName: 'mac.l.example.com', secret: 'abcdefghijklmnopqrstuvwx' });
  for (const bad of ['mac.l.example.com', 'mac/abcdefghijklmnopqrstuvwx', 'mac.l.example.com/short', '*.example.com/abcdefghijklmnopqrstuvwx', 7, null]) {
    assert.equal(parseLinkCode(bad), null, String(bad));
  }
});

test('two Ledungs link with a code, each keeping only its own key and a hash of the other\'s; the code works once', { timeout: 20_000 }, async () => {
  const mac = await ledung('mac.link.test');
  const pc = await ledung('pc.link.test');
  const third = await ledung('third.link.test');
  const macPage = await page(mac);
  const pcPage = await page(pc);

  const made = await macPage('POST', 'links-code', {});
  assert.equal(made.status, 200);
  assert.match(made.json.code, /^mac\.link\.test\/[a-z0-9]{24}$/);
  assert.equal(made.json.expiresAt, clock + LINK_CODE_MS);

  const joined = await pcPage('POST', 'links-join', { code: made.json.code, name: 'Mac' });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.equal(joined.json.name, 'Mac');
  assert.equal(joined.json.publicName, 'mac.link.test');
  assert.equal(joined.json.sendKey, undefined, 'the page never sees a key');

  const onMac = (await macPage('GET', 'links')).json;
  assert.equal(onMac.problem, null);
  assert.deepEqual(onMac.links.map((l: any) => [l.name, l.publicName]), [['pc', 'pc.link.test']]);
  assert.deepEqual((await pcPage('GET', 'links')).json.links.map((l: any) => l.publicName), ['mac.link.test']);

  // Each side's file holds the key it sends and a hash of the one it accepts, private to this user.
  const macFile = path.join(mac.dir, LINKS_FILE);
  if (process.platform !== 'win32') assert.equal(fs.statSync(macFile).mode & 0o777, 0o600);
  const macKey = keyFor(mac, pc);
  const pcKey = keyFor(pc, mac);
  assert.notEqual(macKey, pcKey);
  assert.ok(!fs.readFileSync(macFile, 'utf8').includes(pcKey), 'the Mac keeps no copy of the key the PC sends it');

  // Each reaches the other with its key.
  assert.equal((await viaTunnel('pc.link.test', '/link/hello', { headers: { authorization: `Bearer ${macKey}` } })).status, 200);
  assert.equal((await viaTunnel('mac.link.test', '/link/hello', { headers: { authorization: `Bearer ${pcKey}` } })).status, 200);
  // Not with the other's, not with a made-up one.
  assert.equal((await viaTunnel('pc.link.test', '/link/hello', { headers: { authorization: `Bearer ${pcKey}` } })).status, 401);
  assert.equal((await viaTunnel('pc.link.test', '/link/hello', { headers: { authorization: `Bearer ${'A'.repeat(43)}` } })).status, 401);

  // The code is used up.
  const again = await (await page(third))('POST', 'links-join', { code: made.json.code, name: 'Mac' });
  assert.equal(again.status, 502);
  assert.match(again.json.error, /No link code is open/);
  assert.equal((await macPage('GET', 'links')).json.links.length, 1);
});

test('a code runs out after 10 minutes; wrong guesses do not close it', { timeout: 20_000 }, async () => {
  const one = await ledung('one.link.test');
  const two = await ledung('two.link.test');
  const onePage = await page(one);
  const twoPage = await page(two);

  const late = await onePage('POST', 'links-code', {});
  clock += LINK_CODE_MS;
  const tooLate = await twoPage('POST', 'links-join', { code: late.json.code });
  assert.equal(tooLate.status, 502);
  assert.match(tooLate.json.error, /No link code is open/);

  // A stranger who sees the public name can't close an open code with wrong guesses (review 250, Minor 2); one that
  // isn't in the code's alphabet is a wrong guess too, not a crash (Minor 1). The right code still works after them.
  const guess = (code: string) => viaTunnel('one.link.test', '/link/pair', { body: JSON.stringify({ code, publicName: 'two.link.test', key: 'B'.repeat(43) }) });
  const open = await onePage('POST', 'links-code', {});
  for (const wrong of ['é'.repeat(24), 'x', ...Array.from({ length: 30 }, (_, i) => String(i).padStart(24, 'x'))]) {
    const res = await guess(wrong);
    assert.equal(res.status, 403, `${wrong}: ${res.body}`);
    assert.match(JSON.parse(res.body).error, /not valid here/);
  }
  const ok = await twoPage('POST', 'links-join', { code: open.json.code });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await onePage('GET', 'links')).json.links.length, 1);
});

test('the callback must reach the name the code was used for: a name that does not answer is not linked', { timeout: 20_000 }, async () => {
  const home = await ledung('home.link.test');
  const homePage = await page(home);
  const made = await homePage('POST', 'links-code', {});
  // Someone with the code claims a name nobody answers for.
  const res = await viaTunnel('home.link.test', '/link/pair', { body: JSON.stringify({ code: parseLinkCode(made.json.code)!.secret, publicName: 'nobody.link.test', key: 'C'.repeat(43) }) });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /could not confirm nobody\.link\.test: nobody\.link\.test is offline/);
  assert.deepEqual((await homePage('GET', 'links')).json.links, []);

  // A name that answers, but isn't making this link, refuses the callback.
  const other = await ledung('other.link.test');
  const made2 = await homePage('POST', 'links-code', {});
  const res2 = await viaTunnel('home.link.test', '/link/pair', { body: JSON.stringify({ code: parseLinkCode(made2.json.code)!.secret, publicName: other.name, key: 'D'.repeat(43) }) });
  assert.equal(res2.status, 502);
  assert.match(JSON.parse(res2.body).error, /401/);
  assert.deepEqual((await homePage('GET', 'links')).json.links, []);
});

test('/link/ is only for another Ledung through the relay: never locally, never with a cookie; its key opens nothing else', { timeout: 20_000 }, async () => {
  const a = await ledung('a.link.test');
  const b = await ledung('b.link.test');
  const code = (await (await page(a))('POST', 'links-code', {})).json.code;
  assert.equal((await (await page(b))('POST', 'links-join', { code })).status, 200);
  const key = keyFor(b, a);

  // Locally, with the right key, the sign-in cookie, even naming the public name: not there.
  // (http.request, not fetch: fetch drops a Host header it is given.)
  for (const headers of [{ authorization: `Bearer ${key}` }, { authorization: `Bearer ${key}`, cookie: COOKIE, host: 'a.link.test' }]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: a.port, method: 'POST', path: '/link/hello', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 404, JSON.stringify(headers));
  }
  // Through the tunnel, a cookie is no key.
  assert.equal((await viaTunnel('a.link.test', '/link/hello', { headers: { cookie: COOKIE } })).status, 401);
  // Only POST.
  assert.equal((await viaTunnel('a.link.test', '/link/hello', { method: 'GET', headers: { authorization: `Bearer ${key}` } })).status, 404);
  // The link key is not a sign-in: the API and the live connection refuse it.
  const api = await viaTunnel('a.link.test', '/api/state', { method: 'GET', headers: { authorization: `Bearer ${key}` } });
  assert.equal(api.status, 401);
  const ws = new WebSocket('wss://a.link.test/ws', { createConnection: (() => connect('a.link.test')) as never, headers: { authorization: `Bearer ${key}`, origin: 'https://a.link.test' } });
  cleanup.push(() => ws.terminate());
  const refused = await new Promise<number>((resolve) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode!));
    ws.once('open', () => resolve(101));
    ws.once('error', () => resolve(0));
  });
  assert.equal(refused, 403);
  // Nor for the linking routes (that a paired device is refused there too: server-security.test.ts, #245 step 1).
  const remoteCode = await viaTunnel('a.link.test', '/api/links-code', { headers: { authorization: `Bearer ${key}`, origin: 'https://a.link.test' } });
  assert.equal(remoteCode.status, 401);
});

test('unlinking takes effect at once here and is passed on to the other computer', { timeout: 20_000 }, async () => {
  const x = await ledung('x.link.test');
  const y = await ledung('y.link.test');
  const xPage = await page(x);
  const yPage = await page(y);
  const code = (await xPage('POST', 'links-code', {})).json.code;
  assert.equal((await yPage('POST', 'links-join', { code, name: 'X' })).status, 200);
  const xKey = keyFor(x, y);
  const yKey = keyFor(y, x);

  const link = (await yPage('GET', 'links')).json.links[0];
  assert.equal((await yPage('POST', `links/${link.id}/remove`, {})).status, 200);
  assert.deepEqual((await yPage('GET', 'links')).json.links, []);
  // X's key no longer works on Y at once; Y's on X once X has been told.
  assert.equal((await viaTunnel('y.link.test', '/link/hello', { headers: { authorization: `Bearer ${xKey}` } })).status, 401);
  await until(async () => (await xPage('GET', 'links')).json.links.length === 0, 'X to drop the link');
  assert.equal((await viaTunnel('x.link.test', '/link/hello', { headers: { authorization: `Bearer ${yKey}` } })).status, 401);
  assert.equal((await yPage('POST', `links/${link.id}/remove`, {})).status, 400);
});

test('without end-to-end encryption through the relay there is no linking', { timeout: 20_000 }, async () => {
  const plain = await ledung('plain.link.test', false);
  const plainPage = await page(plain);
  const view = (await plainPage('GET', 'links')).json;
  assert.match(view.problem, /"tls": "required"/);
  const code = await plainPage('POST', 'links-code', {});
  assert.equal(code.status, 400);
  assert.equal((await viaTunnel('plain.link.test', '/link/pair', { body: '{}' })).status, 404);
});

test('making and using a link code needs the open page, as pairing a device does', { timeout: 20_000 }, async () => {
  const node = await ledung('pagekey.link.test');
  const origin = `http://127.0.0.1:${node.port}`;
  for (const route of ['links-code', 'links-join']) {
    const res = await fetch(`${origin}/api/${route}`, { method: 'POST', headers: { cookie: COOKIE, origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403, route);
  }
});

test('a linked computer\'s manager messages reach this one\'s managers through /link/message, named by the key, within the limits', { timeout: 20_000 }, async () => {
  const mac = await ledung('msgmac.link.test');
  const pc = await ledung('msgpc.link.test');
  const code = (await (await page(mac))('POST', 'links-code', {})).json.code;
  assert.equal((await (await page(pc))('POST', 'links-join', { code, name: 'Mac' })).status, 200);
  const key = keyFor(mac, pc);
  pc.store.createSession({ id: 'pc-manager-1', project: 'web', runner: 'local', title: 'Manager: web', parentId: null, permissionMode: 'default', role: 'manager' });
  pc.store.updateSession('pc-manager-1', { status: 'idle' });
  const auth = { authorization: `Bearer ${key}` };

  const listed = await viaTunnel(pc.name, '/link/managers', { headers: auth });
  assert.equal(listed.status, 200);
  assert.match(JSON.parse(listed.body).text, /"Manager: web" \(pc-manager-1\) for web: idle/);

  // The sender's computer is the key's, whatever the body says; the PC knows the Mac by the name it gave when linking.
  const sent = await viaTunnel(pc.name, '/link/message', { headers: auth, body: JSON.stringify({ fromId: 'mac-mgr', fromTitle: 'Manager: Ledung', fromProject: 'Ledung', toId: 'pc-manager-1', text: 'hello from the Mac', computer: 'Someone else' }) });
  assert.equal(sent.status, 200, sent.body);
  const [item] = pc.store.undeliveredInbox('pc-manager-1');
  assert.match(item!.text, /^Message from manager "Manager: Ledung" \(mac-mgr\) of Ledung on your computer "Mac":\n\nhello from the Mac/);
  assert.doesNotMatch(item!.text, /Someone else/);

  // A refusal comes back with its reason.
  const ended = await viaTunnel(pc.name, '/link/message', { headers: auth, body: JSON.stringify({ fromId: 'mac-mgr', toId: 'nobody-here', text: 'hi' }) });
  assert.equal(ended.status, 400);
  assert.match(JSON.parse(ended.body).error, /not a manager there/);
  // No key, no message.
  assert.equal((await viaTunnel(pc.name, '/link/message', { body: JSON.stringify({ fromId: 'x', toId: 'pc-manager-1', text: 'hi' }) })).status, 401);
  // Too large.
  const big = JSON.stringify({ fromId: 'x', toId: 'pc-manager-1', text: 'y'.repeat(20_000) });
  assert.equal((await viaTunnel(pc.name, '/link/message', { headers: auth, body: big })).status, 413);
  // The same without a length up front: counted as it is read (review 254, Important 1).
  assert.equal((await viaTunnel(pc.name, '/link/message', { headers: auth, body: big, chunked: true })).status, 413, 'chunked');
  const fits = JSON.stringify({ fromId: 'x', toId: 'pc-manager-1', text: 'y'.repeat(4000) });
  assert.equal((await viaTunnel(pc.name, '/link/message', { headers: auth, body: fits, chunked: true })).status, 200, 'chunked and within the limit');
  // Exactly 60 calls a minute per linked computer (manager-link.md, "Loops and floods"), counted from a fresh minute:
  // all 60 answered, the 61st refused within the minute, and answered again once it has passed.
  clock += 60_000;
  const statuses: number[] = [];
  for (let i = 0; i < 60; i++) statuses.push((await viaTunnel(pc.name, '/link/managers', { headers: auth })).status);
  assert.deepEqual(statuses, Array(60).fill(200), 'the first 60 in a minute');
  clock += 59_000;
  const over = await viaTunnel(pc.name, '/link/managers', { headers: auth });
  assert.equal(over.status, 429, 'the 61st, still within the minute');
  assert.match(JSON.parse(over.body).error, /More than 60 calls in a minute/);
  clock += 1_000;
  assert.equal((await viaTunnel(pc.name, '/link/managers', { headers: auth })).status, 200, 'a minute after the first');
});
