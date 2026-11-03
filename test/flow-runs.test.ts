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
import { checkFlow, checkFlowCalls, parseFlow } from '../src/shared/flow-check.ts';
import { answerWord, FlowRuns, lastReplyOf, type BlockSessionStart, type FlowRunsPorts } from '../src/sessions/flow-runs.ts';
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
async function engine(opts: { following?: boolean; flows?: Awaited<ReturnType<typeof example>> } = {}) {
  const store = new Store(openDatabase(':memory:'));
  const flows = opts.flows ?? await example();
  const told: { id: string; text: string }[] = [];
  const changed: string[] = [];
  const mk = (id: string, role: 'manager' | 'session', title: string) => store.createSession({ id, project: 'shop', runner: 'local', title, parentId: null, permissionMode: 'default', role });
  mk('manager-1', 'manager', 'Manager: shop');
  mk('session-1', 'session', 'Helper');
  mk('session-2', 'session', 'Other');
  let clock = 1_000_000;
  const started: BlockSessionStart[] = [];
  const continued: { id: string; text: string }[] = [];
  const replies = new Map<string, string>();
  const withdrawn: number[] = [];
  const stopped: string[] = [];
  let made = 0;
  const ports: FlowRunsPorts = {
    runs: new RunStore(store.database),
    getSession: (id) => store.getSession(id),
    managerOf: () => 'manager-1',
    flows: async () => flows,
    following: () => opts.following ?? true,
    tell: (id, text) => told.push({ id, text }),
    changed: (p) => changed.push(p),
    startSession: async (b) => {
      started.push(b);
      const s = store.createSession({ id: `block-${++made}`, project: b.project, runner: 'local', title: b.title, parentId: b.coordinator, permissionMode: 'default', requestedModel: b.model ?? null, profile: b.profile ?? 'full' });
      store.updateSession(s.id, { runBlock: b.runBlock });
      return store.getSession(s.id)!;
    },
    continueSession: async (id, text, runBlock) => {
      continued.push({ id, text });
      store.updateSession(id, { runBlock });
    },
    lastReply: (id) => replies.get(id) ?? '',
    ask: (a) => store.createQuestion({ sessionId: a.coordinator, question: a.question, options: a.options, addressedTo: 'user', details: a.details }),
    markDelivered: (id) => store.markDelivered([id]),
    withdraw: (id, reason) => {
      withdrawn.push(id);
      store.withdrawQuestion(id, reason);
    },
    stopSession: async (id, reason) => {
      stopped.push(id);
      store.updateSession(id, { status: 'ended', endReason: reason });
    },
    tiers: () => ['Blocks a finished PR', 'Process'],
    userName: 'Simon',
    now: () => (clock += 1000),
  };
  /** The person answers a question, as the page's answer does. */
  const answer = async (id: number, text: string) => {
    store.answerQuestion(id, text, 'user');
    await runs.onAnswered(store.getQuestion(id)!);
  };
  const runs = new FlowRuns(ports);
  return { runs, ports, store, told, changed, started, continued, replies, withdrawn, stopped, answer };
}

test('part 3a: a run started by the manager moves through the example flow, the 3rd "Changes requested" taking the counted outcome', async () => {
  const { runs, ports, changed } = await engine();
  const started = await runs.start('manager-1', { title: 'Fix the cart total', ref: '#142' });
  assert.match(started, /^Started run-1 "Fix the cart total" \(#142\) in the flow "Ledung's own process"\. At "Issue" \(issue\): your own step\.\n\nThe brief \(briefs\/issue\.md\):/);
  assert.match(started, /"Ready" → Build; "Needs an asset" → Make the asset/);
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Ready' }), /goes to "Build"\. At "Build" \(build\): Ledung started session "Build: Fix the cart total" \(block-1\) with model opus, profile full\. Ledung tells you when it finishes a turn\./);
  await runs.step('manager-1', { run: 'run-1', outcome: 'PR opened', note: 'PR #143' });
  for (const round of [1, 2]) {
    assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested' }), /goes to "Fix"/, `round ${round}`);
    assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed', block: 'fix' }), /goes to "Code review"/);
  }
  const third = await runs.step('manager-1', { run: 'run-1', outcome: 'changes requested' });
  assert.match(third, /Recorded "Changes requested" for "Code review" \(its 3rd time\): run-1 "Fix the cart total" \(#142\) goes to "Person decides"\. At "Person decides" \(decide\), a person's step: Ledung put it to Simon as question #1\./);
  const run = ports.runs.get('run-1')!;
  // Taken its last counted time, the word's count starts again (review of 3a).
  assert.deepEqual(run.counts['code-review'], { 'changes requested': 0 });
  assert.deepEqual(run.counts.fix, { fixed: 2 });
  assert.equal(run.at, 'decide');
  assert.equal(run.history.length, 7);
  assert.deepEqual({ ...run.history[1], at: 0 }, { block: 'build', word: 'PR opened', n: 1, to: 'code-review', by: 'manager "Manager: shop"', at: 0, note: 'PR #143' });
  assert.ok(changed.length >= 8 && changed.every((p) => p === 'shop'));
  // The person sends it back; the next three rounds go as the first three did: the limit holds every time round.
  await runs.step('manager-1', { run: 'run-1', outcome: 'Fix again' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed' });
  for (const round of [4, 5]) {
    assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested' }), /goes to "Fix"/, `round ${round}`);
    await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed' });
  }
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested' }), /\(its 3rd time\): .* goes to "Person decides"/);
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
  assert.match(await runs.step('session-1', { run: 'run-1', outcome: 'dropped by Simon', stop: true }), /is stopped at "Review the asset": dropped by Simon/);
  assert.equal(ports.runs.get('run-1')!.state, 'stopped');
  const status = await runs.status('manager-1');
  assert.match(status, /- run-1 "Asset only", flow "Asset": stopped \(dropped by Simon\)/);
  assert.match(await runs.status('manager-1', 'run-1'), /Counts: Produce: "done" ×1\.\nSessions: Produce: block-1\.\nHistory:\n- .* Produce: "Done" by manager "Manager: shop" → Review the asset\n- .* Review the asset: "stopped" by session "Helper" → end/);
});

test('part 3a: a run needs a title; a removed project stops its open runs', async () => {
  const { runs, ports } = await engine();
  await assert.rejects(runs.start('manager-1', { title: '  ' }), /Give the run a title/);
  await runs.start('manager-1', { title: 'Open one' });
  await runs.start('manager-1', { title: 'Ended one', flow: 'asset' });
  await runs.step('manager-1', { run: 'run-2', outcome: 'x', stop: true });
  runs.stopProject('shop', 'the project "shop" was removed');
  assert.deepEqual(ports.runs.list('shop').map((r) => [r.id, r.state, r.ending]), [['run-1', 'stopped', 'the project "shop" was removed'], ['run-2', 'stopped', 'x']]);
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
  // Only a manager routes work in; another session starts a run when the person asks it.
  const described = (role: 'manager' | 'session') => (ledungToolServer({ ...base, role, runs }).instance as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools.flow_start!.description!;
  assert.match(described('session'), /only when Simon asks you to run the workflow/);
  assert.match(described('manager'), /when you route work in, or Simon asks to run the workflow/);
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

test('part 3b: blocks act: Build gets a new session with its settings, Fix continues it, the person answers move the run', async () => {
  const { runs, ports, store, told, started, continued, replies, withdrawn, answer } = await engine();
  await runs.start('manager-1', { title: 'Fix the cart total', ref: '#142' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Ready', note: 'The total adds VAT twice.' });
  // Build: a new session under the coordinator, with the block's model, its brief, sub-steps, the handoff and the words.
  assert.equal(started.length, 1);
  const build = started[0]!;
  assert.deepEqual({ ...build, task: '' }, { project: 'shop', coordinator: 'manager-1', title: 'Build: Fix the cart total', task: '', model: 'opus', profile: undefined, runBlock: { run: 'run-1', block: 'build', runTitle: 'Fix the cart total', blockTitle: 'Build', flow: 'main' } });
  assert.match(build.task, /^You run "Build" \(block build\) of run-1 "Fix the cart total" \(#142\), in the flow "Ledung's own process"\. .*manager "Manager: shop" coordinates the run\./);
  assert.match(build.task, /The brief \(briefs\/builder\.md\):\n\n/);
  assert.match(build.task, /Start these subagents, in order:\n- Self-review \(check, when done, model sonnet, brief briefs\/reviewer\.md\): "No findings" → done, "Findings" → owner, "Findings" \(3rd time\) → report/);
  assert.match(build.task, /What "Issue" handed on:\n\nThe total adds VAT twice\./);
  assert.match(build.task, /end your report with how it went, one of: "PR opened"\./);
  assert.deepEqual(store.getSession('block-1')!.runBlock, { run: 'run-1', block: 'build', runTitle: 'Fix the cart total', blockTitle: 'Build', flow: 'main' });
  // The session's last reply is the handoff when the coordinator gives no note.
  replies.set('block-1', 'PR #143 is open.');
  await runs.step('manager-1', { run: 'run-1', outcome: 'PR opened' });
  assert.equal(started[1]!.title, 'Code review: Fix the cart total');
  assert.match(started[1]!.task, /What "Build" handed on:\n\nPR #143 is open\./);
  // Fix continues Build's session: the same session gets the step, and the run notes it.
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested', note: 'Round the total.' }), /Ledung gave it to session "Build: Fix the cart total" \(block-1\), which ran "Build"/);
  assert.equal(continued.length, 1);
  assert.equal(continued[0]!.id, 'block-1');
  assert.match(continued[0]!.text, /^You run "Fix" \(block fix\) of run-1/);
  assert.deepEqual(store.getSession('block-1')!.runBlock, { run: 'run-1', block: 'fix', runTitle: 'Fix the cart total', blockTitle: 'Fix', flow: 'main' });
  assert.equal(ports.runs.get('run-1')!.sessions.fix, 'block-1');
  // Back to Code review: a new-session block starts a session each time it is reached.
  await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed' });
  assert.equal(started.length, 3);
  // The 3rd "Changes requested" puts "Person decides" to Simon as a question with its words as the answers.
  await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed' });
  const third = await runs.step('manager-1', { run: 'run-1', outcome: 'Changes requested' });
  assert.match(third, /Ledung put it to Simon as question #1\. The answer moves the run by itself \("Go on" → Functional review; "Fix again" → Fix\); you are told then/);
  const q = store.getQuestion(1)!;
  assert.equal(q.addressedTo, 'user');
  assert.equal(q.sessionId, 'manager-1');
  assert.deepEqual(q.options, ['Go on', 'Fix again']);
  assert.deepEqual(q.details!.run, { run: 'run-1', block: 'decide', runTitle: 'Fix the cart total', blockTitle: 'Person decides', flow: 'main' });
  assert.deepEqual(q.details!.refs, ['#142']);
  assert.equal(q.details!.tier, 'Blocks a finished PR');
  assert.equal(ports.runs.get('run-1')!.state, 'waiting');
  // Simon answers: the run moves by itself, the coordinator is told, and the answer isn't delivered again as a plain one.
  await answer(1, 'Go on');
  let run = ports.runs.get('run-1')!;
  assert.equal(run.at, 'functional-review');
  assert.equal(run.history.at(-1)!.by, 'Simon');
  assert.ok(store.getQuestion(1)!.deliveredAt);
  assert.match(told.at(-1)!.text, /^Ledung: Simon answered "Person decides" of run-1 "Fix the cart total" \(#142\) \(question #1\): Go on\n\nRecorded "Go on" .* goes to "Functional review"\. At "Functional review" \(functional-review\), a person's step: Ledung put it to Simon as review #2/);
  // The functional review is a review page; "Changes needed:" takes the "Changes needed" outcome, the note handed on.
  const review = store.getQuestion(2)!;
  assert.equal(review.details!.review!.solving, `Fix the cart total (#142), in the flow "Ledung's own process".`);
  assert.match(review.details!.review!.notes!, /^Your answer moves run-1 by itself: "Accepted" → Merge \+ release; "Changes needed" → Fix\./);
  await answer(2, 'Changes needed: the total is still off by a cent.');
  run = ports.runs.get('run-1')!;
  assert.equal(run.at, 'fix');
  assert.equal(run.history.at(-1)!.note, 'the total is still off by a cent.');
  assert.match(continued.at(-1)!.text, /What "Functional review" handed on:\n\nthe total is still off by a cent\./);
  // The manager reports a person block itself (the person's word in chat): the open question is withdrawn.
  await runs.step('manager-1', { run: 'run-1', outcome: 'Fixed' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Approved' });
  const open = ports.runs.get('run-1')!.question!;
  await runs.step('manager-1', { run: 'run-1', outcome: 'Accepted' });
  assert.deepEqual(withdrawn, [open]);
  assert.equal(store.getQuestion(open)!.status, 'withdrawn');
  assert.equal(ports.runs.get('run-1')!.at, 'merge');
});

test(`part 3b: a Run flow block runs its flow as a child run; the way that ends is the block's outcome`, async () => {
  const { runs, ports, store, started, answer, told } = await engine();
  await runs.start('manager-1', { title: 'New logo' });
  const at = await runs.step('manager-1', { run: 'run-1', outcome: 'Needs an asset' });
  assert.match(at, /At "Make the asset" \(asset\): Ledung started run-2 in the flow "Asset" for it, and run-1 waits; the way run-2 ends is "Make the asset"'s outcome\.\n\nrun-2: At "Produce" \(produce\): Ledung started session "Produce: New logo"/);
  assert.equal(started[0]!.model, 'sonnet');
  const child = ports.runs.get('run-2')!;
  assert.deepEqual(child.parent, { run: 'run-1', block: 'asset' });
  assert.equal(child.coordinator, 'manager-1');
  assert.equal(ports.runs.get('run-1')!.state, 'waiting');
  await runs.step('manager-1', { run: 'run-2', outcome: 'Done', note: 'logo.svg' });
  // The asset review has no "Accepted": Accepted takes its first outcome, Ready, which ends the child; the parent goes on.
  const q = ports.runs.get('run-2')!.question!;
  await answer(q, 'Accepted.');
  assert.equal(ports.runs.get('run-2')!.state, 'ended');
  assert.equal(ports.runs.get('run-2')!.ending, 'Ready');
  const parent = ports.runs.get('run-1')!;
  assert.equal(parent.at, 'build');
  assert.equal(parent.state, 'running');
  assert.equal(parent.history.at(-1)!.by, 'the flow "Asset" (run-2)');
  assert.equal(parent.history.at(-1)!.word, 'Ready');
  assert.match(told.at(-1)!.text, /run-2 "New logo" has ended: "Ready"\. It was run by "Make the asset" of run-1 "New logo": Recorded "Ready" for "Make the asset": run-1 "New logo" goes to "Build"\. At "Build" \(build\): Ledung started session/);
  assert.equal(store.getSession('block-2')!.title, 'Build: New logo');
});

test('part 3b: an answer that is none of the words is left for the coordinator; a session coordinator hears of block turns', async () => {
  const { runs, ports, answer, told } = await engine();
  await runs.start('session-1', { title: 'Decide', flow: 'asset' });
  await runs.step('session-1', { run: 'run-1', outcome: 'Done' });
  const q = ports.runs.get('run-1')!.question!;
  await answer(q, 'Let me think about the colours first');
  assert.equal(ports.runs.get('run-1')!.at, 'review');
  assert.equal(ports.runs.get('run-1')!.question, null);
  assert.match(told.at(-1)!.text, /with an answer that is none of its outcomes: read it and report the outcome with flow_step/);
  assert.equal(told.at(-1)!.id, 'session-1');
  // The produce session's turn: its coordinator is a session, not its manager, so Ledung tells it.
  await runs.step('session-1', { run: 'run-1', outcome: 'Changes needed' });
  const s = ports.runs.get('run-1')!.sessions.produce!;
  runs.onSessionTurn(s, 'Done: logo-2.svg');
  assert.equal(told.at(-1)!.id, 'session-1');
  assert.match(told.at(-1)!.text, /^Ledung: session "Produce: Decide" \(block-\d\), which runs "produce" of run-1 "Decide", finished a turn\. Its last reply began:\n\nDone: logo-2\.svg/);
});

test(`part 3b: the words a person's answer gives`, () => {
  const review = { id: 'r', kind: 'person' as const, title: 'R', ask: 'review' as const, outcomes: [{ word: 'Accepted', to: 'm' }, { word: 'Changes needed', to: 'f' }] };
  assert.equal(answerWord(review, 'Accepted.'), 'Accepted');
  assert.equal(answerWord(review, 'Accepted.\n\nNice.'), 'Accepted');
  assert.equal(answerWord(review, 'Changes needed: the colour'), 'Changes needed');
  const other = { ...review, outcomes: [{ word: 'Ready', end: true as const }, { word: 'Rejected', end: true as const }] };
  assert.equal(answerWord(other, 'Accepted.'), 'Ready');
  assert.equal(answerWord(other, 'Changes needed: x'), 'Rejected');
  const question = { id: 'q', kind: 'person' as const, title: 'Q', ask: 'question' as const, outcomes: [{ word: 'Go on', to: 'a' }, { word: 'Go on later', to: 'b' }, { word: 'Fix again', to: 'c' }] };
  assert.equal(answerWord(question, 'go on.'), 'Go on');
  // Only the word itself: more than that is the coordinator's to read (review of 3b).
  assert.equal(answerWord(question, 'Go on later, after lunch'), null);
  assert.equal(answerWord(question, 'go on later!'), 'Go on later');
  assert.equal(answerWord(question, 'Gone'), null);
  assert.equal(answerWord(question, 'Accepted.'), null);
});

test(`part 3b: a session's last reply is its last text of its own, not a subagent's`, () => {
  const m = (id: number, data: unknown) => ({ id, sessionId: 's', at: id, kind: 'sdk' as const, data });
  const reply = lastReplyOf([
    m(1, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'First.' }] } }),
    m(2, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'PR #143 is open.' }, { type: 'tool_use', name: 'x' }] } }),
    m(3, { type: 'assistant', parent_tool_use_id: 'tool-1', message: { content: [{ type: 'text', text: 'A subagent.' }] } }),
  ] as never);
  assert.equal(reply, 'PR #143 is open.');
});

test('part 3b review: the answer is delivered at once, only in the run note; a withdrawn person question goes back to the coordinator', async () => {
  const { runs, ports, store, answer, told } = await engine();
  await runs.start('manager-1', { title: 'Logo', flow: 'asset' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Done' });
  const q = ports.runs.get('run-1')!.question!;
  store.answerQuestion(q, 'Accepted.', 'user');
  const moving = runs.onAnswered(store.getQuestion(q)!);
  // Before the run has moved, the plain answer is already out of the coordinator's way.
  assert.deepEqual(store.undeliveredAnswers('manager-1'), []);
  await moving;
  assert.equal(ports.runs.get('run-1')!.state, 'ended');
  // An answer none of the words is still said in full in the note, as it no longer arrives on its own.
  await runs.start('manager-1', { title: 'Logo 2', flow: 'asset' });
  await runs.step('manager-1', { run: 'run-2', outcome: 'Done' });
  await answer(ports.runs.get('run-2')!.question!, 'Make it bluer first');
  assert.match(told.at(-1)!.text, /The answer:\n\nMake it bluer first$/);
  // Withdrawn on the page: the run is running again and its coordinator told.
  await runs.step('manager-1', { run: 'run-2', outcome: 'Changes needed' });
  await runs.step('manager-1', { run: 'run-2', outcome: 'Done' });
  const again = store.getQuestion(ports.runs.get('run-2')!.question!)!;
  store.withdrawQuestion(again.id, 'Withdrawn by Simon.');
  runs.onWithdrawn(store.getQuestion(again.id)!);
  assert.equal(ports.runs.get('run-2')!.state, 'running');
  assert.equal(ports.runs.get('run-2')!.question, null);
  assert.match(told.at(-1)!.text, /Simon withdrew question #\d+, "review" of run-2 "Logo 2": report that block's outcome yourself with flow_step/);
});

test('part 3b review: a session that could not start is said; a block reached again stops its earlier session', async () => {
  const { runs, ports, stopped } = await engine();
  const failing = ports.startSession;
  ports.startSession = async () => { throw new Error('the session could not start: no Claude Code.'); };
  await runs.start('manager-1', { title: 'One' });
  assert.match(await runs.step('manager-1', { run: 'run-1', outcome: 'Ready' }), /At "Build" \(build\), but Ledung could not do it: the session could not start: no Claude Code\. Do the step yourself, or stop the run\./);
  ports.startSession = failing;
  await runs.start('manager-1', { title: 'Two' });
  await runs.step('manager-1', { run: 'run-2', outcome: 'Ready' });
  await runs.step('manager-1', { run: 'run-2', outcome: 'PR opened' });
  const firstReview = ports.runs.get('run-2')!.sessions['code-review']!;
  await runs.step('manager-1', { run: 'run-2', outcome: 'Changes requested' });
  await runs.step('manager-1', { run: 'run-2', outcome: 'Fixed' });
  // A new reviewer for the second round; the first one is stopped, and Build's session (continued by Fix) is not.
  assert.deepEqual(stopped, [firstReview]);
  assert.notEqual(ports.runs.get('run-2')!.sessions['code-review'], firstReview);
});

test('part 3b review: stopping a run stops its child runs; a child stopped leaves its parent said to be waiting', async () => {
  const { runs, ports } = await engine();
  await runs.start('manager-1', { title: 'Logo' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Needs an asset' });
  assert.match(await runs.step('manager-1', { run: 'run-2', outcome: 'gave up', stop: true }), /run-1 "Logo" still waits at "asset" for it: report that block's outcome with flow_step, or stop it\./);
  await runs.step('manager-1', { run: 'run-1', outcome: 'Needs an asset', stop: true });
  await runs.start('manager-1', { title: 'Logo 2' });
  await runs.step('manager-1', { run: 'run-3', outcome: 'Needs an asset' });
  await runs.step('manager-1', { run: 'run-3', outcome: 'dropped', stop: true });
  assert.equal(ports.runs.get('run-4')!.state, 'stopped');
  assert.equal(ports.runs.get('run-4')!.ending, 'run-3, which it ran for, was stopped');
});

test('part 3b review: a person block answered with its word alone passes on what it was handed', async () => {
  const { runs, ports, replies, answer, told } = await engine();
  await runs.start('manager-1', { title: 'Cart' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Ready' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'PR opened' });
  replies.set(ports.runs.get('run-1')!.sessions['code-review']!, 'Approved: PR #143 reads well.');
  await runs.step('manager-1', { run: 'run-1', outcome: 'Approved' });
  await answer(ports.runs.get('run-1')!.question!, 'Accepted.');
  assert.equal(ports.runs.get('run-1')!.at, 'merge');
  assert.match(told.at(-1)!.text, /At "Merge \+ release" \(merge\): your own step\.\n\n"Code review" handed on:\n\nApproved: PR #143 reads well\./);
});

// --- Part 3d: the four format additions, each drawn (the format and its checks), checked and followed. -----------------

/** A test flow with all four: a sign-off by the owner, a wait for CI, four reviewers at once, a phase in the caller's session. */
const PHASES = {
  version: 1, title: 'Phases', start: 'build',
  blocks: [
    { id: 'build', kind: 'work', title: 'Build', runs: 'new-session', model: 'sonnet', outcomes: [{ word: 'Pushed', to: 'ci' }] },
    { id: 'ci', kind: 'wait', title: 'CI', brief: 'briefs/ci.md', outcomes: [{ word: 'Green', to: 'review' }, { word: 'Red', to: 'build' }, { word: 'Red', times: 3, to: 'owner' }] },
    { id: 'review', kind: 'check', title: 'Review', runs: 'new-session', parallel: true, substeps: [
      { id: 'sec', kind: 'check', title: 'Security', when: 'start' }, { id: 'perf', kind: 'check', title: 'Speed', when: 'start' },
    ], outcomes: [{ word: 'Approved', to: 'polish' }] },
    { id: 'polish', kind: 'flow', title: 'Polish', flow: 'polish', session: 'caller', outcomes: [{ word: 'Polished', to: 'owner' }] },
    { id: 'owner', kind: 'person', title: 'Owner signs off', ask: 'question', person: 'the owner', outcomes: [{ word: 'Ship it', end: true }, { word: 'Not yet', to: 'build' }] },
  ],
};
const POLISH = {
  version: 1, title: 'Polish',
  blocks: [{ id: 'tidy', kind: 'work', title: 'Tidy', runs: 'new-session', outcomes: [{ word: 'Polished', end: true }] }],
};

test('part 3d: the format: person, a wait block, parallel sub-steps and a Run flow block in the caller\'s session read and pass the checks', () => {
  const parsed = parseFlow(JSON.stringify(PHASES));
  assert.deepEqual(parsed.problems, []);
  const flow = parsed.flow!;
  assert.equal(flow.blocks[1]!.kind, 'wait');
  assert.equal(flow.blocks[2]!.parallel, true);
  assert.equal(flow.blocks[3]!.session, 'caller');
  assert.equal(flow.blocks[4]!.person, 'the owner');
  const problems = checkFlow(flow, () => true);
  assert.deepEqual(problems.filter((p) => !p.hint), []);
  const calls = checkFlowCalls(new Map([['main', flow], ['polish', parseFlow(JSON.stringify(POLISH)).flow!]]));
  assert.deepEqual(calls.get('main'), []);
});

test('part 3d: the checks: each field only where it means something', () => {
  const bad = parseFlow(JSON.stringify({
    version: 1,
    blocks: [
      { id: 'a', kind: 'work', title: 'A', runs: 'manager', person: 'the owner', session: 'caller', parallel: true, outcomes: [{ word: 'Go', to: 'w' }] },
      { id: 'w', kind: 'wait', title: 'W', runs: 'manager', model: 'opus', outcomes: [{ word: 'Done', to: 'f' }] },
      { id: 'f', kind: 'flow', title: 'F', flow: 'main', parallel: true },
      { id: 'one', kind: 'work', title: 'One', runs: 'manager', parallel: true, substeps: [{ id: 's', kind: 'check', title: 'S' }] },
    ],
  })).flow!;
  const said = checkFlow(bad, () => true).map((p) => `${p.at}${p.hint ? ' (hint)' : ''}`);
  for (const at of ['blocks.a.person', 'blocks.a.session', 'blocks.a.parallel', 'blocks.w.runs', 'blocks.w.model', 'blocks.f.parallel', 'blocks.one.parallel (hint)']) {
    assert.ok(said.includes(at), `${at} in ${said.join(', ')}`);
  }
  // A field of the wrong shape is said and the flow doesn't read.
  assert.match(parseFlow(JSON.stringify({ version: 1, blocks: [{ id: 'f', kind: 'flow', title: 'F', flow: 'x', session: 'own' }] })).problems[0]!.message, /is "caller"/);
});

async function phases() {
  const main = parseFlow(JSON.stringify(PHASES)).flow!;
  const polish = parseFlow(JSON.stringify(POLISH)).flow!;
  return {
    folder: '/work/.ledung/workflow', flows: new Map([['main', main], ['polish', polish]]), titles: new Map([['main', 'Phases'], ['polish', 'Polish']]),
    text: async (f: string) => (f === 'briefs/ci.md' ? 'Wait for the CI run on the PR.' : null),
  };
}

test('part 3d: followed: a wait waits, sub-steps at once, the caller\'s session goes on in the called flow, the owner\'s call is said', async () => {
  const { runs, ports, store, started, continued, answer } = await engine({ flows: await phases() });
  await runs.start('manager-1', { title: 'Speed up the cart' });
  assert.equal(started[0]!.title, 'Build: Speed up the cart');
  // The wait: the run waits there, with what it waits for, until the coordinator reports how it came out.
  const waiting = await runs.step('manager-1', { run: 'run-1', outcome: 'Pushed', note: 'PR #7' });
  assert.match(waiting, /At "CI" \(ci\), a wait: run-1 waits there \(the workflow page shows how long\) until you report how it came out\.\n\n"Build" handed on:\n\nPR #7\n\nThe brief \(briefs\/ci\.md\):\n\nWait for the CI run on the PR\./);
  assert.equal(ports.runs.get('run-1')!.state, 'waiting');
  // Counted at a wait like anywhere: red goes back to Build.
  await runs.step('manager-1', { run: 'run-1', outcome: 'Red' });
  assert.equal(ports.runs.get('run-1')!.state, 'running');
  await runs.step('manager-1', { run: 'run-1', outcome: 'Pushed' });
  await runs.step('manager-1', { run: 'run-1', outcome: 'Green' });
  // Parallel sub-steps: the review session starts them all at once and merges the results.
  assert.match(started.at(-1)!.task, /Start these subagents all at once, in parallel, and merge their results into one report:\n- Security \(check, when start\)\n- Speed \(check, when start\)/);
  const reviewer = ports.runs.get('run-1')!.sessions.review!;
  // The Run flow block hands the caller's session (the reviewer's, the latest) to Polish, whose Tidy continues it.
  const polish = await runs.step('manager-1', { run: 'run-1', outcome: 'Approved' });
  assert.match(polish, new RegExp(`It goes on in the caller's session ${reviewer}\\.\\n\\nrun-2: At "Tidy" \\(tidy\\): Ledung gave it to session "Review: Speed up the cart" \\(${reviewer}\\), the caller's session this flow was handed`));
  assert.equal(continued.at(-1)!.id, reviewer);
  assert.equal(ports.runs.get('run-2')!.sessions.tidy, reviewer);
  const before = started.length;
  // Polish ends; the owner is asked, the question saying whose call it is.
  await runs.step('manager-1', { run: 'run-2', outcome: 'Polished' });
  assert.equal(started.length, before);
  const q = store.getQuestion(ports.runs.get('run-1')!.question!)!;
  assert.equal(q.details!.run!.person, 'the owner');
  assert.match(q.details!.issue!, /It is the owner's call\./);
  await answer(q.id, 'Ship it');
  assert.equal(ports.runs.get('run-1')!.state, 'ended');
  assert.equal(ports.runs.get('run-1')!.ending, 'Ship it');
});

test('part 3c review: the page gets every open run and only the latest others', () => {
  const store = new Store(openDatabase(':memory:'));
  const runs = new RunStore(store.database);
  for (let i = 0; i < 40; i++) {
    const r = runs.create({ project: 'shop', title: `done ${i}`, ref: null, flow: 'main', at: 'issue', coordinator: 'm', parent: null, now: i });
    runs.update(r.id, { state: 'ended', ending: 'x' }, 100 + i);
  }
  runs.create({ project: 'shop', title: 'open 1', ref: null, flow: 'main', at: 'issue', coordinator: 'm', parent: null, now: 1 });
  runs.create({ project: 'shop', title: 'open 2', ref: null, flow: 'main', at: 'issue', coordinator: 'm', parent: null, now: 2 });
  const page = runs.forPage('shop');
  assert.equal(page.length, 32);
  assert.deepEqual(page.filter((r) => r.state === 'running').map((r) => r.title).sort(), ['open 1', 'open 2']);
  assert.ok(page.some((r) => r.title === 'done 39') && !page.some((r) => r.title === 'done 0'));
});
