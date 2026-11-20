// The page around a passkey prompt (#179): before the first prompt it says what is about to happen (and that a
// locked phone asks twice), and a check that didn't go through offers a retry. What Ledung requires is
// unchanged (test/server-security.test.ts): this is only what the page shows and when it asks again.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, connectionClosed, connectionHello, DEVICE_LOCKED, openConnection, PASSKEY_CANCELLED, PASSKEY_NEEDED,
  resetPasskeyExplained, setPasskeyCalls, setPasskeyPrompter, setVouchCall, signPoll, type PasskeyStep,
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
  setVouchCall(null);
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

/**
 * Stands in for Ledung for the Mac app's sign link (#463): a locked device, a link per challenge asked for with
 * `browser`, and the browser's answers to pick up, given out in turn from `answers` per link (null: not signed yet;
 * an Error: Ledung's refusal). The unlock carrying an answer picked up goes through, and the device is unlocked then.
 */
function signLinks(answers: (string | null | Error)[][]) {
  const sent: { path: string; body?: unknown; passkey?: string }[] = [];
  const links: string[] = [];
  const signed = new Set<string>();
  let unlocked = false;
  globalThis.fetch = (async (path: string, init: { headers: Record<string, string>; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ path, body, passkey: init.headers['X-Ledung-Passkey'] });
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    if (path === '/api/passkey-challenge') {
      assert.equal(body.browser, true, 'the Mac app asks for a sign link, never a passkey prompt');
      const code = `code-${links.length + 1}`;
      links.push(code);
      return answer(200, { url: `https://pc.example.test/sign.html#${code}`, code, expiresAt: 0 });
    }
    if (path === '/api/passkey-sign-answer') {
      const next = answers[links.indexOf(body.code)]!.shift() ?? null;
      if (next instanceof Error) return answer(403, { error: next.message });
      if (next) signed.add(next);
      return answer(200, { answer: next });
    }
    if (path === '/api/device-unlock') {
      if (!signed.has(init.headers['X-Ledung-Passkey'] ?? '')) return answer(403, { error: PASSKEY_NEEDED });
      unlocked = true;
      return answer(200, { unlockedUntil: 1 });
    }
    return unlocked ? answer(200, {}) : answer(403, { error: DEVICE_LOCKED });
  }) as typeof fetch;
  return { sent, links };
}

/** The dialog as the page has it: a browser step closes by itself once its answer arrives (or fails); `cancel` says Cancel. */
function browserDialog(cancel: (step: PasskeyStep) => boolean = () => false): PasskeyStep[] {
  const shown: PasskeyStep[] = [];
  setPasskeyPrompter(async (step) => {
    shown.push(step);
    if (cancel(step)) return false;
    if (step.browser) await step.browser.signed.catch(() => {});
    return true;
  });
  return shown;
}

test('in the Mac app a check is signed in the browser from a sign link, and the change goes through with no further click', { timeout: HANG_MS }, async () => {
  publicPage();
  setPasskeyCalls(macAppPasskeys);
  signPoll.ms = 1;
  try {
    // The browser has not signed on the first two looks, then has.
    const { sent, links } = signLinks([[null, null, 'answer-1']]);
    const shown = browserDialog();
    await api.setPaused('s1', true);
    assert.equal(shown.length, 1, 'one step: the link, then the change goes on by itself');
    assert.equal(shown[0]!.kind, 'unlock');
    assert.equal(shown[0]!.browser?.url, 'https://pc.example.test/sign.html#code-1');
    assert.deepEqual(links, ['code-1']);
    // Locked: the change, the unlock tried unsigned, the link for the unlock, three looks, the unlock signed, the change again.
    assert.deepEqual(sent.map((r) => r.path), [
      '/api/sessions/s1/pause', '/api/device-unlock', '/api/passkey-challenge',
      '/api/passkey-sign-answer', '/api/passkey-sign-answer', '/api/passkey-sign-answer', '/api/device-unlock', '/api/sessions/s1/pause',
    ]);
    // The link is for exactly the request that waits: its method, path and body.
    assert.deepEqual(sent[2]!.body, { method: 'POST', path: '/api/device-unlock', body: '{}', browser: true });
    assert.deepEqual(sent[3]!.body, { code: 'code-1' });
    assert.equal(sent[6]!.passkey, 'answer-1', 'the unlock carries the browser\'s answer');
  } finally {
    signPoll.ms = 1000;
  }
});

test('in the Mac app a sign link that ran out says why and offers a new one; Cancel stops asking', { timeout: HANG_MS }, async () => {
  publicPage();
  setPasskeyCalls(macAppPasskeys);
  signPoll.ms = 1;
  try {
    const gone = 'This sign link is not valid any more: it was used, or its two minutes ran out. Make the change again in the app.';
    const { sent, links } = signLinks([[null, new Error(gone)], ['answer-2']]);
    const shown = browserDialog();
    await api.setPaused('s1', true);
    assert.deepEqual(links, ['code-1', 'code-2'], 'Try again made a new link');
    assert.deepEqual(shown.map((s) => s.failed ?? s.browser?.url), ['https://pc.example.test/sign.html#code-1', gone, 'https://pc.example.test/sign.html#code-2']);
    assert.ok(sent.some((r) => r.path === '/api/device-unlock' && r.passkey === 'answer-2'));

    // Cancel on the browser step: the change is not sent, and the app stops looking for an answer.
    const again = signLinks([[]]);
    browserDialog((step) => step.browser !== undefined);
    await assert.rejects(api.setPaused('s2', true), (e: Error) => e.message === PASSKEY_CANCELLED);
    await new Promise((r) => setTimeout(r, 20));
    const looks = again.sent.filter((r) => r.path === '/api/passkey-sign-answer').length;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(again.sent.filter((r) => r.path === '/api/passkey-sign-answer').length, looks, 'no more looks after Cancel');
    assert.ok(looks <= 1, `at most the look already under way: ${looks}`);
    assert.deepEqual(again.sent.slice(0, 3).map((r) => r.path), ['/api/sessions/s2/pause', '/api/device-unlock', '/api/passkey-challenge']);
    assert.equal(again.sent.filter((r) => r.path === '/api/sessions/s2/pause').length, 1, 'the change not sent again');
  } finally {
    signPoll.ms = 1000;
  }
});

// A computer that trusts this one's screen (#313) needs no passkey from its frame: that route keeps working in the
// Mac app (test review of PR #458, finding 2).
test('in the Mac app a frame of a computer that trusts this screen is vouched for, with no Mac line', { timeout: HANG_MS }, async () => {
  publicPage();
  setPasskeyCalls(macAppPasskeys);
  const vouched: string[] = [];
  setVouchCall(async (challenge) => { vouched.push(challenge); });
  const sent: { path: string; vouch?: string }[] = [];
  globalThis.fetch = (async (path: string, init: { headers: Record<string, string> }) => {
    sent.push({ path, vouch: init.headers['X-Ledung-Vouch'] });
    if (path === '/api/passkey-challenge') return new Response(JSON.stringify({ vouch: 'v-1' }), { status: 200 });
    if (!init.headers['X-Ledung-Vouch']) return new Response(JSON.stringify({ error: PASSKEY_NEEDED }), { status: 403 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const shown = dialog([false, false]);
  await api.decide('perm-1', { behavior: 'allow' });
  assert.deepEqual(vouched, ['v-1']);
  assert.deepEqual(sent, [
    { path: '/api/permissions/perm-1', vouch: undefined }, { path: '/api/passkey-challenge', vouch: undefined }, { path: '/api/permissions/perm-1', vouch: 'v-1' },
  ]);
  assert.deepEqual(shown, [], 'no dialog: the vouch needs no passkey');
});

test('in the Mac app setting up a passkey says the same line at once', { timeout: HANG_MS }, async () => {
  publicPage();
  setPasskeyCalls(macAppPasskeys);
  globalThis.fetch = (async () => new Response(JSON.stringify({ challenge: 'chal' }), { status: 200 })) as typeof fetch;
  await assert.rejects(api.addPasskey(), (e: Error) => e.message === MAC_APP_NO_PASSKEY);
});

test('the Mac app\'s browser step offers Sign in the browser, then only waits; failures stay a retry', () => {
  const browser = { url: 'https://pc.example.test/sign.html#c', signed: new Promise<string>(() => {}) };
  const sign = passkeyWords({ kind: 'sign', browser });
  assert.equal(sign.title, 'Sign in your browser');
  assert.equal(sign.go, 'Sign in the browser');
  assert.match(sign.body.join(' '), /can't show Touch ID/);
  assert.equal(passkeyWords({ kind: 'unlock', browser }).title, 'Log on in your browser');
  const waiting = passkeyWords({ kind: 'sign', browser }, true);
  assert.equal(waiting.title, 'Waiting for your browser');
  assert.equal(waiting.go, null, 'no Go while waiting: only Cancel');
  assert.equal(passkeyWords({ kind: 'sign', failed: PASSKEY_CANCELLED }).go, 'Try again', 'any failure stays a retry');
});
