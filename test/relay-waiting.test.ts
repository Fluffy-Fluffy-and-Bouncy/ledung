// Waiting for you through the relay (issue #412; Martin, 2026-11-19, Ledung questions #588 and #589 "a"): every card
// a computer counts is shown through its public name too, the link-pairing and new-computer cards included; a pairing
// card's OK and Remove device work there; Approve and the device list stay on the computer itself (#237,
// test/server-security.test.ts). A pairing card clears itself when its code expires unused, its device is removed or
// its link is.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LinkedNodes, until, type Node } from './linked-nodes.ts';
import { FakePasskey } from './fake-passkey.ts';
import { HANG_MS } from './limits.ts';
import type { NewComputerInfo } from '../src/shared/protocol.ts';
import type { RelayAdmin } from '../src/remote/admin.ts';

const nodes = new LinkedNodes();
after(() => nodes.close());

const NEW_COMPUTER: NewComputerInfo = { name: 'friend-pc', owner: 'Friend', host: 'friend-pc.relay.test', record: 'friend-pc.relay.test. CAA 0 issue "letsencrypt.org"', enrolledAt: 1, approvable: true } as NewComputerInfo;
/** Only what the server reads of the relay admin for Waiting for you: one computer waiting for Approve. */
const relayAdmin = { newComputers: () => [NEW_COMPUTER] } as unknown as RelayAdmin;

let n = 0;
/** A linked Mac and PC; the PC is a relay admin with one new computer waiting. */
async function linked() {
  n++;
  const mac = await nodes.ledung(`mac${n}.waiting.test`);
  // Its count goes to the Mac every 100 ms, so a card that cleared itself by time alone reaches the Mac's tab soon.
  const pc = await nodes.ledung(`pc${n}.waiting.test`, undefined, 100, undefined, {}, { relayAdmin });
  await nodes.link(mac, pc, 'Mac');
  return { mac, pc, macPage: await nodes.page(mac), pcPage: await nodes.page(pc) };
}

/** The Mac asks the PC for a pairing code and its frame pairs with it: the PC's card then names that device. */
async function pairedThroughLink(pc: Node, macPage: Awaited<ReturnType<LinkedNodes['page']>>) {
  const started = await macPage('POST', 'link-device-pair', { id: pc.name });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const code = new URL(started.json.url).pathname.slice('/p/'.length);
  const done = await nodes.viaTunnel(pc.name, '/pair', {
    body: new URLSearchParams({ code, name: 'Mac browser' }).toString(),
    headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-dest': 'iframe' },
  });
  assert.equal(done.status, 303, done.body);
  const cookie = /^__Host-ledung_device=([0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  return pc.server.devices.byCookie(cookie)!;
}

/** A phone paired with the PC through its public name, with its passkey: its open page there and its calls. */
async function phone(pc: Node, pcPage: Awaited<ReturnType<LinkedNodes['page']>>) {
  const code = new URL((await pcPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
  const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!;
  const pageKey = await nodes.publicPage(pc, cookie);
  const pub = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    nodes.viaTunnel(pc.name, `/api/${route}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { origin: `https://${pc.name}`, cookie, 'x-ledung-page': pageKey, ...headers } });
  const key = new FakePasskey(pc.name);
  assert.equal((await pub('POST', 'passkey', { response: key.register(JSON.parse((await pub('POST', 'passkey-options', {})).body)) })).status, 200);
  const unlock = async () => {
    const challenge = JSON.parse((await pub('POST', 'passkey-challenge', { method: 'POST', path: '/api/device-unlock', body: '{}' })).body);
    assert.equal((await pub('POST', 'device-unlock', {}, { 'x-ledung-passkey': key.header(challenge) })).status, 200);
  };
  /** This very request signed by the phone's passkey. */
  const signed = async (route: string) => {
    const challenge = JSON.parse((await pub('POST', 'passkey-challenge', { method: 'POST', path: `/api/${route}`, body: '{}' })).body);
    return pub('POST', route, {}, { 'x-ledung-passkey': key.header(challenge) });
  };
  return { pub, unlock, signed };
}

test('through the public name the page state carries every card the count holds: link pairings and new computers', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage } = await linked();
  const device = await pairedThroughLink(pc, macPage);
  const { pub } = await phone(pc, pcPage);
  const local = (await pcPage('GET', 'state')).json;
  const remote = JSON.parse((await pub('GET', 'state')).body);
  // The cards themselves, the same as on the PC's own page.
  assert.equal(remote.throughPublicName, true);
  assert.deepEqual(remote.newComputers.map((c: NewComputerInfo) => c.name), [NEW_COMPUTER.name]);
  assert.equal(remote.linkPairings.length, 1);
  assert.equal(remote.linkPairings[0].device.id, device.id);
  assert.deepEqual(remote.linkPairings, local.linkPairings);
  assert.deepEqual(remote.newComputers, local.newComputers);
  // The count the linked Mac gets is these two cards, so its tab and the list through the relay agree.
  await until(async () => (await macPage('GET', 'state')).json.computers.find((c: { id: string }) => c.id === pc.name)?.waiting === 2, 'the Mac\'s tab to count the PC\'s two cards');
});

test('a pairing card\'s Remove device works through the public name, signed by the passkey; only for the device it names', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage } = await linked();
  const device = await pairedThroughLink(pc, macPage);
  const { pub, unlock, signed } = await phone(pc, pcPage);
  const [card] = (await pcPage('GET', 'state')).json.linkPairings;
  await unlock();
  // Unlocked is not enough: removing a device takes this very request signed.
  const unsigned = await pub('POST', `link-pairings/${card.id}/remove-device`, {});
  assert.equal(unsigned.status, 403, unsigned.body);
  assert.match(JSON.parse(unsigned.body).error, /needs your passkey/);
  assert.ok(pc.server.devices.get(device.id), 'the device is still there');
  // Any other device's removal stays on the PC itself.
  assert.equal((await signed(`devices/${device.id}/revoke`)).status, 403);
  assert.ok(pc.server.devices.get(device.id));
  // Signed: the device goes, and its card with it.
  const removed = await signed(`link-pairings/${card.id}/remove-device`);
  assert.equal(removed.status, 200, removed.body);
  assert.equal(pc.server.devices.get(device.id), null);
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, []);
  // A card that names no device removes nothing.
  nodes.clock += 10 * 60 * 1000;
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  const [open] = (await pcPage('GET', 'state')).json.linkPairings;
  assert.equal(open.device, null);
  assert.equal((await signed(`link-pairings/${open.id}/remove-device`)).status, 400);
});

test('an unused pairing card clears itself when its code expires: from the list and from the count', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage } = await linked();
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  const tab = async () => (await macPage('GET', 'state')).json.computers.find((c: { id: string }) => c.id === pc.name)?.waiting;
  await until(async () => (await tab()) === 2, 'the Mac\'s tab to count the card and the new computer');
  nodes.clock += 10 * 60 * 1000 - 1;
  assert.equal((await pcPage('GET', 'state')).json.linkPairings.length, 1, 'still there a moment before its code expires');
  nodes.clock += 1;
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, [], 'gone once its code has');
  await until(async () => (await tab()) === 1, 'the Mac\'s tab to count the new computer only');
});

test('a used pairing card clears itself when its device is removed in Settings, and the open pages are told', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage } = await linked();
  const device = await pairedThroughLink(pc, macPage);
  assert.equal((await pcPage('GET', 'state')).json.linkPairings.length, 1);
  const seen = pcPage.events.length;
  assert.equal((await pcPage('POST', `devices/${device.id}/revoke`, {})).status, 200);
  assert.deepEqual((await pcPage('GET', 'state')).json.linkPairings, []);
  await until(() => pcPage.events.slice(seen).some((e) => e.type === 'linkPairings' && e.pairings.length === 0), 'the open page to lose the card');
});

test('a pairing card clears itself when its link is removed, on either side', { timeout: HANG_MS }, async () => {
  // The PC removes the link.
  const one = await linked();
  await pairedThroughLink(one.pc, one.macPage);
  assert.equal((await one.pcPage('GET', 'state')).json.linkPairings.length, 1);
  const onPc = (await one.pcPage('GET', 'links')).json.links[0];
  assert.equal((await one.pcPage('POST', `links/${onPc.id}/remove`, {})).status, 200);
  assert.deepEqual((await one.pcPage('GET', 'state')).json.linkPairings, []);
  // The Mac removes it, and the PC drops its side when told.
  const two = await linked();
  await pairedThroughLink(two.pc, two.macPage);
  assert.equal((await two.pcPage('GET', 'state')).json.linkPairings.length, 1);
  const onMac = (await two.macPage('GET', 'links')).json.links[0];
  assert.equal((await two.macPage('POST', `links/${onMac.id}/remove`, {})).status, 200);
  await until(async () => (await two.pcPage('GET', 'state')).json.linkPairings.length === 0, 'the PC\'s card to go with the link');
});

// The page's side, read from its source as test/frame-settings-wiring.test.ts does (the core's tests can't render .tsx).
test('the page shows the cards through the relay: a new computer says where to approve it, Remove device uses the card\'s route', () => {
  const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', ...file.split('/')), 'utf8');
  assert.match(read('web/src/App.tsx'), /linkPairings=\{ledung\.linkPairings\}\s+throughPublicName=\{ledung\.throughPublicName\}/);
  assert.match(read('web/src/components/WaitingView.tsx'), /<NewComputerCard [^>]*throughPublicName=\{props\.throughPublicName\}/);
  const card = read('web/src/components/RelaySettings.tsx');
  const start = card.indexOf('export function NewComputerCard');
  assert.ok(start > 0, 'the new computer card');
  // Through the relay: where to approve it, and neither Approve nor I added it (both refused there, #237).
  const branch = card.indexOf('throughPublicName ? <>', start);
  assert.ok(branch > start, 'the card branches on throughPublicName');
  const [remote, local] = card.slice(branch).split('</> : <>');
  assert.match(remote!, /Approve it on the computer this Ledung runs on/);
  assert.doesNotMatch(remote!, /approveComputer|computerAdded/);
  // On the computer itself both stay.
  assert.match(local!, /onClick=\{approve\}/);
  assert.match(local!, /api\.computerAdded\(computer\.name\)/);
  const pairing = read('web/src/components/LinkPairingCard.tsx');
  assert.match(pairing, /api\.removeLinkPairingDevice\(pairing\.id\)/);
  assert.doesNotMatch(pairing, /api\.revokeDevice/, 'not the device list\'s Remove, which stays on the computer');
});
