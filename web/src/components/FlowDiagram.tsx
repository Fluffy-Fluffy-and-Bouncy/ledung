// The workflow diagram's pieces (issues #310, #311): a block with its outcomes' pins (#446), a comment frame (#446), an
// arrow and how arrows meet blocks, shared by the workflow page (read-only) and the builder (editing).
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Handle, MiniMap, NodeResizer, Position, useInternalNode, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { DEFAULT_FLOW, FLOW_FILE, outcomeName, type FlowBlock, type FlowFrame } from '../../../src/shared/flow.ts';
import { NAME_COLOURS } from '../../../src/shared/name-colours.ts';
import { NARROW_QUERY } from '../sidebarSize.ts';
export { lightArrows } from '../flowLight.ts';
import { actorLine, blockSize, briefName, KIND_LABEL, labelSpots, openingView, pinnedRoute, roundedPath, SIDE_HANDLE_Y, substepText, type Box, type Point } from '../flowLayout.ts';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(NARROW_QUERY);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export type BlockData = {
  block: FlowBlock; hasBrief: boolean; selected: boolean; problem?: boolean; start?: boolean;
  /** The titles of the overlays that amend it (#318), for its badge. */
  overlays?: string[];
  /** Amended by the overlay being edited (#318). */
  marked?: boolean;
  /** For a block that continues a session: the title of the block whose it is (#322). */
  continuesTitle?: string;
  /** The outcome whose pin and arrow are marked (#446): the one in focus in the builder's panel. */
  focusOutcome?: number;
  /** In the builder: "+ outcome" on the block, which names a new pin in the panel (#446). */
  onAddOutcome?: () => void;
  /** For a Run flow block (#447): what it runs, in words ("runs Asset"). */
  runsFlow?: string | null;
  /** The runs at this block now (workflow part 3c): a marker each, above the block. */
  runs?: { id: string; label: string; title: string; waiting: boolean }[];
  /** Per outcome, its counted pin's progress, or null (part 3c): "2 of 3" on the pin beside its word. */
  counts?: ({ short: string; full: string } | null)[];
  /** On the chosen run's path (part 3c); `here`: where it is now. */
  path?: 'passed' | 'here';
  /** A block selected (#124): the pins whose arrows are lit, on the selected block itself. */
  litPins?: number[];
  /** A block selected (#124): one its arrows lead to, outlined; or one with nothing to do with it, dimmed. */
  lit?: 'target' | 'dimmed';
};

/** The side handles, by the title: arrows going back come in there, and a continued session leaves and comes in there. */
const SIDE: CSSProperties = { top: SIDE_HANDLE_Y };

/**
 * A block in the diagram: kind, title, who runs it, its brief's name, its sub-steps as rows (#322), and each outcome
 * as a pin, a labelled row whose dot on the right edge its arrow leaves from (#446, as Unreal Blueprints' exec pins).
 * One handle takes arrows in, the top; in the builder (#311) the bottom one is drawn to a block for a new outcome,
 * whose word the panel asks for, and a pin to a block sets where its outcome leads. Hidden handles on the sides by the
 * title take arrows going back, and a continued session's.
 */
function BlockNode({ data }: NodeProps<Node<BlockData>>) {
  const b = data.block;
  const actor = actorLine(b, () => data.continuesTitle ?? b.continues ?? '');
  const size = blockSize(b);
  const outs = b.outcomes ?? [];
  return (
    <div className={`flow-block kind-${b.kind}${data.selected ? ' selected' : ''}${data.problem ? ' has-problem' : ''}${data.marked ? ' marked' : ''}${data.path ? ` on-path ${data.path}` : ''}${data.lit ? ` lit-${data.lit}` : ''}`} style={{ width: size.width, minHeight: size.height }} title={data.hasBrief ? 'Open its brief' : 'Show this block'}>
      {!!data.runs?.length && (
        // Above the block, so a block with runs in it is laid out as one without (part 3c).
        <div className="flow-run-markers" role="group" aria-label={`${data.runs.length === 1 ? 'One run' : `${data.runs.length} runs`} here`}>
          {data.runs.slice(0, 3).map((r) => <span key={r.id} className={`flow-run-marker${r.waiting ? ' waiting' : ''}`} title={r.title}>● {r.label}</span>)}
          {data.runs.length > 3 && <span className="flow-run-marker more" title={data.runs.slice(3).map((r) => r.title).join('\n')}>+{data.runs.length - 3}</span>}
        </div>
      )}
      <Handle type="target" position={Position.Top} id="t" className="h-in" />
      <Handle type="source" position={Position.Bottom} id="b" className="h-pass" title="Drag to a block: a new outcome that leads there; its word is asked for" />
      <Handle type="target" position={Position.Right} id="rt" className="h-hidden" style={SIDE} />
      <Handle type="source" position={Position.Right} id="rs" className="h-hidden" style={SIDE} />
      <Handle type="target" position={Position.Left} id="lt" className="h-hidden" style={SIDE} />
      <Handle type="source" position={Position.Left} id="ls" className="h-hidden" style={SIDE} />
      <div className="flow-block-top">
        <span className="flow-kind">{data.start ? '▶ ' : ''}{KIND_LABEL[b.kind]}</span>
        {data.onAddOutcome && <button className="flow-add-pin nodrag" onClick={(e) => { e.stopPropagation(); data.onAddOutcome!(); }} title="Add an outcome: name it in the panel, then drag its pin to the block it leads to" aria-label={`Add an outcome to ${b.title}`}>+ outcome</button>}
      </div>
      <div className="flow-block-title">{b.title}</div>
      {actor && <div className="flow-block-actor">{actor}</div>}
      {data.runsFlow && <div className="flow-block-actor flow-block-runs">▸ {data.runsFlow}</div>}
      {!!b.substeps?.length && (
        <ol className="flow-substeps">
          {b.substeps.map((s, i) => {
            const t = substepText(b, s);
            return (
              <li key={i} className={`flow-substep kind-${s.kind}`} title={[t.head, t.detail, t.outcomes, t.note].filter(Boolean).join(' · ')}>
                <span className="flow-substep-head">{t.head}</span>
                <span className="flow-substep-detail">{t.detail}</span>
                {t.outcomes && <span className="flow-substep-detail">{t.outcomes}</span>}
                {t.note && <span className="flow-substep-note">{t.note}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {(!!b.brief || !!data.overlays?.length) && (
        <div className="flow-block-foot">
          {b.brief && <span className={`flow-block-brief${data.hasBrief ? '' : ' missing'}`}>📄 {briefName(b.brief)}.md</span>}
          {!!data.overlays?.length && <span className="flow-block-overlays" title={`Amended by ${data.overlays.join(', ')}`}>◇ {data.overlays.length === 1 ? 'overlay' : `${data.overlays.length} overlays`}</span>}
        </div>
      )}
      {outs.length > 0 && (
        <ol className="flow-pins" aria-label="Outcomes">
          {outs.map((o, j) => {
            const name = o.word.trim() ? outcomeName(o) : '(its word?)';
            // One that ends the flow (#447) has no arrow: "■ end" where its dot would be; dragging it to a block still leads it there.
            return (
              <li key={j} className={`flow-pin${o.to === undefined && !o.end ? ' loose' : ''}${o.end ? ' ends' : ''}${o.times ? ' counted' : ''}${data.counts?.[j] ? ' has-count' : ''}${data.focusOutcome === j ? ' chosen' : ''}${data.litPins?.includes(j) ? ' lit' : ''}`} title={o.end ? `${name}: ends the flow` : o.to === undefined ? `${name}: leads nowhere yet; drag its dot to a block` : name}>
                <span className="flow-pin-word">{name}</span>
                {data.counts?.[j] && <span className="flow-pin-count" title={`${data.counts[j]!.full}: how far a run has counted this outcome's word`}>{data.counts[j]!.short}</span>}
                {o.end && <span className="flow-pin-end">■ end</span>}
                <Handle type="source" position={Position.Right} id={`o${j}`} className="h-pin" />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export type FrameData = {
  frame: FlowFrame;
  /** In the builder: chosen, so its edges can be dragged to resize it. */
  selected?: boolean;
  editable?: boolean;
  onResize?: (box: { x: number; y: number; width: number; height: number }) => void;
  onResizeEnd?: (box: { x: number; y: number; width: number; height: number }) => void;
};

/** A frame's colour as `.named` takes it: the light and dark values of its name colour; none, the page's border. */
export function frameColour(frame: FlowFrame): CSSProperties | undefined {
  if (!frame.colour) return undefined;
  const c = NAME_COLOURS[frame.colour];
  return { '--name-light': c.light, '--name-dark': c.dark } as CSSProperties;
}

/**
 * A comment frame (#446): its title in a bar at the top, a faint tint of its colour behind the blocks it holds. Only
 * its bar takes the pointer (to choose it, and in the builder to drag it with its blocks), so the canvas pans and the
 * blocks are clicked through it.
 */
function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  const f = data.frame;
  return (
    <div className={`flow-frame${f.colour ? ' coloured' : ''}${data.selected ? ' selected' : ''}`} style={frameColour(f)}>
      {data.editable && (
        <NodeResizer isVisible={!!data.selected} minWidth={120} minHeight={80} color="var(--accent)"
          onResize={(_, p) => data.onResize?.(p)} onResizeEnd={(_, p) => data.onResizeEnd?.(p)} />
      )}
      <div className="flow-frame-title" title={data.editable ? 'Drag to move the frame and the blocks in it; click to change it' : f.title}>{f.title}</div>
    </div>
  );
}

export const NODE_TYPES = { block: BlockNode, frame: FrameNode };

/** An arrow: its words (a continued session's "same session"; an outcome's are on its pin, #446) and where they go. */
export type StepData = { text: string | null; labelAt?: Point; offset?: number };
/** An outcome's arrow along the route the layout gave it round the blocks, joined to its pin (#446). */
export type RouteData = { route: Point[]; offset: number };

/** An arrow's words on the canvas, centred on `at`. */
function EdgeWords({ text, at }: { text: string | null; at: Point | null | undefined }) {
  if (!text || !at) return null;
  return (
    <EdgeLabelRenderer>
      <div className="flow-edge-label" style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}>{text}</div>
    </EdgeLabelRenderer>
  );
}

/**
 * An outcome's arrow along the layout's route round the blocks, from its pin (#446): React Flow gives where the pin is
 * as the arrow's source.
 */
function RoutedEdge({ id, source, data, markerEnd, interactionWidth, sourceX, sourceY }: EdgeProps<Edge<RouteData>>) {
  // Its block as drawn: the arrow turns below it, never inside it (#447).
  const node = useInternalNode(source);
  if (!data) return null;
  const bottom = node?.measured.height !== undefined ? node.internals.positionAbsolute.y + node.measured.height : undefined;
  return <BaseEdge id={id} path={roundedPath(pinnedRoute({ x: sourceX, y: sourceY }, data.offset, data.route, bottom))} markerEnd={markerEnd} interactionWidth={interactionWidth} />;
}

/**
 * An arrow as a step path from its pin or side (#446), out by `offset` first so the arrows of one block's pins run
 * beside each other rather than on top; its words, if any, placed clear of the others.
 */
function StepEdge({ id, data, markerEnd, interactionWidth, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps<Edge<StepData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, ...(data?.offset ? { offset: data.offset } : {}) });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <EdgeWords text={data?.text ?? null} at={data?.labelAt ?? { x: labelX, y: labelY }} />
    </>
  );
}

export const EDGE_TYPES = { routed: RoutedEdge, stepped: StepEdge };

/**
 * The arrows with their words placed so none lies on another or on a block, its pins included (#1184, #446): each
 * midway along its step path, moved down clear of those already placed. `nodes` give the blocks' boxes, by their own
 * size; frames (#446) are behind everything and in nobody's way.
 */
export function withLabelSpots(nodes: readonly Node[], edges: Edge[]): Edge[] {
  const blocks = nodes.filter((n): n is Node<BlockData> => n.type === 'block');
  const boxes = new Map<string, Box>(blocks.map((n) => [n.id, { ...n.position, ...blockSize(n.data.block) }]));
  const pins = new Map(blocks.map((n) => [n.id, n.data.block.outcomes?.length ?? 0]));
  const textOf = (e: Edge) => ((e.data as StepData | undefined)?.text ?? null);
  const spots = labelSpots(boxes, edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, text: textOf(e), pins: pins.get(e.source) ?? 0,
  })));
  return edges.map((e) => (spots.has(e.id) ? { ...e, data: { ...e.data, labelAt: spots.get(e.id) } } : e));
}

/** Esc clears a diagram's selected block (#124), unless typing in a field. */
export function useEscapeClears(on: boolean, clear: (() => void) | undefined): void {
  useEffect(() => {
    if (!on || !clear) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || e.defaultPrevented || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      clear();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [on, clear]);
}

/** The arrow's colour, for its head, which React Flow draws outside the arrow's own element. */
export const ARROW_COLOUR = { way: 'var(--muted)', back: 'var(--muted)', counted: 'var(--warn-border)', continue: 'var(--accent)' } as const;

/** A continued session's arrow (#322) from the side of one block that faces the other: Build beside Fix. */
export function continueHandles(from: Point | undefined, to: Point | undefined): [string, string] {
  return from && to && to.x < from.x ? ['ls', 'rt'] : ['rs', 'lt'];
}

/**
 * Where a diagram opens (#318): measured once, when its box is first laid out, so later edits never move the view.
 * Null until then; `fit`: React Flow fits it as before, else the viewport to open at.
 */
export function useOpeningView(box: RefObject<HTMLDivElement | null>, blocks: Point[], start: Point | undefined, options?: Parameters<typeof openingView>[4]): ReturnType<typeof openingView> | null {
  const [view, setView] = useState<ReturnType<typeof openingView> | null>(null);
  useLayoutEffect(() => {
    if (view || !box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    setView(openingView(blocks, start, width, height, options));
  });
  return view;
}

/**
 * The blocks' sizes as React Flow measured them, to give back with the nodes (#318): the canvases make new node
 * objects every render, and one without `measured` is measured again and unknown to the minimap meanwhile. Kept from
 * its dimension changes; `onChanges` takes those, and passes on what it doesn't.
 */
export function useMeasured(): [Record<string, { width: number; height: number }>, (changes: NodeChange[]) => NodeChange[]] {
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const onChanges = (changes: NodeChange[]) => {
    const measured = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (measured.length) {
      setSizes((was) => (measured.every(([id, d]) => was[id]?.width === d.width && was[id]?.height === d.height) ? was : { ...was, ...Object.fromEntries(measured) }));
    }
    return changes.filter((c) => c.type !== 'dimensions');
  };
  return [sizes, onChanges];
}

/** Each kind's colour in the minimap, as the blocks' edges have them. */
const MINIMAP_COLOUR: Record<string, string> = { work: 'var(--accent)', check: 'var(--s3)', person: 'var(--dot-waiting)', timer: 'var(--s7)', fork: 'var(--s5)', join: 'var(--s5)', wait: 'var(--s7)' };

/** A large flow's map (#318), to find one's way round it; in the page's own colours, smaller on a phone. Frames (#446) as faint outlines. */
export function FlowMiniMap({ small = false }: { small?: boolean }) {
  // The mask's outline as props: React Flow scales those to the map, not a CSS width (review of #318).
  return <MiniMap className="flow-minimap" pannable zoomable maskStrokeColor="var(--accent)" maskStrokeWidth={2} {...(small ? { style: { width: 120, height: 90 } } : {})}
    nodeColor={(n) => (n.type === 'frame' ? 'transparent' : MINIMAP_COLOUR[(n.data as BlockData).block.kind] ?? 'var(--muted)')} nodeStrokeColor={(n) => (n.type === 'frame' ? 'var(--border)' : 'transparent')}
    nodeBorderRadius={4} ariaLabel="Map of the whole flow" />;
}

/** A frame as a node behind the blocks (#446): its own place and size, `live` while it is dragged or resized. */
export function frameNode(id: string, frame: FlowFrame, data: Omit<FrameData, 'frame'> = {}, live?: { x: number; y: number; width?: number; height?: number }): Node<FrameData> {
  return {
    // Behind the blocks; chosen in the builder, above them with its tint cleared, so a block lying on its edge never
    // hides the handles that resize it.
    id, type: 'frame', zIndex: data.selected ? 1000 : -1, dragHandle: '.flow-frame-title', draggable: !!data.editable, connectable: false,
    position: live ? { x: live.x, y: live.y } : frame.at,
    width: live?.width ?? frame.size.width, height: live?.height ?? frame.size.height,
    data: { frame, ...data },
  };
}

/** The flows as tabs (#447), each with a ⚠ count of its problems; none for a project with one flow. */
export function FlowTabs({ flows, shown, onShow, children }: { flows: readonly { name: string; title: string; bad: number }[]; shown: string; onShow: (name: string) => void; children?: ReactNode }) {
  if (flows.length < 2 && !children) return null;
  return (
    <div className="flow-tabs" role="tablist" aria-label="Flows">
      {flows.map((f) => (
        <button key={f.name} role="tab" aria-selected={f.name === shown} className={`flow-tab${f.name === shown ? ' on' : ''}`} onClick={() => onShow(f.name)} title={f.name === DEFAULT_FLOW ? `${FLOW_FILE}: the default flow` : `flows/${f.name}.json`}>
          {f.title}{f.bad > 0 && <span className="flow-tab-bad">⚠ {f.bad}</span>}
        </button>
      ))}
      {children}
    </div>
  );
}
