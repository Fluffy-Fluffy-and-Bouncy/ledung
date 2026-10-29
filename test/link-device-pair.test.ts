// Pair through the link (issue #273, docs/steps/computer-tabs-link.md part 2; Martin's manager's decision on question
// #222, a: a confirm dialog on the framing computer's own page). The Mac's own page asks the linked PC for a pairing
// code for the frame it shows. Started only locally with the open page; answered by the PC only for a link key; a
// computer code only; at most one per computer every 10 minutes; read-only until passkey and log on; shown on the PC.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, keyFor, LinkedNodes, until, type Node } from './linked-nodes.ts';
import { FakePasskey } from './fake-passkey.ts';

const nodes = new LinkedNodes();
after(() => nodes.close());

let n = 0;
/** A linked Mac and PC. */
async function pair() {
  n++;
  const mac = await nodes.ledung(`mac${n}.pair.test`);
  const pc = await nodes.ledung(`pc${n}.pair.test`);
  // The code is the Mac's, used on the PC, which names the Mac as Martin types it there.
  await nodes.link(mac, pc, 'Mac');
  const pcPage = await nodes.page(pc);
  const macPage = await nodes.page(mac);
  return { mac, pc, macPage, pcPage, macName: 'Mac' };
}

/** The pairing form in the frame, as the browser posts it from inside a frame on the Mac's page. */
async function pairInFrame(pc: Node, url: string, name = 'Mac browser') {
  const code = new URL(url).pathname.slice('/p/'.length);
  return nodes.viaTunnel(pc.name, '/pair', {
    body: new URLSearchParams({ code, name }).toString(),
    headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-dest': 'iframe' },
  });
}

test('the Mac\'s own page pairs its frame of the PC through the link: a read-only computer device, shown on the PC', { timeout: 20_000 }, async () => {
  const { mac, pc, macPage, pcPage, macName } = await pair();
  // The Mac's page knows the PC's tab is a linked computer's, so it offers Pair through the link there.
  assert.equal(((await macPage('GET', 'state')).json.computers as { id: string; linked?: boolean }[]).find((c) => c.id === pc.name)?.linked, true);

  const started = await macPage('POST', 'link-device-pair', { id: pc.name });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  // The address is the PC's own public name; only the code came from the PC.
  assert.match(started.json.url, new RegExp(`^https://${pc.name.replace(/\./g, '\\.')}/p/[0-9a-z]{20}$`));

  // The PC shows it at once in Waiting for you, before anyone has paired.
  await until(() => pcPage.events.some((e) => e.type === 'linkPairings' && e.pairings.length === 1 && e.pairings[0]!.device === null), 'the PC\'s notice');
  const [notice] = (await pcPage('GET', 'state')).json.linkPairings;
  assert.equal(notice.computer, macName);

  // The frame opens the PC's pairing form, named for a browser on the Mac.
  const form = await nodes.viaTunnel(pc.name, new URL(started.json.url).pathname, { method: 'GET' });
  assert.equal(form.status, 200);
  assert.match(form.body, new RegExp(`value="Browser on ${macName}"`));
  const done = await pairInFrame(pc, started.json.url);
  assert.equal(done.status, 303, done.body);
  // The frame's own cookie, as for any pairing in a frame (#241).
  assert.match(String(done.headers['set-cookie']), /SameSite=None; Partitioned/);
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;

  // A computer, marked as paired through the link from the Mac, on the PC's device list.
  const device = pc.server.devices.byCookie(cookie.split('=')[1]!)!;
  assert.equal(device.kind, 'computer');
  assert.equal(device.pairedVia, macName);
  const listed = (await pcPage('GET', 'devices')).json.devices.find((d: { id: string }) => d.id === device.id);
  assert.equal(listed.pairedVia, macName);
  // The notice now names the device.
  await until(async () => (await pcPage('GET', 'state')).json.linkPairings[0]?.device?.id === device.id, 'the notice to name the device');

  // It can look, and change nothing: no passkey and not logged on.
  const pub = (method: string, route: string, body?: string) => nodes.viaTunnel(pc.name, `/api/${route}`, { method, body, headers: { cookie, origin: `https://${pc.name}` } });
  assert.equal((await pub('GET', 'state')).status, 200);
  const change = await pub('POST', 'computers', JSON.stringify({ id: pc.name, name: 'Hacked' }));
  assert.equal(change.status, 403);
  assert.match(JSON.parse(change.body).error, /no passkey, so it can only look/);
  // The PC's notices are this computer's: not through the public name.
  assert.deepEqual(JSON.parse((await pub('GET', 'state')).body).linkPairings, []);

  // OK on the PC takes the card away; the device stays.
  assert.equal((await pcPage('POST', `link-pairings/${notice.id}/dismiss`, {})).status, 200);
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, []);
  assert.ok(pc.server.devices.byCookie(cookie.split('=')[1]!));
  void mac;
});

test('starting needs this computer\'s own open page: never through its public name, never without the page key', { timeout: 20_000 }, async () => {
  const { mac, pc, macPage } = await pair();
  // Without the open page's key (the install token alone).
  const noKey = await fetch(`http://127.0.0.1:${mac.port}/api/link-device-pair`, {
    method: 'POST', headers: { cookie: COOKIE, origin: `http://127.0.0.1:${mac.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: pc.name }),
  });
  assert.equal(noKey.status, 403);
  // Through the Mac's public name, as a phone paired with the Mac would send it, and with no device at all.
  const code = new URL((await macPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
  const phone = await nodes.viaTunnel(mac.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${mac.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const phoneCookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(phone.headers['set-cookie']))![1]!;
  const pageKey = await nodes.publicPage(mac, phoneCookie);
  const pub = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    nodes.viaTunnel(mac.name, `/api/${route}`, { body: JSON.stringify(body), headers: { origin: `https://${mac.name}`, cookie: phoneCookie, 'x-ledung-page': pageKey, ...headers } });
  // Locked, it can only look anyway.
  assert.equal((await pub('link-device-pair', { id: pc.name })).status, 403);
  // Unlocked with its passkey, and even with this very request signed by it: still not through the public name.
  const key = new FakePasskey(mac.name);
  assert.equal((await pub('passkey', { response: key.register(JSON.parse((await pub('passkey-options', {})).body)) })).status, 200);
  const signed = async () => key.header(JSON.parse((await pub('passkey-challenge', { method: 'POST', path: '/api/link-device-pair', body: JSON.stringify({ id: pc.name }) })).body));
  const challenge = JSON.parse((await pub('passkey-challenge', { method: 'POST', path: '/api/device-unlock', body: '{}' })).body);
  assert.equal((await pub('device-unlock', {}, { 'x-ledung-passkey': key.header(challenge) })).status, 200);
  for (const headers of [{}, { 'x-ledung-passkey': await signed() }] as Record<string, string>[]) {
    const viaPhone = await pub('link-device-pair', { id: pc.name }, headers);
    assert.equal(viaPhone.status, 403, viaPhone.body);
    assert.match(JSON.parse(viaPhone.body).error, /only on the computer Ledung runs on/);
  }
  const nobody = await nodes.viaTunnel(mac.name, '/api/link-device-pair', { body: JSON.stringify({ id: pc.name }), headers: { origin: `https://${mac.name}` } });
  assert.equal(nobody.status, 401);
  // A computer that is not linked.
  const stranger = await macPage('POST', 'link-device-pair', { id: 'nobody.pair.test' });
  assert.equal(stranger.status, 400);
  assert.match(stranger.json.error, /not linked/);
  // None of it reached the PC: no code was made there.
  assert.deepEqual((await (await nodes.page(pc))('GET', 'state')).json.linkPairings, []);
});

test('the PC makes a code only for a link key: not locally, not with a cookie, not with another key', { timeout: 20_000 }, async () => {
  const { mac, pc, pcPage } = await pair();
  // Locally, even with the key and the sign-in cookie.
  const local = await nodes.local(pc, { method: 'POST', path: '/link/device-pair', body: '{}', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor(mac, pc)}`, cookie: COOKIE } });
  assert.equal(local.status, 404);
  // Through the tunnel: a cookie is no key, nor is the key the PC sends the Mac, nor a made-up one.
  for (const headers of [{ cookie: COOKIE }, { authorization: `Bearer ${keyFor(pc, mac)}` }, { authorization: `Bearer ${"A".repeat(43)}` }, {}] as Record<string, string>[]) {
    assert.equal((await nodes.viaTunnel(pc.name, '/link/device-pair', { headers })).status, 401, JSON.stringify(headers));
  }
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, []);
  // With the Mac's key: a code for a computer, whatever kind is asked for.
  const res = await nodes.viaTunnel(pc.name, '/link/device-pair', { headers: { authorization: `Bearer ${keyFor(mac, pc)}` }, body: JSON.stringify({ kind: 'phone' }) });
  assert.equal(res.status, 200, res.body);
  const { code } = JSON.parse(res.body);
  const done = await pairInFrame(pc, `https://${pc.name}/p/${code}`);
  assert.equal(done.status, 303);
  const cookie = /^__Host-ledung_device=([0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  assert.equal(pc.server.devices.byCookie(cookie)!.kind, 'computer');
});

test('at most one pairing code per linked computer every 10 minutes', { timeout: 20_000 }, async () => {
  const { pc, macPage, pcPage } = await pair();
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  nodes.clock += 9 * 60 * 1000;
  const again = await macPage('POST', 'link-device-pair', { id: pc.name });
  assert.equal(again.status, 502);
  assert.match(again.json.error, /answered 429: .* less than 10 minutes ago/);
  assert.equal((await pcPage('GET', 'state')).json.linkPairings.length, 1, 'the refused one made no code');
  nodes.clock += 60 * 1000;
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  assert.equal((await pcPage('GET', 'state')).json.linkPairings.length, 2);
});

test('a pairing code from this computer\'s own Settings is not marked as through the link', { timeout: 20_000 }, async () => {
  const { pc, pcPage } = await pair();
  const made = await pcPage('POST', 'devices-pair', { kind: 'computer' });
  const form = await nodes.viaTunnel(pc.name, new URL(made.json.url).pathname, { method: 'GET' });
  assert.match(form.body, /value="Phone"/);
  const done = await pairInFrame(pc, made.json.url);
  const cookie = /^__Host-ledung_device=([0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  assert.equal(pc.server.devices.byCookie(cookie)!.pairedVia, null);
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, []);
});

test('a pairing card is dismissed only on the PC itself: through its public name, even unlocked and signed, it stays', { timeout: 20_000 }, async () => {
  const { pc, macPage, pcPage } = await pair();
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  const [notice] = (await pcPage('GET', 'state')).json.linkPairings;
  // A phone paired with the PC, with its passkey, unlocked, and this very request signed by it.
  const code = new URL((await pcPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
  const phone = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(phone.headers['set-cookie']))![1]!;
  const pageKey = await nodes.publicPage(pc, cookie);
  const pub = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    nodes.viaTunnel(pc.name, `/api/${route}`, { body: JSON.stringify(body), headers: { origin: `https://${pc.name}`, cookie, 'x-ledung-page': pageKey, ...headers } });
  const key = new FakePasskey(pc.name);
  assert.equal((await pub('passkey', { response: key.register(JSON.parse((await pub('passkey-options', {})).body)) })).status, 200);
  const unlock = JSON.parse((await pub('passkey-challenge', { method: 'POST', path: '/api/device-unlock', body: '{}' })).body);
  assert.equal((await pub('device-unlock', {}, { 'x-ledung-passkey': key.header(unlock) })).status, 200);
  const route = `/api/link-pairings/${notice.id}/dismiss`;
  const signed = JSON.parse((await pub('passkey-challenge', { method: 'POST', path: route, body: '{}' })).body);
  const res = await pub(route.slice('/api/'.length), {}, { 'x-ledung-passkey': key.header(signed) });
  assert.equal(res.status, 403, res.body);
  assert.match(JSON.parse(res.body).error, /Devices are managed in Settings on the computer Ledung runs on/);
  assert.equal((await pcPage('GET', 'state')).json.linkPairings.length, 1, 'the card is still there');
  // On the PC's own page it goes.
  assert.equal((await pcPage('POST', `link-pairings/${notice.id}/dismiss`, {})).status, 200);
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, []);
});

test('unlinking closes an open pairing code the other computer asked for, on either side (review 275, Important 1)', { timeout: 20_000 }, async () => {
  // The PC unlinks the Mac.
  const one = await pair();
  const first = await one.macPage('POST', 'link-device-pair', { id: one.pc.name });
  assert.equal(first.status, 200);
  const onPc = (await one.pcPage('GET', 'links')).json.links[0];
  assert.equal((await one.pcPage('POST', `links/${onPc.id}/remove`, {})).status, 200);
  const after = await pairInFrame(one.pc, first.json.url);
  assert.equal(after.status, 403, 'the code no longer pairs');
  assert.equal(after.headers['set-cookie'], undefined);

  // The Mac unlinks, and the PC drops its side when told.
  const two = await pair();
  const second = await two.macPage('POST', 'link-device-pair', { id: two.pc.name });
  const onMac = (await two.macPage('GET', 'links')).json.links[0];
  assert.equal((await two.macPage('POST', `links/${onMac.id}/remove`, {})).status, 200);
  await until(async () => (await two.pcPage('GET', 'links')).json.links.length === 0, 'the PC to drop the link');
  assert.equal((await pairInFrame(two.pc, second.json.url)).status, 403);

  // A code made on the PC's own Settings is not the link's to close.
  const own = await two.pcPage('POST', 'devices-pair', { kind: 'computer' });
  await nodes.link(two.mac, two.pc, 'Mac');
  const link = (await two.pcPage('GET', 'links')).json.links[0];
  assert.equal((await two.pcPage('POST', `links/${link.id}/remove`, {})).status, 200);
  assert.equal((await pairInFrame(two.pc, own.json.url)).status, 303);
});

test('the 10-minute limit holds across a restart of the PC\'s Ledung (review 275, Minor 1)', { timeout: 20_000 }, async () => {
  const { pc, macPage } = await pair();
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  await nodes.restart(pc);
  const again = await macPage('POST', 'link-device-pair', { id: pc.name });
  assert.equal(again.status, 502);
  assert.match(again.json.error, /429: .* less than 10 minutes ago/);
  nodes.clock += 10 * 60 * 1000;
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
});
