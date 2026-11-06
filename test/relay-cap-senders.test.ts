// A capped owner's sends to the admin's own computers (issue #176, follow-up of #161): bytes a capped owner's computer
// sends to one of the admin's computers count for the admin, whose computer was dialled, so #161's throttle never saw
// them. The admin's Ledung tells the relay which linked computer a stream comes from, and the relay holds that stream,
// in the way from the capped computer only, at the throttle rate the relay ships with. Real relay, real tunnels, the
// computers that dial as raw sockets, as in relay-cap.test.ts. The Ledung's side (the report from the linked key, the
// refusal) is relay-cap-senders-ledung.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { duplexPair, type Duplex } from 'node:stream';
import { hashSecret, parseRelayConfig, Relay, type OwnerRow } from '../relay/relay.ts';
import { cappedSenders, cappedSendersMessage, senderMessage, senderOf } from '../src/remote/mux.ts';
import { Tunnel } from '../src/remote/tunnel.ts';
import { freePort } from './free-port.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

const T = { timeout: HANG_MS };
const ADMIN_KEY = 'the admin key of the admin\'s Ledung';
const SECRETS = { mine: 'secret of the admin\'s own computer 0123456789', bobpc: 'secret of bob\'s computer 0123456789', carolpc: 'secret of carol\'s computer 0123456789' };
/** The rate the relay ships with (relay.ts DEFAULT_LIMITS, #161 refine notes): these tests never set their own. */
const SHIPPED = 64 * 1024;
const BIG = 384 * 1024;
/** BIG at the shipped rate: 6 s. */
const HELD_MS = (BIG / SHIPPED) * 1000;
/** What the throttle lets ahead of the rate at most: 1 s of slack, one 64 KiB read, and its release 0.5 s early. */
const AHEAD_MS = 1000 + ((64 * 1024) / SHIPPED) * 1000 + 500;
/** Not held: well under what the throttle would take (HELD_MS less AHEAD_MS is 3.5 s). */
const FREE_MS = 1500;

const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function waitFor(what: string, ok: () => boolean, ms = WAIT_MS): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startRelay() {
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(), bind: '127.0.0.1', adminKeySha256: hashSecret(ADMIN_KEY),
    agents: [
      { name: 'mine', owner: 'Martin', host: 'mine.relay.test', secretSha256: hashSecret(SECRETS.mine) },
      { name: 'bobpc', owner: 'Bob', host: 'bob.relay.test', secretSha256: hashSecret(SECRETS.bobpc) },
      { name: 'carolpc', owner: 'Carol', host: 'carol.relay.test', secretSha256: hashSecret(SECRETS.carolpc) },
    ],
  });
  assert.equal(config.limits.capThrottleBytesPerSecond, SHIPPED, 'the shipped rate');
  const relay = new Relay(config, (line) => lines.push(line), { usage: null });
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { authorization: `Bearer ${ADMIN_KEY}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { owners: OwnerRow[] } & OwnerRow };
  };
  // The admin's Ledung reads the owners as "mine": Martin is the admin's own from then on (#161).
  assert.equal((await call('GET', '/admin/owners?self=mine')).status, 200);
  const setCap = async (owner: string, cap: number | null) => assert.equal((await call('POST', `/admin/owners/${owner}/cap`, { cap })).status, 200);
  return { port, lines, setCap };
}

/**
 * A stand-in for a Ledung's server on one stream: reads a request with its body, and on its head tells the relay who
 * it comes from when the head names one in X-Test-From, as Ledung does from the linked key (server.ts linkRoute). It
 * answers with X-Test-Answer bytes.
 */
function serve(socket: Duplex, sender?: (host: string) => void): void {
  let got = Buffer.alloc(0);
  let told = false;
  socket.on('data', (chunk: Buffer) => {
    got = Buffer.concat([got, chunk]);
    const end = got.indexOf('\r\n\r\n');
    if (end === -1) return;
    const head = got.subarray(0, end).toString('latin1');
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'im').exec(head)?.[1]?.trim();
    const from = field('x-test-from');
    if (from && !told) {
      told = true;
      sender?.(from);
    }
    if (got.length < end + 4 + Number(field('content-length') ?? 0)) return;
    const answer = Buffer.alloc(Number(field('x-test-answer') ?? 2), 7);
    socket.removeAllListeners('data');
    // Written a piece at a time and only as fast as it is taken, as a server does: a pause from the relay holds it.
    let at = 0;
    const pump = () => {
      while (at < answer.length) {
        const piece = answer.subarray(at, at + 16 * 1024);
        at += piece.length;
        if (!socket.write(piece)) return void socket.once('drain', () => setImmediate(pump));
      }
      socket.end();
    };
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${answer.length}\r\nConnection: close\r\n\r\n`, 'latin1');
    setImmediate(pump);
  });
  socket.on('error', () => {});
}

async function tunnel(relayPort: number, name: keyof typeof SECRETS): Promise<Tunnel> {
  const t = new Tunnel({
    relay: `ws://127.0.0.1:${relayPort}`, name, secret: SECRETS[name], publicName: `${name}.relay.test`, minDelayMs: 50, maxDelayMs: 200,
    connect: (sender) => {
      const [ours, theirs] = duplexPair();
      serve(ours, sender);
      return theirs;
    },
  });
  cleanup.push(() => t.stop());
  t.start();
  await waitFor(`${name} to connect`, () => t.status().state === 'connected');
  return t;
}

/**
 * A computer dials `host` through the relay and sends `body`, naming itself as `from`. The head goes first and the body
 * 300 ms later, by when the relay has been told who the stream comes from, as with a Ledung whose request head (and
 * TLS handshake) comes before its body. `ms`: from the body's first byte to the answer's last.
 */
function transfer(port: number, host: string, body: Buffer, opts: { from?: string; answer?: number } = {}): Promise<{ answer: Buffer; ms: number }> {
  const head = `POST /link/file HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n`
    + `${opts.from ? `X-Test-From: ${opts.from}\r\n` : ''}${opts.answer ? `X-Test-Answer: ${opts.answer}\r\n` : ''}\r\n`;
  return new Promise((resolve, reject) => {
    let t0 = 0;
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(head, 'latin1');
      setTimeout(() => {
        t0 = Date.now();
        socket.end(body);
      }, 300);
    });
    const got: Buffer[] = [];
    socket.on('data', (c: Buffer) => got.push(c));
    socket.on('end', () => {
      const all = Buffer.concat(got);
      resolve({ answer: all.subarray(all.indexOf('\r\n\r\n') + 4), ms: Date.now() - t0 });
    });
    socket.on('error', reject);
  });
}

/** Bob over his cap, and the admin's Ledung told so. */
async function capBob(r: Awaited<ReturnType<typeof startRelay>>, mine: Tunnel): Promise<void> {
  await r.setCap('Bob', 1);
  await transfer(r.port, 'bob.relay.test', Buffer.alloc(10));
  await waitFor('the admin\'s Ledung to be told Bob\'s computer is capped', () => !!mine.status().cappedSenders);
}

test('the sender and capped-senders messages read back what was written, and nothing else', () => {
  assert.deepEqual(senderOf(senderMessage(7, 'Bob.Relay.Test')), { id: 7, host: 'bob.relay.test' });
  assert.deepEqual(cappedSenders(cappedSendersMessage(['bob.relay.test'], '2026-12-01')), { hosts: ['bob.relay.test'], resetsOn: '2026-12-01' });
  for (const text of ['', 'not json', '{"type":"sender","id":"7","host":"x"}', '{"type":"hello","version":1}', '{"type":"cap","reached":true,"resetsOn":"2026-12-01"}']) {
    assert.equal(senderOf(text), null, text);
    assert.equal(cappedSenders(text), null, text);
  }
});

test('ledung#176: with Bob capped, what his computer sends one of the admin\'s computers is held to the shipped rate; the admin\'s Ledung is told his host, Bob\'s is not', T, async () => {
  const r = await startRelay();
  const mine = await tunnel(r.port, 'mine');
  const bob = await tunnel(r.port, 'bobpc');
  await capBob(r, mine);
  assert.deepEqual(mine.status().cappedSenders?.hosts, ['bob.relay.test']);
  assert.equal(bob.status().cappedSenders, undefined, 'only the admin\'s own computers are told');
  assert.equal(mine.status().relayCap, undefined, 'the admin\'s own owner is still not capped');

  const slow = await transfer(r.port, 'mine.relay.test', Buffer.alloc(BIG, 1), { from: 'bob.relay.test' });
  assert.equal(slow.answer.length, 2, 'held, not refused');
  assert.ok(slow.ms >= HELD_MS - AHEAD_MS, `held to 64 KiB/s (${slow.ms} ms, at least ${HELD_MS - AHEAD_MS} ms)`);
  assert.equal(r.lines.filter((l) => /EXERCISED #176 relay throttled a capped owner's stream to the admin's own computer$/.test(l)).length, 1, r.lines.join('\n'));

  // The cap lifted: the admin's Ledung hears that no sender is capped, and the same upload goes at full speed.
  await r.setCap('Bob', null);
  await waitFor('the admin\'s Ledung to hear no sender is capped', () => !mine.status().cappedSenders);
  const freed = await transfer(r.port, 'mine.relay.test', Buffer.alloc(BIG, 1), { from: 'bob.relay.test' });
  assert.ok(freed.ms < FREE_MS, `not held once the cap is lifted (${freed.ms} ms)`);
});

test('ledung#176: with Bob uncapped, what his computer sends one of the admin\'s computers goes at full speed', T, async () => {
  const r = await startRelay();
  const mine = await tunnel(r.port, 'mine');
  await tunnel(r.port, 'bobpc');
  await transfer(r.port, 'bob.relay.test', Buffer.alloc(10));
  const fast = await transfer(r.port, 'mine.relay.test', Buffer.alloc(BIG, 2), { from: 'bob.relay.test' });
  assert.equal(fast.answer.length, 2);
  assert.ok(fast.ms < FREE_MS, `not held (${fast.ms} ms)`);
  assert.equal(mine.status().cappedSenders, undefined, 'and nothing told');
});

test('ledung#176: the admin\'s computers to a capped Bob are held as in #161, but what they answer him is never held', T, async () => {
  const r = await startRelay();
  const mine = await tunnel(r.port, 'mine');
  await tunnel(r.port, 'bobpc');
  await capBob(r, mine);
  // The admin's computer dials Bob's: through Bob's own computer on the relay, held both ways (#161, unchanged).
  const toBob = await transfer(r.port, 'bob.relay.test', Buffer.alloc(BIG, 3));
  assert.ok(toBob.ms >= HELD_MS - AHEAD_MS, `to Bob's computer: held as in #161 (${toBob.ms} ms)`);
  // Bob's computer dials the admin's and is answered with 4 BIG, 24 s at the rate: the way from the admin's computer is
  // not held.
  const answer = await transfer(r.port, 'mine.relay.test', Buffer.alloc(10), { from: 'bob.relay.test', answer: 4 * BIG });
  assert.equal(answer.answer.length, 4 * BIG);
  assert.ok(answer.ms < FREE_MS, `the admin's answer to a capped computer is not held (${answer.ms} ms)`);
});

test('ledung#176: only the admin\'s own computers are believed about who a stream comes from', T, async () => {
  const r = await startRelay();
  const mine = await tunnel(r.port, 'mine');
  await tunnel(r.port, 'bobpc');
  const carol = await tunnel(r.port, 'carolpc');
  await capBob(r, mine);
  assert.equal(carol.status().cappedSenders, undefined, 'Carol is not told who is capped');
  // Carol's Ledung says the stream is from capped Bob: not hers to say, so not held.
  const toCarol = await transfer(r.port, 'carol.relay.test', Buffer.alloc(BIG, 4), { from: 'bob.relay.test' });
  assert.ok(toCarol.ms < FREE_MS, `a report from another owner's computer is ignored (${toCarol.ms} ms)`);
  // The positive branch: the same report from the admin's own computer holds it.
  const toMine = await transfer(r.port, 'mine.relay.test', Buffer.alloc(BIG, 4), { from: 'bob.relay.test' });
  assert.ok(toMine.ms >= HELD_MS - AHEAD_MS, `the admin's own report holds it (${toMine.ms} ms)`);
});
