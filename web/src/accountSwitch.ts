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
  const to = accountName(sw.to);
  if (sw.failed) return { kind: 'failed', text: `Couldn't switch to ${to}; still on ${accountName(s.account)}.`, reason: sw.failed };
  // An ended one takes the new account when it is resumed.
  if (s.status === 'ended') return { kind: 'pending', text: `Resumes on ${to}` };
  // What it waits for, as Ledung last found it (acceptance of #395): a Ready session isn't in a turn.
  switch (sw.waitsFor) {
    case 'paused': return { kind: 'pending', text: `Switches to ${to} once it is unpaused` };
    case 'command': return { kind: 'pending', text: `Switches to ${to} when its "!" command ends` };
    case 'background': return { kind: 'pending', text: `Switches to ${to} when its background work ends` };
    case 'wakeup': return { kind: 'pending', text: `Switches to ${to} after its scheduled wake-up` };
    case 'repeating': return { kind: 'pending', text: `Won't switch to ${to} on its own while it has a repeating wake-up; use Switch now` };
    default: return { kind: 'pending', text: `Switches to ${to} when this turn ends` };
  }
}

/** The sidebar row's tooltip line for it; empty when there is none. */
export function switchTooltip(s: Pick<SessionInfo, 'accountSwitch' | 'status' | 'account'>): string {
  return switchState(s)?.text ?? '';
}

/** A reason with what to type between backticks, as the sign-in banner shows it: plain text and code, in turn. */
export function reasonParts(reason: string): { text: string; code: boolean }[] {
  return reason.split('`').map((text, i) => ({ text, code: i % 2 === 1 })).filter((p) => p.text);
}
