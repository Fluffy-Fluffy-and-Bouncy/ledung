// What the workflow page shows of the runs (workflow part 3c): the markers on the blocks, a counted pin's progress and
// the chosen run's path; the components are in components/FlowRuns.tsx.
import { endingKey, type Flow } from '../../src/shared/flow.ts';
import { OPEN_STATES, type FlowRun } from '../../src/shared/flow-run.ts';

/** What the diagram shows of the runs, by block id. */
export interface RunMarks {
  at: Map<string, { id: string; label: string; title: string; waiting: boolean }[]>;
  /** Per outcome of a block, its counted pin's progress: "2 of 3" on the pin, the whole ("Failed 2 of 3") in the list. */
  counts: Map<string, ({ short: string; full: string } | null)[]>;
  path: Map<string, 'passed' | 'here'>;
}

/** A run still under way: running, or waiting for a person, a wait or a child run. */
export const openRun = (r: FlowRun) => OPEN_STATES.includes(r.state);
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
    return n ? { short: `${Math.min(n, o.times)} of ${o.times}`, full: `${o.word} ${Math.min(n, o.times)} of ${o.times}` } : null;
  })]));
}

/**
 * The sidebar's Workflow row (Simon, 2026-11-04): "🔀 Workflow · 3 running · 1 for you", and its tooltip. Running counts
 * the runs under way that are not in line, a Run flow block's own runs left out (their parent counts); for you, the
 * runs at a person's step whose question is still open.
 */
export function workflowRow(runs: readonly FlowRun[], openQuestion: (id: number) => boolean): { text: string; title: string } {
  const running = runs.filter((r) => (r.state === 'running' || r.state === 'waiting') && !r.parent).length;
  const queued = runs.filter((r) => r.state === 'queued' && r.queue === 'flow').length;
  const forYou = runs.filter((r) => r.state === 'waiting' && r.question !== null && openQuestion(r.question)).length;
  const text = ['🔀 Workflow', running ? `${running} running` : '', forYou ? `${forYou} for you` : ''].filter(Boolean).join(' · ');
  const said = [running ? `${running} running` : '', queued ? `${queued} queued` : '', forYou ? `${forYou} waiting for you` : ''].filter(Boolean);
  return { text, title: `The workflow page${said.length ? `: ${said.join(', ')}` : ''}` };
}

/** A queued run's place in its line (part 3f): among those queued for the same flow start, or before the same block. */
export function placeInLine(runs: readonly FlowRun[], run: FlowRun): number {
  const line = runs.filter((r) => r.state === 'queued' && r.flow === run.flow && r.queue === run.queue && (run.queue === 'flow' || r.at === run.at))
    .sort((a, b) => a.atSince - b.atSince || Number(a.id.slice(4)) - Number(b.id.slice(4)));
  return Math.max(1, line.findIndex((r) => r.id === run.id) + 1);
}

/** How a flow is followed (part 3f), in a line for the Runs list: "2 at once · a worktree per run". Empty: nothing set. */
export function followLine(flow: Flow | null): string {
  if (!flow) return '';
  const tidy = flow.tidy ?? 'archive';
  const mode = typeof tidy === 'string' ? tidy : tidy.sessions;
  return [
    flow.limit !== undefined ? `${flow.limit} at once` : '',
    flow.worktree ? 'a worktree per run' : '',
    mode === 'keep' ? "sessions kept at the end" : mode === 'stop' ? 'sessions stopped at the end' : '',
    flow.oneRunPerRef === false ? 'several runs per ref' : '',
  ].filter(Boolean).join(' · ');
}

/** The blocks a run has been through, and where it is now. */
export function runPath(run: FlowRun): RunMarks['path'] {
  const path: RunMarks['path'] = new Map(run.history.map((h) => [h.block, 'passed' as const]));
  if (run.at) path.set(run.at, 'here');
  return path;
}

