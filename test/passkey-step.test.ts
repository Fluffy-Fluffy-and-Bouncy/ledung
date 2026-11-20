// The page around a passkey prompt (#179): before the first prompt it says what is about to happen (and that a
// locked phone asks twice), and a check that didn't go through offers a retry. What Ledung requires is
// unchanged (test/server-security.test.ts): this is only what the page shows and when it asks again.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, connectionClosed, connectionHello, DEVICE_LOCKED, openConnection, PASSKEY_CANCELLED, PASSKEY_NEEDED,
  resetPasskeyExplained, setPasskeyCalls, setPasskeyPrompter, type PasskeyStep,
} from '../web/src/api.ts';
import { asCancelled, MAC_APP_NO_PASSKEY, macAppPasskeys, macAppWithoutPasskeys, passkeyWords } from '../web/src/passkeyWords.ts';
import { HANG_MS } from './limits.ts';

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
test('Cancel on the notice asks for no passkey and sends nothing more, and the next signature is explained again', { timeout: HANG_MS }, async () => {
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

// Issue #427: Ledung's desktop app on a Mac gets no Touch ID prompt (Electron serves it only to an app signed with
// Apple's keychain entitlement; the app is ad hoc signed) and a passkey request there hangs. The User-Agents: the Mac
// one as Electron 45.4.1's page sent it on magto-mini, 2026-11-20; the Windows one the same format with Chromium's
// Windows platform part; Chrome and Safari as those browsers send them.
const MAC_APP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ledung/0.0.0 Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36';
const WINDOWS_APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Ledung/0.0.0 Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36';
const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

test('only the desktop app on a Mac counts as having no passkey prompt; Windows (Windows Hello) and the browsers ask as before', () => {
  assert.equal(macAppWithoutPasskeys(MAC_APP_UA), true);
  assert.equal(macAppWithoutPasskeys(WINDOWS_APP_UA), false);
  assert.equal(macAppWithoutPasskeys(MAC_CHROME_UA), false);
  assert.equal(macAppWithoutPasskeys(MAC_SAFARI_UA), false);
});

// The timeout is the backstop: a check that reached the passkey call would hang, as in the app.
test('in the Mac app a check says in one line to use the browser, at once: no notice, no passkey call, no retry, nothing sent', { timeout: HANG_MS }, async () => {
  publicPage();
  setPasskeyCalls(macAppPasskeys);
  const sent = ledung({ locked: true });
  const shown = dialog([true, true, true]);
  await assert.rejects(api.setPaused('s1', true), (e: Error) => e.message === MAC_APP_NO_PASSKEY);
  assert.deepEqual(shown, [{ kind: 'unlock', failed: MAC_APP_NO_PASSKEY }], 'one step, the reason, even after Open in browser');
  // The unlock is tried unsigned first, as in 'a retry turned down …' above; then no challenge, and no change again.
  assert.deepEqual(sent, ['/api/sessions/s1/pause', '/api/device-unlock'], 'no challenge asked for and the change not sent again');
  // The same page with the browser's calls goes on to a challenge: the probe above reaches the passkey path.
  setPasskeyCalls({ sign: async () => 'signature', create: async () => ({}) });
  await api.setPaused('s1', true);
  assert.ok(sent.includes('/api/passkey-challenge'));
});

test('in the Mac app setting up a passkey says the same line at once', { timeout: HANG_MS }, async () => {
  publicPage();
  setPasskeyCalls(macAppPasskeys);
  globalThis.fetch = (async () => new Response(JSON.stringify({ challenge: 'chal' }), { status: 200 })) as typeof fetch;
  await assert.rejects(api.addPasskey(), (e: Error) => e.message === MAC_APP_NO_PASSKEY);
});

test('the Mac app\'s words are one line and offer to open the page in the browser', () => {
  const words = passkeyWords({ kind: 'sign', failed: MAC_APP_NO_PASSKEY });
  assert.deepEqual(words.body, [MAC_APP_NO_PASSKEY]);
  assert.equal(words.go, 'Open in browser');
  assert.equal(words.openInBrowser, true);
  assert.equal(passkeyWords({ kind: 'sign', failed: PASSKEY_CANCELLED }).openInBrowser, undefined, 'any other failure stays a retry');
});
