// No test reaches a real sign-in store (issue #347). The defaults are the real ones: the sign-out is, on macOS,
// the user's login Keychain, so a test that left it in place could remove a real Keychain entry; the sign-in checks run the installed Claude Code on the computer's own login
// (or `docker exec` in a real container), which reads it (review of PR #348, I1).
import type { SessionManager } from '../src/sessions/manager.ts';

/** What a test reached of a refused manager. The manager turns most of these errors into an answer, so they are counted here. */
const reached: string[] = [];
// At exit, not in an after() hook: a failing hook stops the file's own hooks (its server never closes and the run
// hangs), and an account added starts a check that can come after every hook.
process.on('exit', () => {
  if (!reached.length) return;
  console.error(`✖ a test reached a real sign-in store or check (#347): give it its own\n  ${reached.join('\n  ')}`);
  process.exitCode = 1;
});

/** A manager whose sign-in stores, sign-out and sign-in checks fail the test; a test that needs one sets its own after this. */
export function refuseRealSignInStores<M extends SessionManager>(manager: M): M {
  const refuse = (what: string) => async (): Promise<never> => {
    // Where in a test file it came from, for the message at the end.
    const at = new Error().stack?.split('\n').find((l) => /[\\/]test[\\/][^\\/]+\.test\.ts:/.test(l))?.trim() ?? 'a test';
    reached.push(`${what}, ${at}`);
    throw new Error(`a test reached the real ${what} (#347): set its own`);
  };
  manager.signOutWith = refuse('sign-out');
  manager.checkSignInWith = refuse('sign-in check');
  manager.checkContainerSignInWith = refuse('container sign-in check');
  return manager;
}
