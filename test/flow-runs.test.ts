// Workflow part 3a (docs/steps/workflow-follow.md): runs. The step logic (the counted outcome on its Nth time, the
// plain one otherwise, an ending), the run engine on Ledung's example flow with a real database, who may move a run,
// the tools only where a flow is followed, the manager's line, and a project rename taking its runs along.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseProject } from '../src/config.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { flowInstructions, flowPlaces, FOLLOW_LINE, readFlows } from '../src/sessions/flow-files.ts';
import { decideStep, countBadge } from '../src/shared/flow-run.ts';
import { FlowRuns, type FlowRunsPorts } from '../src/sessions/flow-runs.ts';
import { RunStore, runNumber } from '../src/sessions/run-store.ts';
import { ledungToolServer, type RunHandlers, type ToolHandlers } from '../src/sessions/tools.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'flow-ledung');
const project = parseProject({ name: 'shop', runner: 'local', path: FIXTURE });

async function example() {
  const read = await readFlows(flowPlaces(project, undefined));
  assert.ok(read);
  return read;
}

test('part 3a: a step takes the counted outcome on its Nth time and the plain one otherwise', async () => {
  const main = (await example()).flows.get('main')!;
  const counts: Record<string, number> = {};
  const go = (word: string) => {
    const d = decideStep(main, 'code-review', word, counts);
    counts[word.trim().toLowerCase()] = d.n;
    return d.kind === 'move' ? d.to : `end ${d.word}`;
  };
  // Letter case and spaces at the ends aside, as the manager writes the word.
  assert.equal(go('Changes requested'), 'fix');
  assert.equal(go(' changes REQUESTED '), 'fix');
  assert.equal(go('Changes requested'), 'decide');
  // After the counted one, the plain one again (the counted outcome is taken once each time the count is reached).
  assert.equal(go('Changes requested'), 'fix');
  assert.equal(go('Approved'), 'functional-review');
  assert.throws(() => decideStep(main, 'code-review', 'Looks good', {}), /"Looks good" is not an outcome of "Code review"; its outcomes: "Approved" → Functional review/);
  // A block with no outcomes ends the flow with its title (#447); an outcome with "end" with its word.
  assert.deepEqual(decideStep(main, 'merge', 'done', {}), { kind: 'end', word: 'Merge + release', n: 1, outcome: null });
  const asset = decideStep(main, 'asset', 'rejected', {});
  assert.equal(asset.kind, 'end');
  assert.equal(asset.kind === 'end' && asset.word, 'Rejected');
  assert.equal(countBadge({ counts: { 'code-review': { 'changes requested': 2 } } }, 'code-review', { word: 'Changes requested', times: 3 }), 'Changes requested 2 of 3');
  assert.equal(countBadge({ counts: {} }, 'code-review', { word: 'Changes requested', times: 3 }), null);
});

test('part 3a: a counted word with no plain one says the flow has nothing for that time', async () => {
  const flow = { version: 1 as const, blocks: [{ id: 'a', kind: 'work' as const, title: 'A', outcomes: [{ word: 'Failed', times: 2, to: 'b' }] }, { id: 'b', kind: 'work' as const, title: 'B' }], overlays: [], frames: [] };
  assert.throws(() => decideStep(flow, 'a', 'Failed', {}), /only on its 2nd time, and this is its 1st/);
  assert.equal(decideStep(flow, 'a', 'Failed', { failed: 1 }).kind, 'move');
});

/** A run engine on the example flow with a real database, a manager and one of its sessions. */
async function engine(opts: { following?: boolean } = {}) {
  const store = new Store(openDatabase(':memory:'));
  const flows = await example();
  const told: { id: string; text: string }[] = [];
  const changed: string[] = [];
  const mk = (id: string, role: 'manager' | 'session', title: string) => store.createSession({ id, project: 'shop', runner: 'local', title, parentId: null, permissionMode: 'default', role });
  mk('manager-1', 'manager', 'Manager: shop');
  mk('session-1', 'session', 'Helper');
  mk('session-2', 'session', 'Other');
  let clock = 1_000_000;
  const ports: FlowRunsPorts = {
    runs: new RunStore(store.database),
    getSession: (id) => store.getSession(id),
    managerOf: () => 'manager-1',
    flows: async () => flows,
    following: () => opts.following ?? true,
    tell: (id, text) => told.push({ id, text }),
    changed: (p) => changed.push(p),
    userName: 'Simon',
    now: () => (clock += 1000),
  };
  return { runs: new FlowRuns(ports), ports, store, told, changed };
}

test('part 3a: a run started by the manager moves through the example flow, the 3rd "Changes requested" taking the counted outcome', async () => {
  const { runs, ports, changed } = await engine();
  const started = await runs.start('manager-1', { title: 'Fix the cart total', ref: '#142' });
  assert.match(started, /^Started run-1 "Fix the cart total" \(#142\) in the flow "Ledung's own process"\. At "Issue" \(issue\): your own step\. Its brief: briefs\/issue\.md/);
  assert.match(started, /"Ready" → Build; "Needs an asset" → Make the asset/);
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Ready' }), /goes to "Build"\. At "Build" \(build\): start a new session for it with model opus\. .*Self-review \(done, sonnet, briefs\/reviewer\.md\)/);
  await runs.step('manager-1', { run: 'run-1', outcome: 'PR opened', note: 'PR #143' });
  for (const round of [1, 2]) {
    assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested' }), /goes to "Fix"/, `round ${round}`);
    assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed', block: 'fix' }), /goes to "Code review"/);
  }
  const third = await runs.step('manager-1', { run: 'run-1', outcome: 'changes requested' });
  assert.match(third, /Recorded "Changes requested" for "Code review" \(its 3rd time\): run-1 "Fix the cart total" \(#142\) goes to "Person decides"\. At "Person decides" \(decide\), a person's step: ask Simon \(a question/);
  const run = ports.runs.get('run-1')!;
  assert.deepEqual(run.counts['code-review'], { 'changes requested': 3 });
  assert.deepEqual(run.counts.fix, { fixed: 2 });
  assert.equal(run.at, 'decide');
  assert.equal(run.history.length, 7);
  assert.deepEqual({ ...run.history[1], at: 0 }, { block: 'build', word: 'PR opened', n: 1, to: 'code-review', by: 'manager "Manager: shop"', at: 0, note: 'PR #143' });
  assert.ok(changed.length === 8 && changed.every((p) => p === 'shop'));
  // On to the end: the block with no outcomes ends the run with its title.
  await runs.step('manager-1', { run: 'run-1', outcome: 'Go on' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Accepted' });
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Merged' }), /has ended: "Merge \+ release"/);
  const ended = ports.runs.get('run-1')!;
  assert.equal(ended.state, 'ended');
  assert.equal(ended.ending, 'Merge + release');
  assert.equal(ended.at, null);
  await assert.rejects(runs.step('manager-1', { run: 'run-1', outcome: 'Accepted' }), /has ended \(Merge \+ release\)/);
});

test('part 3a: nothing is recorded for a word the block lacks, or a report on a block the run has left', async () => {
  const { runs, ports } = await engine();
  await runs.start('manager-1', { title: 'One' });
  await assert.rejects(runs.step('manager-1', { run: 'run-1', outcome: 'Shipped' }), /"Shipped" is not an outcome of "Issue".*Nothing was recorded\./);
  await assert.rejects(runs.step('manager-1', { run: 'run-1', outcome: 'Ready', block: 'build' }), /is at "Issue" \(issue\), not "build": nothing was recorded/);
  assert.equal(ports.runs.get('run-1')!.history.length, 0);
  // By its title too.
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Ready', block: 'Issue' }), /goes to "Build"/);
});

test('part 3a: any session may start a run and coordinates it; the manager may move it too, another session may not', async () => {
  const { runs, ports } = await engine();
  assert.match(await runs.start('session-1', { title: 'Asset only', flow: 'Asset' }), /in the flow "Asset"/);
  const run = ports.runs.get('run-1')!;
  assert.equal(run.coordinator, 'session-1');
  assert.equal(run.flow, 'asset');
  await assert.rejects(runs.step('session-2', { run: 'run-1', outcome: 'Done' }), /coordinated by session "Helper", not by you/);
  await runs.step('manager-1', { run: 'run-1', outcome: 'Done' });
  await assert.rejects(runs.start('manager-1', { title: 'x', flow: 'nope' }), /There is no flow "nope"; the project's flows: main \("Ledung's own process"\), asset \("Asset"\)/);
  assert.match(await runs.step('session-1', { run: 'run-1', outcome: 'dropped by Simon', stop: true }), /is stopped at "review": dropped by Simon/);
  assert.equal(ports.runs.get('run-1')!.state, 'stopped');
  const status = await runs.status('manager-1');
  assert.match(status, /- run-1 "Asset only", flow "Asset": stopped \(dropped by Simon\)/);
  assert.match(await runs.status('manager-1', 'run-1'), /Counts: Produce: "done" ×1\.\nHistory:\n- .* Produce: "Done" by manager "Manager: shop" → Review the asset\n- .* Review the asset: "stopped" by session "Helper" → end/);
});

test('part 3a: following switched off, the tools say so and no run starts', async () => {
  const { runs, ports } = await engine({ following: false });
  await assert.rejects(runs.start('manager-1', { title: 'x' }), /Following the workflow is switched off for shop/);
  assert.equal(ports.runs.list('shop').length, 0);
});

test('part 3a: run ids are Ledung\'s own numbers', () => {
  assert.equal(runNumber('run-12'), 12);
  assert.equal(runNumber('12'), 12);
  assert.equal(runNumber('RUN-3 '), 3);
  assert.equal(runNumber('build'), null);
});

const toolNames = (h: ToolHandlers) => Object.keys((ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

test('part 3a: the run tools exist only for a session given them, with short descriptions', () => {
  const base: ToolHandlers = { userName: 'Simon', role: 'session', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '' };
  assert.deepEqual(toolNames(base).filter((t) => t.startsWith('flow_')), []);
  const runs: RunHandlers = { start: async () => 'started', step: async () => 'stepped', status: async () => 'status' };
  assert.deepEqual(toolNames({ ...base, runs }).filter((t) => t.startsWith('flow_')), ['flow_start', 'flow_step', 'flow_status']);
  const tools = (ledungToolServer({ ...base, runs }).instance as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
  for (const t of ['flow_start', 'flow_step', 'flow_status']) assert.ok(tools[t]!.description!.length < 260, `${t} is short`);
});

test("part 3a: the manager's line names the run tools only when Ledung follows the flow", async () => {
  const places = flowPlaces(project, undefined);
  const plain = (await flowInstructions(places))!;
  const following = (await flowInstructions(places, true))!;
  assert.ok(!plain.includes('flow_start'));
  assert.equal(following, `${plain} ${FOLLOW_LINE}`);
  assert.ok(FOLLOW_LINE.length < 240);
});

test('part 3a: a project renamed takes its runs along', () => {
  const store = new Store(openDatabase(':memory:'));
  const projects = new ProjectStore(store.database);
  projects.add(project);
  const runs = new RunStore(store.database);
  runs.create({ project: 'shop', title: 'x', ref: null, flow: 'main', at: 'issue', coordinator: 'm', parent: null, now: 1 });
  projects.rename('shop', 'store');
  assert.equal(runs.list('shop').length, 0);
  assert.equal(runs.list('store').length, 1);
});

test('part 3a: a session remembers the run and block it serves', () => {
  const store = new Store(openDatabase(':memory:'));
  const s = store.createSession({ id: 's1', project: 'shop', runner: 'local', title: 'Build', parentId: null, permissionMode: 'default' });
  assert.equal(s.runBlock, null);
  store.updateSession('s1', { runBlock: { run: 'run-1', block: 'build' } });
  assert.deepEqual((store.getSession('s1') as SessionInfo).runBlock, { run: 'run-1', block: 'build' });
});
