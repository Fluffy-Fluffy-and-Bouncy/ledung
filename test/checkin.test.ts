// The anonymous daily check-in (#220): nothing is sent with the switch off or DO_NOT_TRACK set, at most one send a
// day, and the payload holds the four fields {id, version, channel, os} and nothing else. Each "nothing sent" test
// sends from the same setup with the one thing changed, so a send that never runs can't pass it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CheckIn, DAY_MS, ID_KEY, LAST_KEY, NOTICE_KEY, SWITCH_KEY, doNotTrack, type CheckInOptions, type CheckInPayload } from '../src/update/checkin.ts';

const URL_ = 'http://127.0.0.1:9/v1/checkin';
const T0 = Date.parse('2026-11-11T12:00:00Z');
const HOUR = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function memory(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}

/** A check-in whose notice was answered (OK), with the clock and the send under the test's hand. */
function setup(over: Partial<CheckInOptions> & { meta?: ReturnType<typeof memory> } = {}) {
  const meta = over.meta ?? memory({ [NOTICE_KEY]: 'seen' });
  const sent: CheckInPayload[] = [];
  let now = T0;
  const c = new CheckIn({
    version: '2.1.0', channel: () => 'dev', os: 'win32', env: {}, packaged: true, url: URL_,
    send: async (_url, payload) => void sent.push(payload),
    now: () => now,
    ...over,
    meta,
  });
  return { c, meta, sent, at: (t: number) => { now = t; } };
}

test('with the switch on it sends; switched off in Settings it sends nothing', async () => {
  const on = setup();
  assert.equal(await on.c.maybeSend(), true);
  assert.equal(on.sent.length, 1);

  const off = setup();
  off.c.act('off');
  assert.equal(off.meta.map.get(SWITCH_KEY), 'off');
  assert.equal(await off.c.maybeSend(), false);
  assert.equal(off.sent.length, 0);
  assert.equal(off.c.view().sends, false);
  // Switched on again, it sends.
  off.c.act('on');
  assert.equal(await off.c.maybeSend(), true);
  assert.equal(off.sent.length, 1);
});

test('DO_NOT_TRACK=1 sends nothing whatever the switch says; unset, 0 or empty it sends', async () => {
  const dnt = setup({ env: { DO_NOT_TRACK: '1' } });
  assert.equal(dnt.c.on(), true, 'the switch itself is still on');
  assert.equal(await dnt.c.maybeSend(), false);
  assert.equal(dnt.sent.length, 0);
  assert.equal(dnt.c.view().doNotTrack, true);

  for (const env of [{}, { DO_NOT_TRACK: '0' }, { DO_NOT_TRACK: '' }]) {
    const s = setup({ env });
    assert.equal(await s.c.maybeSend(), true, JSON.stringify(env));
    assert.equal(s.sent.length, 1);
  }
  assert.equal(doNotTrack({ DO_NOT_TRACK: 'true' }), true);
  assert.equal(doNotTrack({ DO_NOT_TRACK: 'false' }), false);
});

test('at most one send a day: not again within 24 hours, again after', async () => {
  const s = setup();
  assert.equal(await s.c.maybeSend(), true);
  s.at(T0 + HOUR);
  assert.equal(await s.c.maybeSend(), false);
  s.at(T0 + DAY_MS - 1);
  assert.equal(await s.c.maybeSend(), false);
  assert.equal(s.sent.length, 1);
  s.at(T0 + DAY_MS);
  assert.equal(await s.c.maybeSend(), true);
  assert.equal(s.sent.length, 2);
  // The day is kept in the database, so a restart doesn't send again.
  const again = setup({ meta: s.meta });
  again.at(T0 + DAY_MS + HOUR);
  assert.equal(await again.c.maybeSend(), false);
  assert.equal(again.sent.length, 0);
});

test('a failed send still waits a day before the next try', async () => {
  let tries = 0;
  const s = setup({ send: async () => { tries++; throw new Error('offline'); } });
  assert.equal(await s.c.maybeSend(), false);
  s.at(T0 + HOUR);
  assert.equal(await s.c.maybeSend(), false);
  assert.equal(tries, 1);
  s.at(T0 + DAY_MS);
  await s.c.maybeSend();
  assert.equal(tries, 2);
});

test('a database that throws (busy, disk full) makes the look return false, never reject; once it works it sends', async () => {
  // The timers call maybeSend unawaited, so a rejection here would be unhandled and stop Ledung (review of PR #223, S1).
  for (const failing of ['get', 'set'] as const) {
    const meta = memory({ [NOTICE_KEY]: 'seen', [ID_KEY]: '11111111-1111-4111-8111-111111111111' });
    let broken = true;
    const real = meta[failing];
    meta[failing] = ((k: string, v: string) => {
      if (broken && k === LAST_KEY) throw new Error('SQLITE_BUSY: database is locked');
      return real(k, v);
    }) as never;
    const s = setup({ meta });
    assert.equal(await s.c.maybeSend(), false, `${failing} throwing`);
    assert.equal(s.sent.length, 0);
    broken = false;
    assert.equal(await s.c.maybeSend(), true, `${failing} working again`);
    assert.equal(s.sent.length, 1);
  }
});

test('nothing is sent until the notice is answered; OK lets it send', async () => {
  const s = setup({ meta: memory() });
  assert.equal(s.c.view().notice, true);
  assert.equal(await s.c.maybeSend(), false);
  assert.equal(s.sent.length, 0);
  s.c.act('seen');
  assert.equal(s.c.view().notice, false);
  assert.equal(s.c.on(), true, 'OK leaves it on');
  assert.equal(await s.c.maybeSend(), true);
  assert.equal(s.sent.length, 1);
});

test('a Ledung run from source sends nothing; the npm package does', async () => {
  const source = setup({ packaged: false, url: undefined });
  assert.equal(await source.c.maybeSend(), false);
  assert.equal(source.c.view().fromPackage, false);
  assert.equal(source.sent.length, 0);
  const pkg = setup({ packaged: true, url: undefined });
  assert.equal(await pkg.c.maybeSend(), true);
  assert.equal(pkg.sent.length, 1);
});

test('the install ID is random, made once at start, and kept', () => {
  const a = setup({ meta: memory() });
  assert.equal(a.meta.map.has(ID_KEY), false);
  a.c.start();
  a.c.stop();
  const id = a.meta.map.get(ID_KEY)!;
  assert.match(id, UUID);
  assert.equal(new CheckIn({ meta: a.meta, version: '2.1.0', channel: () => 'public', packaged: true }).id(), id);
  const b = setup({ meta: memory() });
  assert.notEqual(b.c.id(), id);
});

const servers: http.Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('what goes over the wire is a JSON POST of exactly id, version, channel and os', async () => {
  const bodies: { method?: string; type?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      bodies.push({ method: req.method, type: req.headers['content-type'], body });
      res.writeHead(204).end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/checkin`;
  // The real send (no replacement), as the npm package makes it.
  const s = setup({ url, send: undefined });
  assert.equal(await s.c.maybeSend(), true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.method, 'POST');
  assert.equal(bodies[0]!.type, 'application/json');
  const sent = JSON.parse(bodies[0]!.body);
  assert.deepEqual(Object.keys(sent).sort(), ['channel', 'id', 'os', 'version']);
  assert.deepEqual(sent, { id: s.meta.map.get(ID_KEY), version: '2.1.0', channel: 'dev', os: 'win32' });
  assert.ok(s.meta.map.get(LAST_KEY), 'the day of the send is kept');
});
