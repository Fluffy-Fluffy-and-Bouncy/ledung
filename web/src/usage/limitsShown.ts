// Which of an account's limit windows the sidebar draws (issue #284). Pure, so the rules are tested without a browser.

/** Each window's own length: a window whose last reading is older than this has had a whole window since. */
export const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 86400_000,
  seven_day_opus: 7 * 86400_000,
  seven_day_sonnet: 7 * 86400_000,
  seven_day_overage_included: 7 * 86400_000,
};

/**
 * Claude Code's "overage-included weekly" window: a per-model weekly bucket that counts extra usage too, sent only for
 * some accounts (its own schema's words). It is drawn in the weekly meter's hover, not as a meter of its own (#284).
 */
export const FOLDED_INTO: Record<string, string> = { seven_day_overage_included: 'seven_day' };

export interface ShownReading {
  kind: string;
  at: number;
  seenAt?: number;
}

const seen = (r: ShownReading) => r.seenAt ?? r.at;

/**
 * The meters to draw, and the windows folded into another meter's hover, keyed by the meter they fold into.
 * A window is left out while it has had no reading for longer than its own length and the account has reported
 * another window since then: the plan doesn't send it (Martin, issue #284: "5-hour hidden when the plan has none").
 * A reading brings it back. A window with a stop that holds is always drawn, so the hold stays in view.
 */
export function shownLimits<T extends ShownReading>(limits: T[], now: number, holding: ReadonlySet<string> = new Set()): { shown: T[]; folded: Map<string, T> } {
  const newest = Math.max(-Infinity, ...limits.map(seen));
  const kept = limits.filter((l) => {
    const length = WINDOW_MS[l.kind];
    if (length === undefined || holding.has(l.kind)) return true;
    return !(now - seen(l) > length && newest - seen(l) > length);
  });
  const folded = new Map<string, T>();
  const shown = kept.filter((l) => {
    const into = FOLDED_INTO[l.kind];
    if (!into || !kept.some((o) => o.kind === into)) return true;
    folded.set(into, l);
    return false;
  });
  return { shown, folded };
}
