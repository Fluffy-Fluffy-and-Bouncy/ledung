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

/**
 * Of the badge's count, what is not in Waiting for you because it is addressed to a manager (the sidebar badge counts
 * those too, on the session that asked), so the line can say where the rest is (Done looks like 7).
 */
export function withManager(focus: WaitingFocus, questions: QuestionInfo[], permissions: PermissionInfo[]): number {
  if (!focus.sessions.length) return 0;
  const mine = new Set(focus.sessions);
  return questions.filter((q) => q.status === 'open' && q.addressedTo !== 'user' && mine.has(q.sessionId)).length
    + permissions.filter((p) => p.status === 'pending' && p.addressedTo !== 'user' && mine.has(p.sessionId)).length;
}

/** The badge's tooltip and label (Done looks like 5). */
export function badgeTitle(count: number, project: string): string {
  return `${count} waiting in ${projectLabel(project)} — open Waiting for you for it`;
}
