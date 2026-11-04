// How the workflow is reached (Simon, 2026-11-04): the sidebar's Workflow row says what is going on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowRun } from '../src/shared/flow-run.ts';
import { workflowRow } from '../web/src/flowRuns.ts';

const run = (id: number, over: Partial<FlowRun>): FlowRun => ({
  id: `run-${id}`, project: 'shop', title: `Issue ${id}`, ref: `#${id}`, flow: 'main', at: 'build', atSince: id, counts: {}, sessions: {}, parent: null,
  history: [], state: 'running', ending: null, coordinator: 'manager-1', question: null, worktree: null, queue: null, startedAt: id, updatedAt: id, ...over,
});

test('the Workflow row: running, for you, and nothing more when nothing goes on', () => {
  const open = (id: number) => id === 7;
  assert.deepEqual(workflowRow([], open), { text: '🔀 Workflow', title: 'The workflow page' });
  const ended = [run(1, { state: 'ended', ending: 'Merged', at: null }), run(2, { state: 'stopped', at: null })];
  assert.equal(workflowRow(ended, open).text, '🔀 Workflow');
  const runs = [
    ...ended,
    run(3, {}),
    run(4, { state: 'waiting', question: 7 }),
    // A person's step whose question was answered meanwhile is not for you any more.
    run(5, { state: 'waiting', question: 8 }),
    // A wait block's run waits on no one in particular.
    run(6, { state: 'waiting' }),
    run(9, { state: 'queued', queue: 'flow' }),
    // A Run flow block's own run: its parent counts already.
    run(10, { parent: { run: 'run-3', block: 'asset' } }),
  ];
  assert.deepEqual(workflowRow(runs, open), { text: '🔀 Workflow · 4 running · 1 for you', title: 'The workflow page: 4 running, 1 queued, 1 waiting for you' });
});
