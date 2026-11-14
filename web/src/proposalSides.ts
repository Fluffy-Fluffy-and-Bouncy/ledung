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
