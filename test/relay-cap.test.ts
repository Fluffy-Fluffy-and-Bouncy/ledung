// The byte cap per owner (issue #161), the relay's side: every stream byte through an agent counted for its owner per
// UTC day, kept across a restart, a monthly cap the admin's key sets, an owner past it throttled (never refused) and
// told with a status message after the hello, and the admin's own owner never capped (Martin, 2026-11-06, Ledung
// questions #632 and #633). Real relay, real tunnels, phones as raw sockets, as in relay.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { forwardHead, hashSecret, parseRelayConfig, readUsage, Relay, writeUsage, type OwnerRow } from '../relay/relay.ts';
import { duplexPair } from 'node:stream';
import { decodeFrame, FRAME, MAX_CHUNK, Streams } from '../src/remote/mux.ts';
import { RelayAdmin } from '../src/remote/admin.ts';
import { Tunnel } from '../src/remote/tunnel.ts';
import { freePort, listenOk } from './free-port.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

const T = { timeout: HANG_MS };
const ADMIN_KEY = 'the admin key of the admin\'s Ledung';
const MINE = 'secret of the admin\'s own computer 0123456789';
const BOBS = 'secret of bob\'s computer 0123456789';
/** The throttle in these tests: 128 KiB/s, so a 384 KiB upload takes at least 3 s less AHEAD_MS. */
const RATE = 128 * 1024;
const BIG = 384 * 1024;
/** What the throttle lets ahead of the rate at most: 1 s of slack, one 64 KiB chunk, and its release 0.5 s early. */
const AHEAD_MS = 1000 + ((64 * 1024) / RATE) * 1000 + 500;
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-relay-cap-'));
  cleanup.push(() => removeTemp(dir));
  return dir;
}

const BOBS_LAPTOP = 'secret of bob\'s laptop 0123456789';

async function startRelay(opts: { usage?: string | null; now?: () => number; usageEveryMs?: number; bobsLaptop?: boolean } = {}) {
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(), bind: '127.0.0.1', adminKeySha256: hashSecret(ADMIN_KEY),
    limits: { capThrottleBytesPerSecond: RATE },
    agents: [
      { name: 'mine', owner: 'Martin', host: 'mine.relay.test', secretSha256: hashSecret(MINE) },
      { name: 'bobpc', owner: 'Bob', host: 'bob.relay.test', secretSha256: hashSecret(BOBS) },
      ...(opts.bobsLaptop ? [{ name: 'boblaptop', owner: 'Bob', host: 'boblaptop.relay.test', secretSha256: hashSecret(BOBS_LAPTOP) }] : []),
    ],
  });
  const relay = new Relay(config, (line) => lines.push(line), { usage: opts.usage ?? null, now: opts.now, usageEveryMs: opts.usageEveryMs });
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  const call = async (method: string, route: string, body?: unknown, key: string | null = ADMIN_KEY) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> & { error?: string } };
  };
  const owners = async (self?: string) => {
    const r = await call('GET', `/admin/owners${self ? `?self=${self}` : ''}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as unknown as { owners: OwnerRow[]; resetsOn: string };
  };
  const owner = async (name: string) => (await owners()).owners.find((o) => o.owner === name)!;
  const setCap = (name: string, cap: number | null) => call('POST', `/admin/owners/${encodeURIComponent(name)}/cap`, { cap });
  return { relay, port, lines, call, owners, owner, setCap };
}

async function waitFor(what: string, ok: () => boolean, ms = WAIT_MS): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ANSWER = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok', 'latin1');

/** A stand-in for a Ledung: reads one request with its whole body and answers ANSWER; keeps what it got. */
async function target() {
  const received: Buffer[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let got = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      const end = got.indexOf('\r\n\r\n');
      const length = Number(/content-length: (\d+)/i.exec(got.toString('latin1'))?.[1] ?? 0);
      if (end !== -1 && got.length >= end + 4 + length) {
        received.push(got);
        socket.end(ANSWER);
      }
    });
    socket.on('error', () => {});
  });
  await listenOk(server);
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as net.AddressInfo).port, received };
}

async function tunnel(relayPort: number, name: string, secret: string, targetPort: number): Promise<Tunnel> {
  const t = new Tunnel({
    relay: `ws://127.0.0.1:${relayPort}`, name, secret, publicName: `${name}.relay.test`, minDelayMs: 50, maxDelayMs: 200,
    connect: () => net.connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true }),
  });
  cleanup.push(() => t.stop());
  t.start();
  await waitFor(`${name} to connect`, () => t.status().state === 'connected');
  return t;
}

function head(host: string, length: number): string {
  return `POST /link/file HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`;
}

/**
 * What one transfer moves through the relay, worked out from what goes in: the head as the relay forwards it, the body,
 * and the answer. Nothing else crosses a stream.
 */
const counted = (host: string, body: Buffer) => Buffer.byteLength(forwardHead(head(host, body.length)), 'latin1') + body.length + ANSWER.length;

/** A phone (or another Ledung) sends `body` to `host` through the relay; the answer and how long it took. */
function transfer(port: number, host: string, body: Buffer): Promise<{ answer: Buffer; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(Buffer.concat([Buffer.from(head(host, body.length), 'latin1'), body])));
    const got: Buffer[] = [];
    socket.on('data', (c: Buffer) => got.push(c));
    socket.on('end', () => resolve({ answer: Buffer.concat(got), ms: Date.now() - t0 }));
    socket.on('error', reject);
  });
}

test('ledung#161: an owner under the cap goes at full speed, at the cap is throttled and told, a message still goes; the admin\'s own past any number never is; removing the cap lets go at once', T, async () => {
  const r = await startRelay();
  const t = await target();
  const mine = await tunnel(r.port, 'mine', MINE, t.port);
  const bob = await tunnel(r.port, 'bobpc', BOBS, t.port);

  // Uncapped until a number is set (question #633), and the bytes shown from day one.
  const first = await r.owners('mine');
  assert.deepEqual(first.owners.map((o) => [o.owner, o.you, o.cap, o.capped, o.computers]), [['Martin', true, null, false, 1], ['Bob', false, null, false, 1]], 'the admin\'s own first, marked you');
  const now = new Date();
  assert.equal(first.resetsOn, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10));

  // Under the cap: counted exactly, both ways, at full speed.
  const small = Buffer.alloc(50_000, 7);
  const under = await transfer(r.port, 'bob.relay.test', small);
  assert.deepEqual(under.answer, ANSWER);
  const once = counted('bob.relay.test', small);
  const sofar = once + counted('bob.relay.test', Buffer.alloc(BIG));
  // A cap one byte above what the next upload brings Bob to.
  assert.equal((await r.setCap('Bob', sofar + 1)).status, 200);
  assert.deepEqual(await r.owner('Bob'), { owner: 'Bob', computers: 1, today: once, month: once, cap: sofar + 1, capped: false, you: false });
  assert.equal(bob.status().relayCap, undefined, 'not capped: no cap in the tunnel\'s status');
  const fast = await transfer(r.port, 'bob.relay.test', Buffer.alloc(BIG, 1));
  assert.ok(fast.ms < 1000, `under the cap a ${BIG}-byte upload is not held (${fast.ms} ms)`);
  assert.deepEqual(await r.owner('Bob'), { owner: 'Bob', computers: 1, today: sofar, month: sofar, cap: sofar + 1, capped: false, you: false }, 'one byte under: not capped');
  assert.equal(bob.status().relayCap, undefined);
  // Exactly at the cap: the cap set to what Bob has moved so far.
  assert.equal((await r.setCap('Bob', sofar)).status, 200);
  const at = await r.owner('Bob');
  assert.equal(at.capped, true, 'reaching the cap is past it');
  await waitFor('Bob\'s Ledung to be told', () => !!bob.status().relayCap);
  assert.deepEqual(bob.status().relayCap, { resetsOn: first.resetsOn }, 'the status message after the hello says until when');
  assert.equal(mine.status().relayCap, undefined, 'the admin\'s own Ledung is not told anything');
  assert.ok(r.lines.some((l) => / owner capped owner="Bob"/.test(l)), r.lines.join('\n'));
  assert.equal(r.lines.filter((l) => /EXERCISED #161 relay throttled an owner past their monthly cap$/.test(l)).length, 1);

  // A message of a few KB still goes, and quickly: never refused.
  const message = await transfer(r.port, 'bob.relay.test', Buffer.alloc(3000, 2));
  assert.deepEqual(message.answer, ANSWER);
  assert.ok(message.ms < 1000, `a message is not held (${message.ms} ms)`);
  // A file crawls at the throttle rate: at least its bytes at the rate, less what the throttle lets ahead.
  // Twice BIG, so the bound (6 s less AHEAD_MS) also fails a throttle running at 1.5 times the rate (test review of PR #173).
  const slow = await transfer(r.port, 'bob.relay.test', Buffer.alloc(BIG * 2, 3));
  assert.deepEqual(slow.answer, ANSWER, 'throttled, not refused');
  assert.ok(slow.ms >= ((BIG * 2) / RATE) * 1000 - AHEAD_MS, `held to the rate (${slow.ms} ms)`);

  // The admin's own computers past any number: a cap can't be set, and a large month is never throttled.
  const refused = await r.setCap('Martin', 1);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error!, /your own computers; they are never capped/);
  for (let i = 0; i < 3; i++) assert.ok((await transfer(r.port, 'mine.relay.test', Buffer.alloc(BIG, 4))).ms < 1000, 'the admin\'s own at full speed');
  const martin = await r.owner('Martin');
  assert.ok(martin.month > sofar, 'and more than Bob\'s cap');
  assert.equal(martin.cap, null);
  assert.equal(martin.capped, false);

  // Removing the cap lets an upload that is being held go at once, and tells Bob's Ledung.
  const held = transfer(r.port, 'bob.relay.test', Buffer.alloc(BIG * 4, 5));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await r.setCap('Bob', null)).status, 200);
  const freed = await held;
  assert.ok(freed.ms < (BIG * 4 / RATE) * 1000 - 3000, `let go once the cap went (${freed.ms} ms, held it would be ${(BIG * 4 / RATE) * 1000} ms)`);
  await waitFor('Bob\'s Ledung to hear the cap is lifted', () => !bob.status().relayCap);
  assert.equal((await r.owner('Bob')).capped, false);
  assert.ok(r.lines.some((l) => / owner cap lifted owner="Bob"/.test(l)));
});

test('ledung#161: a computer that connects while its owner is capped is told after the hello and throttled at once', T, async () => {
  const r = await startRelay();
  const t = await target();
  await r.owners('mine');
  await tunnel(r.port, 'mine', MINE, t.port);
  await transfer(r.port, 'mine.relay.test', Buffer.alloc(1000));
  // Bob has no bytes yet; a cap of 1 byte is reached by his first connection's first bytes.
  assert.equal((await r.setCap('Bob', 1)).status, 200);
  const bob = await tunnel(r.port, 'bobpc', BOBS, t.port);
  assert.equal(bob.status().relayCap, undefined, 'under the cap: nothing said');
  await transfer(r.port, 'bob.relay.test', Buffer.alloc(10));
  await waitFor('the cap', () => !!bob.status().relayCap);
  // Connecting again while capped: the status comes with the hello.
  bob.stop();
  const again = await tunnel(r.port, 'bobpc', BOBS, t.port);
  await waitFor('the status after the hello', () => !!again.status().relayCap);
  const slow = await transfer(r.port, 'bob.relay.test', Buffer.alloc(BIG, 3));
  assert.ok(slow.ms >= (BIG / RATE) * 1000 - AHEAD_MS, `throttled from the start (${slow.ms} ms)`);
});

test('ledung#161: a capped owner\'s computers are each held to the rate on their own, not to one rate shared between them', T, async () => {
  const r = await startRelay({ bobsLaptop: true });
  const t = await target();
  const pc = await tunnel(r.port, 'bobpc', BOBS, t.port);
  const laptop = await tunnel(r.port, 'boblaptop', BOBS_LAPTOP, t.port);
  assert.equal((await r.setCap('Bob', 1)).status, 200);
  await transfer(r.port, 'bob.relay.test', Buffer.alloc(10));
  await waitFor('both of Bob\'s Ledungs to be told', () => !!pc.status().relayCap && !!laptop.status().relayCap);
  assert.equal((await r.owner('Bob')).computers, 2);
  // Both at once. Each on its own budget takes its bytes at the rate; one budget shared would take both sets of bytes.
  const size = BIG * 2;
  const own = (size / RATE) * 1000;
  const [a, b] = await Promise.all([transfer(r.port, 'bob.relay.test', Buffer.alloc(size, 1)), transfer(r.port, 'boblaptop.relay.test', Buffer.alloc(size, 2))]);
  for (const [name, x] of [['the PC', a], ['the laptop', b]] as const) {
    assert.deepEqual(x.answer, ANSWER);
    assert.ok(x.ms >= own - AHEAD_MS, `${name} is held to the rate (${x.ms} ms)`);
    assert.ok(x.ms < 2 * own - AHEAD_MS, `${name} has the whole rate, not half of one shared with the other (${x.ms} ms, shared it would be at least ${2 * own - AHEAD_MS} ms)`);
  }
});

test('ledung#161: the counts and caps survive a restart, and are written about once a minute without one', T, async () => {
  const dir = tempDir();
  const usage = path.join(dir, 'relay.usage.json');
  const a = await startRelay({ usage, usageEveryMs: 50 });
  const t = await target();
  await tunnel(a.port, 'bobpc', BOBS, t.port);
  const body = Buffer.alloc(20_000, 9);
  await transfer(a.port, 'bob.relay.test', body);
  assert.equal((await a.setCap('Bob', 5_000_000)).status, 200);
  // Written by the timer, without a close: a crash keeps what was counted up to the last minute.
  const expected = counted('bob.relay.test', body);
  await waitFor('the timer to write', () => fs.existsSync(usage) && Object.values(readUsage(usage).owners.find((o) => o.owner === 'Bob')?.days ?? {}).includes(expected));
  const before = await a.owner('Bob');
  assert.equal(before.month, expected);
  await a.relay.close();

  const b = await startRelay({ usage });
  assert.deepEqual(await b.owner('Bob'), before, 'the same today, month and cap after the restart');
  if (process.platform !== 'win32') assert.equal(fs.statSync(usage).mode & 0o777, 0o600, 'private to the relay\'s user, as its store is');
});

test('ledung#161: a cap written by hand for the admin\'s own owner is ignored with a log line; one for another owner applies', T, async () => {
  const dir = tempDir();
  const usage = path.join(dir, 'relay.usage.json');
  const today = new Date().toISOString().slice(0, 10);
  writeUsage(usage, { owners: [{ owner: 'Martin', cap: 10, days: { [today]: 1_000_000 } }, { owner: 'Bob', cap: 10, days: { [today]: 1_000_000 } }], admin: 'Martin', logged: today });
  const r = await startRelay({ usage });
  assert.ok(r.lines.some((l) => / cap ignored owner="Martin" reason="the admin's own computers are never capped"/.test(l)), r.lines.join('\n'));
  const rows = (await r.owners()).owners;
  assert.deepEqual(rows.map((o) => [o.owner, o.you, o.cap, o.capped]), [['Martin', true, null, false], ['Bob', false, 10, true]], 'Martin\'s ignored, Bob\'s applied');
  assert.ok(!r.lines.some((l) => /cap ignored owner="Bob"/.test(l)));
});

test('ledung#161: the log has each owner\'s total once a day and never what went through', T, async () => {
  let clock = Date.parse('2026-11-06T23:59:00Z');
  const r = await startRelay({ now: () => clock, usageEveryMs: 30 });
  const t = await target();
  await tunnel(r.port, 'bobpc', BOBS, t.port);
  const body = Buffer.from('MARKER-OF-WHAT-GOES-THROUGH '.repeat(100), 'latin1');
  await transfer(r.port, 'bob.relay.test', body);
  assert.ok(t.received[0]!.includes(Buffer.from('MARKER-OF-WHAT-GOES-THROUGH')), 'the content went through');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!r.lines.some((l) => / owner bytes /.test(l)), 'nothing logged within the day');
  clock = Date.parse('2026-11-07T00:00:30Z');
  await waitFor('the day\'s totals', () => r.lines.some((l) => / owner bytes /.test(l)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const totals = r.lines.filter((l) => / owner bytes /.test(l));
  const bytes = counted('bob.relay.test', body);
  assert.deepEqual(totals.map((l) => l.replace(/^\S+ /, '')), [`owner bytes owner="Bob" day="2026-11-06" bytes="${bytes}" month="${bytes}"`], 'once, for the day that ended');
  assert.ok(!r.lines.some((l) => l.includes('MARKER')), 'no content in the log');
  assert.equal((await r.owner('Bob')).today, 0, 'a new day starts at 0');
  assert.equal((await r.owner('Bob')).month, bytes, 'in the same month');
});

test('ledung#161: the owners API needs the admin key and checks the cap', T, async () => {
  const r = await startRelay();
  assert.equal((await r.call('GET', '/admin/owners', undefined, null)).status, 401);
  assert.equal((await r.call('POST', '/admin/owners/Bob/cap', { cap: 1 }, 'wrong key')).status, 401);
  for (const cap of [0, -1, 1.5, '10', 2e15]) assert.equal((await r.setCap('Bob', cap as number)).status, 400, `cap ${cap}`);
  assert.equal((await r.setCap('Nobody', 1)).status, 404);
  assert.equal((await r.setCap('Bob', 1_000)).status, 200, 'the positive branch: a good cap is taken');
  assert.equal((await r.owner('Bob')).cap, 1_000);
});

test('ledung#161: the admin\'s Ledung reads the owners and sets caps; it is "you" only on the relay it is itself on', T, async () => {
  const r = await startRelay();
  const relayUrl = `ws://127.0.0.1:${r.port}`;
  const admin = (self: { relay: string; name: string } | null) => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'relay-admin.json'), JSON.stringify({ relay: relayUrl, adminKey: ADMIN_KEY }));
    return new RelayAdmin({ dir, onComputers: () => {}, self: () => self, log: () => {} });
  };
  // On another relay under the same name: not told, so nobody is "you" here.
  const elsewhere = await admin({ relay: 'wss://another-relay.example.org', name: 'mine' }).owners();
  assert.deepEqual(elsewhere.owners.map((o) => [o.owner, o.you]), [['Bob', false], ['Martin', false]]);
  // On this relay as "mine": Martin is "you", and the relay keeps it.
  const here = admin({ relay: relayUrl, name: 'mine' });
  assert.deepEqual((await here.owners()).owners.map((o) => [o.owner, o.you]), [['Martin', true], ['Bob', false]]);
  const capped = await here.setCap('Bob', 2 * 1024 ** 3);
  assert.equal(capped.owners.find((o) => o.owner === 'Bob')!.cap, 2 * 1024 ** 3);
  await assert.rejects(here.setCap('Martin', 1024), /never capped/);
  await assert.rejects(here.setCap('Bob', 0), /whole number of bytes above 0/);
  assert.equal((await here.setCap('Bob', null)).owners.find((o) => o.owner === 'Bob')!.cap, null);
  assert.equal((await r.owner('Martin')).you, true, 'the relay remembers who the admin is');
});

test('ledung#161: under a throttle the other side is asked to pause, and a stream whose sender ignores it is reset', () => {
  const run = (rate: number) => {
    const frames: { kind: number; id: number }[] = [];
    const counted: number[] = [];
    const streams = new Streams({ send: (data: Buffer) => void frames.push(decodeFrame(data)!), bufferedAmount: 0 }, { onBytes: (n) => counted.push(n) });
    // A buffer large enough that the socket's own backpressure never pauses: only the throttle may.
    const [here, there] = duplexPair({ highWaterMark: 16 * 1024 * 1024 });
    there.resume();
    streams.attach(7, here);
    streams.throttle(rate);
    // Six full frames from a sender that keeps going after the pause.
    for (let i = 0; i < 6; i++) streams.receive(FRAME.data, 7, Buffer.alloc(MAX_CHUNK));
    streams.closeAll();
    return { kinds: frames.filter((f) => f.id === 7).map((f) => f.kind), counted, open: streams.has(7) };
  };
  // 1 KiB/s: the first 64 KiB is 64 s ahead, past the one-second slack, so pause; the fifth is 320 s, past five minutes.
  const ignored = run(1024);
  assert.deepEqual(ignored.kinds, [FRAME.pause, FRAME.reset], 'asked to pause, then reset when it kept sending');
  assert.equal(ignored.counted.length, 5, 'counted up to the frame that reset it; nothing after');
  // The positive branch: at a rate the six frames fit in (1 MiB/s, 384 KiB), no pause and no reset.
  const fits = run(1024 * 1024);
  assert.deepEqual(fits.kinds, []);
  assert.equal(fits.counted.reduce((a, b) => a + b, 0), 6 * MAX_CHUNK, 'every byte counted');
});
