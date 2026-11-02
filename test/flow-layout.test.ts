// The workflow page's diagram and list (issue #310): where blocks go and what arrows say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFlow } from '../src/shared/flow-check.ts';
import { actorLine, arrowsFrom, arrowText, BLOCK_HEIGHT, BLOCK_WIDTH, blockSize, frameOf, layoutFlow, OPENING_MIN_ZOOM, openingView, outcomeHandles, PIN_ROW, readingOrder, substepText, SUBSTEP_BLOCK_WIDTH } from '../web/src/flowLayout.ts';

const example = parseFlow(fs.readFileSync(path.resolve('test/fixtures/flow-ledung/.ledung/workflow/flow.json'), 'utf8')).flow!;

test("Ledung's own process is laid out top to bottom along the way on; a 'no' that comes back doesn't pull its target down", () => {
  const layout = layoutFlow(example);
  const y = (id: string) => layout.blocks.find((b) => b.block.id === id)!.y;
  assert.ok(y('issue') < y('build') && y('build') < y('code-review') && y('code-review') < y('functional-review') && y('functional-review') < y('merge'));
  assert.ok(y('fix') < y('code-review'), 'Fix leads into Code review, so it sits above it, beside Build');
  assert.deepEqual(readingOrder(layout).map((b) => b.block.id), ['issue', 'asset', 'build', 'fix', 'code-review', 'decide', 'functional-review', 'merge']);
});

test('a block with a canvas position keeps it (part 2 stores the layout there)', () => {
  const flow = { ...example, blocks: example.blocks.map((b) => (b.id === 'merge' ? { ...b, at: { x: 999, y: -5 } } : b)) };
  const merge = layoutFlow(flow).blocks.find((b) => b.block.id === 'merge')!;
  assert.deepEqual([merge.x, merge.y], [999, -5]);
});

test('arrows say their outcome, the count as part of its name (#1184); the list says where each goes', () => {
  assert.equal(arrowText({ word: 'Failed', times: 3 }), 'Failed (3rd time)');
  assert.equal(arrowText({ word: 'Failed', times: 1 }), 'Failed (1st time)');
  assert.equal(arrowText({ word: 'Failed', times: 12 }), 'Failed (12th time)');
  assert.equal(arrowText({ word: 'Failed', times: 22 }), 'Failed (22nd time)');
  assert.equal(arrowText({ word: 'Approved' }), 'Approved');
  const layout = layoutFlow(example);
  assert.deepEqual(arrowsFrom(layout, 'code-review'), ['Approved → Functional review', 'Changes requested → Fix', 'Changes requested (3rd time) → Person decides']);
  assert.deepEqual(layout.arrows.filter((a) => a.from === 'code-review').map((a) => a.kind), ['way', 'back', 'counted']);
  assert.deepEqual(arrowsFrom(layout, 'functional-review'), ['Accepted → Merge + release', 'Changes needed → Fix']);
  assert.equal(actorLine(example.blocks.find((b) => b.id === 'code-review')!), 'new session · opus');
  assert.equal(actorLine(example.blocks.find((b) => b.id === 'fix')!, (id) => (id === 'build' ? 'Build' : id)), 'continues Build', 'the block whose session it is, by its title (#322)');
  assert.equal(actorLine(example.blocks.find((b) => b.id === 'issue')!), 'manager');
  assert.equal(actorLine(example.blocks.find((b) => b.id === 'functional-review')!), 'person · asks for a review');
  assert.equal(actorLine({ id: 't', kind: 'timer', title: 'T', timer: { every: 30, of: 'merges' } }), 'every 30 merges');
});

test('arrows to blocks that are not there are left out of the drawing; the checks report them', () => {
  const layout = layoutFlow({ ...example, blocks: example.blocks.map((b) => (b.id === 'merge' ? { ...b, outcomes: [{ word: 'Lost', to: 'ghost' }] } : b)) });
  assert.equal(layout.arrows.some((a) => a.to === 'ghost'), false);
});

test('#446 every outcome is an arrow from its own pin, its place in the block\'s outcomes; a pin not drawn yet has none', () => {
  const layout = layoutFlow(example);
  // A continued session's arrow (#322) is no way the work goes: it says so in words, and has no pin.
  assert.deepEqual(layout.arrows.filter((a) => a.kind === 'continue').map((a) => [a.from, a.to, a.text, a.index]), [['build', 'fix', 'same session', undefined]]);
  for (const b of example.blocks) {
    assert.deepEqual(layout.arrows.filter((a) => a.from === b.id && a.kind !== 'continue').map((a) => [a.index, a.text, a.to]), (b.outcomes ?? []).flatMap((o, j) => (o.end ? [] : [[j, arrowText(o), o.to]])), b.id);
  }
  // One that ends the flow (#447) has no arrow, and the list says it all the same.
  assert.deepEqual(arrowsFrom(layout, 'asset'), ['Ready → Build', 'Rejected → ends the flow']);
  // Named on its pin, not drawn to a block: no arrow, and the others keep their places (pins).
  const loose = layoutFlow({ ...example, blocks: example.blocks.map((b) => (b.id === 'code-review' ? { ...b, outcomes: [b.outcomes![0]!, { word: 'Blocked' }, b.outcomes![1]!] } : b)) });
  assert.deepEqual(loose.arrows.filter((a) => a.from === 'code-review').map((a) => a.index), [0, 2]);
});

test('#446 a block is drawn a pin row taller for each outcome, so the next block is below all of them', () => {
  const plain = { id: 'a', kind: 'work' as const, title: 'A' };
  assert.deepEqual(blockSize(plain), { width: BLOCK_WIDTH, height: BLOCK_HEIGHT });
  const three = { ...plain, outcomes: [{ word: 'Accepted', to: 'b' }, { word: 'Failed', to: 'c' }, { word: 'Failed', times: 3, to: 'd' }] };
  assert.equal(blockSize(three).height, blockSize(plain).height + 4 + 3 * PIN_ROW);
  const layout = layoutFlow(example);
  const at = (id: string) => layout.blocks.find((b) => b.block.id === id)!;
  assert.equal(at('code-review').height, BLOCK_HEIGHT + 4 + 3 * PIN_ROW);
  assert.ok(at('code-review').y + at('code-review').height < at('functional-review').y);
});

test('a block id used twice is drawn once (the checks report it)', () => {
  const layout = layoutFlow({ ...example, blocks: [...example.blocks, { id: 'fix', kind: 'work', title: 'Fix twice' }] });
  assert.equal(layout.blocks.filter((b) => b.block.id === 'fix').length, 1);
  assert.equal(layout.blocks.find((b) => b.block.id === 'fix')!.block.title, 'Fix');
});

test('a small flow opens fitted; a large one at a readable zoom, its start block across the middle near the top (#318)', () => {
  const small = layoutFlow(parseFlow(fs.readFileSync(path.resolve('test/fixtures/flow-ledung/.ledung/workflow/flow.json'), 'utf8')).flow!);
  // Its pins (#446) make its blocks taller: fitted in a tall canvas, from its start at the readable zoom in a lower one.
  assert.deepEqual(openingView(small.blocks, small.blocks[0], 640, 1000), { fit: true }, 'the workflow page at 1280 px, a tall window');
  assert.equal(openingView(small.blocks, small.blocks[0], 640, 760).fit, false);
  // 30 blocks one after another: fitted, a block would be a few pixels high.
  const blocks = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: i * 140 }));
  const view = openingView(blocks, blocks[0], 900, 700);
  assert.equal(view.fit, false);
  if (view.fit) return;
  assert.equal(view.zoom, OPENING_MIN_ZOOM);
  assert.equal(view.x + (BLOCK_WIDTH / 2) * view.zoom, 450, 'the start block in the middle across');
  assert.equal(view.y, 32, 'and near the top');
  // Another start block is the one shown.
  const later = openingView(blocks, blocks[10], 900, 700);
  assert.ok(!later.fit && later.y === 32 - 1400 * OPENING_MIN_ZOOM);
  assert.deepEqual(openingView([], undefined, 900, 700), { fit: true });
  assert.deepEqual(openingView(blocks, blocks[0], 0, 0), { fit: true }, 'a box not laid out yet: as before');
});

test('opening a flow too long to fit but narrow enough: centred across; the builder\'s lower least zoom fits more (#318)', () => {
  const blocks = Array.from({ length: 30 }, (_, i) => ({ x: (i % 3) * 240, y: Math.floor(i / 3) * 140 }));
  const view = openingView(blocks, blocks[0], 900, 700);
  assert.ok(!view.fit);
  const w = (480 + BLOCK_WIDTH) * view.zoom;
  assert.equal(Math.round(view.x * 100), Math.round(((900 - w) / 2) * 100), 'the whole width centred');
  const small = layoutFlow(example);
  assert.equal(openingView(small.blocks, small.blocks[0], 455, 760).fit, false, 'the page\'s least zoom');
  assert.deepEqual(openingView(small.blocks, small.blocks[0], 455, 760, { padding: 0.2, minZoom: 0.5 }), { fit: true }, 'the builder\'s canvas still fits it');
});

test('review of #318: a flow just narrower than the box, but not with a margin, opens on its start block, not centred', () => {
  // 900 units wide at 0.7 is 630 px: within a 640 px box, but not with the 15% margin fitting keeps.
  const blocks = Array.from({ length: 30 }, (_, i) => ({ x: (i % 2) * (900 - BLOCK_WIDTH), y: Math.floor(i / 2) * 140 }));
  const view = openingView(blocks, blocks[0], 640, 700);
  assert.ok(!view.fit);
  assert.equal(view.x, 320 - (BLOCK_WIDTH / 2) * view.zoom, 'the start block in the middle');
});

test('#322 sub-steps are rows inside their block: "↳ when done: Self-review", "subagent · sonnet · reviewer.md", its outcomes, a check marked', () => {
  const build = example.blocks.find((b) => b.id === 'build')!;
  assert.deepEqual(substepText(build, build.substeps![0]!), {
    head: '↳ when done: Self-review',
    detail: 'subagent · sonnet · reviewer.md',
    outcomes: 'No findings → done · Findings → ✗ builder fixes · Findings (3rd time) → report',
    note: 'the author reads this',
  });
  // A piece of work is no check of the block's: not marked. With no brief its one is said by who runs the block.
  const manager = { id: 'm', kind: 'work' as const, title: 'M', runs: 'manager' as const };
  assert.deepEqual(substepText(manager, { id: 's', kind: 'work', title: 'Sweep', when: 'start', outcomes: [{ word: 'Stale', to: 'owner' }, { word: 'Stale', times: 2, to: 'ask-manager' }] }), {
    head: '↳ at the start: Sweep', detail: 'subagent', outcomes: 'Stale → ✗ the manager fixes · Stale (2nd time) → ask the manager', note: null,
  });
  assert.equal(substepText(manager, { id: 's', kind: 'work', title: 'Sweep' }).outcomes, null);
  // A block with sub-steps is drawn wider and taller, and laid out so: the next block is below all of it.
  const size = blockSize(build);
  assert.equal(size.width, SUBSTEP_BLOCK_WIDTH);
  assert.ok(size.height > BLOCK_HEIGHT + 40, `room for the row: ${size.height}`);
  assert.deepEqual(blockSize(example.blocks.find((b) => b.id === 'fix')!), { width: BLOCK_WIDTH, height: BLOCK_HEIGHT + 4 + PIN_ROW }, 'its one pin (#446)');
  const layout = layoutFlow(example);
  const at = (id: string) => layout.blocks.find((b) => b.block.id === id)!;
  assert.equal(at('build').height, size.height);
  assert.ok(at('build').y + at('build').height < at('code-review').y, 'Code review below the whole of Build');
  // The opening view counts a block's own size.
  const wide = openingView([{ x: 0, y: 0, width: 2000, height: 78 }], { x: 0, y: 0, width: 2000 }, 900, 700);
  assert.equal(wide.fit, false);
});

test('#446 the pins\' arrows: each from its own pin, into the top or, going back, the side; the top pin\'s steps out furthest', () => {
  assert.deepEqual(outcomeHandles('way', 0, 3), ['o0', 't', 36]);
  assert.deepEqual(outcomeHandles('back', 1, 3), ['o1', 'rt', 26]);
  assert.deepEqual(outcomeHandles('counted', 2, 3), ['o2', 't', 16]);
});

test('arrow words never lie on each other: a check with Accepted → next, Failed → back, Failed (3rd time) → a person who sends it back (#1184, from the preview)', async () => {
  const { handlePoint, labelSpots, labelWidth } = await import('../web/src/flowLayout.ts');
  const flow = parseFlow(JSON.stringify({
    version: 1,
    blocks: [
      { id: 'planner', kind: 'work', title: 'Planner', outcomes: [{ word: 'Done', to: 'plan-reviewer' }] },
      { id: 'plan-reviewer', kind: 'check', title: 'Plan reviewer', outcomes: [{ word: 'Accepted', to: 'build' }, { word: 'Failed', to: 'planner' }, { word: 'Failed', times: 3, to: 'person' }] },
      { id: 'person', kind: 'person', title: 'Person solves the plan issue', ask: 'question', outcomes: [{ word: 'Solved', to: 'planner' }] },
      { id: 'build', kind: 'work', title: 'Build' },
    ],
  })).flow!;
  const overlapping = (spots: Map<string, { x: number; y: number }>, texts: Map<string, string>) => {
    const list = [...spots].map(([id, p]) => ({ id, ...p, w: labelWidth(texts.get(id)!), h: 18 }));
    return list.flatMap((a, i) => list.slice(i + 1).filter((b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2).map((b) => `${a.id} on ${b.id}`));
  };
  // Since pins (#446) the words are on the blocks and only a continued session's float; here every arrow is given
  // its words, from its pin as the page draws it, to show the placing still holds with pins.
  const run = (f: typeof flow) => {
    const layout = layoutFlow(f);
    const boxes = new Map(layout.blocks.map((p) => [p.block.id, { x: p.x, y: p.y, width: p.width, height: p.height }]));
    const pins = (id: string) => layout.blocks.find((p) => p.block.id === id)!.block.outcomes?.length ?? 0;
    const labels = layout.arrows.map((a) => {
      const [sourceHandle, targetHandle] = a.kind === 'continue' ? ['rs', 'lt'] : outcomeHandles(a.kind, a.index!, pins(a.from));
      return { id: a.id, source: a.from, target: a.to, sourceHandle, targetHandle, text: a.text, pins: pins(a.from) };
    });
    const texts = new Map(labels.map((l) => [l.id, l.text!]));
    // Where each would go alone: midway between its handles.
    const alone = new Map(labels.map((l) => {
      const a = handlePoint(boxes.get(l.source)!, l.sourceHandle, l.pins);
      const b = handlePoint(boxes.get(l.target)!, l.targetHandle);
      return [l.id, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
    }));
    const spots = labelSpots(boxes, labels);
    // Clear of every block, its pin rows included (blockSize counts them).
    const onBlocks = [...spots].flatMap(([id, p]) => [...boxes].filter(([, b]) => {
      const w = labelWidth(texts.get(id)!);
      return !(p.x + w / 2 <= b.x || p.x - w / 2 >= b.x + b.width || p.y - 9 >= b.y + b.height || p.y + 9 <= b.y);
    }).map(([bid]) => `${id} on ${bid}`));
    return { before: overlapping(alone, texts), after: overlapping(spots, texts), onBlocks, texts };
  };
  // Laid out by the page: no words on each other or on a block.
  assert.deepEqual(run(flow).after, []);
  assert.deepEqual(run(flow).onBlocks, []);
  // Placed by hand side by side (as a saved flow is): placed, they don't clash either.
  const byHand = { ...flow, blocks: flow.blocks.map((b, i) => ({ ...b, at: { x: [0, 0, 280, 0][i]!, y: [0, 180, 180, 360][i]! } })) };
  const placed = run(byHand);
  assert.deepEqual(placed.after, []);
  assert.deepEqual(placed.onBlocks, []);
  assert.deepEqual([...placed.texts.values()].sort(), ['Accepted', 'Done', 'Failed', 'Failed (3rd time)', 'Solved']);
});

test('#446 a pin\'s dot is on the block\'s right edge, in its own row at the foot, in order', async () => {
  const { handlePoint } = await import('../web/src/flowLayout.ts');
  const box = { x: 100, y: 50, width: 210, height: BLOCK_HEIGHT + 4 + 3 * PIN_ROW };
  const ys = [0, 1, 2].map((j) => handlePoint(box, `o${j}`, 3));
  assert.ok(ys.every((p) => p.x === 310));
  assert.ok(ys[0]!.y < ys[1]!.y && ys[1]!.y < ys[2]!.y);
  assert.equal(ys[1]!.y - ys[0]!.y, PIN_ROW);
  assert.ok(ys[0]!.y > box.y + BLOCK_HEIGHT - 6 && ys[2]!.y < box.y + box.height, 'below the block\'s own words, inside it');
});

test('arrow words keep off the blocks too: words that would hide under a block go below it', async () => {
  const { labelSpots, labelWidth } = await import('../web/src/flowLayout.ts');
  const boxes = new Map([['a', { x: 0, y: 0, width: 210, height: 78 }], ['b', { x: 270, y: 0, width: 210, height: 78 }]]);
  const spot = labelSpots(boxes, [{ id: 'x', source: 'a', target: 'b', sourceHandle: 'b', targetHandle: 't', text: 'Failed (3rd time)' }]).get('x')!;
  const w = labelWidth('Failed (3rd time)');
  for (const b of boxes.values()) {
    const clear = spot.x + w / 2 <= b.x || spot.x - w / 2 >= b.x + b.width || spot.y - 9 >= b.y + b.height || spot.y + 9 <= b.y;
    assert.ok(clear, `the words at ${spot.x},${spot.y} are clear of the block at ${b.x},${b.y}`);
  }
});
