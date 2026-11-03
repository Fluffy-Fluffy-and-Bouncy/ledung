// Workflow part 3e (docs/steps/workflow-follow.md): a manager constructs workflows. flow_propose's proposal (what would be
// written, with the versions it replaces; the flows before and after; the checks' problems), the review it becomes, the
// save on Accepted through the builder's save and the decline on Changes needed; the tool for managers only; and the
// "workflow building" skill shipped with Ledung as its own plugin (#1577).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, parseProject } from '../src/config.ts';
import { flowPlaces, readFlowView } from '../src/sessions/flow-files.ts';
import { buildProposal, ProposalStore, proposalSummary } from '../src/sessions/flow-propose.ts';
import { SessionManager, WORKFLOW_PLUGIN, workflowGuide } from '../src/sessions/manager.ts';
import { ledungToolServer, type ToolHandlers } from '../src/sessions/tools.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { removeTemp } from './temp.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'flow-ledung');
const temps: string[] = [];
after(() => temps.forEach(removeTemp));

/** A copy of the example project, to write into. */
function copy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-propose-'));
  temps.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const flowJson = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.ledung', 'workflow', 'flow.json'), 'utf8'));
/** Ledung's example flow with a second review between Code review and the person. */
function withSecondReview(dir: string): string {
  const flow = flowJson(dir);
  const review = flow.blocks.find((b: { id: string }) => b.id === 'code-review');
  review.outcomes[0].to = 'second-review';
  flow.blocks.splice(4, 0, { id: 'second-review', kind: 'check', title: 'Second review', runs: 'new-session', model: 'opus', brief: 'briefs/second.md', outcomes: [{ word: 'Approved', to: 'functional-review' }, { word: 'Changes requested', to: 'fix' }, { word: 'Changes requested', times: 2, to: 'decide' }] });
  return `${JSON.stringify(flow, null, 2)}\n`;
}

test('part 3e: a proposal is what would be written, the flows before and after, and what the checks find', async () => {
  const dir = copy();
  const project = parseProject({ name: 'shop', runner: 'local', path: dir });
  const view = await readFlowView('shop', flowPlaces(project, undefined));
  const p = await buildProposal(view, [
    { file: 'flow.json', text: withSecondReview(dir) },
    { file: 'briefs/second.md', text: '# Second reviewer\n\nRead the PR again.\n' },
    { file: 'rules.md', text: view.rules ?? '' },
  ], 'Simon wants a second reviewer.');
  // The unchanged rules are left out; flow.json replaces the version read, the brief is new.
  assert.deepEqual(p.writes.map((w) => [w.path, w.base === null ? 'new' : w.base === view.versions[w.path] ? 'read' : '?']), [['flow.json', 'read'], ['briefs/second.md', 'new']]);
  assert.deepEqual(p.flows.map((f) => [f.name, f.before?.flow?.blocks.length, f.after?.flow?.blocks.length]), [['main', 8, 9]]);
  assert.deepEqual(p.texts, [{ file: 'briefs/second.md', before: null, after: '# Second reviewer\n\nRead the PR again.\n' }]);
  assert.deepEqual(p.problems.filter((x) => !x.hint), []);
  // The example's frames are fitted round the page's own layout, and a block added moves the others: said as a hint.
  assert.deepEqual(p.problems.filter((x) => x.hint && x.at === 'flow.json: frames').length, 1);
  assert.match(proposalSummary(p), /^- flow\.json \("Ledung's own process"\): adds Second review; changes Code review\n- briefs\/second\.md: new$/);
  // A brief named but not given is found by the checks, as the builder's would.
  const missing = await buildProposal(view, [{ file: 'flow.json', text: withSecondReview(dir) }], 'x');
  assert.deepEqual(missing.problems.filter((x) => !x.hint).map((x) => x.at), ['blocks.second-review.brief']);
});

test('part 3e: what can\'t be proposed is refused, in words', async () => {
  const dir = copy();
  const project = parseProject({ name: 'shop', runner: 'local', path: dir });
  const view = await readFlowView('shop', flowPlaces(project, undefined));
  await assert.rejects(buildProposal(view, [{ file: 'rules.md', text: view.rules ?? '' }], 'x'), /Nothing changes/);
  await assert.rejects(buildProposal(view, [{ file: '../outside.md', text: 'x' }], 'x'), /is not a file the workflow's format has/);
  await assert.rejects(buildProposal(view, [{ file: 'flow.json', text: '{ "version": 1 }' }], 'x'), /would not be a flow/);
  await assert.rejects(buildProposal(view, [{ file: 'flows/nope.json', remove: true }], 'x'), /not there to remove/);
  await assert.rejects(buildProposal({ ...view, source: { kind: 'workflow', folder: '/w', workflow: 'team' } }, [{ file: 'rules.md', text: 'x' }], 'x'), /shared workflow "team"/);
  // A flow removed from flows/ is a removal of the version read.
  const removed = await buildProposal(view, [{ file: 'flows/asset.json', remove: true }], 'x');
  assert.deepEqual(removed.writes, [{ path: 'flows/asset.json', remove: true, base: view.versions['flows/asset.json'] }]);
  assert.equal(removed.flows[0]!.after, null);
  assert.ok(removed.problems.some((x) => x.at === 'blocks.asset.flow'), 'the Run flow block now runs a flow that is gone');
});

test('part 3e: a project with no workflow gets its first one by a proposal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-propose-empty-'));
  temps.push(dir);
  const view = await readFlowView('fresh', flowPlaces(parseProject({ name: 'fresh', runner: 'local', path: dir }), undefined));
  const three = { version: 1, title: 'Small change', blocks: [
    { id: 'build', kind: 'work', title: 'Build', runs: 'new-session', outcomes: [{ word: 'Done', to: 'review' }] },
    { id: 'review', kind: 'check', title: 'Review', runs: 'new-session', outcomes: [{ word: 'Approved', to: 'sign-off' }, { word: 'Changes requested', to: 'build' }, { word: 'Changes requested', times: 3, to: 'sign-off' }] },
    { id: 'sign-off', kind: 'person', title: 'Sign off', ask: 'review', outcomes: [{ word: 'Accepted', end: true }, { word: 'Changes needed', to: 'build' }] },
  ] };
  const p = await buildProposal(view, [{ file: 'flow.json', text: JSON.stringify(three, null, 2) }], 'A three-block flow.');
  assert.deepEqual(p.writes.map((w) => [w.path, w.base]), [['flow.json', null]]);
  assert.equal(p.flows[0]!.before, null);
  assert.equal(p.flows[0]!.after!.flow!.blocks.length, 3);
  assert.match(proposalSummary(p), /a new flow/);
  await assert.rejects(buildProposal(view, [{ file: 'rules.md', text: '# Rules' }], 'x'), /needs flow\.json/);
});

/** Answers as Simon; the test's manager is only a row, so delivering to it afterwards can't resume it (settled before). */
const answer = (manager: SessionManager, id: number, text: string) => manager.answerQuestion(id, text).catch((e: Error) => assert.match(e.message, /could not be resumed/));

/** A Ledung with the example project, its manager, and the manager's proposal put to Simon. */
async function proposed() {
  const dir = copy();
  const store = new Store(openDatabase(':memory:'));
  const published: string[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'shop', runner: 'local', path: dir }] }), store, (e) => published.push(e.type)));
  store.createSession({ id: 'mgr', project: 'shop', runner: 'local', title: 'Manager: shop', parentId: null, permissionMode: 'default', role: 'manager' });
  const reply = await manager.proposeFlow('mgr', [
    { file: 'flow.json', text: withSecondReview(dir) },
    { file: 'briefs/second.md', text: '# Second reviewer\n' },
  ], 'Simon wants a second reviewer before his review.');
  const q = store.listQuestions().find((x) => x.details?.flowProposal !== undefined)!;
  return { dir, store, manager, reply, q, published };
}

test('part 3e: a proposal is a review to Simon; Accepted saves it through the builder\'s save and tells the manager', async () => {
  const { dir, store, manager, reply, q } = await proposed();
  assert.match(reply, new RegExp(`^Your change is put to Simon as review #${q.id}, with the flows before and after\\. Accepted saves it`));
  assert.equal(q.addressedTo, 'user');
  assert.equal(q.sessionId, 'mgr');
  assert.equal(q.details!.title, 'Workflow change: Simon wants a second reviewer before his review.');
  assert.equal(q.details!.tier, 'Process');
  assert.equal(q.details!.review!.solving, 'Simon wants a second reviewer before his review.');
  assert.match(q.details!.review!.done, /Manager: shop proposes this change to shop's workflow:\n\n- flow\.json \("Ledung's own process"\): adds Second review; changes Code review\n- briefs\/second\.md: new/);
  assert.match(q.details!.review!.notes!, /The checks find no problems/);
  assert.match(q.details!.review!.notes!, /Hints:\n\n- flow\.json: frames: Its frames are drawn where they say.*Auto-arrange in the builder/);
  // Nothing is written yet.
  assert.equal(flowJson(dir).blocks.length, 8);
  const shown = manager.flowProposal('shop', q.details!.flowProposal!);
  assert.equal(shown.state, 'open');
  assert.equal('manager' in shown, false);
  assert.throws(() => manager.flowProposal('other', q.details!.flowProposal!), /no such proposal/);
  await answer(manager, q.id, 'Accepted.');
  assert.equal(flowJson(dir).blocks.length, 9);
  assert.equal(fs.readFileSync(path.join(dir, '.ledung', 'workflow', 'briefs', 'second.md'), 'utf8'), '# Second reviewer\n');
  assert.equal(manager.flowProposal('shop', q.details!.flowProposal!).state, 'saved');
  assert.match(store.undeliveredInbox('mgr').at(-1)!.text, /accepted review #\d+, and your workflow change is saved into shop's \.ledung\/workflow \(flow\.json, briefs\/second\.md\)/);
});

test('part 3e: Changes needed declines it; a file changed meanwhile is never written over', async () => {
  const a = await proposed();
  await answer(a.manager, a.q.id, 'Changes needed: a third reviewer instead.');
  assert.equal(a.manager.flowProposal('shop', a.q.details!.flowProposal!).state, 'declined');
  assert.equal(flowJson(a.dir).blocks.length, 8);
  const b = await proposed();
  fs.appendFileSync(path.join(b.dir, '.ledung', 'workflow', 'flow.json'), '\n');
  await answer(b.manager, b.q.id, 'Accepted.');
  assert.equal(b.manager.flowProposal('shop', b.q.details!.flowProposal!).state, 'failed');
  assert.match(b.store.undeliveredInbox('mgr').at(-1)!.text, /could not be saved: the workflow changed since it was proposed \(flow\.json\)/);
  // Also a file the proposal doesn't write: the flow its Run flow block runs (review of 3e).
  const c = await proposed();
  fs.rmSync(path.join(c.dir, '.ledung', 'workflow', 'flows', 'asset.json'));
  await answer(c.manager, c.q.id, 'Accepted.');
  assert.equal(c.manager.flowProposal('shop', c.q.details!.flowProposal!).state, 'failed');
  assert.match(c.store.undeliveredInbox('mgr').at(-1)!.text, /changed since it was proposed \(flows\/asset\.json\)/);
  assert.equal(flowJson(c.dir).blocks.length, 8);
});

test('part 3e: proposals are kept per project in the database', () => {
  const store = new Store(openDatabase(':memory:'));
  const proposals = new ProposalStore(store.database);
  const p = proposals.create('shop', 'mgr', { why: 'x', writes: [], flows: [], texts: [], problems: [], titles: {}, read: {}, createdAt: 1 });
  assert.deepEqual({ ...proposals.get(p.id)! }, { why: 'x', writes: [], flows: [], texts: [], problems: [], titles: {}, read: {}, createdAt: 1, id: p.id, project: 'shop', manager: 'mgr', question: null, state: 'open' });
  proposals.setQuestion(p.id, 7);
  proposals.setState(p.id, 'saved');
  assert.deepEqual([proposals.get(p.id)!.question, proposals.get(p.id)!.state], [7, 'saved']);
});

const base: ToolHandlers = { userName: 'Simon', role: 'manager', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '' };
const registered = (h: ToolHandlers) => (ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, { description?: string; handler: (a: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools;

test('part 3e: flow_propose is a manager\'s, short, and gives a container manager the guide', async () => {
  const propose = { propose: async () => 'proposed' };
  assert.equal(registered(base).flow_propose, undefined);
  assert.equal(registered({ ...base, role: 'session', propose }).flow_propose, undefined);
  const tool = registered({ ...base, propose }).flow_propose!;
  assert.ok(tool.description!.length < 300);
  assert.ok(!tool.description!.includes('guide'));
  assert.match((await tool.handler({ changes: [{ file: 'flow.json', text: '{}' }] }, {})).content[0]!.text, /Say why/);
  assert.equal((await tool.handler({ changes: [{ file: 'flow.json', text: '{}' }], why: 'x' }, {})).content[0]!.text, 'proposed');
  const container = registered({ ...base, propose: { ...propose, guide: () => 'THE GUIDE' } }).flow_propose!;
  assert.match(container.description!, /Call it with no changes for the guide to the format\./);
  assert.equal((await container.handler({}, {})).content[0]!.text, 'THE GUIDE');
});

test('part 3e: the "workflow building" skill ships as Ledung\'s own plugin, and the guide is its text', () => {
  const dir = WORKFLOW_PLUGIN();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'ledung-workflow');
  const skill = fs.readFileSync(path.join(dir, 'skills', 'workflow-building', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: workflow-building\ndescription: .{40,1024}\n---\n/);
  const guide = workflowGuide(dir);
  assert.match(guide, /^# Building a Ledung workflow/);
  assert.ok(guide.includes('flow_propose') && guide.includes('"times": 3') && guide.includes('"session": "caller"'));
  // The package and the release carry it (scripts/build-package.ts, scripts/release.ts).
  assert.ok((JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).files as string[]).includes('plugins/'));
});

test('part 3e review: line comments on the manager\'s code never answer a proposed workflow change', async () => {
  const { openReviewFor } = await import('../src/shared/line-comments.ts');
  const q = (id: number, details: Record<string, unknown>) => ({ id, sessionId: 'mgr', askedAt: id, question: 'x', options: null, addressedTo: 'user', status: 'open', answer: null, answeredAt: null, answeredBy: null, aboutQuestion: null, forwardedFrom: null, aboutRequest: null, shots: null, deliveredAt: null, withdrawnReason: null, details }) as never;
  const code = q(1, { review: { solving: 'a', done: 'b' } });
  const flow = q(2, { review: { solving: 'a', done: 'b' }, flowProposal: 1 });
  assert.equal((openReviewFor('mgr', [code, flow]) as { id: number } | null)?.id, 1);
  assert.equal(openReviewFor('mgr', [flow]), null);
});
