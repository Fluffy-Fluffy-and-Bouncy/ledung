// A sidebar badge opens Waiting for you on its project (issue #322, Simon 2026-11-14: "I should be able to click on
// that thing by the manager to get to those questions ... in Waiting for you, but with the specific project filter
// on"). The project is shown for this visit only: the filter kept in the browser stays as it was, so opening
// Waiting for you the usual way shows what it always did (Done looks like 9). Pure, so it can be tested.
import type { PermissionInfo, QuestionInfo } from '../../src/shared/protocol.ts';
import { projectLabel } from '../../src/shared/protocol.ts';
import type { Filter } from './waitingLists.ts';

/** What a badge click asks for: its project, and the sessions its count is about (the row's, and any folded under it). */
export interface WaitingFocus {
  project: string;
  /** Empty for a folded project's badge: the whole project. */
  sessions: string[];
  /** The row clicked, for the line that says what is shown. */
  from: string;
}

/** The filter the view uses while a badge's project is shown: that project alone, the hidden list kept. */
export function focusFilter(saved: Filter, focus: WaitingFocus | null): Filter {
  return focus ? { mode: 'one', one: focus.project, hidden: saved.hidden } : saved;
}

/** "Show all": every project the All filter shows, kept in the browser like a press on All. */
export const showAll = (saved: Filter): Filter => ({ ...saved, mode: 'all' });

/** Who asked something that is with a manager, and how much: named on the line, since it is not in the view. */
export interface Aside { sessionId: string; count: number }

/**
 * Of the badge's count, what is not in Waiting for you because it is addressed to a manager (the sidebar badge counts
 * those too, on the session that asked), per session that asked, so the line can say whose it is and where (Done
 * looks like 7). A folded project's badge (no sessions) is about every session of its project.
 */
export function withManager(focus: WaitingFocus, questions: QuestionInfo[], permissions: PermissionInfo[], projectOf: (sessionId: string) => string): Aside[] {
  const mine = new Set(focus.sessions);
  const inScope = (id: string) => (mine.size ? mine.has(id) : projectOf(id) === focus.project);
  const counts = new Map<string, number>();
  const add = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const q of questions) if (q.status === 'open' && q.addressedTo !== 'user' && inScope(q.sessionId)) add(q.sessionId);
  for (const p of permissions) if (p.status === 'pending' && p.addressedTo !== 'user' && inScope(p.sessionId)) add(p.sessionId);
  return [...counts].map(([sessionId, count]) => ({ sessionId, count }));
}

/** A row's count of what is with a manager, from the counts per asking session (the sidebar's badge tooltip). */
export function asideCount(focus: WaitingFocus, bySession: Record<string, number>, projectOf: (sessionId: string) => string): number {
  const ids = focus.sessions.length ? focus.sessions : Object.keys(bySession).filter((id) => projectOf(id) === focus.project);
  return ids.reduce((n, id) => n + (bySession[id] ?? 0), 0);
}

/** The badge's tooltip and label (Done looks like 5), honest about what is with a manager rather than with you. */
export function badgeTitle(count: number, project: string, aside = 0): string {
  const where = projectLabel(project);
  if (!aside) return `${count} waiting for you in ${where} — open`;
  if (aside >= count) return `${count} in ${where} ${count === 1 ? 'is' : 'are'} with a manager, not waiting for you — open Waiting for you on ${where}`;
  return `${count} open in ${where}: ${count - aside} waiting for you, ${aside} with a manager — open`;
}
