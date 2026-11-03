// A manager constructs workflows (workflow part 3e, docs/steps/workflow-follow.md, Simon 2026-11-03): flow_propose
// puts new or changed workflow files to the person as a review, with the flows before and after and the problems the
// builder's checks find. Accepted saves them through the builder's own save (only the project's .ledung/workflow, only
// the format's files, each the version read when it was proposed); Changes needed goes back to the manager. A manager
// never changes the process it follows without the person's say.
import type { DatabaseSync } from 'node:sqlite';
import { FLOW_FILE, FLOW_IN_FOLDER, FLOW_TEXT_FILE, MANAGER_FILE, RULES_FILE, type Flow, type FlowFileWrite, type FlowProblem, type FlowView } from '../shared/flow.ts';
import type { FlowProposal, ProposalFlow, ProposalState } from '../shared/flow-proposal.ts';
import { FileError } from './files.ts';
import { flowWrites, readFlowView, type FileRead, type FlowPlace } from './flow-files.ts';

/** One change as flow_propose takes it: a whole file's new text, or a flow in flows/ to remove. */
export interface ProposedChange {
  file: string;
  text?: string;
  remove?: boolean;
}

/** The files a view read, by their path in the workflow folder: flow.json, the other flows, rules.md, the texts. */
function filesOf(view: FlowView): Map<string, string> {
  const files = new Map<string, string>();
  if (view.raw !== null) files.set(FLOW_FILE, view.raw);
  for (const f of view.flows) if (f.raw !== null) files.set(f.file, f.raw);
  if (view.rules !== null) files.set(RULES_FILE, view.rules);
  for (const [f, t] of Object.entries(view.texts)) files.set(f, t);
  return files;
}

/** A place that reads the given files, as the checks read a project's folder: the files as they would be after the change. */
function placeOf(folder: string, files: Map<string, string>): FlowPlace {
  return {
    kind: 'project', folder,
    read: async (wanted) => new Map(wanted.map((f): [string, FileRead] => [f, files.has(f) ? { text: files.get(f)! } : { missing: true }])),
    list: async () => [...files.keys()].filter((f) => f === MANAGER_FILE || FLOW_TEXT_FILE.test(f) || FLOW_IN_FOLDER.test(f)).sort(),
  };
}

/** A view's flows by name with their titles: the default one ("main") and those in flows/. */
function flowsOf(view: FlowView): ProposalFlow[] {
  return [
    ...(view.raw !== null ? [{ name: 'main', file: FLOW_FILE, title: view.flow?.title ?? 'main', flow: view.flow }] : []),
    ...view.flows.map((f) => ({ name: f.name, file: f.file, title: f.flow?.title ?? f.name, flow: f.flow })),
  ];
}

/**
 * The proposal a manager's changes make of the project's workflow as read now (`view`): what would be written, with the
 * version each replaces (none for a new file), the flows that change, before and after, the texts that change and the
 * problems the checks find in the result. Throws FileError with the reason when it can't be proposed.
 */
export async function buildProposal(view: FlowView, changes: ProposedChange[], why: string, profiles?: readonly string[]): Promise<Omit<FlowProposal, 'id' | 'project' | 'question' | 'state'>> {
  if (view.source?.kind === 'workflow') {
    throw new FileError(`This project follows the shared workflow "${view.source.workflow}" with no .ledung/workflow of its own; the person makes its own copy in the builder first (Edit, Save), then you can propose changes to it.`);
  }
  if (!view.saveTo) throw new FileError("Ledung can't write into this project's folder, so nothing can be proposed for it.");
  if (!changes.length) throw new FileError('Give the files that change.');
  // A file there that couldn't be read is not a new one (review of 3e): say so, rather than fail later on Accepted.
  const unread = new Set(view.problems.filter((p) => p.message.startsWith("can't be read")).map((p) => p.at));
  if (view.source && view.raw === null) unread.add('flow.json');
  for (const f of view.flows) if (f.raw === null) unread.add(f.file);
  const before = filesOf(view);
  const after = new Map(before);
  const writes: FlowFileWrite[] = [];
  for (const c of changes) {
    const file = c.file.trim().replace(/^\.ledung\/workflow\//, '');
    if (unread.has(file)) throw new FileError(`${file} is in the workflow folder but can't be read, so Ledung can't tell what it replaces; the workflow page says why.`);
    if (c.remove) {
      if (c.text !== undefined) throw new FileError(`${file}: give its text or remove it, not both.`);
      if (!before.has(file)) throw new FileError(`${file} is not there to remove.`);
      writes.push({ path: file, remove: true, base: view.versions[file]! });
      after.delete(file);
    } else {
      if (typeof c.text !== 'string') throw new FileError(`${file}: give its whole new text, or remove: true.`);
      if (before.get(file) === c.text) continue;
      writes.push({ path: file, text: c.text, base: view.versions[file] ?? null });
      after.set(file, c.text);
    }
  }
  if (!writes.length) throw new FileError('Nothing changes: every file given is as it is now.');
  // The builder's own rules for what may be written (#311): the format's files, the limits, a flow.json that is a flow.
  flowWrites(writes);
  if (!after.has(FLOW_FILE)) throw new FileError(`A workflow needs ${FLOW_FILE}, its default flow.`);
  const result = await readFlowView(view.project, [placeOf(view.saveTo, after)], profiles);
  const old = flowsOf(view);
  const now = flowsOf(result);
  const changed = (f: ProposalFlow) => writes.some((w) => w.path === f.file);
  const flows = [...new Set([...old, ...now].filter(changed).map((f) => f.name))].map((name) => ({
    name,
    before: old.find((f) => f.name === name) ?? null,
    after: now.find((f) => f.name === name) ?? null,
  }));
  const texts = writes.filter((w) => !FLOW_IN_FOLDER.test(w.path) && w.path !== FLOW_FILE).map((w) => ({ file: w.path, before: before.get(w.path) ?? null, after: after.get(w.path) ?? null }));
  const problems: FlowProblem[] = [
    ...result.problems,
    ...result.flows.flatMap((f) => f.problems.map((p) => ({ ...p, at: `${f.file}: ${p.at}` }))),
  ];
  // Frames are rectangles where they say, and blocks with no position are laid out by the page (#446): a block added or
  // taken out moves the others, so they may leave their frames. Said, as the builder would pin them (seen in the try-out).
  for (const f of flows) {
    const was = f.before?.flow;
    const is = f.after?.flow;
    if (!was || !is || !is.frames.length || is.blocks.every((b) => b.at)) continue;
    const ids = (x: Flow) => x.blocks.map((b) => b.id).sort().join();
    if (ids(was) === ids(is)) continue;
    problems.push({
      at: `${f.after!.file}: frames`, hint: true,
      message: `Its frames are drawn where they say, and its blocks have no positions of their own, so with blocks added or taken out the page lays them out anew and some may fall outside their frames (the diagrams show it). After saving, Auto-arrange in the builder fits the frames round their blocks again.`,
    });
  }
  const titles = Object.fromEntries([...old, ...now].map((f) => [f.name, f.title]));
  return { why: why.trim(), writes, flows, texts, problems, titles, read: { ...view.versions }, createdAt: Date.now() };
}

/** What a proposal changes, in a line per file, for the review and the manager. */
export function proposalSummary(p: Pick<FlowProposal, 'writes' | 'flows'>): string {
  const blocks = (f: Flow | null | undefined) => new Map((f?.blocks ?? []).map((b) => [b.id, b]));
  const lines = p.writes.map((w) => {
    if (w.remove) return `- ${w.path}: removed`;
    const flow = p.flows.find((f) => f.after?.file === w.path || f.before?.file === w.path);
    if (!flow) return `- ${w.path}: ${w.base === null ? 'new' : 'changed'}`;
    const was = blocks(flow.before?.flow);
    const is = blocks(flow.after?.flow);
    const added = [...is.keys()].filter((id) => !was.has(id)).map((id) => is.get(id)!.title);
    const gone = [...was.keys()].filter((id) => !is.has(id)).map((id) => was.get(id)!.title);
    const edited = [...is.keys()].filter((id) => was.has(id) && JSON.stringify({ ...was.get(id), at: 0 }) !== JSON.stringify({ ...is.get(id), at: 0 })).map((id) => is.get(id)!.title);
    const parts = [added.length && `adds ${added.join(', ')}`, gone.length && `takes out ${gone.join(', ')}`, edited.length && `changes ${edited.join(', ')}`].filter(Boolean);
    return `- ${w.path} ("${flow.after?.title ?? flow.before?.title}"): ${w.base === null ? 'a new flow' : parts.length ? parts.join('; ') : 'its layout or wording'}`;
  });
  return lines.join('\n');
}

export class ProposalStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(project: string, manager: string, data: Omit<FlowProposal, 'id' | 'project' | 'question' | 'state'>): FlowProposal {
    const r = this.db.prepare(`INSERT INTO flow_proposals (project, manager, data, state, created_at) VALUES (?, ?, ?, 'open', ?) RETURNING id`).get(project, manager, JSON.stringify(data), data.createdAt) as { id: number };
    return this.get(Number(r.id))!;
  }

  get(id: number): (FlowProposal & { manager: string }) | undefined {
    const r = this.db.prepare('SELECT * FROM flow_proposals WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!r) return undefined;
    return { ...JSON.parse(r.data), id: Number(r.id), project: r.project, manager: r.manager, question: r.question == null ? null : Number(r.question), state: r.state };
  }

  setQuestion(id: number, question: number): void {
    this.db.prepare('UPDATE flow_proposals SET question = ? WHERE id = ?').run(question, id);
  }

  setState(id: number, state: ProposalState): void {
    this.db.prepare('UPDATE flow_proposals SET state = ? WHERE id = ?').run(state, id);
  }
}
