// What the passkey window (enrol.html, issue #241) says when a passkey can't be made (issue #273, Martin on Windows
// with no Windows Hello set up, 2026-10-20 20:27: he saw only "error"). Always the reason in plain words, with the
// browser's own error name and message after it; never a bare "error". Plain script module, no build; tested in Node.

/** Before trying: no way to make a passkey on this computer itself. The button stays: a phone or an extension may work. */
export function noPlatformPasskey(userAgent) {
  if (/Windows/i.test(userAgent)) {
    return 'No passkey on this computer: set up Windows Hello (a PIN is enough) in Settings → Accounts → Sign-in options, or use a phone or a password manager such as Bitwarden.';
  }
  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return 'No passkey on this computer: set up Touch ID or a login password in System Settings → Touch ID & Password, or use a phone or a password manager such as Bitwarden.';
  }
  return 'No passkey on this computer: set up a screen lock (a PIN is enough), or use a phone or a password manager such as Bitwarden.';
}

/** The browser has no passkeys at all (no WebAuthn). */
export const NO_WEBAUTHN = 'This browser can\'t make passkeys. Open this link in a current Chrome, Edge, Safari or Firefox.';

const REASONS = {
  NotAllowedError: 'The passkey was not made: it was cancelled, it timed out, or this computer has no way to make one (on Windows: Windows Hello; or a phone or a password manager such as Bitwarden). Press the button to try again.',
  NotSupportedError: 'This browser or computer can\'t make this kind of passkey. Try a phone, or a password manager such as Bitwarden.',
  SecurityError: 'The browser refused to make a passkey for this address. Open the link exactly as Ledung gave it, at its https:// address.',
  InvalidStateError: 'This computer already has a passkey for this device. Close this window and Log on in Ledung.',
  AbortError: 'Setting up the passkey was stopped before it finished. Press the button to try again.',
  ConstraintError: 'This computer can\'t make a passkey that checks who you are (a fingerprint, face or PIN). Set up Windows Hello or Touch ID, or use a phone.',
  UnknownError: 'The passkey could not be made, for a reason the browser did not give. Press the button to try again, or use a phone.',
};

/** A failed try in plain words, then the browser's own error name and message, so the real reason is always shown. */
export function passkeyError(e) {
  const name = e && typeof e.name === 'string' ? e.name : '';
  const message = e && typeof e.message === 'string' ? e.message.trim() : String(e ?? '').trim();
  // An error of Ledung's own (from its answer) is already plain words.
  if (name === 'Error' || (!name && message)) return message || REASONS.UnknownError;
  const reason = REASONS[name] ?? 'The passkey could not be made.';
  const detail = [name, message && message.toLowerCase() !== 'error' ? message : ''].filter(Boolean).join(': ');
  return detail ? `${reason} (${detail})` : reason;
}
