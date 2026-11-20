// What the page says around a passkey prompt (#179), kept apart from web/src/passkey.ts so tests and the core
// type check need no DOM.
import { PASSKEY_CANCELLED, type PasskeyCalls, type PasskeyStep } from './api.ts';

/**
 * Ledung's desktop app on a Mac can't reach Touch ID (#427): Electron serves it only to an app signed with Apple's
 * keychain entitlement, and the app is signed ad hoc (#572). Probe on Electron 45.4.1, 2026-11-20: no platform
 * authenticator before or after app.configureWebAuthn, a passkey request left pending past its own timeout, and an
 * ad hoc app carrying the entitlement killed by macOS at launch. So the step is done in the browser instead.
 */
export const MAC_APP_NO_PASSKEY = "The Ledung app on a Mac can't show Touch ID: make this change in your browser.";

/** The desktop app (Electron, as installApp.ts tells it) on a Mac; on Windows it has Windows Hello, so it asks as before. */
export const macAppWithoutPasskeys = (userAgent: string): boolean => /\bElectron\//.test(userAgent) && /Macintosh/.test(userAgent);

/** The passkey calls in the Mac app: each says why at once instead of a request that never ends. */
export const macAppPasskeys: PasskeyCalls = {
  unavailable: MAC_APP_NO_PASSKEY,
  sign: () => Promise.reject(new Error(MAC_APP_NO_PASSKEY)),
  create: () => Promise.reject(new Error(MAC_APP_NO_PASSKEY)),
};

/** Cancel in the phone's own prompt (or its time running out) rejects as NotAllowedError, not null: the same words as a cancel. */
export const asCancelled = (e: unknown): unknown => ((e as { name?: unknown } | null)?.name === 'NotAllowedError' ? new Error(PASSKEY_CANCELLED) : e);

/** What the passkey dialog (components/PasskeyDialog.tsx) says at each step (#179). */
export function passkeyWords(step: PasskeyStep): { title: string; body: string[]; go: string; openInBrowser?: true } {
  // Go opens this page in the default browser: the app hands a link to another computer's page to it (#427).
  if (step.failed === MAC_APP_NO_PASSKEY) return { title: 'Make this change in your browser', body: [MAC_APP_NO_PASSKEY], go: 'Open in browser', openInBrowser: true };
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
