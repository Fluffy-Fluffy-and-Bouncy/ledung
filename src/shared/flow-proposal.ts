// A manager's proposed workflow change (workflow part 3e): what the review page shows, before and after.
import type { Flow, FlowFileWrite, FlowProblem } from './flow.ts';

/** open: waiting for the person; saved on Accepted; declined on Changes needed; failed: accepted but could not be saved. */
export type ProposalState = 'open' | 'saved' | 'declined' | 'failed';

/** One flow as it is, or would be: its name, file, title and blocks (null when it doesn't read as a flow). */
export interface ProposalFlow {
  name: string;
  file: string;
  title: string;
  flow: Flow | null;
}

export interface FlowProposal {
  id: number;
  project: string;
  /** The review it was put to the person as. */
  question: number | null;
  state: ProposalState;
  /** The manager's reason, in its words. */
  why: string;
  /** What Accepted writes, each with the version it replaces (null: a new file). */
  writes: FlowFileWrite[];
  /** The flows that change: before (null: a new flow) and after (null: removed). */
  flows: { name: string; before: ProposalFlow | null; after: ProposalFlow | null }[];
  /** The other files that change (briefs, rules, the manager's file): before and after (null: none). */
  texts: { file: string; before: string | null; after: string | null }[];
  /** The version of every workflow file as read when it was proposed: Accepted saves only if none has changed. */
  read: Record<string, string>;
  /** Every flow's title by its name, as it would be: what a Run flow block runs, in words. */
  titles: Record<string, string>;
  /** What the checks find in the workflow as it would be; hints apart. */
  problems: FlowProblem[];
  createdAt: number;
}
