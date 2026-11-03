// What the workflow page shows of the runs (workflow part 3c): the markers on the blocks, a counted pin's progress and
// the chosen run's path; the components are in components/FlowRuns.tsx.
import { endingKey, type Flow } from '../../src/shared/flow.ts';
import type { FlowRun } from '../../src/shared/flow-run.ts';

/** What the diagram shows of the runs, by block id. */
export interface RunMarks {
  at: Map<string, { id: string; label: string; title: string; waiting: boolean }[]>;
  counts: Map<string, (string | null)[]>;
  path: Map<string, 'passed' | 'here'>;
}

/** A run still under way: running, or waiting for a person, a wait or a child run. */
export const openRun = (r: FlowRun) => r.state === 'running' || r.state === 'waiting';
const open = openRun;

/** The open runs at each block of a flow, as markers: the ref when it has one (short), else the title. */
export function blockRuns(runs: readonly FlowRun[], flow: string): RunMarks['at'] {
  const at: RunMarks['at'] = new Map();
  for (const r of runs) {
    if (r.flow !== flow || !open(r) || !r.at) continue;
    const list = at.get(r.at) ?? [];
    list.push({ id: r.id, label: r.ref ?? (r.title.length > 18 ? `${r.title.slice(0, 17)}…` : r.title), title: `${r.id} "${r.title}"${r.ref ? ` (${r.ref})` : ''}${r.state === 'waiting' ? ', waiting' : ''}`, waiting: r.state === 'waiting' });
    at.set(r.at, list);
  }
  return at;
}

/**
 * Each counted pin's progress: the chosen run's, else the furthest any open run in this flow has got, as "Failed 2 of 3";
 * null for a plain pin or a word no run has counted.
 */
export function pinCounts(flow: Flow | null, runs: readonly FlowRun[], flowName: string, chosen: FlowRun | null): RunMarks['counts'] {
  const counting = chosen ? (chosen.flow === flowName ? [chosen] : []) : runs.filter((r) => r.flow === flowName && open(r));
  return new Map((flow?.blocks ?? []).map((b) => [b.id, (b.outcomes ?? []).map((o) => {
    if (!o.times) return null;
    const n = Math.max(0, ...counting.map((r) => r.counts[b.id]?.[endingKey(o.word)] ?? 0));
    return n ? `${o.word} ${Math.min(n, o.times)} of ${o.times}` : null;
  })]));
}

/** The blocks a run has been through, and where it is now. */
export function runPath(run: FlowRun): RunMarks['path'] {
  const path: RunMarks['path'] = new Map(run.history.map((h) => [h.block, 'passed' as const]));
  if (run.at) path.set(run.at, 'here');
  return path;
}

