// A selected block's arrows in a workflow diagram (issue #124), apart from the components so the tests can reach it.
import type { Edge, Node } from '@xyflow/react';
/** What of a block's data this reads and sets (BlockData's, in components/FlowDiagram.tsx, out of the core's reach). */
type BlockData = { path?: 'passed' | 'here'; litPins?: number[]; lit?: 'target' | 'dimmed' };

/**
 * A selected block's arrows lit (issue #124, Simon 2026-11-05: "if I select a node, the arrows going from it should
 * light up"): its outgoing arrows lit and drawn after the others, their pins' words marked and the blocks they lead to
 * outlined; its incoming arrows lit more faintly; every other arrow and block dimmed. A block on a chosen run's path
 * keeps its full look, so the run's path and the selection read apart. `selected`: the selected block's node id;
 * `focusPin`: one outcome in focus (the builder's panel), the only one lit as outgoing, its block's others as faint.
 * No zIndex: a lit arrow stays under the blocks it passes (review of #124); order alone puts it over the other arrows.
 */
export function lightArrows(nodes: Node[], edges: Edge[], selected: string | null, focusPin?: number): { nodes: Node[]; edges: Edge[] } {
  if (!selected || !nodes.some((n) => n.id === selected && n.type === 'block')) return { nodes, edges };
  const pinOf = (e: Edge) => {
    const m = /^o(\d+)$/.exec(e.sourceHandle ?? '');
    return m ? Number(m[1]) : null;
  };
  const from = edges.filter((e) => e.source === selected);
  const out = new Set(from.filter((e) => focusPin === undefined || pinOf(e) === focusPin).map((e) => e.id));
  const into = new Set(edges.filter((e) => (e.target === selected && e.source !== selected) || (e.source === selected && !out.has(e.id))).map((e) => e.id));
  const targets = new Set(edges.filter((e) => out.has(e.id) && e.target !== selected).map((e) => e.target));
  const sources = new Set(edges.filter((e) => into.has(e.id) && e.source !== selected).map((e) => e.source));
  const pins = edges.filter((e) => out.has(e.id)).map(pinOf).filter((p): p is number => p !== null);
  const lit = (e: Edge) => (out.has(e.id) ? 'lit-out' : into.has(e.id) ? 'lit-in' : 'flow-dimmed');
  const order = { 'flow-dimmed': 0, 'lit-in': 1, 'lit-out': 2 };
  return {
    nodes: nodes.map((n) => {
      if (n.type !== 'block') return { ...n, className: `${n.className ?? ''} flow-dimmed`.trim() };
      const data = n.data as BlockData;
      if (n.id === selected) return { ...n, data: { ...data, litPins: pins } };
      if (targets.has(n.id)) return { ...n, data: { ...data, lit: 'target' } };
      return sources.has(n.id) || data.path ? n : { ...n, data: { ...data, lit: 'dimmed' } };
    }),
    edges: edges
      .map((e) => {
        const marker = out.has(e.id) && e.markerEnd && typeof e.markerEnd === 'object' ? { markerEnd: { ...e.markerEnd, color: 'var(--accent)' } } : {};
        return { ...e, ...marker, className: `${e.className ?? ''} ${lit(e)}`.trim() };
      })
      .sort((a, b) => order[lit(a)] - order[lit(b)]),
  };
}
