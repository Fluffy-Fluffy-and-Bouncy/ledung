// Workflow part 3c (docs/steps/workflow-follow.md): what the workflow page shows of the runs: a marker on the block each
// open run is at, a counted pin's progress ("Changes requested 2 of 3"), the chosen run's path; and the route the page
// reads them from, behind the sign-in like every other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { blockRuns, pinCounts, runPath } from '../web/src/flowRuns.ts';
import { parseFlow } from '../src/shared/flow-check.ts';
import type { FlowRun } from '../src/shared/flow-run.ts';

const main = parseFlow(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'flow-ledung', '.ledung', 'workflow', 'flow.json'), 'utf8')).flow!;

const run = (r: Partial<FlowRun> & { id: string }): FlowRun => ({
  project: 'shop', title: 'Fix the cart', ref: null, flow: 'main', at: 'build', atSince: 0, counts: {}, sessions: {}, parent: null, history: [],
  state: 'running', ending: null, coordinator: 'm', question: null, startedAt: 0, updatedAt: 0, ...r,
});

test('part 3c: a marker on the block each open run is at, by its ref or its title; ended runs and other flows have none', () => {
  const runs = [
    run({ id: 'run-1', ref: '#142', at: 'code-review' }),
    run({ id: 'run-2', title: 'A title much longer than a marker', at: 'code-review', state: 'waiting' }),
    run({ id: 'run-3', at: null, state: 'ended', ending: 'Merge + release' }),
    run({ id: 'run-4', flow: 'asset', at: 'produce' }),
  ];
  const at = blockRuns(runs, 'main');
  assert.deepEqual([...at.keys()], ['code-review']);
  assert.deepEqual(at.get('code-review')!.map((m) => [m.label, m.waiting]), [['#142', false], ['A title much long…', true]]);
  assert.match(at.get('code-review')![1]!.title, /run-2 "A title much longer than a marker", waiting/);
  assert.deepEqual([...blockRuns(runs, 'asset').keys()], ['produce']);
});

test("part 3c: a counted pin shows how far a run has got, the chosen run's or the furthest open one's", () => {
  const a = run({ id: 'run-1', counts: { 'code-review': { 'changes requested': 2 } } });
  const b = run({ id: 'run-2', counts: { 'code-review': { 'changes requested': 1 } } });
  const ended = run({ id: 'run-3', state: 'ended', counts: { 'code-review': { 'changes requested': 10 } } });
  const review = main.blocks.findIndex((x) => x.id === 'code-review');
  const pins = (chosen: FlowRun | null) => pinCounts(main, [a, b, ended], 'main', chosen).get(main.blocks[review]!.id);
  // Only the counted pin ("Changes requested (3rd time)", the third) shows it; the plain ones show nothing.
  assert.deepEqual(pins(null), [null, null, 'Changes requested 2 of 3']);
  assert.deepEqual(pins(b), [null, null, 'Changes requested 1 of 3']);
  // A run chosen in another flow counts nothing here.
  assert.deepEqual(pins(run({ id: 'run-9', flow: 'asset' })), [null, null, null]);
});

test("part 3c: the chosen run's path: the blocks it went through, and where it is now", () => {
  const r = run({ id: 'run-1', at: 'fix', history: [
    { block: 'issue', word: 'Ready', n: 1, to: 'build', by: 'm', at: 1 },
    { block: 'build', word: 'PR opened', n: 1, to: 'code-review', by: 'm', at: 2 },
    { block: 'code-review', word: 'Changes requested', n: 1, to: 'fix', by: 'm', at: 3 },
  ] });
  assert.deepEqual([...runPath(r)], [['issue', 'passed'], ['build', 'passed'], ['code-review', 'passed'], ['fix', 'here']]);
});
