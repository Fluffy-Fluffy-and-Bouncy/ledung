// The workflow builder's edits (issue #311, part 2): a flow read and saved unchanged gives the same files, fields this
// Ledung doesn't know included; Ledung's own process drawn from scratch gives part 1's flow.json; edits keep the
// links between blocks; the live checks are part 1's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFlow } from '../src/shared/flow-check.ts';
import { textVersion } from '../src/sessions/flow-files.ts';
import type { FlowView } from '../src/shared/flow.ts';
import { addBlock, addFrame, addOutcome, addOverlay, addSubstep, amendedBy, arrange, blocksSaving, connect, deleteBlocks, deleteOutcome, deleteOverlay, deleteSubstep, draftFromView, draftProblems, flowText, flowWrites, formatJson, moveBlock, moveSubstep, newBrief, newDraft, newManagerFile, newOverlayFile, newSubstepBrief, setBlock, setFrame, setManager, setOutcome, setOverlay, setSubstep, toggleAmends, wireOutcome, frameMembers, type Draft } from '../web/src/flowEdit.ts';
import type { FlowProblem } from '../src/shared/flow.ts';
import { layoutFlow } from '../web/src/flowLayout.ts';

const FOLDER = path.resolve('test/fixtures/flow-ledung/.ledung/workflow');
const RAW = fs.readFileSync(path.join(FOLDER, 'flow.json'), 'utf8');

/** A view as the server gives it, from flow.json's text and the texts beside it. */
function viewOf(raw: string, texts: Record<string, string> = {}, rules: string | null = null, kind: 'project' | 'workflow' = 'project'): FlowView {
  const versions: Record<string, string> = { 'flow.json': textVersion(raw), ...Object.fromEntries(Object.entries(texts).map(([f, t]) => [f, textVersion(t)])) };
  if (rules !== null) versions['rules.md'] = textVersion(rules);
  return {
    project: 'p', source: { kind, folder: '/x/.ledung/workflow', ...(kind === 'workflow' ? { workflow: 'team' } : {}) }, expected: '.ledung/workflow/flow.json',
    flow: parseFlow(raw).flow, rules, texts, problems: [], raw, versions, saveTo: '/p/.ledung/workflow', flows: [],
  };
}

/** The problems, without the hints (#1184). */
const faults = (list: FlowProblem[]) => list.filter((p) => !p.hint);

const exampleTexts = () => Object.fromEntries(['briefs/builder.md', 'briefs/decide.md', 'briefs/functional-review.md', 'briefs/issue.md', 'briefs/merge.md', 'briefs/reviewer.md', 'manager.md', 'overlays/check-before-push.md']
  .map((f) => [f, fs.readFileSync(path.join(FOLDER, f), 'utf8')]));

test('a flow read and saved unchanged gives the same files: nothing to write, the same JSON', () => {
  const { base, draft } = draftFromView(viewOf(RAW, exampleTexts(), '# Rules\n'))!;
  assert.deepEqual(JSON.parse(flowText(base, draft)), JSON.parse(RAW));
  assert.deepEqual(flowWrites(base, draft), []);
});

test("fields this Ledung doesn't know, $comment and a left-out default stay as written, in blocks and their outcomes", () => {
  const raw = JSON.stringify({
    $comment: 'top', version: 1, future: { a: 1 },
    blocks: [
      { $comment: 'first', id: 'a', kind: 'work', title: 'A', colour: 'red', outcomes: [{ word: 'Next', to: 'b', weight: 3 }, { $comment: 'c', word: 'Failed', to: 'p', times: 2 }], at: { x: 1, y: 2, z: 3 } },
      { id: 'b', kind: 'work', title: ' B ', outcomes: [{ word: 'Done', to: 'p' }] },
      { id: 'p', kind: 'person', title: 'P', ask: 'review', timer2: true },
    ],
  });
  const view = viewOf(raw);
  assert.ok(view.flow, 'it reads as a flow');
  const { base, draft } = draftFromView(view)!;
  assert.deepEqual(JSON.parse(flowText(base, draft)), JSON.parse(raw));
  assert.deepEqual(flowWrites(base, draft), []);
  // A change writes only what changed: the rest of the block, and the fields nobody here knows, stay.
  const moved = setOutcome(setBlock(setBlock(draft, 'b0', { title: 'A again' }), 'b1', { runs: 'manager' }), 'b0', 1, { times: 3 });
  const written = JSON.parse(flowText(base, moved));
  assert.deepEqual(written.blocks[0], { $comment: 'first', id: 'a', kind: 'work', title: 'A again', colour: 'red', outcomes: [{ word: 'Next', to: 'b', weight: 3 }, { $comment: 'c', word: 'Failed', to: 'p', times: 3 }], at: { x: 1, y: 2, z: 3 } });
  assert.deepEqual(written.blocks[1], { id: 'b', kind: 'work', title: ' B ', runs: 'manager', outcomes: [{ word: 'Done', to: 'p' }] });
  assert.equal(written.$comment, 'top');
  assert.deepEqual(written.future, { a: 1 });
  const writes = flowWrites(base, moved);
  assert.deepEqual(writes.map((w) => [w.path, w.base]), [['flow.json', textVersion(raw)]]);
  // The live checks say the unknown fields are kept, not left out.
  assert.match(draftProblems(base, draft).map((p) => p.message).join('\n'), /the builder keeps it as it is/);
});

test("Ledung's own process drawn from scratch gives part 1's flow.json (all but its $comment): runs, outcomes, pins, a continued session, a sub-step, the manager's file, an overlay and frames", () => {
  let { base, draft } = newDraft(false, null);
  const add = (kind: Parameters<typeof addBlock>[1], fields: Parameters<typeof setBlock>[2]) => {
    const made = addBlock(draft, kind);
    draft = setBlock(made.draft, made.key, fields);
    return made.key;
  };
  // Titles first: a new block's id follows its title, as on the canvas. Work and checks start as a new session's.
  add('work', { title: 'Issue', runs: 'manager', brief: 'briefs/issue.md' });
  // A Run flow block (#447): it runs the asset flow, and nobody here runs it.
  const asset = add('flow', { title: 'Make the asset', flow: 'asset' });
  assert.equal(draft.blocks.find((b) => b.key === asset)!.block.runs, undefined);
  draft = setBlock(draft, asset, { id: 'asset' });
  const build = add('work', { title: 'Build', model: 'opus', brief: 'briefs/builder.md' });
  assert.equal(draft.blocks.find((b) => b.key === build)!.block.runs, 'new-session');
  add('check', { title: 'Code review', model: 'opus', brief: 'briefs/reviewer.md' });
  add('work', { title: 'Fix', runs: 'continue', continues: 'build', brief: 'briefs/builder.md' });
  const decide = add('person', { title: 'Person decides', ask: 'question', brief: 'briefs/decide.md' });
  assert.equal(draft.blocks.find((b) => b.key === decide)!.block.id, 'person-decides');
  assert.equal(draft.blocks.find((b) => b.key === decide)!.block.runs, 'person', "a person block is a person's");
  draft = setBlock(draft, decide, { id: 'decide' });
  const functional = add('person', { title: 'Functional review', ask: 'review', brief: 'briefs/functional-review.md' });
  add('work', { title: 'Merge + release', runs: 'manager', brief: 'briefs/merge.md' });
  assert.equal(draft.blocks.find((b) => b.key === functional)!.block.id, 'functional-review');
  draft = setBlock(draft, draft.blocks.find((b) => b.block.title === 'Merge + release')!.key, { id: 'merge' });
  // Outcomes drawn from block to block, each word then given in the panel, and a count where there is one (#1184);
  // the counted one as a pin (#446): named with "+ outcome", its count set, then its pin drawn to the person.
  for (const [from, to, word, times] of [
    ['issue', 'build', 'Ready'], ['issue', 'asset', 'Needs an asset'], ['asset', 'build', 'Ready'], ['build', 'code-review', 'PR opened'],
    ['code-review', 'functional-review', 'Approved'], ['code-review', 'fix', 'Changes requested'], ['code-review', 'decide', 'Changes requested', 3],
    ['fix', 'code-review', 'Fixed'], ['decide', 'functional-review', 'Go on'], ['decide', 'fix', 'Fix again'],
    ['functional-review', 'merge', 'Accepted'], ['functional-review', 'fix', 'Changes needed'],
  ] as const) {
    if (times) {
      const key = draft.blocks.find((b) => b.block.id === from)!.key;
      const pin = addOutcome(draft, key, undefined, word);
      draft = wireOutcome(setOutcome(pin.draft, key, pin.index, { times }), key, pin.index, to);
      continue;
    }
    const made = connect(draft, from, to)!;
    assert.equal(made.draft.blocks.find((b) => b.key === made.key)!.block.outcomes![made.index]!.word, '', 'its word is asked for');
    draft = setOutcome(made.draft, made.key, made.index, { word, ...(times ? { times } : {}) });
  }
  // The asset flow's other way to end ends this one too (#447): a pin named, then set to end the flow.
  const rejected = addOutcome(draft, asset, undefined, 'Rejected');
  draft = setOutcome(rejected.draft, asset, rejected.index, { end: true });
  draft = { ...draft, title: "Ledung's own process", start: 'issue' };
  // Build's self-review, as the panel's Add a check sub-step makes it and its fields set it.
  const sub = addSubstep(draft, build, 'check');
  assert.equal(sub.index, 0);
  assert.deepEqual(sub.draft.blocks.find((b) => b.key === build)!.block.substeps, [{ id: 'self-review', kind: 'check', title: 'Self-review', when: 'done' }]);
  draft = setSubstep(sub.draft, build, 0, { brief: 'briefs/reviewer.md', model: 'sonnet', outcomes: [{ word: 'No findings', to: 'done' }, { word: 'Findings', to: 'owner' }, { word: 'Findings', times: 3, to: 'report' }] });
  // The manager's file and the overlay, as the panels make them.
  draft = newManagerFile(draft);
  assert.equal(draft.manager, 'manager.md');
  assert.match(draft.texts['manager.md']!, /^# Manager\n/);
  const overlay = addOverlay(draft, 'Check before every push', ['fix']);
  assert.ok(typeof overlay === 'object');
  draft = toggleAmends(overlay.draft, overlay.key, 'build');
  assert.deepEqual(draft.overlays[0]!.overlay, { id: 'check-before-every-push', title: 'Check before every push', file: 'overlays/check-before-every-push.md', blocks: ['build', 'fix'] }, 'blocks in the flow\'s order');
  draft = setOverlay(draft, overlay.key, { id: 'check-before-push' });
  draft = newOverlayFile(draft, overlay.key, 'check-before-push') as Draft;
  // The frames (#446): one round Issue, from its panel; one round Build, Fix and Code review, titled and coloured.
  const keyOf = (id: string) => draft.blocks.find((b) => b.block.id === id)!.key;
  for (const [title, colour, ids] of [['Planning', 'blue', ['issue']], ['Building', 'green', ['build', 'fix', 'code-review']]] as const) {
    const made = addFrame(draft, 'New frame', { blocks: ids.map(keyOf) });
    assert.ok(typeof made === 'object');
    draft = setFrame(made.draft, made.key, { title, colour, id: title.toLowerCase() });
    assert.deepEqual(frameMembers(draft, draft.frames.find((f) => f.key === made.key)!.frame).sort(), ids.map(keyOf).sort(), `${title} holds its blocks`);
  }
  const drawn = JSON.parse(flowText(base, draft));
  const { $comment: _, ...example } = JSON.parse(RAW);
  // Positions are where the canvas put the blocks, and the frames round them; part 1's flow has none, so it is laid
  // out by the page, its frames round where the page puts them.
  const placeless = (f: { frames: object[]; blocks: object[] }) => ({ ...f, blocks: f.blocks.map(({ at: _a, ...b }: { at?: unknown }) => b), frames: f.frames.map(({ at: _a, size: _s, ...r }: { at?: unknown; size?: unknown }) => r) });
  assert.deepEqual(placeless(drawn), placeless(example));
  assert.ok(drawn.blocks.every((b: { at?: unknown }) => b.at), 'each block keeps where it was put');
  assert.deepEqual(Object.keys(drawn), ['version', 'title', 'start', 'manager', 'blocks', 'overlays', 'frames']);
  // The overlay's first file, given up for another, is not written.
  assert.deepEqual(flowWrites(base, draft).map((w) => w.path).sort(), ['flow.json', 'manager.md', 'overlays/check-before-push.md']);
  assert.deepEqual(draftProblems(base, { ...draft, texts: { ...draft.texts, ...exampleTexts() } }), []);
});

test('an id changed goes wherever it was used; a block taken out takes the outcomes that led to it (#1184)', () => {
  const { base, draft } = draftFromView(viewOf(RAW, exampleTexts()))!;
  const key = (d: Draft, id: string) => d.blocks.find((b) => b.block.id === id)!.key;
  const renamed = setBlock(draft, key(draft, 'fix'), { id: 'repair' });
  const flow = parseFlow(flowText(base, renamed)).flow!;
  assert.deepEqual(flow.blocks.find((b) => b.id === 'code-review')!.outcomes!.map((o) => o.to), ['functional-review', 'repair', 'decide']);
  assert.equal(flow.overlays[0]!.blocks.includes('repair'), true);
  const without = parseFlow(flowText(base, deleteBlocks(renamed, [key(renamed, 'decide')]))).flow!;
  assert.equal(without.blocks.some((b) => b.id === 'decide'), false);
  assert.deepEqual(without.blocks.find((b) => b.id === 'code-review')!.outcomes, [{ word: 'Approved', to: 'functional-review' }, { word: 'Changes requested', to: 'repair' }]);
  // Code review left with no outcome at all: the field goes.
  const lone = deleteBlocks(draft, [key(draft, 'functional-review'), key(draft, 'fix'), key(draft, 'decide')]);
  assert.equal('outcomes' in JSON.parse(flowText(base, lone)).blocks.find((b: { id: string }) => b.id === 'code-review'), false);
  // An outcome drawn to itself is none; another to the same block is another outcome, its word to be given.
  assert.equal(connect(draft, 'issue', 'issue'), null);
  const again = connect(draft, 'issue', 'build')!;
  assert.deepEqual(again.draft.blocks[0]!.block.outcomes, [{ word: 'Ready', to: 'build' }, { word: 'Needs an asset', to: 'asset' }, { word: '', to: 'build' }]);
  assert.equal(blocksSaving(base, again.draft), true, 'an empty word keeps the flow from being saved until it is given');
  assert.match(draftProblems(base, again.draft).map((p) => `${p.at} ${p.message}`).join('\n'), /^blocks\.issue\.outcomes\.3\.word is empty$/m);
  // Taking one out keeps the rest, and the others' keys, so they are still written over what they were.
  const out = deleteOutcome(draft, key(draft, 'code-review'), 1);
  assert.deepEqual(JSON.parse(flowText(base, out)).blocks[3].outcomes, [{ word: 'Approved', to: 'functional-review' }, { word: 'Changes requested', times: 3, to: 'decide' }]);
  const added = addOutcome(out, key(out, 'code-review'), 'fix', 'Changes requested');
  assert.deepEqual(JSON.parse(flowText(base, added.draft)).blocks[3].outcomes.at(-1), { word: 'Changes requested', to: 'fix' });
});

test('the live checks are part 1\'s, on what would be written; a flow with no block or no flow at all is not saved', () => {
  const { base, draft } = draftFromView(viewOf(RAW, exampleTexts()))!;
  assert.deepEqual(draftProblems(base, draft), []);
  const lonely = addBlock(draft, 'work').draft;
  assert.match(draftProblems(base, lonely).map((p) => p.message).join('\n'), /No outcome leads to "New step"/);
  // Hints: a second block that leads nowhere, a session with no brief.
  assert.deepEqual(draftProblems(base, lonely).filter((p) => p.hint).map((p) => p.at), ['blocks.merge.outcomes', 'blocks.new-step.outcomes', 'blocks.new-step.brief']);
  const asking = setBlock(draft, draft.blocks.find((b) => b.block.id === 'decide')!.key, { ask: undefined });
  assert.match(draftProblems(base, asking).map((p) => p.message).join('\n'), /doesn't say what it asks/);
  assert.equal(blocksSaving(base, asking), false, 'a draft with problems may be saved');
  const profiled = setBlock(draft, draft.blocks[2]!.key, { profile: 'review' });
  assert.match(draftProblems(base, profiled, ['full']).map((p) => p.message).join('\n'), /There is no session profile "review" for this project \(there are: full\)/);
  assert.deepEqual(draftProblems(base, profiled, ['full', 'review']), []);
  const empty = newDraft(false, null);
  assert.equal(blocksSaving(empty.base, empty.draft), true);
  assert.match(draftProblems(empty.base, empty.draft)[0]!.message, /at least one block/);
  const untitled = setBlock(lonely, lonely.blocks.at(-1)!.key, { title: '  ' });
  assert.equal(blocksSaving(base, untitled), true, 'an empty title would make flow.json no flow');
});

test('the starter is a flow with no problems: Issue → Build (a self-review) → Code review → Fix (Build\'s session) → Person → Merge', () => {
  const { base, draft } = newDraft(true, null);
  assert.deepEqual(draft.blocks.map((b) => b.block.title), ['Issue', 'Build', 'Code review', 'Fix', 'Person', 'Merge']);
  assert.deepEqual(faults(draftProblems(base, draft)), []);
  // Its sessions have no brief yet: hints, which don't keep a save (#1184).
  assert.deepEqual(draftProblems(base, draft).map((p) => p.at), ['blocks.build.brief', 'blocks.code-review.brief', 'blocks.fix.brief']);
  assert.deepEqual(draft.blocks[2]!.block.outcomes, [{ word: 'Approved', to: 'person' }, { word: 'Changes requested', to: 'fix' }, { word: 'Changes requested', times: 3, to: 'person' }]);
  const writes = flowWrites(base, draft);
  assert.deepEqual(writes.map((w) => [w.path, w.base]), [['flow.json', null]]);
  assert.equal(parseFlow(writes[0]!.text!).problems.length, 0);
});

test('briefs: a new one is made beside the block and written as new; an edited one names the version it replaces', () => {
  const { base, draft } = draftFromView(viewOf(RAW, exampleTexts(), '# Rules\n'))!;
  const fix = draft.blocks.find((b) => b.block.id === 'fix')!.key;
  const made = newBrief(draft, fix, 'Fix it');
  assert.equal(typeof made, 'object');
  const withBrief = made as Draft;
  assert.equal(withBrief.blocks.find((b) => b.key === fix)!.block.brief, 'briefs/fix-it.md');
  assert.match(newBrief(withBrief, fix, 'fix-it') as string, /already there/);
  assert.match(newBrief(withBrief, fix, 'BUILDER') as string, /already there/, 'a name taken in other case too');
  const edited = { ...withBrief, texts: { ...withBrief.texts, 'briefs/builder.md': 'Build it well.\n' }, rules: '# Rules\n\nOne more.\n' };
  const writes = flowWrites(base, edited);
  assert.deepEqual(writes.map((w) => [w.path, w.base]), [
    ['briefs/builder.md', textVersion(exampleTexts()['briefs/builder.md']!)],
    ['briefs/fix-it.md', null],
    ['rules.md', textVersion('# Rules\n')],
    ['flow.json', textVersion(RAW)],
  ]);
});

test("a shared workflow's flow is saved as a copy into the project's own folder: every file it uses, all new", () => {
  const { base, draft } = draftFromView(viewOf(RAW, { ...exampleTexts(), 'briefs/unused.md': 'x' }, '# Rules\n', 'workflow'))!;
  const writes = flowWrites(base, draft);
  assert.ok(writes.every((w) => w.base === null));
  assert.deepEqual(writes.map((w) => w.path).sort(), ['briefs/builder.md', 'briefs/decide.md', 'briefs/functional-review.md', 'briefs/issue.md', 'briefs/merge.md', 'briefs/reviewer.md', 'flow.json', 'manager.md', 'overlays/check-before-push.md', 'rules.md']);
});

test('auto-arrange puts the blocks where the page lays them out', () => {
  const { base, draft } = draftFromView(viewOf(RAW))!;
  const arranged = parseFlow(flowText(base, arrange(draft))).flow!;
  const plain = layoutFlow(parseFlow(RAW).flow!);
  assert.ok(arranged.blocks.every((b, i) => Math.abs(b.at!.x - plain.blocks[i]!.x) <= 0.5 && Math.abs(b.at!.y - plain.blocks[i]!.y) <= 0.5));
  // A block moved by hand is where it was put, its arrows drawn by the canvas; the others stay where they were.
  const moved = parseFlow(flowText(base, moveBlock(draft, draft.blocks[0]!.key, { x: 500.4, y: -20 }))).flow!;
  assert.deepEqual(moved.blocks[0]!.at, { x: 500, y: -20 });
  assert.deepEqual(moved.blocks[1]!.at, { x: Math.round(plain.blocks[1]!.x), y: Math.round(plain.blocks[1]!.y) });
});

test('flow.json is written as a person writes it: a part on one line when it fits, the same JSON either way', () => {
  const value = JSON.parse(RAW);
  const text = formatJson(value);
  assert.deepEqual(JSON.parse(text), value);
  assert.match(text, /"blocks": \["build", "fix"\]/);
  assert.match(text, /^ {4}\{ "id": "merge", "kind": "work", "title": "Merge \+ release", "runs": "manager", "brief": "briefs\/merge\.md" \}$/m);
  assert.match(text, /^ {6}"outcomes": \[\{ "word": "Ready", "to": "build" \}, \{ "word": "Rejected", "end": true \}\]$/m);
  // A block's own outcomes on one line when they fit; the top's lists one a line (#1184).
  assert.match(text, /^ {6}"outcomes": \[\{ "word": "Accepted", "to": "merge" \}, \{ "word": "Changes needed", "to": "fix" \}\]$/m);
  // Past the width only where nothing can be split: one long word ($comment here).
  assert.deepEqual(text.split('\n').filter((l) => l.length > 150).map((l) => l.trim().slice(0, 11)), ['"$comment":']);
  assert.equal(formatJson({ a: [], b: {}, c: 'x' }), '{ "a": [], "b": {}, "c": "x" }');
});

test('review of #311: a flow with two blocks of one id can still be edited; a dropped new brief and a deleted block leave nothing behind', () => {
  const raw = JSON.stringify({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', outcomes: [{ word: 'Next', to: 'c' }] }, { id: 'a', kind: 'work', title: 'A again' }, { id: 'c', kind: 'work', title: 'C' }] });
  const { base, draft } = draftFromView(viewOf(raw))!;
  const added = addBlock(draft, 'check').draft;
  assert.ok(added.blocks.every((b) => Number.isFinite(b.block.at!.x) && Number.isFinite(b.block.at!.y)));
  assert.notDeepEqual(added.blocks[1]!.block.at, added.blocks[0]!.block.at, 'the second "a" is beside the first, not on it');
  assert.ok(arrange(draft).blocks.every((b) => Number.isFinite(b.block.at!.x)));
  assert.ok(moveBlock(draft, 'b2', { x: 1, y: 2 }).blocks[2]!.block.at);
  // A brief made and then not used is not written.
  const full = draftFromView(viewOf(RAW, exampleTexts()))!;
  const fix = full.draft.blocks.find((b) => b.block.id === 'fix')!.key;
  const made = newBrief(full.draft, fix, 'scratch') as Draft;
  assert.deepEqual(flowWrites(full.base, setBlock(made, fix, { brief: 'briefs/builder.md' })), []);
  // An overlay forgets a block taken out, as it follows a renamed one.
  const noFix = deleteBlocks(full.draft, [fix]);
  assert.deepEqual(noFix.overlays[0]!.overlay.blocks, ['build']);
  assert.equal(base.copy, false);
});

test("#322 the manager's file: named, made as manager.md, given another, taken out; written into a flow that had none before its blocks", () => {
  const { base, draft } = draftFromView(viewOf(RAW, exampleTexts()))!;
  assert.equal(draft.manager, 'manager.md');
  // Another file, then none: the field goes, the file stays unwritten.
  const other = setManager(draft, 'briefs/issue.md');
  assert.equal(JSON.parse(flowText(base, other)).manager, 'briefs/issue.md');
  const none = setManager(draft, undefined);
  assert.equal('manager' in JSON.parse(flowText(base, none)), false);
  assert.deepEqual(flowWrites(base, none).map((w) => w.path), ['flow.json']);
  // Added again: manager.md, the one already there, so nothing but flow.json changes (and here, nothing at all).
  assert.deepEqual(flowWrites(base, newManagerFile(none)), []);
  // A flow that had none: manager.md made new, named before the blocks.
  const raw = JSON.stringify({ version: 1, title: 'T', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }], future: 1 });
  const read = draftFromView(viewOf(raw))!;
  const made = newManagerFile(read.draft);
  assert.deepEqual(Object.keys(JSON.parse(flowText(read.base, made))), ['version', 'title', 'manager', 'blocks', 'future']);
  assert.deepEqual(flowWrites(read.base, made).map((w) => [w.path, w.base]), [['manager.md', null], ['flow.json', textVersion(raw)]]);
  // Checked live like any brief: there, and nothing tied to one computer.
  assert.match(draftProblems(base, setManager(draft, 'briefs/nobody.md')).map((p) => `${p.at} ${p.message}`).join('\n'), /^manager The manager's file briefs\/nobody\.md is not in the workflow folder\.$/m);
  const tied = { ...draft, texts: { ...draft.texts, 'manager.md': '# Manager\n\nNotes in C:\\Users\\someone\\notes.md\n' } };
  assert.deepEqual(draftProblems(base, tied).map((p) => p.at), ['manager.md:3']);
});

test('#322 runs and continues: written back, followed when a block is renamed, dropped when the block it names is taken out', () => {
  const { base, draft } = draftFromView(viewOf(RAW, exampleTexts()))!;
  const key = (id: string) => draft.blocks.find((b) => b.block.id === id)!.key;
  // Code review as the manager's: only that field changes in the file.
  const managed = setBlock(draft, key('code-review'), { runs: 'manager' });
  const written = JSON.parse(flowText(base, managed));
  assert.deepEqual(written.blocks[3], { ...JSON.parse(RAW).blocks[3], runs: 'manager' });
  // Build renamed: Fix still continues it.
  const renamed = setBlock(draft, key('build'), { id: 'make' });
  assert.equal(parseFlow(flowText(base, renamed)).flow!.blocks.find((b) => b.id === 'fix')!.continues, 'make');
  assert.deepEqual(draftProblems(base, renamed), []);
  // Build taken out: Fix no longer says whose session, and the check asks.
  const gone = deleteBlocks(draft, [key('build')]);
  const fix = parseFlow(flowText(base, gone)).flow!.blocks.find((b) => b.id === 'fix')!;
  assert.equal(fix.runs, 'continue');
  assert.equal(fix.continues, undefined);
  assert.match(draftProblems(base, gone).map((p) => `${p.at} ${p.message}`).join('\n'), /^blocks\.fix\.continues "Fix" continues a session: say whose/m);
  // Code review continuing Build's session is the error the checks name.
  assert.match(draftProblems(base, setBlock(draft, key('code-review'), { runs: 'continue', continues: 'build' })).map((p) => p.message).join('\n'), /would run in the session that did "Build" and "Fix"/);
});

test('#322 sub-steps: added, changed, reordered and taken out; each written over what it was read as, unknown fields kept', () => {
  const raw = JSON.stringify({
    version: 1,
    blocks: [{
      id: 'build', kind: 'work', title: 'Build', runs: 'new-session',
      substeps: [
        { id: 'tests', kind: 'work', title: 'Tests', when: 'start', colour: 'red' },
        { $comment: 'kept', id: 'self-review', kind: 'check', title: 'Self-review', outcomes: [{ word: 'Findings', to: 'owner', why: 'x' }, { word: 'Findings', times: 2, to: 'report' }] },
      ],
    }],
  });
  const { base, draft } = draftFromView(viewOf(raw))!;
  assert.deepEqual(flowWrites(base, draft), [], 'read and saved unchanged: nothing written');
  const b = 'b0';
  const subsOf = (d: Draft) => JSON.parse(flowText(base, d)).blocks[0].substeps;
  // A change to one: the other, and what nobody here knows, stay as written.
  const changed = setSubstep(draft, b, 1, { outcomes: [{ word: 'Findings', to: 'owner' }, { word: 'Findings', times: 3, to: 'ask-manager' }], model: 'haiku' });
  assert.deepEqual(subsOf(changed), [
    { id: 'tests', kind: 'work', title: 'Tests', when: 'start', colour: 'red' },
    { $comment: 'kept', id: 'self-review', kind: 'check', title: 'Self-review', outcomes: [{ word: 'Findings', to: 'owner', why: 'x' }, { word: 'Findings', times: 3, to: 'ask-manager' }], model: 'haiku' },
  ]);
  // Reordered: each keeps its own unknown fields; moving past the end does nothing.
  const moved = moveSubstep(changed, b, 1, -1);
  assert.deepEqual(subsOf(moved).map((s: { id: string; colour?: string; $comment?: string }) => [s.id, s.colour ?? s.$comment]), [['self-review', 'kept'], ['tests', 'red']]);
  assert.deepEqual(subsOf(moveSubstep(moved, b, 1, 1)).map((s: { id: string }) => s.id), ['self-review', 'tests']);
  // Taken out, and a new one added: the new one in the format's order, its id from its title, unique in the block.
  const less = deleteSubstep(moved, b, 1);
  const added = addSubstep(less, b, 'check');
  assert.deepEqual(subsOf(added.draft), [
    { $comment: 'kept', id: 'self-review', kind: 'check', title: 'Self-review', outcomes: [{ word: 'Findings', to: 'owner', why: 'x' }, { word: 'Findings', times: 3, to: 'ask-manager' }], model: 'haiku' },
    { id: 'self-review-2', kind: 'check', title: 'Self-review', when: 'done' },
  ]);
  // A new one's id follows its title until set by hand; one read keeps its id.
  const titled = setSubstep(added.draft, b, 1, { title: 'Security pass' });
  assert.equal(subsOf(titled)[1].id, 'security-pass');
  assert.equal(subsOf(setSubstep(titled, b, 0, { title: 'Own review' }))[0].id, 'self-review');
  // A brief of its own; the last one taken out takes the field out.
  const briefed = newSubstepBrief(titled, b, 1, 'security') as Draft;
  assert.equal(subsOf(briefed)[1].brief, 'briefs/security.md');
  assert.deepEqual(flowWrites(base, briefed).map((w) => w.path), ['briefs/security.md', 'flow.json']);
  const empty = deleteSubstep(deleteSubstep(draft, b, 0), b, 0);
  assert.equal('substeps' in JSON.parse(flowText(base, empty)).blocks[0], false);
  // A block's own change leaves its sub-steps' keys alone, so they still match what was read.
  const retitled = setBlock(moved, b, { title: 'Build it' });
  assert.deepEqual(subsOf(retitled), subsOf(moved));
  assert.deepEqual(faults(draftProblems(base, retitled)).map((p) => p.at), ['blocks.build.substeps.self-review.outcomes.1.why', 'blocks.build.substeps.tests.colour'], 'only the unknown fields, kept');
});

test('overlays (#318): added, renamed, amending other blocks, deleted; the others and their unknown fields stay as written', () => {
  const raw = JSON.stringify({
    version: 1,
    blocks: [{ id: 'a', kind: 'work', title: 'A', outcomes: [{ word: 'Next', to: 'b' }] }, { id: 'b', kind: 'work', title: 'B', outcomes: [{ word: 'Next', to: 'c' }] }, { id: 'c', kind: 'work', title: 'C' }],
    overlays: [
      { id: 'one', title: 'One', file: 'overlays/one.md', blocks: ['a'], colour: 'red' },
      { id: 'two', title: 'Two', file: 'overlays/two.md', blocks: ['b', 'c'], $comment: 'kept' },
    ],
  });
  const texts = { 'overlays/one.md': '# One\n', 'overlays/two.md': '# Two\n' };
  const { base, draft } = draftFromView(viewOf(raw, texts))!;
  assert.deepEqual(flowWrites(base, draft), [], 'read and saved unchanged: nothing written');
  // The first taken out: the second keeps what it had, its $comment too.
  const less = deleteOverlay(draft, draft.overlays[0]!.key);
  assert.deepEqual(JSON.parse(flowText(base, less)).overlays, [JSON.parse(raw).overlays[1]]);
  // Renamed and amending another block: its unknown field stays.
  const changed = toggleAmends(setOverlay(draft, 'o0', { title: 'One, renamed' }), 'o0', 'c');
  assert.deepEqual(JSON.parse(flowText(base, changed)).overlays[0], { id: 'one', title: 'One, renamed', file: 'overlays/one.md', blocks: ['a', 'c'], colour: 'red' });
  // The last block stays: an overlay amends at least one.
  assert.equal(toggleAmends(draft, 'o0', 'a'), draft);
  // A new one, with its own new text; an empty title is refused.
  assert.match(addOverlay(draft, '  ', ['a']) as string, /needs a title/);
  assert.match(addOverlay(draft, 'X', []) as string, /at least one block/);
  const added = addOverlay(draft, 'One', ['b']);
  assert.ok(typeof added === 'object');
  assert.deepEqual(added.draft.overlays.at(-1)!.overlay, { id: 'one-2', title: 'One', file: 'overlays/one-2.md', blocks: ['b'] });
  assert.deepEqual(flowWrites(base, added.draft).map((w) => [w.path, w.base]), [['overlays/one-2.md', null], ['flow.json', textVersion(raw)]]);
  assert.deepEqual(draftProblems(base, added.draft).map((p) => p.at), ['overlays.one.colour'], 'only the unknown field, kept');
  // A block renamed or taken out is followed; the canvas's badge lists each block's overlays.
  const ren = setBlock(added.draft, 'b1', { id: 'bee' });
  assert.deepEqual(ren.overlays.map((o) => o.overlay.blocks), [['a'], ['bee', 'c'], ['bee']]);
  assert.deepEqual([...amendedBy(ren.overlays.map((o) => o.overlay))], [['a', ['One']], ['bee', ['Two', 'One']], ['c', ['Two']]]);
});

test('review of #318: a new overlay never shares a text another one uses', () => {
  const { draft } = draftFromView(viewOf(RAW, exampleTexts()))!;
  // An overlay whose title names a file another overlay uses gets its own.
  const used = addOverlay(draft, 'Check before push', ['build']);
  assert.ok(typeof used === 'object');
  assert.equal(used.draft.overlays.at(-1)!.overlay.file, 'overlays/check-before-push-2.md');
});

test('an old "lock" (#1183) is kept by the builder as any unknown field: read and saved unchanged writes nothing', () => {
  const raw = JSON.stringify({ version: 1, blocks: [{ id: 'p', kind: 'person', title: 'P', ask: 'review', lock: true }] });
  const { base, draft } = draftFromView(viewOf(raw))!;
  assert.deepEqual(flowWrites(base, draft), []);
  assert.equal(JSON.parse(flowText(base, setBlock(draft, 'b0', { title: 'Q' }))).blocks[0].lock, true);
});

test('review of #1184: a sub-step\'s outcomes keep their own unknown fields when one is taken out or added', () => {
  const raw = JSON.stringify({
    version: 1,
    blocks: [{ id: 'b', kind: 'work', title: 'B', runs: 'manager', substeps: [{ id: 's', kind: 'check', title: 'S', outcomes: [
      { $comment: 'first', word: 'Ok', to: 'done' }, { $comment: 'second', word: 'F', to: 'owner', extra: 1 }, { word: 'F', times: 3, to: 'report' },
    ] }] }],
  });
  const { base, draft } = draftFromView(viewOf(raw))!;
  const outs = (d: Draft) => JSON.parse(flowText(base, d)).blocks[0].substeps[0].outcomes;
  const read = draft.blocks[0]!.block.substeps![0]!.outcomes!;
  // The first taken out and another added, the list as long as before: nothing lends its fields to another.
  const swapped = setSubstep(draft, 'b0', 0, { outcomes: [read[1]!, read[2]!, { word: 'Blocked', to: 'ask-manager' }] });
  assert.deepEqual(outs(swapped), [{ $comment: 'second', word: 'F', to: 'owner', extra: 1 }, { word: 'F', times: 3, to: 'report' }, { word: 'Blocked', to: 'ask-manager' }]);
  // One added: the others keep theirs.
  const more = setSubstep(draft, 'b0', 0, { outcomes: [...read, { word: 'Blocked', to: 'ask-manager' }] });
  assert.deepEqual(outs(more).slice(0, 2), [{ $comment: 'first', word: 'Ok', to: 'done' }, { $comment: 'second', word: 'F', to: 'owner', extra: 1 }]);
  // One changed keeps its own fields, matched by its word.
  const changed = setSubstep(draft, 'b0', 0, { outcomes: [read[0]!, { ...read[1]!, to: 'report' }, read[2]!] });
  assert.deepEqual(outs(changed)[1], { $comment: 'second', word: 'F', to: 'report', extra: 1 });
  // The old fields are kept, and the builder says so (not "left out").
  const old = draftFromView(viewOf(JSON.stringify({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', pass: 'Ok' }], arrows: [] })))!;
  const said = draftProblems(old.base, old.draft).filter((p) => p.at === 'arrows' || p.at === 'blocks.a.pass').map((p) => p.message);
  assert.equal(said.length, 2);
  assert.ok(said.every((m) => /the builder keeps it as it is\.$/.test(m)), said.join('\n'));
});

test('part 3d: the builder keeps person, a wait, parallel and session as written, and sets them in place', () => {
  const raw = JSON.stringify({
    version: 1,
    blocks: [
      { id: 'w', kind: 'wait', title: 'CI', outcomes: [{ word: 'Green', to: 'r' }] },
      { id: 'r', kind: 'check', title: 'Review', runs: 'new-session', parallel: true, substeps: [{ id: 'a', kind: 'check', title: 'A' }, { id: 'b', kind: 'check', title: 'B' }], outcomes: [{ word: 'Ok', to: 'f' }] },
      { id: 'f', kind: 'flow', title: 'Phase', flow: 'main', session: 'caller', outcomes: [{ word: 'Signed', to: 'p' }] },
      { id: 'p', kind: 'person', title: 'Sign off', ask: 'question', person: 'the owner' },
    ],
  }, null, 2);
  const { base, draft } = draftFromView(viewOf(raw))!;
  assert.deepEqual(JSON.parse(flowText(base, draft)), JSON.parse(raw));
  const key = (id: string) => draft.blocks.find((b) => b.block.id === id)!.key;
  const changed = setBlock(setBlock(draft, key('p'), { person: 'a code owner' }), key('f'), { session: undefined });
  const written = JSON.parse(flowText(base, changed));
  assert.equal(written.blocks[3].person, 'a code owner');
  assert.equal('session' in written.blocks[2], false);
  // A new wait block is nobody's: no runs, nothing to start.
  const added = addBlock(draft, 'wait');
  const block = added.draft.blocks.find((b) => b.key === added.key)!.block;
  assert.deepEqual([block.kind, block.title, block.runs], ['wait', 'Wait', undefined]);
});
