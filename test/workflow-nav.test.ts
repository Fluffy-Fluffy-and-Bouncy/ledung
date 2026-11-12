// How the workflow is reached: the Workflow button on a project's row (issue #289, mockup D; it replaced the Workflow row
// of Simon, 2026-11-04) shows how many runs are under way and how many wait on you.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowRun } from '../src/shared/flow-run.ts';
import { workflowButton } from '../web/src/flowRuns.ts';

const run = (id: number, over: Partial<FlowRun>): FlowRun => ({
  id: `run-${id}`, project: 'shop', title: `Issue ${id}`, ref: `#${id}`, flow: 'main', at: 'build', atSince: id, counts: {}, sessions: {}, parent: null,
  history: [], state: 'running', ending: null, coordinator: 'manager-1', question: null, worktree: null, queue: null, startedAt: id, updatedAt: id, ...over,
});

test('the Workflow button: running, for you, and nothing more when nothing goes on', () => {
  const open = (id: number) => id === 7;
  // No runs: the dimmed symbol alone (running 0, no bubble), and a tooltip that says only where it goes.
  assert.deepEqual(workflowButton([], open), { running: 0, forYou: 0, title: 'The workflow page' });
  const ended = [run(1, { state: 'ended', ending: 'Merged', at: null }), run(2, { state: 'stopped', at: null })];
  assert.deepEqual(workflowButton(ended, open), { running: 0, forYou: 0, title: 'The workflow page' });
  const runs = [
    ...ended,
    run(3, {}),
    run(4, { state: 'waiting', question: 7 }),
    // A person's step whose question was answered meanwhile is not for you any more.
    run(5, { state: 'waiting', question: 8 }),
    // A wait block's run waits on no one in particular.
    run(6, { state: 'waiting' }),
    // Queued: in the tooltip only, never in the count (issue #289, out of scope).
    run(9, { state: 'queued', queue: 'flow' }),
    // A Run flow block's own run: its parent counts already.
    run(10, { parent: { run: 'run-3', block: 'asset' } }),
  ];
  // Running: 3, 4, 5, 6 (not 9 queued, not 10 a child); for you: 4 only (7 is the one open question).
  assert.deepEqual(workflowButton(runs, open), { running: 4, forYou: 1, title: 'The workflow page: 4 running, 1 queued, 1 waiting for you' });
  // Runs under way and none for you: no bubble.
  assert.deepEqual(workflowButton([run(3, {}), run(5, { state: 'waiting', question: 8 })], open), { running: 2, forYou: 0, title: 'The workflow page: 2 running' });
});
