// Push notifications to paired phones (issue #246, docs/steps/push.md): the encryption against RFC 8291's own
// example, the VAPID token, one subscription per device, revoking, and what a notification carries.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { checkSubscription, encrypt, vapidHeader, loadOrCreateVapid } from '../src/server/push.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { FakePasskey } from './fake-passkey.ts';
import { keyBytes, pushSupport, sameKey } from '../web/src/push.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const u = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// RFC 8291 section 5 and Appendix A, verbatim.
const RFC = {
  plaintext: u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  uaPublic: u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  uaPrivate: u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  salt: u('DGv6ra1nlYgDCS1FRnbzlw'),
  auth: u('BTBZMqHH6r4Tts7J_aSIgg'),
  message: u(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

/** The phone's side, written from RFC 8291 section 3 and RFC 8188 with plain HMAC, apart from Ledung's code. */
function decrypt(message: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const salt = message.subarray(0, 16);
  const idlen = message[20]!;
  const asPublic = message.subarray(21, 21 + idlen);
  const sealed = message.subarray(21 + idlen);
  const prkKey = hmac(auth, ua.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // The last record ends with 0x02, then any zero padding.
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  assert.equal(padded[end], 2, 'last-record delimiter');
  return padded.subarray(0, end);
}

test('the encryption gives RFC 8291\'s example message exactly (section 5, Appendix A)', () => {
  const message = encrypt(RFC.plaintext, RFC.uaPublic, RFC.auth, { asPrivate: RFC.asPrivate, salt: RFC.salt });
  assert.equal(message.toString('base64url'), RFC.message.toString('base64url'));
  // The 86-octet header (Appendix A), the 41-octet text and its delimiter, and the 16-octet tag. (Section 5's
  // "Content-Length: 145" is one too many: its own body decodes to 144 octets.)
  assert.equal(message.length, 86 + 41 + 1 + 16);
  assert.equal(decrypt(RFC.message, RFC.uaPrivate, RFC.auth).toString(), 'When I grow up, I want to be a watermelon');
});

test('a message with a fresh key and salt each time still opens on the phone', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const a = encrypt(Buffer.from('one'), ua.getPublicKey(), auth);
  const b = encrypt(Buffer.from('one'), ua.getPublicKey(), auth);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'a new salt');
  assert.equal(decrypt(a, ua.getPrivateKey(), auth).toString(), 'one');
  assert.equal(decrypt(b, ua.getPrivateKey(), auth).toString(), 'one');
});

test('the VAPID token (RFC 8292) is signed with the kept key, for the push service\'s origin, for at most 24 hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-vapid-'));
  try {
    const file = path.join(dir, 'remote', 'push-vapid.json');
    const keys = loadOrCreateVapid(file);
    assert.equal(loadOrCreateVapid(file).publicKey, keys.publicKey, 'kept, not made again');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'private to this user');
    const now = Date.UTC(2026, 9, 20, 8, 0, 0);
    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://ledung.example.test', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    assert.ok(m, header);
    assert.equal(m[4], keys.publicKey);
    const raw = u(m[4]!);
    assert.equal(raw.length, 65);
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, u(m[3]!)), 'signature checks with k');
    assert.deepEqual(JSON.parse(u(m[1]!).toString()), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(u(m[2]!).toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'https://ledung.example.test');
    assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600);
  } finally {
    removeTemp(dir);
  }
});

/** A browser's subscription: real P-256 keys, and the phone's private key to read what arrives. */
function phone(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    read: (body: Buffer) => JSON.parse(decrypt(body, ecdh.getPrivateKey(), auth).toString()),
  };
}

test('only an endpoint of a known push service, over HTTPS, with keys that work, is taken', () => {
  const keys = phone().subscription.keys;
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/QG', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.equal(checkSubscription({ endpoint, keys }).endpoint, endpoint);
  }
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.test/x', 'https://evilpush.apple.com/x', 'https://127.0.0.1/x', 'https://localhost:4317/api/away', 'https://user:pw@fcm.googleapis.com/x', 'not a url']) {
    assert.throws(() => checkSubscription({ endpoint, keys }), /push services|not an address/, endpoint);
  }
  const endpoint = 'https://fcm.googleapis.com/fcm/send/x';
  // A point off the curve: the same x with y changed (RFC 8291 section 7 asks for this check).
  const off = Buffer.from(u(keys.p256dh));
  off[64] = off[64]! ^ 1;
  for (const bad of [{ p256dh: off.toString('base64url'), auth: keys.auth }, { p256dh: keys.p256dh, auth: 'AAAA' }, { p256dh: 'AAAA', auth: keys.auth }]) {
    assert.throws(() => checkSubscription({ endpoint, keys: bad }), /keys are not valid/);
  }
  assert.throws(() => checkSubscription({ endpoint }), /endpoint and keys/);
  assert.throws(() => checkSubscription(null), /endpoint and keys/);
});

test('the page tells an iPhone in a Safari tab to add Ledung to the Home Screen; the key and its check', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(pushSupport({ secure: true, serviceWorker: true, pushManager: false, userAgent: iphone, standalone: false }), 'home-screen');
  assert.equal(pushSupport({ secure: true, serviceWorker: true, pushManager: true, userAgent: iphone, standalone: true }), 'yes');
  assert.equal(pushSupport({ secure: true, serviceWorker: true, pushManager: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', standalone: false }), 'yes');
  assert.equal(pushSupport({ secure: false, serviceWorker: false, pushManager: false, userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', standalone: false }), 'no');
  const key = phone().subscription.keys.p256dh;
  assert.deepEqual(Buffer.from(keyBytes(key)), u(key));
  assert.ok(sameKey(keyBytes(key).buffer, keyBytes(key)));
  assert.ok(!sameKey(null, keyBytes(key)));
  assert.ok(!sameKey(keyBytes(phone().subscription.keys.p256dh).buffer, keyBytes(key)));
});

// Through the server: paired devices, the routes, and what reaches the push service.
const PORT = await freePort();
const TOKEN = 'b'.repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `ledung_auth=${TOKEN}`;
const PUBLIC = 'pc.example.test';
const PUBLIC_ORIGIN = `https://${PUBLIC}`;
/** The secret parts of a question and a permission prompt; none may leave in a notification. */
const SECRET = 'Deploy the patient database to production?';
const SECRET_COMMAND = 'kubectl apply -f prod-secrets.yaml';
const SESSION_TITLE = 'Very private session title';

let server: LedungServer;
let store: Store;
let dir: string;
let projectRoot: string;
/** What reached the "push service", and what it answers. */
const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
let answer = 201;
const logs: string[] = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-push-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-push-proj-'));
  const webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: PORT, projects: [{ name: 'p', runner: 'local', path: projectRoot }] }), store, () => {}));
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: SESSION_TITLE, parentId: null, permissionMode: 'default', role: 'session' });
  store.createSession({ id: 'm1', project: 'p', runner: 'local', title: 'lead', parentId: null, permissionMode: 'default', role: 'manager' });
  // Waiting already when Ledung starts: not new.
  store.createQuestion({ sessionId: 's1', question: 'before the start', options: null, addressedTo: 'user' });
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: Buffer.from(init!.body as Uint8Array) });
    return new Response(null, { status: answer });
  }) as typeof fetch;
  server = new LedungServer({
    port: PORT, token: TOKEN, store, manager, webRoot, publicName: PUBLIC,
    computers: [{ id: PUBLIC, name: 'Studio PC', colour: 'teal', url: `https://${PUBLIC}/`, here: true, config: { name: 'Studio PC', colour: 'teal' } }],
    push: { keyFile: path.join(dir, 'remote', 'push-vapid.json'), fetch: fakeFetch, log: (l) => logs.push(l) },
  });
  await server.listen();
});

after(async () => {
  await server.close();
  removeTemp(dir);
  removeTemp(projectRoot);
});

function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${PORT}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const pub = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) => request({ ...opts, headers: { host: PUBLIC, ...opts.headers } });
const pubChange = (p: string, body: unknown, cookie: string, extra: Record<string, string> = {}) =>
  pub({ method: 'POST', path: p, headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });

function page(headers: Record<string, string>, host?: string): Promise<{ key: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: host ? { ...headers, host } : headers });
    ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close() }));
    ws.on('error', reject);
  });
}

/** A phone as it really pairs: the code from Settings here, the form on the public name, its passkey, unlocked. */
async function pairedPhone(name = 'Phone') {
  const here = await page({ cookie: COOKIE, origin: ORIGIN });
  const made = await request({ method: 'POST', path: '/api/devices-pair', headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json', 'x-ledung-page': here.key }, body: '{}' });
  here.close();
  assert.equal(made.status, 200, made.body);
  const code = new URL(JSON.parse(made.body).url).pathname.slice('/p/'.length);
  const done = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/pair', headers: { host: PUBLIC, origin: PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }, resolve);
    req.on('error', reject);
    req.end(new URLSearchParams({ code, name }).toString());
  });
  done.resume();
  const value = /__Host-ledung_device=([0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  const cookie = `__Host-ledung_device=${value}`;
  const id = server.devices.byCookie(value)!.id;
  const open = await page({ cookie, origin: PUBLIC_ORIGIN }, PUBLIC);
  const withKey = { 'x-ledung-page': open.key };
  const key = new FakePasskey(PUBLIC);
  const options = JSON.parse((await pubChange('/api/passkey-options', {}, cookie, withKey)).body);
  assert.equal((await pubChange('/api/passkey', { response: key.register(options) }, cookie, withKey)).status, 200);
  const challenge = JSON.parse((await pubChange('/api/passkey-challenge', { method: 'POST', path: '/api/device-unlock', body: '{}' }, cookie)).body);
  assert.equal((await pubChange('/api/device-unlock', {}, cookie, { ...withKey, 'x-ledung-passkey': key.header(challenge) })).status, 200);
  return { cookie, id, withKey, close: () => open.close() };
}

/** A new item as the sessions make it, through the server's broadcast like every event the page gets. */
function newQuestion(addressedTo = 'user', question = SECRET) {
  const q = store.createQuestion({ sessionId: 's1', question, options: null, addressedTo });
  server.broadcast({ type: 'question', question: q });
  return q;
}
function newPermission(addressedTo = 'user') {
  const p = store.createPermission({ id: crypto.randomUUID(), sessionId: 's1', toolName: 'Bash', input: { command: SECRET_COMMAND }, title: SECRET_COMMAND, reason: SECRET, sensitive: 'command matches /prod/' });
  const info = { ...p, addressedTo };
  server.broadcast({ type: 'permission', permission: info });
  return info;
}
const settle = async () => server.push!.settled();
const take = () => sent.splice(0);

test('push is only for a paired device through the public name: not on this computer, not without the page', async () => {
  assert.equal((await request({ path: '/api/push', headers: { cookie: COOKIE } })).status, 404);
  const local = await request({ method: 'POST', path: '/api/push', headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: phone().subscription }) });
  assert.equal(local.status, 404, local.body);
  assert.equal((await pub({ path: '/api/push' })).status, 401, 'not paired');
  const p = await pairedPhone('No page');
  try {
    const noPage = await pubChange('/api/push', { subscription: phone().subscription }, p.cookie);
    assert.equal(noPage.status, 403, noPage.body);
    assert.equal(server.push!.subscribed(p.id), false);
    // From the wrong origin, page key and all.
    const elsewhere = await pub({ method: 'POST', path: '/api/push', headers: { cookie: p.cookie, origin: 'https://evil.test', 'content-type': 'application/json', ...p.withKey }, body: JSON.stringify({ subscription: phone().subscription }) });
    assert.equal(elsewhere.status, 403);
    const bad = await pubChange('/api/push', { subscription: phone('https://127.0.0.1:4317/api/away').subscription }, p.cookie, p.withKey);
    assert.equal(bad.status, 400);
    assert.equal(server.push!.subscribed(p.id), false);
  } finally {
    server.revokeDevice(p.id);
    p.close();
  }
});

test('one subscription per device: on, on again replaces it, off removes it', async () => {
  const p = await pairedPhone('One');
  try {
    const state = JSON.parse((await pub({ path: '/api/push', headers: { cookie: p.cookie } })).body);
    assert.equal(state.on, false);
    assert.equal(u(state.publicKey).length, 65, 'the VAPID public key, uncompressed P-256');
    const first = phone(), second = phone();
    assert.equal((await pubChange('/api/push', { subscription: first.subscription }, p.cookie, p.withKey)).status, 200);
    assert.equal((await pubChange('/api/push', { subscription: second.subscription }, p.cookie, p.withKey)).status, 200);
    assert.equal(JSON.parse((await pub({ path: '/api/push', headers: { cookie: p.cookie } })).body).on, true);
    const rows = store.database.prepare('SELECT endpoint FROM push_subscriptions WHERE device_id = ?').all(p.id) as { endpoint: string }[];
    assert.deepEqual(rows.map((r) => r.endpoint), [second.subscription.endpoint]);
    take();
    newQuestion();
    await settle();
    assert.deepEqual(take().map((s) => s.url), [second.subscription.endpoint]);
    assert.equal((await pubChange('/api/push-off', {}, p.cookie)).status, 200);
    assert.equal(server.push!.subscribed(p.id), false);
    newQuestion();
    await settle();
    assert.equal(take().length, 0, 'switched off: nothing sent');
  } finally {
    server.revokeDevice(p.id);
    p.close();
  }
});

test('revoking a device deletes its subscription and stops its notifications', async () => {
  const a = await pairedPhone('Kept'), b = await pairedPhone('Revoked');
  try {
    const kept = phone(), gone = phone();
    assert.equal((await pubChange('/api/push', { subscription: kept.subscription }, a.cookie, a.withKey)).status, 200);
    assert.equal((await pubChange('/api/push', { subscription: gone.subscription }, b.cookie, b.withKey)).status, 200);
    const revoked = await request({ method: 'POST', path: `/api/devices/${b.id}/revoke`, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(revoked.status, 200, revoked.body);
    assert.equal(server.push!.subscribed(b.id), false);
    take();
    newQuestion();
    await settle();
    assert.deepEqual(take().map((s) => s.url), [kept.subscription.endpoint]);
    // A device revoked without going through the server (another way in later): its row is never sent to.
    server.push!.subscribe(b.id, gone.subscription);
    server.devices.revoke(a.id);
    server.push!.subscribe(a.id, kept.subscription);
    newQuestion();
    await settle();
    assert.equal(take().length, 0, 'only live devices are sent to');
  } finally {
    server.revokeDevice(a.id);
    server.revokeDevice(b.id);
    a.close();
    b.close();
  }
});

test('a notification carries the computer, the kind and the item, never the question, the command or the session', async () => {
  const p = await pairedPhone('Reader');
  try {
    const ph = phone();
    assert.equal((await pubChange('/api/push', { subscription: ph.subscription }, p.cookie, p.withKey)).status, 200);
    take();
    const q = newQuestion();
    const perm = newPermission();
    await settle();
    const got = take();
    assert.equal(got.length, 2);
    for (const s of got) {
      assert.equal(s.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(s.headers.TTL, '86400');
      assert.match(s.headers.Authorization!, /^vapid t=.+, k=.+$/);
      for (const secret of [SECRET, SECRET_COMMAND, SESSION_TITLE, 'patient', 'kubectl']) {
        assert.ok(!s.body.includes(secret), `not in the clear: ${secret}`);
        assert.ok(!JSON.stringify(ph.read(s.body)).includes(secret), `not in the payload either: ${secret}`);
      }
    }
    assert.deepEqual(ph.read(got[0]!.body), { computer: 'Studio PC', kind: 'question', item: `q${q.id}`, open: `/#/waiting/q/${q.id}` });
    assert.deepEqual(ph.read(got[1]!.body), { computer: 'Studio PC', kind: 'permission', item: `p${perm.id}`, open: '/#/s/s1' });
  } finally {
    server.revokeDevice(p.id);
    p.close();
  }
});

test('the items the page notifies about, each once: not a manager\'s, not one already waiting at the start, not when answered', async () => {
  const p = await pairedPhone('Rules');
  try {
    const ph = phone();
    assert.equal((await pubChange('/api/push', { subscription: ph.subscription }, p.cookie, p.withKey)).status, 200);
    take();
    // Already waiting when the server started (made in before), sent again as an update.
    const early = store.listQuestions().find((x) => x.question === 'before the start')!;
    server.broadcast({ type: 'question', question: early });
    newQuestion('m1');
    newPermission('m1');
    await settle();
    assert.equal(take().length, 0, 'nothing new for the user');
    const q = newQuestion();
    server.broadcast({ type: 'question', question: q });
    await settle();
    assert.equal(take().length, 1, 'once, though the event came twice');
    store.answerQuestion(q.id, 'yes', 'user');
    server.broadcast({ type: 'question', question: store.getQuestion(q.id)! });
    await settle();
    assert.equal(take().length, 0, 'answered: nothing');
  } finally {
    server.revokeDevice(p.id);
    p.close();
  }
});

test('a subscription the push service no longer knows (410) is dropped; with no public name nothing is sent', async () => {
  const p = await pairedPhone('Gone');
  try {
    assert.equal((await pubChange('/api/push', { subscription: phone().subscription }, p.cookie, p.withKey)).status, 200);
    take();
    answer = 410;
    newQuestion();
    await settle();
    assert.equal(take().length, 1);
    assert.equal(server.push!.subscribed(p.id), false);
    assert.ok(logs.some((l) => /no longer knows/.test(l)), logs.join('\n'));
    answer = 201;
    server.push!.subscribe(p.id, phone().subscription);
    server.setPublicName(null, null);
    newQuestion();
    await settle();
    assert.equal(take().length, 0, 'left the relay: nothing sent');
  } finally {
    server.setPublicName(PUBLIC, null);
    server.revokeDevice(p.id);
    p.close();
  }
});
