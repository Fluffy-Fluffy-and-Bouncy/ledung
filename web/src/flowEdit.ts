// The workflow builder's edits (issue #311, part 2, docs/steps/workflow-builder.md): a draft of the flow, the edits
// the canvas and the block panel make to it, the live checks, and the files a save writes. It edits the same files
// part 1 reads, in the same format; what it writes back keeps everything it didn't change as it was written, fields
// this Ledung doesn't know and $comment included, so a flow read and saved unchanged gives the same files. Pure, kept
// apart from the component so it can be tested. The arrows are each block's outcomes (#1184): edited in its panel, or
// drawn from block to block, which adds one; each is a pin on its block's edge, drawn to the block it leads to (#446).
// Comment frames (#446) are rectangles round blocks: moving one moves the blocks inside it. A project may have several
// flows (#447): the builder edits them together as a workspace, one draft each, sharing the rules and texts, so one
// undo history and one save cover them all.
import { BLOCK_KINDS, DEFAULT_FLOW, FLOW_FILE, flowFileOf, FLOW_IN_FOLDER, linkedTexts, MANAGER_FILE, RULES_FILE, WRITABLE_FLOW_FILE, type BlockKind, type Flow, type FlowBlock, type FlowFileWrite, type FlowFrame, type FlowOrigin, type FlowOutcome, type FlowOverlay, type FlowProblem, type FlowSubstep, type FlowTidy, type FlowView, type FlowWorktree } from '../../src/shared/flow.ts';
import { checkFlow, checkFlowCalls, machinePathIn, parseFlow, personGatedFlows } from '../../src/shared/flow-check.ts';
import { ownCredit } from '../../src/shared/flow-origin.ts';
import { blockSize, layoutFlow } from './flowLayout.ts';

/** A block being edited; `key` stays when its id changes, so it is still matched to what was read. */
export interface DraftBlock {
  key: string;
  block: FlowBlock;
  /** A block made here: its id follows its title until the id is set by hand. */
  autoId?: boolean;
  /**
   * Its sub-steps' keys, in their order (#322): "r<n>" for the n-th one read, so a sub-step moved or changed is still
   * written over what it was, with the fields this Ledung doesn't know. None: as many as it has, in the order read.
   */
  subs?: string[];
  /** Its outcomes' keys, the same way (#1184). */
  outs?: string[];
}

/** An overlay being edited (#318); its key matches it to what was read, as a block's does. */
export interface DraftOverlay {
  key: string;
  overlay: FlowOverlay;
}

/** A comment frame being edited (#446); its key matches it to what was read, as an overlay's does. */
export interface DraftFrame {
  key: string;
  frame: FlowFrame;
}

export interface Draft {
  title?: string;
  /** As flow.json says it (#117); the builder keeps it. */
  author?: string;
  /** The author's own release number (workflow-origin.md); only the default flow has one. */
  release?: number;
  /** Where this copy came from (workflow-origin.md): written back as read; set only by a split-off or "Record where this came from". */
  origin?: FlowOrigin;
  /** Part 3f: as flow.json says them; none: the default. */
  worktree?: FlowWorktree;
  limit?: number;
  tidy?: FlowTidy;
  oneRunPerRef?: boolean;
  start?: string;
  /** The manager's file (#322), as flow.json names it. */
  manager?: string;
  blocks: DraftBlock[];
  overlays: DraftOverlay[];
  frames: DraftFrame[];
  /** rules.md; null: there is none and none was written. */
  rules: string | null;
  /** The manager's file, the briefs and overlay texts, by their path in the workflow folder: those read and those made here. */
  texts: Record<string, string>;
  /** Numbers the keys of the parts made here. */
  seq: number;
}

/** What was read, to write back what didn't change as it was and to name the versions a save replaces. */
export interface DraftBase {
  /** flow.json as read; null for a new flow. */
  raw: Record<string, unknown> | null;
  rawText: string | null;
  parsed: Flow | null;
  rules: string | null;
  texts: Record<string, string>;
  versions: Record<string, string>;
  /** The files are a shared workflow's: saving writes them all into the project's own folder as new files. */
  copy: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The same value, as JSON sees it (key order aside). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k] !== undefined || b[k] !== undefined));
  return [...keys].every((k) => sameValue(a[k], b[k]));
}

/** The draft of a view's flow, and what it was read from; a view whose flow.json isn't a flow can't be edited. */
export function draftFromView(view: FlowView): { base: DraftBase; draft: Draft } | null {
  if (!view.flow || view.raw === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(view.raw.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const flow = view.flow;
  return {
    base: { raw, rawText: view.raw, parsed: flow, rules: view.rules, texts: view.texts, versions: view.versions, copy: view.source?.kind === 'workflow' },
    draft: {
      ...(flow.title !== undefined ? { title: flow.title } : {}),
      ...(flow.author !== undefined ? { author: flow.author } : {}),
      ...(flow.release !== undefined ? { release: flow.release } : {}),
      ...(flow.origin !== undefined ? { origin: flow.origin } : {}),
      ...(flow.start !== undefined ? { start: flow.start } : {}),
      ...(flow.manager !== undefined ? { manager: flow.manager } : {}),
      ...follow(flow),
      blocks: flow.blocks.map((block, i) => ({ key: `b${i}`, block })),
      overlays: flow.overlays.map((overlay, i) => ({ key: `o${i}`, overlay })),
      frames: flow.frames.map((frame, i) => ({ key: `f${i}`, frame })),
      rules: view.rules,
      texts: { ...view.texts },
      seq: 0,
    },
  };
}

/**
 * A new flow, empty or from the starter: Issue → Build (with a self-review) → Code review → Fix (Build's session) →
 * Person → Merge (#322), its arrows outcomes (#1184): the 3rd "Changes requested" goes to the person.
 */
export function newDraft(starter: boolean, view: FlowView | null): { base: DraftBase; draft: Draft } {
  const base: DraftBase = { raw: null, rawText: null, parsed: null, rules: null, texts: view?.texts ?? {}, versions: view?.versions ?? {}, copy: false };
  const empty: Draft = { blocks: [], overlays: [], frames: [], rules: null, texts: { ...(view?.texts ?? {}) }, seq: 0 };
  if (!starter) return { base, draft: empty };
  const blocks: FlowBlock[] = [
    { id: 'issue', kind: 'work', title: 'Issue', runs: 'manager', outcomes: [{ word: 'Ready', to: 'build' }] },
    {
      id: 'build', kind: 'work', title: 'Build', runs: 'new-session',
      substeps: [{
        id: 'self-review', kind: 'check', title: 'Self-review', when: 'done',
        outcomes: [{ word: 'No findings', to: 'done' }, { word: 'Findings', to: 'owner' }, { word: 'Findings', times: 3, to: 'report' }],
      }],
      outcomes: [{ word: 'PR opened', to: 'code-review' }],
    },
    {
      id: 'code-review', kind: 'check', title: 'Code review', runs: 'new-session',
      outcomes: [{ word: 'Approved', to: 'person' }, { word: 'Changes requested', to: 'fix' }, { word: 'Changes requested', times: 3, to: 'person' }],
    },
    { id: 'fix', kind: 'work', title: 'Fix', runs: 'continue', continues: 'build', outcomes: [{ word: 'Fixed', to: 'code-review' }] },
    { id: 'person', kind: 'person', title: 'Person', runs: 'person', ask: 'review', outcomes: [{ word: 'Accepted', to: 'merge' }, { word: 'Changes needed', to: 'fix' }] },
    { id: 'merge', kind: 'work', title: 'Merge', runs: 'manager' },
  ];
  return { base, draft: { ...empty, title: 'Our process', start: 'issue', blocks: blocks.map((block, i) => ({ key: `n${i}`, block })), seq: blocks.length } };
}

/** Part 3f's settings of a flow or draft, those it has. */
function follow(f: Pick<Flow, 'worktree' | 'limit' | 'tidy' | 'oneRunPerRef'>): Pick<Flow, 'worktree' | 'limit' | 'tidy' | 'oneRunPerRef'> {
  return {
    ...(f.worktree !== undefined ? { worktree: f.worktree } : {}),
    ...(f.limit !== undefined ? { limit: f.limit } : {}),
    ...(f.tidy !== undefined ? { tidy: f.tidy } : {}),
    ...(f.oneRunPerRef !== undefined ? { oneRunPerRef: f.oneRunPerRef } : {}),
  };
}

/** Part 3f's settings changed (undefined takes one out, back to its default). */
export function setFollow(draft: Draft, patch: Partial<Pick<Draft, 'worktree' | 'limit' | 'tidy' | 'oneRunPerRef'>>): Draft {
  const next: Draft = { ...draft, ...patch };
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined) delete next[k];
  return next;
}

/** The draft as a flow, for the canvas and the checks. */
export function flowOf(draft: Draft): Flow {
  return {
    version: 1,
    ...(draft.title !== undefined ? { title: draft.title } : {}),
    ...(draft.author !== undefined ? { author: draft.author } : {}),
    ...(draft.release !== undefined ? { release: draft.release } : {}),
    ...(draft.origin !== undefined ? { origin: draft.origin } : {}),
    ...(draft.start !== undefined ? { start: draft.start } : {}),
    ...(draft.manager !== undefined ? { manager: draft.manager } : {}),
    ...follow(draft),
    blocks: draft.blocks.map((b) => b.block),
    overlays: draft.overlays.map((o) => o.overlay),
    frames: draft.frames.map((f) => f.frame),
  };
}

// --- Writing back -------------------------------------------------------------------------------------------------

/** The fields of each part of the format, in the order a new one is written; nested parts with their own fields. */
const TOP_FIELDS = ['version', 'title', 'author', 'release', 'origin', 'start', 'manager', 'worktree', 'limit', 'tidy', 'oneRunPerRef'];
const BLOCK_FIELDS = ['id', 'kind', 'title', 'flow', 'session', 'runs', 'continues', 'context', 'model', 'profile', 'brief', 'ask', 'person', 'timer', 'guard', 'parallel', 'limit', 'substeps', 'outcomes', 'at'];
const SUBSTEP_FIELDS = ['id', 'kind', 'title', 'brief', 'model', 'when', 'outcomes'];
const OUTCOME_FIELDS = ['word', 'to', 'times', 'end'];
const OVERLAY_FIELDS = ['id', 'title', 'file', 'blocks'];
const FRAME_FIELDS = ['id', 'title', 'colour', 'at', 'size'];
const NESTED: Record<string, string[]> = { at: ['x', 'y'], timer: ['every', 'of', 'clock'], guard: ['$comment', 'minHours', 'when'], size: ['width', 'height'] };
/** Lists of parts with fields of their own, merged one by one by place when the list is as long as it was. */
const NESTED_LISTS: Record<string, string[]> = { outcomes: OUTCOME_FIELDS };

/**
 * `edited` written over `raw`: a known field the edit didn't change (the same as `parsed`, what was read) keeps what
 * was written, even where the reader filled in a default; a changed one is set or taken out; fields this Ledung
 * doesn't know stay. Nested parts (at, timer) the same way, and a sub-step's outcomes one by one.
 */
function mergeKnown(raw: unknown, parsed: unknown, edited: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  if (!isObject(raw)) return fresh(edited, fields);
  const out: Record<string, unknown> = { ...raw };
  const was = isObject(parsed) ? parsed : {};
  for (const f of fields) {
    const e = edited[f];
    if (sameValue(was[f], e)) continue;
    const rawList = raw[f];
    if (e === undefined) delete out[f];
    else if (NESTED[f] && isObject(e)) out[f] = mergeKnown(raw[f], was[f], e, NESTED[f]!);
    else if (NESTED_LISTS[f] && Array.isArray(e)) {
      // Each matched to the one it was read as by what it says (the same, else the same word), not by place, so a
      // moved or taken-out one never lends its unknown fields to another (review of #1184); one with none is new.
      const raws = Array.isArray(rawList) ? rawList : [];
      const wasList = Array.isArray(was[f]) ? was[f] as unknown[] : [];
      const used = new Set<number>();
      const pick = (test: (w: unknown) => boolean) => {
        const i = wasList.findIndex((w, k) => !used.has(k) && k < raws.length && test(w));
        if (i >= 0) used.add(i);
        return i;
      };
      const items = e as Record<string, unknown>[];
      const exact = items.map((x) => pick((w) => sameValue(w, x)));
      out[f] = items.map((x, j) => {
        const i = exact[j]! >= 0 ? exact[j]! : pick((w) => isObject(w) && w.word === x.word);
        return i >= 0 ? mergeKnown(raws[i], wasList[i], x, NESTED_LISTS[f]!) : fresh(x, NESTED_LISTS[f]!);
      });
    } else out[f] = e;
  }
  return out;
}

/** A part made here, its fields in the format's order and nothing undefined. */
function fresh(edited: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = edited[f];
    if (v === undefined) continue;
    out[f] = NESTED[f] && isObject(v) ? fresh(v, NESTED[f]!) : NESTED_LISTS[f] && Array.isArray(v) ? v.map((x) => fresh(x as Record<string, unknown>, NESTED_LISTS[f]!)) : v;
  }
  return out;
}

/** A block's sub-steps' keys, in their order: as given, else those of the sub-steps as read ("r0", "r1"…). */
export const substepKeys = (entry: DraftBlock): string[] => entry.subs ?? (entry.block.substeps ?? []).map((_, j) => `r${j}`);
/** A block's outcomes' keys, the same way (#1184). */
export const outcomeKeys = (entry: DraftBlock): string[] => entry.outs ?? (entry.block.outcomes ?? []).map((_, j) => `r${j}`);

/**
 * A list of a block's parts (sub-steps, outcomes) written back one by one by their keys: each changed one over what it
 * was read as, a new one in the format's order.
 */
function mergeKeyed(rawList: unknown, wasList: readonly unknown[] | undefined, items: readonly object[], keys: string[], fields: string[]): Record<string, unknown>[] {
  const raws = Array.isArray(rawList) ? rawList : [];
  return items.map((x, j) => {
    const n = /^r(\d+)$/.exec(keys[j] ?? '') ? Number(keys[j]!.slice(1)) : -1;
    return n >= 0 && n < raws.length ? mergeKnown(raws[n], wasList?.[n], { ...x }, fields) : fresh({ ...x }, fields);
  });
}

/** flow.json for the draft: what was read, with the draft's changes written over it. */
export function flowText(base: DraftBase, draft: Draft): string {
  const raw = base.raw;
  const parsed = base.parsed;
  const rawList = (key: string): unknown[] => (raw && Array.isArray(raw[key]) ? raw[key] as unknown[] : []);
  const at = (key: string) => /^[bof](\d+)$/.exec(key) && raw ? Number(key.slice(1)) : -1;
  const fields = { version: 1, title: draft.title, author: draft.author, release: draft.release, origin: draft.origin, start: draft.start, manager: draft.manager, worktree: draft.worktree, limit: draft.limit, tidy: draft.tidy, oneRunPerRef: draft.oneRunPerRef };
  let top: Record<string, unknown> = raw ? mergeKnown(raw, parsed, fields, TOP_FIELDS) : fresh(fields, TOP_FIELDS);
  // A manager's file new to a read flow goes where a new flow has it, before the blocks, not after everything.
  if (raw && !('manager' in raw) && 'manager' in top && 'blocks' in top) {
    const { manager: m, ...rest } = top;
    top = Object.fromEntries(Object.entries(rest).flatMap(([k, v]) => (k === 'blocks' ? [['manager', m], [k, v]] : [[k, v]])));
  }
  top.blocks = draft.blocks.map((entry) => {
    const { key, block } = entry;
    const i = key.startsWith('b') ? at(key) : -1;
    if (i < 0) return fresh({ ...block, substeps: block.substeps?.map((s) => fresh({ ...s }, SUBSTEP_FIELDS)) }, BLOCK_FIELDS);
    const rawBlock = rawList('blocks')[i];
    const was = parsed?.blocks[i];
    const out = mergeKnown(rawBlock, was, { ...block }, BLOCK_FIELDS);
    const own = (f: string) => (isObject(rawBlock) ? rawBlock[f] : undefined);
    // Sub-steps and outcomes one by one, by their keys (#322, #1184).
    if (block.substeps && !sameValue(was?.substeps, block.substeps)) out.substeps = mergeKeyed(own('substeps'), was?.substeps, block.substeps, substepKeys(entry), SUBSTEP_FIELDS);
    if (block.outcomes && !sameValue(was?.outcomes, block.outcomes)) out.outcomes = mergeKeyed(own('outcomes'), was?.outcomes, block.outcomes, outcomeKeys(entry), OUTCOME_FIELDS);
    return out;
  });
  const overlays = draft.overlays.map(({ key, overlay }) => {
    const i = key.startsWith('o') ? at(key) : -1;
    return i >= 0 ? mergeKnown(rawList('overlays')[i], parsed?.overlays[i], { ...overlay }, OVERLAY_FIELDS) : fresh({ ...overlay }, OVERLAY_FIELDS);
  });
  if (overlays.length || (raw && 'overlays' in raw)) top.overlays = overlays;
  else delete top.overlays;
  const frames = draft.frames.map(({ key, frame }) => {
    const i = key.startsWith('f') ? at(key) : -1;
    return i >= 0 ? mergeKnown(rawList('frames')[i], parsed?.frames[i], { ...frame }, FRAME_FIELDS) : fresh({ ...frame }, FRAME_FIELDS);
  });
  if (frames.length || (raw && 'frames' in raw)) top.frames = frames;
  else delete top.frames;
  // A new flow's parts in the format's order; a read one keeps its own order.
  const ordered = raw ? top : { ...fresh(top, TOP_FIELDS), ...Object.fromEntries(['blocks', 'overlays', 'frames'].filter((k) => k in top).map((k) => [k, top[k]])) };
  return `${formatJson(ordered)}\n`;
}

/**
 * JSON as a person writes it: a part on one line when it fits in `width` (about as wide as part 1's example), else
 * its parts one a line, so a change to the process is a small diff in git; a list of parts (blocks, outcomes) always
 * one a line. `lead`: what is on the line before it.
 */
export function formatJson(value: unknown, indent = '', lead = 0, width = 150): string {
  const flat = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
    if (isObject(v)) {
      const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${flat(x)}`);
      return parts.length ? `{ ${parts.join(', ')} }` : '{}';
    }
    return JSON.stringify(v) ?? 'null';
  };
  const one = flat(value);
  const inner = `${indent}  `;
  // Lists of parts at the top (blocks, overlays) one a line; a block's own (outcomes) on one line when they fit (#1184).
  const list = Array.isArray(value) && value.some(isObject) && indent.length <= 2;
  if ((!list && indent.length + lead + one.length <= width) || !(Array.isArray(value) ? value.length : isObject(value) && Object.keys(value).length)) return one;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + formatJson(v, inner, 0, width)).join(',\n')}\n${indent}]`;
  const parts = Object.entries(value as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => {
    const key = `${JSON.stringify(k)}: `;
    return `${inner}${key}${formatJson(x, inner, key.length, width)}`;
  });
  return `{\n${parts.join(',\n')}\n${indent}}`;
}

/** The files a save writes for a project with one flow: those the draft changed or made. */
export function flowWrites(base: DraftBase, draft: Draft): FlowFileWrite[] {
  return workspaceWrites(single(base, draft));
}

/**
 * The files a save writes (#447): the texts and rules the drafts changed or made, each flow whose file changed (a flow
 * renamed is written under its new name), flow.json last, and the removal of each flow read whose file no flow has any
 * more (deleted or renamed); when copying from a shared workflow, all of them, as new files.
 */
export function workspaceWrites(ws: Workspace): FlowFileWrite[] {
  const writes: FlowFileWrite[] = [];
  const { base, draft } = ws.flows[0]!;
  const version = (p: string) => (base.copy ? null : base.versions[p] ?? null);
  const made = ws.flows.map((f) => ({ f, file: flowFileOf(f.name), text: flowText(f.base, f.draft) }));
  const linked = new Set(made.flatMap(({ text, file }) => {
    const flow = parseFlow(text, file).flow;
    return flow ? linkedTexts(flow) : [];
  }));
  for (const [p, t] of Object.entries(draft.texts)) {
    if (!WRITABLE_FLOW_FILE.test(p) || p === FLOW_FILE || FLOW_IN_FOLDER.test(p)) continue;
    // A text read is written when changed; one made here (a new brief) only while a flow still links it (review of #311, finding 6).
    const changed = base.texts[p] === undefined ? linked.has(p) : base.texts[p] !== t;
    if (base.copy ? linked.has(p) : changed) writes.push({ path: p, text: t, base: version(p) });
  }
  // Rules typed and taken out again, where there were none, make no empty rules.md.
  if (draft.rules !== null && !(base.rules === null && draft.rules === '') && (base.copy || draft.rules !== base.rules)) writes.push({ path: RULES_FILE, text: draft.rules, base: version(RULES_FILE) });
  // The other flows, then the default one: a flow on disk never runs one that isn't written yet.
  for (const { f, file, text } of [...made.slice(1), made[0]!]) {
    let same = false;
    try {
      same = f.read === file && !!f.base.raw && sameValue(JSON.parse(text), f.base.raw);
    } catch {
      // Not JSON: written, and the server says why it can't be.
    }
    if (base.copy || !same) writes.push({ path: file, text, base: version(file) });
  }
  if (!base.copy) {
    const files = new Set(made.map((m) => m.file));
    for (const file of ws.read) if (!files.has(file) && base.versions[file]) writes.push({ path: file, remove: true, base: base.versions[file]! });
  }
  return writes;
}

/**
 * The checks of part 1 on the draft as it would be written, live while editing: the format's, the flow's and the
 * texts'. A field this Ledung doesn't know is kept by the builder rather than left out.
 */
export function draftProblems(base: DraftBase, draft: Draft, profiles?: readonly string[], gated?: ReadonlySet<string>): FlowProblem[] {
  if (!draft.blocks.length) return [{ at: 'blocks', message: 'A flow needs at least one block: drag one from the left.' }];
  const parsed = parseFlow(flowText(base, draft));
  const format = parsed.problems.map((p) => ({ ...p, message: p.message.replace(/[Ii]t is left out\.$/, 'the builder keeps it as it is.') }));
  if (!parsed.flow) return format;
  const exists = (f: string) => draft.texts[f] !== undefined;
  const linked = linkedTexts(parsed.flow);
  const texts = [...(draft.rules === null ? [] : [machinePathIn(RULES_FILE, draft.rules)]), ...linked.map((f) => (draft.texts[f] === undefined ? null : machinePathIn(f, draft.texts[f])))];
  return [...format, ...checkFlow(parsed.flow, exists, profiles, gated), ...texts.filter((p): p is FlowProblem => p !== null)];
}

/** The problems that keep the draft from being saved at all: flow.json would not be a flow. */
export function blocksSaving(base: DraftBase, draft: Draft): boolean {
  return !draft.blocks.length || !parseFlow(flowText(base, draft)).flow;
}

// --- Edits --------------------------------------------------------------------------------------------------------

/** An id made from words: lower case, digits and "-", unique in the draft. */
export function idFrom(words: string, draft: Draft, except?: string): string {
  const stem = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'block';
  const taken = new Set(draft.blocks.filter((b) => b.key !== except).map((b) => b.block.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

export const NEW_TITLE: Record<BlockKind, string> = { work: 'New step', check: 'New check', person: 'Person decides', fork: 'Fork', join: 'Join', timer: 'Timer', flow: 'Run flow', wait: 'Wait' };

/**
 * Where the layout draws each block, by the block itself: the layout draws a second block with an id already used
 * once only (a problem the checks name), so that one goes just beside the first (review of #311, finding 1).
 */
function placesOf(draft: Draft): (block: FlowBlock) => { x: number; y: number } {
  const layout = layoutFlow(flowOf(draft));
  const by = new Map(layout.blocks.map((p) => [p.block, p]));
  const byId = new Map(layout.blocks.map((p) => [p.block.id, p]));
  return (block) => {
    const p = by.get(block);
    if (p) return { x: Math.round(p.x), y: Math.round(p.y) };
    const first = byId.get(block.id);
    return { x: Math.round((first?.x ?? 0) + 40), y: Math.round((first?.y ?? 0) + 40) };
  };
}

/** Every block's canvas position as drawn now, so the next edit moves nothing the person didn't move. */
export function pinned(draft: Draft): Draft {
  if (draft.blocks.every((b) => b.block.at)) return draft;
  const at = placesOf(draft);
  return { ...draft, blocks: draft.blocks.map((b) => (b.block.at ? b : { ...b, block: { ...b.block, at: at(b.block) } })) };
}

/** A new block of `kind`; a Run flow block (#447) runs `flow`, the flow the builder offers first. */
export function addBlock(given: Draft, kind: BlockKind, at?: { x: number; y: number }, flow?: string): { draft: Draft; key: string } {
  const draft = given.blocks.length ? pinned(given) : given;
  const title = NEW_TITLE[kind];
  // Work and checks are a session's to begin with (#322): the usual case, and a choice in the panel.
  const block: FlowBlock = {
    id: idFrom(title, draft), kind, title,
    ...(kind === 'flow' && flow !== undefined ? { flow } : {}),
    ...(kind === 'work' || kind === 'check' ? { runs: 'new-session' as const } : {}),
    ...(kind === 'person' ? { runs: 'person' as const, ask: 'question' as const } : {}),
    ...(kind === 'timer' ? { timer: { clock: 'daily' as const } } : {}),
  };
  // Below everything when no place is given.
  const below = Math.max(-100, ...draft.blocks.map((b) => b.block.at?.y ?? 0)) + 140;
  block.at = { x: Math.round(at?.x ?? draft.blocks[draft.blocks.length - 1]?.block.at?.x ?? 0), y: Math.round(at?.y ?? below) };
  const key = `n${draft.seq}`;
  return { draft: { ...draft, blocks: [...draft.blocks, { key, block, autoId: true }], seq: draft.seq + 1 }, key };
}

/** A block's ids in other places changed with it: outcomes, continues, the start, overlays. */
function renamed(draft: Draft, from: string, to: string): Draft {
  const r = (id: string) => (id === from ? to : id);
  return {
    ...draft,
    ...(draft.start === from ? { start: to } : {}),
    blocks: draft.blocks.map((b) => {
      let block = b.block;
      if (block.outcomes?.some((o) => o.to === from)) block = { ...block, outcomes: block.outcomes.map((o) => (o.to === from ? { ...o, to } : o)) };
      if (block.continues === from) block = { ...block, continues: to };
      return block === b.block ? b : { ...b, block };
    }),
    overlays: draft.overlays.map((o) => ({ ...o, overlay: { ...o.overlay, blocks: o.overlay.blocks.map(r) } })),
  };
}

/** Sets a block's fields (undefined takes one out). A new id goes wherever the old one was used. */
export function setBlock(draft: Draft, key: string, patch: Partial<FlowBlock>): Draft {
  const at = draft.blocks.findIndex((b) => b.key === key);
  if (at < 0) return draft;
  const was = draft.blocks[at]!;
  const block = { ...was.block, ...patch } as FlowBlock;
  for (const k of Object.keys(patch) as (keyof FlowBlock)[]) if (patch[k] === undefined) delete block[k];
  let autoId = was.autoId && patch.id === undefined;
  if (autoId && patch.title !== undefined) block.id = idFrom(patch.title, draft, key);
  if (patch.id !== undefined) autoId = false;
  const next = { ...draft, blocks: draft.blocks.map((b, i) => (i === at ? { key, block, ...(autoId ? { autoId } : {}), ...(was.subs ? { subs: was.subs } : {}), ...(was.outs ? { outs: was.outs } : {}) } : b)) };
  return block.id !== was.block.id ? renamed(next, was.block.id, block.id) : next;
}

/**
 * Takes blocks out, with the outcomes that led to them, and a block that continued one's session no longer says
 * whose (the checks ask which, #322).
 */
export function deleteBlocks(given: Draft, keys: string[]): Draft {
  const draft = pinned(given);
  const ids = new Set(draft.blocks.filter((b) => keys.includes(b.key)).map((b) => b.block.id));
  const kept = draft.blocks.filter((b) => !keys.includes(b.key)).map((b) => {
    if (b.block.continues === undefined || !ids.has(b.block.continues)) return b;
    const { continues: _, ...rest } = b.block;
    return { ...b, block: rest };
  });
  let next: Draft = {
    ...draft,
    ...(draft.start && ids.has(draft.start) ? { start: undefined } : {}),
    blocks: kept,
    // An overlay forgets a block taken out, as it follows a renamed one; one left with none keeps it, and the checks say so.
    overlays: draft.overlays.map((o) => {
      const amends = o.overlay.blocks;
      return amends.some((id) => !ids.has(id)) && amends.some((id) => ids.has(id)) ? { ...o, overlay: { ...o.overlay, blocks: amends.filter((id) => !ids.has(id)) } } : o;
    }),
  };
  const gone = (o: FlowOutcome) => o.to !== undefined && ids.has(o.to);
  for (const b of kept) next = withOutcomes(next, b.key, (outs, ks) => [outs.filter((o) => !gone(o)), ks.filter((_, i) => !gone(outs[i]!))]);
  return next;
}

// --- Outcomes (#1184) ---------------------------------------------------------------------------------------------

/** A block's outcomes and their keys changed together; none left takes the field out. */
function withOutcomes(draft: Draft, key: string, change: (outs: FlowOutcome[], keys: string[]) => [FlowOutcome[], string[]]): Draft {
  let changed = false;
  const blocks = draft.blocks.map((b) => {
    if (b.key !== key) return b;
    const before = b.block.outcomes ?? [];
    const [outs, keys] = change([...before], [...outcomeKeys(b)]);
    if (sameValue(outs, before)) return b;
    changed = true;
    const { outcomes: _, ...rest } = b.block;
    return { ...b, block: outs.length ? { ...rest, outcomes: outs } : rest, outs: keys };
  });
  return changed ? { ...draft, blocks } : draft;
}

/**
 * A new outcome at the end of a block's, leading `to` a block; its word is asked for in the panel (an empty one keeps
 * the flow from being saved until it is given). Drawing one from block to block makes one this way. With no `to`, a
 * pin named and not yet drawn to a block (#446): "+ outcome" makes one so.
 */
export function addOutcome(given: Draft, key: string, to: string | undefined, word = ''): { draft: Draft; index: number } {
  const entry = given.blocks.find((b) => b.key === key);
  if (!entry) return { draft: given, index: -1 };
  const draft = pinned(given);
  const index = entry.block.outcomes?.length ?? 0;
  const next = withOutcomes(draft, key, (outs, keys) => [[...outs, { word, ...(to === undefined ? {} : { to }) }], [...keys, `n${draft.seq}`]]);
  return { draft: { ...next, seq: draft.seq + 1 }, index };
}

/**
 * An outcome's pin drawn to a block (#446): that outcome now leads there, whether it led nowhere yet or elsewhere.
 * The canvas keeps every block where it is.
 */
export function wireOutcome(given: Draft, key: string, index: number, to: string): Draft {
  const was = given.blocks.find((b) => b.key === key)?.block.outcomes?.[index];
  if (!was || was.to === to) return given;
  // Drawn to a block, it no longer ends the flow (#447).
  return setOutcome(pinned(given), key, index, { to, end: undefined });
}

/** An outcome drawn from one block to another (the canvas): a new one, its word to be given; none to itself. */
export function connect(draft: Draft, from: string, to: string): { draft: Draft; key: string; index: number } | null {
  const entry = draft.blocks.find((b) => b.block.id === from);
  if (!entry || from === to) return null;
  const made = addOutcome(draft, entry.key, to);
  return { draft: made.draft, key: entry.key, index: made.index };
}

/** Sets an outcome's fields: its word, where it goes, its count (undefined takes the count, or the way, out). */
export function setOutcome(draft: Draft, key: string, index: number, patch: Partial<FlowOutcome>): Draft {
  return withOutcomes(draft, key, (outs, keys) => {
    const was = outs[index];
    if (!was) return [outs, keys];
    const o = { ...was, ...patch };
    if (o.times === undefined) delete o.times;
    if (o.to === undefined) delete o.to;
    if (o.end === undefined) delete o.end;
    outs[index] = o;
    return [outs, keys];
  });
}

/** Takes an outcome out; the canvas keeps every block where it is. */
export function deleteOutcome(given: Draft, key: string, index: number): Draft {
  return withOutcomes(pinned(given), key, (outs, keys) => [outs.filter((_, i) => i !== index), keys.filter((_, i) => i !== index)]);
}

export function moveBlock(given: Draft, key: string, at: { x: number; y: number }): Draft {
  const draft = pinned(given);
  return { ...draft, blocks: draft.blocks.map((b) => (b.key === key ? { ...b, block: { ...b.block, at: { x: Math.round(at.x), y: Math.round(at.y) } } } : b)) };
}

/**
 * Auto-arrange: every block where the layout puts it with no positions, and kept there. A frame (#446) is fitted round
 * the blocks it held, wherever they went; one that held none stays where it was.
 */
export function arrange(draft: Draft): Draft {
  const members = new Map(draft.frames.map((f) => [f.key, frameMembers(draft, f.frame)]));
  const loose = { ...draft, blocks: draft.blocks.map((b) => ({ ...b, block: { ...b.block, at: undefined } })) };
  const at = placesOf(loose);
  const arranged = { ...draft, blocks: loose.blocks.map((b) => ({ ...b, block: { ...b.block, at: at(b.block) } })) };
  return {
    ...arranged,
    frames: draft.frames.map((f) => {
      const box = boxRound(arranged, members.get(f.key)!);
      return box ? { ...f, frame: { ...f.frame, ...box } } : f;
    }),
  };
}

/**
 * A new text's path: `folder`/<name>.md, the name made safe (`fallback` when nothing is left of it); a problem in words
 * when it can't be one or is already there (letter case aside: Windows and macOS see one file).
 */
function newTextFile(draft: Draft, folder: 'briefs' | 'overlays', name: string, fallback: string): { file: string } | string {
  const file = textPath(folder, name, fallback);
  if (!WRITABLE_FLOW_FILE.test(file)) return `${file} is not a name a brief can have.`;
  if (textThere(draft, file)) return `${file} is already there: pick it from the list.`;
  return { file };
}

function textPath(folder: 'briefs' | 'overlays', name: string, fallback: string): string {
  const stem = (s: string) => s.trim().replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 76);
  return `${folder}/${stem(name) || stem(fallback) || 'brief'}.md`;
}

/** The text already in the draft at `file`, letter case aside, by its own path; undefined when there is none. */
const textThere = (draft: Draft, file: string) => Object.keys(draft.texts).find((f) => f.toLowerCase() === file.toLowerCase());

/**
 * An overlay's text: the one already at that path when nothing in the flow links it (taken out and added again finds
 * its text), else a new one, numbered past those another part uses, so two never share a text unasked (review of
 * #318, finding 1).
 */
function textFor(draft: Draft, folder: 'overlays', name: string, fallback: string, heading: string): { file: string; texts: Record<string, string> } | string {
  const first = textPath(folder, name, fallback);
  if (!WRITABLE_FLOW_FILE.test(first)) return `${first} is not a name a brief can have.`;
  const linked = new Set(linkedTexts(flowOf(draft)).map((f) => f.toLowerCase()));
  for (let n = 1; n < 1000; n++) {
    const file = n === 1 ? first : first.replace(/\.md$/, `-${n}.md`);
    if (linked.has(file.toLowerCase()) || !WRITABLE_FLOW_FILE.test(file)) continue;
    const there = textThere(draft, file);
    return there ? { file: there, texts: draft.texts } : { file, texts: { ...draft.texts, [file]: `# ${heading}\n\n` } };
  }
  return `${first} and the names after it are taken.`;
}

/** A new brief for a block: briefs/<name>.md, started with its title; refused when that file is already there. */
export function newBrief(draft: Draft, key: string, name: string): Draft | string {
  const block = draft.blocks.find((b) => b.key === key)?.block;
  if (!block) return draft;
  const made = newTextFile(draft, 'briefs', name, block.id);
  if (typeof made === 'string') return made;
  return setBlock({ ...draft, texts: { ...draft.texts, [made.file]: `# ${block.title}\n\n` } }, key, { brief: made.file });
}

// --- The manager's file (#322) ------------------------------------------------------------------------------------

/** Names the manager's file (undefined: none); the file stays in the folder either way. */
export function setManager(draft: Draft, file: string | undefined): Draft {
  const { manager: _, ...rest } = draft;
  return file === undefined ? rest : { ...rest, manager: file };
}

/** The manager's file as manager.md: the one there when there is one, else a new one with a heading. */
export function newManagerFile(draft: Draft): Draft {
  const there = textThere(draft, MANAGER_FILE);
  if (there) return setManager(draft, there);
  return setManager({ ...draft, texts: { ...draft.texts, [MANAGER_FILE]: '# Manager\n\nWhat the manager does between steps:\n\n' } }, MANAGER_FILE);
}

// --- Sub-steps (#322) ---------------------------------------------------------------------------------------------

/** A sub-step's id made from its title: as a block's, unique among its block's sub-steps. */
export function substepIdFrom(words: string, block: FlowBlock, except?: number): string {
  const stem = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sub-step';
  const taken = new Set((block.substeps ?? []).filter((_, i) => i !== except).map((s) => s.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** A block's sub-steps and their keys changed together; none left takes the field out. */
function withSubsteps(draft: Draft, key: string, change: (subs: FlowSubstep[], keys: string[]) => [FlowSubstep[], string[]]): Draft {
  return {
    ...draft,
    blocks: draft.blocks.map((b) => {
      if (b.key !== key) return b;
      const [subs, keys] = change([...(b.block.substeps ?? [])], [...substepKeys(b)]);
      const { substeps: _, ...rest } = b.block;
      return { ...b, block: subs.length ? { ...rest, substeps: subs } : rest, subs: keys };
    }),
  };
}

/** A new sub-step at the end of a block's: a self-review check when its work is done, unless a piece of work is asked for. */
export function addSubstep(draft: Draft, key: string, kind: FlowSubstep['kind'] = 'check'): { draft: Draft; index: number } {
  const entry = draft.blocks.find((b) => b.key === key);
  if (!entry) return { draft, index: -1 };
  const title = kind === 'check' ? 'Self-review' : 'Sub-step';
  const sub: FlowSubstep = { id: substepIdFrom(title, entry.block), kind, title, when: 'done' };
  const index = entry.block.substeps?.length ?? 0;
  const next = withSubsteps(draft, key, (subs, keys) => [[...subs, sub], [...keys, `n${draft.seq}`]]);
  return { draft: { ...next, seq: draft.seq + 1 }, index };
}

/**
 * Sets a sub-step's fields (undefined takes one out). One made here keeps an id that follows its title until the id is
 * set by hand, as a new block's does.
 */
export function setSubstep(draft: Draft, key: string, index: number, patch: Partial<FlowSubstep>): Draft {
  const entry = draft.blocks.find((b) => b.key === key);
  const was = entry?.block.substeps?.[index];
  if (!entry || !was) return draft;
  const sub = { ...was, ...patch } as FlowSubstep;
  for (const k of Object.keys(patch) as (keyof FlowSubstep)[]) if (patch[k] === undefined) delete sub[k];
  const made = substepKeys(entry)[index]?.startsWith('n');
  if (made && patch.title !== undefined && patch.id === undefined && was.id === substepIdFrom(was.title, entry.block, index)) sub.id = substepIdFrom(patch.title, entry.block, index);
  return withSubsteps(draft, key, (subs, keys) => [subs.map((s, i) => (i === index ? sub : s)), keys]);
}

/** Moves a sub-step one place earlier (-1) or later (1): they run in list order. */
export function moveSubstep(draft: Draft, key: string, index: number, by: -1 | 1): Draft {
  const to = index + by;
  return withSubsteps(draft, key, (subs, keys) => {
    if (to < 0 || to >= subs.length || index < 0 || index >= subs.length) return [subs, keys];
    [subs[index], subs[to]] = [subs[to]!, subs[index]!];
    [keys[index], keys[to]] = [keys[to]!, keys[index]!];
    return [subs, keys];
  });
}

/** Takes a sub-step out; its brief stays in the folder. */
export function deleteSubstep(draft: Draft, key: string, index: number): Draft {
  const next = withSubsteps(draft, key, (subs, keys) => [subs.filter((_, i) => i !== index), keys.filter((_, i) => i !== index)]);
  // The last one gone, "run them at once" goes with it (part 3d, review): nothing is left to run at once.
  const b = next.blocks.find((x) => x.key === key)?.block;
  return b?.parallel && !b.substeps?.length ? setBlock(next, key, { parallel: undefined }) : next;
}

/** A new brief for a sub-step: briefs/<name>.md, started with its title. */
export function newSubstepBrief(draft: Draft, key: string, index: number, name: string): Draft | string {
  const sub = draft.blocks.find((b) => b.key === key)?.block.substeps?.[index];
  if (!sub) return draft;
  const made = newTextFile(draft, 'briefs', name, sub.id);
  if (typeof made === 'string') return made;
  return setSubstep({ ...draft, texts: { ...draft.texts, [made.file]: `# ${sub.title}\n\n` } }, key, index, { brief: made.file });
}

// --- Overlays (#318) ----------------------------------------------------------------------------------------------

/** An overlay's id made from its title: as a block's, unique among the overlays. */
export function overlayIdFrom(words: string, draft: Draft, except?: string): string {
  const stem = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'overlay';
  const taken = new Set(draft.overlays.filter((o) => o.key !== except).map((o) => o.overlay.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/**
 * A new overlay amending `blocks` (an overlay amends at least one), with a new text, overlays/<id>.md, started with
 * its title; the file already there is used when there is one.
 */
export function addOverlay(draft: Draft, title: string, blocks: string[]): { draft: Draft; key: string } | string {
  if (!title.trim()) return 'An overlay needs a title.';
  if (!blocks.length) return 'An overlay amends at least one block: add a block first.';
  const id = overlayIdFrom(title, draft);
  const made = textFor(draft, 'overlays', id, 'overlay', title);
  if (typeof made === 'string') return made;
  const key = `n${draft.seq}`;
  return { draft: { ...draft, overlays: [...draft.overlays, { key, overlay: { id, title, file: made.file, blocks } }], texts: made.texts, seq: draft.seq + 1 }, key };
}

/** Sets an overlay's fields; its blocks in the flow's order, so the file doesn't change with the clicking order. */
export function setOverlay(draft: Draft, key: string, patch: Partial<FlowOverlay>): Draft {
  const order = new Map(draft.blocks.map((b, i) => [b.block.id, i]));
  return {
    ...draft,
    overlays: draft.overlays.map((o) => {
      if (o.key !== key) return o;
      const overlay = { ...o.overlay, ...patch };
      if (patch.blocks) overlay.blocks = [...new Set(patch.blocks)].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
      return { ...o, overlay };
    }),
  };
}

/** Whether an overlay amends a block, switched; the last block stays, as an overlay amends at least one. */
export function toggleAmends(draft: Draft, key: string, block: string): Draft {
  const o = draft.overlays.find((x) => x.key === key)?.overlay;
  if (!o) return draft;
  const on = o.blocks.includes(block);
  if (on && o.blocks.length === 1) return draft;
  return setOverlay(draft, key, { blocks: on ? o.blocks.filter((id) => id !== block) : [...o.blocks, block] });
}

/** Takes an overlay out of the flow; its file stays in the folder. */
export function deleteOverlay(draft: Draft, key: string): Draft {
  return { ...draft, overlays: draft.overlays.filter((o) => o.key !== key) };
}

/** A new text for an overlay: overlays/<name>.md, started with its title. */
export function newOverlayFile(draft: Draft, key: string, name: string): Draft | string {
  const o = draft.overlays.find((x) => x.key === key)?.overlay;
  if (!o) return draft;
  const made = newTextFile(draft, 'overlays', name, o.id);
  if (typeof made === 'string') return made;
  return setOverlay({ ...draft, texts: { ...draft.texts, [made.file]: `# ${o.title}\n\n` } }, key, { file: made.file });
}

/** The overlays that amend each block, by block id, as their titles: for the canvas's badge. */
export function amendedBy(overlays: readonly FlowOverlay[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const o of overlays) {
    for (const id of o.blocks) {
      const titles = by.get(id);
      if (titles) titles.push(o.title);
      else by.set(id, [o.title]);
    }
  }
  return by;
}

// --- Comment frames (#446) ----------------------------------------------------------------------------------------

/** Room between a frame's edge and the blocks it is fitted round, and for its title bar above them. */
export const FRAME_PAD = 24;
export const FRAME_TITLE = 28;

/** Each block's box as drawn now, by key. */
function boxesOf(draft: Draft): Map<string, { x: number; y: number; width: number; height: number }> {
  const at = placesOf(draft);
  return new Map(draft.blocks.map((b) => [b.key, { ...(b.block.at ?? at(b.block)), ...blockSize(b.block) }]));
}

/** The blocks a frame holds, by key: those whose middle is inside it, where they are drawn now. */
export function frameMembers(draft: Draft, frame: FlowFrame): string[] {
  return [...boxesOf(draft)].filter(([, b]) => {
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    return x >= frame.at.x && x <= frame.at.x + frame.size.width && y >= frame.at.y && y <= frame.at.y + frame.size.height;
  }).map(([key]) => key);
}

/** A frame's place and size round blocks (by key), with room for its title; null for none. */
export function boxRound(draft: Draft, keys: readonly string[]): Pick<FlowFrame, 'at' | 'size'> | null {
  const boxes = [...boxesOf(draft)].filter(([key]) => keys.includes(key)).map(([, b]) => b);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b.x)) - FRAME_PAD;
  const top = Math.min(...boxes.map((b) => b.y)) - FRAME_PAD - FRAME_TITLE;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + FRAME_PAD;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + FRAME_PAD;
  return { at: { x: Math.round(left), y: Math.round(top) }, size: { width: Math.round(right - left), height: Math.round(bottom - top) } };
}

/** A frame's id made from its title: as a block's, unique among the frames. */
export function frameIdFrom(words: string, draft: Draft, except?: string): string {
  const stem = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'frame';
  const taken = new Set(draft.frames.filter((f) => f.key !== except).map((f) => f.frame.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/**
 * A new frame titled `title`: round the blocks given (by key), else at `at` in a size to start from. The blocks are
 * pinned where they are drawn, so the frame stays round them.
 */
export function addFrame(given: Draft, title: string, place: { blocks: string[] } | { at: { x: number; y: number } }): { draft: Draft; key: string } | string {
  if (!title.trim()) return 'A frame needs a title.';
  const draft = given.blocks.length ? pinned(given) : given;
  const box = ('blocks' in place ? boxRound(draft, place.blocks) : null)
    ?? { at: 'at' in place ? { x: Math.round(place.at.x), y: Math.round(place.at.y) } : { x: 0, y: 0 }, size: { width: 420, height: 260 } };
  const key = `n${draft.seq}`;
  return { draft: { ...draft, frames: [...draft.frames, { key, frame: { id: frameIdFrom(title, draft), title, ...box } }], seq: draft.seq + 1 }, key };
}

/** Sets a frame's fields (undefined takes the colour out); a place and size in whole pixels, at least 40 across. */
export function setFrame(draft: Draft, key: string, patch: Partial<FlowFrame>): Draft {
  return {
    ...draft,
    frames: draft.frames.map((f) => {
      if (f.key !== key) return f;
      const frame = { ...f.frame, ...patch } as FlowFrame;
      for (const k of Object.keys(patch) as (keyof FlowFrame)[]) if (patch[k] === undefined) delete frame[k];
      if (patch.at) frame.at = { x: Math.round(patch.at.x), y: Math.round(patch.at.y) };
      if (patch.size) frame.size = { width: Math.round(Math.max(40, patch.size.width)), height: Math.round(Math.max(40, patch.size.height)) };
      return sameValue(frame, f.frame) ? f : { ...f, frame };
    }),
  };
}

/** The frames wholly inside another (by key), which move with it: "Build" inside "Phase 1" (review of #446). */
export function framesInside(draft: Draft, key: string): string[] {
  const outer = draft.frames.find((f) => f.key === key)?.frame;
  if (!outer) return [];
  return draft.frames.filter((f) => f.key !== key && f.frame.at.x >= outer.at.x && f.frame.at.y >= outer.at.y
    && f.frame.at.x + f.frame.size.width <= outer.at.x + outer.size.width && f.frame.at.y + f.frame.size.height <= outer.at.y + outer.size.height).map((f) => f.key);
}

/**
 * Moves a frame to `at`, and what it held when the move began by as much: its blocks and the frames inside it (by
 * key), so a frame inside another keeps its blocks.
 */
export function moveFrame(given: Draft, key: string, at: { x: number; y: number }, held: { blocks: readonly string[]; frames: readonly string[] }): Draft {
  const was = given.frames.find((f) => f.key === key)?.frame;
  if (!was) return given;
  const dx = Math.round(at.x) - was.at.x;
  const dy = Math.round(at.y) - was.at.y;
  if (!dx && !dy) return given;
  const draft = pinned(given);
  const blocks = draft.blocks.map((b) => (held.blocks.includes(b.key) && b.block.at ? { ...b, block: { ...b.block, at: { x: b.block.at.x + dx, y: b.block.at.y + dy } } } : b));
  const frames = draft.frames.map((f) => (f.key === key || held.frames.includes(f.key) ? { ...f, frame: { ...f.frame, at: { x: f.frame.at.x + dx, y: f.frame.at.y + dy } } } : f));
  return { ...draft, blocks, frames };
}

/** Takes a frame out; its blocks stay where they are. */
export function deleteFrame(draft: Draft, key: string): Draft {
  return { ...draft, frames: draft.frames.filter((f) => f.key !== key) };
}

/** The kinds the palette offers, in its order. */
export const PALETTE: readonly BlockKind[] = BLOCK_KINDS;

// --- Several flows (#447) -----------------------------------------------------------------------------------------

/** A flow being edited: the default one (flow.json, "main") or another (flows/<name>.json). */
export interface DraftFlow {
  /** Stays when its name changes, as a block's key does. */
  key: string;
  /** What a Run flow block names it by; its file is flows/<name>.json, or flow.json for "main". */
  name: string;
  /** A flow made here: its name follows its title until the name is set by hand. */
  autoName?: boolean;
  /** The file it was read from; null for one made here. */
  read: string | null;
  base: DraftBase;
  /** Its texts and rules are the workspace's, the same in every flow's draft (withDraft keeps them so). */
  draft: Draft;
}

/** Every flow of a project being edited (#447), the default one first. */
export interface Workspace {
  flows: DraftFlow[];
  /** The other flows' files as read: a save removes one no flow has any more. */
  read: string[];
  /** Numbers the keys of the flows made here. */
  seq: number;
}

/**
 * The workspace a split-off saves (workflow-origin.md, section 2): its default flow with the origin the server worked
 * out (the remote left out when the person ticked so), and the original's author and release moved into it, so the
 * copy claims neither.
 */
export function withOrigin(ws: Workspace, origin: FlowOrigin, from: { author?: string; release?: number } = origin): Workspace {
  const [first, ...rest] = ws.flows;
  if (!first) return ws;
  const { author, release, origin: _, ...draft } = first.draft;
  // `from`: the original's own credit, when the origin can't carry it (an older copy whose version isn't known, review of part d).
  const own = ownCredit({ ...(author !== undefined ? { author } : {}), ...(release !== undefined ? { release } : {}) }, { title: origin.title, ...from });
  return { ...ws, flows: [{ ...first, draft: { ...draft, ...own, origin } }, ...rest] };
}

/** The flow's own author or release set, or taken out when empty (workflow-origin.md: the builder offers both). */
export function setCredit(ws: Workspace, key: string, patch: { author?: string | undefined; release?: number | undefined }): Workspace {
  const f = ws.flows.find((x) => x.key === key);
  if (!f) return ws;
  const next: Draft = { ...f.draft, ...patch };
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined) delete next[k];
  return withDraft(ws, key, next);
}

/** A workspace of one flow: a project as it was before #447. */
export function single(base: DraftBase, draft: Draft): Workspace {
  return { flows: [{ key: 'w0', name: DEFAULT_FLOW, read: base.rawText === null ? null : FLOW_FILE, base, draft }], read: [], seq: 1 };
}

/** The workspace of a view's flows; null when one of them can't be read as a flow, as the builder can't open it then. */
export function workspaceFromView(view: FlowView): Workspace | null {
  const main = draftFromView(view);
  if (!main) return null;
  const others: DraftFlow[] = [];
  for (const [i, e] of view.flows.entries()) {
    const opened = draftFromView({ ...view, flow: e.flow, raw: e.raw });
    if (!opened) return null;
    others.push({ key: `w${i + 1}`, name: e.name, read: e.file, base: opened.base, draft: { ...opened.draft, texts: main.draft.texts } });
  }
  return { flows: [{ key: 'w0', name: DEFAULT_FLOW, read: FLOW_FILE, ...main }, ...others], read: view.flows.map((e) => e.file), seq: view.flows.length + 1 };
}

/** A workspace with a flow's draft changed; a change to the texts or rules is every flow's, as they share them. */
export function withDraft(ws: Workspace, key: string, draft: Draft): Workspace {
  const was = ws.flows.find((f) => f.key === key);
  if (!was || was.draft === draft) return ws;
  const shared = draft.texts !== was.draft.texts || draft.rules !== was.draft.rules;
  return {
    ...ws,
    flows: ws.flows.map((f) => (f.key === key ? { ...f, draft } : shared ? { ...f, draft: { ...f.draft, texts: draft.texts, rules: draft.rules } } : f)),
  };
}

/**
 * A flow's name made from words: as a block's id, unique among the flows, never "main" (the default one's), and never
 * a name a Run flow block runs that no flow has (review of #447): a name made while typing a title would take that
 * block over unasked.
 */
export function flowNameFrom(words: string, ws: Workspace, except?: string): string {
  const stem = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'flow';
  const own = ws.flows.find((f) => f.key === except)?.name;
  const run = ws.flows.flatMap((f) => f.draft.blocks.flatMap((b) => (b.block.kind === 'flow' && b.block.flow !== undefined && b.block.flow !== own ? [b.block.flow] : [])));
  const taken = new Set([DEFAULT_FLOW, ...run, ...ws.flows.filter((f) => f.key !== except).map((f) => f.name)]);
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** Why a name can't be a flow's, or null when it can. */
export function flowNameProblem(name: string, ws: Workspace, key: string): string | null {
  if (!FLOW_IN_FOLDER.test(`flows/${name}.json`)) return 'Lower case letters, digits and "-" (at most 48), starting with a letter or digit.';
  if (name === DEFAULT_FLOW) return `"${DEFAULT_FLOW}" is the default flow's name.`;
  if (ws.flows.some((f) => f.key !== key && f.name === name)) return `Another flow is "${name}" already.`;
  return null;
}

/** A new flow titled `title`, with one block to start from; it shares the texts and rules. */
export function addFlow(ws: Workspace, title: string): { ws: Workspace; key: string } | string {
  if (!title.trim()) return 'A flow needs a title.';
  const first = ws.flows[0]!;
  const base: DraftBase = { raw: null, rawText: null, parsed: null, rules: first.base.rules, texts: first.base.texts, versions: first.base.versions, copy: first.base.copy };
  const empty: Draft = { title, blocks: [], overlays: [], frames: [], rules: first.draft.rules, texts: first.draft.texts, seq: 0 };
  const draft = addBlock(empty, 'work', { x: 0, y: 0 }).draft;
  const key = `w${ws.seq}`;
  return { ws: { ...ws, flows: [...ws.flows, { key, name: flowNameFrom(title, ws), autoName: true, read: null, base, draft }], seq: ws.seq + 1 }, key };
}

/** Renames a flow (never the default one): the Run flow blocks of every flow that ran it run it by its new name. */
export function renameFlow(ws: Workspace, key: string, name: string, autoName = false): Workspace {
  const was = ws.flows.find((f) => f.key === key);
  if (!was || was.key === ws.flows[0]!.key || (was.name === name && !!was.autoName === autoName)) return ws;
  const flows = ws.flows.map((f) => {
    let draft = f.draft;
    for (const b of f.draft.blocks) if (b.block.kind === 'flow' && b.block.flow === was.name) draft = setBlock(draft, b.key, { flow: name });
    const next = draft === f.draft ? f : { ...f, draft };
    if (f.key !== key) return next;
    const { autoName: _, ...rest } = next;
    return { ...rest, name, ...(autoName ? { autoName } : {}) };
  });
  return { ...ws, flows };
}

/** Sets a flow's title; a flow made here keeps a name that follows it until the name is set by hand. */
export function setFlowTitle(ws: Workspace, key: string, title: string | undefined): Workspace {
  const f = ws.flows.find((x) => x.key === key);
  if (!f) return ws;
  const { title: _, ...rest } = f.draft;
  const titled = withDraft(ws, key, title === undefined ? rest : { ...rest, title });
  return f.autoName && title?.trim() ? renameFlow(titled, key, flowNameFrom(title, titled, key), true) : titled;
}

/** Takes a flow out (never the default one); a Run flow block that ran it then runs a flow that isn't there. */
export function deleteFlow(ws: Workspace, key: string): Workspace {
  if (key === ws.flows[0]?.key) return ws;
  return { ...ws, flows: ws.flows.filter((f) => f.key !== key) };
}

/** Each flow's problems, by its key: its own checks and those between the flows (#447). */
export function workspaceProblems(ws: Workspace, profiles?: readonly string[]): Map<string, FlowProblem[]> {
  const parsed = ws.flows.map((f) => ({ f, flow: f.draft.blocks.length ? parseFlow(flowText(f.base, f.draft)).flow : null }));
  const all = new Map(parsed.map(({ f, flow }) => [f.name, flow]));
  // A Run flow block whose flow a person decides in limits a loop as a person does (#447).
  const gated = personGatedFlows(all);
  const each = parsed.map(({ f, flow }) => ({ f, flow, own: draftProblems(f.base, f.draft, profiles, gated) }));
  const calls = checkFlowCalls(all);
  return new Map(each.map(({ f, own, flow }, i) => [f.key, [
    ...own,
    ...(i > 0 && flow?.manager !== undefined ? [{ at: 'manager', message: `The manager's file is named by the default flow for all flows: take it out of "${f.draft.title ?? f.name}".` }] : []),
    ...(ws.flows.some((x) => x.key !== f.key && x.name === f.name) ? [{ at: 'name', message: `Two flows are named "${f.name}": give each its own.` }] : []),
    ...(calls.get(f.name) ?? []),
  ]]));
}

/** Whether a save can't be made: a flow that would not be a flow. */
export function workspaceBlocksSaving(ws: Workspace): boolean {
  return ws.flows.some((f) => blocksSaving(f.base, f.draft));
}

/** A Run flow block's outcomes for each way its flow ends that it has none for yet (#447), each a pin to draw. */
export function addEndings(given: Draft, key: string, endings: readonly string[]): Draft {
  const entry = given.blocks.find((b) => b.key === key);
  if (!entry) return given;
  const had = new Set((entry.block.outcomes ?? []).map((o) => o.word.trim().toLowerCase()));
  let draft = given;
  for (const e of endings) if (!had.has(e.trim().toLowerCase())) draft = addOutcome(draft, key, undefined, e).draft;
  return draft;
}
