// Ledung's tunnel to the relay (issue #160, docs/steps/relay.md step 2): requests through it reach this
// Ledung's own server; a relay that is down never holds up the start or the local page; it reconnects.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { agentUrl, backoffDelay, secureRelay, Tunnel } from '../src/remote/tunnel.ts';
import { hashSecret, parseRelayConfig, Relay } from '../relay/relay.ts';
import type { RemoteStatus, ServerEvent } from '../src/shared/protocol.ts';
import { remoteLine } from '../web/src/remoteStatus.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort, listenOk } from './free-port.ts';

const PORT = await freePort();
const TOKEN = 'b'.repeat(64);
const SECRET = 'a secret long enough for the relay';
const PUBLIC = 'pc.tunnel.test';
/** A broken link fails the test by name instead of hanging the file (test review 165, minor 3). */
const T = { timeout: 10_000 };
let server: LedungServer;
const cleanup: (() => unknown)[] = [];

before(async () => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: PORT }), store, () => {}));
  server = new LedungServer({ port: PORT, token: TOKEN, store, manager, webRoot });
  await server.listen();
});
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
  await server.close();
});

async function startRelay(port = 0) {
  if (port === 0) port = await freePort();
  const relay = new Relay(parseRelayConfig({
    port, bind: '127.0.0.1',
    agents: [{ name: 'pc', owner: 'someone', host: PUBLIC, secretSha256: hashSecret(SECRET) }],
  }), () => {});
  return { relay, port: await relay.listen() };
}

function tunnel(relayPort: number, secret = SECRET) {
  const statuses: RemoteStatus[] = [];
  const t = new Tunnel({ relay: `ws://127.0.0.1:${relayPort}`, name: 'pc', secret, publicName: PUBLIC, connect: () => server.tunnelConnection(), minDelayMs: 50, maxDelayMs: 100, onStatus: (s) => statuses.push(s) });
  cleanup.push(() => t.stop());
  return { t, statuses };
}

async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A raw GET with the given Host; resolves with the whole answer once the server closes. */
function get(port: number, host: string, url = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let got = '';
    socket.on('data', (c) => (got += c.toString('latin1')));
    socket.on('end', () => resolve(got));
    socket.on('error', reject);
  });
}

const localWorks = async () => assert.match(await get(PORT, `127.0.0.1:${PORT}`, `/login?token=${TOKEN}`), /^HTTP\/1\.1 302/);

test('a request through the tunnel reaches this Ledung, which refuses it when it has no public name', T, async () => {
  const { relay, port } = await startRelay();
  cleanup.push(() => relay.close());
  const { t } = tunnel(port);
  t.start();
  await until(() => t.status().state === 'connected');
  // Ledung's own refusal, not the relay's offline page: the request got through. This Ledung has no
  // public name, so nothing through the tunnel is allowed.
  const answer = await get(port, PUBLIC);
  assert.match(answer, /^HTTP\/1\.1 403/);
  assert.match(answer, /Unknown host/);
  assert.doesNotMatch(answer, /offline/);
});

/** Raw bytes to the relay; everything that comes back before the connection closes or `ms` pass. */
function raw(port: number, bytes: string, ms = 1500): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    let got = '';
    const done = () => resolve(got);
    socket.on('data', (c) => (got += c.toString('latin1')));
    socket.on('close', done);
    socket.on('error', () => {});
    setTimeout(() => { socket.destroy(); done(); }, ms).unref();
  });
}

test('a request through the public name cannot carry a second request that names this computer (review 165 finding 1)', T, async () => {
  const { relay, port } = await startRelay();
  cleanup.push(() => relay.close());
  const { t } = tunnel(port);
  t.start();
  await until(() => t.status().state === 'connected');
  // The second request would sign in if it reached Ledung as a local one: /login with the right token
  // and a local Host answers 302 with the sign-in cookie.
  const second = `GET /login?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n\r\n`;
  for (const extra of ['', 'Upgrade: x\r\n', 'Upgrade: websocket\r\nConnection: keep-alive\r\n', 'Connection: upgrade\r\n']) {
    const answer = await raw(port, `GET /first HTTP/1.1\r\nHost: ${PUBLIC}\r\n${extra}\r\n${second}`);
    // 403 from the Host check, or 400 when Node refuses bytes after a "Connection: close" request.
    assert.match(answer, /^HTTP\/1\.1 40[03]/, `first request refused (${JSON.stringify(extra)})`);
    assert.doesNotMatch(answer, /302|ledung_auth=/, `the second request never reaches Ledung (${JSON.stringify(extra)})`);
  }
});

test('a request through the tunnel claiming this computer as Host is still a phone on the public name (Martin, #160, question #219)', T, async () => {
  // A Ledung with a public name, as with "remote" in the config (the one above has none).
  const port2 = await freePort();
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: port2 }), store, () => {}));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const withName = new LedungServer({ port: port2, token: TOKEN, store, manager, webRoot, publicName: PUBLIC });
  await withName.listen();
  cleanup.push(() => withName.close());
  const { relay, port } = await startRelay();
  cleanup.push(() => relay.close());
  const t = new Tunnel({ relay: `ws://127.0.0.1:${port}`, name: 'pc', secret: SECRET, publicName: PUBLIC, connect: () => withName.tunnelConnection(), minDelayMs: 50, maxDelayMs: 100 });
  cleanup.push(() => t.stop());
  t.start();
  await until(() => t.status().state === 'connected');

  const local = `Host: 127.0.0.1:${port2}\r\n`;
  // Locally the install's sign-in link and its cookie work...
  assert.match(await raw(port2, `GET /login?token=${TOKEN} HTTP/1.1\r\n${local}Connection: close\r\n\r\n`), /^HTTP\/1\.1 302/);
  assert.match(await raw(port2, `GET /api/state HTTP/1.1\r\n${local}Cookie: ledung_auth=${TOKEN}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200/);
  // ...through the tunnel, the same requests with the same Host are the public name's: no sign-in link, no
  // install cookie. They reach the relay as the public name's (that is how it routes), and the relay passes
  // the bytes on; a broken-into relay could just as well rewrite the Host, so Ledung goes by the connection.
  const viaTunnel = async (request: string) => {
    const socket = withName.tunnelConnection();
    let got = '';
    socket.on('data', (c: Buffer) => (got += c.toString('latin1')));
    await new Promise<void>((resolve) => {
      socket.on('end', () => resolve());
      socket.on('close', () => resolve());
      socket.write(request);
    });
    return got;
  };
  const login = await viaTunnel(`GET /login?token=${TOKEN} HTTP/1.1\r\n${local}Connection: close\r\n\r\n`);
  assert.match(login, /^HTTP\/1\.1 403/);
  assert.match(login, /Sign-in links work only on the computer Ledung runs on/);
  assert.match(await viaTunnel(`GET /api/state HTTP/1.1\r\n${local}Cookie: ledung_auth=${TOKEN}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 401/);
  // And the whole way, phone → relay → tunnel → server: the public Host with the install's cookie is refused too.
  assert.match(await raw(port, `GET /api/state HTTP/1.1\r\nHost: ${PUBLIC}\r\nCookie: ledung_auth=${TOKEN}\r\n\r\n`), /^HTTP\/1\.1 401/);

  // A paired phone gets its page's live connection the whole way: the in-memory connection carries a WebSocket.
  const { code } = withName.devices.newPairCode();
  const paired = withName.devices.pair(code, 'Phone')!;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: PUBLIC, origin: `https://${PUBLIC}`, cookie: `__Host-ledung_device=${paired.cookie}` } });
  const hello = await new Promise<ServerEvent>((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as ServerEvent));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`live connection refused: ${res.statusCode}`)));
    ws.once('error', reject);
  });
  assert.equal(hello.type, 'hello');
  ws.close();
});

test('a relay that is down does not hold up the start, and the local page works',T, async () => {
  const deadPort = await freePort();
  const { t } = tunnel(deadPort);
  const started = Date.now();
  t.start();
  assert.ok(Date.now() - started < 50, 'start returns at once');
  await localWorks();
  await until(() => t.status().state === 'reconnecting');
  assert.ok(t.status().error);
});

test('when the relay goes away the tunnel says reconnecting, the local page works, and it comes back by itself', T, async () => {
  const first = await startRelay();
  const { t, statuses } = tunnel(first.port);
  t.start();
  await until(() => t.status().state === 'connected');
  await first.relay.close();
  await until(() => t.status().state === 'reconnecting');
  await localWorks();
  const again = await startRelay(first.port);
  cleanup.push(() => again.relay.close());
  await until(() => t.status().state === 'connected', 5000);
  assert.match(await get(first.port, PUBLIC), /Unknown host/, 'requests go through again');
  assert.deepEqual(statuses.map((s) => s.state).filter((s, i, all) => s !== all[i - 1]), ['connected', 'reconnecting', 'connected']);
});

test('the wait between attempts doubles from the minimum, stops at the maximum, and is spread by a quarter either way (test review 165 finding 2)', T, () => {
  // 1, 2, 4 … 60 s (docs/steps/relay.md step 2), with the middle of the spread.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a, 1000, 60_000, 0.5)), [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(backoffDelay(16, 1000, 60_000, 0.5), 60_000);
  assert.equal(backoffDelay(2, 1000, 60_000, 0), 3000);
  assert.equal(backoffDelay(2, 1000, 60_000, 1), 5000);
});

test('a tunnel waits longer after each failed attempt, and starts from the minimum again once connected (test review 165 finding 2)', T, async () => {
  const relayPort = await freePort();
  const delays: number[] = [];
  const t = new Tunnel({ relay: `ws://127.0.0.1:${relayPort}`, name: 'pc', secret: SECRET, publicName: PUBLIC, connect: () => server.tunnelConnection(), minDelayMs: 20, maxDelayMs: 80, random: () => 0.5, onRetry: (d) => delays.push(d) });
  cleanup.push(() => t.stop());
  t.start();
  await until(() => delays.length >= 4);
  assert.deepEqual(delays.slice(0, 4), [20, 40, 80, 80]);
  const { relay } = await startRelay(relayPort);
  await until(() => t.status().state === 'connected');
  const before = delays.length;
  await relay.close();
  await until(() => delays.length > before);
  assert.equal(delays[before], 20, 'back to the minimum after a connection that worked');
});

test('a secret the relay does not accept shows as reconnecting with the reason', T, async () => {
  const { relay, port } = await startRelay();
  cleanup.push(() => relay.close());
  const { t } = tunnel(port, 'not the right secret at all');
  t.start();
  await until(() => t.status().state === 'reconnecting');
  assert.match(t.status().error ?? '', /did not accept this name and secret/);
  assert.deepEqual(relay.connected(), []);
});

test('the page gets the tunnel state in hello and as it changes', T, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `ledung_auth=${TOKEN}`, origin: `http://127.0.0.1:${PORT}` } });
  const events: ServerEvent[] = [];
  ws.on('message', (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
  await until(() => events.length > 0);
  const hello = events[0]!;
  assert.equal(hello.type, 'hello');
  assert.equal(hello.type === 'hello' && hello.remote, null, 'none configured: off');
  server.setRemote({ state: 'connected', publicName: PUBLIC, error: null });
  await until(() => events.some((e) => e.type === 'remote'));
  assert.deepEqual(events.find((e) => e.type === 'remote'), { type: 'remote', remote: { state: 'connected', publicName: PUBLIC, error: null } });
  ws.close();
});

test('the remote config: a lower-case public name, Ledung names as decided', T, () => {
  const remote = { relay: 'wss://relay.example.org', name: 'pc', publicName: 'pc.example.org', secret: 'x'.repeat(32) };
  assert.equal(parseConfig({ remote }).remote?.name, 'pc');
  // The rule step 3's guards use (#164): one DNS name, written in any case.
  assert.equal(parseConfig({ remote: { ...remote, publicName: ' PC.Example.org ' } }).remote?.publicName, 'pc.example.org');
  for (const bad of ['pc', '*.example.org', 'pc.example.org:443', 'https://pc.example.org', '127.0.0.1']) {
    assert.throws(() => parseConfig({ remote: { ...remote, publicName: bad } }), /remote\.publicName/, bad);
  }
  // Ledung names as Martin decided them (#160, 2026-10-17 12:44): two words of 6–10 letters and two digits.
  assert.equal(parseConfig({ remote: { ...remote, name: 'copper7meadow4', publicName: 'copper7meadow4.example.org' } }).remote?.publicName, 'copper7meadow4.example.org');
  assert.equal(parseConfig({}).remote, undefined);
});

test('the secret only goes over wss, or plain ws to this computer: anything else is never dialled', T, async () => {
  assert.ok(secureRelay('wss://relay.example.org'));
  assert.ok(secureRelay('ws://127.0.0.1:8080'));
  assert.ok(secureRelay('ws://localhost:8080'));
  for (const bad of ['ws://relay.example.org', 'ws://192.168.1.5:8080', 'https://relay.example.org', 'relay.example.org']) assert.ok(!secureRelay(bad), bad);
  // A plain-ws relay elsewhere: the tunnel says why and never connects.
  // macOS has only 127.0.0.1 on its loopback, so 127.0.0.2 can't be bound there (EADDRNOTAVAIL). Then nothing
  // listens and nothing can be dialled; the state and error checks below still hold.
  const listener = net.createServer();
  let dialled = false;
  listener.on('connection', (s) => { dialled = true; s.destroy(); });
  const port = await listenOk(listener, '127.0.0.2').then((p) => { cleanup.push(() => new Promise((done) => listener.close(done))); return p; }, () => 9);
  const t = new Tunnel({ relay: `ws://127.0.0.2:${port}`, name: 'pc', secret: SECRET, publicName: PUBLIC, connect: () => server.tunnelConnection(), minDelayMs: 20, maxDelayMs: 40 });
  cleanup.push(() => t.stop());
  t.start();
  assert.equal(t.status().state, 'reconnecting');
  assert.match(t.status().error ?? '', /must be a wss:\/\/ address/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(dialled, false);
});

test('the client dials /agent unless the relay URL names a path', T, () => {
  assert.equal(agentUrl('wss://relay.example.org'), 'wss://relay.example.org/agent');
  assert.equal(agentUrl('wss://relay.example.org/'), 'wss://relay.example.org/agent');
  assert.equal(agentUrl('wss://example.org/ledung/agent'), 'wss://example.org/ledung/agent');
});

test('Settings words the tunnel state: off, connecting, connected, reconnecting with its reason', T, () => {
  assert.equal(remoteLine(null).label, 'Remote: off');
  assert.equal(remoteLine({ state: 'connecting', publicName: PUBLIC, error: null }).label, 'Remote: connecting…');
  assert.deepEqual(remoteLine({ state: 'connected', publicName: PUBLIC, error: null }), { label: 'Remote: connected', detail: `Through the relay as ${PUBLIC}.` });
  assert.deepEqual(remoteLine({ state: 'reconnecting', publicName: PUBLIC, error: 'The relay answered 502.' }), { label: 'Remote: reconnecting', detail: 'The relay answered 502.' });
});
