// How old a limit reading is, and whether its window has reset since (issue #360). Ledung hears the plan's limits only
// during a session's turn, so after a start or an account switch a meter can show figures from hours ago, or from a
// window that has already reset; the meter says so instead of looking current.

/** From this age the meter shows it; younger readings show it in the hover only. An hour: Martin, question #329 (2026-10-28), "1: but at 60 min as the limit". */
export const SHOW_AGE_MS = 60 * 60_000;

export interface Reading {
  resetsAt: number | null;
  at: number;
  seenAt?: number;
}

/** The window has reset since the reading: its figure belongs to an earlier window. */
export function hasReset(r: Reading, now: number): boolean {
  return r.resetsAt != null && r.resetsAt <= now;
}

/** "as of 4 min ago", "as of 2 h ago", or "as of Tue 14:05" for a reading over a day old. */
export function readingAge(r: Reading, now: number): string {
  const seen = r.seenAt ?? r.at;
  const mins = Math.max(0, Math.floor((now - seen) / 60_000));
  if (mins < 1) return 'as of just now';
  if (mins < 60) return `as of ${mins} min ago`;
  if (mins < 24 * 60) return `as of ${Math.floor(mins / 60)} h ago`;
  return `as of ${new Date(seen).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/** The age to show on the meter itself, or null while the reading is recent. */
export function shownAge(r: Reading, now: number): string | null {
  return now - (r.seenAt ?? r.at) >= SHOW_AGE_MS ? readingAge(r, now) : null;
}
