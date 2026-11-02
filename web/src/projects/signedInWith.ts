import type { ShownSignIn } from '../../../src/shared/protocol.ts';

/** How an account is signed in, in words (#85); Claude Code's own answer, Ledung reads no sign-in. */
export function signedInWith(kind: ShownSignIn | null | undefined): string {
  if (kind === 'token') return 'Signed in with a long-lived token';
  if (kind === 'login') return 'Signed in with /login';
  if (kind === 'key') return 'Signed in with an API key';
  // Signed in in a way Ledung doesn't know: the row must not contradict the missing banner (Martin, question #519).
  if (kind === 'other') return 'Signed in';
  return 'Not signed in, or not checked yet';
}
