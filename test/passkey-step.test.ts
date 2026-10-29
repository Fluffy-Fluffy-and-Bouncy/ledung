// The page around a passkey prompt (#179): before the first prompt it says what is about to happen (and that a
// locked phone asks twice), and a check that didn't go through offers a retry. What Ledung requires is
// unchanged (test/server-security.test.ts): this is only what the page shows and when it asks again.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, connectionClosed, connectionHello, DEVICE_LOCKED, openConnection, PASSKEY_CANCELLED, PASSKEY_NEEDED,
  resetPasskeyExplained, setPasskeyCalls, setPasskeyPrompter, type PasskeyStep,
} from '../web/src/api.ts';
import { asCancelled, passkeyWords } from '../web/src/passkeyWords.ts';

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
const g = globalThis as { location?: unknown };
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
  delete g.location;
  setPasskeyCalls(null);
  setPasskeyPrompter(null);
  resetPasskeyExplained();
  connectionClosed();
});

/** A page opened through the public name, with its live connection's key. */
function publicPage() {
  g.location = { protocol: 'https:' };
  globalThis.WebSocket = class extends EventTarget {} as unknown as typeof WebSocket;
  openConnection('wss://pc.example.test/ws');
  connectionHello('key');
}

/**
 * Stands in for Ledung as the issue's evidence describes it: a locked device must unlock (signed) before any
 * change, and a decision (standing for a sensitive one) is signed on its own besides. Words to a manager
 * ride the unlock with no signature of their own (Martin, 2026-10-18 10:41, issue #192).
 */
function ledung(opts: { locked: boolean }): string[] {
  const sent: string[] = [];
  let unlocked = !opts.locked;
  let challenges = 0;
  globalThis.fetch = (async (path: string, init: { headers: Record<string, string> }) => {
    sent.push(path);
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path === '/api/passkey-challenge') return answer(200, { challenge: `chal-${++challenges}` });
    if (path === '/api/device-unlock') {
      if (!init.headers['X-Ledung-Passkey']) return answer(403, { error: PASSKEY_NEEDED });
      unlocked = true;
      return answer(200, { unlockedUntil: 1 });
    }
    if (!unlocked) return answer(403, { error: DEVICE_LOCKED });
    if (path.startsWith('/api/permissions/') && !init.headers['X-Ledung-Passkey']) return answer(403, { error: PASSKEY_NEEDED });
    return answer(200, {});
  }) as typeof fetch;
  return sent;
}

/** Records every step the page would show, answering each in turn from `answers` (go on when it runs out). */
function dialog(answers: boolean[] = []): PasskeyStep[] {
  const shown: PasskeyStep[] = [];
  setPasskeyPrompter(async (step) => (shown.push(step), answers.shift() ?? true));
  return shown;
}

test('a locked phone answering a manager is told before the first prompt, once, and both checks follow', async () => {
  publicPage();
  const signed: string[] = [];
  setPasskeyCalls({ sign: async (o) => (signed.push(o.challenge), 'signature'), create: async () => ({}) });
  const sent = ledung({ locked: true });
  const shown = dialog();
  await api.decide('perm-1', { behavior: 'allow' });
  assert.deepEqual(shown, [{ kind: 'unlock' }], 'one notice, before the unlock; the signature after it goes straight on');
  assert.deepEqual(signed, ['chal-1', 'chal-2'], 'two passkey checks: unlock, then sign');
  assert.deepEqual(sent, ['/api/permissions/perm-1', '/api/device-unlock', '/api/passkey-challenge', '/api/device-unlock', '/api/permissions/perm-1', '/api/passkey-challenge', '/api/permissions/perm-1']);
});

// Martin, 2026-10-18 10:41 (issue #192): one Face ID, then no more; the page must not sign after every unlock.
test('a locked phone messaging a manager asks for one passkey check, the unlock, and the next message asks for none', async () => {
  publicPage();
  const signed: string[] = [];
  setPasskeyCalls({ sign: async (o) => (signed.push(o.challenge), 'signature'), create: async () => ({}) });
  const sent = ledung({ locked: true });
  const shown = dialog();
  await api.send('m1', 'merge #1');
  await api.send('m1', 'and #2');
  assert.deepEqual(shown, [{ kind: 'unlock' }]);
  assert.deepEqual(signed, ['chal-1'], 'one passkey check: the unlock');
  assert.deepEqual(sent, ['/api/sessions/m1/messages', '/api/device-unlock', '/api/passkey-challenge', '/api/device-unlock', '/api/sessions/m1/messages', '/api/sessions/m1/messages']);
});

test('an unlocked phone is told before its first signature on the page, not before every one', async () => {
  publicPage();
  setPasskeyCalls({ sign: async () => 'signature', create: async () => ({}) });
  ledung({ locked: false });
  const shown = dialog();
  await api.decide('perm-1', { behavior: 'allow' });
  await api.decide('perm-2', { behavior: 'allow' });
  assert.deepEqual(shown, [{ kind: 'sign' }]);
});

// A wrongly reached retry is turned down too (the second false), so a Cancel that is ignored fails here instead of
// retrying forever; the timeout is the backstop (#184 test review).
test('Cancel on the notice asks for no passkey and sends nothing more, and the next signature is explained again', { timeout: 5000 }, async () => {
  publicPage();
  setPasskeyCalls({ sign: async () => assert.fail('no prompt after Cancel'), create: async () => ({}) });
  const sent = ledung({ locked: false });
  const shown = dialog([false, false, false]);
  await assert.rejects(api.decide('perm-1', { behavior: 'allow' }), new RegExp(PASSKEY_CANCELLED));
  assert.deepEqual(sent, ['/api/permissions/perm-1']);
  await assert.rejects(api.decide('perm-2', { behavior: 'allow' }), new RegExp(PASSKEY_CANCELLED));
  assert.deepEqual(shown, [{ kind: 'sign' }, { kind: 'sign' }], 'a cancelled notice does not count as explained');
});

test('a cancelled check offers a retry, and Try again asks again over a fresh challenge', async () => {
  publicPage();
  const tries: string[] = [];
  setPasskeyCalls({
    sign: async (o) => {
      tries.push(o.challenge);
      if (tries.length === 1) throw new Error(PASSKEY_CANCELLED);
      return 'signature';
    },
    create: async () => ({}),
  });
  const sent = ledung({ locked: false });
  const shown = dialog([true, true]);
  await api.decide('perm-1', { behavior: 'allow' });
  assert.deepEqual(shown, [{ kind: 'sign' }, { kind: 'sign', failed: PASSKEY_CANCELLED }]);
  assert.deepEqual(tries, ['chal-1', 'chal-2']);
  assert.deepEqual(sent, ['/api/permissions/perm-1', '/api/passkey-challenge', '/api/passkey-challenge', '/api/permissions/perm-1']);
});

test('a retry turned down ends there, with the reason, and the change is not sent', async () => {
  publicPage();
  setPasskeyCalls({ sign: async () => { throw new Error(PASSKEY_CANCELLED); }, create: async () => ({}) });
  const sent = ledung({ locked: true });
  const shown = dialog([true, false]);
  await assert.rejects(api.setPaused('s1', true), new RegExp(PASSKEY_CANCELLED));
  assert.deepEqual(shown, [{ kind: 'unlock' }, { kind: 'unlock', failed: PASSKEY_CANCELLED }]);
  assert.deepEqual(sent, ['/api/sessions/s1/pause', '/api/device-unlock', '/api/passkey-challenge']);
});

test('Cancel in the phone\'s own prompt (NotAllowedError) reads as a cancelled check; other errors pass through', () => {
  const cancel = asCancelled(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
  assert.ok(cancel instanceof Error && cancel.message === PASSKEY_CANCELLED);
  const other = new DOMException('Not a valid domain.', 'SecurityError');
  assert.equal(asCancelled(other), other);
});

test('the words say what comes, that a locked phone asks twice, and offer Try again after a cancel', () => {
  const unlock = passkeyWords({ kind: 'unlock' });
  assert.match(unlock.body.join(' '), /30 minutes/);
  assert.match(unlock.body.join(' '), /second check/);
  assert.match(passkeyWords({ kind: 'sign' }).body.join(' '), /locked it asks twice/);
  assert.equal(passkeyWords({ kind: 'sign', failed: PASSKEY_CANCELLED }).go, 'Try again');
  const other = passkeyWords({ kind: 'sign', failed: 'Ledung is not reachable.' });
  assert.ok(other.body.includes('Ledung is not reachable.'), 'another failure shows its reason');
});
