// The relay admin's side of Invite a computer (issue #237): Settings → Relay's files, the Approve card, and the CAA
// record written through Cloudflare's API, which is mocked here (never the real one). The relay's admin API is stood
// in for too; the relay's own side is tested in relay-invite.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADMIN_FILE, RelayAdmin } from '../src/remote/admin.ts';
import { Cloudflare } from '../src/remote/cloudflare.ts';
import { JOIN_TOKEN_BYTES, newJoinToken, parseJoinCode } from '../src/remote/join-code.ts';
import type { NewComputerInfo } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';

const CF = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = 'https://acme-v02.api.letsencrypt.org/acme/acct/123456';
// RFC 8659/8657: an issue record for Let's Encrypt naming the one account, by TLS-ALPN-01 only (relay-e2e.md C1).
const VALUE = `letsencrypt.org; accounturi=${ACCOUNT}; validationmethods=tls-alpn-01`;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeTemp(dir);
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-relay-admin-'));
  dirs.push(dir);
  return dir;
};

type Call = { method: string; url: string; auth: string | null; body: unknown };
type Handler = (call: Call) => { status?: number; body: unknown } | undefined;

/** A fetch that answers from handlers in turn and records every call. Anything unhandled is a failed test. */
function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? 'GET', url: String(input), auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const answer = handler(call);
    if (!answer) throw new Error(`unexpected ${call.method} ${call.url}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls };
}

const cf = (result: unknown) => ({ body: { success: true, errors: [], result } });

/** Cloudflare with a zone for example.org and the CAA records already there per name. */
function cloudflareApi(existing: Record<string, number> = {}): Handler {
  return (c) => {
    if (!c.url.startsWith(CF)) return undefined;
    const url = new URL(c.url);
    if (c.method === 'GET' && url.pathname.endsWith('/zones')) {
      return cf(url.searchParams.get('name') === 'example.org' ? [{ id: 'zone-1', name: 'example.org' }] : []);
    }
    if (c.method === 'GET' && url.pathname.endsWith('/zones/zone-1/dns_records')) {
      assert.equal(url.searchParams.get('type'), 'CAA');
      return cf(Array.from({ length: existing[url.searchParams.get('name') ?? ''] ?? 0 }, (_, i) => ({ id: `r${i}` })));
    }
    if (c.method === 'POST' && url.pathname.endsWith('/zones/zone-1/dns_records')) return cf({ id: 'new' });
    return undefined;
  };
}

test('Cloudflare: the record goes in the zone holding the name, as one CAA issue record with flags 0', async () => {
  const { fetcher, calls } = mockFetch(cloudflareApi());
  await new Cloudflare('zone-token', fetcher).addCaa({ name: 'copper7meadow4.l.example.org', value: VALUE });
  assert.ok(calls.every((c) => c.auth === 'Bearer zone-token'));
  // Walks up from the name: copper7meadow4.l.example.org, l.example.org, example.org.
  assert.deepEqual(calls.filter((c) => c.url.includes('/zones?')).map((c) => new URL(c.url).searchParams.get('name')), ['copper7meadow4.l.example.org', 'l.example.org', 'example.org']);
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal(post.url, `${CF}/zones/zone-1/dns_records`);
  assert.deepEqual(post.body, { type: 'CAA', name: 'copper7meadow4.l.example.org', ttl: 1, data: { flags: 0, tag: 'issue', value: VALUE } });
});

test('Cloudflare: a name with any CAA record already is refused, never changed', async () => {
  const { fetcher, calls } = mockFetch(cloudflareApi({ 'taken.l.example.org': 1 }));
  await assert.rejects(new Cloudflare('zone-token', fetcher).addCaa({ name: 'taken.l.example.org', value: VALUE }), /already has a CAA record/);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], 'no write of any kind');
});

test('Cloudflare: a refusal says why, and never repeats the token', async () => {
  const { fetcher } = mockFetch(() => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null } }));
  await assert.rejects(new Cloudflare('secret-zone-token', fetcher).addCaa({ name: 'a.example.org', value: VALUE }), (e: Error) => {
    assert.match(e.message, /Cloudflare refused \(403\): Authentication error/);
    assert.equal(e.message.includes('secret-zone-token'), false);
    return true;
  });
  const none = mockFetch(cloudflareApi());
  await assert.rejects(new Cloudflare('t', none.fetcher).addCaa({ name: 'a.example.net', value: VALUE }), /reaches no zone/);
});

/** The relay's admin API, stood in for: one invite, then the computer that used it. */
function relayApi(state: { key: () => string | undefined; computers: { name: string; owner: string; host: string; accountUrl: string | null; enrolledAt: number | null; approved: boolean }[] }): Handler {
  return (c) => {
    if (!c.url.startsWith('https://relay.example.org/')) return undefined;
    if (c.auth !== `Bearer ${state.key()}`) return { status: 401, body: { error: 'no' } };
    const route = `${c.method} ${new URL(c.url).pathname}`;
    if (route === 'POST /admin/invites') {
      const body = c.body as { owner: string; name?: string };
      const name = body.name ?? 'copper7meadow4';
      return { body: { id: 'inv1', owner: body.owner, name, host: `${name}.l.example.org`, expiresAt: 1_900_000_000_000, token: newJoinToken(Buffer.alloc(JOIN_TOKEN_BYTES, 7)) } };
    }
    if (route === 'GET /admin/invites') return { body: { invites: [] } };
    if (route === 'GET /admin/computers') return { body: { computers: state.computers } };
    const approved = /^POST \/admin\/computers\/([^/]+)\/approved$/.exec(route);
    if (approved) {
      const computer = state.computers.find((x) => x.name === decodeURIComponent(approved[1]!));
      if (!computer) return { status: 404, body: { error: 'no such computer' } };
      computer.approved = true;
      return { body: { ok: true } };
    }
    return undefined;
  };
}

function admin(handler: Handler) {
  const dir = tempDir();
  const { fetcher, calls } = mockFetch(handler);
  const sent: NewComputerInfo[][] = [];
  const timers: (() => void)[] = [];
  const a = new RelayAdmin({ dir, fetch: fetcher, onComputers: (c) => sent.push(c), log: () => {}, setTimer: (fn) => timers.push(fn), clearTimer: () => {} });
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, ADMIN_FILE), 'utf8'));
  return { a, dir, calls, sent, timers, saved };
}

test('the admin key is made here and shown only as its SHA-256; the Cloudflare token is kept and only said to be set', () => {
  const { a, saved } = admin(() => undefined);
  assert.deepEqual(a.view(), { relay: null, keySha256: null, tokenSet: false });
  a.update({ relay: 'wss://relay.example.org/' });
  const view = a.makeKey();
  const key = saved().adminKey as string;
  assert.equal(Buffer.from(key, 'base64url').length, 32, '256 bits');
  assert.deepEqual(view, { relay: 'wss://relay.example.org', keySha256: crypto.createHash('sha256').update(key, 'utf8').digest('hex'), tokenSet: false });
  assert.deepEqual(a.update({ cloudflareToken: '  tok-123  ' }), { ...view, tokenSet: true });
  assert.equal(saved().cloudflareToken, 'tok-123');
  assert.equal(a.update({ cloudflareToken: '' }).tokenSet, false, 'an empty token removes it');
  assert.equal(JSON.stringify(a.view()).includes(key), false);
  for (const bad of ['https://relay.example.org', 'ws://relay.example.org', 'wss://relay.example.org/agent', 'nonsense']) {
    assert.throws(() => a.update({ relay: bad }), /wss:\/\//, bad);
  }
});

test('Invite a computer: the relay reserves the name with the admin key, and the code carries the relay and its token', async () => {
  let key: string | undefined;
  const state = { key: () => key, computers: [] };
  const { a, calls, saved, timers } = admin(relayApi(state));
  await assert.rejects(a.invite('Friend', undefined), /relay's address/);
  a.update({ relay: 'wss://relay.example.org' });
  await assert.rejects(a.invite('Friend', undefined), /admin key/);
  a.makeKey();
  key = saved().adminKey;
  const invite = await a.invite('  Friend ', undefined);
  assert.equal(invite.host, 'copper7meadow4.l.example.org');
  assert.deepEqual(calls.at(-1)!.body, { owner: 'Friend' });
  const parsed = parseJoinCode(invite.code);
  assert.equal(parsed.relay, 'wss://relay.example.org');
  assert.equal(parsed.token, newJoinToken(Buffer.alloc(JOIN_TOKEN_BYTES, 7)));
  assert.equal(timers.length, 1, 'asks the relay for new computers in a minute while the invite is open');
  await assert.rejects(a.invite('', undefined), /owner/);

  key = 'another';
  await assert.rejects(a.invite('Friend', undefined), /did not accept the admin key/);
});

test('a joined computer becomes an Approve card; Approve writes its CAA record through Cloudflare and tells the relay', async () => {
  let key: string | undefined;
  const state = { key: () => key, computers: [{ name: 'copper7meadow4', owner: 'Friend', host: 'copper7meadow4.l.example.org', accountUrl: ACCOUNT, enrolledAt: 5, approved: false }] };
  const both: Handler = (c) => relayApi(state)(c) ?? cloudflareApi()(c);
  const { a, calls, sent, saved } = admin(both);
  a.update({ relay: 'wss://relay.example.org' });
  a.makeKey();
  key = saved().adminKey;

  const listed = await a.list();
  const card = { name: 'copper7meadow4', owner: 'Friend', host: 'copper7meadow4.l.example.org', accountUrl: ACCOUNT, record: `copper7meadow4.l.example.org. CAA 0 issue "${VALUE}"`, enrolledAt: 5, approvable: false };
  assert.deepEqual(listed.computers, [card]);
  assert.deepEqual(sent.at(-1), [card]);
  await assert.rejects(a.approve('copper7meadow4'), /No Cloudflare token/, 'Copy only without a token');
  assert.equal(calls.some((c) => c.url.startsWith(CF)), false);

  a.update({ cloudflareToken: 'zone-token' });
  assert.deepEqual(sent.at(-1), [{ ...card, approvable: true }], 'the card can Approve once a token is set');
  const approved = await a.approve('copper7meadow4');
  assert.equal(approved.record, card.record);
  const post = calls.find((c) => c.method === 'POST' && c.url.startsWith(CF))!;
  assert.deepEqual(post.body, { type: 'CAA', name: 'copper7meadow4.l.example.org', ttl: 1, data: { flags: 0, tag: 'issue', value: VALUE } });
  assert.equal(post.auth, 'Bearer zone-token');
  assert.equal(state.computers[0]!.approved, true, 'the relay was told');
  assert.deepEqual(sent.at(-1), [], 'the card is gone');
  // The admin key went only to the relay, the zone token only to Cloudflare.
  assert.ok(calls.filter((c) => c.url.startsWith(CF)).every((c) => c.auth === 'Bearer zone-token'));
  assert.ok(calls.filter((c) => c.url.startsWith('https://relay.')).every((c) => c.auth === `Bearer ${key}`));
});

test('what the relay says about a computer can\'t break out of the record: a bad account URL or host gives no card', async () => {
  let key: string | undefined;
  const good = { name: 'ok', owner: 'A', host: 'ok.l.example.org', accountUrl: ACCOUNT, enrolledAt: 1, approved: false };
  const state = { key: () => key, computers: [
    good,
    { ...good, name: 'quote', accountUrl: `${ACCOUNT}"; issue "evil.example` },
    { ...good, name: 'semi', accountUrl: `${ACCOUNT}; validationmethods=dns-01` },
    { ...good, name: 'plain', accountUrl: 'http://acme.example/acct/1' },
    { ...good, name: 'host', host: 'Evil Host' },
    { ...good, name: 'none', accountUrl: null },
    { ...good, name: 'done', approved: true },
  ] };
  const { a, saved } = admin(relayApi(state));
  a.update({ relay: 'wss://relay.example.org' });
  a.makeKey();
  key = saved().adminKey;
  assert.deepEqual((await a.list()).computers.map((c) => c.name), ['ok']);
});

test('without a token the admin adds the record by hand and marks it added: the card goes, Cloudflare is never asked', async () => {
  let key: string | undefined;
  const state = { key: () => key, computers: [{ name: 'byhand', owner: 'B', host: 'byhand.l.example.org', accountUrl: ACCOUNT, enrolledAt: 1, approved: false }] };
  const { a, calls, sent, saved } = admin(relayApi(state));
  a.update({ relay: 'wss://relay.example.org' });
  a.makeKey();
  key = saved().adminKey;
  await a.list();
  await a.markAdded('byhand');
  assert.equal(state.computers[0]!.approved, true);
  assert.deepEqual(sent.at(-1), []);
  assert.equal(calls.some((c) => c.url.startsWith(CF)), false);
  await assert.rejects(a.markAdded('byhand'), /No computer named byhand/);
});
