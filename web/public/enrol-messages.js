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

/** The sign page's (sign.html, #463) reasons: there the passkey is used, not made. */
const SIGN_REASONS = {
  NotAllowedError: 'The passkey check was cancelled or timed out. Press the button to try again.',
  SecurityError: 'The browser refused the passkey for this address. Open the link exactly as the app gave it, at its https:// address.',
  AbortError: 'The passkey check was stopped before it finished. Press the button to try again.',
};

/** A failed passkey check on the sign page in plain words, then the browser's own error name and message. */
export function signError(e) {
  const name = e && typeof e.name === 'string' ? e.name : '';
  const message = e && typeof e.message === 'string' ? e.message.trim() : String(e ?? '').trim();
  if (name === 'Error' || (!name && message)) return message || 'The passkey check did not go through. Press the button to try again.';
  const reason = SIGN_REASONS[name] ?? 'The passkey check did not go through. Press the button to try again.';
  const detail = [name, message && message.toLowerCase() !== 'error' ? message : ''].filter(Boolean).join(': ');
  return detail ? `${reason} (${detail})` : reason;
}

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

/**
 * What the sign page says (#481, Martin's variant A, Ledung question #751): what is asked, the rules and how long a
 * log-on lasts, from what Ledung sends with the link (`terms`: src/server/passkeys.ts SignTerms), never from numbers
 * kept here. Text parts are { text, bold? }, so a device's name is never read as HTML.
 */
export function signWords(name, what, terms) {
  const t = terms || {};
  const link = `${t.linkMinutes} minute${t.linkMinutes === 1 ? '' : 's'}`;
  if (t.logOn && t.kind === 'computer') {
    const lasts = `until you log it out, or ${t.idleDays} days without use`;
    return {
      title: 'Log this Mac on to Ledung',
      lead: [{ text: name, bold: true }, { text: ' asks to log on. Until it does, it can look at everything but change nothing.' }],
      factsTitle: 'What logging on means',
      rules: [
        [{ text: 'The app can make changes: send messages, allow prompts, start and stop sessions.' }],
        [{ text: 'It ' }, { text: 'stays logged on', bold: true }, { text: ' until you log it out (Settings → Phones), remove it, or it goes ' },
          { text: `${t.idleDays} days unused`, bold: true }, { text: '. A restart doesn\'t log it out.' }],
        [{ text: 'Allowing a sensitive prompt, and settings such as pairing, away mode and usage stops, still ask for Touch ID each time.' }],
      ],
      button: 'Log on with Touch ID',
      fine: `This link signs only this log-on, once, and runs out in ${link}. Didn't ask for it? Close this tab: nothing happens.`,
      doneTitle: 'Logged on',
      doneLead: [{ text: name, bold: true }, { text: ` is logged on ${lasts}.` }],
    };
  }
  if (t.logOn) {
    const lasts = `for ${t.unlockMinutes} minutes`;
    return {
      title: 'Unlock the Ledung app',
      lead: [{ text: name, bold: true }, { text: ' asks to be unlocked. Until it is, it can look at everything but change nothing.' }],
      factsTitle: 'What unlocking means',
      rules: [
        [{ text: 'The app can make changes: send messages, allow prompts, start and stop sessions.' }],
        [{ text: 'It ' }, { text: `stays unlocked ${lasts}`, bold: true }, { text: ', then locks again by itself.' }],
        [{ text: 'Allowing a sensitive prompt, and settings such as pairing, away mode and usage stops, still ask for Touch ID each time.' }],
      ],
      button: 'Unlock with Touch ID',
      fine: `This link signs only this unlock, once, and runs out in ${link}. Didn't ask for it? Close this tab: nothing happens.`,
      doneTitle: 'Unlocked',
      doneLead: [{ text: name, bold: true }, { text: ` is unlocked ${lasts}.` }],
    };
  }
  return {
    title: 'Allow one change from the Ledung app',
    lead: [{ text: name, bold: true }, { text: ' needs your passkey for this, and only this:' }],
    request: what,
    factsTitle: 'The rules',
    rules: [
      [{ text: 'Signs this one request, once. It can\'t be reused or changed into another.' }],
      [{ text: 'It does ' }, { text: 'not', bold: true }, { text: ' log the app on.' }],
      [{ text: `The link runs out in ${link}.` }],
    ],
    button: 'Allow with Touch ID',
    fine: 'Didn\'t ask for it? Close this tab: nothing happens.',
    doneTitle: 'Allowed',
    doneLead: [{ text: 'Signed for ' }, { text: name, bold: true }, { text: ': the change goes through in the app by itself.' }],
  };
}
