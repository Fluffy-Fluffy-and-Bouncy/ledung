// Paired devices and passkeys (issue #160, docs/steps/relay.md steps 4 and 5): pairing codes work once and
// expire, a revoked device is out at once, and a passkey signature allows exactly the request it was issued for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Devices, PAIR_CODE_MS, PASSKEY_WINDOW_MS } from '../src/server/devices.ts';
import { actionOf, CHALLENGE_MS, Passkeys } from '../src/server/passkeys.ts';
import { openDatabase } from '../src/store/database.ts';
import { FakePasskey } from './fake-passkey.ts';

const NAME = 'pc.example.test';

function setup() {
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms), now: () => now };
  const devices = new Devices(openDatabase(':memory:'), () => now);
  const passkeys = new Passkeys(devices, NAME, () => now);
  return { devices, passkeys, clock };
}

function paired(devices: Devices, name = 'Phone') {
  const { code } = devices.newPairCode();
  return devices.pair(code, name)!;
}

/** A device with its passkey registered. */
async function withPasskey(devices: Devices, passkeys: Passkeys) {
  const { device, cookie } = paired(devices);
  const key = new FakePasskey(NAME);
  await passkeys.register(device, key.register(await passkeys.registrationOptions(device)));
  return { device: devices.byCookie(cookie)!, key, cookie };
}

const header = (key: FakePasskey, options: { challenge: string }, opts = {}) => key.header(options, opts);

test('a pairing code pairs one device, once', () => {
  const { devices } = setup();
  const { code } = devices.newPairCode();
  assert.equal(devices.pair('x'.repeat(code.length), 'A'), null, 'a wrong code');
  const first = devices.pair(code, '  My phone\n ');
  assert.ok(first);
  assert.equal(first.device.name, 'My phone');
  assert.match(first.cookie, /^[0-9a-f]{64}$/);
  assert.equal(devices.pair(code, 'B'), null, 'used up');
  assert.equal(devices.list().length, 1);
});

test('a pairing code expires after 10 minutes, and a new one replaces the old', () => {
  const { devices, clock } = setup();
  const old = devices.newPairCode().code;
  const fresh = devices.newPairCode().code;
  assert.equal(devices.codeValid(old), false, 'replaced');
  clock.advance(PAIR_CODE_MS);
  assert.equal(devices.pair(fresh, 'A'), null, 'expired');
});

test('a device cookie is stored only as its hash, and stops working when the device is revoked', () => {
  const { devices } = setup();
  const { device, cookie } = paired(devices);
  const row = (devices as any).db.prepare('SELECT cookie_hash FROM devices WHERE id = ?').get(device.id);
  assert.notEqual(row.cookie_hash, cookie);
  assert.equal(devices.byCookie(cookie)?.id, device.id);
  assert.equal(devices.byCookie('0'.repeat(64)), null);
  assert.equal(devices.revoke(device.id), true);
  assert.equal(devices.byCookie(cookie), null);
  assert.equal(devices.list().length, 0);
  assert.equal(devices.revoke(device.id), false);
});

test('a passkey is registered once, only in the window after pairing, with user verification', async () => {
  const { devices, passkeys, clock } = setup();
  const late = paired(devices).device;
  const { device } = paired(devices);
  // Without the user-verified flag the phone skipped Face ID / the fingerprint: refused.
  const noUv = new FakePasskey(NAME);
  await assert.rejects(passkeys.register(device, noUv.register(await passkeys.registrationOptions(device), { noUserVerification: true })), /not accepted/);
  // Signed for the http origin or another name: refused.
  await assert.rejects(passkeys.register(device, new FakePasskey(NAME).register(await passkeys.registrationOptions(device), { origin: `http://${NAME}` })), /not accepted/);
  await assert.rejects(passkeys.register(device, new FakePasskey('evil.test').register(await passkeys.registrationOptions(device))), /not accepted/);
  const key = new FakePasskey(NAME);
  const options = await passkeys.registrationOptions(device);
  assert.equal(options.rp.id, NAME);
  assert.equal(options.authenticatorSelection?.userVerification, 'required');
  await passkeys.register(device, key.register(options));
  assert.equal(devices.get(device.id)?.credentialId, key.credentialId);
  // When it was added shows in Settings (the setup clock has not moved since pairing).
  assert.equal(devices.list().find((d) => d.id === device.id)?.passkeyAt, device.createdAt);
  assert.equal(devices.list().find((d) => d.id === late.id)?.passkeyAt, null);
  // A second passkey (a copied cookie adding its own) is refused.
  await assert.rejects(passkeys.registrationOptions(devices.get(device.id)!), /already has/);
  clock.advance(PASSKEY_WINDOW_MS);
  await assert.rejects(passkeys.registrationOptions(late), /10 minutes after pairing/);
});

test('a registration challenge is used once', async () => {
  const { devices, passkeys } = setup();
  const { device } = paired(devices);
  const options = await passkeys.registrationOptions(device);
  const key = new FakePasskey(NAME);
  const response = key.register(options);
  await assert.rejects(passkeys.register(paired(devices).device, response), /something else/, "another device can't use it");
  await assert.rejects(passkeys.register(device, response), /expired or was already used/);
});

test('a signature allows exactly the request its challenge was issued for', async () => {
  const { devices, passkeys } = setup();
  const { device, key } = await withPasskey(devices, passkeys);
  const allowA = actionOf('POST', '/api/permissions/A', '{"behavior":"allow"}');
  const allowB = actionOf('POST', '/api/permissions/B', '{"behavior":"allow"}');
  const denyA = actionOf('POST', '/api/permissions/A', '{"behavior":"deny"}');
  for (const other of [allowB, denyA]) {
    const h = header(key, await passkeys.challenge(device, allowA));
    await assert.rejects(passkeys.verify(devices.get(device.id)!, other, h), /something else/);
  }
  const h = header(key, await passkeys.challenge(device, allowA));
  await passkeys.verify(devices.get(device.id)!, allowA, h);
  await assert.rejects(passkeys.verify(devices.get(device.id)!, allowA, h), /already used/, 'replayed');
});

test('a challenge expires after two minutes', async () => {
  const { devices, passkeys, clock } = setup();
  const { device, key } = await withPasskey(devices, passkeys);
  const action = actionOf('POST', '/api/away', '{}');
  const h = header(key, await passkeys.challenge(device, action));
  clock.advance(CHALLENGE_MS);
  await assert.rejects(passkeys.verify(devices.get(device.id)!, action, h), /expired/);
});

test('an assertion without user verification, from another origin, or by another key is refused', async () => {
  const { devices, passkeys } = setup();
  const { device, key } = await withPasskey(devices, passkeys);
  const action = actionOf('POST', '/api/away', '{}');
  const fresh = () => passkeys.challenge(device, action);
  const current = () => devices.get(device.id)!;
  await assert.rejects(passkeys.verify(current(), action, header(key, await fresh(), { noUserVerification: true })), /not accepted/);
  await assert.rejects(passkeys.verify(current(), action, header(key, await fresh(), { origin: `http://${NAME}` })), /not accepted/);
  await assert.rejects(passkeys.verify(current(), action, header(new FakePasskey(NAME), await fresh())), /not this device's passkey/);
  await assert.rejects(passkeys.verify(current(), action, undefined), /needs your passkey/);
  await assert.rejects(passkeys.verify(current(), action, 'not base64 json'), /could not be read/);
  // Another device's challenge is not this one's.
  const other = await withPasskey(devices, passkeys);
  await assert.rejects(passkeys.verify(current(), action, header(key, await passkeys.challenge(other.device, action))), /something else/);
});

test('a signature counter that goes backwards is refused (a cloned authenticator)', async () => {
  const { devices, passkeys } = setup();
  const { device, key } = await withPasskey(devices, passkeys);
  const action = actionOf('POST', '/api/away', '{}');
  await passkeys.verify(devices.get(device.id)!, action, header(key, await passkeys.challenge(device, action)));
  assert.equal(devices.get(device.id)!.counter, 1);
  key.counter = 0; // the next assertion says 1 again
  await assert.rejects(passkeys.verify(devices.get(device.id)!, action, header(key, await passkeys.challenge(device, action))), /not accepted/);
});

test('a device without a passkey gets no challenge', async () => {
  const { devices, passkeys } = setup();
  const { device } = paired(devices);
  await assert.rejects(passkeys.challenge(device, 'x'), /no passkey/);
  await assert.rejects(passkeys.verify(device, 'x', 'y'), /no passkey/);
});

/** Martin, 2026-10-17 12:54: "C but unlocks 30min". The figure from the decision, not from the code under test. */
const THIRTY_MINUTES = 30 * 60 * 1000;

test('an unlock lasts 30 minutes, belongs to one device, and ends when locked', async () => {
  const { devices, passkeys, clock } = setup();
  const a = paired(devices).device;
  const b = paired(devices).device;
  assert.equal(passkeys.unlockedUntil(a.id), null, 'locked from the start');
  const until = passkeys.unlock(a.id);
  assert.equal(until, 1_000_000 + THIRTY_MINUTES);
  assert.equal(passkeys.unlockedUntil(a.id), until);
  assert.equal(passkeys.unlockedUntil(b.id), null, 'only that device');
  clock.advance(THIRTY_MINUTES - 1);
  assert.equal(passkeys.unlockedUntil(a.id), until);
  clock.advance(1);
  assert.equal(passkeys.unlockedUntil(a.id), null, 'expired at 30 minutes');
  passkeys.unlock(a.id);
  passkeys.lock(a.id);
  assert.equal(passkeys.unlockedUntil(a.id), null);
});

test('a restart locks every device again (test review round 2, finding 1)', () => {
  const { devices, passkeys, clock } = setup();
  const a = paired(devices).device;
  passkeys.unlock(a.id);
  assert.notEqual(passkeys.unlockedUntil(a.id), null);
  // What a restart does: a new Passkeys over the same devices (the same database).
  const afterRestart = new Passkeys(devices, NAME, clock.now);
  assert.equal(afterRestart.unlockedUntil(a.id), null);
});
