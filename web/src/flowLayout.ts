// The workflow page's diagram (issue #310, part 1): where each block goes and what each arrow is. Blocks with a canvas
// position (`at`, written by the builder in part 2) keep it; the rest are laid out top to bottom by dagre. The arrows
// are the blocks' outcomes (#1184), each named with its count ("Failed (3rd time)") on its own pin, a row on the
// block's right edge it leaves from (#446, as Unreal Blueprints' exec pins), so the arrow itself carries no words; a
// "no" that comes back round is laid out reversed, so it never pulls its target down. Pure, kept apart from the
// component so it can be tested.
//
// A block shows who runs it and its brief's name, and its sub-steps as rows inside it (#322), so a block with sub-steps
// is wider and taller; a block that continues another's session gets a dashed arrow from that one, drawn over the
// layout rather than laid out with it, since it is no way the work goes.
import dagre from '@dagrejs/dagre';
import { drawnArrows, outcomeName, type DrawnArrow, type Flow, type FlowBlock, type FlowFrame, type FlowSubstep, type SubstepTo } from '../../src/shared/flow.ts';

export const BLOCK_WIDTH = 210;
export const BLOCK_HEIGHT = 78;
/** A block with sub-steps: wider, for their rows' words, and a row's height per line of them. */
export const SUBSTEP_BLOCK_WIDTH = 260;
const SUBSTEP_LINE = 14;
const SUBSTEP_ROW_PAD = 8;
/** About how many characters of a sub-step's row fit on one of its lines (10.5 px, the row's width less its padding). */
const SUBSTEP_LINE_CHARS = 38;
/** An outcome's pin (#446): a row of its own at the foot of the block, the styles' .flow-pin height, after a gap. */
export const PIN_ROW = 18;
const PIN_GAP = 4;
/** Where the side handles sit, from a block's top: by its title, clear of the pins below. */
export const SIDE_HANDLE_Y = 22;

/** The file's name of a path, without ".md": what a brief makes the one who runs it ("briefs/builder.md" → "builder"). */
export const briefName = (file: string | undefined): string | undefined => file?.split('/').pop()?.replace(/\.md$/i, '');

/** Who runs a block, in words: "manager", "new session", "continues Build". */
export function runsText(b: FlowBlock, titleOf: (id: string) => string = (id) => id): string | null {
  switch (b.runs) {
    case 'manager': return 'manager';
    case 'person': return 'person';
    case 'new-session': return 'new session';
    case 'continue': return b.continues ? `continues ${titleOf(b.continues)}` : 'continues a session';
    default: return b.kind === 'person' ? 'person' : null;
  }
}

const WHEN_TEXT = { start: 'at the start', done: 'when done', brief: 'as the brief says' } as const;

/** Where a sub-step's outcome leads, in words, with who fixes for "owner" (#1185). */
export function substepToText(owner: FlowBlock, to: SubstepTo): string {
  const who = briefName(owner.brief) ?? (owner.runs === 'manager' ? 'the manager' : 'the session');
  return { done: 'done', owner: `✗ ${who} fixes`, report: 'report', 'ask-manager': 'ask the manager' }[to];
}

/**
 * A sub-step as its block shows it: "↳ when done: Self-review", "subagent · sonnet · reviewer.md", then its outcomes,
 * "No findings → done · Findings → ✗ builder fixes · Findings (3rd time) → report". A check sub-step checks its own
 * block's work, which is allowed and marked: "the author reads this" (#322).
 */
export function substepText(owner: FlowBlock, s: FlowSubstep): { head: string; detail: string; outcomes: string | null; note: string | null } {
  const detail = ['subagent', s.model, s.brief && `${briefName(s.brief)}.md`].filter(Boolean).join(' · ');
  const outcomes = s.outcomes?.length ? s.outcomes.map((o) => `${outcomeName(o)} → ${substepToText(owner, o.to)}`).join(' · ') : null;
  return { head: `↳ ${WHEN_TEXT[s.when ?? 'done']}: ${s.title}`, detail, outcomes, note: s.kind === 'check' ? 'the author reads this' : null };
}

/** How large a block is drawn: its sub-steps' rows make it wider and taller, and each outcome's pin a row taller (#446). */
export function blockSize(b: FlowBlock): { width: number; height: number } {
  const subs = b.substeps ?? [];
  const pins = b.outcomes?.length ? PIN_GAP + PIN_ROW * b.outcomes.length : 0;
  if (!subs.length) return { width: BLOCK_WIDTH, height: BLOCK_HEIGHT + pins };
  const lines = (text: string) => Math.max(1, Math.ceil(text.length / SUBSTEP_LINE_CHARS));
  const rows = subs.reduce((h, s) => {
    const t = substepText(b, s);
    return h + SUBSTEP_ROW_PAD + SUBSTEP_LINE * (lines(t.head) + lines(t.detail) + (t.outcomes ? lines(t.outcomes) : 0) + (t.note ? 1 : 0));
  }, 0);
  return { width: SUBSTEP_BLOCK_WIDTH, height: BLOCK_HEIGHT + 6 + rows + pins };
}

export interface Point {
  x: number;
  y: number;
}

export interface PlacedBlock {
  block: FlowBlock;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The kinds of arrow drawn: an outcome on the way on, a "no" that comes back round, a counted one
 * ("Failed (3rd time)"), and "continue", from a block to the one that continues its session (#322).
 */
export type PlacedKind = 'way' | 'back' | 'counted' | 'continue';

export interface PlacedArrow {
  from: string;
  to: string;
  kind: PlacedKind;
  /** The outcome's word and count, and its place in the block's outcomes; none for a continued session. */
  word?: string;
  index?: number;
  times?: number;
  id: string;
  /** Its outcome's name, which its pin shows (#446); "same session" for a continued one. */
  text: string | null;
  /**
   * Its route round the blocks, from its block's edge to the edge of the one it leads to; null when the page draws it
   * as a step path (a block it joins was placed by hand, an arrow to itself, a continued session). The page joins it to
   * the arrow's pin (pinnedRoute, #446).
   */
  route: Point[] | null;
}

export interface FlowLayout {
  /** Where work enters: the flow's start, else its first block. */
  start: string;
  blocks: PlacedBlock[];
  arrows: PlacedArrow[];
}

/** What an arrow says in the diagram: its outcome's name, the count as part of it ("Failed (3rd time)"). */
export const arrowText = (a: { word: string; times?: number }): string => outcomeName(a);

/**
 * Which arrows go back: a block's first outcome is its way on, and a later one that comes round to it again (Code
 * review's "Changes requested" → Fix → Code review) is its "no", as part 1's fail arrows were. Laid out reversed, Fix
 * sits above Code review, beside Build, rather than under everything that can send work back to it. A counted outcome
 * ("Changes requested (3rd time)" → Person) goes on, down.
 */
export function goesBack(arrows: DrawnArrow[]): Set<DrawnArrow> {
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const todo = [from];
    while (todo.length) {
      const id = todo.pop()!;
      for (const x of arrows) {
        if (x.from !== id) continue;
        if (x.to === to) return true;
        if (!seen.has(x.to)) { seen.add(x.to); todo.push(x.to); }
      }
    }
    return false;
  };
  return new Set(arrows.filter((x) => x.index > 0 && !x.times && x.from !== x.to && reaches(x.to, x.from)));
}

/** About how wide an arrow's words are at the diagram's 11 px, so dagre keeps room for them. */
export const labelWidth = (text: string) => Math.ceil(text.length * 6.3) + 12;

export function layoutFlow(given: Flow): FlowLayout {
  // A second block with an id already used is a problem the checks report; the drawing shows the first only.
  const flow = { ...given, blocks: given.blocks.filter((b, i) => given.blocks.findIndex((x) => x.id === b.id) === i) };
  const g = new dagre.graphlib.Graph({ multigraph: true });
  // Wider apart across than before pins (#446): arrows leave a block's right edge and run down beside it.
  g.setGraph({ rankdir: 'TB', nodesep: 70, edgesep: 20, ranksep: 56, marginx: 10, marginy: 10 });
  const ids = new Set(flow.blocks.map((b) => b.id));
  const size = new Map(flow.blocks.map((b) => [b.id, blockSize(b)]));
  for (const b of flow.blocks) g.setNode(b.id, { ...size.get(b.id)! });
  const drawn = drawnArrows(flow).filter((a) => ids.has(a.from) && ids.has(a.to));
  const start = flow.start && ids.has(flow.start) ? flow.start : flow.blocks[0]!.id;
  const back = goesBack(drawn);
  const named = drawn.map((a, i) => {
    const kind: PlacedKind = a.times ? 'counted' : back.has(a) ? 'back' : 'way';
    return { from: a.from, to: a.to, word: a.word, index: a.index, ...(a.times ? { times: a.times } : {}), kind, id: `${a.from}-${a.index}-${a.to}-${i}`, text: arrowText(a), back: back.has(a) };
  });
  // The words are on the pins (#446), so the arrows need no room for them. Arrows between the same two blocks the same
  // way (each way on, or each way back) are one edge to dagre, and share its route from their own pins: dagre fails on parallel edges ("Not possible to
  // find intersection inside of the rectangle", #447: three outcomes of a check all to one join).
  const edgeOf = (a: { from: string; to: string; back: boolean }) => (a.back ? JSON.stringify([a.to, a.from, true]) : JSON.stringify([a.from, a.to, false]));
  for (const a of named) {
    if (a.from === a.to) continue;
    const [u, v] = JSON.parse(edgeOf(a)) as [string, string, boolean];
    if (!g.hasEdge(u, v, edgeOf(a))) g.setEdge(u, v, {}, edgeOf(a));
  }
  try {
    dagre.layout(g);
  } catch (e) {
    // A shape dagre can't lay out must not take the page down: the blocks one below another, arrows drawn as steps.
    console.warn('Workflow layout failed; the blocks are stacked instead.', e);
    let y = 10;
    for (const b of flow.blocks) {
      const { width, height } = size.get(b.id)!;
      g.setNode(b.id, { width, height, x: 10 + width / 2, y: y + height / 2 });
      y += height + 56;
    }
    for (const e2 of g.edges()) g.setEdge(e2, {});
  }
  // A position the layout gives anyway (the builder's auto-arrange, saved, #311) moves nothing: its arrows stay routed.
  const moved = new Set(flow.blocks.filter((b) => {
    const n = g.node(b.id);
    const { width, height } = size.get(b.id)!;
    return b.at && (Math.abs(b.at.x - (n.x - width / 2)) > 1 || Math.abs(b.at.y - (n.y - height / 2)) > 1);
  }).map((b) => b.id));
  // A continued session's arrow (#322): not laid out, as it is no way the work goes; React Flow draws it round the side.
  const continued: PlacedArrow[] = flow.blocks.flatMap((b, i) => (b.runs === 'continue' && b.continues && b.continues !== b.id && ids.has(b.continues)
    ? [{ id: `continue-${b.continues}-${b.id}-${i}`, from: b.continues, to: b.id, kind: 'continue' as const, text: 'same session', route: null }]
    : []));
  return {
    start,
    // dagre gives centres; the canvas wants the top-left corner.
    blocks: flow.blocks.map((block) => {
      const n = g.node(block.id);
      const { width, height } = size.get(block.id)!;
      return { block, x: block.at?.x ?? n.x - width / 2, y: block.at?.y ?? n.y - height / 2, width, height };
    }),
    arrows: [...named.map(({ back: reversed, ...a }): PlacedArrow => {
      if (a.from === a.to || moved.has(a.from) || moved.has(a.to)) return { ...a, route: null };
      const e = reversed ? g.edge(a.to, a.from, edgeOf({ ...a, back: true })) : g.edge(a.from, a.to, edgeOf({ ...a, back: false }));
      const points: Point[] = ((e?.points ?? []) as Point[]).map((p) => ({ x: p.x, y: p.y }));
      if (reversed) points.reverse();
      return { ...a, route: points.length >= 2 ? points : null };
    }), ...continued],
  };
}

/**
 * A route joined to the pin its arrow leaves from (#446): out of the pin to the right by `offset`, along the block's
 * side to the gap between it and the route's next point (below it, or above for a way back), across to that point,
 * then the route on round the blocks to the one it leads to.
 */
/** How far below its block an arrow from a pin turns towards the block it leads to, at least (#447). */
const PIN_CLEAR = 12;

export function pinnedRoute(pin: Point, offset: number, route: readonly Point[], bottom?: number): Point[] {
  if (route.length < 2) return [pin, ...route];
  const first = route[0]!;
  // Below the block as it is drawn, `bottom`, when the route goes down: a block drawn taller than laid out (a long
  // title wrapped, a block being dragged) would otherwise have the turn inside it, and the arrow run hidden behind its
  // own block (#447, Simon: "a pointer towards itself"). The route's points still inside it are passed by.
  const down = route[1]!.y > first.y;
  let at = 1;
  if (down && bottom !== undefined) while (at < route.length - 1 && route[at]!.y <= bottom + PIN_CLEAR) at++;
  const next = route[at]!;
  // Clear of the block, but above the point it heads for when there is room, so it never comes up into its target.
  const gap = down && bottom !== undefined ? Math.max((first.y + next.y) / 2, Math.min(bottom + PIN_CLEAR, Math.max(bottom + 3, next.y - 6))) : (first.y + next.y) / 2;
  const out = pin.x + offset;
  return [pin, { x: out, y: pin.y }, { x: out, y: gap }, { x: next.x, y: gap }, ...route.slice(at)];
}

/** An SVG path through `points` with its corners rounded off by up to `radius`. */
export function roundedPath(points: Point[], radius = 10): string {
  if (points.length < 2) return '';
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M ${f(points[0]!.x)} ${f(points[0]!.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const towards = (p: Point, q: Point) => { const l = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: p.x + ((q.x - p.x) / l) * r, y: p.y + ((q.y - p.y) / l) * r }; };
    const into = towards(b, a);
    const out = towards(b, c);
    d += ` L ${f(into.x)} ${f(into.y)} Q ${f(b.x)} ${f(b.y)} ${f(out.x)} ${f(out.y)}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${f(last.x)} ${f(last.y)}`;
}

/**
 * The blocks top to bottom, the order of the list a narrow screen shows; blocks level with each other in the order the
 * work reaches them from the first block, the way on before a way back (Build before Fix).
 */
export function readingOrder(layout: FlowLayout): PlacedBlock[] {
  const rank = { way: 0, counted: 1, back: 2, continue: 3 } as const;
  // A continued session is no way the work goes (#322).
  const arrows = layout.arrows.filter((a) => a.kind !== 'continue').sort((a, b) => rank[a.kind] - rank[b.kind]);
  const reached: string[] = [];
  const todo = [layout.start];
  while (todo.length) {
    const id = todo.shift()!;
    if (reached.includes(id)) continue;
    reached.push(id);
    for (const a of arrows) if (a.from === id) todo.push(a.to);
  }
  const at = (id: string) => (reached.includes(id) ? reached.indexOf(id) : reached.length);
  return [...layout.blocks].sort((a, b) => a.y - b.y || at(a.block.id) - at(b.block.id) || a.x - b.x);
}

/**
 * The comment frame (#446) each block is in, by block id: the smallest that holds its middle, as the builder moves the
 * blocks with a frame. For the list on a narrow screen, which heads a frame's blocks with its title.
 */
export function frameOf(blocks: readonly PlacedBlock[], frames: readonly FlowFrame[]): Map<string, FlowFrame> {
  const by = new Map<string, FlowFrame>();
  const bySize = [...frames].sort((a, b) => a.size.width * a.size.height - b.size.width * b.size.height);
  for (const p of blocks) {
    const x = p.x + p.width / 2;
    const y = p.y + p.height / 2;
    const f = bySize.find((f) => x >= f.at.x && x <= f.at.x + f.size.width && y >= f.at.y && y <= f.at.y + f.size.height);
    if (f) by.set(p.block.id, f);
  }
  return by;
}

/**
 * A block's outcomes in words, for the list: "Approved → Functional review", "Failed (3rd time) → Person". Not a
 * continued session's arrow: the block that continues it says so itself (#322).
 */
export function arrowsFrom(layout: FlowLayout, id: string): string[] {
  const title = (to: string) => layout.blocks.find((b) => b.block.id === to)?.block.title ?? to;
  // An outcome that ends the flow (#447) has no arrow; it is said all the same.
  const ends = (layout.blocks.find((b) => b.block.id === id)?.block.outcomes ?? []).filter((o) => o.end).map((o) => `${outcomeName(o)} → ends the flow`);
  return [...layout.arrows.filter((a) => a.from === id && a.kind !== 'continue').map((a) => `${a.text} → ${title(a.to)}`), ...ends];
}

export const KIND_LABEL: Record<FlowBlock['kind'], string> = {
  work: 'Work', check: 'Check', person: 'Person', fork: 'Fork', join: 'Join', timer: 'Timer', flow: 'Run flow', wait: 'Wait',
};

/** What a Run flow block runs, in words (#447): "runs Asset", by the flow's title when it is there. */
export function flowLine(b: FlowBlock, flowTitle?: (name: string) => string | undefined): string | null {
  if (b.kind !== 'flow') return null;
  if (b.flow === undefined) return 'runs no flow yet';
  const title = flowTitle?.(b.flow);
  // Part 3d: the flow it runs continues the session before it.
  const caller = b.session === 'caller' ? ", in the caller's session" : '';
  return title === undefined ? `runs "${b.flow}" (not a flow here)${caller}` : `runs ${title}${caller}`;
}

/** Who runs it and with what, in one line: "new session · opus · profile review" (#322). */
export function actorLine(b: FlowBlock, titleOf?: (id: string) => string): string | null {
  // Part 3d: whose call a person block is, a wait, sub-steps run at once.
  const parts = [
    runsText(b, titleOf), b.model, b.profile && `profile ${b.profile}`, b.ask && (b.ask === 'review' ? 'asks for a review' : 'asks a question'),
    b.person && `${b.person}'s call`, b.kind === 'wait' && 'waits on something outside', b.parallel && b.substeps?.length && 'sub-steps at once', timerText(b),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function timerText(b: FlowBlock): string | null {
  if (!b.timer) return null;
  return 'clock' in b.timer ? b.timer.clock : `every ${b.timer.every} ${b.timer.of}`;
}

/** The least zoom a diagram opens at: below it a block's words are too small to read (#318, a 29-block flow). */
export const OPENING_MIN_ZOOM = 0.7;

/**
 * Where a diagram opens, in a box `width` × `height`: the whole flow, fitted as React Flow's fitView does with
 * `padding`, when that is readable (`minZoom`); else at that zoom from the top of the start block, near the top of
 * the box, where the reading starts, and across the whole flow centred when it is narrow enough, else the start block
 * in the middle (a large flow is then found with the minimap). `fit` says which.
 */
export function openingView(blocks: readonly (Point & { width?: number; height?: number })[], start: (Point & { width?: number }) | undefined, width: number, height: number, { padding = 0.15, minZoom = OPENING_MIN_ZOOM } = {}): { fit: true } | { fit: false; x: number; y: number; zoom: number } {
  if (!blocks.length || width <= 0 || height <= 0) return { fit: true };
  const left = Math.min(...blocks.map((b) => b.x));
  const top = Math.min(...blocks.map((b) => b.y));
  const w = Math.max(...blocks.map((b) => b.x + (b.width ?? BLOCK_WIDTH))) - left;
  const h = Math.max(...blocks.map((b) => b.y + (b.height ?? BLOCK_HEIGHT))) - top;
  // As React Flow's fitView works it out (getViewportForBounds).
  const fitZoom = Math.min(width / (w * (1 + padding)), height / (h * (1 + padding)));
  if (fitZoom >= minZoom) return { fit: true };
  const zoom = minZoom;
  const at = start ?? { x: left, y: top };
  // With the same margin as fitting: arrows that loop back run beside the blocks, and the map sits on the drawing.
  const x = w * zoom * (1 + padding) <= width ? (width - w * zoom) / 2 - left * zoom : width / 2 - (at.x + (('width' in at ? at.width : undefined) ?? BLOCK_WIDTH) / 2) * zoom;
  return { fit: false, zoom, x, y: 32 - at.y * zoom };
}

/** A block's box on the canvas, by its node id. */
export type Box = { x: number; y: number; width: number; height: number };

/**
 * Where a handle sits on its block: "t" top and "b" bottom in the middle, "l…" left and "r…" right by the title
 * (SIDE_HANDLE_Y), and "o<n>" the n-th of its `pins` outcomes' pins on the right edge (#446), the block's last rows.
 */
export function handlePoint(box: Box, handle: string | null | undefined, pins = 0): Point {
  if (handle === 't') return { x: box.x + box.width / 2, y: box.y };
  if (handle?.startsWith('l')) return { x: box.x, y: box.y + SIDE_HANDLE_Y };
  if (handle?.startsWith('r')) return { x: box.x + box.width, y: box.y + SIDE_HANDLE_Y };
  const pin = /^o(\d+)$/.exec(handle ?? '');
  // Above the block's bottom padding (6 px, the styles' .flow-block).
  if (pin) return { x: box.x + box.width, y: box.y + box.height - 6 - PIN_ROW * (pins - Number(pin[1])) + PIN_ROW / 2 };
  return { x: box.x + box.width / 2, y: box.y + box.height };
}

/**
 * Where an outcome's arrow leaves and enters (#446): from its own pin, the `index`-th of the block's `count`; into the
 * top of the block it leads to, or the side by its title for one going back. Out from the pin by a step each, the
 * top pin's furthest, so a block's arrows going down run beside each other and don't cross.
 */
export function outcomeHandles(kind: PlacedKind, index: number, count: number): [string, string, number] {
  return [`o${index}`, kind === 'back' ? 'rt' : 't', 16 + 10 * Math.max(0, count - 1 - index)];
}

/** An arrow's label to place: its words, and where it starts and ends (midway between its handles). */
export interface LabelToPlace {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  text: string | null;
  /** How many outcomes' pins its source block has (#446), for where a pin handle is. */
  pins?: number;
}

const LABEL_HEIGHT = 18;
const LABEL_GAP = 4;

/**
 * Where each arrow's words go, so none lies on another (#1184, seen in the preview: "Failed → Planner", "Failed (3rd
 * time) → Person" and "Done" leaving one block read "Faile Done (3rd time)"). Each starts midway between its handles,
 * as React Flow's own step path puts it; then, top to bottom, one that overlaps one already placed, or a block (the
 * words would hide under it, or on its pins, #446), moves down along the arrows' way, below it, until it is clear.
 * Words keep their size, so they read at 390 px as at 1280. Since pins (#446) only a continued session's arrow has words.
 */
export function labelSpots(boxes: ReadonlyMap<string, Box>, labels: readonly LabelToPlace[]): Map<string, Point> {
  const wanted = labels.flatMap((l) => {
    if (!l.text) return [];
    const s = boxes.get(l.source);
    const t = boxes.get(l.target);
    if (!s || !t) return [];
    const a = handlePoint(s, l.sourceHandle, l.pins);
    const b = handlePoint(t, l.targetHandle);
    const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return [{ id: l.id, x: at.x, y: at.y, w: labelWidth(l.text), h: LABEL_HEIGHT }];
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: typeof wanted = [];
  // The blocks are in the way too, as boxes centred like the words.
  const blocks = [...boxes.values()].map((b) => ({ id: '', x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }));
  const clash = (a: (typeof wanted)[number], b: (typeof wanted)[number]) =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 + LABEL_GAP && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + LABEL_GAP;
  for (const l of wanted) {
    const spot = { ...l };
    for (let round = 0; round < 50; round++) {
      const hit = placed.find((p) => clash(spot, p)) ?? blocks.find((b) => clash(spot, b));
      if (!hit) break;
      spot.y = hit.y + (hit.h + spot.h) / 2 + LABEL_GAP;
    }
    placed.push(spot);
  }
  return new Map(placed.map((p) => [p.id, { x: p.x, y: p.y }]));
}
