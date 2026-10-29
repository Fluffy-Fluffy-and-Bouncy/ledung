// Invite a computer (issue #237), the relay's side: the admin API (invites, joined computers, Approve) that only the
// admin key opens, and /enrol, where a one-time join code adds a computer to the running relay, end to end. Then the
// whole flow with real pieces: the admin's Ledung invites, a joining Ledung joins and connects with no restart, and
// Approve writes the CAA record through Cloudflare's API (mocked: never the real one).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { INVITE_MS, parseRelayConfig, readInvites, Relay } from '../relay/relay.ts';
import { RelayAdmin } from '../src/remote/admin.ts';
import { RemoteLink, type RemoteServer } from '../src/remote/link.ts';
import { hashSecret } from '../src/remote/secret.ts';
import { Tunnel } from '../src/remote/tunnel.ts';
import type { AcmeClient } from '../src/server/acme.ts';
import type { NewComputerInfo } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { freePort } from './free-port.ts';

const T = { timeout: 20_000 };
const ADMIN_KEY = 'the admin key only the admin\'s Ledung holds';
const OLD_SECRET = 'the secret of the computer already there';
const ACCOUNT = 'https://acme-v02.api.letsencrypt.org/acme/acct/42';
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-relay-invite-'));
  cleanup.push(() => removeTemp(dir));
  return dir;
}

async function startRelay(opts: { adminKey?: string | null; invites?: string | null; now?: () => number; failed?: number } = {}) {
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(), bind: '127.0.0.1', passthroughPort: 0, domain: 'relay.test', relayUrl: 'wss://relay.relay.test',
    adminKeySha256: opts.adminKey === null ? undefined : hashSecret(opts.adminKey ?? ADMIN_KEY),
    limits: { headTimeoutMs: 300, ...(opts.failed ? { failedAttemptsPerAddress: opts.failed } : {}) },
    agents: [{ name: 'old', owner: 'admin', host: 'old.relay.test', secretSha256: hashSecret(OLD_SECRET), tls: 'passthrough' }],
  });
  const relay = new Relay(config, (line) => lines.push(line), { invites: opts.invites ?? null, now: opts.now });
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  const call = async (method: string, route: string, body?: unknown, key: string | null = ADMIN_KEY) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> & { error?: string } };
  };
  return { relay, port, lines, call };
}

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function connected(port: number, name: string, secret: string): Promise<Tunnel> {
  const tunnel = new Tunnel({ relay: `ws://127.0.0.1:${port}`, name, secret, publicName: `${name}.relay.test`, minDelayMs: 50, maxDelayMs: 200, connect: () => { throw new Error('no streams'); } });
  cleanup.push(() => tunnel.stop());
  tunnel.start();
  await waitFor(`${name} to connect`, () => tunnel.status().state === 'connected');
  return tunnel;
}

const enrolBody = (code: unknown, extra: Record<string, unknown> = {}) => ({ code, secretSha256: hashSecret('new secret'), accountUrl: ACCOUNT, ...extra });

test('the admin API answers only to the admin key, is off without one, and turns away an address that keeps guessing', T, async () => {
  const off = await startRelay({ adminKey: null });
  assert.equal((await off.call('GET', '/admin/invites')).status, 404, 'no adminKeySha256: no admin API');
  assert.equal((await off.call('POST', '/enrol', enrolBody('X'))).status, 404, 'and no enrolment');

  const { call, lines } = await startRelay({ failed: 3 });
  assert.equal((await call('GET', '/admin/invites', undefined, null)).status, 401, 'no key');
  assert.equal((await call('GET', '/admin/invites', undefined, 'wrong')).status, 401, 'a wrong key');
  assert.equal((await call('POST', '/admin/invites', { owner: 'x' }, 'wrong')).status, 401);
  assert.equal((await call('GET', '/admin/invites')).status, 429, 'after three failures even the right key waits out the window');
  assert.ok(lines.some((l) => l.includes('admin refused') && l.includes('wrong key')));
  assert.equal(lines.some((l) => l.includes(ADMIN_KEY)), false, 'the key is never logged');

  const fresh = await startRelay();
  assert.deepEqual((await fresh.call('GET', '/admin/invites')).body, { invites: [] });
  assert.equal((await fresh.call('GET', '/admin/nothing')).status, 404);
  assert.equal((await fresh.call('POST', '/admin/invites', 'x'.repeat(5000))).status, 413);
  assert.equal((await fresh.call('POST', '/admin/invites', '[1]')).status, 400);
});

test('a bad escape in the address is a counted wrong key without the key, and a 400 with it; never an api error (PR #239 review, Minor 1)', T, async () => {
  const { call, lines } = await startRelay({ failed: 2 });
  assert.equal((await call('GET', '/admin/invites/%E0')).status, 400, 'with the key: the name is not valid');
  assert.equal((await call('POST', '/admin/computers/%E0/approved')).status, 400);
  assert.equal((await call('DELETE', '/admin/invites/%E0', undefined, null)).status, 401, 'without the key: refused before decoding');
  assert.equal((await call('DELETE', '/admin/invites/%E0', undefined, null)).status, 401);
  assert.equal((await call('GET', '/admin/invites')).status, 429, 'both counted as failed attempts');
  assert.equal(lines.some((l) => l.includes('api error')), false, 'nothing reaches the log as an api error');
});

test('an invite reserves a word name for 24 hours and gives its token once; only its hash is kept', T, async () => {
  const file = path.join(tempDir(), 'relay.invites.json');
  let now = 1_000_000;
  const { relay, call } = await startRelay({ invites: file, now: () => now });
  const made = await call('POST', '/admin/invites', { owner: 'Friend' });
  assert.equal(made.status, 200);
  const invite = made.body as { id: string; owner: string; name: string; host: string; expiresAt: number; token: string };
  assert.match(invite.name, /^[a-z0-9]{1,22}$/);
  assert.equal(invite.host, `${invite.name}.l.relay.test`);
  assert.equal(invite.expiresAt, now + INVITE_MS);
  assert.match(invite.token, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  const kept = readInvites(file);
  assert.equal(kept.invites[0]!.tokenSha256, hashSecret(invite.token));
  assert.equal(fs.readFileSync(file, 'utf8').includes(invite.token), false, 'the token itself is not kept');
  const listed = (await call('GET', '/admin/invites')).body as { invites: Record<string, unknown>[] };
  assert.deepEqual(listed.invites, [{ id: invite.id, owner: 'Friend', name: invite.name, host: invite.host, expiresAt: invite.expiresAt }]);

  // The reserved name is taken for the admin command too, and for a second invite asking for it.
  assert.throws(() => relay.add({ hash: hashSecret('x'), owner: 'o', name: invite.name }), /taken/);
  assert.equal((await call('POST', '/admin/invites', { owner: 'Other', name: invite.name })).status, 400);
  const custom = await call('POST', '/admin/invites', { owner: 'Other', name: 'my-mac', host: 'mac.friend.example' });
  assert.equal(custom.status, 200);
  assert.equal(custom.body.host, 'mac.friend.example', 'the owner\'s own domain is allowed');
  assert.equal((await call('POST', '/admin/invites', { owner: '' })).status, 400);

  assert.equal((await call('DELETE', `/admin/invites/${custom.body.id as string}`)).status, 200);
  assert.equal((await call('DELETE', `/admin/invites/${custom.body.id as string}`)).status, 404);
  now += INVITE_MS;
  assert.deepEqual((await call('GET', '/admin/invites')).body, { invites: [] }, 'run out after 24 hours');
  assert.deepEqual(readInvites(file).invites, []);
});

test('a join code adds the computer to the running relay end to end, once; the computer already there stays connected', T, async () => {
  let now = 5_000;
  const { relay, port, call, lines } = await startRelay({ now: () => now });
  const old = await connected(port, 'old', OLD_SECRET);
  const invite = (await call('POST', '/admin/invites', { owner: 'Friend' })).body as { name: string; host: string; token: string };

  assert.equal((await call('POST', '/enrol', enrolBody(invite.token, { secretSha256: 'abc' }), null)).status, 400, 'a hash that is not one');
  assert.equal((await call('POST', '/enrol', enrolBody(invite.token, { accountUrl: `${ACCOUNT}"; issue "evil` }), null)).status, 400, 'an account URL that could break out of the CAA record');
  assert.equal((await call('POST', '/enrol', enrolBody(invite.token, { accountUrl: 'http://acme.test/acct/1' }), null)).status, 400);

  const joined = await call('POST', '/enrol', enrolBody(invite.token.toLowerCase()), null);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body, { name: invite.name, host: invite.host });
  const listed = relay.list().find((a) => a.name === invite.name)!;
  assert.deepEqual({ tls: listed.tls, from: listed.from, owner: listed.owner }, { tls: 'passthrough', from: 'added', owner: 'Friend' }, 'always end to end');
  assert.deepEqual((await call('GET', '/admin/invites')).body, { invites: [] }, 'the invite is used up');

  const again = await call('POST', '/enrol', enrolBody(invite.token), null);
  assert.equal(again.status, 401, 'a used code');
  assert.match(String(again.body.error), /not valid/);

  // Signs in with the secret whose hash it sent, while the computer already there stays connected.
  await connected(port, invite.name, 'new secret');
  assert.equal(old.status().state, 'connected');
  assert.deepEqual(relay.connected().sort(), ['old', invite.name].sort());

  // The admin's Ledung sees it waiting for its CAA record, and marks it approved.
  const waiting = (await call('GET', '/admin/computers')).body as { computers: Record<string, unknown>[] };
  assert.deepEqual(waiting.computers, [{ name: invite.name, owner: 'Friend', host: invite.host, accountUrl: ACCOUNT, enrolledAt: now, approved: false }]);
  assert.equal((await call('POST', `/admin/computers/${invite.name}/approved`, {})).status, 200);
  assert.equal(((await call('GET', '/admin/computers')).body as { computers: { approved: boolean }[] }).computers[0]!.approved, true);
  assert.equal((await call('POST', '/admin/computers/nobody/approved', {})).status, 404);
  assert.ok(lines.some((l) => l.includes('computer joined')));

  // Removed with the admin command: it is gone from the joined list too.
  relay.remove(invite.name);
  assert.deepEqual((await call('GET', '/admin/computers')).body, { computers: [] });

  // A code that ran out, or was revoked, is refused the same way.
  const late = (await call('POST', '/admin/invites', { owner: 'Late' })).body as { token: string };
  now += INVITE_MS + 1;
  assert.equal((await call('POST', '/enrol', enrolBody(late.token), null)).status, 401, 'run out');
  const revoked = (await call('POST', '/admin/invites', { owner: 'Revoked' })).body as { id: string; token: string };
  await call('DELETE', `/admin/invites/${revoked.id}`);
  assert.equal((await call('POST', '/enrol', enrolBody(revoked.token), null)).status, 401, 'revoked');
});

test('guessing join codes is turned away for the window, like guessing agent secrets', T, async () => {
  const { call, lines } = await startRelay({ failed: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/enrol', enrolBody(`AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA${i}`), null)).status, 401);
  const invite = (await call('POST', '/admin/invites', { owner: 'F' }, ADMIN_KEY)).status;
  assert.equal(invite, 429, 'the address is turned away, admin key or not');
  assert.equal(lines.filter((l) => l.includes('enrol refused')).length, 3);
});

test('invites and joined computers survive a restart of the relay', T, async () => {
  const dir = tempDir();
  const invites = path.join(dir, 'relay.invites.json');
  const first = await startRelay({ invites });
  const open = (await first.call('POST', '/admin/invites', { owner: 'Later' })).body as { name: string; token: string };
  await first.relay.close();
  const second = await startRelay({ invites });
  assert.equal(((await second.call('GET', '/admin/invites')).body as { invites: { name: string }[] }).invites[0]!.name, open.name);
  assert.equal((await second.call('POST', '/enrol', enrolBody(open.token), null)).status, 200, 'the code still works after the restart');
});

/** A stand-in ACME server's client, as in remote-link.test.ts: one account per key. */
function fakeAcme() {
  const known = new Set<string>();
  return (_directory: string, key: Buffer): AcmeClient => {
    const url = `https://acme.test/acct/${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    return {
      async createAccount(data) {
        if ('onlyReturnExisting' in data && !known.has(url)) throw new Error('accountDoesNotExist');
        known.add(url);
        return {};
      },
      getAccountUrl: () => url,
      createOrder: async () => { throw new Error('no orders'); },
      getAuthorizations: async () => [],
      getChallengeKeyAuthorization: async () => '',
      completeChallenge: async () => ({}),
      waitForValidStatus: async () => ({}),
      finalizeOrder: async () => { throw new Error('no orders'); },
      getCertificate: async () => '',
    };
  };
}

test('the whole flow: Invite in the admin\'s Ledung, Join with the code in another, connected with no restart, Approve writes the CAA record', T, async () => {
  // The admin's Ledung makes its key first; the relay's config gets only its hash.
  const adminDir = tempDir();
  const cloudflare: { method: string; url: string; body: unknown }[] = [];
  // Cloudflare's API, mocked; everything else goes to the real relay.
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.cloudflare.com/')) return fetch(input, init);
    cloudflare.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const u = new URL(url);
    const result = u.pathname.endsWith('/zones') ? (u.searchParams.get('name') === 'relay.test' ? [{ id: 'z', name: 'relay.test' }] : [])
      : init?.method === 'POST' ? { id: 'r' } : [];
    return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  }) as typeof fetch;
  const cards: NewComputerInfo[][] = [];
  const admin = new RelayAdmin({ dir: adminDir, fetch: fetcher, onComputers: (c) => cards.push(c), log: () => {}, setTimer: () => 0, clearTimer: () => {} });
  admin.makeKey();
  const adminKey = JSON.parse(fs.readFileSync(path.join(adminDir, 'relay-admin.json'), 'utf8')).adminKey as string;
  const { relay, port } = await startRelay({ adminKey });
  admin.update({ relay: `ws://127.0.0.1:${port}`, cloudflareToken: 'zone-token' });

  const invite = await admin.invite('Friend', undefined);

  // The joining Ledung: only the code.
  const names: (string | null)[] = [];
  const server: RemoteServer = {
    setPublicName: (name) => names.push(name), tunnelConnection: () => { throw new Error('no streams'); },
    setChallenge: () => {}, loadCertificate: () => {}, setCertificate: () => {}, setRemote: () => {},
  };
  const joining = new RemoteLink({ server, dir: tempDir(), acmeClient: fakeAcme(), log: () => {} });
  cleanup.push(() => joining.stop());
  const joined = await joining.join(invite.code);
  assert.equal(joined.publicName, invite.host);
  assert.deepEqual(names, [invite.host]);
  await waitFor('the joined computer to connect', () => relay.connected().includes(invite.name));

  // The admin's Ledung finds it waiting, as an Approve card with its exact record.
  const { computers } = await admin.list();
  assert.equal(computers.length, 1);
  const card = computers[0]!;
  assert.equal(card.host, invite.host);
  assert.match(card.accountUrl, /^https:\/\/acme\.test\/acct\//);
  assert.equal(card.record, `${invite.host}. CAA 0 issue "letsencrypt.org; accounturi=${card.accountUrl}; validationmethods=tls-alpn-01"`);
  assert.equal(card.approvable, true);

  await admin.approve(card.name);
  const post = cloudflare.find((c) => c.method === 'POST')!;
  assert.deepEqual(post.body, { type: 'CAA', name: invite.host, ttl: 1, data: { flags: 0, tag: 'issue', value: `letsencrypt.org; accounturi=${card.accountUrl}; validationmethods=tls-alpn-01` } });
  assert.deepEqual(cards.at(-1), [], 'the card is gone');
  assert.equal(relay.joinedComputers()[0]!.approved, true, 'and the relay knows');
});

test('the admin API and enrolment are reached only on the relay\'s HTTP port, never through a computer\'s name', T, async () => {
  const { port } = await startRelay();
  // A request for an agent's passthrough name on the HTTP port is refused before any route is looked at.
  const res = await new Promise<string>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /admin/invites HTTP/1.1\r\nHost: old.relay.test\r\nAuthorization: Bearer x\r\n\r\n'));
    let text = '';
    socket.on('data', (c) => (text += c));
    socket.on('close', () => resolve(text));
  });
  assert.match(res, /^HTTP\/1\.1 421 /);
});
