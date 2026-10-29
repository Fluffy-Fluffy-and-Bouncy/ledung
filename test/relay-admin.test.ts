// Adding computers to a running relay (issue #236): `node relay.ts add`, `remove` and `list` reach the relay over
// a local admin socket and change its agents in place, so a computer added can connect at once while the ones
// connected stay connected. Only a hash is given, every computer added is end to end, and what is added is kept.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  adminText, AGENT_NAME_HEADER, hashSecret as relayHash, NAME_WORDS, parseAdminArgs, parseRelayConfig, Relay, sendAdmin, wordName, type AdminReply,
} from '../relay/relay.ts';
import { helloMessage } from '../src/remote/mux.ts';
import { hashSecret, remoteSecretText } from '../src/remote/secret.ts';
import { Tunnel } from '../src/remote/tunnel.ts';
import { removeTemp } from './temp.ts';
import { freePort, listenOk } from './free-port.ts';

const T = { timeout: 15_000 };
const ROOT = path.join(import.meta.dirname, '..');
const OLD_SECRET = 'the secret of the computer already there';
/** 13 characters, as test/fixtures/clienthello-edge.hex's name, so it can be swapped in place. */
const OLD_HOST = 'tl.relay.test';
const NEW_SECRET = 'the secret the new computer made itself';
const NEW_HOST = 'nw.relay.test';
const NEW_HASH = crypto.createHash('sha256').update(NEW_SECRET).digest('hex');
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-relay-admin-'));
  cleanup.push(() => removeTemp(dir));
  return dir;
}

/** A socket path of its own per relay: a named pipe on Windows, a short Unix socket path elsewhere (macOS allows 104 bytes). */
function socketPath(): string {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\ledung-relay-test-${id}` : path.join(os.tmpdir(), `lr-${id}.sock`);
}

interface Options { store?: string | null; pickName?: () => string; passthroughPort?: number | null; domain?: string | null; relayUrl?: string | null }

async function startRelay(options: Options = {}) {
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(),
    bind: '127.0.0.1',
    passthroughPort: options.passthroughPort === undefined ? 0 : options.passthroughPort,
    domain: options.domain === undefined ? 'relay.test' : options.domain,
    relayUrl: options.relayUrl === undefined ? 'wss://relay.relay.test' : options.relayUrl,
    limits: { headTimeoutMs: 300 },
    agents: [{ name: 'old', owner: 'admin', host: OLD_HOST, secretSha256: hashSecret(OLD_SECRET), tls: options.passthroughPort === null ? 'proxy' : 'passthrough' }],
  });
  const relay = new Relay(config, (line) => lines.push(line), { store: options.store, pickName: options.pickName });
  const port = await relay.listen();
  const admin = socketPath();
  await relay.listenAdmin(admin);
  cleanup.push(() => relay.close());
  return { relay, port, passPort: relay.passthroughPort(), admin, lines };
}

async function connectedTunnel(relayPort: number, targetPort: number, name: string, secret: string, publicName: string): Promise<Tunnel> {
  const tunnel = new Tunnel({
    relay: `ws://127.0.0.1:${relayPort}`, name, secret, publicName, minDelayMs: 50, maxDelayMs: 200,
    connect: () => net.connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true }),
  });
  cleanup.push(() => tunnel.stop());
  tunnel.start();
  // A deadline, so a relay that won't take the name fails the test instead of hanging the file.
  const until = Date.now() + 3000;
  while (tunnel.status().state !== 'connected') {
    if (Date.now() > until) {
      tunnel.stop();
      throw new Error(`"${name}" did not connect: ${JSON.stringify(tunnel.status())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return tunnel;
}

/** A Ledung by hand: signs in and sends its hello; resolves with the socket once the relay's hello is back, or the refusal's status. */
function rawAgent(port: number, name: string, secret: string): Promise<{ ws: WebSocket | null; status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { [AGENT_NAME_HEADER]: name, authorization: `Bearer ${secret}` } });
    ws.once('open', () => {
      ws.once('message', () => resolve({ ws, status: 101 }));
      ws.send(helloMessage());
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ws: null, status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on('error', () => {});
  });
}

/** A stand-in Ledung that answers `who` to whatever it is sent. */
async function target(who: string): Promise<number> {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end(who));
    socket.on('error', () => {});
  });
  await listenOk(server);
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as net.AddressInfo).port;
}

const PROXY_SIGNATURE = Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'latin1');
/** A PROXY v2 header for TCP over IPv4 from 203.0.113.7, as caddy-l4 sends it before the phone's bytes. */
const PROXY = Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x11, 0, 12, 203, 0, 113, 7, 10, 0, 0, 2, 0xc8, 0x22, 0x20, 0xfb])]);

/** A browser's ClientHello for `host` (recorded from Edge, test/clienthello.test.ts), as a phone opens that name end to end. */
function browserHello(host: string): Buffer {
  const bytes = Buffer.from(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'clienthello-edge.hex'), 'utf8').trim(), 'hex');
  assert.equal(host.length, 'pc.relay.test'.length);
  const at = bytes.indexOf('pc.relay.test');
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(host, 'ascii'), bytes.subarray(at + host.length)]);
}

/** A phone opening `host` on the passthrough listener; what came back before the relay or the Ledung closed. */
function passPhone(port: number, host: string): Promise<string> {
  return new Promise((resolve) => {
    const got: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(Buffer.concat([PROXY, browserHello(host)])));
    socket.on('data', (c: Buffer) => got.push(c));
    socket.on('error', () => {});
    socket.on('close', () => resolve(Buffer.concat(got).toString()));
  });
}

function ok<R extends AdminReply>(reply: AdminReply): Extract<R, { ok: true }> {
  assert.equal(reply.ok, true, reply.ok ? '' : reply.error);
  return reply as Extract<R, { ok: true }>;
}

function refused(reply: AdminReply, reason: RegExp): void {
  assert.equal(reply.ok, false, 'refused');
  assert.match((reply as { error: string }).error, reason);
}

test('a computer added to the running relay connects at once, end to end, while the one already connected stays connected', T, async () => {
  const { relay, port, passPort, admin, lines } = await startRelay();
  const oldTunnel = await connectedTunnel(port, await target('OLD-LEDUNG'), 'old', OLD_SECRET, OLD_HOST);
  // The new name isn't known yet.
  assert.equal((await rawAgent(port, 'newpc', NEW_SECRET)).status, 401);

  const added = ok(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', host: NEW_HOST }, admin));
  assert.deepEqual(added, { ok: true, op: 'add', relayUrl: 'wss://relay.relay.test', agent: { name: 'newpc', owner: 'friend', host: NEW_HOST, secretSha256: NEW_HASH, tls: 'passthrough' } });
  await connectedTunnel(port, await target('NEW-LEDUNG'), 'newpc', NEW_SECRET, NEW_HOST);

  assert.equal(oldTunnel.status().state, 'connected');
  assert.deepEqual(relay.connected().sort(), ['newpc', 'old']);
  assert.equal(lines.filter((l) => l.includes('agent disconnected') || l.includes('agent replaced')).length, 0, 'nobody was dropped');
  assert.equal(lines.filter((l) => l.includes('agent connected') && l.includes('name="old"')).length, 1, 'the old one connected once and only once');
  // Phones reach each by its own name, still encrypted (the stand-ins answer whatever comes).
  assert.equal(await passPhone(passPort!, NEW_HOST), 'NEW-LEDUNG');
  assert.equal(await passPhone(passPort!, OLD_HOST), 'OLD-LEDUNG');
  // Only the hash was ever given or logged.
  assert.ok(lines.every((l) => !l.includes(NEW_SECRET)));
});

test('remove disconnects the computer and forgets it; list shows every computer, where it comes from and whether it is connected', T, async () => {
  const { relay, port, passPort, admin, lines } = await startRelay();
  ok(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', host: NEW_HOST }, admin));
  const old = await rawAgent(port, 'old', OLD_SECRET);
  const added = await rawAgent(port, 'newpc', NEW_SECRET);
  assert.equal(added.status, 101);

  const listed = ok<Extract<AdminReply, { op: 'list' }>>(await sendAdmin({ op: 'list' }, admin));
  assert.deepEqual(listed.agents, [
    { name: 'old', owner: 'admin', host: OLD_HOST, tls: 'passthrough', from: 'config', connected: true },
    { name: 'newpc', owner: 'friend', host: NEW_HOST, tls: 'passthrough', from: 'added', connected: true },
  ]);

  const closed = new Promise<number>((resolve) => added.ws!.once('close', (code) => resolve(code)));
  const removed = ok(await sendAdmin({ op: 'remove', name: 'newpc' }, admin));
  assert.equal((removed as Extract<AdminReply, { op: 'remove' }>).wasConnected, true);
  assert.equal(await closed, 4003, 'its connection is closed');
  assert.deepEqual(relay.connected(), ['old'], 'the other stays');
  assert.equal(old.ws!.readyState, WebSocket.OPEN);
  assert.equal((await rawAgent(port, 'newpc', NEW_SECRET)).status, 401, 'it can no longer sign in');
  assert.equal(await passPhone(passPort!, NEW_HOST), '', 'phones no longer reach it');
  assert.ok(lines.some((l) => l.includes('agent removed') && l.includes('name="newpc"')));
  assert.deepEqual(ok<Extract<AdminReply, { op: 'list' }>>(await sendAdmin({ op: 'list' }, admin)).agents.map((a) => a.name), ['old']);

  // Hand-written entries are the config's: removed there, not here.
  refused(await sendAdmin({ op: 'remove', name: 'old' }, admin), /written in the relay's config/);
  refused(await sendAdmin({ op: 'remove', name: 'nobody' }, admin), /No computer is named "nobody"/);
  assert.deepEqual(relay.connected(), ['old']);
  old.ws!.close();
});

test('a computer removed while it is signing in is refused when its hello arrives, even under a name added again with a new secret (review finding 1)', T, async () => {
  const { relay, port, admin, lines } = await startRelay();
  const OTHER_SECRET = 'the leaked secret the computer had before';
  ok(await sendAdmin({ op: 'add', hash: hashSecret(OTHER_SECRET), owner: 'friend', name: 'newpc', host: NEW_HOST }, admin));
  // Signed in with the old secret, its hello held back.
  const held = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { [AGENT_NAME_HEADER]: 'newpc', authorization: `Bearer ${OTHER_SECRET}` } });
  held.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    held.once('open', () => resolve());
    held.once('unexpected-response', () => reject(new Error('the old secret was refused before the remove')));
  });
  ok(await sendAdmin({ op: 'remove', name: 'newpc' }, admin));
  ok(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', host: NEW_HOST }, admin));

  // A deadline, so a relay that lets it in fails the test instead of hanging it.
  const closed = new Promise<number | string>((resolve) => {
    held.once('close', (code) => resolve(code));
    setTimeout(() => resolve('still open'), 3000).unref();
  });
  held.send(helloMessage());
  assert.equal(await closed, 4003);
  assert.deepEqual(relay.connected(), [], 'the holder of the old secret is not the tunnel');
  assert.ok(lines.some((l) => l.includes('agent refused') && l.includes('name="newpc"') && l.includes('Removed from the relay')));

  const renewed = await rawAgent(port, 'newpc', NEW_SECRET);
  assert.equal(renewed.status, 101, 'the computer with the new secret signs in');
  assert.deepEqual(relay.connected(), ['newpc']);
  renewed.ws!.close();
});

test('word names: two words and two digits from 2 to 9 in two of the three gaps, a DNS label of at most 22 characters (relay-home decision 2)', T, () => {
  assert.ok(NAME_WORDS.length >= 100);
  assert.ok(NAME_WORDS.every((w) => /^[a-z]{6,10}$/.test(w)), 'six to ten lower-case letters');
  assert.equal(new Set(NAME_WORDS).size, NAME_WORDS.length);
  for (let i = 0; i < 2000; i++) {
    const name = wordName();
    assert.match(name, /^[2-9]?[a-z]+[2-9]?[a-z]+[2-9]?$/);
    assert.ok(name.length <= 22, name);
    assert.equal(name.replace(/[a-z]/g, '').length, 2, `${name}: two digits`);
    const letters = name.replace(/[2-9]/g, '');
    const split = NAME_WORDS.some((w) => letters.startsWith(w) && letters !== w + w && NAME_WORDS.includes(letters.slice(w.length)));
    assert.ok(split, `${name}: two different words from the list`);
  }
  // With a fixed sequence: words 0 and 1, the middle gap skipped, then digits 2 + 5 and 2 + 7 in the other two.
  const picks = [0, 1, 1, 5, 7];
  assert.equal(wordName(() => picks.shift()!), `7${NAME_WORDS[0]}${NAME_WORDS[1]}9`);
});

test('add picks a free word name under the relay\'s domain, takes a given name and host when free, and refuses taken ones', T, async () => {
  const words = ['old', 'copper7meadow4', 'copper7meadow4', '4lantern9harbor'];
  const { admin } = await startRelay({ pickName: () => words.shift()! });
  const add = (extra: Record<string, string> = {}) => sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', ...extra }, admin);
  // The first pick is the config's "old", so it picks again.
  const first = ok<Extract<AdminReply, { op: 'add' }>>(await add());
  assert.equal(first.agent.name, 'copper7meadow4');
  assert.equal(first.agent.host, 'copper7meadow4.l.relay.test');
  // The next pick is the one just added: picked again.
  assert.equal(ok<Extract<AdminReply, { op: 'add' }>>(await add()).agent.name, '4lantern9harbor');
  // A given name, and a host of the owner's own domain.
  const own = ok<Extract<AdminReply, { op: 'add' }>>(await add({ name: 'Friends-Mac', host: 'Mac.Friend.Example' }));
  assert.deepEqual([own.agent.name, own.agent.host], ['friends-mac', 'mac.friend.example']);
  refused(await add({ name: 'OLD' }), /The name "old" is taken/);
  refused(await add({ name: 'copper7meadow4' }), /taken/);
  refused(await add({ name: 'other', host: OLD_HOST }), /The host "tl.relay.test" is taken/);
  refused(await add({ name: 'other2', host: 'mac.friend.example' }), /taken/);
  refused(await add({ name: 'bad_name' }), /--name/);
  refused(await add({ name: 'x'.repeat(64) }), /--name/);
  refused(await add({ name: 'other3', host: 'no-dot' }), /--host/);
  refused(await add({ name: 'other4', host: 'relay.relay.test' }), /the relay's own name/);
  const listed = ok<Extract<AdminReply, { op: 'list' }>>(await sendAdmin({ op: 'list' }, admin));
  assert.deepEqual(listed.agents.map((a) => a.name), ['old', 'copper7meadow4', '4lantern9harbor', 'friends-mac']);
});

test('add takes only a hash, always passes through end to end and refuses "proxy"', T, async () => {
  const { admin, relay } = await startRelay();
  const add = (extra: Record<string, unknown>) => sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', ...extra } as never, admin);
  refused(await add({ tls: 'proxy' }), /always "tls": "passthrough".*"proxy" is only for hand-written/);
  refused(await add({ hash: NEW_SECRET }), /--hash: the 64 hex digits/);
  refused(await add({ hash: NEW_HASH.slice(1) }), /--hash/);
  refused(await add({ owner: '  ' }), /--owner/);
  assert.equal(relay.list().length, 1, 'nothing was added');
  // A hash in capitals is the same hash.
  assert.equal(ok<Extract<AdminReply, { op: 'add' }>>(await add({ hash: NEW_HASH.toUpperCase(), tls: 'passthrough' })).agent.secretSha256, NEW_HASH);

  // A relay with no passthrough listener can't take one; without a domain, the host must be given.
  const plain = await startRelay({ passthroughPort: null });
  refused(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend' }, plain.admin), /no passthroughPort/);
  const noDomain = await startRelay({ domain: null });
  refused(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend' }, noDomain.admin), /no "domain", so give the host with --host/);
  assert.equal(ok<Extract<AdminReply, { op: 'add' }>>(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', host: 'pc.friend.example' }, noDomain.admin)).agent.host, 'pc.friend.example');
});

test('what add and remove change is kept in the store, written whole, and read back when the relay starts again', T, async () => {
  const dir = tempDir();
  const store = path.join(dir, 'relay.added.json');
  const first = await startRelay({ store });
  ok(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', host: NEW_HOST }, first.admin));
  ok(await sendAdmin({ op: 'add', hash: hashSecret('another'), owner: 'friend', name: 'gone', host: 'gone.relay.test' }, first.admin));
  ok(await sendAdmin({ op: 'remove', name: 'gone' }, first.admin));
  assert.deepEqual(JSON.parse(fs.readFileSync(store, 'utf8')).agents, [{ name: 'newpc', owner: 'friend', host: NEW_HOST, secretSha256: NEW_HASH, tls: 'passthrough' }]);
  assert.deepEqual(fs.readdirSync(dir), ['relay.added.json'], 'no temporary file left behind');
  await first.relay.close();

  const again = await startRelay({ store });
  assert.deepEqual(again.relay.list().map((a) => [a.name, a.from]), [['old', 'config'], ['newpc', 'added']]);
  assert.equal((await rawAgent(again.port, 'newpc', NEW_SECRET)).status, 101, 'it signs in after the restart');
  // Still the store's to remove.
  ok(await sendAdmin({ op: 'remove', name: 'newpc' }, again.admin));
  assert.deepEqual(JSON.parse(fs.readFileSync(store, 'utf8')).agents, []);
});

test('an add that cannot be kept changes nothing; a stored computer that now clashes with the config, or is not end to end, is left out and logged', T, async () => {
  const unwritable = await startRelay({ store: path.join(tempDir(), 'no-such-folder', 'relay.added.json') });
  refused(await sendAdmin({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', host: NEW_HOST }, unwritable.admin), /Could not write the relay's store/);
  assert.deepEqual(unwritable.relay.list().map((a) => a.name), ['old']);
  assert.equal((await rawAgent(unwritable.port, 'newpc', NEW_SECRET)).status, 401);

  const store = path.join(tempDir(), 'relay.added.json');
  fs.writeFileSync(store, JSON.stringify({ agents: [
    { name: 'old', owner: 'friend', host: 'other.relay.test', secretSha256: NEW_HASH, tls: 'passthrough' },
    { name: 'newpc', owner: 'friend', host: NEW_HOST, secretSha256: NEW_HASH, tls: 'passthrough' },
    { name: 'byhand', owner: 'friend', host: 'bh.relay.test', secretSha256: NEW_HASH, tls: 'proxy' },
  ] }));
  const { relay, lines } = await startRelay({ store });
  assert.deepEqual(relay.list().map((a) => [a.name, a.host]), [['old', OLD_HOST], ['newpc', NEW_HOST]], 'the config\'s entry wins');
  assert.ok(lines.some((l) => l.includes('added agent skipped') && l.includes('name="old"') && l.includes('already in use')));
  // Added computers are always end to end (Q396), also after a hand edit of the store (review finding Minor 1).
  assert.ok(lines.some((l) => l.includes('added agent skipped') && l.includes('name="byhand"') && l.includes('not end to end')));
  // A store that isn't one stops the relay with a readable reason instead of losing it.
  fs.writeFileSync(store, '{"agents": [');
  assert.throws(() => new Relay(parseRelayConfig({ port: 0, agents: [] }), () => {}, { store }), /store of added computers .* can't be read/);
});

test('the admin requests are not reachable through the relay\'s ports, only on its local socket', T, async () => {
  const { relay, port, passPort, admin } = await startRelay();
  const line = `${JSON.stringify({ op: 'add', hash: NEW_HASH, owner: 'friend', name: 'newpc', host: NEW_HOST })}\n`;
  const send = (p: number, bytes: string) => new Promise<string>((resolve) => {
    const socket = net.connect(p, '127.0.0.1', () => socket.write(bytes));
    let got = '';
    socket.on('data', (c: Buffer) => { got += c.toString(); });
    socket.on('error', () => {});
    socket.on('close', () => resolve(got));
  });
  // As raw bytes, and as an HTTP request carrying them, on both listeners.
  const http = `POST /admin HTTP/1.1\r\nHost: relay.relay.test\r\nContent-Length: ${line.length}\r\n\r\n${line}`;
  for (const p of [port, passPort!]) {
    for (const bytes of [line, http]) assert.doesNotMatch(await send(p, bytes), /"ok"/);
  }
  assert.deepEqual(relay.list().map((a) => a.name), ['old'], 'nothing was added');
  if (process.platform !== 'win32') assert.equal(fs.statSync(admin).mode & 0o777, 0o600, 'only the relay\'s own user may use the socket');
  // An admin line that never ends is cut off.
  const long = await new Promise<string>((resolve) => {
    const socket = net.connect(admin, () => socket.write('x'.repeat(5000)));
    let got = '';
    socket.on('data', (c: Buffer) => { got += c.toString(); });
    socket.on('close', () => resolve(got));
    socket.on('error', () => {});
  });
  assert.match(long, /too long/);
});

/** Runs `node relay/relay.ts <args>` against the admin socket; resolves with its exit code and output. */
function relayCommand(args: string[], admin: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'relay', 'relay.ts'), ...args], { env: { ...process.env, RELAY_ADMIN_SOCKET: admin } }, (error, out, err) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err });
    });
  });
}

test('node relay.ts add prints the remote block the owner pastes, with a placeholder for their own secret, and the CAA reminder', T, async () => {
  const { admin, relay } = await startRelay();
  const added = await relayCommand(['add', '--hash', NEW_HASH, '--owner', 'friend', '--name', 'newpc'], admin);
  assert.equal(added.code, 0, added.err);
  const at = added.out.indexOf('"remote"');
  // Printed as it goes inside the config's braces, indented by two.
  const block = JSON.parse(`{${added.out.slice(at, added.out.indexOf('\n  }', at) + 4)}}`);
  assert.deepEqual(block, { remote: {
    relay: 'wss://relay.relay.test', name: 'newpc', publicName: 'newpc.l.relay.test', secret: '<the secret remote-secret printed for you>', tls: 'required', acme: 'production',
  } });
  assert.match(added.out, /CAA line for newpc\.l\.relay\.test; add that CAA record/);
  assert.ok(!added.out.includes(NEW_SECRET));
  assert.deepEqual(relay.list().map((a) => a.name), ['old', 'newpc']);

  const listed = await relayCommand(['list'], admin);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^NAME +OWNER +HOST +TLS +FROM +CONNECTED\n/);
  assert.match(listed.out, /\nnewpc +friend +newpc\.l\.relay\.test +passthrough +added +no$/m);

  const proxy = await relayCommand(['add', '--hash', NEW_HASH, '--owner', 'friend', '--tls', 'proxy'], admin);
  assert.equal(proxy.code, 1);
  assert.match(proxy.err, /always "tls": "passthrough"/);

  assert.equal((await relayCommand(['remove', 'newpc'], admin)).out.trim(), 'Removed "newpc" (newpc.l.relay.test).');
  const none = await relayCommand(['list'], socketPath());
  assert.equal(none.code, 1);
  assert.match(none.err, /No relay is running here/);
});

test('the admin command line: what it takes and what it refuses', T, () => {
  assert.deepEqual(parseAdminArgs(['add', '--hash', 'h', '--owner', 'o']), { op: 'add', hash: 'h', owner: 'o', name: undefined, host: undefined, tls: undefined });
  assert.deepEqual(parseAdminArgs(['remove', 'pc']), { op: 'remove', name: 'pc' });
  assert.deepEqual(parseAdminArgs(['list']), { op: 'list' });
  assert.throws(() => parseAdminArgs(['add', '--owner', 'o']), /add needs --hash and --owner/);
  assert.throws(() => parseAdminArgs(['add', '--hash', 'h', '--owner']), /--owner needs a value/);
  assert.throws(() => parseAdminArgs(['add', '--hash', 'h', '--owner', 'o', '--secret', 's']), /Unknown option: --secret/);
  assert.throws(() => parseAdminArgs(['remove']), /remove takes the name only/);
  assert.throws(() => parseAdminArgs(['list', 'x']), /list takes nothing more/);
  assert.equal(adminText({ ok: true, op: 'list', agents: [] }), 'No computers.');
});

test('remote-secret makes a strong secret and shows the SHA-256 the relay checks, before any config is read', T, async () => {
  // Same function on both sides.
  assert.equal(relayHash, hashSecret);
  const text = remoteSecretText('a-known-secret');
  assert.ok(text.includes('  a-known-secret\n'));
  assert.ok(text.includes(`  ${crypto.createHash('sha256').update('a-known-secret').digest('hex')}\n`));

  const dir = tempDir();
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'src', 'main.ts'), 'remote-secret'], {
      // A config that doesn't exist: the command must not need one, nor touch Ledung's data.
      env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'none.json'), LEDUNG_DATA_DIR: path.join(dir, 'data') },
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  const [secret, hash] = [...out.matchAll(/^ {2}(\S+)$/gm)].map((m) => m[1]!);
  assert.match(secret!, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(hash, crypto.createHash('sha256').update(secret!).digest('hex'));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written');
});
