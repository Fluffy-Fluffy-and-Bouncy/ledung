// The page's side of the passkey (issue #160, docs/steps/relay.md step 5): through the public name a change
// Ledung refused for want of the passkey goes again once, signed over a challenge for exactly the same text.
// On this computer (plain http) the same refusal asks for nothing.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, connectionClosed, connectionHello, DEVICE_LOCKED, openConnection, PASSKEY_NEEDED, setPasskeyCalls } from '../web/src/api.ts';

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
const g = globalThis as { location?: unknown };
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
  delete g.location;
  setPasskeyCalls(null);
  connectionClosed();
});

function livePage() {
  globalThis.WebSocket = class extends EventTarget {} as unknown as typeof WebSocket;
  openConnection('wss://pc.example.test/ws');
  connectionHello('key');
}

type Sent = { path: string; body: string | undefined; headers: Record<string, string> };

/** Stands in for Ledung: refuses the decision until it carries a passkey, and hands out one challenge. */
function ledung(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (path: string, init: { body?: string; headers: Record<string, string> }) => {
    sent.push({ path, body: init.body, headers: init.headers });
    if (path === '/api/passkey-challenge') return new Response(JSON.stringify({ challenge: 'chal', rpId: 'pc.example.test' }), { status: 200 });
    if (!init.headers['X-Ledung-Passkey']) return new Response(JSON.stringify({ error: PASSKEY_NEEDED }), { status: 403 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return sent;
}

test('through the public name, a refused page-key action is signed for its exact text and sent again once', async () => {
  g.location = { protocol: 'https:' };
  livePage();
  const signed: unknown[] = [];
  setPasskeyCalls({ sign: async (options) => (signed.push(options), 'signature'), create: async () => ({}) });
  const sent = ledung();
  await api.decide('perm-1', { behavior: 'allow' });
  assert.deepEqual(sent.map((s) => s.path), ['/api/permissions/perm-1', '/api/passkey-challenge', '/api/permissions/perm-1']);
  const text = JSON.stringify({ behavior: 'allow' });
  assert.deepEqual(JSON.parse(sent[1]!.body!), { method: 'POST', path: '/api/permissions/perm-1', body: text });
  assert.deepEqual(signed, [{ challenge: 'chal', rpId: 'pc.example.test' }]);
  assert.equal(sent[2]!.body, text, 'the same text the challenge was for');
  assert.equal(sent[2]!.headers['X-Ledung-Passkey'], 'signature');
  assert.equal(sent[2]!.headers['X-Ledung-Page'], 'key');
});

test('the page acts on exactly the refusals Ledung sends', async () => {
  const server = await import('../src/server/passkeys.ts');
  assert.equal(PASSKEY_NEEDED, server.PASSKEY_NEEDED);
  assert.equal(DEVICE_LOCKED, server.DEVICE_LOCKED);
});

test('through the public name, a change refused as locked unlocks the device (one signed unlock) and goes again', async () => {
  g.location = { protocol: 'https:' };
  livePage();
  setPasskeyCalls({ sign: async () => 'signature', create: async () => ({}) });
  const sent: Sent[] = [];
  let unlocked = false;
  globalThis.fetch = (async (path: string, init: { body?: string; headers: Record<string, string> }) => {
    sent.push({ path, body: init.body, headers: init.headers });
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path === '/api/passkey-challenge') return answer(200, { challenge: 'chal' });
    if (path === '/api/device-unlock') {
      if (!init.headers['X-Ledung-Passkey']) return answer(403, { error: PASSKEY_NEEDED });
      unlocked = true;
      return answer(200, { unlockedUntil: 1 });
    }
    return unlocked ? answer(200, {}) : answer(403, { error: DEVICE_LOCKED });
  }) as typeof fetch;
  await api.setPaused('s1', true);
  assert.deepEqual(sent.map((s) => s.path), ['/api/sessions/s1/pause', '/api/device-unlock', '/api/passkey-challenge', '/api/device-unlock', '/api/sessions/s1/pause']);
  assert.deepEqual(JSON.parse(sent[2]!.body!), { method: 'POST', path: '/api/device-unlock', body: '{}' }, 'the signature is for the unlock');
  assert.equal(sent[4]!.headers['X-Ledung-Passkey'], undefined, 'the change itself needs no signature once unlocked');
  assert.equal(sent[4]!.body, sent[0]!.body);
});

test('on this computer the same refusal asks for no passkey', async () => {
  g.location = { protocol: 'http:' };
  livePage();
  setPasskeyCalls({ sign: async () => assert.fail('no passkey locally'), create: async () => ({}) });
  const sent = ledung();
  await assert.rejects(api.decide('perm-1', { behavior: 'allow' }), new RegExp(PASSKEY_NEEDED));
  assert.deepEqual(sent.map((s) => s.path), ['/api/permissions/perm-1']);
});
