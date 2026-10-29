// The passkey window's messages (issue #273, enrol.html): Martin on Windows with no Windows Hello saw only "error".
// The reason in plain words with the browser's own error name and message, and before trying, when this computer
// has no way to make a passkey, what to set up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A plain browser module with no types; imported by a computed path so the type check leaves it alone.
const path = '../web/public/enrol-messages.js';
const m = await import(path) as {
  noPlatformPasskey(userAgent: string): string;
  passkeyError(e: unknown): string;
  NO_WEBAUTHN: string;
};

const dom = (name: string, message: string) => Object.assign(new Error(message), { name });

test('no platform passkey: Windows says to set up Windows Hello, a Mac Touch ID; both name a phone or Bitwarden', () => {
  const windows = m.noPlatformPasskey('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36');
  assert.equal(windows, 'No passkey on this computer: set up Windows Hello (a PIN is enough) in Settings → Accounts → Sign-in options, or use a phone or a password manager such as Bitwarden.');
  const mac = m.noPlatformPasskey('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15');
  assert.match(mac, /^No passkey on this computer: set up Touch ID/);
  assert.match(m.noPlatformPasskey('Mozilla/5.0 (X11; Linux x86_64)'), /a phone or a password manager such as Bitwarden/);
});

test('a failed try names the reason in plain words and the browser\'s own error, never a bare "error"', () => {
  const notAllowed = m.passkeyError(dom('NotAllowedError', 'The operation either timed out or was not allowed.'));
  assert.match(notAllowed, /^The passkey was not made: it was cancelled, it timed out, or this computer has no way to make one/);
  assert.match(notAllowed, /\(NotAllowedError: The operation either timed out or was not allowed\.\)$/);
  assert.match(m.passkeyError(dom('NotSupportedError', 'x')), /can't make this kind of passkey.*\(NotSupportedError: x\)$/);
  assert.match(m.passkeyError(dom('SecurityError', 'bad rp')), /refused to make a passkey for this address.*\(SecurityError: bad rp\)$/);
  assert.match(m.passkeyError(dom('InvalidStateError', 'y')), /already has a passkey/);
  // What Martin saw: a message that is just "error" is never all that shows.
  for (const e of [dom('UnknownError', 'error'), dom('SomethingNew', 'error'), dom('NotAllowedError', '')]) {
    const text = m.passkeyError(e);
    assert.notEqual(text.trim().toLowerCase(), 'error');
    assert.ok(text.length > 30, text);
    assert.ok(text.includes(e.name), `${text} names ${e.name}`);
  }
  // Ledung's own refusal (its answer) is shown as it is.
  assert.equal(m.passkeyError(new Error('This link is not valid any more.')), 'This link is not valid any more.');
  assert.match(m.NO_WEBAUTHN, /can't make passkeys/);
});
