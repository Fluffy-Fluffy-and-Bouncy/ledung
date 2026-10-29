// What the page says around a passkey prompt (#179), kept apart from web/src/passkey.ts so tests and the core
// type check need no DOM.
import { PASSKEY_CANCELLED, type PasskeyStep } from './api.ts';

/** Cancel in the phone's own prompt (or its time running out) rejects as NotAllowedError, not null: the same words as a cancel. */
export const asCancelled = (e: unknown): unknown => ((e as { name?: unknown } | null)?.name === 'NotAllowedError' ? new Error(PASSKEY_CANCELLED) : e);

/** What the passkey dialog (components/PasskeyDialog.tsx) says at each step (#179). */
export function passkeyWords(step: PasskeyStep): { title: string; body: string[]; go: string } {
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
