// How a usage stop (issue #278) is worded on the page's meters and in managers' prompt line, kept in one place so
// both say the same thing (issue #280: "Managers' prompt line uses the same wording").
import type { UsageStopInfo } from './protocol.ts';

/**
 * The figure the meter's ship shows: whole percent, rounded down, so the gap to the stop never looks smaller than it
 * is. Rounded to basis points first, as stopStates counts (#278 finding 4): 0.29 * 100 is 28.999… (review 1 of #280).
 */
export const shownPercent = (utilization: number | null): number => Math.max(0, Math.min(100, Math.floor(Math.round((utilization ?? 0) * 10_000) / 100)));

/** "2% to stop", "held at 95%", "stop at 95% lifted", or "stop at 95%" with no current figure. */
export function stopNote(s: UsageStopInfo): string {
  if (s.holding) return `held at ${s.percent}%`;
  if (s.lifted) return `stop at ${s.percent}% lifted`;
  // The recorded figure has expired: no "0%" or "95% to stop" next to a ship still showing the old one (review 1 of #280).
  if (s.utilization == null) return `stop at ${s.percent}%`;
  const left = s.percent - shownPercent(s.utilization);
  // Not reached yet but under a whole percent away: the figure rounds down, so it can meet the stop first.
  return `${Math.max(1, left)}% to stop`;
}

/** How a window is named in front of its reset: "5 h", "Weekly", "Weekly Opus"; an unknown kind is shown as it is (Martin, issue #392). */
const WINDOW_NAME: Record<string, string> = {
  five_hour: '5 h',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_overage_included: 'Weekly (incl. extra)',
  overage: 'Extra usage',
};

/** "5 h limit resets in 4 h", "Weekly limit resets in 2 d 4 h", "5 h limit resets in 40 min", "… resets now"; empty without a reset time. Minutes round up. */
export function resetsInText(resetsAt: number | null, now: number, kind: string): string {
  if (resetsAt == null) return '';
  const mins = Math.ceil((resetsAt - now) / 60_000);
  const lead = `${WINDOW_NAME[kind] ?? kind} limit resets`;
  if (mins <= 0) return `${lead} now`;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts = d ? [`${d} d`, h ? `${h} h` : ''] : [h ? `${h} h` : '', m ? `${m} min` : ''];
  return `${lead} in ${parts.filter(Boolean).join(' ')}`;
}

/** The line under a meter with a stop: "93% · 2% to stop · Weekly limit resets in 11 h 30 min", or once held "Held at 95% · Weekly limit resets in 9 h". */
export function meterStopLine(s: UsageStopInfo, now: number): string {
  const note = stopNote(s);
  const head = s.holding || s.utilization == null ? note[0]!.toUpperCase() + note.slice(1) : `${shownPercent(s.utilization)}% · ${note}`;
  const reset = resetsInText(s.resetsAt, now, s.kind);
  return reset ? `${head} · ${reset}` : head;
}
