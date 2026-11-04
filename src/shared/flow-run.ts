// A piece of work going through a flow (workflow part 3, docs/steps/workflow-follow.md, approved by Simon 2026-11-03):
// a run. Ledung keeps what an LLM forgets: where each piece of work is, how many times each outcome's word has
// happened at each block, and which session ran each block. The manager (or the person) still says which outcome a
// step had, by its word; Ledung never picks the arrow from text (2026-10-26, #1184).
import { endingKey, outcomeName, ordinal, type Flow, type FlowBlock, type FlowOutcome } from './flow.ts';

/**
 * running: at a block someone works on; waiting: for a person, a wait block or a child run; queued: in line for its
 * flow's or its block's limit (part 3f), at the block it waits before; ended; stopped by hand.
 */
export const RUN_STATES = ['running', 'waiting', 'queued', 'ended', 'stopped'] as const;
/** A run still under way: running, waiting or queued. */
export const OPEN_STATES: readonly RunState[] = ['running', 'waiting', 'queued'];
export type RunState = (typeof RUN_STATES)[number];

/** One step of a run's history: the block it was at, the outcome's word, who reported it, when, and where it went. */
export interface RunStep {
  block: string;
  word: string;
  /** The count the word reached at that block for this run (its Nth time). */
  n: number;
  /** The block it went to; null when the run ended (or was stopped) there. */
  to: string | null;
  /** Who reported it, as a person reads it: 'manager "Manager: shop"', "Simon", "the flow Asset". */
  by: string;
  at: number;
  /** What was handed on, shortened; none: nothing given. */
  note?: string;
}

export interface FlowRun {
  /** Ledung's own, e.g. "run-12". */
  id: string;
  project: string;
  title: string;
  /** An issue or PR reference ("#142", "PR #143"); null: none. */
  ref: string | null;
  /** The flow's name: "main" for flow.json, else its file's name in flows/. */
  flow: string;
  /** The block it is at; null once it has ended or was stopped before its first block. */
  at: string | null;
  /** Since when it is at that block (for a wait: how long). */
  atSince: number;
  /** Per block, per outcome word (endingKey), how many times it has happened. */
  counts: Record<string, Record<string, number>>;
  /** Per block, the session that ran it, so a later `continue` knows where to go. */
  sessions: Record<string, string>;
  /** For a run a Run flow block started: the run and block that wait for it. */
  parent: { run: string; block: string } | null;
  history: RunStep[];
  state: RunState;
  /** How it ended: the ending's word, or why it was stopped. */
  ending: string | null;
  /** The session that coordinates it: whoever started it, usually the manager (Simon, 2026-11-03). */
  coordinator: string;
  /** The open question or review a person block put to the person; null: none. */
  question: number | null;
  /** Its git worktree (part 3f), as its sessions see the folder; a child run shares its parent's. Null: none. */
  worktree: RunWorktree | null;
  /** For a queued run (part 3f): in line for its flow's limit (not started yet) or its block's. Null: not queued. */
  queue: 'flow' | 'block' | null;
  startedAt: number;
  updatedAt: number;
}

/** A run's worktree (part 3f): its folder, branch and the branch it came from; `own`: made for this run (not inherited). */
export interface RunWorktree {
  path: string;
  branch: string;
  base: string;
  own: boolean;
  /** Ignored files there once it was set up (review of 3f): any other ignored file keeps it at the end. */
  ignored?: string[];
}

/** What a step does: where the outcome leads, or how the flow ends. */
export type StepDecision =
  | { kind: 'move'; outcome: FlowOutcome; n: number; to: string }
  | { kind: 'end'; word: string; n: number; outcome: FlowOutcome | null };

/** A block's outcomes as a manager reads them: `"Approved" → Functional review, "Failed" (3rd time) → Person`. */
export function outcomeList(flow: Flow, block: FlowBlock, counts: Record<string, number> = {}): string {
  const titleOf = (id: string) => flow.blocks.find((b) => b.id === id)?.title ?? id;
  const outs = block.outcomes ?? [];
  if (!outs.length) return `none: the flow ends here with "${block.title}"`;
  return outs.map((o) => {
    const where = o.end ? 'ends the flow' : o.to === undefined ? 'leads nowhere yet' : `→ ${titleOf(o.to)}`;
    const so = counts[endingKey(o.word)];
    return `"${outcomeName(o)}" ${where}${so && !o.times ? ` (${so} so far)` : ''}`;
  }).join('; ');
}

/**
 * How a block ended, by the outcome's word (the manager's reading, matched with letter case and spaces at the ends
 * aside, as a Run flow block's ending is): the word's count goes up, and the counted outcome is taken on its Nth time,
 * the plain one on the others (#1184). A block with no outcomes ends the flow with its title (#447), whatever word is
 * given. Throws with the reason, in words for the manager, when the word is none of the block's.
 */
export function decideStep(flow: Flow, blockId: string, word: string, counts: Record<string, number> = {}): StepDecision {
  const block = flow.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error(`The flow has no block "${blockId}" any more; stop the run, or start it again.`);
  const key = endingKey(word);
  if (!key) throw new Error('Give the outcome\'s word.');
  const n = (counts[key] ?? 0) + 1;
  if (!block.outcomes?.length) return { kind: 'end', word: block.title, n, outcome: null };
  const same = block.outcomes.filter((o) => endingKey(o.word) === key);
  if (!same.length) throw new Error(`"${word.trim()}" is not an outcome of "${block.title}"; its outcomes: ${outcomeList(flow, block, counts)}.`);
  const chosen = same.find((o) => o.times === n) ?? same.find((o) => !o.times);
  if (!chosen) {
    throw new Error(`"${block.title}" says where "${same[0]!.word}" goes only on its ${same.map((o) => ordinal(o.times!)).join(', ')} time, and this is its ${ordinal(n)}: ` +
      'the flow says nothing for this time. Change the flow, or stop the run.');
  }
  if (chosen.end) return { kind: 'end', word: chosen.word, n, outcome: chosen };
  if (chosen.to === undefined) throw new Error(`"${outcomeName(chosen)}" of "${block.title}" leads nowhere yet: the flow must be finished before the run can take it.`);
  if (!flow.blocks.some((b) => b.id === chosen.to)) throw new Error(`"${outcomeName(chosen)}" of "${block.title}" leads to "${chosen.to}", which is not a block of the flow.`);
  return { kind: 'move', outcome: chosen, n, to: chosen.to };
}

/** Where work enters a flow: its `start`, else its first block. */
export function startBlock(flow: Flow): FlowBlock {
  return (flow.start ? flow.blocks.find((b) => b.id === flow.start) : undefined) ?? flow.blocks[0]!;
}

/** A counted outcome's progress for one run, for its pin: "Failed 2 of 3"; null when the word hasn't happened. */
export function countBadge(run: Pick<FlowRun, 'counts'>, blockId: string, o: { word: string; times?: number }): string | null {
  if (!o.times) return null;
  const n = run.counts[blockId]?.[endingKey(o.word)] ?? 0;
  return n ? `${o.word} ${Math.min(n, o.times)} of ${o.times}` : null;
}

/** The run as one line, for tools and notes: `run-3 "Fix the cart" (#142)`. */
export const runLabel = (r: Pick<FlowRun, 'id' | 'title' | 'ref'>): string => `${r.id} "${r.title}"${r.ref ? ` (${r.ref})` : ''}`;
