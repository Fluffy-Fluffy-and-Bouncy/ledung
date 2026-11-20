// What the page says around a passkey prompt (#179), kept apart from web/src/passkey.ts so tests and the core
// type check need no DOM.
import { PASSKEY_CANCELLED, type PasskeyCalls, type PasskeyStep } from './api.ts';

/**
 * Ledung's desktop app on a Mac can't reach Touch ID (#427): Electron serves it only to an app signed with Apple's
 * keychain entitlement, and the app is signed ad hoc (#572). Probe on Electron 45.4.1, 2026-11-20: no platform
 * authenticator before or after app.configureWebAuthn, a passkey request left pending past its own timeout, and an
 * ad hoc app carrying the entitlement killed by macOS at launch. So a signature is made in the default browser instead,
 * through a one-time sign link (#463); setting the passkey up already is (the enrol link, #241).
 */
export const MAC_APP_NO_PASSKEY = "The Ledung app on a Mac can't show Touch ID: make this change in your browser.";

/** The desktop app (Electron, as installApp.ts tells it) on a Mac; on Windows it has Windows Hello, so it asks as before. */
export const macAppWithoutPasskeys = (userAgent: string): boolean => /\bElectron\//.test(userAgent) && /Macintosh/.test(userAgent);

/** The passkey calls in the Mac app: a signature is made in the browser (#463); none says why at once, never hangs. */
export const macAppPasskeys: PasskeyCalls = {
  inBrowser: true,
  sign: () => Promise.reject(new Error(MAC_APP_NO_PASSKEY)),
  create: () => Promise.reject(new Error(MAC_APP_NO_PASSKEY)),
};

/** Cancel in the phone's own prompt (or its time running out) rejects as NotAllowedError, not null: the same words as a cancel. */
export const asCancelled = (e: unknown): unknown => ((e as { name?: unknown } | null)?.name === 'NotAllowedError' ? new Error(PASSKEY_CANCELLED) : e);

/**
 * What the passkey dialog (components/PasskeyDialog.tsx) says at each step (#179). `opened`: a browser step's link is
 * open (#463), so it only waits; no Go then, only Cancel.
 */
export function passkeyWords(step: PasskeyStep, opened = false): { title: string; body: string[]; go: string | null } {
  // Signed in the default browser (#463): Go opens the one-time link there, the app hands it to the browser (#427).
  if (step.browser && opened) {
    return {
      title: 'Waiting for your browser',
      body: ['Use Touch ID in the browser tab that opened. This change goes through here by itself once it is signed; the link works for two minutes.'],
      go: null,
    };
  }
  if (step.browser) {
    return {
      title: step.kind === 'unlock' ? 'Log on in your browser' : 'Sign in your browser',
      body: [
        step.kind === 'unlock'
          ? "This device is locked. The Ledung app on a Mac can't show Touch ID, so your browser does the check that logs it on."
          : "The Ledung app on a Mac can't show Touch ID, so your browser signs this change.",
        'It opens on a one-time link, shows what is signed and asks for Touch ID. Then the change goes through here by itself.',
      ],
      go: 'Sign in the browser',
    };
  }
  if (step.failed) {
    return {
      title: step.failed === PASSKEY_CANCELLED ? 'The passkey check was cancelled' : "The passkey check didn't go through",
      body: [
        ...(step.failed === PASSKEY_CANCELLED ? [] : [step.failed]),
        'Nothing was changed. Try again to get the Face ID or fingerprint prompt back.',
      ],
      go: 'Try again',
    };
  }
  if (step.kind === 'unlock') {
    return {
      title: 'Unlock this device',
      body: [
        // A computer device (issue #241) logs on instead, until it logs out (decision 6 on #245).
        'This device is locked. Next comes a Face ID, fingerprint, Touch ID or Windows Hello check that unlocks it for changes: for 30 minutes on a phone; a computer stays logged on until you log out.',
        // Words to a manager are covered by the unlock since #192; a sensitive permission still is not.
        'A sensitive permission is also signed on its own, so then a second check follows straight after the first.',
      ],
      go: 'Continue',
    };
  }
  return {
    title: 'Sign with your passkey',
    body: [
      'Sensitive permissions are signed one by one: next comes a Face ID or fingerprint check for this one.',
      'When this device is locked it asks twice: first to unlock it, then to sign.',
    ],
    go: 'Continue',
  };
}
