// Usage stops (issue #278): a plan-usage level per account and window (e.g. seven_day at 98%) at which Ledung
// holds new turns for every session and manager on that account, so some of the plan is kept for later.
// Kept free of sessions and timers so the rules can be tested: reached, lifted by hand, lifted on reset.
import type { LimitInfo, UsageStopInfo } from '../shared/protocol.ts';
import { shownPercent, stopNote } from '../shared/usage-stop-text.ts';

/** Percent per window kind (five_hour, seven_day, …), per account ("default": the computer's own login). */
export type UsageStops = Record<string, Record<string, number>>;

/** Stops lifted by hand: by `account\nkind`, the window (its resetsAt) they were lifted for. */
export type LiftedStops = Record<string, number | null>;

const HOUR = 3600_000;
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR };

export const liftKey = (account: string, kind: string): string => `${account}\n${kind}`;

/** Checks a stop from the page or a tool: a known shape, 1–100 percent. */
export function validStop(account: unknown, kind: unknown, percent: unknown): percent is number | null {
  if (typeof account !== 'string' || !account || typeof kind !== 'string' || !/^[a-z0-9_]{1,40}$/.test(kind)) return false;
  return percent === null || (typeof percent === 'number' && Number.isFinite(percent) && percent >= 1 && percent <= 100);
}

/**
 * Every set stop with where it stands. A stop holds when the window's recorded utilization has reached it,
 * the window has not reset since (a recorded resetsAt in the past means the figure is from an earlier window),
 * and it was not lifted by hand for this window.
 */
export function stopStates(stops: UsageStops, limits: LimitInfo[], lifted: LiftedStops, now: number): UsageStopInfo[] {
  const out: UsageStopInfo[] = [];
  for (const [account, kinds] of Object.entries(stops)) {
    for (const [kind, percent] of Object.entries(kinds)) {
      const l = limits.find((x) => x.account === account && x.kind === kind);
      // A figure with no reset time is taken to end a window's length after it was recorded: a held account sends
      // no new figures, so otherwise only Lift would release it (review 1 of #278, finding 3).
      const ends = l ? l.resetsAt ?? l.at + (WINDOW_MS[kind] ?? WINDOW_MS.seven_day!) : null;
      const reset = ends != null && ends <= now;
      const utilization = l && !reset ? l.utilization : null;
      // In basis points: 0.57 * 100 is 56.99999999999999 (finding 4).
      const reached = utilization != null && Math.round(utilization * 10000) >= Math.round(percent * 100);
      const key = liftKey(account, kind);
      // A real reset time names the window; an estimated one moves with every new figure, so a lift then lasts until the
      // end estimated when it was lifted (review 2 of #278, finding 1).
      const liftedFor = lifted[key];
      const isLifted = reached && key in lifted && (l?.resetsAt != null ? liftedFor === l.resetsAt : liftedFor != null && now < liftedFor);
      out.push({ account, kind, percent, utilization, resetsAt: reset ? null : ends, reached, lifted: isLifted, holding: reached && !isLifted });
    }
  }
  return out;
}

/** The stop holding an account's work now, if any. */
export function holdingStop(states: UsageStopInfo[], account: string): UsageStopInfo | undefined {
  return states.find((s) => s.holding && s.account === account);
}

/** When a holding stop's window resets, the earliest; null if none will (the stop then lifts by hand only). */
export function nextReset(states: UsageStopInfo[]): number | null {
  const times = states.filter((s) => s.holding && s.resetsAt != null).map((s) => s.resetsAt!);
  return times.length ? Math.min(...times) : null;
}

const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' };
export const windowName = (kind: string): string => WINDOW_NAMES[kind] ?? kind.replace(/_/g, ' ');

// Rounded down like the page's meter, so "2% to stop" adds up with the figure before it (issue #280).
const pct = (u: number) => `${shownPercent(u)}%`;
const clock = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const USAGE_RULE = "Information only: don't delay or ration work for it; Ledung's usage stop holds work if needed.";

/**
 * "Plan usage: 5-hour 41% (resets Tue 23:00; no stop set), weekly 92% (resets Thu 09:00, 6% to stop). Information
 * only: …" on every manager prompt, so managers know the limits (issue #278). The figures are not a reason to hold
 * work back, which the usage stop is for: a manager did on "weekly 96%" with no stop set (issue #284). Empty when
 * nothing is recorded for the account.
 */
export function promptUsageLine(limits: LimitInfo[], states: UsageStopInfo[], account: string, now: number): string {
  const parts: string[] = [];
  for (const kind of ['five_hour', 'seven_day']) {
    const l = limits.find((x) => x.account === account && x.kind === kind);
    if (!l || l.utilization == null) continue;
    const reset = l.resetsAt != null && l.resetsAt <= now;
    const stop = states.find((s) => s.account === account && s.kind === kind);
    const when = reset ? 'reset since' : l.resetsAt != null ? `resets ${clock(l.resetsAt)}` : '';
    const notes = stop
      ? [when, `${stopNote(stop)}${stop.holding ? ': work is held' : ''}`].filter(Boolean).join(', ')
      : [when, 'no stop set'].filter(Boolean).join('; ');
    parts.push(`${windowName(kind)} ${reset ? '0%' : pct(l.utilization)} (${notes})`);
  }
  return parts.length ? `Plan usage: ${parts.join(', ')}. ${USAGE_RULE}` : '';
}
