// Several flows per project, and a flow that runs another (issue #447, docs/steps/workflow-builder.md, part 2e): the
// format (a Run flow block, an outcome that ends the flow), the checks between flows, the reader of flows/<name>.json
// beside flow.json, the builder's workspace and what it writes and removes, the save, and the manager's line.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../src/config.ts';
import { checkFlow, checkFlowCalls, parseFlow, personGatedFlows } from '../src/shared/flow-check.ts';
import { flowInstructions, flowPlaces, flowWrites as serverWrites, readFlowView, saveFlowFiles, textVersion } from '../src/sessions/flow-files.ts';
import { drawnArrows, flowEndings, type Flow, type FlowView } from '../src/shared/flow.ts';
import { addBlock, addEndings, addFlow, deleteFlow, flowNameProblem, flowText, renameFlow, setBlock, setFlowTitle, setOutcome, single, withDraft, workspaceFromView, workspaceProblems, workspaceWrites } from '../web/src/flowEdit.ts';
import { removeTemp } from './temp.ts';

const temps: string[] = [];
after(() => temps.forEach(removeTemp));

/** A project folder with a .ledung/workflow made of `files` (path inside the workflow folder → text). */
function projectWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-flows-'));
  temps.push(dir);
  for (const [f, text] of Object.entries(files)) {
    const at = path.join(dir, '.ledung', 'workflow', ...f.split('/'));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  }
  return dir;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const flow = (raw: unknown): Flow => {
  const parsed = parseFlow(JSON.stringify(raw));
  assert.deepEqual(parsed.problems, []);
  return parsed.flow!;
};

/** A code flow that runs the asset flow, and the asset flow: made, reviewed by a person, ended Ready or Rejected. */
const MAIN = {
  version: 1, title: 'Code change', start: 'plan',
  blocks: [
    { id: 'plan', kind: 'work', title: 'Plan', runs: 'manager', outcomes: [{ word: 'Ready', to: 'art' }] },
    { id: 'art', kind: 'flow', title: 'Make the art', flow: 'asset', outcomes: [{ word: 'Ready', to: 'build' }, { word: 'Rejected', end: true }] },
    { id: 'build', kind: 'work', title: 'Build', runs: 'manager' },
  ],
};
const ASSET = {
  version: 1, title: 'Asset',
  blocks: [
    { id: 'produce', kind: 'work', title: 'Produce', runs: 'manager', outcomes: [{ word: 'Done', to: 'review' }] },
    { id: 'review', kind: 'person', title: 'Review', ask: 'review', outcomes: [{ word: 'Ready', end: true }, { word: 'Rejected', end: true }, { word: 'Changes needed', to: 'produce' }] },
  ],
};

test('#447 the format: a Run flow block names its flow; an outcome may end the flow instead of leading to a block', () => {
  const main = flow(MAIN);
  assert.deepEqual(main.blocks[1], MAIN.blocks[1]);
  // An outcome that ends the flow has no arrow; the checks find nothing wrong with it.
  assert.deepEqual(drawnArrows(main).filter((a) => a.from === 'art').map((a) => a.word), ['Ready']);
  assert.deepEqual(checkFlow(main, () => true), []);
  // What doesn't fit: both ending and leading on, a Run flow block that says no flow or is run by someone, "flow" elsewhere.
  const bad = flow({
    version: 1,
    blocks: [
      { id: 'a', kind: 'work', title: 'A', flow: 'x', outcomes: [{ word: 'Go', to: 'b', end: true }, { word: 'Stop', end: true }] },
      { id: 'b', kind: 'flow', title: 'B', runs: 'new-session', brief: 'briefs/b.md', model: 'opus' },
    ],
  });
  const said = checkFlow(bad, () => true).filter((p) => !p.hint).map((p) => `${p.at} ${p.message}`);
  assert.deepEqual(said, [
    'blocks.a.outcomes.1 "Go" of "A" both ends the flow and leads to "b": take out "end" or "to".',
    'blocks.a.flow Only a Run flow block (kind "flow") runs a flow: take "flow" out, or make "A" one.',
    'blocks.b.flow The Run flow block "B" doesn\'t say which flow it runs: give "flow", the name of one of the project\'s flows.',
    'blocks.b.runs A Run flow block is done by the flow it runs: take "runs" out of "B".',
    'blocks.b.model A Run flow block is done by the flow it runs: take "model" out of "B".',
    'blocks.b.brief A Run flow block is done by the flow it runs: take "brief" out of "B".',
  ]);
  assert.deepEqual(parseFlow(JSON.stringify({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', outcomes: [{ word: 'X', end: false }] }] })).problems.map((p) => p.at), ['blocks.a.outcomes.1.end']);
});

test('#447 how a flow ends: the words of the outcomes that end it, and the title of a block with no outcomes, each once', () => {
  assert.deepEqual(flowEndings(flow(ASSET)), ['Ready', 'Rejected']);
  assert.deepEqual(flowEndings(flow(MAIN)), ['Rejected', 'Build'], 'Build has nothing after it: its title is how the flow ends');
  const twice = flow({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', outcomes: [{ word: 'Done', end: true }, { word: 'Again', to: 'b' }] }, { id: 'b', kind: 'work', title: 'b', outcomes: [{ word: ' done ', end: true }] }] });
  assert.deepEqual(flowEndings(twice), ['Done'], 'letter case and spaces at the ends aside');
});

test('#447 the checks between flows: the flow is there, its outcomes are its endings, an ending with no outcome is a hint, no flow runs itself', () => {
  const ok = checkFlowCalls(new Map([['main', flow(MAIN)], ['asset', flow(ASSET)]]));
  assert.deepEqual([...ok.entries()], [['main', []], ['asset', []]]);
  // Matched by word, letter case aside; an outcome no ending produces is a problem; an ending with none, a hint.
  const loose = { ...MAIN, blocks: MAIN.blocks.map((b) => (b.id === 'art' ? { ...b, outcomes: [{ word: 'ready', to: 'build' }, { word: 'Cancelled', to: 'plan' }] } : b)) };
  const said = checkFlowCalls(new Map([['main', flow(loose)], ['asset', flow(ASSET)]])).get('main')!;
  assert.deepEqual(said.map((p) => [p.at, !!p.hint]), [['blocks.art.outcomes.2', false], ['blocks.art.outcomes', true]]);
  assert.match(said[0]!.message, /^"Cancelled" is not a way "Asset" ends, so "Make the art" never has it: it ends with "Ready", "Rejected"\.$/);
  assert.match(said[1]!.message, /^"Asset" can end with "Rejected": where does the work go after "Make the art" then\?/);
  // A flow that isn't there.
  const lost = checkFlowCalls(new Map([['main', flow(MAIN)]])).get('main')!;
  assert.deepEqual(lost.map((p) => `${p.at} ${p.message}`), ['blocks.art.flow "Make the art" runs the flow "asset", which the project doesn\'t have (no flows/asset.json).']);
  // Itself, directly, and through others: a problem on each Run flow block on the circle.
  const self = { ...ASSET, blocks: [...ASSET.blocks, { id: 'again', kind: 'flow', title: 'Again', flow: 'asset' }] };
  assert.match(checkFlowCalls(new Map([['asset', flow(self)]])).get('asset')!.map((p) => p.message).join('\n'), /"Again" runs "Asset", the flow it is in: a flow can't run itself\./);
  const back = { ...ASSET, blocks: [...ASSET.blocks, { id: 'code', kind: 'flow', title: 'Code it', flow: 'main', outcomes: [{ word: 'Build', to: 'produce' }] }] };
  const circle = checkFlowCalls(new Map([['main', flow(MAIN)], ['asset', flow(back)]]));
  assert.deepEqual(circle.get('main')!.filter((p) => p.at.endsWith('.flow')).map((p) => p.message), ['"Make the art" runs a flow that runs this one again (Code change → Asset → Code change): a flow can\'t run itself, also not through others.']);
  assert.deepEqual(circle.get('asset')!.filter((p) => p.at.endsWith('.flow')).map((p) => p.message), ['"Code it" runs a flow that runs this one again (Asset → Code change → Asset): a flow can\'t run itself, also not through others.']);
  // A flow that can't be read: its endings aren't known, so nothing is said about the outcomes.
  assert.deepEqual(checkFlowCalls(new Map<string, Flow | null>([['main', flow(MAIN)], ['asset', null]])).get('main'), []);
});

test('#447 a project with one flow.json reads as it did: one flow, nothing converted', async () => {
  const dir = projectWith({ 'flow.json': json(ASSET) });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.deepEqual(view.flows, []);
  assert.deepEqual(view.problems, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.ledung', 'workflow')), ['flow.json']);
  // Read and saved unchanged in the builder: nothing written.
  const ws = workspaceFromView(view)!;
  assert.deepEqual(ws.flows.map((f) => [f.name, f.read]), [['main', 'flow.json']]);
  assert.deepEqual(workspaceWrites(ws), []);
});

test('#447 the reader: each flow in flows/ with its own problems; one broken or misnamed leaves the others drawn; briefs shared', async () => {
  const dir = projectWith({
    'flow.json': json(MAIN),
    'flows/asset.json': json({ ...ASSET, blocks: ASSET.blocks.map((b) => (b.id === 'produce' ? { ...b, brief: 'briefs/maker.md' } : b)) }),
    'flows/broken.json': '{ "version": 1,',
    'flows/main.json': json(ASSET),
    'flows/Not A Name.json': json(ASSET),
    'flows/managed.json': json({ version: 1, manager: 'manager.md', blocks: [{ id: 'a', kind: 'work', title: 'A', brief: 'briefs/gone.md' }] }),
    'briefs/maker.md': '# Maker\n',
  });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.deepEqual(view.flows.map((f) => [f.name, f.file, !!f.flow]), [['asset', 'flows/asset.json', true], ['broken', 'flows/broken.json', false], ['managed', 'flows/managed.json', true]]);
  assert.deepEqual(view.flows[0]!.problems, []);
  assert.equal(view.texts['briefs/maker.md'], '# Maker\n', "another flow's brief is read with the rest");
  assert.match(view.flows[1]!.problems[0]!.message, /^is not valid JSON/);
  assert.equal(view.flows[1]!.problems[0]!.at, 'flows/broken.json');
  assert.deepEqual(view.flows[2]!.problems.map((p) => p.at), ['manager', 'blocks.a.brief', 'manager'], "one manager's file, the default flow's; its own missing brief and manager's file");
  assert.deepEqual(view.problems.map((p) => p.at), ['flows/main.json'], '"main" is the default flow\'s name');
  assert.ok(view.versions['flows/asset.json'] && view.versions['flows/broken.json'], 'each read, a flow or not, has its version');
});

test('#447 the builder: a flow added, renamed and deleted; its file written, the old one removed, the Run flow blocks following', async () => {
  const dir = projectWith({ 'flow.json': json(MAIN), 'flows/asset.json': json(ASSET), 'briefs/a.md': '# A\n' });
  const places = flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined);
  const view = await readFlowView('p', places);
  let ws = workspaceFromView(view)!;
  assert.deepEqual(ws.flows.map((f) => f.name), ['main', 'asset']);
  assert.deepEqual(workspaceWrites(ws), [], 'read and saved unchanged: nothing written');
  // Added: its name follows its title; "main" and names taken are not given.
  const made = addFlow(ws, 'Merge ask');
  assert.ok(typeof made === 'object');
  ws = made.ws;
  assert.equal(ws.flows.at(-1)!.name, 'merge-ask');
  ws = setFlowTitle(ws, made.key, 'Ask to merge');
  assert.equal(ws.flows.at(-1)!.name, 'ask-to-merge');
  assert.equal(flowNameProblem('main', ws, made.key), '"main" is the default flow\'s name.');
  assert.equal(flowNameProblem('asset', ws, made.key), 'Another flow is "asset" already.');
  assert.deepEqual(workspaceWrites(ws).map((w) => [w.path, w.base]), [['flows/ask-to-merge.json', null]]);
  // Renamed: the Run flow block in the default flow runs it by its new name; written new, the old file removed last.
  const asset = ws.flows[1]!.key;
  ws = renameFlow(ws, asset, 'art');
  assert.equal(ws.flows[0]!.draft.blocks.find((b) => b.block.id === 'art')!.block.flow, 'art');
  const writes = workspaceWrites(ws);
  assert.deepEqual(writes.map((w) => [w.path, w.remove ?? false, w.base]), [
    ['flows/art.json', false, null],
    ['flows/ask-to-merge.json', false, null],
    ['flow.json', false, view.versions['flow.json']],
    ['flows/asset.json', true, view.versions['flows/asset.json']],
  ]);
  await saveFlowFiles(places[0]!, writes);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.ledung', 'workflow', 'flows')).sort(), ['art.json', 'ask-to-merge.json']);
  const after = await readFlowView('p', places);
  assert.deepEqual(after.flows.map((f) => [f.name, f.problems.filter((p) => !p.hint).length]), [['art', 0], ['ask-to-merge', 0]]);
  assert.deepEqual(after.problems, []);
  // Deleted: removed on save, and the Run flow block that ran it now runs a flow that isn't there.
  let next = workspaceFromView(after)!;
  next = deleteFlow(next, next.flows.find((f) => f.name === 'art')!.key);
  assert.deepEqual(next.flows.length, 2);
  assert.match(workspaceProblems(next).get(next.flows[0]!.key)!.map((p) => p.message).join('\n'), /runs the flow "art", which the project doesn't have/);
  assert.deepEqual(workspaceWrites(next).map((w) => [w.path, w.remove ?? false]), [['flows/art.json', true]]);
  assert.equal(deleteFlow(next, next.flows[0]!.key), next, 'the default flow stays');
  // Review of #447: a flow made afterwards doesn't take over the block left running "art" while its title is typed.
  const again = addFlow(next, 'Ar');
  assert.ok(typeof again === 'object');
  const typed = setFlowTitle(again.ws, again.key, 'Art');
  assert.equal(typed.flows.at(-1)!.name, 'art-2');
  assert.equal(typed.flows[0]!.draft.blocks.find((b) => b.block.id === 'art')!.block.flow, 'art', 'the block still runs the flow that is gone, and the checks say so');
});

test('#447 the flows share their texts and rules: a brief changed from one flow is every flow\'s, and written once', async () => {
  const dir = projectWith({ 'flow.json': json(MAIN), 'flows/asset.json': json(ASSET), 'briefs/a.md': '# A\n', 'rules.md': 'R\n' });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  let ws = workspaceFromView(view)!;
  const [main, asset] = ws.flows;
  const produce = asset!.draft.blocks.find((b) => b.block.id === 'produce')!.key;
  ws = withDraft(ws, asset!.key, setBlock({ ...asset!.draft, texts: { ...asset!.draft.texts, 'briefs/a.md': '# A, changed\n' }, rules: 'R2\n' }, produce, { brief: 'briefs/a.md' }));
  assert.equal(ws.flows[0]!.draft.texts['briefs/a.md'], '# A, changed\n', 'the default flow sees it too');
  assert.equal(ws.flows[0]!.draft.rules, 'R2\n');
  assert.equal(ws.flows[0]!.draft.blocks, main!.draft.blocks, "the other flow's blocks are not touched");
  assert.deepEqual(workspaceWrites(ws).map((w) => w.path), ['briefs/a.md', 'rules.md', 'flows/asset.json']);
});

test("#447 a Run flow block in the builder: it starts with the other flow, gets that flow's endings as outcomes, and one can end the flow", () => {
  const view: FlowView = {
    project: 'p', source: { kind: 'project', folder: '/x' }, expected: '', flow: parseFlow(JSON.stringify(ASSET)).flow, rules: null, texts: {}, problems: [],
    raw: JSON.stringify(ASSET), versions: { 'flow.json': textVersion(JSON.stringify(ASSET)) }, saveTo: '/x', flows: [],
  };
  let ws = workspaceFromView(view)!;
  const made = addFlow(ws, 'Code');
  assert.ok(typeof made === 'object');
  ws = made.ws;
  const code = ws.flows[1]!;
  const added = addBlock(code.draft, 'flow', undefined, 'main');
  assert.deepEqual(added.draft.blocks.at(-1)!.block, { id: 'run-flow', kind: 'flow', title: 'Run flow', flow: 'main', at: added.draft.blocks.at(-1)!.block.at });
  const ended = addEndings(added.draft, added.key, flowEndings(parseFlow(JSON.stringify(ASSET)).flow!));
  assert.deepEqual(ended.blocks.at(-1)!.block.outcomes, [{ word: 'Ready' }, { word: 'Rejected' }], 'pins to draw');
  assert.equal(addEndings(ended, added.key, ['ready', 'Rejected']), ended, 'none twice');
  const end = setOutcome(ended, added.key, 1, { end: true });
  assert.deepEqual(JSON.parse(flowText(code.base, end)).blocks.at(-1).outcomes, [{ word: 'Ready' }, { word: 'Rejected', end: true }]);
  // Its pin drawn to a block: it no longer ends the flow.
  const wired = setOutcome(end, added.key, 1, { to: 'new-step', end: undefined });
  assert.deepEqual(wired.blocks.at(-1)!.block.outcomes![1], { word: 'Rejected', to: 'new-step' });
});

test('#447 the save: a removal only of a flow in flows/, only of the version read, after everything written', async () => {
  const dir = projectWith({ 'flow.json': json(MAIN), 'flows/asset.json': json(ASSET), 'rules.md': 'R\n' });
  const places = flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined);
  const v = textVersion(json(ASSET));
  assert.throws(() => serverWrites([{ path: 'rules.md', remove: true, base: textVersion('R\n') }]), /rules\.md can't be removed: a save removes only a flow in flows\//);
  assert.throws(() => serverWrites([{ path: 'flow.json', remove: true, base: v }]), /flow\.json can't be removed/);
  assert.throws(() => serverWrites([{ path: 'flows/asset.json', remove: true, base: null }]), /doesn't say which version it removes/);
  assert.throws(() => serverWrites([{ path: 'flows/main.json', text: json(ASSET), base: null }]), /not "main", the default flow's name/);
  assert.throws(() => serverWrites([{ path: 'flows/x.json', text: '{"version":1}', base: null }]), /flows\/x\.json would not be a flow/);
  assert.throws(() => serverWrites([{ path: 'flows/../x.json', text: json(ASSET), base: null }]), /is not a file the workflow's format has/);
  await assert.rejects(saveFlowFiles(places[0]!, [{ path: 'flows/asset.json', remove: true, base: textVersion('something else') }]), /flows\/asset\.json has changed since the page read the workflow/);
  assert.ok(fs.existsSync(path.join(dir, '.ledung', 'workflow', 'flows', 'asset.json')));
  await saveFlowFiles(places[0]!, [{ path: 'flows/asset.json', remove: true, base: v }, { path: 'flows/art.json', text: json(ASSET), base: null }]);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.ledung', 'workflow', 'flows')), ['art.json']);
});

test("#447 the manager's line names the other flows, short; a project with one flow gets the line it got", async () => {
  const one = projectWith({ 'flow.json': json(MAIN) });
  const plain = (await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: one }), undefined)))!;
  assert.match(plain, /which say where the work goes next\.$/);
  const two = projectWith({ 'flow.json': json(MAIN), 'flows/asset.json': json(ASSET) });
  const line = (await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: two }), undefined)))!;
  assert.ok(line.startsWith(plain.replace(path.join(one, '.ledung', 'workflow'), path.join(two, '.ledung', 'workflow'))));
  assert.equal(line.slice(line.indexOf(' Other flows')), ` Other flows, in ${path.join('flows', '<name>.json')}: asset. Each piece of work runs in one flow, flow.json's unless you or the person pick another; a "Run flow" block starts its flow as a piece of work of its own, and the word that flow ends with is the block's outcome.`);
  const many = projectWith({ 'flow.json': json(MAIN), ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => [`flows/${n}.json`, json(ASSET)])) });
  const long = (await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: many }), undefined)))!;
  assert.match(long, /: a, b, c, d, e, f, and 2 more\. /);
});

test("#447 a container's flows: listed by the folder script, a removal through the writer script with its checks", (t) => {
  if (spawnSync('sh', ['-c', 'readlink -f .'], { windowsHide: true }).status !== 0) {
    t.skip('no sh with readlink here');
    return;
  }
  return import('../src/runners/docker-runner.ts').then(({ WRITE_FLOW_SCRIPT, LIST_FLOW_SCRIPT }) => {
    const project = projectWith({ 'flow.json': '{}', 'flows/asset.json': '{}', 'flows/notes.txt': 'x', 'briefs/a.md': '# A' }).replaceAll('\\', '/');
    const listed = spawnSync('sh', ['-c', LIST_FLOW_SCRIPT, 'sh', project], { encoding: 'utf8', windowsHide: true });
    assert.equal(listed.stdout, 'briefs/a.md\nflows/asset.json\n');
    const sh = (args: string[]) => spawnSync('sh', ['-c', WRITE_FLOW_SCRIPT, 'sh', ...args], { encoding: 'utf8', windowsHide: true });
    const removed = sh(['remove', project, 'flows/asset.json']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.deepEqual(fs.readdirSync(path.join(project, '.ledung', 'workflow', 'flows')), ['notes.txt']);
    assert.equal(sh(['remove', project, 'flows/gone.json']).status, 0, 'one already gone is no error');
    // A folder in the way that is a link is refused, as for writing.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-flows-out-'));
    temps.push(outside);
    fs.writeFileSync(path.join(outside, 'keep.json'), 'KEEP');
    const linkedProject = projectWith({ 'flow.json': '{}' });
    try {
      fs.symlinkSync(outside, path.join(linkedProject, '.ledung', 'workflow', 'flows'), 'junction');
    } catch {
      t.diagnostic('no links here: the linked folder case was not run');
      return;
    }
    const refused = sh(['remove', linkedProject.replaceAll('\\', '/'), 'flows/keep.json']);
    assert.equal(refused.status, 3);
    assert.match(refused.stdout, /is a link/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.json'), 'utf8'), 'KEEP');
  });
});

test('#447 the single-flow write-back stays as it was: one flow, no removals', () => {
  const raw = JSON.stringify(ASSET);
  const view: FlowView = { project: 'p', source: { kind: 'project', folder: '/x' }, expected: '', flow: parseFlow(raw).flow, rules: null, texts: {}, problems: [], raw, versions: { 'flow.json': textVersion(raw) }, saveTo: '/x', flows: [] };
  const ws = workspaceFromView(view)!;
  const one = single(ws.flows[0]!.base, ws.flows[0]!.draft);
  assert.deepEqual(workspaceWrites(one), []);
  assert.deepEqual(workspaceWrites(withDraft(one, 'w0', { ...one.flows[0]!.draft, title: 'Assets' })).map((w) => [w.path, w.base]), [['flow.json', textVersion(raw)]]);
});

/** A reused "merge ask" flow: a person decides, then the manager merges; or the person holds it. */
const ASK = {
  version: 1, title: 'Merge ask',
  blocks: [
    { id: 'ask', kind: 'person', title: 'Ask to merge', ask: 'question', outcomes: [{ word: 'Yes', to: 'merge' }, { word: 'Hold or changes', end: true }] },
    { id: 'merge', kind: 'work', title: 'Merge', runs: 'manager' },
  ],
};
/** Build, then the merge ask; "Hold or changes" goes back to Build. */
const CODE = {
  version: 1, title: 'Code',
  blocks: [
    { id: 'build', kind: 'work', title: 'Build', runs: 'manager', outcomes: [{ word: 'Done', to: 'ask' }] },
    { id: 'ask', kind: 'flow', title: 'Merge ask', flow: 'merge-ask', outcomes: [{ word: 'Merge', end: true }, { word: 'Hold or changes', to: 'build' }] },
  ],
};
const loopsIn = (problems: { message: string }[]) => problems.filter((p) => /can go round for ever/.test(p.message)).map((p) => p.message);

test('#447 a loop through a Run flow block whose flow a person decides in on every way to its end is limited, as by a person', async () => {
  const lone = { version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] };
  const gated = personGatedFlows(new Map<string, Flow | null>([['main', flow(CODE)], ['merge-ask', flow(ASK)], ['asset', flow(ASSET)], ['lone', flow(lone)]]));
  assert.deepEqual([...gated].sort(), ['asset', 'main', 'merge-ask'], 'Code ends only through the merge ask; Lone with no person on the way');
  // Through another flow's Run flow block too, and never for a flow that runs itself or can't be read.
  const wrapped = { version: 1, blocks: [{ id: 'w', kind: 'flow', title: 'W', flow: 'merge-ask', outcomes: [{ word: 'Merge', end: true }, { word: 'Hold or changes', end: true }] }] };
  const self = { version: 1, blocks: [{ id: 's', kind: 'flow', title: 'S', flow: 'self', outcomes: [{ word: 'S', end: true }] }] };
  assert.deepEqual([...personGatedFlows(new Map<string, Flow | null>([['wrapped', flow(wrapped)], ['merge-ask', flow(ASK)], ['self', flow(self)], ['gone', null]]))].sort(), ['merge-ask', 'wrapped']);
  // A pin not drawn yet, or to no block, in the merge ask: not decided, so the caller's loop is said.
  const loose = { ...ASK, blocks: [{ id: 'pre', kind: 'work', title: 'Pre', runs: 'manager', outcomes: [{ word: 'Go', to: 'ask' }, { word: 'Skip' }] }, ...ASK.blocks] };
  const typo = { ...ASK, blocks: [{ id: 'pre', kind: 'work', title: 'Pre', runs: 'manager', outcomes: [{ word: 'Go', to: 'ask' }, { word: 'Skip', to: 'nowhere' }] }, ...ASK.blocks] };
  for (const f of [loose, typo]) assert.equal(personGatedFlows(new Map([['merge-ask', parseFlow(JSON.stringify(f)).flow]])).size, 0);
  // Two flows that run each other behind a person: both decided (and the circle is a problem of its own).
  const a = { version: 1, blocks: [{ id: 'p', kind: 'person', title: 'P', ask: 'question', outcomes: [{ word: 'B', to: 'b' }, { word: 'Done', end: true }] }, { id: 'b', kind: 'flow', title: 'B', flow: 'b', outcomes: [{ word: 'Done', end: true }] }] };
  const b = { version: 1, blocks: [{ id: 'a', kind: 'flow', title: 'A', flow: 'a', outcomes: [{ word: 'Done', end: true }] }] };
  assert.deepEqual([...personGatedFlows(new Map<string, Flow | null>([['a', flow(a)], ['b', flow(b)]]))].sort(), ['a', 'b']);
  // The two-flow case, read from the files: no loop problem; with a merge ask nobody decides in, there is one.
  const dir = projectWith({ 'flow.json': json(CODE), 'flows/merge-ask.json': json(ASK) });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.deepEqual(loopsIn(view.problems), []);
  assert.deepEqual(view.problems.filter((p) => !p.hint), []);
  const unasked = { ...ASK, blocks: ASK.blocks.map((b) => (b.id === 'ask' ? { ...b, kind: 'work', runs: 'manager', ask: undefined } : b)) };
  const open = projectWith({ 'flow.json': json(CODE), 'flows/merge-ask.json': json(unasked) });
  const said = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: open }), undefined));
  assert.deepEqual(loopsIn(said.problems), ['Build → Merge ask can go round for ever: give an outcome in it a count ("times": where the 3rd one goes, say), or put a person block in it.']);
  // The builder's live checks say the same.
  const ws = workspaceFromView(view)!;
  assert.deepEqual(loopsIn(workspaceProblems(ws).get(ws.flows[0]!.key)!), []);
  assert.equal(loopsIn(workspaceProblems(workspaceFromView(said)!).get('w0')!).length, 1);
});

test('#447 a counted outcome that ends the flow limits its plain word, as a counted outcome to another block does', () => {
  const round = (outcomes: unknown[]) => flow({ version: 1, blocks: [
    { id: 'a', kind: 'work', title: 'A', runs: 'manager', outcomes: [{ word: 'Done', to: 'b' }] },
    { id: 'b', kind: 'check', title: 'B', runs: 'manager', outcomes },
  ] });
  const open = checkFlow(round([{ word: 'Failed', to: 'a' }, { word: 'Passed', end: true }]), () => true);
  assert.deepEqual(loopsIn(open).length, 1);
  assert.deepEqual(loopsIn(checkFlow(round([{ word: 'Failed', to: 'a' }, { word: 'Failed', times: 3, end: true }, { word: 'Passed', end: true }]), () => true)), []);
  // The count must be of the same word that goes round, on the block it leaves.
  const other = flow({ version: 1, blocks: [
    { id: 'a', kind: 'work', title: 'A', runs: 'manager', outcomes: [{ word: 'Failed', to: 'b' }, { word: 'Failed', times: 3, end: true }] },
    { id: 'b', kind: 'check', title: 'B', runs: 'manager', outcomes: [{ word: 'Failed', to: 'a' }] },
  ] });
  assert.deepEqual(loopsIn(checkFlow(other, () => true)), [], "A's own count limits A's word; the loop passes it");
  const elsewhere = flow({ version: 1, blocks: [
    { id: 'a', kind: 'work', title: 'A', runs: 'manager', outcomes: [{ word: 'Done', to: 'b' }] },
    { id: 'b', kind: 'check', title: 'B', runs: 'manager', outcomes: [{ word: 'Failed', to: 'a' }] },
    { id: 'c', kind: 'work', title: 'C', runs: 'manager', outcomes: [{ word: 'Failed', times: 3, end: true }] },
  ] });
  assert.equal(loopsIn(checkFlow(elsewhere, () => true)).length, 1, 'a count on another block limits nothing here');
  assert.equal(loopsIn(checkFlow(round([{ word: 'Failed', to: 'a' }, { word: 'Broken', times: 3, end: true }]), () => true)).length, 1);
});

test('#447 several outcomes between the same two blocks are laid out (dagre failed on them): each its own pin, one route', async () => {
  const { layoutFlow } = await import('../web/src/flowLayout.ts');
  const fan = flow({ version: 1, start: 'split', blocks: [
    { id: 'split', kind: 'fork', title: 'Split', outcomes: [{ word: 'One', to: 'one' }, { word: 'Two', to: 'two' }] },
    { id: 'one', kind: 'check', title: 'One', runs: 'manager', outcomes: [{ word: 'Yes', to: 'both' }, { word: 'No', to: 'both' }, { word: 'Maybe', to: 'both' }] },
    { id: 'two', kind: 'check', title: 'Two', runs: 'manager', outcomes: [{ word: 'Yes', to: 'both' }, { word: 'No', to: 'both' }] },
    { id: 'both', kind: 'join', title: 'Both in', outcomes: [{ word: 'Yes', end: true }, { word: 'No', end: true }, { word: 'Maybe', end: true }] },
  ] });
  const layout = layoutFlow(fan);
  const from = (id: string) => layout.arrows.filter((a) => a.from === id);
  assert.deepEqual(from('one').map((a) => a.index), [0, 1, 2]);
  assert.ok(layout.arrows.every((a) => a.route && a.route.length >= 2), 'every arrow routed');
  assert.deepEqual(from('one')[0]!.route, from('one')[2]!.route, 'arrows between the same two blocks share a route');
  assert.ok(new Set(layout.arrows.map((a) => a.id)).size === layout.arrows.length, 'each arrow its own id');
});

test("#447 the page's error boundary tells a part that couldn't be fetched from an error while drawing", async () => {
  const { errorText, isStalePageError } = await import('../web/src/pageError.ts');
  assert.equal(isStalePageError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/WorkflowView-abc.js')), true);
  assert.equal(isStalePageError(new TypeError('Importing a module script failed.')), true);
  assert.equal(isStalePageError(new Error('Unable to preload CSS for /assets/WorkflowView-abc.css')), true);
  assert.equal(isStalePageError(new Error('Not possible to find intersection inside of the rectangle')), false);
  assert.match(errorText(new Error('Not possible to find intersection inside of the rectangle')), /^Error: Not possible to find intersection/);
  assert.equal(errorText('plain'), 'plain');
});

test('#447 an arrow from a pin to the block below turns below its own block as drawn, never inside it ("a pointer towards itself")', async () => {
  const { layoutFlow, pinnedRoute } = await import('../web/src/flowLayout.ts');
  // A chain of blocks with one outcome each, straight down, and a block whose three outcomes all go to the one below.
  const chain = flow({ version: 1, blocks: [
    { id: 'claim', kind: 'work', title: 'Claim: assign it in the tracker', runs: 'manager', outcomes: [{ word: 'Assigned', to: 's0' }] },
    { id: 's0', kind: 'work', title: 'S0: write the brief, start the session', runs: 'manager', outcomes: [{ word: 'Session started', to: 'check' }] },
    { id: 'check', kind: 'check', title: 'Check', runs: 'manager', outcomes: [{ word: 'Yes', to: 'last' }, { word: 'No', to: 'last' }, { word: 'Maybe', to: 'last' }] },
    { id: 'last', kind: 'work', title: 'Last', runs: 'manager' },
  ] });
  const layout = layoutFlow(chain);
  const at = new Map(layout.blocks.map((b) => [b.block.id, b]));
  for (const a of layout.arrows) {
    const from = at.get(a.from)!;
    const to = at.get(a.to)!;
    const bottom = from.y + from.height;
    assert.ok(to.y > bottom, `${a.to} is below ${a.from}`);
    // The pin on the block's right edge, a row each from the foot.
    const pin = { x: from.x + from.width, y: bottom - 10 - 18 * ((from.block.outcomes?.length ?? 1) - 1 - (a.index ?? 0)) };
    const path = pinnedRoute(pin, 16 + 10 * (a.index ?? 0), a.route!, bottom);
    // Out to the right of the block, down below it, and only then across: nothing of it inside the block.
    assert.ok(path[1]!.x > from.x + from.width, 'out to the right first');
    assert.ok(path[2]!.y > bottom && path[3]!.y > bottom, `${a.from} → ${a.to} turns below its block`);
    assert.ok(path.slice(3).every((p) => p.y > bottom), 'the rest runs below it');
  }
  // Drawn taller than laid out (a title the estimate missed): the turn follows the block as drawn.
  const tall = pinnedRoute({ x: 210, y: 140 }, 16, [{ x: 105, y: 100 }, { x: 105, y: 160 }], 150);
  assert.deepEqual(tall.slice(1, 4), [{ x: 226, y: 140 }, { x: 226, y: 154 }, { x: 105, y: 154 }], 'below the block, above where it heads');
  // Drawn so much taller that the route's next point is inside it: that point is passed by, the turn below the block.
  const taller = pinnedRoute({ x: 210, y: 175 }, 16, [{ x: 105, y: 100 }, { x: 105, y: 128 }, { x: 300, y: 128 }, { x: 300, y: 260 }], 185);
  assert.deepEqual(taller.slice(1), [{ x: 226, y: 175 }, { x: 226, y: 197 }, { x: 300, y: 197 }, { x: 300, y: 260 }]);
  // Without a drawn bottom, as before.
  assert.deepEqual(pinnedRoute({ x: 210, y: 90 }, 16, [{ x: 105, y: 100 }, { x: 105, y: 160 }]).slice(2, 4), [{ x: 226, y: 130 }, { x: 105, y: 130 }]);
});
