// Ledung follows the flow (workflow part 3, docs/steps/workflow-follow.md, approved by Simon 2026-11-03): runs, each
// a piece of work going through one of the project's flows. The coordinator (whoever started the run: usually the
// manager, else the session the person asked) reports how each block ended by the outcome's word; Ledung records and
// counts it, takes the counted outcome on its Nth time and the plain one otherwise, moves the run and says what to do
// at the next block. Ledung never picks the outcome from text (#1184), and the workflow guides: no locks (#1183).
import type { QuestionInfo, RunBlock, SessionInfo, StoredMessage } from '../shared/protocol.ts';
import { DEFAULT_FLOW, DEFAULT_TIDY, endingKey, flowFileOf, ordinal, STOPPED_ENDING, type Flow, type FlowBlock } from '../shared/flow.ts';
import { makeWorktree, removeWorktree, type WorktreeHost } from './run-worktrees.ts';
import { decideStep, OPEN_STATES, outcomeList, runLabel, startBlock, type FlowRun, type RunStep } from '../shared/flow-run.ts';
import { inFolder, sessionOf } from '../shared/flow-check.ts';
import { exercisedLine } from '../platform/exercised.ts';
import { ACCEPTED, CHANGES_NEEDED, optionAnswer, questionText, type QuestionDetails, type QuestionOption, type QuestionRun } from '../shared/questions.ts';
import type { RunStore } from './run-store.ts';

/** A project's flows as they read now: by name ("main" for flow.json), and the folder they are in. */
export interface ProjectFlows {
  folder: string;
  flows: Map<string, Flow>;
  /** Each flow's title, for the tools: its own, else its name. */
  titles: Map<string, string>;
  /** A text in the workflow folder (a brief), or null when it can't be read. */
  text(file: string): Promise<string | null>;
}

/** What a block's session is started with (part 3b): the block's settings, under the run's coordinator. */
export interface BlockSessionStart {
  project: string;
  coordinator: string;
  title: string;
  task: string;
  model?: string;
  profile?: string;
  runBlock: RunBlock;
  /** The run's worktree, where the session works (part 3f); none: the project folder. */
  cwd?: string;
}

/** A person block's question or review (part 3b), asked of the person for the run's coordinator. */
export interface PersonAsk {
  coordinator: string;
  question: string;
  options: string[] | null;
  details: QuestionDetails;
}

export interface FlowRunsPorts {
  runs: RunStore;
  getSession(id: string): SessionInfo | undefined;
  /** The project's manager session, if it has one. */
  managerOf(project: string): string | null;
  /** The project's flows; null: it has none Ledung can read. */
  flows(project: string): Promise<ProjectFlows | null>;
  /** Whether the project follows its flow (the project setting, on by default). */
  following(project: string): boolean;
  /** Something for a session: put in its inbox and delivered when it is free. */
  tell(sessionId: string, text: string): void;
  /** The project's runs changed: the page is told. */
  changed(project: string): void;
  /** Starts a block's session (part 3b); throws with the reason. */
  startSession(s: BlockSessionStart): Promise<SessionInfo>;
  /** Hands a session the next block: in its inbox, resumed first if it ended; throws when it can't be. */
  continueSession(id: string, text: string, runBlock: RunBlock, fresh?: { context: 'compact' | 'clear'; by: string }): Promise<void>;
  /** A session's last reply, for the handoff to the next block; empty: none. */
  lastReply(id: string): string;
  /** Puts a person block to the person (part 3b): the question, stored and shown. */
  ask(a: PersonAsk): QuestionInfo;
  /** The answer has reached its asker: the run's note says it instead. */
  markDelivered(questionId: number): void;
  /** A person block's question no longer needed: the run moved or stopped without its answer. */
  withdraw(questionId: number, reason: string): void;
  /** Stops a block's session that has done its part (an earlier round's). */
  stopSession(id: string, reason: string): Promise<void>;
  /** Archives an ended session (part 3f, a run's tidying). */
  archiveSession(id: string, by: string): void;
  /** How Ledung reaches the project's git (part 3f); null: it can't (a removed project). */
  worktreeHost(project: string): WorktreeHost | null;
  /** The project's setup command for a new worktree (its settings); none: nothing is run. */
  worktreeSetup(project: string): string | undefined;
  /** Sessions not ended that work in this folder (review of 3f): a worktree is never removed under them. */
  workingIn(project: string, folder: string): string[];
  /** Every session a run's blocks started, a block's earlier ones too (a new session on each visit). */
  sessionsOf(project: string, run: string): string[];
  /** The project's question tiers, in order. */
  tiers(project: string): string[];
  userName: string;
  now?(): number;
}

/** The longest note a step keeps in the history. */
const NOTE_KEPT = 600;
/** How many runs flow_status lists without a run named. */
const STATUS_LISTED = 20;
/** A brief longer than this is named, not copied into the handoff. */
const BRIEF_INLINE = 6000;
/** The most of the previous step's report a handoff carries. */
const HANDOFF_MAX = 4000;
/** How deep Run flow blocks may start runs that start runs at once (a flow that runs itself is a check problem). */
const NESTED_MAX = 8;

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Where a brief is, for one who reads it: a "folder:" brief is in the folder the workflow folder is in (ledung#111). */
function briefPlace(folder: string, brief: string): string {
  const rest = inFolder(brief);
  return rest === null ? `${brief} in ${folder}` : `${rest} in ${folder.replace(/[\\/]\.ledung[\\/]workflow$/, '')}`;
}

/** EXERCISED #142 is logged once per run of Ledung, not per step. */
let exercised142 = false;
/** EXERCISED #291 is logged once per run of Ledung. */
let exercised291 = false;

/** How long a person block waits for its coordinator's write-up before Ledung asks its own card (#291). */
export const WRITE_UP_MINUTES = 10;
/** The head of that card (#291, Done looks like). */
export const LATE_HEAD = 'The manager gave no write-up for this step';
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

type Handoff = { from: string; text: string } | null;

/** In a run's sessions, the session its Run flow block handed it (part 3d, `session: "caller"`). */
const CALLER = '@caller';

export class FlowRunError extends Error {}
/** A run whose worktree git refused (final review of part 3, finding 6): held in line, said to whoever started it. */
class WorktreeHeld extends FlowRunError {}

export class FlowRuns {
  private readonly p: FlowRunsPorts;
  /** Runs held in line because git refused their worktree (final review of part 3, 6): Start anyway tries them again. */
  private readonly held = new Set<string>();
  /** One change at a time per project, so two steps on one run can't both count the same state. */
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(ports: FlowRunsPorts) {
    this.p = ports;
  }

  private now(): number {
    return this.p.now?.() ?? Date.now();
  }

  private one<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const before = this.queue.get(project) ?? Promise.resolve();
    const run = before.then(fn, fn);
    this.queue.set(project, run.catch(() => {}));
    return run;
  }

  /** Who a session is, for a run's history: 'manager "Manager: shop"' or 'session "Build"'. */
  private who(sessionId: string): string {
    const s = this.p.getSession(sessionId);
    return s ? `${s.role === 'manager' ? 'manager' : 'session'} "${s.title}"` : 'a session that is gone';
  }

  private async flowsOf(project: string): Promise<ProjectFlows> {
    if (!this.p.following(project)) throw new FlowRunError(`Following the workflow is switched off for ${project} (its settings, Workflow).`);
    const flows = await this.p.flows(project);
    if (!flows || !flows.flows.get(DEFAULT_FLOW)) throw new FlowRunError(`${project} has no flow Ledung can read (.ledung/workflow/flow.json); the workflow page says why.`);
    return flows;
  }

  /** The flow a run is in, as it reads now. */
  private flowOf(flows: ProjectFlows, run: FlowRun): Flow {
    const flow = flows.flows.get(run.flow);
    if (!flow) throw new FlowRunError(`${runLabel(run)} runs in the flow "${run.flow}", which the project no longer has (${flowFileOf(run.flow)}). Stop it with flow_step stop.`);
    return flow;
  }

  /** A flow by its name or its title, letter case aside; none given: the default one. */
  private pickFlow(flows: ProjectFlows, name: string | undefined): string {
    if (!name?.trim()) return DEFAULT_FLOW;
    const want = name.trim().toLowerCase();
    for (const [n, title] of flows.titles) if (n === want || title.toLowerCase() === want) return n;
    throw new FlowRunError(`There is no flow "${name.trim()}"; the project's flows: ${[...flows.titles].map(([n, t]) => (n === t ? n : `${n} ("${t}")`)).join(', ')}.`);
  }

  /** A run the caller may move: one it coordinates, or any of its project's when it is the project's manager. */
  /**
   * Tells a run's coordinator (final review of part 3, finding 3). An ended one is resumed by the tell port; one gone for
   * good (archived, or no longer known) hands the run to the project's manager, which is told so, rather than leaving
   * the run to hold its place with no one to read what happens to it.
   */
  private tellCoordinator(run: FlowRun, text: string): void {
    const c = this.p.getSession(run.coordinator);
    if (c && !c.archivedAt) return this.p.tell(c.id, text);
    const manager = this.p.managerOf(run.project);
    // No one to hand it to: an archived session is not woken for it; the run's history and the Runs list keep it.
    if (!manager || manager === run.coordinator) return;
    this.p.runs.update(run.id, { coordinator: manager }, this.now());
    this.p.changed(run.project);
    this.p.tell(manager, `Ledung: ${runLabel(run)} was coordinated by ${c ? `"${c.title}", which is archived` : 'a session that is gone'}, so you coordinate it now.\n\n${text}`);
  }

  private ownRun(callerId: string, id: string): FlowRun {
    const caller = this.p.getSession(callerId);
    const run = this.p.runs.get(id);
    if (!caller || !run || run.project !== caller.project) throw new FlowRunError(`There is no run "${id}" in your project; flow_status lists them.`);
    if (run.coordinator !== callerId && this.p.managerOf(run.project) !== callerId) {
      throw new FlowRunError(`${runLabel(run)} is coordinated by ${this.who(run.coordinator)}, not by you.`);
    }
    return run;
  }

  // --- the tools -------------------------------------------------------------------------------------

  /** flow_start: a new run at the flow's start block, coordinated by the caller; what to do there. */
  start(callerId: string, args: { title: string; ref?: string; flow?: string; again?: boolean }): Promise<string> {
    const caller = this.p.getSession(callerId);
    if (!caller) return Promise.reject(new FlowRunError('Your session is not known to Ledung.'));
    // Also when it was given a block after its tools were made (final review of part 3, finding 2).
    if (caller.runBlock) return Promise.reject(new FlowRunError(`You do a step of ${caller.runBlock.run}; a block's session starts no runs. If more work is needed, say so in your report, and your coordinator decides.`));
    if (!args.title.trim()) return Promise.reject(new FlowRunError('Give the run a title: what the work is.'));
    return this.one(caller.project, async () => {
      const flows = await this.flowsOf(caller.project);
      const name = this.pickFlow(flows, args.flow);
      const flow = flows.flows.get(name)!;
      const first = startBlock(flow);
      const ref = args.ref?.trim() || null;
      // One run per ref (part 3f), unless the flow allows more or the caller says again.
      if (ref && flow.oneRunPerRef !== false && !args.again) {
        const already = this.p.runs.list(caller.project, { open: true, limit: 10000 }).find((r) => r.ref?.trim().toLowerCase() === ref.toLowerCase());
        if (already) {
          const titleOf = (id: string | null) => flows.flows.get(already.flow)?.blocks.find((b) => b.id === id)?.title ?? id ?? '';
          throw new FlowRunError(`${runLabel(already)} is already under way for ${ref} (${this.stateLine(already, titleOf(already.at))}): report on it, or start another with again: true.`);
        }
      }
      // Full, or others already in line: a new run never jumps the line (review of 3f).
      const full = flow.limit !== undefined && (this.working(caller.project, name) >= flow.limit || this.p.runs.queued(caller.project).some((r) => r.flow === name && r.queue === 'flow'));
      const run = this.p.runs.create({ project: caller.project, title: args.title.trim(), ref, flow: name, at: first.id, coordinator: callerId, parent: null, now: this.now() });
      const started = `Started ${runLabel(run)} in the flow "${flows.titles.get(name)}".`;
      if (full) {
        // At most N at once (part 3f): it waits at the start, in line, and Ledung starts it when one ends.
        const queued = this.p.runs.update(run.id, { state: 'queued', queue: 'flow' }, this.now());
        this.p.changed(caller.project);
        return `${started} The flow takes ${flow.limit} at once, so it is queued, number ${this.place(queued)} in line: Ledung starts it when one ends, and tells you. ${this.p.userName} can start it anyway from the Runs list.`;
      }
      this.p.changed(caller.project);
      try {
        return `${started} ${await this.begin(flows, run, flow, null, false)}`;
      } catch (e) {
        if (e instanceof WorktreeHeld) return `${started} ${e.message}`;
        throw e;
      }
    });
  }

  /** The person's "start anyway" for a queued run (part 3f): it goes on past its flow's or block's limit. */
  startAnyway(project: string, id: string, by: string): Promise<string> {
    return this.one(project, async () => {
      const run = this.p.runs.get(id);
      if (!run || run.project !== project) throw new FlowRunError(`There is no run "${id}" in ${project}.`);
      if (run.state !== 'queued') throw new FlowRunError(`${runLabel(run)} is not in line.`);
      this.held.delete(run.id);
      const flows = await this.flowsOf(project);
      const flow = this.flowOf(flows, run);
      const at = flow.blocks.find((b) => b.id === run.at);
      // In line before a block that is gone: not some other block (final review of part 3, finding 6), as release does.
      if (!at && run.queue === 'block') throw new FlowRunError(`${runLabel(run)} waits before "${run.at}", which is no block of its flow any more: its coordinator reports its outcome or stops it.`);
      const block = at ?? startBlock(flow);
      const text = run.queue === 'flow'
        ? await this.begin(flows, run, flow, null, true)
        : await this.arrive(flows, this.p.runs.update(run.id, { state: 'running', queue: null }, this.now()), flow, block, this.lastHandoff(run, flow));
      this.p.changed(project);
      this.tellCoordinator(run, `Ledung: ${by} started ${runLabel(run)} past its limit. ${text}`);
      return text;
    });
  }

  /**
   * flow_step: how the run's current block ended, by the outcome's word. `block`, when given, must be where the run
   * is, so a report meant for a block the run has left is not counted at the next one. `stop`: the run stops where it
   * is, with `outcome` as why.
   */
  step(callerId: string, args: { run: string; outcome: string; note?: string; block?: string; stop?: boolean }): Promise<string> {
    const caller = this.p.getSession(callerId);
    if (!caller) return Promise.reject(new FlowRunError('Your session is not known to Ledung.'));
    return this.one(caller.project, async () => {
      const run = this.ownRun(callerId, args.run);
      if (run.state === 'ended' || run.state === 'stopped') throw new FlowRunError(`${runLabel(run)} has ${run.state === 'ended' ? `ended (${run.ending})` : 'been stopped'}; start a new run for more work.`);
      if (args.stop) {
        const flows = await this.p.flows(run.project).catch(() => null);
        const stopped = this.stopRun(run, args.outcome.trim() || 'stopped', this.who(callerId), flows);
        return `${stopped} ${await this.afterEnd(flows, this.p.runs.get(run.id)!, STOPPED_ENDING)}`.trim();
      }
      if (run.state === 'queued') throw new FlowRunError(`${runLabel(run)} is in line (${this.stateLine(run, run.at ?? '')}): it has no step to report yet. Stop it with stop: true, or ${this.p.userName} can start it anyway.`);
      const flows = await this.flowsOf(run.project);
      const flow = this.flowOf(flows, run);
      const block = flow.blocks.find((b) => b.id === run.at);
      if (!block) throw new FlowRunError(`${runLabel(run)} is at "${run.at}", which is no block of the flow any more. Stop it with stop: true, and start it again.`);
      if (args.block?.trim() && args.block.trim().toLowerCase() !== block.id && args.block.trim().toLowerCase() !== block.title.toLowerCase()) {
        throw new FlowRunError(`${runLabel(run)} is at "${block.title}" (${block.id}), not "${args.block.trim()}": nothing was recorded. flow_status shows its history.`);
      }
      return this.applyStep(flows, flow, run, block, args.outcome, this.who(callerId), args.note);
    });
  }

  /** flow_status: one run in full, or the project's open runs and the latest ended ones. */
  async status(callerId: string, id?: string): Promise<string> {
    const caller = this.p.getSession(callerId);
    if (!caller) throw new FlowRunError('Your session is not known to Ledung.');
    const flows = await this.p.flows(caller.project).catch(() => null);
    const titleOf = (run: FlowRun, block: string | null) => (block && flows?.flows.get(run.flow)?.blocks.find((b) => b.id === block)?.title) || block || '';
    if (id?.trim()) {
      const run = this.p.runs.get(id);
      if (!run || run.project !== caller.project) throw new FlowRunError(`There is no run "${id}" in your project.`);
      const counts = Object.entries(run.counts).flatMap(([b, words]) => Object.entries(words).map(([w, n]) => `${titleOf(run, b)}: "${w}" ×${n}`));
      const sessions = Object.entries(run.sessions).map(([b, s]) => `${b === CALLER ? 'handed by its caller' : titleOf(run, b)}: ${s}`);
      return [
        `${runLabel(run)} in the flow "${flows?.titles.get(run.flow) ?? run.flow}", coordinated by ${this.who(run.coordinator)}: ${this.stateLine(run, titleOf(run, run.at))}.`,
        run.parent ? `Started by "${run.parent.block}" of ${run.parent.run}, which waits for it.` : '',
        run.worktree ? `Worktree: ${run.worktree.path} (branch ${run.worktree.branch}, from ${run.worktree.base}${run.worktree.own ? '' : `, its parent's`}).` : '',
        counts.length ? `Counts: ${counts.join('; ')}.` : '',
        sessions.length ? `Sessions: ${sessions.join('; ')}.` : '',
        run.history.length ? `History:\n${run.history.map((h) => `- ${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')} ${titleOf(run, h.block)}: "${h.word}"${h.n > 1 ? ` (${ordinal(h.n)} time)` : ''} by ${h.by} → ${h.to === null ? 'end' : titleOf(run, h.to)}`).join('\n')}` : 'No steps yet.',
      ].filter(Boolean).join('\n');
    }
    const runs = this.p.runs.list(caller.project, { limit: STATUS_LISTED });
    if (!runs.length) return 'No runs in your project yet; flow_start starts one.';
    return runs.map((r) => `- ${runLabel(r)}, flow "${flows?.titles.get(r.flow) ?? r.flow}": ${this.stateLine(r, titleOf(r, r.at))}`).join('\n');
  }

  /** The project's runs for the page, the latest changed first: the open ones and the latest others. */
  list(project: string): FlowRun[] {
    return this.p.runs.forPage(project);
  }

  // --- moving a run ----------------------------------------------------------------------------------

  private stateLine(run: FlowRun, at: string): string {
    if (run.state === 'ended') return `ended "${run.ending}"`;
    if (run.state === 'stopped') return `stopped (${run.ending})`;
    if (run.state === 'queued') return `queued ${run.queue === 'flow' ? 'to start' : `before "${at}"`}, number ${this.place(run)} in line`;
    return `${run.state === 'waiting' ? 'waiting' : 'at'} "${at}" since ${new Date(run.atSince).toISOString().slice(0, 16).replace('T', ' ')}`;
  }

  /**
   * Records a step and moves the run on; what the coordinator does next. A run a Run flow block started hands its
   * ending to that block (part 3b), which then moves its own run.
   */
  private async applyStep(flows: ProjectFlows, flow: Flow, run: FlowRun, block: FlowBlock, word: string, by: string, note: string | undefined): Promise<string> {
    let decision;
    try {
      decision = decideStep(flow, block.id, word, run.counts[block.id]);
    } catch (e) {
      throw new FlowRunError(`${(e as Error).message} Nothing was recorded.`);
    }
    // After the last counted outcome of its word the count starts again, so "two rounds, then a person" holds every
    // time round (#318, review of part 3a: a count that never reset let the 4th, 5th... time take the plain outcome).
    const key = endingKey(word);
    const last = Math.max(0, ...(block.outcomes ?? []).filter((o) => o.times && endingKey(o.word) === key).map((o) => o.times!));
    const counts = { ...run.counts, [block.id]: { ...run.counts[block.id], [key]: decision.outcome?.times && decision.outcome.times === last ? 0 : decision.n } };
    const said = decision.kind === 'end' ? decision.word : decision.outcome.word;
    const step: RunStep = {
      block: block.id, word: said, n: decision.n, to: decision.kind === 'move' ? decision.to : null, by, at: this.now(),
      ...(note?.trim() ? { note: short(note.trim(), NOTE_KEPT) } : {}),
    };
    const history = [...run.history, step];
    // Reported without the person's answer (the coordinator's word goes, the workflow guides): the question goes.
    // No lock (Simon, #1183): the history says who stepped, and the person reads why their question went.
    if (run.question !== null) this.p.withdraw(run.question, `${by} reported "${said}" for "${block.title}" of ${run.id} instead of waiting for your answer, and the run went on; its history on the workflow page says so.`);
    const counted = decision.kind === 'move' && decision.outcome.times ? ` (its ${ordinal(decision.n)} time)` : '';
    const handoff = this.handoff(run, flow, block, note);
    if (decision.kind === 'end') {
      const ended = this.p.runs.update(run.id, { at: null, atSince: this.now(), counts, history, state: 'ended', ending: decision.word, question: null }, this.now());
      this.p.changed(run.project);
      const after = await this.afterEnd(flows, ended, decision.word);
      const done = `Recorded "${said}" for "${block.title}". ${runLabel(ended)} has ended: "${decision.word}".${after ? ` ${after}` : ''}`;
      return ended.parent ? `${done} ${await this.childEnded(flows, ended, handoff)}` : done;
    }
    const next = flow.blocks.find((b) => b.id === decision.to)!;
    const moved = this.p.runs.update(run.id, { at: next.id, atSince: this.now(), counts, history, state: 'running', question: null }, this.now());
    this.p.changed(run.project);
    const text = `Recorded "${said}" for "${block.title}"${counted}: ${runLabel(moved)} goes to "${next.title}". ${await this.enterBlock(flows, moved, flow, next, handoff, false)}`;
    // A place freed at the block it left (part 3f).
    if (block.limit !== undefined) await this.release(run.project, flows);
    return text;
  }

  // --- part 3f: a worktree per run, runs at once, tidying -----------------------------------------------

  /**
   * Runs of a flow under way: started, also those in line before a block (they have started); not those waiting to
   * start. A Run flow block's runs count with their parent.
   */
  private working(project: string, flow: string): number {
    return this.p.runs.list(project, { open: true, limit: 10000 }).filter((r) => r.flow === flow && !r.parent && !(r.state === 'queued' && r.queue === 'flow')).length;
  }

  /** Runs at a block now, not in line before it. */
  private busyAt(project: string, flow: string, block: string, besides: string): number {
    return this.p.runs.list(project, { open: true, limit: 10000 }).filter((r) => r.flow === flow && r.at === block && r.id !== besides && r.state !== 'queued').length;
  }

  /** A queued run's place in its line: its flow's start, or the block it waits before; 1 is next. */
  private place(run: FlowRun): number {
    const line = this.p.runs.queued(run.project).filter((r) => r.flow === run.flow && r.queue === run.queue && (run.queue === 'flow' || r.at === run.at));
    return Math.max(1, line.findIndex((r) => r.id === run.id) + 1);
  }

  /**
   * A run starts work (part 3f): its worktree is made, or a child run takes its parent's, then it goes to its block. A
   * worktree git refuses holds the run in line instead (WorktreeHeld).
   */
  private async begin(flows: ProjectFlows, run: FlowRun, flow: Flow, handoff: Handoff, anyway: boolean): Promise<string> {
    let now = run;
    let note = '';
    const parent = now.parent ? this.p.runs.get(now.parent.run) : undefined;
    if (!now.worktree && parent?.worktree) {
      now = this.p.runs.update(now.id, { worktree: { ...parent.worktree, own: false } }, this.now());
    } else if (!now.worktree && !now.parent && flow.worktree) {
      const host = this.p.worktreeHost(now.project);
      try {
        if (!host) throw new Error('the project is not there.');
        const made = await makeWorktree(host, now, flow.worktree, this.p.worktreeSetup(now.project));
        now = this.p.runs.update(now.id, { worktree: made.worktree }, this.now());
        note = `Ledung made its worktree ${made.worktree.path} on branch ${made.worktree.branch}, from ${made.worktree.base}; its sessions work there.` +
          (made.setupProblem ? ` The project's setup command failed there: ${made.setupProblem}` : '');
      } catch (e) {
        // Held in line, not run in the project folder, where runs would share what the flow keeps apart (final review
        // of part 3, finding 6). It takes no place; each place that frees tries it again, and Start anyway does now.
        const held = this.p.runs.update(now.id, { state: 'queued', queue: 'flow' }, this.now());
        this.held.add(held.id);
        this.p.changed(now.project);
        throw new WorktreeHeld(`Ledung could not make its worktree: ${(e as Error).message} ${runLabel(held)} is held in line at its start, with no session started: once the cause is fixed, ${this.p.userName} can start it anyway from the Runs list; or stop it with stop: true.`);
      }
    }
    now = this.p.runs.update(now.id, { state: 'running', queue: null, atSince: this.now() }, this.now());
    this.p.changed(now.project);
    const block = flow.blocks.find((b) => b.id === now.at) ?? startBlock(flow);
    return `${note ? `${note} ` : ''}${await this.enterBlock(flows, now, flow, block, handoff, anyway)}`;
  }

  /** A run comes to a block (part 3f): in line before it when the block has its limit of runs, else it acts. */
  private async enterBlock(flows: ProjectFlows, run: FlowRun, flow: Flow, block: FlowBlock, handoff: Handoff, anyway: boolean): Promise<string> {
    if (!anyway && block.limit !== undefined && this.busyAt(run.project, run.flow, block.id, run.id) >= block.limit) {
      const queued = this.p.runs.update(run.id, { state: 'queued', queue: 'block', at: block.id, atSince: this.now() }, this.now());
      this.p.changed(run.project);
      return `"${block.title}" (${block.id}) takes ${block.limit} at once, so ${run.id} waits before it, number ${this.place(queued)} in line: Ledung goes on when one leaves it, and tells you.`;
    }
    return this.arrive(flows, run, flow, block, handoff);
  }

  /** What the last step of a run handed on, for a run that goes on after waiting in line. */
  private lastHandoff(run: FlowRun, flow: Flow): Handoff {
    const last = run.history.at(-1);
    const from = last && flow.blocks.find((b) => b.id === last.block);
    return from ? this.handoff(run, flow, from, last.note) : null;
  }

  /** Queued runs that now have a place go on, first in line first; their coordinators are told (part 3f). */
  private async release(project: string, known: ProjectFlows | null): Promise<void> {
    const flows = known ?? await this.p.flows(project).catch(() => null);
    if (!flows) return;
    for (const q of this.p.runs.queued(project)) {
      const run = this.p.runs.get(q.id)!;
      if (run.state !== 'queued') continue;
      // Held for its worktree: tried again by Start anyway, not at every place that frees (second review of the fixes).
      if (this.held.has(run.id)) continue;
      const flow = flows.flows.get(run.flow);
      // A run waiting to start goes to the flow's start as it is now, should its block have been renamed (review of 3f).
      const block = flow?.blocks.find((b) => b.id === run.at) ?? (flow && run.queue === 'flow' ? startBlock(flow) : undefined);
      if (!flow || !block) continue;
      let text: string;
      try {
        if (run.queue === 'flow') {
          if (flow.limit !== undefined && this.working(project, run.flow) >= flow.limit) continue;
          text = await this.begin(flows, run, flow, null, false);
        } else {
          if (block.limit !== undefined && this.busyAt(project, run.flow, block.id, run.id) >= block.limit) continue;
          text = await this.arrive(flows, this.p.runs.update(run.id, { state: 'running', queue: null }, this.now()), flow, block, this.lastHandoff(run, flow));
        }
      } catch (e) {
        text = `but it could not go on: ${(e as Error).message}`;
      }
      this.p.changed(project);
      this.tellCoordinator(run, `Ledung: ${runLabel(run)} is out of line. ${text}`);
    }
  }

  /**
   * A run ended or was stopped (part 3f): its sessions are tidied as the flow says (archived by default), its worktree
   * removed if the flow says so and it is safe, and runs in line go on. What happened, for the coordinator.
   */
  private async afterEnd(flows: ProjectFlows | null, run: FlowRun, ending: string): Promise<string> {
    const flow = flows?.flows.get(run.flow) ?? null;
    // Its Run flow blocks' runs stopped with it are tidied too, before its worktree, which they share (review of 3f).
    for (const child of this.p.runs.children(run.id)) {
      if (child.state === 'stopped') await this.tidy(child, flows?.flows.get(child.flow) ?? null, STOPPED_ENDING).catch(() => '');
    }
    const safely = (part: () => Promise<string>) => part().catch((e: Error) => `Ledung could not finish tidying: ${e.message}`);
    try {
      return [await safely(() => this.tidy(run, flow, ending)), await safely(() => this.dropWorktree(run, flow, ending))].filter(Boolean).join(' ');
    } finally {
      await this.release(run.project, flows).catch(() => {});
    }
  }

  /** The flow's tidying of a run's sessions on this ending: archive (the default), stop or keep. */
  private async tidy(run: FlowRun, flow: Flow | null, ending: string): Promise<string> {
    const t = flow?.tidy ?? DEFAULT_TIDY;
    const mode = typeof t === 'string' ? t : !t.on || t.on.some((e) => endingKey(e) === endingKey(ending)) ? t.sessions : 'keep';
    if (mode === 'keep') return '';
    // A session another open run still uses (its parent's, handed on as the caller's) is that run's.
    const others = new Set(this.p.runs.list(run.project, { open: true, limit: 10000 }).filter((r) => r.id !== run.id).flatMap((r) => Object.values(r.sessions)));
    // Its blocks' sessions as they are now, and the ones a block had on an earlier visit (the try-out of 3f: a first
    // review's session was left out).
    const ids = [...new Set([...Object.entries(run.sessions).filter(([k]) => k !== CALLER).map(([, id]) => id), ...this.p.sessionsOf(run.project, run.id)])].filter((id) => !others.has(id));
    const done: string[] = [];
    const working: string[] = [];
    for (const id of ids) {
      const s = this.p.getSession(id);
      if (!s || s.archivedAt) continue;
      // Mid-turn, on a prompt or in line for a place, are all still working (review of 3f).
      if (s.status === 'running' || s.status === 'starting' || s.status === 'stopping' || s.status === 'waiting' || s.status === 'queued') {
        working.push(`"${s.title}"`);
        continue;
      }
      if (s.status !== 'ended') await this.p.stopSession(id, `${run.id} ended.`).catch(() => {});
      // One that couldn't be stopped or archived stays as it is, said; the rest of the ending goes on (review of 3f).
      try {
        if (mode === 'archive' && this.p.getSession(id)?.status === 'ended') this.p.archiveSession(id, `Ledung (${run.id} ended)`);
      } catch {
        working.push(`"${s.title}"`);
        continue;
      }
      done.push(id);
    }
    if (!done.length && !working.length) return '';
    return `Its sessions: ${done.length} ${mode === 'archive' ? 'archived' : 'stopped'}${working.length ? `; ${working.join(', ')} still working, so kept` : ''}.`;
  }

  /** The run's own worktree removed if the flow says so on this ending and it is safe; else kept, with why. */
  private async dropWorktree(run: FlowRun, flow: Flow | null, ending: string): Promise<string> {
    const wt = run.worktree;
    if (!wt?.own) return '';
    const remove = flow?.worktree?.remove;
    if (remove === 'never') return `Its worktree ${wt.path} stays: the flow keeps worktrees.`;
    if (remove?.on && !remove.on.some((e) => endingKey(e) === endingKey(ending))) return `Its worktree ${wt.path} stays: the flow removes it only on ${remove.on.map((e) => `"${e}"`).join(', ')}.`;
    const host = this.p.worktreeHost(run.project);
    if (!host) return `Its worktree ${wt.path} stays: the project is not there.`;
    // Never under a session still in it, whatever its tidying kept (review of 3f).
    const inIt = this.p.workingIn(run.project, wt.path);
    if (inIt.length) return `Its worktree ${wt.path} is kept: ${inIt.map((t) => `"${t}"`).join(', ')} still ${inIt.length === 1 ? 'works' : 'work'} in it. Stop ${inIt.length === 1 ? 'it' : 'them'}, then remove it (git worktree remove).`;
    const r = await removeWorktree(host, wt);
    if ('removed' in r) {
      this.p.runs.update(run.id, { worktree: null }, this.now());
      this.p.changed(run.project);
      return `Its worktree ${wt.path} is removed.`;
    }
    return `Its worktree ${wt.path} is kept: ${r.kept}. Deal with that, then remove it (git worktree remove).`;
  }

  /**
   * What the step just done hands on: the coordinator's note, else the last reply of the session that ran it; a block
   * with neither (a person's answered with its word alone, the manager's) passes on what it was handed itself (review of
   * 3b, finding 8).
   */
  private handoff(run: FlowRun, flow: Flow, block: FlowBlock, note: string | undefined): Handoff {
    if (note?.trim()) return { from: block.title, text: short(note.trim(), HANDOFF_MAX) };
    const reply = (id: string | undefined) => (id ? this.p.lastReply(id).trim() : '');
    if (reply(run.sessions[block.id])) return { from: block.title, text: short(reply(run.sessions[block.id]), HANDOFF_MAX) };
    const into = [...run.history].reverse().find((h) => h.to === block.id);
    if (!into || into.block === block.id) return null;
    const from = flow.blocks.find((b) => b.id === into.block)?.title ?? into.block;
    const text = into.note ?? reply(run.sessions[into.block]);
    return text ? { from, text: short(text, HANDOFF_MAX) } : null;
  }

  /** A child run ended (part 3b): its ending is the outcome of the Run flow block that waits for it. */
  private async childEnded(flows: ProjectFlows, child: FlowRun, handoff: Handoff): Promise<string> {
    const parent = this.p.runs.get(child.parent!.run);
    if (!parent || parent.state !== 'waiting' || parent.at !== child.parent!.block) return `${child.parent!.run} no longer waits for it at "${child.parent!.block}".`;
    const flow = flows.flows.get(parent.flow);
    const block = flow?.blocks.find((b) => b.id === parent.at);
    if (!flow || !block) return `${runLabel(parent)} waits at "${parent.at}", which is no block of its flow any more: report its outcome yourself with flow_step, or stop it.`;
    try {
      return `It was run by "${block.title}" of ${runLabel(parent)}: ${await this.applyStep(flows, flow, parent, block, child.ending!, `the flow "${flows.titles.get(child.flow) ?? child.flow}" (${child.id})`, handoff?.text)}`;
    } catch (e) {
      return `${runLabel(parent)} waits at "${block.title}" for it, but ${(e as Error).message} Report the outcome yourself with flow_step (run "${parent.id}").`;
    }
  }

  private stopRun(run: FlowRun, why: string, by: string, flows: ProjectFlows | null): string {
    this.held.delete(run.id);
    if (run.question !== null) this.p.withdraw(run.question, `The run was stopped: ${why}.`);
    // A run's own Run flow blocks' runs stop with it; a parent waiting for this one is said (review of 3b, finding 5).
    for (const child of this.p.runs.children(run.id)) if (OPEN_STATES.includes(child.state)) this.stopRun(child, `${run.id}, which it ran for, was stopped`, by, flows);
    const parent = run.parent ? this.p.runs.get(run.parent.run) : undefined;
    const waits = parent && parent.state === 'waiting' && parent.at === run.parent!.block
      ? ` ${runLabel(parent)} still waits at "${parent.at}" for it: report that block's outcome with flow_step, or stop it.`
      : '';
    const step: RunStep = { block: run.at ?? '', word: 'stopped', n: 1, to: null, by, at: this.now(), note: why.slice(0, NOTE_KEPT) };
    this.p.runs.update(run.id, { state: 'stopped', ending: why, history: [...run.history, step], question: null }, this.now());
    this.p.changed(run.project);
    const at = flows?.flows.get(run.flow)?.blocks.find((b) => b.id === run.at)?.title ?? run.at;
    if (waits && by === 'Ledung') this.tellCoordinator(run, `Ledung: ${runLabel(run)} was stopped (${why}).${waits}`);
    return `${runLabel(run)} is stopped${at ? ` at "${at}"` : ''}: ${why}.${waits}`;
  }

  /** The person's Stop in the Runs list (final review of part 3, finding 3): as flow_step's stop, the coordinator told. */
  stopByPerson(project: string, id: string, by: string): Promise<string> {
    return this.one(project, async () => {
      const run = this.p.runs.get(id);
      if (!run || run.project !== project) throw new FlowRunError(`There is no run "${id}" in ${project}.`);
      if (!OPEN_STATES.includes(run.state)) throw new FlowRunError(`${runLabel(run)} has ${run.state === 'ended' ? `ended (${run.ending})` : 'been stopped'} already.`);
      const flows = await this.p.flows(project).catch(() => null);
      const stopped = this.stopRun(run, `stopped by ${by} from the Runs list`, by, flows);
      const text = `${stopped} ${await this.afterEnd(flows, this.p.runs.get(run.id)!, STOPPED_ENDING)}`.trim();
      this.tellCoordinator(run, `Ledung: ${text}`);
      return text;
    });
  }

  /** A project removed: its open runs stop, so a project added later under its name doesn't take them over (review of 3a). */
  stopProject(project: string, why: string): void {
    for (const run of this.p.runs.list(project, { open: true, limit: 10000 })) this.stopRun(run, why, 'Ledung', null);
  }

  /**
   * What happens at a block the run has just reached (part 3b), and what the coordinator is told: a new session is
   * started with the block's settings, a continued one gets the step, a person is asked, a Run flow block starts its
   * flow; the manager's own step is said with its brief. The coordinator still reads each result and reports it.
   */
  private async arrive(flows: ProjectFlows, run: FlowRun, flow: Flow, block: FlowBlock, handoff: Handoff): Promise<string> {
    const at = `"${block.title}" (${block.id})`;
    const outs = `Its outcomes: ${outcomeList(flow, block, run.counts[block.id])}.`;
    const report = `Judge its result against them and report with flow_step (run "${run.id}", the outcome's word).`;
    try {
      if (block.kind === 'person') return await this.askPerson(flows, run, flow, block, handoff);
      if (block.kind === 'flow') return await this.startChild(flows, run, block, handoff);
      if (block.kind === 'wait') return await this.waitAt(flows, run, flow, block, handoff);
      if (block.runs === 'new-session' || block.runs === 'continue') {
        const s = await this.blockSession(flows, run, flow, block, handoff);
        return `At ${at}: ${s}. Ledung tells you when it finishes a turn. ${outs} ${report}`;
      }
    } catch (e) {
      return `At ${at}, but Ledung could not do it: ${(e as Error).message} Do the step yourself, or stop the run. ${outs} ${report}`;
    }
    const brief = await this.briefOf(flows, block);
    const subs = block.substeps?.length ? `\n\n${this.substepsLine(flows, block)}` : '';
    const given = handoff ? `\n\n"${handoff.from}" handed on:\n\n${handoff.text}` : '';
    const tree = run.worktree ? ` The run's worktree: ${run.worktree.path} (branch ${run.worktree.branch}).` : '';
    return `At ${at}: ${block.runs === 'manager' ? 'your own step' : 'a step for you to see through'}.${tree}${given}${brief ? `\n\n${brief}` : ''}${subs}\n\n${outs} ${report}`;
  }

  /**
   * A wait (part 3d): the run waits on something outside the flow (a merge queue, CI, someone else's approval), shown
   * as waiting with how long, until the coordinator reports how it came out.
   */
  private async waitAt(flows: ProjectFlows, run: FlowRun, flow: Flow, block: FlowBlock, handoff: Handoff): Promise<string> {
    this.p.runs.update(run.id, { state: 'waiting' }, this.now());
    this.p.changed(run.project);
    const brief = await this.briefOf(flows, block);
    const given = handoff ? `\n\n"${handoff.from}" handed on:\n\n${handoff.text}` : '';
    return `At "${block.title}" (${block.id}), a wait: ${run.id} waits there (the workflow page shows how long) until you report how it came out.${given}${brief ? `\n\n${brief}` : ''}\n\n` +
      `Its outcomes: ${outcomeList(flow, block, run.counts[block.id])}. Report with flow_step (run "${run.id}", the outcome's word) when it comes.`;
  }

  /** The block's brief as the one doing it reads it: its text, or where it is when it is long or can't be read. */
  private async briefOf(flows: ProjectFlows, block: FlowBlock): Promise<string> {
    if (!block.brief) return '';
    const text = await flows.text(block.brief).catch(() => null);
    const where = briefPlace(flows.folder, block.brief);
    return text !== null && text.length <= BRIEF_INLINE
      ? `The brief (${block.brief}):\n\n${text.trim()}`
      : `The brief: read ${where}.`;
  }

  private substepsLine(flows: ProjectFlows, block: FlowBlock): string {
    const subs = (block.substeps ?? []).map((sub) => {
      const outs = (sub.outcomes ?? []).map((o) => `"${o.word}"${o.times ? ` (${ordinal(o.times)} time)` : ''} → ${o.to}`).join(', ');
      // Named where it is, as the block's own brief is: the subagent has no workflow folder to look in (ledung#142).
      const brief = sub.brief ? `, brief ${briefPlace(flows.folder, sub.brief)}` : '';
      if (sub.brief && !exercised142) {
        exercised142 = true;
        exercisedLine('EXERCISED #142 sub-step brief named with its folder');
      }
      return `- ${sub.title} (${sub.kind}, when ${sub.when ?? 'done'}${sub.model ? `, model ${sub.model}` : ''}${brief})${outs ? `: ${outs}` : ''}`;
    });
    // Part 3d: four reviewers at once, say; their results come back as one report.
    return block.parallel
      ? `Start these subagents all at once, in parallel, and merge their results into one report:\n${subs.join('\n')}`
      : `Start these subagents, in order:\n${subs.join('\n')}`;
  }

  /** The step for a block's session: which run and block, the brief, the sub-steps, the handoff, the words to end with. */
  private async handoffText(flows: ProjectFlows, run: FlowRun, block: FlowBlock, handoff: Handoff): Promise<string> {
    const words = [...new Map((block.outcomes ?? []).map((o) => [endingKey(o.word), o.word])).values()];
    return [
      `You run "${block.title}" (block ${block.id}) of ${runLabel(run)}, in the flow "${flows.titles.get(run.flow) ?? run.flow}". Ledung started this from the flow; ${this.who(run.coordinator)} coordinates the run.`,
      run.worktree ? `The run has its own git worktree, ${run.worktree.path}, on branch ${run.worktree.branch} (from ${run.worktree.base}): work and commit there, not in the project folder.` : '',
      await this.briefOf(flows, block),
      block.substeps?.length ? this.substepsLine(flows, block) : '',
      handoff ? `What "${handoff.from}" handed on:\n\n${handoff.text}` : '',
      words.length ? `When you are done, end your report with how it went, one of: ${words.map((w) => `"${w}"`).join(', ')}. Your coordinator reads it and decides.` : '',
    ].filter(Boolean).join('\n\n');
  }

  /** A new session for the block, or the session it continues, given the step; recorded on the run. */
  private async blockSession(flows: ProjectFlows, run: FlowRun, flow: Flow, block: FlowBlock, handoff: Handoff): Promise<string> {
    const text = await this.handoffText(flows, run, block, handoff);
    const runBlock: RunBlock = { run: run.id, block: block.id, runTitle: run.title, blockTitle: block.title, flow: run.flow };
    // The session that ran the block it continues, or the one that started that chain (Fix continues Build); in a flow
    // handed its caller's session (part 3d), a new-session block continues that one.
    // Only work goes on in the caller's session: a check starts its own, so no one reviews their own work across flows
    // (review of 3d, as continueProblems holds within one flow).
    const handed = block.kind === 'work' ? run.sessions[CALLER] : undefined;
    const own = block.runs === 'continue'
      ? run.sessions[block.continues ?? ''] ?? run.sessions[sessionOf(flow, block.id) ?? ''] ?? handed
      : handed;
    if (own && this.p.getSession(own)) {
      // A fresh context first, when the block says so (part 3f): compacted, or cleared with the step as its handoff.
      await this.p.continueSession(own, text, runBlock, block.runs === 'continue' && block.context ? { context: block.context, by: run.coordinator } : undefined);
      this.p.runs.update(run.id, { sessions: { ...run.sessions, [block.id]: own } }, this.now());
      this.p.changed(run.project);
      const which = block.runs === 'continue' && block.continues && run.sessions[block.continues] === own
        ? `which ran "${flow.blocks.find((b) => b.id === block.continues)?.title ?? block.continues}"`
        : own === run.sessions[CALLER] ? "the caller's session this flow was handed" : `which ran "${flow.blocks.find((b) => b.id === sessionOf(flow, block.id))?.title ?? block.continues}"`;
      const fresh = block.runs === 'continue' && block.context ? `, ${block.context === 'compact' ? 'compacted' : 'cleared'} first` : '';
      return `Ledung gave it to session "${this.p.getSession(own)?.title}" (${own}), ${which}${fresh}`;
    }
    // A new session: the block's own, or one for a continued block whose session isn't there (said so).
    const from = block.runs === 'continue' ? flow.blocks.find((b) => b.id === sessionOf(flow, block.id)) ?? block : block;
    const s = await this.p.startSession({
      project: run.project, coordinator: run.coordinator, title: short(`${block.title}: ${run.title}`, 80), task: text,
      model: block.model ?? from.model, profile: block.profile ?? from.profile, runBlock,
      ...(run.worktree ? { cwd: run.worktree.path } : {}),
    });
    // The block's session from an earlier round has done its part: stopped, unless another block of the run still uses
    // it (a continued one), so a loop doesn't leave a session behind each round (review of 3b, finding 4).
    const earlier = run.sessions[block.id];
    // Nor one an open run of its Run flow blocks goes on in (the caller's session, review of 3d).
    const inChildren = (id: string) => this.p.runs.children(run.id).some((c) => OPEN_STATES.includes(c.state) && Object.values(c.sessions).includes(id));
    if (earlier && earlier !== s.id && !Object.entries(run.sessions).some(([b, id]) => b !== block.id && id === earlier) && !inChildren(earlier)) {
      await this.p.stopSession(earlier, `A new session took "${block.title}" of ${run.id}.`).catch(() => {});
    }
    this.p.runs.update(run.id, { sessions: { ...run.sessions, [block.id]: s.id } }, this.now());
    this.p.changed(run.project);
    const settings = [s.requestedModel ? `model ${s.requestedModel}` : '', s.profile ? `profile ${s.profile}` : ''].filter(Boolean).join(', ');
    return `Ledung started session "${s.title}" (${s.id})${settings ? ` with ${settings}` : ''}${block.runs === 'continue' ? `, as no session of "${from.title}" was there to continue` : ''}`;
  }

  /** The outcome words of a block, once each, in the flow's spelling. */
  private static words(block: FlowBlock): string[] {
    return [...new Map((block.outcomes ?? []).map((o) => [endingKey(o.word), o.word])).values()];
  }

  /** Where each of a person block's outcomes takes the run, for the one who asks and the one who answers. */
  private static whereTo(flow: Flow, block: FlowBlock): string {
    const titleOf = (id: string | undefined) => flow.blocks.find((b) => b.id === id)?.title ?? id;
    return (block.outcomes ?? []).map((o) => `"${o.word}"${o.times ? ` (${ordinal(o.times)} time)` : ''} → ${o.end ? 'the flow ends' : titleOf(o.to)}`).join('; ') || 'the flow ends';
  }

  /** The outcome an answer takes at a block, said for the one who asks. */
  private static mapped(block: FlowBlock, answer: string): string {
    const w = answerWord(block, answer);
    return w ? `"${w}"` : 'no outcome (it comes back to you)';
  }

  /**
   * A person block (part 3b) reached (#291, Martin 2026-11-12, Ledung question #872): Ledung asks nothing itself. The
   * coordinator writes it up and asks it with ask_user, naming the run and block, and the person's answer moves the run
   * as before. Ledung's own card comes only when none was asked in time (overdue). The words that say how, and what a
   * good write-up holds, are Ledung's own, so every manager gets them whatever its workflow files say.
   */
  private async askPerson(flows: ProjectFlows, run: FlowRun, flow: Flow, block: FlowBlock, handoff: Handoff): Promise<string> {
    this.p.runs.update(run.id, { state: 'waiting', question: null, atSince: this.now() }, this.now());
    this.p.changed(run.project);
    const user = this.p.userName;
    const whose = block.person ? ` It is ${block.person}'s call; ${user} is asked all the same.` : '';
    const brief = await this.briefOf(flows, block);
    const words = FlowRuns.words(block);
    const how = block.ask === 'review'
      ? `Ask it as a review (review with solving, done, notes and evidence; title, tier and refs): "${ACCEPTED}" takes ${FlowRuns.mapped(block, ACCEPTED)}, "${CHANGES_NEEDED} …" takes ${FlowRuns.mapped(block, `${CHANGES_NEEDED} x`)}.`
      : words.length
        ? `Ask it as a question with options, each option's outcome one of the block's words: ${FlowRuns.whereTo(flow, block)}. An answer that is none of them comes back to you to report.`
        : 'The block has no outcomes, so any answer ends the flow; ask it as a question.';
    return [
      `At "${block.title}" (${block.id}), a person's step: ${user} decides.${whose} Ledung has asked nothing: write it up and ask it now with ask_user, giving run "${run.id}" and block "${block.id}". ${user}'s answer then moves the run by itself, and you are told where it went; you need not report it.`,
      how,
      `Write it for someone who has not followed the work and reads it on a phone: the backstory (what the work is and why, each decision quoted with who made it and when), what was done, the evidence (what ran and its results), the options with their cost, your recommendation as an opinion, and other sessions' views (the reviewers') as their own opinions. Not the flow's process text: that is for you.`,
      `If you have not asked within ${WRITE_UP_MINUTES} minutes, Ledung asks its own short card instead, marked as having no write-up from you.`,
      run.worktree ? `The run's worktree: ${run.worktree.path} (branch ${run.worktree.branch}).` : '',
      handoff ? `"${handoff.from}" handed on:\n\n${handoff.text}` : '',
      brief ? `For you, not for ${user}: ${brief}` : '',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Ledung's own card for a person block whose coordinator gave no write-up in time (#291): the run and what was handed
   * on, headed so the person knows it is Ledung's, and without the block's brief, which is process text for the manager.
   */
  private lateCard(run: FlowRun, flow: Flow, flowTitle: string, block: FlowBlock, handoff: Handoff): QuestionInfo {
    const words = FlowRuns.words(block);
    const where = FlowRuns.whereTo(flow, block);
    const tag: QuestionRun = { run: run.id, block: block.id, runTitle: run.title, blockTitle: block.title, flow: run.flow, ...(block.person ? { person: block.person } : {}) };
    // Part 3d: whose call it is; this computer's person is asked all the same.
    const whose = block.person ? ` It is ${block.person}'s call.` : '';
    const refs = run.ref ? { refs: [run.ref] } : {};
    const title = short(`${LATE_HEAD}: ${block.title}, ${run.title}`, 200);
    const head = `**${LATE_HEAD}.** Ledung wrote this card from the run alone, ${WRITE_UP_MINUTES} minutes after the run got here, so it has no backstory, evidence or recommendation.`;
    const details: QuestionDetails = block.ask === 'review'
      ? {
        title, tier: this.p.tiers(run.project)[0], ...refs, run: tag,
        review: {
          solving: `${head}\n\n${run.title}${run.ref ? ` (${run.ref})` : ''}, in the flow "${flowTitle}".`,
          done: handoff ? `${handoff.from}: ${handoff.text}` : `See ${run.id}'s history on the workflow page.`,
          notes: `Your answer moves ${run.id} by itself: ${where}.${whose}`,
        },
      }
      : {
        title, tier: this.p.tiers(run.project)[0], ...refs, run: tag,
        issue: [head, `${run.title}${run.ref ? ` (${run.ref})` : ''} is at "${block.title}" in the flow "${flowTitle}". Your answer moves it: ${where}.${whose}`, handoff ? `"${handoff.from}" handed on:\n\n${handoff.text}` : ''].filter(Boolean).join('\n\n'),
      };
    return this.p.ask({ coordinator: run.coordinator, question: questionText(undefined, details), options: block.ask === 'review' || !words.length ? null : words.slice(0, 8), details });
  }

  /**
   * Person blocks left without a write-up (#291): each run that has waited at one for WRITE_UP_MINUTES with no question
   * gets Ledung's own card, linked to it as a write-up is, and its coordinator is told. Called every minute.
   */
  async overdue(): Promise<void> {
    const cutoff = this.now() - WRITE_UP_MINUTES * 60_000;
    for (const due of this.p.runs.awaitingWriteUp(cutoff)) {
      await this.one(due.project, async () => {
        const run = this.p.runs.get(due.id);
        if (!run || run.state !== 'waiting' || run.question !== null || run.at !== due.at || run.atSince > cutoff) return;
        if (!this.p.following(run.project)) return;
        const flows = await this.p.flows(run.project).catch(() => null);
        const flow = flows?.flows.get(run.flow);
        const block = flow?.blocks.find((b) => b.id === run.at);
        if (!flows || !flow || !block || block.kind !== 'person') return;
        const q = this.lateCard(run, flow, flows.titles.get(run.flow) ?? run.flow, block, this.lastHandoff(run, flow));
        this.p.runs.update(run.id, { question: q.id }, this.now());
        this.p.changed(run.project);
        this.tellCoordinator(run, `Ledung: no write-up came for "${block.title}" of ${runLabel(run)} within ${WRITE_UP_MINUTES} minutes, so Ledung asked ${this.p.userName} its own card, ${block.ask === 'review' ? 'review' : 'question'} #${q.id}. Its answer moves the run by itself; don't ask it again.`);
      }).catch((e) => console.error(`Workflow: ${(e as Error).message}`));
    }
  }

  /**
   * ask_user giving a run and block (#291): checks that the caller may ask that step now and that its options lead to
   * the block's outcomes, before anything is stored. The tag goes on the question; the options come back with each
   * outcome in the flow's own spelling. Refused with the valid runs, blocks or words listed.
   */
  async writeUp(callerId: string, args: { run: string; block: string; review: boolean; options?: (string | QuestionOption)[] }): Promise<{ tag: QuestionRun; options?: (string | QuestionOption)[] }> {
    const caller = this.p.getSession(callerId);
    if (!caller) throw new FlowRunError('Your session is not known to Ledung.');
    const waiting = () => {
      const open = this.p.runs.list(caller.project, { open: true, limit: 10000 })
        .filter((r) => r.state === 'waiting' && r.question === null && (r.coordinator === callerId || this.p.managerOf(r.project) === callerId));
      return open.length ? `Runs waiting for your write-up: ${open.map((r) => `${r.id} at block "${r.at}"`).join(', ')}.` : 'No run of yours waits for a write-up now.';
    };
    let run: FlowRun;
    try {
      run = this.ownRun(callerId, args.run);
    } catch (e) {
      throw new FlowRunError(`${(e as Error).message} ${waiting()} Nothing was asked.`);
    }
    const flows = await this.flowsOf(run.project);
    const flow = this.flowOf(flows, run);
    const block = flow.blocks.find((b) => b.id === run.at);
    if (!block || run.state !== 'waiting' || block.kind !== 'person') {
      throw new FlowRunError(`${runLabel(run)} is ${block ? `at "${block.title}"` : run.state === 'ended' || run.state === 'stopped' ? run.state : `at "${run.at}"`}, which is no person's step waiting for a write-up. ${waiting()} Nothing was asked.`);
    }
    const want = args.block.trim().toLowerCase();
    if (want !== block.id && want !== block.title.toLowerCase()) {
      throw new FlowRunError(`${runLabel(run)} is at "${block.title}" (block ${block.id}), not "${args.block.trim()}". Nothing was asked.`);
    }
    if (run.question !== null) throw new FlowRunError(`"${block.title}" of ${runLabel(run)} is already asked, as question #${run.question}; its answer moves the run. Nothing was asked.`);
    const review = block.ask === 'review';
    if (review !== args.review) {
      throw new FlowRunError(review
        ? `"${block.title}" is a review: give review (solving, done, notes, evidence), not a question. "${ACCEPTED}" takes ${FlowRuns.mapped(block, ACCEPTED)}, "${CHANGES_NEEDED}" takes ${FlowRuns.mapped(block, `${CHANGES_NEEDED} x`)}. Nothing was asked.`
        : `"${block.title}" is a question, not a review: give issue, evidence, options (each with its outcome) and opinions. Nothing was asked.`);
    }
    const tag: QuestionRun = { run: run.id, block: block.id, runTitle: run.title, blockTitle: block.title, flow: run.flow, ...(block.person ? { person: block.person } : {}) };
    const words = FlowRuns.words(block);
    if (review || !words.length) return { tag, options: args.options };
    const list = `The block's outcomes: ${FlowRuns.whereTo(flow, block)}.`;
    if (!args.options?.length) throw new FlowRunError(`Give options, each leading to one of the block's outcomes, so the answer can move the run. ${list} Nothing was asked.`);
    const wordOf = (w: string | undefined) => (w === undefined ? undefined : words.find((x) => endingKey(x) === endingKey(w.replace(RECOMMENDED, '').replace(/[.!]+$/, ''))));
    const options = args.options.map((o, i) => {
      if (typeof o === 'string') {
        if (!wordOf(o)) throw new FlowRunError(`Option ${i + 1}, "${o}", is not one of the block's outcome words: give it as one, or give options as objects with an outcome each. ${list} Nothing was asked.`);
        return o;
      }
      const w = wordOf(o.outcome);
      if (!w) throw new FlowRunError(`Option "${o.key}" ${o.outcome ? `leads to "${o.outcome}", which is no outcome of "${block.title}"` : 'has no outcome'}: give each option the outcome its answer leads to. ${list} Nothing was asked.`);
      return { ...o, outcome: w };
    });
    return { tag, options };
  }

  /**
   * The write-up was stored (#291): the run waits for its answer as it did for Ledung's own question. When the run moved
   * while it was being asked, the question is withdrawn and the asker told.
   */
  writeUpAsked(q: QuestionInfo): void {
    const tag = q.details?.run;
    const run = tag ? this.p.runs.get(tag.run) : undefined;
    if (!tag || !run) return;
    if (run.state !== 'waiting' || run.at !== tag.block || run.question !== null) {
      this.p.withdraw(q.id, `${tag.run} moved on while it was being asked.`);
      throw new FlowRunError(`${runLabel(run)} moved on while question #${q.id} was being asked, so it is withdrawn; flow_status shows where the run is.`);
    }
    this.p.runs.update(run.id, { question: q.id }, this.now());
    this.p.changed(run.project);
    if (!exercised291) {
      exercised291 = true;
      exercisedLine("EXERCISED #291 a person step asked with the manager's write-up");
    }
  }

  /** A Run flow block (part 3b): a run of its own in the flow it names, which this one waits for. */
  private async startChild(flows: ProjectFlows, run: FlowRun, block: FlowBlock, handoff: Handoff): Promise<string> {
    const name = block.flow ?? '';
    const flow = flows.flows.get(name);
    if (!flow) throw new Error(`the flow "${name}" it runs is not there.`);
    // Counted up the parent chain, so a flow that runs itself one step at a time is held too (review of 3b, finding 6).
    let depth = 0;
    for (let r: FlowRun | undefined = run; r?.parent && depth <= NESTED_MAX; r = this.p.runs.get(r.parent.run)) depth++;
    if (depth >= NESTED_MAX) throw new Error(`runs started by Run flow blocks go at most ${NESTED_MAX} deep.`);
    this.p.runs.update(run.id, { state: 'waiting' }, this.now());
    const first = startBlock(flow);
    const child = this.p.runs.create({ project: run.project, title: run.title, ref: run.ref, flow: name, at: first.id, coordinator: run.coordinator, parent: { run: run.id, block: block.id }, now: this.now() });
    // Part 3d: the session that ran the step before goes on in the called flow, whose session blocks continue it.
    const caller = block.session === 'caller' ? this.callerSession(run, flows.flows.get(run.flow) ?? flow) : undefined;
    if (caller) this.p.runs.update(child.id, { sessions: { [CALLER]: caller } }, this.now());
    this.p.changed(run.project);
    const hands = block.session !== 'caller' ? '' : caller ? ` It goes on in the caller's session ${caller}.` : ' No session ran before it, so its session steps start their own.';
    return `At "${block.title}" (${block.id}): Ledung started ${child.id} in the flow "${flows.titles.get(name) ?? name}" for it, and ${run.id} waits; the way ${child.id} ends is "${block.title}"'s outcome.${hands}\n\n` +
      `${child.id}: ${await this.begin(flows, this.p.runs.get(child.id)!, flow, handoff, false)}`;
  }

  /**
   * The session that ran the latest work step of a run, or that its own caller handed it (part 3d): the long session
   * whose phases the flows are, never a reviewer's (review of 3d).
   */
  private callerSession(run: FlowRun, flow: Flow): string | undefined {
    for (const h of [...run.history].reverse()) {
      const id = run.sessions[h.block];
      if (id && flow.blocks.find((b) => b.id === h.block)?.kind === 'work' && this.p.getSession(id)) return id;
    }
    const handed = run.sessions[CALLER];
    return handed && this.p.getSession(handed) ? handed : undefined;
  }

  // --- events ----------------------------------------------------------------------------------------

  /**
   * The person answered a question (part 3b): one a person block asked moves its run by the answer's word (answerWord).
   * Anything else is left for the coordinator to read and report. The coordinator is told either way.
   */
  onAnswered(q: QuestionInfo): Promise<void> {
    const run = q.answer === null ? undefined : this.p.runs.byQuestion(q.id);
    if (!run) return Promise.resolve();
    // At once, before the run moves (which may start a session): the coordinator gets the answer in the run's note only,
    // never also as a plain answer it might report again at the next block (review of 3b, finding 1).
    this.p.markDelivered(q.id);
    return this.one(run.project, async () => {
      const now = this.p.runs.get(run.id)!;
      const answer = q.answer!.trim();
      // The run moved before the answer came (its coordinator reported first): the answer is still the coordinator's to
      // read, as it was marked delivered above (final review of part 3, finding 6).
      if (now.question !== q.id) {
        this.tellCoordinator(now, `Ledung: ${this.p.userName} answered question #${q.id} of ${runLabel(now)}, but the run had already moved on, so nothing was recorded from it. Read it, and act on it if it changes anything.\n\nThe answer:\n\n${answer}`);
        return;
      }
      try {
        const flows = await this.flowsOf(now.project);
        const flow = this.flowOf(flows, now);
        const block = flow.blocks.find((b) => b.id === now.at);
        if (!block) throw new FlowRunError(`it is at "${now.at}", which is no block of its flow any more.`);
        const word = answerWord(block, answer, q.details?.options);
        if (!word) {
          this.p.runs.update(now.id, { question: null, state: 'running' }, this.now());
          this.p.changed(now.project);
          this.tellCoordinator(now, `Ledung: ${this.p.userName} answered "${block.title}" of ${runLabel(now)} (question #${q.id}) with an answer that is none of its outcomes: read it and report the outcome with flow_step. Its outcomes: ${outcomeList(flow, block, now.counts[block.id])}.\n\nThe answer:\n\n${answer}`);
          return;
        }
        const note = answer.replace(/^(Accepted\.|Changes needed:)\s*/, '').trim();
        const moved = await this.applyStep(flows, flow, { ...now, question: null }, block, word, this.p.userName, note && endingKey(note) !== endingKey(word) ? note : undefined);
        this.tellCoordinator(now, `Ledung: ${this.p.userName} answered "${block.title}" of ${runLabel(now)} (question #${q.id}): ${answer}\n\n${moved}`);
      } catch (e) {
        this.tellCoordinator(now, `Ledung: ${this.p.userName} answered question #${q.id} of ${runLabel(now)}, but the run could not move: ${(e as Error).message} Report its outcome with flow_step, or stop it.\n\nThe answer:\n\n${answer}`);
      }
    });
  }

  /**
   * A person block's question withdrawn on the page (review of 3b, finding 3): the run is the coordinator's to move again,
   * and it is told.
   */
  onWithdrawn(q: QuestionInfo): void {
    const run = this.p.runs.byQuestion(q.id);
    if (!run) return;
    this.p.runs.update(run.id, { question: null, state: 'running' }, this.now());
    this.p.changed(run.project);
    this.tellCoordinator(run, `Ledung: ${this.p.userName} withdrew question #${q.id}, "${run.at}" of ${runLabel(run)}: report that block's outcome yourself with flow_step when you know it, or stop the run.`);
  }

  /**
   * A block's session finished a turn with nothing running (part 3b): a coordinator that isn't its manager is told, as a
   * manager is told of its own sessions.
   */
  onSessionTurn(sessionId: string, lastReply: string): void {
    const s = this.p.getSession(sessionId);
    const run = s?.runBlock ? this.p.runs.get(s.runBlock.run) : undefined;
    if (!s || !run || run.state === 'ended' || run.state === 'stopped' || run.at !== s.runBlock!.block) return;
    const parent = s.parentId ? this.p.getSession(s.parentId) : undefined;
    if (parent?.role === 'manager' && parent.id === run.coordinator) return;
    this.tellCoordinator(run, `Ledung: session "${s.title}" (${s.id}), which runs "${s.runBlock!.block}" of ${runLabel(run)}, finished a turn. Its last reply began:\n\n${short(lastReply, 600) || '(no text)'}\n\nJudge it against the block's outcomes and report with flow_step.`);
  }
}

/**
 * The outcome word a person's answer gives (part 3b), or null: a review's verdict is the outcome of that word (or, if
 * the block has no such word, its first outcome for Accepted and its second for Changes needed), a question's answer
 * one of the block's words. A block with no outcomes ends the flow whatever the answer.
 */
export function answerWord(block: FlowBlock, answer: string, options?: QuestionOption[]): string | null {
  if (!block.outcomes?.length) return 'done';
  const words = [...new Map(block.outcomes.map((o) => [endingKey(o.word), o.word])).values()];
  const a = answer.trim();
  const verdict = a === ACCEPTED || /^Accepted\.\s/.test(a) ? 'accepted' : a.startsWith(CHANGES_NEEDED) ? 'changes needed' : null;
  if (verdict) return words.find((w) => endingKey(w) === verdict) ?? (block.ask === 'review' ? (verdict === 'accepted' ? words[0] : words[1]) ?? null : null);
  // The button the person pressed, with or without the page's note under it (#291): a write-up's option leads to the
  // outcome its asker gave it. "Other" text is no button, so it stays the coordinator's to read (#1184).
  const picked = a.split(NOTE_SEP)[0]!;
  const option = options?.find((o) => o.outcome && optionAnswer(o) === picked);
  if (option) return words.find((w) => endingKey(w) === endingKey(option.outcome!)) ?? null;
  // Only the word itself, as its button gives it: anything more is the coordinator's to read (#1184, review of 3b).
  const key = endingKey(picked.replace(RECOMMENDED, '').replace(/[.!]+$/, ''));
  return words.find((w) => endingKey(w) === key) ?? null;
}

/** What the question page puts between the picked option and the person's note (WaitingView). */
const NOTE_SEP = '\n\nNote: ';

/** A session's last reply as text, from its stored messages (oldest first): what a finished block hands on (part 3b). */
export function lastReplyOf(messages: StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== 'sdk' || m.data.type !== 'assistant' || m.data.parent_tool_use_id != null) continue;
    const text = (m.data.message?.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}
