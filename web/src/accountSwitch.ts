// A session's account switch (issue #395) as the page words it: in the session header and the sidebar row's
// tooltip while it waits, and after a switch that failed. Simon, 2026-11-19: "If I switch account, it should switch."
import type { SessionInfo } from '../../src/shared/protocol.ts';

/** An account by name; null: the computer's own login. */
export function accountName(account: string | null): string {
  return account ?? "the computer's own login";
}

/** What the session's switch looks like now; null: none to show. */
export function switchState(s: Pick<SessionInfo, 'accountSwitch' | 'status' | 'account'>):
  | { kind: 'pending'; text: string }
  | { kind: 'failed'; text: string; reason: string }
  | null {
  const sw = s.accountSwitch;
  if (!sw) return null;
  if (sw.failed) return { kind: 'failed', text: `Couldn't switch to ${accountName(sw.to)}; still on ${accountName(s.account)}.`, reason: sw.failed };
  // An ended one takes the new account when it is resumed.
  if (s.status === 'ended') return { kind: 'pending', text: `Resumes on ${accountName(sw.to)}` };
  return { kind: 'pending', text: `Switches to ${accountName(sw.to)} when this turn ends` };
}

/** The sidebar row's tooltip line for it; empty when there is none. */
export function switchTooltip(s: Pick<SessionInfo, 'accountSwitch' | 'status' | 'account'>): string {
  return switchState(s)?.text ?? '';
}
