// TLS ends in Ledung on streams through the relay (issue #201, docs/steps/relay-e2e.md 3a and build plan step 3):
// a stream that starts a TLS handshake goes to a TLS server with the certificate in remoteDir(), and everything the
// guard holds for the public name holds there too. Certificates are made here (test/self-signed.ts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import WebSocket, { WebSocketServer } from 'ws';
import { parseConfig } from '../src/config.ts';
import { remoteDir } from '../src/platform/paths.ts';
import { decodeFrame, encodeFrame, FRAME, helloMessage, Streams } from '../src/remote/mux.ts';
import { Tunnel } from '../src/remote/tunnel.ts';
import { LedungServer, type ServerOptions } from '../src/server/server.ts';
import { certificateProblem } from '../src/server/tunnel-tls.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { RemoteStatus, ServerEvent } from '../src/shared/protocol.ts';
import { remoteLine } from '../web/src/remoteStatus.ts';
import { FakePasskey } from './fake-passkey.ts';
import { selfSigned } from './self-signed.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'c'.repeat(64);
const INSTALL_COOKIE = `ledung_auth=${TOKEN}`;
const PUBLIC = 'pc.tls.test';
const PUBLIC_ORIGIN = `https://${PUBLIC}`;
const T = { timeout: 15_000 };
const cleanup: (() => unknown)[] = [];
const first = selfSigned(PUBLIC);

after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** A Ledung with a public name whose remote folder holds `cert` (none: an empty folder). */
async function ledung(opts: { cert?: { key: string; cert: string }; required?: boolean; limits?: ServerOptions['limits'] } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-remote-'));
  if (opts.cert) writeCert(dir, opts.cert);
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, publicName: PUBLIC, tunnelTls: { dir, required: !!opts.required }, limits: opts.limits });
  // Before listen: if a regression makes it throw once the port is bound, the server is still closed and the file
  // ends instead of hanging (test review 201 round 2, minor 1).
  cleanup.push(() => server.close(), () => removeTemp(dir), () => removeTemp(webRoot));
  await server.listen();
  return { server, port, dir };
}

function writeCert(dir: string, pair: { key: string; cert: string }): void {
  fs.writeFileSync(path.join(dir, 'tls.key'), pair.key);
  fs.writeFileSync(path.join(dir, 'tls.crt'), pair.cert);
}

/** A TLS connection over `stream` (a tunnel stream, or a TCP connection to a relay), trusting `ca` only. */
const overTls = (stream: Duplex, ca = first.cert) => tls.connect({ socket: stream, servername: PUBLIC, ca, ALPNProtocols: ['http/1.1'] });

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string; fingerprint: string }

/** One HTTPS request as a phone sends it, over the connection `connect` makes. */
function request(connect: () => tls.TLSSocket, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = https.request({ method: opts.method ?? 'GET', path: opts.path, headers: { host: PUBLIC, ...opts.headers }, createConnection: connect }, (res) => {
      const fingerprint = (res.socket as tls.TLSSocket).getPeerCertificate().fingerprint256;
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body, fingerprint }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** The page's live connection over TLS; resolves with its hello's page key, or rejects with the refusal. */
function livePage(connect: () => tls.TLSSocket, headers: Record<string, string>): Promise<{ ws: WebSocket; key: string; events: ServerEvent[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${PUBLIC}/ws`, { createConnection: connect as never, headers });
    const events: ServerEvent[] = [];
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as ServerEvent & { pageKey?: string };
      events.push(event);
      if (event.type === 'hello') resolve({ ws, key: event.pageKey!, events });
    });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.once('error', reject);
    // Closed with terminate where the client's TLS runs over a stream in memory: there a clean close after the
    // server has sent something waits out ws's 30-second close timeout, Ledung or not. A TLS client over TCP, as a
    // phone is, closes at once (the relay test below).
    cleanup.push(() => ws.terminate());
  });
}

/** Everything that comes back on a raw stream before it closes or `ms` pass. */
function rawAnswer(stream: Duplex, bytes: string | Buffer, ms = 1500): Promise<{ got: string; closed: boolean }> {
  return new Promise((resolve) => {
    let got = '';
    const timer = setTimeout(() => resolve({ got, closed: false }), ms);
    stream.on('data', (c: Buffer) => (got += c.toString('latin1')));
    stream.on('error', () => {});
    stream.on('end', () => {
      clearTimeout(timer);
      resolve({ got, closed: true });
    });
    stream.on('close', () => {
      clearTimeout(timer);
      resolve({ got, closed: true });
    });
    // Nothing to send: only wait for the other side to close it.
    if (bytes.length) stream.write(bytes);
  });
}

async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const fingerprintOf = (pem: string) => new crypto.X509Certificate(pem).fingerprint256;
const errorOf = (a: Answer) => JSON.parse(a.body).error as string;

/**
 * A relay that passes connections through untouched, the way issue #200's will: its agent socket speaks the mux
 * (src/remote/mux.ts) to the real Tunnel, and each TCP connection becomes a stream carrying the raw bytes.
 */
async function passthroughRelay(): Promise<{ agentPort: number; phonePort: number; up: Buffer[]; down: Buffer[] }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/agent' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let streams: Streams | null = null;
  let agent: WebSocket | null = null;
  wss.on('connection', (ws) => {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        ws.send(helloMessage());
        streams = new Streams(ws);
        agent = ws;
        return;
      }
      const frame = decodeFrame(data);
      if (frame) streams?.receive(frame.kind, frame.id, frame.payload);
    });
  });
  let next = 1;
  // Every byte the relay carries, each way, for the test to look at.
  const up: Buffer[] = [];
  const down: Buffer[] = [];
  const phones = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (!streams || !agent) return void socket.destroy();
    socket.on('data', (c: Buffer) => up.push(c));
    const write = socket.write.bind(socket) as (chunk: Buffer) => boolean;
    socket.write = ((chunk: Buffer) => {
      down.push(Buffer.from(chunk));
      return write(chunk);
    }) as never;
    const id = next++;
    agent.send(encodeFrame(FRAME.open, id));
    streams.attach(id, socket);
  });
  await new Promise<void>((resolve) => phones.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(() => new Promise((resolve) => phones.close(resolve)), () => {
    for (const c of wss.clients) c.terminate();
    return new Promise((resolve) => wss.close(resolve));
  });
  return { agentPort: (wss.address() as net.AddressInfo).port, phonePort: (phones.address() as net.AddressInfo).port, up, down };
}

let main: Awaited<ReturnType<typeof ledung>>;
before(async () => {
  main = await ledung({ cert: first });
});
const viaTunnel = () => overTls(main.server.tunnelConnection());

test('a phone gets the page over TLS that ends in Ledung, with the certificate from the remote folder, and the headers as before', T, async () => {
  const answer = await request(viaTunnel, { path: '/', headers: { cookie: INSTALL_COOKIE } });
  assert.equal(answer.fingerprint, fingerprintOf(first.cert), 'the certificate in tls.crt');
  // Not paired: refused by the guard as the public name, over TLS as before.
  assert.equal(answer.status, 401);
  const csp = String(answer.headers['content-security-policy']);
  assert.match(csp, new RegExp(`connect-src [^;]*wss://${PUBLIC.replaceAll('.', '\\.')}`));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(answer.headers['x-frame-options'], 'DENY');
});

test('over TLS the request is the public name whatever Host it claims: the install token signs in nowhere (review finding 4a of PR #198)', T, async () => {
  // The TLSSocket, not the stream under it, is what the guard sees: it must be marked too, or these would be local.
  const local = { host: `127.0.0.1:${main.port}` };
  const login = await request(viaTunnel, { path: `/login?token=${TOKEN}`, headers: local });
  assert.equal(login.status, 403);
  assert.equal(login.headers['set-cookie'], undefined);
  assert.equal((await request(viaTunnel, { path: '/api/state', headers: { ...local, cookie: INSTALL_COOKIE } })).status, 401);
  assert.equal((await request(viaTunnel, { path: '/api/state', headers: { cookie: INSTALL_COOKIE } })).status, 401);
  await assert.rejects(livePage(viaTunnel, { ...local, cookie: INSTALL_COOKIE, origin: `http://127.0.0.1:${main.port}` }), /refused: 403/);
  // Locally the same token works as before.
  const plain = await new Promise<number>((resolve) => http.get({ agent: false, port: main.port, host: '127.0.0.1', path: `/login?token=${TOKEN}` }, (res) => resolve(res.statusCode!)));
  assert.equal(plain, 302);
});

test('over TLS a phone pairs, opens its page, and unlocks with its passkey; only https://<name> is its origin', T, async () => {
  // Pairing: a Secure device cookie, only with the public origin.
  const { code } = main.server.devices.newPairCode();
  const pair = (origin?: string) => request(viaTunnel, {
    method: 'POST', path: '/pair', body: new URLSearchParams({ code, name: 'Phone' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
  });
  assert.equal((await pair(`http://127.0.0.1:${main.port}`)).status, 403, "the local page's origin");
  assert.equal((await pair(`http://${PUBLIC}`)).status, 403, 'not https');
  const paired = await pair(PUBLIC_ORIGIN);
  assert.equal(paired.status, 303, paired.body);
  assert.match(String(paired.headers['set-cookie']), /^__Host-ledung_device=[0-9a-f]{64}; Secure; HttpOnly; SameSite=Strict; Path=\//);
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!;
  assert.equal((await request(viaTunnel, { path: '/api/state', headers: { cookie } })).status, 200);

  // The live connection, over TLS: only with the public origin.
  await assert.rejects(livePage(viaTunnel, { cookie, origin: `http://127.0.0.1:${main.port}` }), /refused: 403/);
  const page = await livePage(viaTunnel, { cookie, origin: PUBLIC_ORIGIN });
  const change = (p: string, body: string, headers: Record<string, string> = {}) =>
    request(viaTunnel, { method: 'POST', path: p, body, headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json', ...headers } });

  // The passkey, registered from the open page.
  const key = new FakePasskey(PUBLIC);
  const options = JSON.parse((await change('/api/passkey-options', '{}', { 'x-ledung-page': page.key })).body);
  assert.equal((await change('/api/passkey', JSON.stringify({ response: key.register(options) }), { 'x-ledung-page': page.key })).status, 200);
  // Locked until the passkey unlocks it; a change with another origin is refused before that.
  assert.match(errorOf(await change('/api/away', '{}')), /locked/);
  assert.equal((await change('/api/away', '{}', { origin: `http://127.0.0.1:${main.port}` })).status, 403);
  const sign = async (p: string, body: string) => key.header(JSON.parse((await change('/api/passkey-challenge', JSON.stringify({ method: 'POST', path: p, body }))).body));
  assert.match(errorOf(await change('/api/device-unlock', '{}', { 'x-ledung-page': page.key, 'x-ledung-passkey': await sign('/api/away', '{}') })), /something else/);
  const unlocked = await change('/api/device-unlock', '{}', { 'x-ledung-page': page.key, 'x-ledung-passkey': await sign('/api/device-unlock', '{}') });
  assert.equal(unlocked.status, 200, unlocked.body);
  assert.ok(JSON.parse(unlocked.body).unlockedUntil > Date.now());
  page.ws.terminate();
});

test('a request and a WebSocket through a relay and the tunnel over TLS; the relay carries only TLS records', T, async () => {
  const relay = await passthroughRelay();
  const t = new Tunnel({ relay: `ws://127.0.0.1:${relay.agentPort}`, name: 'pc', secret: 'x', publicName: PUBLIC, connect: () => main.server.tunnelConnection(), minDelayMs: 50, maxDelayMs: 100 });
  cleanup.push(() => t.stop());
  t.start();
  await until(() => t.status().state === 'connected');
  const phone = () => overTls(net.connect(relay.phonePort, '127.0.0.1'));
  const { code } = main.server.devices.newPairCode();
  const device = main.server.devices.pair(code, 'Through the relay')!;
  const cookie = `__Host-ledung_device=${device.cookie}`;
  const state = await request(phone, { path: '/api/state', headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(state.fingerprint, fingerprintOf(first.cert));
  const page = await livePage(phone, { cookie, origin: PUBLIC_ORIGIN });
  assert.equal(page.events[0]!.type, 'hello');
  // A clean close goes all the way through, as from a phone (a TCP connection under the TLS here).
  const closed = new Promise<number>((resolve) => page.ws.once('close', (code) => resolve(code)));
  page.ws.close(1000);
  assert.equal(await closed, 1000);
  // Both ways the relay carried TLS records and nothing else: not the cookie, not a request, not the page's words.
  for (const [way, chunks] of [['up', relay.up], ['down', relay.down]] as const) {
    const bytes = Buffer.concat(chunks);
    assert.ok(bytes.length > 0, way);
    assert.ok(tlsRecordTypes(bytes).includes(23), `${way}: application data, encrypted`);
    for (const text of [device.cookie, 'HTTP/1.1', '/api/state', 'hello', PUBLIC_ORIGIN]) assert.equal(bytes.includes(text), false, `${way}: ${text}`);
  }
});

/** The content types of the TLS records `bytes` is made of; throws if it is anything but whole records (RFC 8446 5.1). */
function tlsRecordTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  for (let at = 0; at < bytes.length;) {
    assert.ok(at + 5 <= bytes.length, 'a whole record header');
    const [type, major] = [bytes[at]!, bytes[at + 1]!];
    assert.ok([20, 21, 22, 23].includes(type) && major === 3, `a TLS record at ${at}`);
    types.push(type);
    at += 5 + bytes.readUInt16BE(at + 3);
    assert.ok(at <= bytes.length, 'a whole record');
  }
  return types;
}

test('without "required" a plain stream still reaches the plain server, as from a relay that ends TLS itself', T, async () => {
  const { got } = await rawAnswer(main.server.tunnelConnection(), `GET /api/state HTTP/1.1\r\nHost: ${PUBLIC}\r\nCookie: ${INSTALL_COOKIE}\r\nConnection: close\r\n\r\n`);
  assert.match(got, /^HTTP\/1\.1 401/, 'still the public name: the install cookie does not sign in');
});

test('with "required" a plain stream is closed and Settings says why; TLS works', T, async () => {
  const strict = await ledung({ cert: first, required: true });
  strict.server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  const { got, closed } = await rawAnswer(strict.server.tunnelConnection(), `GET / HTTP/1.1\r\nHost: ${PUBLIC}\r\n\r\n`);
  assert.equal(got, '', 'not one byte of an answer');
  assert.equal(closed, true);
  const page = await new Promise<RemoteStatus | null>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${strict.port}/ws`, { headers: { cookie: INSTALL_COOKIE, origin: `http://127.0.0.1:${strict.port}` } });
    ws.once('message', (data) => {
      resolve((JSON.parse(String(data)) as { remote: RemoteStatus | null }).remote);
      ws.close();
    });
  });
  assert.match(page?.tls ?? '', /plain connection .* closed/);
  assert.match(remoteLine(page).label, /connected/);
  assert.equal((await request(() => overTls(strict.server.tunnelConnection()), { path: '/api/state' })).status, 401, 'TLS is answered');
});

test('a missing certificate closes TLS streams, leaves the local page working, and Settings says so; one added later is used without a restart', T, async () => {
  const bare = await ledung();
  bare.server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  const hello = tls.connect({ socket: bare.server.tunnelConnection(), servername: PUBLIC, ca: first.cert });
  const failed = await new Promise<string>((resolve) => {
    hello.once('secureConnect', () => resolve('connected'));
    hello.once('error', (e) => resolve(e.message));
    hello.once('close', () => resolve('closed'));
  });
  assert.notEqual(failed, 'connected');
  const local = await new Promise<number>((resolve) => http.get({ agent: false, port: bare.port, host: '127.0.0.1', path: `/login?token=${TOKEN}` }, (res) => resolve(res.statusCode!)));
  assert.equal(local, 302, 'the local page works');
  const status = await new Promise<RemoteStatus | null>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bare.port}/ws`, { headers: { cookie: INSTALL_COOKIE, origin: `http://127.0.0.1:${bare.port}` } });
    ws.once('message', (data) => {
      resolve((JSON.parse(String(data)) as { remote: RemoteStatus | null }).remote);
      ws.close();
    });
  });
  assert.match(status?.tls ?? '', /No certificate/);
  // Written while running (step 4's ACME client will): the next connection uses it, and Settings is clear again.
  writeCert(bare.dir, first);
  const answer = await request(() => overTls(bare.server.tunnelConnection()), { path: '/api/state' });
  assert.equal(answer.status, 401);
  assert.equal(answer.fingerprint, fingerprintOf(first.cert));
});

test('a TLS stream that stops part-way through its request head is closed within the same limit as the plain path (review 201, finding 1)', T, async () => {
  // The limit shortened to 300 ms (60 s in Ledung), so the test is quick; both paths must keep it.
  const slow = await ledung({ cert: first, limits: { headersMs: 300, checkEveryMs: 50 } });
  const head = `GET /api/state HTTP/1.1\r\nHost: ${PUBLIC}\r\n`;
  const started = Date.now();
  const plain = await rawAnswer(slow.server.tunnelConnection(), head, 3000);
  assert.equal(plain.closed, true, 'the plain path closes it, as before');
  assert.match(plain.got, /^HTTP\/1\.1 408/);
  assert.ok(Date.now() - started < 2000);
  // The same over TLS: handshake done, then the head dribbles and stops.
  const socket = overTls(slow.server.tunnelConnection());
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve());
    socket.once('error', reject);
  });
  const since = Date.now();
  const over = await rawAnswer(socket, head, 3000);
  assert.equal(over.closed, true, 'the TLS path closes it too');
  assert.match(over.got, /^HTTP\/1\.1 408/);
  assert.ok(Date.now() - since < 2000);
});

test('a tunnel stream that goes silent before its first byte or in the middle of its TLS handshake is closed within its limit (review 201, round 2)', T, async () => {
  // The limits shortened to 300 ms (10 s each in Ledung), so the test is quick.
  const stalled = await ledung({ cert: first, limits: { peekMs: 300, handshakeMs: 300 } });
  const started = Date.now();
  const silent = await rawAnswer(stalled.server.tunnelConnection(), Buffer.alloc(0), 3000);
  assert.equal(silent.closed, true, 'nothing sent: closed');
  assert.ok(Date.now() - started < 2000);
  // The start of a TLS record and no more: past the peek, so only the handshake limit can close it.
  const since = Date.now();
  const handshake = await rawAnswer(stalled.server.tunnelConnection(), Buffer.from([0x16, 0x03, 0x01]), 3000);
  assert.equal(handshake.closed, true, 'a handshake that stops: closed');
  assert.ok(Date.now() - since < 2000);
  // A handshake that finishes in time is not cut by the limit.
  const answer = await request(() => overTls(stalled.server.tunnelConnection()), { path: '/api/state' });
  assert.equal(answer.status, 401);
});

test('a TLS connection left idle after a request is closed within the keep-alive limit (review 201, round 2)', T, async () => {
  const idle = await ledung({ cert: first, limits: { idleMs: 300 } });
  const socket = overTls(idle.server.tunnelConnection());
  // The request asks to keep the connection; the answer comes, then the connection waits for a next one.
  const answer = await request(() => socket, { path: '/api/state', headers: { connection: 'keep-alive' } });
  assert.equal(answer.status, 401);
  const since = Date.now();
  const closed = await new Promise<boolean>((resolve) => {
    if (socket.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), 3000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.equal(closed, true, 'closed while idle');
  assert.ok(Date.now() - since < 2000);
});

test('a certificate deleted under a running Ledung that served with it is no longer served; the local page works (test review 201, finding 1)', T, async () => {
  const gone = await ledung({ cert: first });
  gone.server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  const statusOf = () => (gone.server as unknown as { remote: RemoteStatus }).remote;
  const served = await request(() => overTls(gone.server.tunnelConnection()), { path: '/api/state' });
  assert.equal(served.fingerprint, fingerprintOf(first.cert), 'served with it first');
  // Deleted, as by hand or by a renewal that failed half-way: the next phone gets no handshake at all.
  fs.rmSync(path.join(gone.dir, 'tls.key'));
  fs.rmSync(path.join(gone.dir, 'tls.crt'));
  const hello = tls.connect({ socket: gone.server.tunnelConnection(), servername: PUBLIC, ca: first.cert });
  const outcome = await new Promise<string>((resolve) => {
    hello.once('secureConnect', () => resolve('connected'));
    hello.once('error', (e) => resolve(e.message));
    hello.once('close', () => resolve('closed'));
  });
  assert.notEqual(outcome, 'connected');
  assert.match(statusOf().tls ?? '', /No certificate/);
  const local = await new Promise<number>((resolve) => http.get({ agent: false, port: gone.port, host: '127.0.0.1', path: `/login?token=${TOKEN}` }, (res) => resolve(res.statusCode!)));
  assert.equal(local, 302, 'the local page works');
});

test('a certificate swapped while a connection is open: new connections get the new one, the open one goes on with the old', T, async () => {
  const swap = await ledung({ cert: first });
  const { code } = swap.server.devices.newPairCode();
  const cookie = `__Host-ledung_device=${swap.server.devices.pair(code, 'Phone')!.cookie}`;
  const before = () => overTls(swap.server.tunnelConnection(), first.cert);
  const open = await livePage(before, { cookie, origin: PUBLIC_ORIGIN });
  const second = selfSigned(PUBLIC);
  writeCert(swap.dir, second);
  // A phone that trusts only the old certificate can no longer connect...
  await assert.rejects(request(before, { path: '/api/state', headers: { cookie } }));
  // ...one that trusts the new one gets it, no restart.
  const after = await request(() => overTls(swap.server.tunnelConnection(), second.cert), { path: '/api/state', headers: { cookie } });
  assert.equal(after.status, 200);
  assert.equal(after.fingerprint, fingerprintOf(second.cert));
  // The open connection still has the old certificate and still gets events.
  const socket = (open.ws as unknown as { _socket: tls.TLSSocket })._socket;
  assert.equal(socket.getPeerCertificate().fingerprint256, fingerprintOf(first.cert));
  swap.server.broadcast({ type: 'remote', remote: { state: 'connected', publicName: PUBLIC, error: null } });
  await until(() => open.events.some((e) => e.type === 'remote'));
  open.ws.terminate();
});

test('a new certificate for another name, or with the wrong key, is not used: the last good one stays and Settings says why', T, async () => {
  const keep = await ledung({ cert: first });
  keep.server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  const statusOf = () => (keep.server as unknown as { remote: RemoteStatus }).remote;
  writeCert(keep.dir, selfSigned('other.tls.test'));
  const answer = await request(() => overTls(keep.server.tunnelConnection()), { path: '/api/state' });
  assert.equal(answer.fingerprint, fingerprintOf(first.cert));
  assert.match(statusOf().tls ?? '', /is not for pc\.tls\.test/);
  // Back to a good pair: Settings is clear again.
  writeCert(keep.dir, first);
  await request(() => overTls(keep.server.tunnelConnection()), { path: '/api/state' });
  assert.equal(statusOf().tls, undefined);
});

test('a key and certificate are checked against each other and the public name', () => {
  const other = selfSigned(PUBLIC);
  const files = (pair: { key: string; cert: string }) => ({ key: Buffer.from(pair.key), cert: Buffer.from(pair.cert) });
  assert.equal(certificateProblem(files(first), PUBLIC), null);
  assert.equal(certificateProblem(files(first), PUBLIC.toUpperCase()), null, 'names are case-insensitive');
  assert.match(certificateProblem({ key: Buffer.from(other.key), cert: Buffer.from(first.cert) }, PUBLIC)!, /not the key/);
  assert.match(certificateProblem(files(first), `x.${PUBLIC}`)!, /is not for/);
  assert.match(certificateProblem({ key: Buffer.from('nope'), cert: Buffer.from('nope') }, PUBLIC)!, /not a PEM/);
  // A matching pair TLS itself refuses: an RSA key under 2048 bits is too small for OpenSSL's default level.
  assert.match(certificateProblem(files(selfSigned(PUBLIC, { rsaBits: 1024 })), PUBLIC)!, /can't be used for TLS/);
  assert.equal(certificateProblem(files(selfSigned(PUBLIC, { rsaBits: 2048 })), PUBLIC), null);
});

test('a pair TLS refuses stops neither the start nor a running Ledung: the last good one stays (review 201, finding 2)', T, async () => {
  const weak = selfSigned(PUBLIC, { rsaBits: 1024 });
  // At the start, with only the refused pair: Ledung listens, the local page works, TLS streams are closed.
  const atStart = await ledung({ cert: weak });
  atStart.server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  const statusOf = (s: LedungServer) => (s as unknown as { remote: RemoteStatus }).remote;
  assert.match(statusOf(atStart.server).tls ?? '', /can't be used for TLS/);
  const local = await new Promise<number>((resolve) => http.get({ agent: false, port: atStart.port, host: '127.0.0.1', path: `/login?token=${TOKEN}` }, (res) => resolve(res.statusCode!)));
  assert.equal(local, 302);
  // While running: written over a good pair, the good one goes on being served.
  const running = await ledung({ cert: first });
  running.server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  writeCert(running.dir, weak);
  const answer = await request(() => overTls(running.server.tunnelConnection()), { path: '/api/state' });
  assert.equal(answer.fingerprint, fingerprintOf(first.cert));
  assert.match(statusOf(running.server).tls ?? '', /can't be used for TLS/);
});

test('the remote folder is in the data folder, private to this user', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-data-'));
  const was = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = data;
  try {
    const dir = remoteDir();
    assert.equal(dir, path.join(data, 'remote'));
    assert.ok(fs.statSync(dir).isDirectory());
    if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    if (was === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = was;
    removeTemp(data);
  }
});

test('the remote config takes "tls": "optional" (the default) or "required"', () => {
  const remote = { relay: 'wss://relay.example.org', name: 'pc', publicName: 'pc.example.org', secret: 'x'.repeat(32) };
  assert.equal(parseConfig({ remote }).remote?.tls, 'optional');
  assert.equal(parseConfig({ remote: { ...remote, tls: 'required' } }).remote?.tls, 'required');
  assert.throws(() => parseConfig({ remote: { ...remote, tls: 'off' } }), /tls/);
});
