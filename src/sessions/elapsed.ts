// How much time has passed, for sessions and their managers (issue #265): a session got the time with each
// prompt but no sense of how long it had worked, and a manager saw "running" without "for how long".
import type { SessionInfo } from '../shared/protocol.ts';

const MINUTE = 60_000;

/** A span, short: "under 1 min", "23 min", "2 h", "1 h 10 min", "3 d". */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)} d`;
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const parts = (d: Date, o: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(new Intl.DateTimeFormat('en-GB', { ...o, hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));

const clock = (d: Date) => { const p = parts(d, { hour: '2-digit', minute: '2-digit' }); return `${p.hour}:${p.minute}`; };
const day = (d: Date) => { const p = parts(d, { weekday: 'short', day: 'numeric', month: 'short' }); return `${p.weekday} ${p.day} ${p.month}`; };

/** A moment before now: its clock time, with the day when it was another day. */
const at = (then: Date, now: Date) => (day(then) === day(now) && now.getTime() - then.getTime() < 86_400_000 ? clock(then) : `${day(then)} ${clock(then)}`);

/**
 * The time line at the top of every prompt, e.g.
 * "Current local time: Tue 20 Oct 2026 14:04 CEST · last message 13:41 (23 min ago) · session started 12:05 (2 h)".
 * A part that doesn't exist yet (no earlier message) is left out.
 */
export function promptTimeLine(now: Date, lastPrompt: number | null, started: number | null): string {
  const p = parts(now, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const out = [`Current local time: ${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`];
  if (lastPrompt != null && lastPrompt <= now.getTime()) out.push(`last message ${at(new Date(lastPrompt), now)} (${span(now.getTime() - lastPrompt)} ago)`);
  if (started != null && started <= now.getTime()) out.push(`session started ${at(new Date(started), now)} (${span(now.getTime() - started)})`);
  return out.join(' · ');
}

const STATE: Partial<Record<SessionInfo['status'], string>> = { waiting: 'waiting for an answer' };

/** A session's state with how long it has been in it, for list_sessions: "running for 23 min", "ended 2 h ago". */
export function stateFor(s: Pick<SessionInfo, 'status' | 'statusSince'>, now: number): string {
  const word = STATE[s.status] ?? s.status;
  if (s.statusSince == null || s.statusSince > now) return word;
  return s.status === 'ended' ? `ended ${span(now - s.statusSince)} ago` : `${word} for ${span(now - s.statusSince)}`;
}
