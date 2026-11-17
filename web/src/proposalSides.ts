// A proposed workflow change's two sides (workflow part 3e) and its maximised view (#334): what each side shows, which
// blocks change, and the history entry that lets Back close the big view instead of leaving the review.
import type { ProposalFlow } from '../../src/shared/flow-proposal.ts';
import type { Flow } from '../../src/shared/flow.ts';

export type SideName = 'before' | 'after';

/** The blocks of one side that the other doesn't have as they are: added or changed after, removed or changed before. */
export function changedBlocks(side: Flow | null, other: Flow | null): Set<string> {
  const there = new Map((other?.blocks ?? []).map((b) => [b.id, JSON.stringify({ ...b, at: 0 })]));
  return new Set((side?.blocks ?? []).filter((b) => there.get(b.id) !== JSON.stringify({ ...b, at: 0 })).map((b) => b.id));
}

/** Why a side has no diagram, in words, or null when it has one: a new flow has no before, a removed one no after. */
export function sideNote(name: SideName, side: ProposalFlow | null): { text: string; problem: boolean } | null {
  if (!side) return { text: name === 'before' ? 'A new flow: there is no before.' : 'Removed: there is no after.', problem: false };
  if (!side.flow) return { text: `${side.file} doesn't read as a flow.`, problem: true };
  return null;
}

/** The selected block, only when the shown side has it, so switching to a side without it lights and dims nothing. */
export function selectedIn(flow: Flow | null | undefined, selected: string | null): string | null {
  return selected !== null && flow?.blocks.some((b) => b.id === selected) ? selected : null;
}

/** The mark on the history entry the big view adds (#334, point 5): Back takes it away and so closes the view. */
export const MAX_ENTRY = 'ledungMaxDiagram';

export function isMaxEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MAX_ENTRY] === 1;
}

/**
 * How opening the big view marks history: a new entry, or the current one when it already carries the mark (a stale
 * one, left by a reload or reached by Forward), so one Back always closes the view.
 */
export function maxEntryAction(state: unknown): 'push' | 'replace' {
  return isMaxEntry(state) ? 'replace' : 'push';
}

/** The entry's state with the big view's mark, keeping the review's own (desk depth and the like). */
export function withMaxEntry(state: unknown): Record<string, unknown> {
  return { ...(typeof state === 'object' && state !== null ? state : {}), [MAX_ENTRY]: 1 };
}

/**
 * Whether the current entry is a big view's with no big view open: after a reload, after Forward, or when the review
 * was redrawn while it was open. Such an entry is left with Back, or the review's own Close would land one entry short.
 */
export function staleMaxEntry(state: unknown, open: boolean): boolean {
  return !open && isMaxEntry(state);
}

/**
 * Where Tab goes in the big view: the elements it may reach are those outside an inert part (the diagram under a
 * side's note), and from the last one (or the first, with Shift) or from outside them it wraps round. Null leaves it
 * to the browser. Inert elements are left out because the browser skips them: kept in, Tab from the last reachable
 * button would leave the dialog and Shift+Tab would aim at an element that cannot take focus (#334, re-review 2).
 */
export function tabTarget<T extends { closest(selector: string): unknown }>(elements: Iterable<T>, active: unknown, back: boolean): T | null {
  const all = [...elements].filter((el) => !el.closest('[inert]'));
  const i = all.indexOf(active as T);
  if (i !== -1 && (back ? i > 0 : i < all.length - 1)) return null;
  return all[back ? all.length - 1 : 0] ?? null;
}
