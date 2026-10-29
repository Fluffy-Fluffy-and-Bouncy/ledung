// The relay (issue #160, docs/steps/relay.md step 1): a Ledung dials out to it, a phone reaches that
// Ledung through it, byte for byte; wrong secrets, unknown names and floods are turned away.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { duplexPair, type Duplex } from 'node:stream';
import tls from 'node:tls';
import WebSocket, { WebSocketServer } from 'ws';
import { AGENT_NAME_HEADER, DEFAULT_PASSTHROUGH_FROM, forwardHead, hashSecret, parseRelayConfig, readProxyHeader, Relay, senderCheck, type RelayLimits } from '../relay/relay.ts';
import { decodeFrame, encodeFrame, FRAME, helloMessage, helloVersion, PROTOCOL_VERSION } from '../src/remote/mux.ts';
import { Tunnel } from '../src/remote/tunnel.ts';
import { selfSigned } from './self-signed.ts';
import { freePort, listenOk } from './free-port.ts';

const SECRET = 'correct horse battery staple 0123456789';
const HOST = 'pc.relay.test';
/** A broken link fails the test by name instead of hanging the file (test review 165, minor 3). */
const T = { timeout: 10_000 };
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function startRelay(limits: Partial<RelayLimits> = {}, extraAgents: { name: string; host: string; secret: string }[] = []) {
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(),
    bind: '127.0.0.1',
    agents: [{ name: 'pc', owner: 'someone', host: HOST, secretSha256: hashSecret(SECRET) },
      ...extraAgents.map((a) => ({ name: a.name, owner: 'other', host: a.host, secretSha256: hashSecret(a.secret) }))],
    limits,
  });
  const relay = new Relay(config, (line) => lines.push(line));
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  return { relay, port, lines };
}

/** A stand-in for Ledung: a plain TCP server that keeps every byte it gets and answers with `reply`. */
async function rawTarget(reply: (received: Buffer) => Buffer | null) {
  const received: Buffer[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let got = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      const answer = reply(got);
      if (answer) {
        received.push(got);
        socket.end(answer);
      }
    });
    socket.on('error', () => {});
  });
  await listenOk(server);
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as net.AddressInfo).port, received };
}

async function connectedTunnel(relayPort: number, target: number | (() => Duplex), name = 'pc', secret = SECRET, publicName = HOST): Promise<Tunnel> {
  const connect = typeof target === 'number' ? () => net.connect({ host: '127.0.0.1', port: target, allowHalfOpen: true }) : target;
  const tunnel = new Tunnel({ relay: `ws://127.0.0.1:${relayPort}`, name, secret, publicName, connect, minDelayMs: 50, maxDelayMs: 200 });
  cleanup.push(() => tunnel.stop());
  const connected = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (tunnel.status().state === 'connected') {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  tunnel.start();
  await connected;
  return tunnel;
}

/** Sends raw bytes to the relay as a phone (through its proxy) would, and gathers everything until the relay closes. */
function phone(port: number, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    const got: Buffer[] = [];
    socket.on('data', (c: Buffer) => got.push(c));
    socket.on('end', () => resolve(Buffer.concat(got)));
    socket.on('error', reject);
  });
}

/** Every byte value, several times over: anything rewritten or decoded as text on the way shows. */
function allBytes(times: number): Buffer {
  return Buffer.concat(Array.from({ length: times }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
}

function request(host: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`POST /api/x HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'), body]);
}

const headEnd = (b: Buffer) => b.indexOf('\r\n\r\n') + 4;

test('an HTTP request and its answer go through the tunnel byte for byte', T, async () => {
  const { port } = await startRelay();
  const body = allBytes(8);
  const answer = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, 'latin1'), Buffer.from(body).reverse()]);
  const target = await rawTarget((got) => (got.length >= headEnd(got) + body.length && headEnd(got) > 3 ? answer : null));
  await connectedTunnel(port, target.port);

  const sent = request(HOST, body);
  const back = await phone(port, sent);
  assert.deepEqual(back, answer, 'the phone gets exactly what Ledung sent');
  const got = target.received[0]!;
  assert.deepEqual(got.subarray(headEnd(got)), sent.subarray(headEnd(sent)), 'Ledung gets the body exactly as sent');
  // The head is the phone's, with one request per connection so a proxy can't reuse it for another host.
  assert.equal(got.subarray(0, headEnd(got)).toString('latin1'),
    `POST /api/x HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
});

test('a large answer comes through whole, in frames no larger than the limit', T, async () => {
  const { port } = await startRelay({ maxFrameBytes: 70 * 1024 });
  const big = allBytes(12 * 1024); // 3 MiB
  const answer = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${big.length}\r\n\r\n`, 'latin1'), big]);
  const target = await rawTarget((got) => (got.includes('\r\n\r\n') ? answer : null));
  await connectedTunnel(port, target.port);
  const back = await phone(port, Buffer.from(`GET /big HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`, 'latin1'));
  assert.equal(back.length, answer.length);
  assert.ok(back.equals(answer));
});

test('a WebSocket upgrade goes through, and its messages byte for byte both ways', T, async () => {
  const { port } = await startRelay();
  const http1 = http.createServer();
  const wss = new WebSocketServer({ server: http1 });
  let upgradeHost = '';
  wss.on('connection', (ws, req) => {
    upgradeHost = req.headers.host ?? '';
    ws.on('message', (data: Buffer, isBinary) => ws.send(Buffer.concat([Buffer.from([0xff]), data]), { binary: isBinary }));
  });
  await listenOk(http1);
  cleanup.push(() => new Promise((resolve) => { wss.close(); http1.close(resolve); }));
  await connectedTunnel(port, (http1.address() as net.AddressInfo).port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: HOST } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const message = allBytes(300);
  const echoed = await new Promise<Buffer>((resolve) => {
    ws.once('message', (data: Buffer) => resolve(data));
    ws.send(message);
  });
  assert.deepEqual(echoed, Buffer.concat([Buffer.from([0xff]), message]));
  assert.equal(upgradeHost, HOST);
  ws.close();
});

test('an unknown name and a known one with no Ledung connected get the same offline page', T, async () => {
  const { port } = await startRelay();
  const unknown = (await phone(port, Buffer.from('GET / HTTP/1.1\r\nHost: nobody.relay.test\r\n\r\n'))).toString();
  const offline = (await phone(port, Buffer.from(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`))).toString();
  for (const page of [unknown, offline]) {
    assert.match(page, /^HTTP\/1\.1 503/);
    assert.match(page, /This Ledung is offline/);
  }
  assert.equal(unknown.slice(unknown.indexOf('\r\n\r\n')), offline.slice(offline.indexOf('\r\n\r\n')), 'the same page, so names cannot be probed');
});

test('the relay answers its health check', T, async () => {
  const { port } = await startRelay();
  const reply = (await phone(port, Buffer.from('GET /health HTTP/1.1\r\nHost: relay.test\r\n\r\n'))).toString();
  assert.match(reply, /^HTTP\/1\.1 200/);
  assert.ok(reply.endsWith('ok'));
});

/**
 * An agent written by hand: signs in, sends `hello` (null: nothing) and, when it sent the right one,
 * resolves once the relay's hello is back.
 */
function rawAgent(port: number, name: string, secret: string, hello: string | null = helloMessage()): Promise<{ ws: WebSocket | null; status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { [AGENT_NAME_HEADER]: name, authorization: `Bearer ${secret}` } });
    ws.once('open', () => {
      if (hello !== helloMessage()) {
        if (hello !== null) ws.send(hello);
        resolve({ ws, status: 101 });
        return;
      }
      ws.once('message', (data: Buffer, isBinary) => {
        assert.equal(isBinary, false);
        assert.equal(helloVersion(data.toString()), PROTOCOL_VERSION, 'the relay answers with its hello');
        resolve({ ws, status: 101 });
      });
      ws.send(hello);
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ws: null, status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on('error', () => {});
  });
}

test('the link starts with a versioned hello each way; phones reach the Ledung only after it (review 165, plan step 1)', T, async () => {
  const { port, relay, lines } = await startRelay();
  // Signed in, no hello yet: not reachable.
  const quiet = await rawAgent(port, 'pc', SECRET, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(relay.connected(), []);
  assert.match((await phone(port, Buffer.from(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`))).toString(), /This Ledung is offline/);
  // Something else first: refused.
  const closed = new Promise<number>((resolve) => quiet.ws!.once('close', (code) => resolve(code)));
  quiet.ws!.send(encodeFrame(FRAME.data, 1, Buffer.from('x')));
  assert.equal(await closed, 1002);
  // A version the relay doesn't speak: refused, saying which it speaks.
  const future = await rawAgent(port, 'pc', SECRET, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION + 1 }));
  const why = await new Promise<{ code: number; reason: string }>((resolve) => future.ws!.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  assert.equal(why.code, 4001);
  assert.match(why.reason, new RegExp(`speaks ${PROTOCOL_VERSION}`));
  assert.ok(lines.filter((l) => l.includes('agent refused') && l.includes('"pc"')).length >= 2);
  // The right hello: answered with the relay's, and phones reach it.
  const good = await rawAgent(port, 'pc', SECRET);
  assert.deepEqual(relay.connected(), ['pc']);
  const opened = new Promise<number>((resolve) => good.ws!.once('message', (data: Buffer) => resolve(decodeFrame(data)!.kind)));
  const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`));
  socket.on('error', () => {});
  assert.equal(await opened, FRAME.open);
  socket.destroy();
  good.ws!.close();
});

test('a wrong secret or an unknown name is refused, and logged without the secret',T, async () => {
  const { port, relay, lines } = await startRelay();
  assert.equal((await rawAgent(port, 'pc', 'not the secret at all')).status, 401);
  assert.equal((await rawAgent(port, 'stranger', SECRET)).status, 401);
  assert.deepEqual(relay.connected(), []);
  assert.ok(lines.some((l) => l.includes('agent refused') && l.includes('wrong secret')));
  assert.ok(lines.some((l) => l.includes('agent refused') && l.includes('unknown name')));
  assert.ok(lines.every((l) => !l.includes('not the secret at all') && !l.includes(SECRET)));
});

test('one agent\'s secret does not sign in as another agent', T, async () => {
  const { port, relay } = await startRelay({}, [{ name: 'mac', host: 'mac.relay.test', secret: 'the macs own secret, long enough' }]);
  assert.equal((await rawAgent(port, 'mac', SECRET)).status, 401);
  const mac = await rawAgent(port, 'mac', 'the macs own secret, long enough');
  assert.equal(mac.status, 101);
  assert.deepEqual(relay.connected(), ['mac']);
  mac.ws!.close();
});

test('with two Ledungs connected, each public host reaches its own and only its own (test review 165 finding 1)', T, async () => {
  const MAC_SECRET = 'the macs own secret, long enough';
  const { port, lines } = await startRelay({}, [{ name: 'mac', host: 'mac.relay.test', secret: MAC_SECRET }]);
  const answer = (who: string) => Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${who.length}\r\n\r\n${who}`);
  const pcTarget = await rawTarget((got) => (got.includes('\r\n\r\n') ? answer('PC-LEDUNG') : null));
  const macTarget = await rawTarget((got) => (got.includes('\r\n\r\n') ? answer('MAC-LEDUNG') : null));
  await connectedTunnel(port, pcTarget.port);
  await connectedTunnel(port, macTarget.port, 'mac', MAC_SECRET, 'mac.relay.test');
  assert.equal(lines.filter((l) => l.includes('agent connected')).length, 2);

  const toMac = (await phone(port, Buffer.from('GET /m HTTP/1.1\r\nHost: mac.relay.test\r\n\r\n'))).toString();
  const toPc = (await phone(port, Buffer.from(`GET /p HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`))).toString();
  assert.ok(toMac.endsWith('MAC-LEDUNG'), toMac);
  assert.ok(toPc.endsWith('PC-LEDUNG'), toPc);
  // Each Ledung saw only the request for its own host.
  assert.deepEqual(macTarget.received.map((r) => r.toString('latin1').split('\r\n')[0]), ['GET /m HTTP/1.1']);
  assert.deepEqual(pcTarget.received.map((r) => r.toString('latin1').split('\r\n')[0]), ['GET /p HTTP/1.1']);
});

test('too many failed sign-ins from one address are turned away for the window, even with the right secret', T, async () => {
  const { port } = await startRelay({ failedAttemptsPerAddress: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await rawAgent(port, 'pc', `wrong ${i}`)).status, 401);
  assert.equal((await rawAgent(port, 'pc', SECRET)).status, 429);
});

test('a second connection with the same name replaces the first', T, async () => {
  const { port, relay } = await startRelay();
  const first = await rawAgent(port, 'pc', SECRET);
  const closed = new Promise<number>((resolve) => first.ws!.once('close', (code) => resolve(code)));
  const second = await rawAgent(port, 'pc', SECRET);
  assert.equal(await closed, 4000);
  assert.deepEqual(relay.connected(), ['pc']);
  // Phones now reach the second: it gets the stream.
  const opened = new Promise<number>((resolve) => second.ws!.once('message', (data: Buffer) => resolve(decodeFrame(data)!.kind)));
  const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`));
  socket.on('error', () => {});
  assert.equal(await opened, FRAME.open);
  socket.destroy();
  second.ws!.close();
});

test('phone connections beyond the per-agent limit are refused', T, async () => {
  const { port, lines } = await startRelay({ maxStreamsPerAgent: 1 });
  const agent = await rawAgent(port, 'pc', SECRET);
  const opened = new Promise<void>((resolve) => agent.ws!.once('message', () => resolve()));
  const held = net.connect(port, '127.0.0.1', () => held.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`));
  held.on('error', () => {});
  await opened;
  const second = (await phone(port, Buffer.from(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`))).toString();
  assert.match(second, /^HTTP\/1\.1 503/);
  assert.match(second, /Too many connections/);
  assert.ok(lines.some((l) => l.includes('stream refused')));
  held.destroy();
  agent.ws!.close();
});

test('an agent message over the frame limit ends its connection', T, async () => {
  const { port, relay } = await startRelay({ maxFrameBytes: 70 * 1024 });
  const agent = await rawAgent(port, 'pc', SECRET);
  const closed = new Promise<number>((resolve) => agent.ws!.once('close', (code) => resolve(code)));
  agent.ws!.send(encodeFrame(FRAME.data, 1, Buffer.alloc(80 * 1024)));
  assert.equal(await closed, 1009);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(relay.connected(), []);
});

test('an agent may not open streams of its own', T, async () => {
  const { port } = await startRelay();
  const agent = await rawAgent(port, 'pc', SECRET);
  const closed = new Promise<number>((resolve) => agent.ws!.once('close', (code) => resolve(code)));
  agent.ws!.send(encodeFrame(FRAME.open, 7));
  assert.equal(await closed, 1002);
});

test('the relay logs connects and disconnects, never what goes through', T, async () => {
  const { port, lines } = await startRelay();
  const marker = 'PAGE-CONTENT-7f3a';
  const answer = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\n\r\n${marker}`);
  const target = await rawTarget((got) => (got.includes('\r\n\r\n') ? answer : null));
  const tunnel = await connectedTunnel(port, target.port);
  await phone(port, Buffer.from(`GET /${marker}?cookie=${marker} HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ledung_auth=${marker}\r\n\r\n`));
  tunnel.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(lines.some((l) => l.includes('agent connected') && l.includes('"pc"') && l.includes('"someone"')));
  assert.ok(lines.some((l) => l.includes('agent disconnected')));
  assert.ok(lines.every((l) => !l.includes(marker) && !l.includes(SECRET)));
});

test('the head sent on: one request per connection, upgrades untouched', T, () => {
  assert.equal(forwardHead('GET / HTTP/1.1\r\nHost: a\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n'), 'GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
  assert.equal(forwardHead('GET / HTTP/1.1\r\nHost: a\r\n\r\n'), 'GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
  const upgrade = 'GET /ws HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
  assert.equal(forwardHead(upgrade), upgrade);
  assert.equal(forwardHead('GET /ws HTTP/1.1\r\nHost: a\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n'), 'GET /ws HTTP/1.1\r\nHost: a\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n');
  // Not an upgrade to Node without both headers, so not one here either (review 165 finding 1).
  assert.equal(forwardHead('GET / HTTP/1.1\r\nHost: a\r\nUpgrade: x\r\n\r\n'), 'GET / HTTP/1.1\r\nHost: a\r\nUpgrade: x\r\nConnection: close\r\n\r\n');
  assert.equal(forwardHead('GET / HTTP/1.1\r\nHost: a\r\nConnection: upgrade\r\n\r\n'), 'GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
});

test('the relay config refuses what it cannot use', T, () => {
  const agent = { name: 'pc', owner: 'x', host: 'pc.example.org', secretSha256: hashSecret('s') };
  assert.doesNotThrow(() => parseRelayConfig({ agents: [agent] }));
  // Ledung names as Martin decided them (#160, 2026-10-17 12:44).
  assert.doesNotThrow(() => parseRelayConfig({ agents: [{ ...agent, name: 'copper7meadow4', host: 'copper7meadow4.example.org' }] }));
  assert.throws(() => parseRelayConfig({ agents: [{ ...agent, secretSha256: 'plain secret' }] }), /secretSha256/);
  assert.throws(() => parseRelayConfig({ agents: [{ ...agent, host: 'PC.Example.org' }] }), /host/);
  assert.throws(() => parseRelayConfig({ agents: [{ ...agent, owner: '' }] }), /owner/);
  assert.throws(() => parseRelayConfig({ agents: [agent, { ...agent, host: 'other.example.org' }] }), /two are named "pc"/);
  assert.throws(() => parseRelayConfig({ agents: [agent, { ...agent, name: 'mac' }] }), /two use the host/);
  assert.throws(() => parseRelayConfig({ agents: [agent], limits: { maxFrameBytes: 1000 } }), /maxFrameBytes/);
  // End to end (#200): a passed-through agent needs the passthrough listener.
  assert.equal(parseRelayConfig({ agents: [agent] }).agents[0]!.tls, 'proxy');
  assert.equal(parseRelayConfig({ agents: [agent] }).passthroughPort, null);
  assert.doesNotThrow(() => parseRelayConfig({ passthroughPort: 8443, agents: [{ ...agent, tls: 'passthrough' }] }));
  assert.throws(() => parseRelayConfig({ agents: [{ ...agent, tls: 'passthrough' }] }), /passthroughPort must be set/);
  assert.throws(() => parseRelayConfig({ passthroughPort: 8443, agents: [{ ...agent, tls: 'end' }] }), /tls: "proxy" or "passthrough"/);
  assert.throws(() => parseRelayConfig({ passthroughPort: '8443', agents: [agent] }), /passthroughPort/);
  // The README's example is a config the relay takes, with one agent of each kind.
  const example = parseRelayConfig(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'relay', 'relay.config.example.json'), 'utf8')));
  assert.deepEqual(example.agents.map((a) => a.tls), ['proxy', 'passthrough']);
});

// --- End to end (#200, docs/steps/relay-e2e.md piece 2): TLS passed through by name, never ended here.

/** As long as the recorded ClientHello's "pc.relay.test", so the name can be swapped in place. */
const PASS_HOST = 'tl.relay.test';
const PROXY_SIGNATURE = Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'latin1');

/** A PROXY v2 header for a TCP over IPv4 connection from `from`, as the spec (haproxy.org, proxy-protocol.txt 2.2) lays it out. */
function proxyV4(from: string, fromPort = 51234): Buffer {
  const address = Buffer.concat([Buffer.from(from.split('.').map(Number)), Buffer.from([10, 0, 0, 2]), Buffer.from([fromPort >> 8, fromPort & 0xff]), Buffer.from([0x20, 0xfb])]);
  return Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x11, 0, address.length]), address]);
}

/** Recorded from Edge 155 opening https://pc.relay.test/ (see test/clienthello.test.ts); its name is rewritten to `host`. */
function browserHello(host: string): Buffer {
  const bytes = Buffer.from(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'clienthello-edge.hex'), 'utf8').trim(), 'hex');
  assert.equal(host.length, 'pc.relay.test'.length, 'same length, so no length in the record changes');
  const at = bytes.indexOf('pc.relay.test');
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(host, 'ascii'), bytes.subarray(at + host.length)]);
}

async function startPassRelay(limits: Partial<RelayLimits> = {}, passthroughFrom?: string[]) {
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(),
    passthroughPort: 0,
    passthroughFrom,
    bind: '127.0.0.1',
    agents: [
      { name: 'e2e', owner: 'someone', host: PASS_HOST, secretSha256: hashSecret(SECRET), tls: 'passthrough' },
      { name: 'pc', owner: 'someone', host: HOST, secretSha256: hashSecret('the proxied ones secret, long enough') },
    ],
    limits,
  });
  const relay = new Relay(config, (line) => lines.push(line));
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  return { relay, port, passPort: relay.passthroughPort()!, lines };
}

/** Bytes to the passthrough listener, sent `chunk` bytes at a time; everything that came back once the relay closed. */
function passPhone(port: number, bytes: Buffer, chunk = bytes.length): Promise<Buffer> {
  return new Promise((resolve) => {
    const got: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', async () => {
      socket.setNoDelay(true);
      for (let at = 0; at < bytes.length && !socket.destroyed; at += chunk) {
        socket.write(bytes.subarray(at, at + chunk));
        if (chunk < bytes.length) await new Promise((r) => setTimeout(r, 1));
      }
    });
    socket.on('data', (c: Buffer) => got.push(c));
    socket.on('error', () => {});
    socket.on('close', () => resolve(Buffer.concat(got)));
  });
}

test('PROXY v2 headers: the phone\'s address over IPv4 and IPv6, nothing for LOCAL, and garbage refused', T, () => {
  const v4 = proxyV4('203.0.113.7');
  assert.deepEqual(readProxyHeader(Buffer.concat([v4, Buffer.from([0x16])])), { state: 'header', address: '203.0.113.7', length: 28 });
  for (let n = 0; n < v4.length; n++) assert.deepEqual(readProxyHeader(v4.subarray(0, n)), { state: 'more' }, `first ${n} bytes`);
  const v6Address = Buffer.concat([Buffer.from('20010db8000000000000000000000001', 'hex'), Buffer.alloc(16), Buffer.from([0xc8, 0x00, 0x20, 0xfb])]);
  const v6 = Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x21, 0, 36]), v6Address]);
  assert.deepEqual(readProxyHeader(v6), { state: 'header', address: '2001:db8::1', length: 52 });
  // TLVs after the address are skipped with it.
  const tlv = Buffer.from([0x04, 0x00, 0x02, 0xaa, 0xbb]);
  const withTlv = Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x11, 0, 12 + tlv.length]), v4.subarray(16), tlv]);
  assert.deepEqual(readProxyHeader(withTlv), { state: 'header', address: '203.0.113.7', length: 16 + 12 + tlv.length });
  // LOCAL (the proxy's own check) and UNSPEC carry no address.
  assert.deepEqual(readProxyHeader(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x20, 0x00, 0, 0])])), { state: 'header', address: null, length: 16 });
  assert.deepEqual(readProxyHeader(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x00, 0, 0])])), { state: 'header', address: null, length: 16 });
  const bad = (b: Buffer, reason: RegExp) => {
    const r = readProxyHeader(b);
    assert.equal(r.state, 'bad');
    assert.match((r as { reason: string }).reason, reason);
  };
  bad(Buffer.from([0x16, 0x03, 0x01]), /no PROXY v2 header/);
  bad(Buffer.from('PROXY TCP4 203.0.113.7 10.0.0.2 51234 8443\r\n'), /no PROXY v2 header/); // version 1, text
  bad(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x11, 0x11, 0, 12])]), /version 2/);
  bad(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x22, 0x11, 0, 12])]), /command/);
  bad(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x11, 0xff, 0xff])]), /too large/);
  bad(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x11, 0, 4]), Buffer.alloc(4)]), /too short/);
  bad(Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x12, 0, 12]), Buffer.alloc(12)]), /not TCP/);
  for (let i = 0; i < 2000; i++) assert.ok(['more', 'bad', 'header'].includes(readProxyHeader(crypto.randomBytes(crypto.randomInt(0, 80))).state));
});

test('a TLS connection through the relay reaches the Ledung byte for byte: the Ledung completes the handshake, the relay only carries records', T, async () => {
  const { port, passPort, lines } = await startPassRelay();
  // The Ledung's side: its own certificate and key, a TLS server fed each tunnel stream in memory
  // (as LedungServer.tunnelConnection() hands streams to its server), and everything it got and sent.
  const cert = selfSigned(PASS_HOST);
  const marker = `PAGE-${crypto.randomBytes(8).toString('hex')}`;
  const ledung = tls.createServer({ ...cert, ALPNProtocols: ['http/1.1'] }, (socket) => {
    let request = '';
    socket.on('data', (c: Buffer) => {
      request += c.toString('latin1');
      if (request.includes('\r\n\r\n')) socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`);
    });
  });
  const atLedung = { got: [] as Buffer[], sent: [] as Buffer[] };
  await connectedTunnel(port, () => {
    const [ours, theirs] = duplexPair();
    ours.on('data', (c: Buffer) => atLedung.got.push(c));
    theirs.on('data', (c: Buffer) => atLedung.sent.push(c));
    ledung.emit('connection', ours);
    return theirs;
  }, 'e2e', SECRET, PASS_HOST);

  // The phone: a TLS client trusting only the Ledung's certificate, through a wire that keeps every
  // byte the relay sees. Caddy's PROXY header goes first, as caddy-l4 sends it.
  const raw = net.connect(passPort, '127.0.0.1');
  await new Promise((resolve) => raw.once('connect', resolve));
  raw.write(proxyV4('203.0.113.7'));
  const [mine, wire] = duplexPair();
  const onWire = { up: [] as Buffer[], down: [] as Buffer[] };
  wire.on('data', (c: Buffer) => { onWire.up.push(c); raw.write(c); });
  raw.on('data', (c: Buffer) => { onWire.down.push(c); wire.write(c); });
  raw.on('end', () => wire.end());
  raw.on('error', () => {});
  const phone = tls.connect({ socket: mine, servername: PASS_HOST, ca: cert.cert, ALPNProtocols: ['http/1.1'] });
  await new Promise<void>((resolve, reject) => { phone.once('secureConnect', resolve); phone.once('error', reject); });
  assert.equal(phone.authorized, true, 'the handshake was made with the Ledung\'s own key');
  assert.equal(phone.getPeerX509Certificate()!.fingerprint256, new crypto.X509Certificate(cert.cert).fingerprint256);
  assert.equal(phone.alpnProtocol, 'http/1.1');
  phone.write(`GET / HTTP/1.1\r\nHost: ${PASS_HOST}\r\n\r\n`);
  const page = await new Promise<string>((resolve) => {
    let text = '';
    phone.on('data', (c: Buffer) => { text += c.toString('latin1'); });
    phone.on('end', () => resolve(text));
  });
  assert.ok(page.endsWith(marker), page);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const up = Buffer.concat(onWire.up);
  const down = Buffer.concat(onWire.down);
  assert.ok(up.length > 0 && down.length > 0);
  assert.deepEqual(Buffer.concat(atLedung.got), up, 'the Ledung got exactly what the phone sent after the PROXY header');
  assert.deepEqual(down, Buffer.concat(atLedung.sent), 'the phone got exactly what the Ledung sent, and nothing from the relay');
  assert.equal(up.indexOf(marker), -1);
  assert.equal(down.indexOf(marker), -1, 'the page went through encrypted');
  assert.equal(down[0], 0x16, 'the first byte back is the Ledung\'s handshake record');
  assert.ok(lines.every((l) => !l.includes(marker)));
});

test('a PROXY header and ClientHello arriving in small pieces still reach the Ledung whole, with what follows them', T, async () => {
  const { port, passPort } = await startPassRelay();
  const sent = Buffer.concat([browserHello(PASS_HOST), crypto.randomBytes(64)]);
  const target = await rawTarget((got) => (got.length >= sent.length ? Buffer.from('bye') : null));
  await connectedTunnel(port, target.port, 'e2e', SECRET, PASS_HOST);
  // 23 bytes at a time: the 28-byte PROXY header and the ClientHello are both cut mid-field.
  const back = await passPhone(passPort, Buffer.concat([proxyV4('198.51.100.4'), sent]), 23);
  assert.equal(back.toString(), 'bye');
  assert.deepEqual(target.received[0], sent, 'the PROXY header stays at the relay; every byte after it goes on unchanged');
});

test('no name, an unknown name, a proxied agent\'s name and an offline Ledung close the connection, with no page', T, async () => {
  const { port, passPort, lines } = await startPassRelay();
  // The proxied agent is online, so its case can only close by being refused, not as offline
  // (test review 205 finding 1); its Ledung expects plain HTTP and must get nothing.
  const proxied = await rawTarget(() => Buffer.from('should not get here'));
  await connectedTunnel(port, proxied.port, 'pc', 'the proxied ones secret, long enough', HOST);
  const cases: [string, string, string][] = [
    ['unknown name', 'xx.relay.test', '198.51.100.11'],
    // A name the relay serves only through the proxy that ends TLS is not passed through either.
    ['unknown name', HOST, '198.51.100.12'],
    // Known and passed through, but no Ledung connected.
    ['offline', PASS_HOST, '198.51.100.13'],
  ];
  for (const [reason, name, from] of cases) {
    assert.equal((await passPhone(passPort, Buffer.concat([proxyV4(from), browserHello(name)]))).length, 0, `${name}: ${reason}`);
    const line = lines.find((l) => l.includes(`from="${from}"`));
    assert.ok(line, `${name}: logged with the PROXY address`);
    assert.match(line, new RegExp(`passthrough closed reason="${reason}" sni="${name.replaceAll('.', '\\.')}"`));
  }
  assert.deepEqual(proxied.received, [], 'the proxied Ledung got nothing');
  // No server_name at all: Node sends none to an address.
  const unnamed = await new Promise<Buffer>((resolve) => {
    const server = net.createServer((s) => s.once('data', (c: Buffer) => { s.destroy(); server.close(); resolve(c); }));
    server.listen(0, '127.0.0.1', () => tls.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }).on('error', () => {}));
  });
  assert.equal((await passPhone(passPort, Buffer.concat([proxyV4('198.51.100.9'), unnamed]))).length, 0);
  assert.ok(lines.some((l) => l.includes('passthrough closed') && l.includes('"no name"')));
});

test('the passthrough listener closes what is not a PROXY header followed by a ClientHello', T, async () => {
  const { port, passPort, lines } = await startPassRelay();
  const target = await rawTarget(() => Buffer.from('should not get here'));
  await connectedTunnel(port, target.port, 'e2e', SECRET, PASS_HOST);
  const inputs = [
    browserHello(PASS_HOST), // no PROXY header: not from the proxy
    Buffer.concat([proxyV4('198.51.100.9'), Buffer.from(`GET / HTTP/1.1\r\nHost: ${PASS_HOST}\r\n\r\n`)]), // plain HTTP
    Buffer.concat([proxyV4('198.51.100.9'), crypto.randomBytes(3000)]),
    Buffer.concat([proxyV4('198.51.100.9'), Buffer.from([0x16, 0x03, 0x01, 0x40, 0x01])]), // a record over 16 KiB
  ];
  for (const bytes of inputs) assert.equal((await passPhone(passPort, bytes)).length, 0);
  assert.deepEqual(target.received, [], 'nothing reached the Ledung');
  assert.equal(lines.filter((l) => l.includes('passthrough closed')).length, inputs.length);
});

test('a passed-through name is refused on the HTTP listener, so a proxy that ends TLS for it fails loudly', T, async () => {
  const { port, lines } = await startPassRelay();
  const target = await rawTarget(() => Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
  await connectedTunnel(port, target.port, 'e2e', SECRET, PASS_HOST);
  const reply = (await phone(port, Buffer.from(`GET / HTTP/1.1\r\nHost: ${PASS_HOST}\r\nX-Forwarded-For: 198.51.100.9\r\n\r\n`))).toString();
  assert.match(reply, /^HTTP\/1\.1 421 /);
  assert.match(reply, /must not end TLS/);
  assert.deepEqual(target.received, [], 'nothing reached the Ledung');
  assert.ok(lines.some((l) => l.includes('stream refused') && l.includes('passthrough name on the HTTP listener')));
  // The proxied agent's name still works there as before (its Ledung is not connected: the offline page).
  assert.match((await phone(port, Buffer.from(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`))).toString(), /This Ledung is offline/);
});

test('a connection that stalls before its name is known is dropped after the head timeout, on both listeners (test review 205 finding 2)', T, async () => {
  const { port, passPort } = await startPassRelay({ headTimeoutMs: 200 });
  const stalls = async (to: number, bytes: Buffer) => {
    const started = Date.now();
    await passPhone(to, bytes); // resolves when the relay closes it; the test's own timeout catches one that never does
    return Date.now() - started;
  };
  // A PROXY header and the first 3 bytes of a ClientHello, then nothing.
  const passthrough = await stalls(passPort, Buffer.concat([proxyV4('198.51.100.9'), browserHello(PASS_HOST).subarray(0, 3)]));
  // Half a request head, then nothing.
  const plain = await stalls(port, Buffer.from(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n`));
  for (const took of [passthrough, plain]) assert.ok(took >= 150 && took < 5000, `closed after ${took} ms`);
  assert.equal(parseRelayConfig({ agents: [] }).limits.headTimeoutMs, 10_000, 'the default is the 10 seconds the README states');
});

test('only senders on the list may speak for a phone on the passthrough port; anyone else is closed before a byte is read (Martin, #283)', T, async () => {
  const sent = Buffer.concat([browserHello(PASS_HOST), crypto.randomBytes(16)]);
  const run = async (passthroughFrom: string[]) => {
    const { port, passPort, lines } = await startPassRelay({}, passthroughFrom);
    const target = await rawTarget((got) => (got.length >= sent.length ? Buffer.from('bye') : null));
    await connectedTunnel(port, target.port, 'e2e', SECRET, PASS_HOST);
    // The test's sender is 127.0.0.1; the header claims another address.
    const back = await passPhone(passPort, Buffer.concat([proxyV4('203.0.113.66'), sent]));
    return { back: back.toString(), received: target.received, lines };
  };
  // Not on the list: closed, nothing forwarded, logged with the real sender and never the claimed one.
  const outside = await run(['10.0.0.0/8', 'fc00::/7']);
  assert.equal(outside.back, '');
  assert.deepEqual(outside.received, []);
  const line = outside.lines.find((l) => l.includes('passthrough closed'));
  assert.match(line ?? '', /reason="sender not trusted" from="127\.0\.0\.1"/);
  assert.ok(outside.lines.every((l) => !l.includes('203.0.113.66')));
  // On the list, as one address: carried as before.
  const inside = await run(['10.0.0.0/8', '127.0.0.1']);
  assert.equal(inside.back, 'bye');
  assert.deepEqual(inside.received, [sent]);
});

test('the default senders are loopback and the private ranges, IPv4-mapped forms included', T, () => {
  assert.deepEqual(parseRelayConfig({ agents: [] }).passthroughFrom, DEFAULT_PASSTHROUGH_FROM);
  const trusted = senderCheck(DEFAULT_PASSTHROUGH_FROM);
  for (const a of ['127.0.0.1', '127.255.0.9', '10.0.0.2', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.20', '::1', 'fc00::1', 'fd12:3456::7', '::ffff:10.1.2.3', '::FFFF:172.18.0.4', '::ffff:127.0.0.1']) {
    assert.equal(trusted(a), true, a);
  }
  for (const a of ['8.8.8.8', '172.15.255.255', '172.32.0.1', '192.169.0.1', '11.0.0.1', '203.0.113.66', '2001:db8::1', 'fe80::1', '::2', '::ffff:8.8.8.8', '', undefined, 'not an address']) {
    assert.equal(trusted(a), false, String(a));
  }
  assert.throws(() => parseRelayConfig({ passthroughFrom: ['10.0.0.0/33'], agents: [] }), /passthroughFrom/);
  assert.throws(() => parseRelayConfig({ passthroughFrom: ['caddy'], agents: [] }), /passthroughFrom/);
  assert.throws(() => parseRelayConfig({ passthroughFrom: '10.0.0.0/8', agents: [] }), /passthroughFrom/);
  assert.throws(() => parseRelayConfig({ passthroughFrom: ['10.0.0.0/8/1'], agents: [] }), /passthroughFrom/);
});

test('passed-through connections beyond the per-agent limit are closed', T, async () => {
  const { port, passPort, lines } = await startPassRelay({ maxStreamsPerAgent: 1 });
  const agent = await rawAgent(port, 'e2e', SECRET);
  const opened = new Promise<void>((resolve) => agent.ws!.once('message', () => resolve()));
  const held = net.connect(passPort, '127.0.0.1', () => held.write(Buffer.concat([proxyV4('198.51.100.9'), browserHello(PASS_HOST)])));
  held.on('error', () => {});
  await opened;
  assert.equal((await passPhone(passPort, Buffer.concat([proxyV4('198.51.100.10'), browserHello(PASS_HOST)]))).length, 0);
  assert.ok(lines.some((l) => l.includes('stream refused') && l.includes('"198.51.100.10"')));
  held.destroy();
  agent.ws!.close();
});
