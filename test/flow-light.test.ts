// Issue #124 (Simon, 2026-11-05: "if I select a node, the arrows going from it should light up"): what a selected
// block lights in a workflow diagram, and what it dims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import { lightArrows } from '../web/src/flowLight.ts';

const block = (id: string, extra: Record<string, unknown> = {}): Node => ({ id, type: 'block', position: { x: 0, y: 0 }, data: { block: { id, kind: 'work', title: id }, hasBrief: false, selected: false, ...extra } });
const arrow = (id: string, source: string, target: string, sourceHandle: string): Edge => ({ id, source, target, sourceHandle, className: 'flow-arrow', markerEnd: { type: 'arrowclosed' as never, color: 'var(--muted)' } });

// build → review; review "Approved" → merge, "Changes" → fix (a loop back), "Changes" ×3 → person; fix → review.
const nodes: Node[] = [block('build'), block('review'), block('fix'), block('merge', { path: 'here' }), block('person'), block('other'), { id: 'frame:0', type: 'frame', position: { x: 0, y: 0 }, data: {} }];
const edges: Edge[] = [
  arrow('a', 'build', 'review', 'o0'),
  arrow('b', 'review', 'merge', 'o0'),
  arrow('c', 'review', 'fix', 'o1'),
  arrow('d', 'review', 'person', 'o2'),
  arrow('e', 'fix', 'review', 'o0'),
  arrow('f', 'other', 'merge', 'o0'),
  { id: 'g', source: 'build', target: 'fix', sourceHandle: 'rs', className: 'flow-arrow arrow-continue' },
];

test('nothing selected, or a frame: the diagram as it was', () => {
  assert.deepEqual(lightArrows(nodes, edges, null), { nodes, edges });
  assert.deepEqual(lightArrows(nodes, edges, 'frame:0'), { nodes, edges });
  assert.deepEqual(lightArrows(nodes, edges, 'gone'), { nodes, edges });
});

test("a selected block's outgoing arrows lit, its incoming ones faintly, the rest dimmed", () => {
  const lit = lightArrows(nodes, edges, 'review');
  const cls = (id: string) => lit.edges.find((e) => e.id === id)!.className;
  assert.equal(cls('b'), 'flow-arrow lit-out');
  assert.equal(cls('c'), 'flow-arrow lit-out');
  assert.equal(cls('d'), 'flow-arrow lit-out');
  // Into it: from Build, and Fix's loop back.
  assert.equal(cls('a'), 'flow-arrow lit-in');
  assert.equal(cls('e'), 'flow-arrow lit-in');
  assert.equal(cls('f'), 'flow-arrow flow-dimmed');
  assert.equal(cls('g'), 'flow-arrow arrow-continue flow-dimmed');
  // Lit ones drawn after the rest (above the other arrows, still under the blocks), their heads in the accent.
  assert.deepEqual(lit.edges.map((e) => e.id), ['f', 'g', 'a', 'e', 'b', 'c', 'd']);
  assert.equal(lit.edges.find((e) => e.id === 'b')!.zIndex, undefined);
  assert.equal((lit.edges.find((e) => e.id === 'b')!.markerEnd as { color: string }).color, 'var(--accent)');
  assert.equal((lit.edges.find((e) => e.id === 'a')!.markerEnd as { color: string }).color, 'var(--muted)');
  const data = (id: string) => lit.nodes.find((n) => n.id === id)!.data as Record<string, unknown>;
  assert.deepEqual(data('review').litPins, [0, 1, 2]);
  // Where it leads, outlined (Fix too, though it also leads back); a block on a run's path keeps its look.
  assert.equal(data('fix').lit, 'target');
  assert.equal(data('person').lit, 'target');
  assert.equal(data('merge').lit, 'target');
  // Where it comes from: not dimmed. Anything else is.
  assert.equal(data('build').lit, undefined);
  assert.equal(data('other').lit, 'dimmed');
  assert.equal(lit.nodes.find((n) => n.id === 'frame:0')!.className, 'flow-dimmed');
  // The input is left as it was.
  assert.equal(edges[1]!.className, 'flow-arrow');
});

test("the builder's outcome in focus: only its arrow lit as outgoing, the block's others faint", () => {
  const lit = lightArrows(nodes, edges, 'review', 1);
  const cls = (id: string) => lit.edges.find((e) => e.id === id)!.className;
  assert.equal(cls('c'), 'flow-arrow lit-out');
  assert.equal(cls('b'), 'flow-arrow lit-in');
  assert.equal(cls('d'), 'flow-arrow lit-in');
  const data = (id: string) => lit.nodes.find((n) => n.id === id)!.data as Record<string, unknown>;
  assert.deepEqual(data('review').litPins, [1]);
  assert.equal(data('fix').lit, 'target');
  assert.equal(data('person').lit, 'dimmed');
});

test('a block on a run path that has nothing to do with the selection keeps its full look', () => {
  const lit = lightArrows(nodes, edges, 'build');
  assert.equal((lit.nodes.find((n) => n.id === 'merge')!.data as Record<string, unknown>).lit, undefined);
  assert.equal((lit.nodes.find((n) => n.id === 'other')!.data as Record<string, unknown>).lit, 'dimmed');
  assert.deepEqual((lit.nodes.find((n) => n.id === 'build')!.data as Record<string, unknown>).litPins, [0]);
});
