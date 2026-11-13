// A trusted computer's screen stands in for the passkey (issue #313, docs/steps/trusted-computer.md; Martin,
// 2026-11-13, question #890: "a — Design a, with a key on the tab"). The PC trusts the Mac's own screen; the Mac's
// frame of the PC then logs on and signs each request with the Mac's vouch, sent over the link from the Mac's own
// page, instead of a passkey. Only for the Mac's own frame, only while trusted, never for opening lockdown, never
// from the Mac's public name, a phone, a script with the token alone or anyone without the link key.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, keyFor, LinkedNodes, until, type Node } from './linked-nodes.ts';
import { FakePasskey } from './fake-passkey.ts';
import { HANG_MS } from './limits.ts';

const nodes = new LinkedNodes();
after(() => nodes.close());

const DEVICE_LOCKED = /This device is locked/;
const NO_PASSKEY = /no passkey, so it can only look/;
const PASSKEY_ONLY = /This needs a passkey, or this computer's own screen/;

let n = 0;
/** A linked Mac and PC, and the Mac's frame of the PC paired through the link: a computer device on the PC. */
async function frameOfPc() {
  n++;
  const mac = await nodes.ledung(`mac${n}.trust.test`);
  const pc = await nodes.ledung(`pc${n}.trust.test`);
  await nodes.link(mac, pc, 'Mac');
  const macPage = await nodes.page(mac);
  const pcPage = await nodes.page(pc);
  const started = await macPage('POST', 'link-device-pair', { id: pc.name });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const code = new URL(started.json.url).pathname.slice('/p/'.length);
  const done = await nodes.viaTunnel(pc.name, '/pair', {
    body: new URLSearchParams({ code, name: 'Mac browser' }).toString(),
    headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-dest': 'iframe' },
  });
  assert.equal(done.status, 303, done.body);
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  const frame = await asDevice(pc, cookie);
  // The PC's link to the Mac, as its Settings lists it.
  const macLink = (await pcPage('GET', 'links')).json.links[0] as { id: string; name: string };
  assert.equal(macLink.name, 'Mac');
  return { mac, pc, macPage, pcPage, frame, cookie, macLink };
}

/** Requests through a Ledung's public name as one of its devices, from that device's open page. */
async function asDevice(node: Node, cookie: string) {
  const pageKey = await nodes.publicPage(node, cookie);
  return async (route: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await nodes.viaTunnel(node.name, `/api/${route}`, { body: JSON.stringify(body), headers: { origin: `https://${node.name}`, cookie, 'x-ledung-page': pageKey, ...headers } });
    let json: any = {};
    try { json = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
}
type Device = Awaited<ReturnType<typeof asDevice>>;

/** The frame's challenge for exactly this request, as the PC offers it: a vouch's, or a passkey's options. */
async function offer(frame: Device, route: string, body: unknown = {}) {
  const res = await frame('passkey-challenge', { method: 'POST', path: `/api/${route}`, body: JSON.stringify(body) });
  return res;
}

/** The challenge for this request, vouched for by the Mac's own page: the header the frame then sends it with. */
async function vouched(frame: Device, macPage: Awaited<ReturnType<LinkedNodes['page']>>, pc: Node, route: string, body: unknown = {}) {
  const got = await offer(frame, route, body);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.equal(typeof got.json.vouch, 'string', `a vouch's challenge, not a passkey's: ${JSON.stringify(got.json)}`);
  const v = await macPage('POST', 'link-vouch', { id: pc.name, challenge: got.json.vouch });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return { 'x-ledung-vouch': got.json.vouch as string };
}

const rename = (pc: Node, name: string) => ({ id: pc.name, name });
/** Away mode until a time of day (it lets a manager's merges through, so it is signed per request). */
const away = () => ({ until: '23:59' });

test('trusted, the Mac\'s frame logs on and makes ordinary and signed changes on the PC with the Mac\'s vouch, no passkey', { timeout: HANG_MS }, async () => {
  const { mac, pc, macPage, pcPage, frame, macLink } = await frameOfPc();
  // Not trusted yet: the frame, with no passkey, can only look.
  const before = await frame('computers', rename(pc, 'Before'));
  assert.equal(before.status, 403);
  assert.match(before.json.error, NO_PASSKEY);

  // The PC trusts the Mac's own screen, on its own page.
  const trusted = await pcPage('POST', `links/${macLink.id}/trust`, { on: true });
  assert.equal(trusted.status, 200, JSON.stringify(trusted.json));
  assert.equal(trusted.json.trustedFrom, 'here');
  assert.equal(typeof trusted.json.trustedAt, 'number');
  // The Mac hears it over the link: the key on the PC's tab there.
  await until(async () => ((await macPage('GET', 'state')).json.computers as { id: string; trustsUs?: boolean }[]).find((c) => c.id === pc.name)?.trustsUs === true, 'the key on the Mac\'s tab for the PC');

  // Now the frame is told to log on, not that it can only look.
  const locked = await frame('computers', rename(pc, 'Locked'));
  assert.equal(locked.status, 403);
  assert.match(locked.json.error, DEVICE_LOCKED);
  // It logs on with the Mac's vouch, and ordinary changes go through on the cookie and page key alone.
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
  const changed = await frame('computers', rename(pc, 'Renamed'));
  assert.equal(changed.status, 200, JSON.stringify(changed.json));

  // A signed-per-request call (away mode, which lets merges through): refused without a proof, allowed with a vouch.
  const unsigned = await frame('away', away());
  assert.equal(unsigned.status, 403, 'away mode still takes a proof for itself');
  const signed = await frame('away', away(), await vouched(frame, macPage, pc, 'away', away()));
  assert.equal(signed.status, 200, JSON.stringify(signed.json));
  void mac;
});

test('a vouch counts once, for its own request, within two minutes, and only when vouched by the trusted Mac', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, frame, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  // A challenge nobody vouched for.
  const bare = await offer(frame, 'device-unlock');
  const notVouched = await frame('device-unlock', {}, { 'x-ledung-vouch': bare.json.vouch });
  assert.equal(notVouched.status, 403);
  assert.match(notVouched.json.error, /not vouched|expired or was already used/);
  // A vouched one for another request.
  const forAway = await vouched(frame, macPage, pc, 'away', away());
  const wrong = await frame('device-unlock', {}, forAway);
  assert.equal(wrong.status, 403);
  assert.match(wrong.json.error, /for something else/);
  // Used: the same vouched challenge again, for its own request.
  const unlock = await vouched(frame, macPage, pc, 'device-unlock');
  assert.equal((await frame('device-unlock', {}, unlock)).status, 200);
  assert.equal((await frame('device-unlock', {}, unlock)).status, 403, 'used once');
  // The Mac can't vouch twice for one challenge, nor for one that ran out.
  const twice = await offer(frame, 'away', away());
  assert.equal((await macPage('POST', 'link-vouch', { id: pc.name, challenge: twice.json.vouch })).status, 200);
  assert.equal((await macPage('POST', 'link-vouch', { id: pc.name, challenge: twice.json.vouch })).status, 502);
  const late = await offer(frame, 'away', away());
  nodes.clock += 2 * 60 * 1000;
  const expired = await macPage('POST', 'link-vouch', { id: pc.name, challenge: late.json.vouch });
  assert.equal(expired.status, 502);
  assert.match(expired.json.error, /403: That check expired/);
});

test('without trust nothing changes: no vouch is offered, the PC refuses the Mac\'s vouch, and a vouch header is refused', { timeout: HANG_MS }, async () => {
  const { mac, pc, macPage, frame } = await frameOfPc();
  // The frame has no passkey and the PC trusts no one: the challenge is a passkey's, and it has none.
  const got = await offer(frame, 'device-unlock');
  assert.equal(got.status, 403);
  assert.match(got.json.error, /no passkey/);
  // The Mac's own page asks anyway, for a made-up challenge: the PC says it does not trust the Mac.
  const asked = await macPage('POST', 'link-vouch', { id: pc.name, challenge: 'A'.repeat(43) });
  assert.equal(asked.status, 502);
  assert.match(asked.json.error, /403: This computer does not trust that one's screen/);
  // A vouch header from the frame itself.
  const header = await frame('device-unlock', {}, { 'x-ledung-vouch': 'A'.repeat(43) });
  assert.equal(header.status, 403);
  assert.match(header.json.error, /does not trust that computer's screen/);
  void mac;
});

test('only the Mac\'s own page vouches: never through its public name, never without the page key, never without the link key', { timeout: HANG_MS }, async () => {
  const { mac, pc, pcPage, frame, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  const challenge = (await offer(frame, 'device-unlock')).json.vouch as string;
  // The install token alone on the Mac, with no open page.
  const noKey = await fetch(`http://127.0.0.1:${mac.port}/api/link-vouch`, {
    method: 'POST', headers: { cookie: COOKIE, origin: `http://127.0.0.1:${mac.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: pc.name, challenge }),
  });
  assert.equal(noKey.status, 403);
  // A phone paired with the Mac, with its passkey, unlocked, and this very request signed: still not through the public name.
  const macPage = await nodes.page(mac);
  const code = new URL((await macPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
  const paired = await nodes.viaTunnel(mac.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${mac.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const phone = await asDevice(mac, /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!);
  const key = new FakePasskey(mac.name);
  assert.equal((await phone('passkey', { response: key.register((await phone('passkey-options')).json) })).status, 200);
  const sign = async (route: string, body: unknown) => ({ 'x-ledung-passkey': key.header((await offer(phone, route, body)).json) });
  assert.equal((await phone('device-unlock', {}, await sign('device-unlock', {}))).status, 200);
  const viaPhone = await phone('link-vouch', { id: pc.name, challenge }, await sign('link-vouch', { id: pc.name, challenge }));
  assert.equal(viaPhone.status, 403);
  assert.match(viaPhone.json.error, /Only this computer's own screen vouches/);
  // The PC's link route: no key, a cookie, the key the PC sends the Mac, a made-up one.
  for (const headers of [{}, { cookie: COOKIE }, { authorization: `Bearer ${keyFor(pc, mac)}` }, { authorization: `Bearer ${'A'.repeat(43)}` }] as Record<string, string>[]) {
    assert.equal((await nodes.viaTunnel(pc.name, '/link/vouch', { headers, body: JSON.stringify({ challenge }) })).status, 401, JSON.stringify(headers));
  }
  // None of it vouched: the frame's challenge is still not good.
  assert.equal((await frame('device-unlock', {}, { 'x-ledung-vouch': challenge })).status, 403);
  // With the Mac's link key it is (what the Mac's own page does).
  const challenge2 = (await offer(frame, 'device-unlock')).json.vouch as string;
  assert.equal((await nodes.viaTunnel(pc.name, '/link/vouch', { headers: { authorization: `Bearer ${keyFor(mac, pc)}` }, body: JSON.stringify({ challenge: challenge2 }) })).status, 200);
  assert.equal((await frame('device-unlock', {}, { 'x-ledung-vouch': challenge2 })).status, 200);
});

test('a vouch is only for the trusted computer\'s own frame: not a phone\'s challenge, not a device paired on the PC itself', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  // A computer device paired from the PC's own Settings, and a phone: each gets a passkey's challenge, never a vouch's.
  for (const kind of ['computer', 'phone']) {
    const code = new URL((await pcPage('POST', 'devices-pair', { kind })).json.url).pathname.slice('/p/'.length);
    const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: kind }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
    const other = await asDevice(pc, /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!);
    const key = new FakePasskey(pc.name);
    assert.equal((await other('passkey', { response: key.register((await other('passkey-options')).json) })).status, 200);
    const got = await offer(other, 'device-unlock');
    assert.equal(got.status, 200);
    assert.equal(got.json.vouch, undefined, kind);
    assert.equal(typeof got.json.challenge, 'string', kind);
    // The Mac vouching for that passkey's challenge is refused, and the passkey still works for it.
    const refused = await macPage('POST', 'link-vouch', { id: pc.name, challenge: got.json.challenge });
    assert.equal(refused.status, 502, kind);
    assert.match(refused.json.error, /403: That check expired or was already used/);
    assert.equal((await other('device-unlock', {}, { 'x-ledung-passkey': key.header(await (await offer(other, 'device-unlock')).json) })).status, 200, kind);
    // Its own vouch header is refused: the PC trusts the Mac's frame, not it.
    const header = await other('away', away(), { 'x-ledung-vouch': 'A'.repeat(43) });
    assert.equal(header.status, 403, kind);
  }
});

test('another trusted computer can\'t vouch for the Mac\'s frame: each vouch counts only from its own frame\'s computer', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, frame, macLink } = await frameOfPc();
  const third = await nodes.ledung(`third${n}.trust.test`);
  await nodes.link(third, pc, 'Third');
  const links = (await pcPage('GET', 'links')).json.links as { id: string; name: string }[];
  const thirdLink = links.find((l) => l.name === 'Third')!;
  // The PC trusts both screens.
  for (const id of [macLink.id, thirdLink.id]) assert.equal((await pcPage('POST', `links/${id}/trust`, { on: true })).status, 200);
  const challenge = (await offer(frame, 'device-unlock')).json.vouch as string;
  const thirdPage = await nodes.page(third);
  const refused = await thirdPage('POST', 'link-vouch', { id: pc.name, challenge });
  assert.equal(refused.status, 502);
  assert.match(refused.json.error, /403: That check is not for a frame of this computer/);
  assert.equal((await frame('device-unlock', {}, { 'x-ledung-vouch': challenge })).status, 403, 'not vouched for (and so used up)');
  // Premise: the Mac's own page vouches for its own frame's next challenge.
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
});

test('opening lockdown and loosening the gate still take a passkey: a vouch is refused for them', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, frame, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
  // A new project with a manager grant loosens the gate (issue #107).
  const loosening = { name: 'loose', folder: '/nowhere', managerGrant: 'anything' };
  const res = await frame('projects', loosening, await vouched(frame, macPage, pc, 'projects', loosening));
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.match(res.json.error, PASSKEY_ONLY);
  // The same vouch path for a change that doesn't loosen it goes through the check (premise: the vouch itself is good).
  const plain = await frame('away', away(), await vouched(frame, macPage, pc, 'away', away()));
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  // The same settings sent along with a rename (self-check finding 1): refused on a vouch too.
  const renamed = { name: 'renamed', settings: { managerGrant: 'anything' } };
  const viaRename = await frame('projects/loose/rename', renamed, await vouched(frame, macPage, pc, 'projects/loose/rename', renamed));
  assert.equal(viaRename.status, 403, JSON.stringify(viaRename.json));
  assert.match(viaRename.json.error, PASSKEY_ONLY);
  // Premise: a rename whose settings loosen nothing passes the check on a vouch (and then finds no such project).
  const plainRename = { name: 'renamed', settings: {} };
  const passed = await frame('projects/loose/rename', plainRename, await vouched(frame, macPage, pc, 'projects/loose/rename', plainRename));
  assert.notEqual(passed.status, 403, JSON.stringify(passed.json));
  // Asked for the passkey itself, the frame gets a passkey's challenge, which it can't answer without one.
  const forced = await frame('passkey-challenge', { method: 'POST', path: '/api/projects', body: JSON.stringify(loosening), passkey: true });
  assert.equal(forced.json.vouch, undefined);
  assert.match(forced.json.error, /no passkey/);
});

test('a sensitive prompt is decided on a vouch, and not without one', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, frame, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
  // A sensitive request of a session that is no longer live: past the check, the manager finds nothing to decide.
  pc.store.createSession({ id: 's313', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  pc.store.createPermission({ id: 'perm313', sessionId: 's313', toolName: 'Bash', input: { command: 'gh pr merge 1' }, title: null, reason: null, sensitive: 'command matches /gh pr merge/' });
  const allow = { behavior: 'allow' };
  const unsigned = await frame('permissions/perm313', allow);
  assert.equal(unsigned.status, 403, 'logged on is not enough for a sensitive prompt');
  const signed = await frame('permissions/perm313', allow, await vouched(frame, macPage, pc, 'permissions/perm313', allow));
  assert.notEqual(signed.status, 403, JSON.stringify(signed.json));
});

test('removing trust logs the frame off at once and its next change is refused; unlinking does too', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, frame, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
  assert.equal((await frame('computers', rename(pc, 'While trusted'))).status, 200);

  const removed = await pcPage('POST', `links/${macLink.id}/trust`, { on: false });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.trustedAt, undefined);
  const after = await frame('computers', rename(pc, 'After'));
  assert.equal(after.status, 403);
  assert.match(after.json.error, NO_PASSKEY);
  // No vouch is offered any more, and the Mac's tab loses its key.
  assert.match((await offer(frame, 'device-unlock')).json.error, /no passkey/);
  await until(async () => !((await macPage('GET', 'state')).json.computers as { id: string; trustsUs?: boolean }[]).find((c) => c.id === pc.name)?.trustsUs, 'the key to go');

  // Trusted again and logged on, then the PC unlinks the Mac: logged off too.
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
  assert.equal((await pcPage('POST', `links/${macLink.id}/remove`, {})).status, 200);
  const unlinked = await frame('computers', rename(pc, 'Unlinked'));
  assert.equal(unlinked.status, 403);
  assert.match(unlinked.json.error, NO_PASSKEY);
});

test('trust is set on the PC\'s own page or from a phone with its passkey; never from a frame, even a trusted one', { timeout: HANG_MS }, async () => {
  const { pc, macPage, pcPage, frame, cookie, macLink } = await frameOfPc();
  const route = `links/${macLink.id}/trust`;
  // A phone of the PC, with its passkey: it sees each link's trust (and nothing else of the links), and sets it signed.
  const code = new URL((await pcPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
  const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const phoneCookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!;
  const phone = await asDevice(pc, phoneCookie);
  const key = new FakePasskey(pc.name);
  assert.equal((await phone('passkey', { response: key.register((await phone('passkey-options')).json) })).status, 200);
  const sign = async (r: string, body: unknown) => ({ 'x-ledung-passkey': key.header((await offer(phone, r, body)).json) });
  assert.equal((await phone('device-unlock', {}, await sign('device-unlock', {}))).status, 200);
  const list = await nodes.viaTunnel(pc.name, '/api/link-trust', { method: 'GET', headers: { cookie: phoneCookie, origin: `https://${pc.name}` } });
  assert.equal(list.status, 200, list.body);
  assert.deepEqual(JSON.parse(list.body).links, [{ id: macLink.id, name: 'Mac' }]);
  // Unlocked but not signed for this request: refused.
  assert.equal((await phone(route, { on: true })).status, 403);
  const set = await phone(route, { on: true }, await sign(route, { on: true }));
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.trustedFrom, 'phone');

  // The trusted frame, logged on by the Mac's vouch, and with a vouch for this very request: refused.
  assert.equal((await frame('device-unlock', {}, await vouched(frame, macPage, pc, 'device-unlock'))).status, 200);
  for (const on of [false, true]) {
    const res = await frame(route, { on }, await vouched(frame, macPage, pc, route, { on }));
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.match(res.json.error, /own screen, or from a phone/);
  }
  // Nor does it read the links' trust.
  const fromFrame = await nodes.viaTunnel(pc.name, '/api/link-trust', { method: 'GET', headers: { cookie, origin: `https://${pc.name}` } });
  assert.equal(fromFrame.status, 403, fromFrame.body);
  assert.equal((await pcPage('GET', 'link-trust')).json.links[0].trustedFrom, 'phone', 'still trusted');
});

test('a phone never gets a vouch, whatever the PC trusts', { timeout: HANG_MS }, async () => {
  const { pc, pcPage, macLink } = await frameOfPc();
  assert.equal((await pcPage('POST', `links/${macLink.id}/trust`, { on: true })).status, 200);
  const code = new URL((await pcPage('POST', 'devices-pair', { kind: 'phone' })).json.url).pathname.slice('/p/'.length);
  const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Phone' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  const phone = await asDevice(pc, /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!);
  // Without a passkey it can only look, as today.
  const change = await phone('computers', rename(pc, 'Phone'));
  assert.equal(change.status, 403);
  assert.match(change.json.error, NO_PASSKEY);
});
