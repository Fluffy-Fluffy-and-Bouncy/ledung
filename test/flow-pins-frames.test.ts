// Outcome pins and comment frames (issue #446, docs/steps/workflow-builder.md): a pin named before it leads anywhere,
// a pin drawn to a block, frames in flow.json read, checked and written back as they were, and moved with their blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkFlow, parseFlow } from '../src/shared/flow-check.ts';
import { textVersion } from '../src/sessions/flow-files.ts';
import { drawnArrows, type FlowView } from '../src/shared/flow.ts';
import { addFrame, addOutcome, arrange, boxRound, connect, deleteBlocks, deleteFrame, draftFromView, draftProblems, flowText, flowWrites, FRAME_PAD, FRAME_TITLE, frameMembers, framesInside, moveBlock, moveFrame, setBlock, setFrame, setOutcome, wireOutcome, type Draft } from '../web/src/flowEdit.ts';
import { frameOf, layoutFlow, pinnedRoute, roundedPath } from '../web/src/flowLayout.ts';

const RAW = fs.readFileSync(path.resolve('test/fixtures/flow-ledung/.ledung/workflow/flow.json'), 'utf8');

function viewOf(raw: string): FlowView {
  return {
    project: 'p', source: { kind: 'project', folder: '/x/.ledung/workflow' }, expected: '.ledung/workflow/flow.json',
    flow: parseFlow(raw).flow, rules: null, texts: {}, problems: [], raw, versions: { 'flow.json': textVersion(raw) }, saveTo: '/p/.ledung/workflow', flows: [],
  };
}

const small = (extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  blocks: [
    { id: 'a', kind: 'work', title: 'A', outcomes: [{ word: 'Done', to: 'b' }], at: { x: 0, y: 0 } },
    { id: 'b', kind: 'check', title: 'B', outcomes: [{ word: 'Accepted', to: 'c' }, { word: 'Failed', to: 'a' }, { word: 'Failed', times: 3, to: 'c' }], at: { x: 0, y: 200 } },
    { id: 'c', kind: 'work', title: 'C', at: { x: 400, y: 400 } },
  ],
  ...extra,
});
const exists = () => true;
const keyOf = (d: Draft, id: string) => d.blocks.find((b) => b.block.id === id)!.key;

// --- Frames in the format -----------------------------------------------------------------------------------------

test('frames are optional: none reads as an empty list and is not written', () => {
  const parsed = parseFlow(small());
  assert.deepEqual(parsed.flow!.frames, []);
  const { base, draft } = draftFromView(viewOf(small()))!;
  assert.equal('frames' in JSON.parse(flowText(base, draft)), false);
});

test('a frame reads with its title, name colour, place and size; a wrong colour, size or field is said', () => {
  const ok = parseFlow(small({ frames: [{ id: 'planning', title: 'Planning', colour: 'blue', at: { x: -20, y: -40 }, size: { width: 300, height: 200 } }] }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.flow!.frames, [{ id: 'planning', title: 'Planning', colour: 'blue', at: { x: -20, y: -40 }, size: { width: 300, height: 200 } }]);
  const bad = parseFlow(small({ frames: [{ id: 'x', title: 'X', colour: 'mauve', at: { x: 0, y: 0 }, size: { width: 10, height: 200 } }] }));
  assert.equal(bad.flow, null);
  assert.deepEqual(bad.problems.map((p) => p.at).sort(), ['frames.x.colour', 'frames.x.size.width']);
  assert.match(bad.problems.find((p) => p.at === 'frames.x.colour')!.message, /name colours: red, orange/);
  const unknown = parseFlow(small({ frames: [{ id: 'x', title: 'X', at: { x: 0, y: 0, z: 1 }, size: { width: 100, height: 100 }, locked: true }] }));
  assert.ok(unknown.flow);
  assert.deepEqual(unknown.problems.map((p) => p.at).sort(), ['frames.x.at.z', 'frames.x.locked']);
});

test("frames don't change what the checks say about the flow; two with one id, or a title tied to one computer, are said", () => {
  const plain = parseFlow(small()).flow!;
  const framed = parseFlow(small({ frames: [{ id: 'f', title: 'All of it', at: { x: -50, y: -50 }, size: { width: 900, height: 900 } }] })).flow!;
  assert.deepEqual(checkFlow(framed, exists), checkFlow(plain, exists));
  const twice = parseFlow(small({ frames: [
    { id: 'f', title: 'One', at: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
    { id: 'f', title: 'C:\\Users\\someone\\plan', at: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
  ] })).flow!;
  assert.deepEqual(checkFlow(twice, exists).filter((p) => p.at.startsWith('frames')).map((p) => p.at), ['frames.f', 'frames.f.title']);
});

test('frames are written back as they were read: unknown fields and $comment stay; a change writes only itself', () => {
  const raw = small({ frames: [
    { $comment: 'the plan part', id: 'planning', title: 'Planning', colour: 'blue', at: { x: -20, y: -40 }, size: { width: 300, height: 200 }, shade: 2 },
    { id: 'building', title: 'Building', at: { x: 300, y: 300 }, size: { width: 300, height: 300 } },
  ] });
  const { base, draft } = draftFromView(viewOf(raw))!;
  assert.deepEqual(JSON.parse(flowText(base, draft)), JSON.parse(raw));
  assert.deepEqual(flowWrites(base, draft), []);
  const changed = setFrame(draft, 'f0', { title: 'Plans', colour: undefined });
  const written = JSON.parse(flowText(base, changed));
  assert.deepEqual(written.frames[0], { $comment: 'the plan part', id: 'planning', title: 'Plans', at: { x: -20, y: -40 }, size: { width: 300, height: 200 }, shade: 2 });
  assert.deepEqual(written.frames[1], JSON.parse(raw).frames[1]);
  // Taking the first out keeps the second's own fields; the last taken out leaves an empty list, as it was read with one.
  const one = JSON.parse(flowText(base, deleteFrame(draft, 'f0')));
  assert.deepEqual(one.frames, [JSON.parse(raw).frames[1]]);
  assert.deepEqual(JSON.parse(flowText(base, deleteFrame(deleteFrame(draft, 'f0'), 'f1'))).frames, []);
  // Ledung's own example has two, and reads and writes back with them.
  const example = draftFromView(viewOf(RAW))!;
  assert.deepEqual(example.draft.frames.map((f) => f.frame.title), ['Planning', 'Building']);
  assert.deepEqual(flowWrites(example.base, example.draft), []);
});

// --- Frames in the builder ----------------------------------------------------------------------------------------

test('a frame added round blocks fits them with room for its title; it holds those whose middle is inside it', () => {
  const { draft } = draftFromView(viewOf(small()))!;
  const made = addFrame(draft, 'Top', { blocks: [keyOf(draft, 'a'), keyOf(draft, 'b')] });
  assert.ok(typeof made === 'object');
  const f = made.draft.frames[0]!.frame;
  assert.deepEqual(f.at, { x: -FRAME_PAD, y: -FRAME_PAD - FRAME_TITLE });
  assert.equal(f.id, 'top');
  assert.deepEqual(frameMembers(made.draft, f), [keyOf(draft, 'a'), keyOf(draft, 'b')]);
  assert.equal(addFrame(draft, '  ', { blocks: [] }), 'A frame needs a title.');
  // Placed where it is dropped, in a size to start from; a second with the same title gets an id of its own.
  const dropped = addFrame(made.draft, 'Top', { at: { x: 1000.6, y: 50 } });
  assert.ok(typeof dropped === 'object');
  assert.deepEqual(dropped.draft.frames[1]!.frame, { id: 'top-2', title: 'Top', at: { x: 1001, y: 50 }, size: { width: 420, height: 260 } });
  assert.deepEqual(frameMembers(dropped.draft, dropped.draft.frames[1]!.frame), []);
});

test('moving a frame moves the blocks it held when the move began, by as much, and no others', () => {
  const { draft } = draftFromView(viewOf(small()))!;
  const made = addFrame(draft, 'Top', { blocks: [keyOf(draft, 'a')] }) as { draft: Draft; key: string };
  const members = { blocks: frameMembers(made.draft, made.draft.frames[0]!.frame), frames: framesInside(made.draft, made.key) };
  const was = made.draft.frames[0]!.frame.at;
  const moved = moveFrame(made.draft, made.key, { x: was.x + 500, y: was.y + 10 }, members);
  const at = (id: string) => moved.blocks.find((b) => b.block.id === id)!.block.at;
  assert.deepEqual(at('a'), { x: 500, y: 10 });
  assert.deepEqual(at('b'), { x: 0, y: 200 }, 'not in it');
  assert.deepEqual(moved.frames[0]!.frame.at, { x: was.x + 500, y: was.y + 10 });
  assert.equal(moveFrame(moved, made.key, moved.frames[0]!.frame.at, members), moved, 'not moved: no change');
  // A block dragged out of it is no longer held; resizing it round more takes them in.
  const out = moveBlock(moved, keyOf(moved, 'a'), { x: 2000, y: 2000 });
  assert.deepEqual(frameMembers(out, out.frames[0]!.frame), []);
  const wide = setFrame(out, made.key, { at: { x: -100, y: -100 }, size: { width: 3000, height: 3000 } });
  assert.equal(frameMembers(wide, wide.frames[0]!.frame).length, 3);
  assert.deepEqual(setFrame(wide, made.key, { size: { width: 3, height: 3 } }).frames[0]!.frame.size, { width: 40, height: 40 }, 'at least 40 across');
});

test('review of #446: a frame inside another moves with it, its blocks staying inside it', () => {
  const { draft } = draftFromView(viewOf(small()))!;
  const inner = addFrame(draft, 'Build', { blocks: [keyOf(draft, 'a')] }) as { draft: Draft; key: string };
  const outer = addFrame(inner.draft, 'Phase 1', { blocks: [keyOf(draft, 'a'), keyOf(draft, 'b')] }) as { draft: Draft; key: string };
  assert.deepEqual(framesInside(outer.draft, outer.key), [inner.key]);
  assert.deepEqual(framesInside(outer.draft, inner.key), [], 'not the other way round');
  const held = { blocks: frameMembers(outer.draft, outer.draft.frames[1]!.frame), frames: framesInside(outer.draft, outer.key) };
  const at = outer.draft.frames[1]!.frame.at;
  const moved = moveFrame(outer.draft, outer.key, { x: at.x + 300, y: at.y }, held);
  const innerNow = moved.frames.find((f) => f.key === inner.key)!.frame;
  assert.equal(innerNow.at.x, inner.draft.frames[0]!.frame.at.x + 300);
  assert.deepEqual(frameMembers(moved, innerNow), [keyOf(draft, 'a')], 'its block still inside it');
});

test('auto-arrange fits each frame round the blocks it held, wherever they went', () => {
  const { draft } = draftFromView(viewOf(small()))!;
  const made = addFrame(draft, 'Top', { blocks: [keyOf(draft, 'a'), keyOf(draft, 'b')] }) as { draft: Draft; key: string };
  const empty = addFrame(made.draft, 'Empty', { at: { x: 3000, y: 3000 } }) as { draft: Draft; key: string };
  const arranged = arrange(empty.draft);
  assert.deepEqual(arranged.frames[0]!.frame, { ...made.draft.frames[0]!.frame, ...boxRound(arranged, [keyOf(draft, 'a'), keyOf(draft, 'b')])! });
  assert.deepEqual(frameMembers(arranged, arranged.frames[0]!.frame).sort(), [keyOf(draft, 'a'), keyOf(draft, 'b')].sort());
  assert.deepEqual(arranged.frames[1]!.frame, empty.draft.frames[1]!.frame, 'one that held none stays');
});

test("the narrow list heads a frame's blocks with its title: Ledung's own example, Planning and Building", () => {
  const flow = parseFlow(RAW).flow!;
  const frames = frameOf(layoutFlow(flow).blocks, flow.frames);
  assert.deepEqual(Object.fromEntries([...frames].map(([id, f]) => [id, f.title])), { issue: 'Planning', build: 'Building', fix: 'Building', 'code-review': 'Building' });
});

// --- Pins ---------------------------------------------------------------------------------------------------------

test('a pin named with "+ outcome" leads nowhere yet: it reads, is said as a problem, draws no arrow, and is saved as written', () => {
  const { base, draft } = draftFromView(viewOf(small()))!;
  const b = keyOf(draft, 'b');
  const named = addOutcome(draft, b, undefined, 'Blocked');
  assert.equal(named.index, 3);
  assert.deepEqual(named.draft.blocks.find((x) => x.key === b)!.block.outcomes![3], { word: 'Blocked' });
  const text = flowText(base, named.draft);
  assert.deepEqual(JSON.parse(text).blocks[1].outcomes[3], { word: 'Blocked' });
  const flow = parseFlow(text).flow!;
  assert.ok(flow, 'still a flow, so it can be saved as a draft');
  assert.deepEqual(drawnArrows(flow).filter((a) => a.from === 'b').map((a) => a.index), [0, 1, 2]);
  const said = draftProblems(base, named.draft).filter((p) => p.at === 'blocks.b.outcomes.4');
  assert.equal(said.length, 1);
  assert.equal(said[0]!.hint, undefined, 'a problem, not a hint');
  assert.match(said[0]!.message, /"Blocked" of "B" leads nowhere yet: drag its pin/);
  // Renaming or taking out a block leaves it as it is.
  const renamed = setBlock(named.draft, keyOf(named.draft, 'c'), { id: 'see' });
  assert.deepEqual(renamed.blocks.find((x) => x.key === b)!.block.outcomes![3], { word: 'Blocked' });
  const gone = deleteBlocks(named.draft, [keyOf(named.draft, 'c')]);
  assert.deepEqual(gone.blocks.find((x) => x.key === b)!.block.outcomes, [{ word: 'Failed', to: 'a' }, { word: 'Blocked' }]);
});

test('a pin drawn to a block sets where its outcome leads, the first time or again; the rest stays', () => {
  const { base, draft } = draftFromView(viewOf(small()))!;
  const b = keyOf(draft, 'b');
  const named = addOutcome(draft, b, undefined, 'Blocked');
  const wired = wireOutcome(named.draft, b, named.index, 'a');
  assert.deepEqual(wired.blocks.find((x) => x.key === b)!.block.outcomes![3], { word: 'Blocked', to: 'a' });
  assert.deepEqual(draftProblems(base, wired).filter((p) => p.at.startsWith('blocks.b.outcomes.4')), []);
  // Drawn again to another block: it leads there instead; to the same block, nothing changes.
  const again = wireOutcome(wired, b, 2, 'a');
  assert.deepEqual(again.blocks.find((x) => x.key === b)!.block.outcomes!.map((o) => [o.word, o.times, o.to]), [['Accepted', undefined, 'c'], ['Failed', undefined, 'a'], ['Failed', 3, 'a'], ['Blocked', undefined, 'a']]);
  assert.equal(wireOutcome(again, b, 2, 'a'), again);
  assert.equal(wireOutcome(again, b, 9, 'a'), again, 'no such pin');
  // Written over what was read: only that outcome's way changes.
  const written = JSON.parse(flowText(base, wireOutcome(draft, b, 0, 'a')));
  assert.deepEqual(written.blocks[1].outcomes, [{ word: 'Accepted', to: 'a' }, { word: 'Failed', to: 'a' }, { word: 'Failed', times: 3, to: 'c' }]);
  // Picked in the panel instead, and taken back to nowhere.
  const unpicked = setOutcome(wired, b, 3, { to: undefined });
  assert.deepEqual(unpicked.blocks.find((x) => x.key === b)!.block.outcomes![3], { word: 'Blocked' });
});

test('each outcome has a route round the blocks to the one it leads to, joined to its pin by a step out to the right', () => {
  const layout = layoutFlow(parseFlow(RAW).flow!);
  const box = (id: string) => layout.blocks.find((b) => b.block.id === id)!;
  const near = (p: { x: number; y: number }, id: string) => {
    const b = box(id);
    return p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1;
  };
  for (const a of layout.arrows.filter((x) => x.kind !== 'continue')) {
    assert.ok(a.route, a.id);
    assert.ok(near(a.route[0]!, a.from) && near(a.route.at(-1)!, a.to), a.id);
  }
  // A block placed by hand leaves its arrows to the page, as step paths from their pins.
  const placed = layoutFlow({ ...parseFlow(RAW).flow!, blocks: parseFlow(RAW).flow!.blocks.map((b) => (b.id === 'fix' ? { ...b, at: { x: 0, y: 0 } } : b)) });
  assert.equal(placed.arrows.filter((a) => a.route === null && a.kind !== 'continue').length, placed.arrows.filter((a) => a.kind !== 'continue' && (a.from === 'fix' || a.to === 'fix')).length);
  // Down: out of the pin, along the block's side to the gap below it, across to the route, on to the next block.
  assert.deepEqual(pinnedRoute({ x: 210, y: 90 }, 16, [{ x: 105, y: 100 }, { x: 105, y: 160 }]), [{ x: 210, y: 90 }, { x: 226, y: 90 }, { x: 226, y: 130 }, { x: 105, y: 130 }, { x: 105, y: 160 }]);
  // Back up: to the gap above it.
  assert.deepEqual(pinnedRoute({ x: 210, y: 90 }, 26, [{ x: 105, y: 0 }, { x: 300, y: -60 }, { x: 300, y: -200 }]).slice(1, 4), [{ x: 236, y: 90 }, { x: 236, y: -30 }, { x: 300, y: -30 }]);
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }], 10), 'M 0 0 L 0 90 Q 0 100 10 100 L 50 100');
});

test("the block's bottom dot still adds an outcome and asks for its word", () => {
  const { draft } = draftFromView(viewOf(small()))!;
  const made = connect(draft, 'a', 'c')!;
  assert.deepEqual(made.draft.blocks.find((x) => x.key === made.key)!.block.outcomes![made.index], { word: '', to: 'c' });
});
