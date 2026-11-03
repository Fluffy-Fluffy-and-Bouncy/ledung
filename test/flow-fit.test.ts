// Part 3f besides the runs (docs/steps/workflow-fit.md, Simon 2026-11-03, question #1593): the builder keeps and sets the
// new settings; ledung#115 says which wins when a manager has a written workflow and a drawn flow; ledung#110 says when
// a project's own flow differs from the shared one it follows, and takes it back to the shared one.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../src/config.ts';
import { parseFlow } from '../src/shared/flow-check.ts';
import { backToShared, BOTH_LINE, flowPlaces, readFlowView, textVersion, workflowLines } from '../src/sessions/flow-files.ts';
import type { FlowView } from '../src/shared/flow.ts';
import { draftFromView, flowText, setBlock, setFollow } from '../web/src/flowEdit.ts';
import { followLine } from '../web/src/flowRuns.ts';
import { removeTemp } from './temp.ts';

const temps: string[] = [];
after(() => temps.forEach(removeTemp));

const viewOf = (raw: string): FlowView => ({
  project: 'p', source: { kind: 'project', folder: '/x/.ledung/workflow' }, expected: '.ledung/workflow/flow.json',
  flow: parseFlow(raw).flow, rules: null, texts: {}, problems: [], raw, versions: { 'flow.json': textVersion(raw) }, saveTo: '/p/.ledung/workflow', flows: [],
});

test('part 3f: the builder writes the settings back as written, sets them, and takes one out back to its default', () => {
  const raw = JSON.stringify({
    version: 1, worktree: { remove: { on: ['Done'] } }, limit: 2, tidy: 'stop', oneRunPerRef: false,
    blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'new-session', outcomes: [{ word: 'Go', to: 'b' }] }, { id: 'b', kind: 'work', title: 'B', runs: 'continue', continues: 'a', context: 'compact', limit: 1 }],
  }, null, 2);
  const { base, draft } = draftFromView(viewOf(raw))!;
  assert.deepEqual(JSON.parse(flowText(base, draft)), JSON.parse(raw));
  const changed = setFollow(draft, { limit: 3, tidy: undefined, oneRunPerRef: undefined, worktree: { base: 'main' } });
  const written = JSON.parse(flowText(base, setBlock(changed, changed.blocks[1]!.key, { context: 'clear', limit: undefined })));
  assert.equal(written.limit, 3);
  assert.equal('tidy' in written, false);
  assert.equal('oneRunPerRef' in written, false);
  assert.deepEqual(written.worktree, { base: 'main' });
  assert.equal(written.blocks[1].context, 'clear');
  assert.equal('limit' in written.blocks[1], false);
  assert.equal(followLine(parseFlow(JSON.stringify({ ...JSON.parse(raw), tidy: undefined })).flow), '2 at once · a worktree per run · several runs per ref');
  assert.equal(followLine(parseFlow(JSON.stringify({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A' }] })).flow), '');
});

test('ledung#115: a manager with a written workflow and a drawn flow is told which says what', () => {
  assert.equal(workflowLines('Read lead.md.', 'The process is drawn.'), `Read lead.md. The process is drawn. ${BOTH_LINE}`);
  assert.equal(workflowLines('Read lead.md.', null), 'Read lead.md.');
  assert.equal(workflowLines(null, 'The process is drawn.'), 'The process is drawn.');
  assert.equal(workflowLines(null, null), undefined);
  assert.match(BOTH_LINE, /the flow says what happens next and who does it; the written workflow files say how/);
});

/** A shared workflow's folder and a project that follows it, each with a .ledung/workflow made of `files`. */
function sharedAndProject(shared: Record<string, string>, own: Record<string, string>) {
  const make = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-fit-'));
    temps.push(dir);
    for (const [f, t] of Object.entries(files)) {
      const at = path.join(dir, '.ledung', 'workflow', ...f.split('/'));
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, t);
    }
    return dir;
  };
  const folder = make(shared);
  const dir = make(own);
  const workflow = { name: 'team', folder, managerFile: 'm.md', sessionFile: 's.md', projectConfig: 'p.json' };
  const project = parseProject({ name: 'shop', runner: 'local', path: dir, workflow: { name: 'team' } });
  return { dir, places: () => flowPlaces(project, workflow) };
}

const FLOW = JSON.stringify({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] });

test("ledung#110: a project's own copy of a shared flow says whether it differs, and goes back to the shared one", async () => {
  const same = sharedAndProject({ 'flow.json': FLOW, 'rules.md': '# R' }, { 'flow.json': FLOW, 'rules.md': '# R' });
  assert.deepEqual((await readFlowView('shop', same.places())).shared, { workflow: 'team', differs: false });
  const other = sharedAndProject({ 'flow.json': FLOW }, { 'flow.json': FLOW.replace('"A"', '"Changed"'), 'flows/extra.json': FLOW, 'briefs/x.md': '# X' });
  const view = await readFlowView('shop', other.places());
  assert.deepEqual(view.shared, { workflow: 'team', differs: true });
  assert.equal(view.source?.kind, 'project');
  // Back to shared: the project's flow.json and flows/ go; its briefs stay; the shared flow counts again.
  assert.deepEqual((await backToShared(other.places())).sort(), ['flow.json', 'flows/extra.json']);
  assert.equal(fs.existsSync(path.join(other.dir, '.ledung', 'workflow', 'briefs', 'x.md')), true);
  const back = await readFlowView('shop', other.places());
  assert.equal(back.source?.kind, 'workflow');
  assert.equal(back.shared, undefined);
  await assert.rejects(backToShared(other.places()), /no flow of its own/);
  // A project that follows no shared workflow has nothing to go back to.
  const alone = parseProject({ name: 'solo', runner: 'local', path: other.dir });
  await assert.rejects(backToShared(flowPlaces(alone, undefined)), /follows no shared workflow/);
});
