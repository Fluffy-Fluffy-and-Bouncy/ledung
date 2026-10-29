// Where a plan limit is heading: the use so far, at the same average pace, carried on to the reset.

const HOUR = 3_600_000;
/** How long each window is, so its start can be worked out from when it resets. */
export const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR };

/**
 * The share (0–1, can go past 1) the window would end at if use goes on at its average pace so far. Null when
 * there is no telling yet: an unknown window, or less than a tenth of it gone, when one busy hour says little.
 */
export function atReset(kind: string, utilization: number, resetsAt: number | null, now = Date.now()): number | null {
  const length = WINDOW_MS[kind];
  if (!length || !resetsAt || resetsAt <= now) return null;
  const elapsed = now - (resetsAt - length);
  if (elapsed < length / 10) return null;
  return (utilization * length) / Math.min(elapsed, length);
}

/**
 * The forecast beside "resets in", which a ship meter always shows (issue #70): the share by the reset, or none
 * with the reason, so the row never disappears and never shows a wild number from a few minutes' pace.
 */
export function forecastAt(kind: string, utilization: number, resetsAt: number | null, now = Date.now()): { share: number } | { share: null; why: string } {
  const share = atReset(kind, utilization, resetsAt, now);
  if (share != null) return { share };
  if (!WINDOW_MS[kind]) return { share: null, why: 'No forecast for this window' };
  if (!resetsAt) return { share: null, why: 'No forecast: the reset time is not known yet' };
  if (resetsAt <= now) return { share: null, why: 'No forecast: the window is resetting' };
  return { share: null, why: 'No forecast yet: too little of the window has gone to tell the pace' };
}
