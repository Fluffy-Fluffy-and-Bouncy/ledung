// A project's workflow as a flow of blocks and arrows (issue #310, docs/steps/workflow-builder.md, part 1, approved
// by Simon 2026-10-23, question #1072): the schema of .ledung/workflow/flow.json and the checks the design names.
// Written by hand now and by the builder later (part 2), so the problems are in words a person can act on. Nothing in
// the files may be tied to one computer (part 6, sharing is copying the folder): paths are relative to the workflow
// folder, models and profiles go by name. Shared with the page, so the builder's live checks are the server's (#311).
// Arrows are each block's outcomes (questions #1184, #1185): a loop is limited by an outcome with a count or a person.
// Comment frames (#446) are for the people reading the diagram: checked as a format, passed by by the flow's checks.
// A project may have several flows, and a Run flow block runs another (#447): checkFlowCalls checks them together.
import { z } from 'zod';
import { NAME_COLOURS } from './name-colours.ts';
import { STOPPED_ENDING, BLOCK_KINDS, DEFAULT_FLOW, drawnArrows, endingKey, flowEndings, FLOW_FILE, outcomeName, RUNS, runsSession, SUBSTEP_KINDS, SUBSTEP_TO, SUBSTEP_WHEN, type DrawnArrow, type Flow, type FlowBlock, type FlowProblem } from './flow.ts';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const Id = z.string().regex(ID, 'is lower case letters, digits and "-" (at most 48), starting with a letter or digit');

/**
 * A path inside the workflow folder: plain names joined by "/", no "." or ".." part, no drive, nothing a URL would
 * decode. The reader relies on it as well as on resolving links (src/sessions/files.ts), so a brief can't name a file
 * outside the folder.
 */
const SAFE_PATH = /^(?![\s\S]*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*$/;
const MarkdownPath = z.string().max(200).regex(SAFE_PATH, 'is a path inside the workflow folder, such as briefs/review.md: no absolute path, "..", "\\" or drive')
  .refine((p) => /\.md$/i.test(p), 'is a markdown file (.md)');

/**
 * ledung#111: a brief may name a file in the folder the workflow folder is in, "folder:process/briefs/review.md": a
 * shared workflow's own folder (or the project's), so a process whose briefs live beside its .ledung/workflow needn't
 * copy them. The same rules as SAFE_PATH after the prefix, and the readers keep it inside that folder.
 */
export const FOLDER_PREFIX = 'folder:';
/** A brief's path in the folder the workflow folder is in, for "folder:…"; null for a path in the workflow folder. */
export const inFolder = (p: string): string | null => (p.startsWith(FOLDER_PREFIX) ? p.slice(FOLDER_PREFIX.length) : null);
/** A brief that isn't there, said where it was looked for (review of PR #136). */
const missingBrief = (brief: string) => {
  const rest = inFolder(brief);
  return rest === null ? `The brief ${brief} is not in the workflow folder.` : `The brief ${rest} is not in the folder the workflow folder is in.`;
};
const BriefPath = z.string().max(200)
  .refine((p) => SAFE_PATH.test(inFolder(p) ?? p), `is a path inside the workflow folder, such as briefs/review.md, or inside the folder it is in, such as ${FOLDER_PREFIX}process/briefs/review.md: no absolute path, "..", "\\" or drive`)
  .refine((p) => /\.md$/i.test(p), 'is a markdown file (.md)');

// Not trimmed: the builder (part 2) writes back what it read, so a value stays as it was written (review of #310).
const Text = (max: number) => z.string().max(max).refine((t) => t.trim().length > 0, 'is empty');
const Comment = z.string().optional();

const Timer = z.union([
  z.object({ every: z.number().int().min(1).max(100000), of: Text(40) }),
  z.object({ clock: z.enum(['hourly', 'daily', 'weekly']) }),
], { message: 'is { "every": 30, "of": "merges" } or { "clock": "daily" } (hourly, daily or weekly)' });

/** "The 3rd time": on which occurrence of its word, for one piece of work, an outcome is taken (#1184). */
const Times = z.number().int().min(1).max(100);

/**
 * One way out of a block (#1184): its word, where it leads, and optionally on which occurrence of the word. `to` may
 * wait while the outcome's pin is named and not yet drawn to a block (#446); the checks ask for it.
 */
const Outcome = z.object({
  $comment: Comment,
  word: Text(80),
  to: Id.optional(),
  times: Times.optional(),
  /** It ends the flow with its word (#447), instead of leading to a block. */
  end: z.literal(true, { message: 'is true (the outcome ends the flow) or left out' }).optional(),
});

/** A sub-step's outcome (#1185): it stays inside its block, so it leads to "done", "owner", "report" or "ask-manager". */
const SubstepOutcome = z.object({
  $comment: Comment,
  word: Text(80),
  to: z.enum(SUBSTEP_TO, { message: 'is "done" (the block goes on), "owner" (the block\'s one fixes it, and it runs again), "report" (with the block\'s outcome) or "ask-manager"' }),
  times: Times.optional(),
});

/** A subagent inside its block (#322): no session, no sub-steps of its own (those are said as problems, not fields). */
const Substep = z.object({
  $comment: Comment,
  id: Id,
  kind: z.enum(SUBSTEP_KINDS, { message: 'is "work" or "check": a subagent\'s piece of work, or its check of the block\'s work' }),
  title: Text(80),
  brief: BriefPath.optional(),
  model: Text(80).optional(),
  when: z.enum(SUBSTEP_WHEN, { message: 'is "start", "done" (when the block\'s own work is done) or "brief" (where the brief says)' }).optional(),
  outcomes: z.array(SubstepOutcome).max(20).optional(),
});

const Block = z.object({
  $comment: Comment,
  id: Id,
  kind: z.enum(BLOCK_KINDS, { message: `is one of ${BLOCK_KINDS.join(', ')}` }),
  title: Text(80),
  runs: z.enum(RUNS, { message: 'is "manager", "person", "new-session" or "continue" (with "continues": the block whose session it is)' }).optional(),
  continues: Id.optional(),
  model: Text(80).optional(),
  profile: Text(48).optional(),
  brief: BriefPath.optional(),
  substeps: z.array(Substep).max(20).optional(),
  outcomes: z.array(Outcome).max(50).optional(),
  ask: z.enum(['question', 'review'], { message: 'is "question" (ask_user) or "review" (a review page)' }).optional(),
  timer: Timer.optional(),
  /** A Run flow block's flow (#447), by name. */
  flow: Id.optional(),
  /** Part 3f: runs in the block at once; a continued session compacted or cleared first. */
  limit: z.number().int().min(1).max(100).optional(),
  context: z.enum(['compact', 'clear'], { message: 'is "compact" or "clear" (its session is made fresh before the step) or left out' }).optional(),
  /** Part 3d: whose call a person block is, sub-steps run at once, a Run flow block handing on the caller's session. */
  person: Text(80).optional(),
  parallel: z.literal(true, { message: 'is true (its sub-steps run at once) or left out' }).optional(),
  session: z.literal('caller', { message: 'is "caller" (the flow it runs continues the session before it) or left out' }).optional(),
  at: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});

const Overlay = z.object({
  $comment: Comment,
  id: Id,
  title: Text(80),
  file: MarkdownPath,
  blocks: z.array(Id).min(1).max(200),
});

/** A comment frame (#446): a titled rectangle round blocks, in a name colour. */
const Frame = z.object({
  $comment: Comment,
  id: Id,
  title: Text(80),
  colour: z.enum(Object.keys(NAME_COLOURS) as [keyof typeof NAME_COLOURS, ...(keyof typeof NAME_COLOURS)[]], { message: `is one of the name colours: ${Object.keys(NAME_COLOURS).join(', ')}` }).optional(),
  at: z.object({ x: z.number().finite(), y: z.number().finite() }),
  size: z.object({ width: z.number().finite().min(40).max(100000), height: z.number().finite().min(40).max(100000) }),
});

/** Endings by name, for a worktree's removal or tidying (part 3f). */
const Endings = z.array(Text(80)).min(1, 'names at least one ending (left out: on every ending)').max(30);
/** Never read by git as an option (review of 3f). */
const GitName = Text(100).refine((s) => !s.startsWith('-'), { message: "can't start with \"-\"" });
const Worktree = z.object({
  $comment: Comment,
  base: GitName.optional(),
  branch: GitName.optional(),
  remove: z.union([z.literal('never'), z.object({ on: Endings.optional() })], { message: 'is "never" or { "on": ["Merged"] } (left out: on every ending)' }).optional(),
});
const Tidy = z.union([
  z.enum(['archive', 'stop', 'keep']),
  z.object({ sessions: z.enum(['archive', 'stop']), on: Endings.optional() }),
], { message: 'is "archive", "stop" or "keep", or { "sessions": "archive", "on": ["Merged"] }' });

const FlowFile = z.object({
  $comment: Comment,
  version: z.literal(1, { message: 'must be 1, the only version this Ledung knows' }),
  title: Text(120).optional(),
  start: Id.optional(),
  manager: MarkdownPath.optional(),
  blocks: z.array(Block).min(1, 'a flow needs at least one block').max(200),
  overlays: z.array(Overlay).max(50).default([]),
  frames: z.array(Frame).max(100).default([]),
  /** Part 3f: a worktree per run, runs at once, tidying at the end, one run per ref. */
  worktree: Worktree.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tidy: Tidy.optional(),
  oneRunPerRef: z.boolean().optional(),
});

/**
 * Where an issue is, with a block's or sub-step's id instead of its index ("blocks.build.substeps.self-review.brief"),
 * else counting from 1 ("blocks.review.outcomes.2").
 */
function where(raw: unknown, at: readonly PropertyKey[]): string {
  const parts: string[] = [];
  let node: unknown = raw;
  for (const key of at) {
    const next = node && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[key] : undefined;
    const id = next && typeof next === 'object' && typeof (next as { id?: unknown }).id === 'string' ? (next as { id: string }).id : null;
    parts.push(typeof key !== 'number' ? String(key) : id && ID.test(id) ? id : String(key + 1));
    node = next;
  }
  return parts.join('.') || '(top level)';
}

/** The fields each part of the file has; anything else is left out with a problem rather than refusing the file. */
const FIELDS = {
  top: Object.keys(FlowFile.shape), block: Object.keys(Block.shape), at: ['x', 'y'], timer: ['every', 'of', 'clock'], worktree: Object.keys(Worktree.shape),
  overlay: Object.keys(Overlay.shape), frame: Object.keys(Frame.shape), size: ['width', 'height'], substep: Object.keys(Substep.shape), outcome: Object.keys(Outcome.shape), substepOutcome: Object.keys(SubstepOutcome.shape),
};

/** Fields an older Ledung wrote at the top, said in words: arrows became outcomes (Simon, 2026-10-26, question #1184). */
const DROPPED_AT_TOP: Record<string, string> = {
  arrows: 'was the list of arrows, and arrows are now each block\'s outcomes (question #1184): { "word": "Approved", "to": "merge" } in the "outcomes" of the block they leave. It is left out.',
};

/** A block's fields an older Ledung wrote, said in words: locks were dropped (Simon, 2026-10-26, question #1183). */
const DROPPED_IN_BLOCK: Record<string, string> = {
  pass: 'was the word that sends work on, and it is now an outcome (question #1184): { "word": "Approved", "to": "<the next block>" } in "outcomes". It is left out.',
  fail: 'was where a no goes, and it is now outcomes (question #1184): { "word": "Changes requested", "to": "fix" }, and for a round limit the same word with "times": 3 and where the 3rd one goes. It is left out.',
  lock: "was a lock, and locks are gone (question #1183): the workflow guides, and what must always reach the person is a sensitive pattern or away mode. Take it out of flow.json; it is left out.",
};

/** What a sub-step can't have, said in words rather than as a field this Ledung doesn't know (#322). */
const NOT_IN_SUBSTEP: Record<string, string> = {
  substeps: "can't be in a sub-step: a subagent starts no subagents of its own, so sub-steps don't nest; it is left out.",
  runs: "can't be in a sub-step: a sub-step is a subagent of its block's one and owns no session; it is left out.",
  continues: "can't be in a sub-step: a sub-step is a subagent of its block's one and owns no session; it is left out.",
  profile: "can't be in a sub-step: a subagent starts with no session profile of its own; it is left out.",
  pass: 'was the word that says it is done, and it is now an outcome (question #1185): { "word": "No findings", "to": "done" }. It is left out.',
  fail: 'was what a no does, and it is now outcomes (question #1185): { "word": "Findings", "to": "owner" }, and { "word": "Findings", "times": 3, "to": "report" } for after the last round. It is left out.',
};

/**
 * Fields this Ledung doesn't know: a typo, or a field a newer Ledung writes. Said as problems and left out, so a flow
 * from a newer Ledung (part 6, sharing) still draws, and a typo still shows (review of #310).
 */
function unknownFields(raw: unknown): FlowProblem[] {
  const problems: FlowProblem[] = [];
  // Not an object at all ("null", a list): the schema says so; nothing here to look into (review of 3f).
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return problems;
  const look = (value: unknown, fields: string[], at: readonly PropertyKey[], said: Record<string, string> = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (!fields.includes(key)) problems.push({ at: where(raw, [...at, key]), message: Object.hasOwn(said, key) ? said[key]! : `is not a field this Ledung knows (a typo, or written by a newer Ledung); it is left out.` });
    }
  };
  const list = (key: string) => {
    const v = (raw as Record<string, unknown>)[key];
    return Array.isArray(v) ? v : [];
  };
  const items = (value: unknown, key: string) => {
    const v = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    return Array.isArray(v) ? v : [];
  };
  look(raw, FIELDS.top, [], DROPPED_AT_TOP);
  const top = raw as Record<string, unknown>;
  look(top.worktree, FIELDS.worktree, ['worktree']);
  look((top.worktree as Record<string, unknown> | null)?.remove, ['on'], ['worktree', 'remove']);
  look(top.tidy, ['sessions', 'on'], ['tidy']);
  list('blocks').forEach((b, i) => {
    look(b, FIELDS.block, ['blocks', i], DROPPED_IN_BLOCK);
    for (const part of ['at', 'timer'] as const) look((b as Record<string, unknown> | null)?.[part], FIELDS[part], ['blocks', i, part]);
    items(b, 'outcomes').forEach((o, j) => look(o, FIELDS.outcome, ['blocks', i, 'outcomes', j]));
    items(b, 'substeps').forEach((sub, j) => {
      look(sub, FIELDS.substep, ['blocks', i, 'substeps', j], NOT_IN_SUBSTEP);
      items(sub, 'outcomes').forEach((o, k) => look(o, FIELDS.substepOutcome, ['blocks', i, 'substeps', j, 'outcomes', k]));
    });
  });
  list('overlays').forEach((o, i) => look(o, FIELDS.overlay, ['overlays', i]));
  list('frames').forEach((f, i) => {
    look(f, FIELDS.frame, ['frames', i]);
    for (const part of ['at', 'size'] as const) look((f as Record<string, unknown> | null)?.[part], FIELDS[part], ['frames', i, part]);
  });
  return problems;
}

/** A flow file's text as a flow, or what keeps it from being one; `file` names it in a problem (flows/<name>.json, #447). */
export function parseFlow(text: string, file = FLOW_FILE): { flow: Flow; problems: FlowProblem[] } | { flow: null; problems: FlowProblem[] } {
  let raw: unknown;
  try {
    // A BOM is what PowerShell 5.1 writes by default (review of #310, finding 3).
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { flow: null, problems: [{ at: file, message: `is not valid JSON: ${(e as Error).message}` }] };
  }
  const result = FlowFile.safeParse(raw);
  const unknown = unknownFields(raw);
  if (!result.success) return { flow: null, problems: [...result.error.issues.map((i) => ({ at: where(raw, i.path), message: i.message })), ...unknown] };
  // $comment is for people reading the file; the page has no use for it.
  const { $comment: _, ...flow } = result.data;
  const plain = <T extends { $comment?: string }>(list: T[] | undefined) => list?.map(({ $comment: _x, ...rest }) => rest);
  const blocks = flow.blocks.map(({ $comment: _c, outcomes, substeps, ...b }) => ({
    ...b,
    ...(outcomes ? { outcomes: plain(outcomes) } : {}),
    ...(substeps ? { substeps: substeps.map(({ $comment: _s, outcomes: so, ...sub }) => ({ ...sub, ...(so ? { outcomes: plain(so) } : {}) })) } : {}),
  }));
  return { flow: { ...flow, blocks, overlays: flow.overlays.map(({ $comment: _c, ...o }) => o), frames: flow.frames.map(({ $comment: _c, ...f }) => f) }, problems: unknown };
}

/**
 * Strings that look like a place on one computer: a drive, a share, a home folder, after anything but a letter or
 * digit (part 6, sharing). Folders that are the same on every computer or container (/tmp, /workspace) are fine, and
 * so is a path from the home folder (~/..., $HOME/..., %USERPROFILE%\...): it names the same place on each (#318,
 * port finding 3).
 */
const MACHINE_PATH = /(?:^|[^\w])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]|\/(?:Users|home|root|mnt|Volumes)\/)/;

/** The first line of a text (rules, a brief) that names a place on one computer, as a problem; null when none does. */
export function machinePathIn(file: string, text: string): FlowProblem | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => MACHINE_PATH.test(l));
  return at < 0 ? null : { at: `${file}:${at + 1}`, message: `"${lines[at]!.trim().slice(0, 120)}" looks like a path on one computer; a workflow must work on any computer it is copied to.` };
}

/**
 * The design's checks (docs/steps/workflow-builder.md, "Checks before saving"), and the links between blocks:
 * every block reachable, every loop limited by a count or a person, every person block says what it asks, every
 * linked file there, nothing tied to one computer; and hints, which don't keep a save (#1184): a block that leads
 * nowhere, a session with no brief. `exists` says whether a path inside the workflow folder is a file there;
 * `profiles`, when given, are the session profiles the project's sessions can use; `gated`, the flows a person
 * decides in on every way to their end (personGatedFlows, #447), so a Run flow block running one limits a loop as a
 * person block does.
 */
export function checkFlow(flow: Flow, exists: (file: string) => boolean, profiles?: readonly string[], gated?: ReadonlySet<string>): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const add = (at: string, message: string) => problems.push({ at, message });
  const hint = (at: string, message: string) => problems.push({ at, message, hint: true });
  const ids = new Set<string>();
  for (const b of flow.blocks) {
    if (ids.has(b.id)) add(`blocks.${b.id}`, `Two blocks have the id "${b.id}"; give each its own.`);
    ids.add(b.id);
  }
  const known = (at: string, id: string | undefined, what: string) => {
    if (id !== undefined && !ids.has(id)) add(at, `${what} "${id}", which is not a block in this flow.`);
  };
  known('start', flow.start, 'starts at');
  /** The same word with the same count twice; a counted word with no plain one, so the other times go nowhere. */
  const outcomeList = (at: string, owner: string, list: readonly { word: string; times?: number }[]) => {
    const seen = new Set<string>();
    for (const o of list) {
      const name = outcomeName(o);
      if (seen.has(name)) add(at, `Two outcomes of "${owner}" are "${name}": give each its own word or count.`);
      seen.add(name);
    }
    for (const o of list) {
      if (o.times && !list.some((x) => x.word === o.word && !x.times)) hint(at, `"${owner}" says only where "${outcomeName(o)}" goes: say with a plain "${o.word}" where the other times go.`);
    }
  };
  const ends = flow.blocks.filter((b) => !b.outcomes?.length);

  for (const b of flow.blocks) {
    const at = `blocks.${b.id}`;
    (b.outcomes ?? []).forEach((o, i) => {
      // It ends the flow (#447): it leads to no block.
      if (o.end) {
        if (o.to !== undefined) add(`${at}.outcomes.${i + 1}`, `"${outcomeName(o)}" of "${b.title}" both ends the flow and leads to "${o.to}": take out "end" or "to".`);
        return;
      }
      // Named on its pin, not yet drawn to a block (#446).
      if (o.to === undefined) add(`${at}.outcomes.${i + 1}`, `"${outcomeName(o)}" of "${b.title}" leads nowhere yet: drag its pin to the block it leads to, or pick one in the block's panel.`);
      else known(`${at}.outcomes.${i + 1}`, o.to, `"${outcomeName(o)}" leads to`);
    });
    outcomeList(`${at}.outcomes`, b.title, b.outcomes ?? []);
    // The one block with nowhere to go is the end; more than one may be meant, or a way on forgotten (#1184).
    if (!b.outcomes?.length && ends.length > 1) hint(`${at}.outcomes`, `Where does "${b.title}" go next? It has no outcomes, so the work ends there; that is fine if it is meant to.`);
    if (runsSession(b) && !b.brief) hint(`${at}.brief`, `"${b.title}" runs as a session but has no brief: the brief says how its one acts (a builder, a reviewer).`);
    if (b.kind === 'person' && !b.ask) add(at, `The person block "${b.title}" doesn't say what it asks: give "ask": "question" or "review".`);
    if (b.kind === 'person' && b.runs && b.runs !== 'person') add(`${at}.runs`, `A person block is a person's: take "runs" out, or make "${b.title}" a work or check block.`);
    if ((b.kind === 'fork' || b.kind === 'join') && b.runs) add(`${at}.runs`, `A ${b.kind} only splits or joins the work; nobody runs it: take "runs" out.`);
    // Part 3d: a wait is on something outside; the manager reports how it came out.
    if (b.kind === 'wait') {
      for (const f of ['runs', 'continues', 'model', 'profile', 'substeps'] as const) {
        if (b[f] !== undefined) add(`${at}.${f}`, `"${b.title}" waits on something outside the flow; nobody here runs it: take "${f}" out (its brief may say what it waits for).`);
      }
    }
    if (b.person !== undefined && b.kind !== 'person') add(`${at}.person`, `"person" says whose call a person block is: take it out of "${b.title}", or make it a person block.`);
    if (b.parallel && !b.substeps?.length) add(`${at}.parallel`, `"${b.title}" has no sub-steps to run at once: take "parallel" out, or add sub-steps.`);
    else if (b.parallel && b.substeps!.length === 1) hint(`${at}.parallel`, `"${b.title}" has one sub-step, so "parallel" changes nothing.`);
    // Part 3f: only a continued session has a context to make fresh.
    if (b.context !== undefined && b.runs !== 'continue') add(`${at}.context`, `"context" makes a continued session fresh before its step: "${b.title}" doesn't continue one; take it out, or set "runs": "continue".`);
    if (b.session !== undefined && b.kind !== 'flow') add(`${at}.session`, `"session" is for a Run flow block, which hands its session to the flow it runs: take it out of "${b.title}".`);
    if (b.runs === 'continue' && b.continues === undefined) add(`${at}.continues`, `"${b.title}" continues a session: say whose with "continues", the id of an earlier block that runs as a session.`);
    if (b.continues !== undefined && b.runs !== 'continue') add(`${at}.continues`, '"continues" is for a block that runs as "continue": take it out, or set "runs": "continue".');
    // Sub-steps are subagents (#322): someone who can start one runs the block.
    if (b.substeps?.length && b.runs !== 'manager' && !runsSession(b)) {
      add(`${at}.substeps`, b.kind === 'person' || b.runs === 'person'
        ? 'A person starts no subagents: sub-steps go in a block the manager or a session runs.'
        : `Sub-steps are subagents of the one who runs "${b.title}": say who with "runs" (the manager, a new session or a continued one).`);
    }
    const subIds = new Set<string>();
    for (const s of b.substeps ?? []) {
      const sat = `${at}.substeps.${s.id}`;
      if (subIds.has(s.id)) add(sat, `Two sub-steps of "${b.title}" have the id "${s.id}"; give each its own.`);
      subIds.add(s.id);
      if (s.brief && !exists(s.brief)) add(`${sat}.brief`, missingBrief(s.brief));
      outcomeList(`${sat}.outcomes`, s.title, s.outcomes ?? []);
      // Back to the block's one for ever, unless a count of the same word leads out of the round (#1185, review).
      for (const o of s.outcomes ?? []) {
        if (o.to === 'owner' && !o.times && !(s.outcomes ?? []).some((x) => x.word === o.word && x.times && x.to !== 'owner')) add(`${sat}.outcomes`, `"${s.title}" can go round for ever on "${o.word}": add "${o.word}" with a count ("times") and where it goes then (report, or ask the manager).`);
      }
    }
    if (b.kind !== 'person' && b.ask) add(`${at}.ask`, 'Only a person block asks; take "ask" out or make the block a person block.');
    // A Run flow block (#447): the flow it runs does the step, so nobody here runs it and it has no brief.
    if (b.kind === 'flow') {
      if (b.flow === undefined) add(`${at}.flow`, `The Run flow block "${b.title}" doesn't say which flow it runs: give "flow", the name of one of the project's flows.`);
      for (const f of ['runs', 'continues', 'model', 'profile', 'brief', 'substeps', 'parallel'] as const) {
        if (b[f] !== undefined) add(`${at}.${f}`, `A Run flow block is done by the flow it runs: take "${f}" out of "${b.title}".`);
      }
    } else if (b.flow !== undefined) add(`${at}.flow`, `Only a Run flow block (kind "flow") runs a flow: take "flow" out, or make "${b.title}" one.`);
    if (b.kind === 'timer' && !b.timer) add(at, `The timer block "${b.title}" doesn't say when it starts: give "timer", e.g. { "every": 30, "of": "merges" } or { "clock": "daily" }.`);
    if (b.kind !== 'timer' && b.timer) add(`${at}.timer`, 'Only a timer block has "timer".');
    if (b.brief && !exists(b.brief)) add(`${at}.brief`, missingBrief(b.brief));
    // By name, as the config and the workflow's profiles file give them (#298): the flow carries no profiles of its own.
    if (b.profile && profiles && !profiles.includes(b.profile)) add(`${at}.profile`, `There is no session profile "${b.profile}" for this project (${profiles.length ? `there are: ${profiles.join(', ')}` : 'it has none'}).`);
  }
  const overlayIds = new Set<string>();
  for (const o of flow.overlays) {
    const at = `overlays.${o.id}`;
    if (overlayIds.has(o.id)) add(at, `Two overlays have the id "${o.id}"; give each its own.`);
    overlayIds.add(o.id);
    for (const id of o.blocks) known(`${at}.blocks`, id, 'amends');
    if (!exists(o.file)) add(`${at}.file`, `The overlay's file ${o.file} is not in the workflow folder.`);
  }
  // Frames (#446) only need ids of their own; what they hold is no part of the flow.
  const frameIds = new Set<string>();
  for (const f of flow.frames) {
    if (frameIds.has(f.id)) add(`frames.${f.id}`, `Two frames have the id "${f.id}"; give each its own.`);
    frameIds.add(f.id);
  }
  if (flow.manager && !exists(flow.manager)) add('manager', `The manager's file ${flow.manager} is not in the workflow folder.`);
  problems.push(...followProblems(flow));

  // Strings that name a place on this computer (the path fields are already refused by the schema).
  const scan = (value: unknown, at: string): void => {
    if (typeof value === 'string') {
      if (MACHINE_PATH.test(value)) add(at, `"${value}" looks like a path on one computer; a workflow must work on any computer it is copied to.`);
    } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${at}.${i + 1}`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scan(v, `${at}.${k}`);
  };
  for (const b of flow.blocks) scan({ ...b, id: undefined }, `blocks.${b.id}`);
  if (flow.title) scan(flow.title, 'title');
  flow.overlays.forEach((o) => scan(o.title, `overlays.${o.id}.title`));
  flow.frames.forEach((f) => scan(f.title, `frames.${f.id}.title`));

  // The graph checks need every arrow to land on a block; the problems above say which don't.
  const arrows = drawnArrows(flow).filter((a) => ids.has(a.from) && ids.has(a.to));
  for (const id of unreachable(flow, arrows)) {
    const b = flow.blocks.find((x) => x.id === id)!;
    add(`blocks.${id}`, `No outcome leads to "${b.title}" from where work starts${flow.start ? ` ("${flow.start}")` : ''}; connect it, or take it out.`);
  }
  for (const loop of unlimitedLoops(flow.blocks, arrows, gated)) {
    const titles = loop.map((id) => flow.blocks.find((b) => b.id === id)!.title);
    add(`blocks.${loop[0]}`, `${titles.join(' → ')} can go round for ever: give an outcome in it a count ("times": where the 3rd one goes, say), or put a person block in it.`);
  }
  problems.push(...continueProblems(flow, arrows));
  return problems;
}

/**
 * Part 3f's settings (worktree, tidy): a branch pattern every run gets its own of, and endings that are the flow's.
 */
function followProblems(flow: Flow): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const endings = new Set([...flowEndings(flow).map(endingKey), endingKey(STOPPED_ENDING)]);
  const said = flowEndings(flow);
  const unknown = (list: string[] | undefined, at: string) => {
    for (const e of list ?? []) {
      if (!endings.has(endingKey(e))) problems.push({ at, message: `"${e}" is not a way the flow ends: it ends with ${[...said, STOPPED_ENDING].map((x) => `"${x}"`).join(', ')}.` });
    }
  };
  const w = flow.worktree;
  if (w?.branch !== undefined) {
    if (!w.branch.includes('{id}')) problems.push({ at: 'worktree.branch', message: `"${w.branch}" must have {id} in it, so every run gets a branch of its own.` });
    if (!/^[A-Za-z0-9._/{}-]+$/.test(w.branch) || /\.\.|\/\/|^\/|\/$|\.lock(\/|$)/.test(w.branch)) problems.push({ at: 'worktree.branch', message: `"${w.branch}" is not a branch name git takes: letters, digits, ".", "_", "-" and "/" between parts, with {id} and {ref}.` });
  }
  if (w?.base !== undefined && !/^[A-Za-z0-9._/-]+$/.test(w.base)) problems.push({ at: 'worktree.base', message: `"${w.base}" is not a branch name.` });
  if (w?.remove && w.remove !== 'never') unknown(w.remove.on, 'worktree.remove.on');
  if (flow.tidy && typeof flow.tidy === 'object') unknown(flow.tidy.on, 'tidy.on');
  return problems;
}

/**
 * The checks between a project's flows (#447): a Run flow block names a flow that is there, its outcomes are ways that
 * flow ends (a problem when one isn't, a hint for an ending it has no outcome for), and no flow runs itself, directly
 * or through others. `flows` by name, the default one as "main" (null: one that can't be read); the problems by the
 * name of the flow they are in.
 */
export function checkFlowCalls(flows: ReadonlyMap<string, Flow | null>): Map<string, FlowProblem[]> {
  const out = new Map<string, FlowProblem[]>([...flows.keys()].map((n) => [n, []]));
  const titleOf = (name: string) => flows.get(name)?.title ?? name;
  for (const [name, flow] of flows) {
    const add = (p: FlowProblem) => out.get(name)!.push(p);
    for (const b of flow?.blocks ?? []) {
      if (b.kind !== 'flow' || b.flow === undefined) continue;
      const at = `blocks.${b.id}`;
      if (!flows.has(b.flow)) {
        add({ at: `${at}.flow`, message: `"${b.title}" runs the flow "${b.flow}", which the project doesn't have${b.flow === DEFAULT_FLOW ? '' : ` (no flows/${b.flow}.json)`}.` });
        continue;
      }
      // One that can't be read says so itself; its endings are not known.
      const called = flows.get(b.flow);
      if (!called || b.flow === name) continue;
      const endings = flowEndings(called);
      const keys = new Set(endings.map(endingKey));
      (b.outcomes ?? []).forEach((o, i) => {
        if (o.word.trim() && !keys.has(endingKey(o.word))) {
          add({ at: `${at}.outcomes.${i + 1}`, message: `"${o.word}" is not a way "${titleOf(b.flow!)}" ends, so "${b.title}" never has it: it ends with ${endings.length ? endings.map((e) => `"${e}"`).join(', ') : 'nothing yet'}.` });
        }
      });
      const said = new Set((b.outcomes ?? []).map((o) => endingKey(o.word)));
      for (const e of endings) {
        if (!said.has(endingKey(e))) add({ at: `${at}.outcomes`, message: `"${titleOf(b.flow)}" can end with "${e}": where does the work go after "${b.title}" then? Add it as an outcome.`, hint: true });
      }
    }
  }
  // A flow that runs itself, directly or through others, would never end (#447).
  const calls = new Map([...flows].map(([name, flow]) => [name, [...new Set((flow?.blocks ?? []).flatMap((b) => (b.kind === 'flow' && b.flow !== undefined && flows.has(b.flow) ? [b.flow] : [])))]]));
  /** A way from `first` back to `start`, as the flows on it; null when there is none. */
  const circle = (start: string, first: string): string[] | null => {
    const seen = new Set<string>();
    const walk = (at: string, path: string[]): string[] | null => {
      if (at === start) return path;
      if (seen.has(at)) return null;
      seen.add(at);
      for (const next of calls.get(at) ?? []) {
        const found = walk(next, [...path, next]);
        if (found) return found;
      }
      return null;
    };
    return walk(first, [start, first]);
  };
  for (const [name, flow] of flows) {
    for (const b of flow?.blocks ?? []) {
      if (b.kind !== 'flow' || b.flow === undefined || !flows.has(b.flow)) continue;
      const found = circle(name, b.flow);
      if (!found) continue;
      out.get(name)!.push({
        at: `blocks.${b.id}.flow`,
        message: found.length === 2
          ? `"${b.title}" runs "${titleOf(name)}", the flow it is in: a flow can't run itself.`
          : `"${b.title}" runs a flow that runs this one again (${found.map(titleOf).join(' → ')}): a flow can't run itself, also not through others.`,
      });
    }
  }
  return out;
}

/**
 * The flows a person decides in on every way from their start to an end (#447): each way to an outcome that ends the
 * flow, or to a block with none, passes a person block, or a Run flow block whose own flow is such a flow. A Run flow
 * block running one limits a loop in its caller as a person block does (a reused "merge ask" flow). A flow that runs
 * itself is not one (that is a problem of its own); one that can't be read neither. Its timers start ways too, and an
 * outcome that leads nowhere yet or to no block counts as an end with nobody on the way (review: a draft must not hide
 * a loop). A flow that never reaches an end counts as decided: it never hands the work back, and its own loop check
 * says why.
 */
export function personGatedFlows(flows: ReadonlyMap<string, Flow | null>): Set<string> {
  const done = new Map<string, boolean>();
  const gated = (name: string, on: Set<string>): boolean => {
    if (done.has(name)) return done.get(name)!;
    const flow = flows.get(name);
    if (!flow || !flow.blocks.length || on.has(name)) return false;
    on.add(name);
    const byId = new Map(flow.blocks.map((b) => [b.id, b]));
    const stops = (b: FlowBlock) => b.kind === 'person' || (b.kind === 'flow' && b.flow !== undefined && gated(b.flow, on));
    const first = flow.start && byId.has(flow.start) ? flow.start : flow.blocks[0]!.id;
    const seen = new Set<string>();
    const todo = [first, ...flow.blocks.filter((b) => b.kind === 'timer').map((b) => b.id)];
    let open = false;
    while (todo.length && !open) {
      const b = byId.get(todo.pop()!);
      if (!b || seen.has(b.id)) continue;
      seen.add(b.id);
      if (stops(b)) continue;
      // An end reached with no person on the way.
      if (!b.outcomes?.length || b.outcomes.some((o) => o.end || (o.to === undefined ? true : !byId.has(o.to)))) open = true;
      for (const o of b.outcomes ?? []) if (o.to !== undefined) todo.push(o.to);
    }
    on.delete(name);
    done.set(name, !open);
    return !open;
  };
  return new Set([...flows.keys()].filter((n) => gated(n, new Set())));
}

/**
 * The block whose new session runs a block (#322): its own, or, following `continues`, the one that started the
 * session it continues. Undefined: it runs in no session, or a chain that never reaches a new one.
 */
export function sessionOf(flow: Flow, id: string): string | undefined {
  const byId = new Map(flow.blocks.map((b) => [b.id, b]));
  const seen = new Set<string>();
  for (let b = byId.get(id); b && !seen.has(b.id); b = b.continues === undefined ? undefined : byId.get(b.continues)) {
    seen.add(b.id);
    if (b.runs === 'new-session') return b.id;
    if (b.runs !== 'continue') return undefined;
  }
  return undefined;
}

/**
 * The work a check block checks: the work blocks whose outcomes lead into it, looking back through blocks that do no
 * work of their own (a person, a fork or join, a timer, another check), and the work its own outcomes send back to it
 * (Code review checks Build and Fix). Whose session it must not be (#322, review: one arrow back missed Build →
 * Person → Review, and took a second check by the same reviewer for its own work).
 */
export function checkedBy(flow: Flow, check: FlowBlock): string[] {
  const byId = new Map(flow.blocks.map((b) => [b.id, b]));
  const arrows = drawnArrows(flow);
  const work = new Set<string>();
  const seen = new Set<string>([check.id]);
  const back = (id: string) => {
    const b = byId.get(id);
    if (!b || seen.has(id)) return;
    seen.add(id);
    if (b.kind === 'work') work.add(id);
    // A Run flow block's work is the other flow's (#447): no session of this flow did it.
    else if (b.kind !== 'flow') for (const a of arrows) if (a.to === id) back(a.from);
  };
  for (const a of arrows) if (a.to === check.id) back(a.from);
  // Work a "no" sends back: an outcome whose block comes back round to this check, directly or through other work
  // (Fix → Code review; Write → Lint → Review, review of #1184).
  const reaches = (from: string): boolean => {
    const been = new Set<string>([from]);
    const todo = [from];
    while (todo.length) {
      const id = todo.pop()!;
      for (const a of arrows) {
        if (a.from !== id) continue;
        if (a.to === check.id) return true;
        if (!been.has(a.to)) { been.add(a.to); todo.push(a.to); }
      }
    }
    return false;
  };
  for (const o of check.outcomes ?? []) if (o.to !== undefined && o.to !== check.id && byId.get(o.to)?.kind === 'work' && reaches(o.to)) work.add(o.to);
  return [...work];
}

/**
 * `continues` (#322) names an earlier block that runs as a session: every way from where work starts to this block
 * passes it, so its session is there by the time work gets here (review of #322: a path from it alone let a block
 * before it pass through a loop); and a check never continues the session of work it checks, or the author would
 * review their own work. A check sub-step inside the block it checks is another thing: allowed, and shown as "the
 * author reads this".
 */
function continueProblems(flow: Flow, arrows: DrawnArrow[]): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const byId = new Map(flow.blocks.map((b) => [b.id, b]));
  const first = flow.start && byId.has(flow.start) ? flow.start : flow.blocks[0]!.id;
  const roots = [first, ...flow.blocks.filter((b) => b.kind === 'timer').map((b) => b.id)];
  /** Whether `to` can be reached from where work starts without passing `avoid`. */
  const reachedWithout = (to: string, avoid: string) => {
    const seen = new Set<string>([avoid]);
    const todo = roots.filter((r) => r !== avoid);
    while (todo.length) {
      const id = todo.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const a of arrows) if (a.from === id && !seen.has(a.to)) todo.push(a.to);
    }
    return false;
  };
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const todo = [from];
    while (todo.length) {
      const id = todo.pop()!;
      for (const a of arrows) {
        if (a.from !== id || seen.has(a.to)) continue;
        if (a.to === to) return true;
        seen.add(a.to);
        todo.push(a.to);
      }
    }
    return false;
  };
  const earlier = (other: string, b: string) => reaches(other, b) && !reachedWithout(b, other);
  const runsAs = (b: FlowBlock) => (b.runs === 'manager' ? 'as the manager' : b.runs === 'person' || b.kind === 'person' ? "as a person's step" : 'as nobody said');
  for (const b of flow.blocks) {
    if (b.runs !== 'continue' || b.continues === undefined) continue;
    const at = `blocks.${b.id}.continues`;
    const other = byId.get(b.continues);
    if (!other) problems.push({ at, message: `continues "${b.continues}", which is not a block in this flow.` });
    else if (other.id === b.id) problems.push({ at, message: `"${b.title}" can't continue its own session: name the earlier block whose session takes this step.` });
    else if (!runsSession(other)) problems.push({ at, message: `"${other.title}" runs ${runsAs(other)}, not as a session, so "${b.title}" has no session of it to continue.` });
    else if (!earlier(other.id, b.id)) problems.push({ at, message: `"${other.title}" doesn't come before "${b.title}": work can get here without passing it, so there may be no session of it yet to continue.` });
    else if (!sessionOf(flow, b.id)) problems.push({ at, message: `"${b.title}" continues sessions that only continue each other: one of them must run as a new session.` });
  }
  for (const b of flow.blocks) {
    if (b.kind !== 'check' || b.runs !== 'continue') continue;
    const own = sessionOf(flow, b.id);
    const judged = own ? checkedBy(flow, b).filter((id) => sessionOf(flow, id) === own) : [];
    if (judged.length) {
      const titles = judged.map((id) => `"${byId.get(id)?.title ?? id}"`).join(' and ');
      problems.push({ at: `blocks.${b.id}.continues`, message: `The check "${b.title}" would run in the session that did ${titles}, the work it checks: run it as a new session. For the author to look over their own work, make it a check sub-step of that block.` });
    }
  }
  return problems;
}

/** Blocks no arrow reaches from the start (the "start" block, else the first) or from a timer block. */
function unreachable(flow: Flow, arrows: DrawnArrow[]): string[] {
  const first = flow.start && flow.blocks.some((b) => b.id === flow.start) ? flow.start : flow.blocks[0]!.id;
  const seen = new Set<string>();
  const todo = [first, ...flow.blocks.filter((b) => b.kind === 'timer').map((b) => b.id)];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const a of arrows) if (a.from === id) todo.push(a.to);
  }
  return [...new Set(flow.blocks.map((b) => b.id))].filter((id) => !seen.has(id));
}

/**
 * The loops nothing limits, each as its blocks (#1184). A loop is limited when it passes an outcome with a count: a
 * word whose Nth time goes elsewhere ("Failed → Planner", "Failed, the 3rd time → Person") goes round on that word at
 * most N - 1 times, and the counted outcome itself is taken once each time the count is reached (the escalation of
 * #318, port finding 2); a count that leads where the plain word does limits nothing, and stays in the graph;
 * or when it passes a person block, as a person decides each round (the functional review's "Changes needed → Fix").
 * So the loops left are the cycles of the graph without those arrows and blocks: its strongly connected parts with
 * more than one block, or a block with an arrow to itself (Tarjan's algorithm). A counted outcome that ends the flow
 * limits its plain word too, and a Run flow block whose flow a person decides in on every way to its end (`gated`)
 * counts as a person block (#447, porting a large process).
 */
function unlimitedLoops(blocks: FlowBlock[], arrows: DrawnArrow[], gated?: ReadonlySet<string>): string[][] {
  const person = new Set(blocks.filter((b) => b.kind === 'person' || (b.kind === 'flow' && b.flow !== undefined && !!gated?.has(b.flow))).map((b) => b.id));
  // Counted outcomes that end the flow (#447): no arrow, but the Nth time of their word leaves the loop all the same.
  const endsCounted = new Set(blocks.flatMap((b) => (b.outcomes ?? []).filter((o) => o.end && o.times).map((o) => JSON.stringify([b.id, o.word]))));
  // A count limits its plain word only when it leads somewhere else: "Failed, the 3rd time → Build" beside "Failed →
  // Build" ends nothing (review of #1184).
  const limits = (a: DrawnArrow) => endsCounted.has(JSON.stringify([a.from, a.word])) || arrows.some((x) => x.times && x.from === a.from && x.word === a.word && x.to !== a.to);
  const next = new Map<string, string[]>();
  for (const a of arrows) {
    if (a.times ? arrows.some((x) => !x.times && x.from === a.from && x.word === a.word && x.to === a.to) === false : limits(a)) continue;
    if (person.has(a.from) || person.has(a.to)) continue;
    const out = next.get(a.from);
    if (out) out.push(a.to);
    else next.set(a.from, [a.to]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const loops: string[][] = [];
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const part: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      part.push(w);
    } while (w !== v);
    if (part.length > 1 || (next.get(v) ?? []).includes(v)) loops.push(part.reverse());
  };
  for (const b of blocks) if (!index.has(b.id)) visit(b.id);
  return loops;
}
