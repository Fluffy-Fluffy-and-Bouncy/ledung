// A project's workflow drawn as blocks and arrows (issue #310, docs/steps/workflow-builder.md, part 1): the shapes
// the page draws. The file's schema and its checks are in src/shared/flow-check.ts; these types are what it gives.
// The arrows are each block's outcomes (Simon, 2026-10-26, questions #1184, #1185): a word, where it leads, and
// optionally on which occurrence of that word it is taken instead ("Failed, the 3rd time → a person").
import type { NameColour } from './name-colours.ts';

/** The folder a project's flow lives in, inside its repository (decision 3). */
export const FLOW_FOLDER = '.ledung/workflow';
export const FLOW_FILE = 'flow.json';
/** The project's other flows (#447): `flows/<name>.json` beside flow.json, which is the default flow. */
export const FLOWS_FOLDER = 'flows';
/** The default flow's name (#447), for a Run flow block that runs it; so no file in flows/ may have it. */
export const DEFAULT_FLOW = 'main';
/** A flow's file in flows/ by its name: lower case, digits and "-", as a block's id (#447). */
export const FLOW_IN_FOLDER = /^flows\/([a-z0-9][a-z0-9-]{0,47})\.json$/;
/** The file a flow is in, by its name. */
export const flowFileOf = (name: string): string => (name === DEFAULT_FLOW ? FLOW_FILE : `${FLOWS_FOLDER}/${name}.json`);
export const RULES_FILE = 'rules.md';
/** Where the builder keeps the manager's standing procedures (#322); a flow may name another file in `manager`. */
export const MANAGER_FILE = 'manager.md';

/** `flow`: a Run flow block (#447), which starts another flow for a piece of work of its own and waits for its end. */
export const BLOCK_KINDS = ['work', 'check', 'person', 'fork', 'join', 'timer', 'flow'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * Who does a block's step (#322): the manager itself, a person, a new session, or the session of an earlier block
 * (`continues`: Fix continues Build, so the builder fixes its own work). What the one doing it is told is the brief.
 */
export const RUNS = ['manager', 'person', 'new-session', 'continue'] as const;
export type Runs = (typeof RUNS)[number];

/**
 * One way out of a block (#1184): when the result is `word` (as the manager reads it, not a string Ledung matches), the
 * work goes `to` that block; with `times`, only on that occurrence of the word for one piece of work, which Ledung
 * counts (part 3), the plain one taking the others ("Failed → Planner", "Failed, the 3rd time → Person").
 */
export interface FlowOutcome {
  word: string;
  /** None: named, its pin not yet drawn to a block (#446); the checks ask where it leads. */
  to?: string;
  times?: number;
  /** It ends the flow, with its word as how the flow ended (#447), instead of leading to a block. */
  end?: true;
}

export const SUBSTEP_KINDS = ['work', 'check'] as const;
/** When a sub-step runs in its block: as it starts, when the block's own work is done, or where the brief says. */
export const SUBSTEP_WHEN = ['start', 'done', 'brief'] as const;
/**
 * Where a sub-step's outcome leads (#1185): a subagent returns to whoever started it, so only inside its block. "done":
 * it is done and the block goes on; "owner": back to the block's one, who fixes what it found, and it runs again;
 * "report": what is left goes with the block's outcome; "ask-manager": the manager is asked.
 */
export const SUBSTEP_TO = ['done', 'owner', 'report', 'ask-manager'] as const;
export type SubstepTo = (typeof SUBSTEP_TO)[number];

export interface FlowSubstepOutcome {
  word: string;
  to: SubstepTo;
  times?: number;
}

/**
 * A subagent the one running a block starts (#322): it returns to whoever started it, so it lives inside its block and
 * owns no session or sub-steps of its own. A block's sub-steps run in list order; its outcome counts only after those
 * that run when it is done.
 */
export interface FlowSubstep {
  /** Unique in its block: lower case, digits and "-". */
  id: string;
  kind: (typeof SUBSTEP_KINDS)[number];
  title: string;
  /** How the subagent acts, as a block's brief: "briefs/reviewer.md" makes it a reviewer. */
  brief?: string;
  model?: string;
  /** None: when the block's work is done. */
  when?: (typeof SUBSTEP_WHEN)[number];
  outcomes?: FlowSubstepOutcome[];
}

export interface FlowBlock {
  /** Its name in the file, which outcomes use: lower case, digits and "-". */
  id: string;
  kind: BlockKind;
  /** Its name in the diagram. */
  title: string;
  /** Who does it (#322); a person block is a person's. */
  runs?: Runs;
  /** For `runs: "continue"`: the earlier block whose session takes this step too. */
  continues?: string;
  /** For a session: the model and session profile it starts with, by name. */
  model?: string;
  profile?: string;
  /** How the one doing the step acts, as markdown inside the workflow folder: "briefs/builder.md" makes a builder. Blocks may share one. */
  brief?: string;
  /** The subagents its one starts, in the order they run (#322). */
  substeps?: FlowSubstep[];
  /** Where the work goes next, by result (#1184); a person block's are the answers it offers. None: the work ends here. */
  outcomes?: FlowOutcome[];
  /** For a person block: a question (ask_user) or a review page. */
  ask?: 'question' | 'review';
  /** For a timer block: on a count ("every 30 merges") or a clock ("daily"). */
  timer?: { every: number; of: string } | { clock: 'hourly' | 'daily' | 'weekly' };
  /** For a Run flow block (#447): the name of the flow it runs ("main" for the default one). */
  flow?: string;
  /** Where the canvas puts it (part 2); none: laid out automatically. */
  at?: { x: number; y: number };
}

/** Switchable additions that change several blocks at once (agent-workflow's modules); its text in `file`. */
export interface FlowOverlay {
  id: string;
  title: string;
  file: string;
  blocks: string[];
}

/**
 * A comment frame (#446): a titled, coloured rectangle drawn behind the blocks it holds ("Planning", "Building"), as
 * in Unreal Blueprints. Its blocks are those whose middle is inside it; moving it in the builder moves them. Only for
 * people reading the diagram: the checks and the manager's reading of the flow pass it by.
 */
export interface FlowFrame {
  id: string;
  title: string;
  /** One of the name colours (src/shared/name-colours.ts); none: the page's own border colour. */
  colour?: NameColour;
  /** Its top-left corner and size on the canvas, as a block's `at`. */
  at: { x: number; y: number };
  size: { width: number; height: number };
}

export interface Flow {
  version: 1;
  title?: string;
  /** Where work enters; none: the first block. Timer blocks start on their own. */
  start?: string;
  /**
   * The manager's standing procedures between steps (status briefs, sweeps, the question format), a markdown file in
   * the workflow folder (issue #322, port finding 1); named in the manager's instructions. None: no such file.
   */
  manager?: string;
  blocks: FlowBlock[];
  overlays: FlowOverlay[];
  /** Comment frames round groups of blocks (#446); none: an empty list. */
  frames: FlowFrame[];
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${end}`;
}

/** An outcome's name as everyone sees it: its word, and the count as part of it ("Failed (3rd time)"). */
export const outcomeName = (o: { word: string; times?: number }): string => (o.times ? `${o.word} (${ordinal(o.times)} time)` : o.word);

/** An arrow of the drawn flow: one block's outcome. */
export interface DrawnArrow {
  from: string;
  to: string;
  word: string;
  times?: number;
  /** Its place in the block's outcomes. */
  index: number;
}

/**
 * How a flow can end (#447), each word once: the words of the outcomes that end it, and the title of each block with
 * no outcomes (a flow written before #447 ends there). A Run flow block's outcomes are these words of the flow it runs.
 */
export function flowEndings(flow: Flow): string[] {
  const words = flow.blocks.flatMap((b) => (b.outcomes?.length ? b.outcomes.filter((o) => o.end).map((o) => o.word) : [b.title]));
  const seen = new Set<string>();
  return words.filter((w) => {
    const k = endingKey(w);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** An ending's word as it is matched to a Run flow block's outcome: letter case and spaces at the ends aside (#447). */
export const endingKey = (word: string): string => word.trim().toLowerCase();

/** Every arrow the diagram draws: the blocks' outcomes that lead somewhere, in order (#446: a pin not drawn yet has none). */
export function drawnArrows(flow: Flow): DrawnArrow[] {
  return flow.blocks.flatMap((b) => (b.outcomes ?? []).flatMap((o, index) => (o.to === undefined ? [] : [{ from: b.id, to: o.to, word: o.word, ...(o.times ? { times: o.times } : {}), index }])));
}

/** The texts a flow links, each once: the manager's file, block and sub-step briefs, overlay files (#318, #322). */
export function linkedTexts(flow: Flow): string[] {
  return [...new Set([
    ...(flow.manager ? [flow.manager] : []),
    ...flow.blocks.flatMap((b) => [...(b.brief ? [b.brief] : []), ...(b.substeps ?? []).flatMap((s) => (s.brief ? [s.brief] : []))]),
    ...flow.overlays.map((o) => o.file),
  ])];
}

/** Whether a block runs as a session of its own or an earlier block's: what `continues` may point at (#322). */
export const runsSession = (b: FlowBlock | undefined): boolean => b?.runs === 'new-session' || b?.runs === 'continue';

/** Something wrong with a flow's files, where it is ("blocks.build.brief") and in words; a hint doesn't keep a save. */
export interface FlowProblem {
  at: string;
  message: string;
  /** A suggestion rather than a fault (#1184): shown apart, and saving doesn't ask about it. */
  hint?: boolean;
}

/** A flow other than the default one (#447), as read from flows/<name>.json. */
export interface FlowEntry {
  /** Its file's name without .json: what a Run flow block names. */
  name: string;
  /** Its path in the workflow folder: flows/<name>.json. */
  file: string;
  /** Null: it can't be read as a flow (its problems say why). */
  flow: Flow | null;
  /** As written, for the builder's write-back; null when it can't be read. */
  raw: string | null;
  problems: FlowProblem[];
}

/** What GET /api/projects/:name/flow gives the workflow page. */
export interface FlowView {
  project: string;
  /** Where the files are, as a person reads it: the project's own folder, or a shared workflow's (#21, #132). */
  source: { kind: 'project' | 'workflow'; folder: string; workflow?: string } | null;
  /** Where a project's flow goes, for the empty state. */
  expected: string;
  /** Null: no flow.json, or one that can't be read as a flow (problems say why). */
  flow: Flow | null;
  rules: string | null;
  /** The linked briefs and overlay texts that were found, and the other .md files in briefs/ and overlays/, by their path in the workflow folder. */
  texts: Record<string, string>;
  problems: FlowProblem[];
  /** flow.json as written, so the builder (#311) writes back fields this Ledung doesn't know and $comment; null: none. */
  raw: string | null;
  /** Each file read (flow.json, rules.md, the texts) by its path, as a short hash: a save names what it replaces (#311). */
  versions: Record<string, string>;
  /** The folder the builder saves into: always the project's own, never a shared workflow's (#311). */
  saveTo: string | null;
  /**
   * The project's other flows (#447), by name; `flow`, `raw` and `problems` above are the default flow's (flow.json),
   * with the problems of what all share (the rules, the texts).
   */
  flows: FlowEntry[];
}

/**
 * One file the builder saves (POST /api/projects/:name/flow, #311): `base` the version it replaces, null for a new file.
 * With `remove`, the file is taken away instead (#447): only a flow in flows/, deleted or renamed, and only the version read.
 */
export type FlowFileWrite = { path: string; text: string; base: string | null; remove?: undefined } | { path: string; remove: true; base: string; text?: undefined };

/** The folders of the flow's texts, which the builder lists and writes: briefs and overlays (#311). */
export const FLOW_TEXT_FOLDERS = ['briefs', 'overlays'] as const;

/** A text the builder lists and writes: a .md file directly in one of those folders, or manager.md (#322), by its path in the workflow folder. */
export const FLOW_TEXT_FILE = /^(?:manager\.md|(?:briefs|overlays)\/(?!\.)[A-Za-z0-9_. -]{1,80}\.md)$/;

/** The files the builder may write in the workflow folder: the ones the format knows (#311, #322). */
export const WRITABLE_FLOW_FILE = /^(?:flow\.json|rules\.md|manager\.md|(?:briefs|overlays)\/(?!\.)[A-Za-z0-9_. -]{1,80}\.md|flows\/[a-z0-9][a-z0-9-]{0,47}\.json)$/;
