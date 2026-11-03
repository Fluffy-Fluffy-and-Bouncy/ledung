// Ledung follows the flow (workflow part 3, docs/steps/workflow-follow.md, approved by Simon 2026-11-03): runs, each
// a piece of work going through one of the project's flows. The coordinator (whoever started the run: usually the
// manager, else the session the person asked) reports how each block ended by the outcome's word; Ledung records and
// counts it, takes the counted outcome on its Nth time and the plain one otherwise, moves the run and says what to do
// at the next block. Ledung never picks the outcome from text (#1184), and the workflow guides: no locks (#1183).
import type { SessionInfo } from '../shared/protocol.ts';
import { DEFAULT_FLOW, flowFileOf, ordinal, type Flow, type FlowBlock } from '../shared/flow.ts';
import { decideStep, outcomeList, runLabel, startBlock, type FlowRun, type RunStep } from '../shared/flow-run.ts';
import type { RunStore } from './run-store.ts';

/** A project's flows as they read now: by name ("main" for flow.json), and the folder they are in. */
export interface ProjectFlows {
  folder: string;
  flows: Map<string, Flow>;
  /** Each flow's title, for the tools: its own, else its name. */
  titles: Map<string, string>;
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
  userName: string;
  now?(): number;
}

/** The longest note a step keeps in the history; the whole note goes on to the next block. */
const NOTE_KEPT = 600;
/** How many runs flow_status lists without a run named. */
const STATUS_LISTED = 20;

export class FlowRunError extends Error {}

export class FlowRuns {
  private readonly p: FlowRunsPorts;
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
  start(callerId: string, args: { title: string; ref?: string; flow?: string }): Promise<string> {
    const caller = this.p.getSession(callerId);
    if (!caller) return Promise.reject(new FlowRunError('Your session is not known to Ledung.'));
    return this.one(caller.project, async () => {
      const flows = await this.flowsOf(caller.project);
      const name = this.pickFlow(flows, args.flow);
      const flow = flows.flows.get(name)!;
      const first = startBlock(flow);
      const run = this.p.runs.create({
        project: caller.project, title: args.title.trim(), ref: args.ref?.trim() || null, flow: name, at: first.id, coordinator: callerId, parent: null, now: this.now(),
      });
      this.p.changed(caller.project);
      return `Started ${runLabel(run)} in the flow "${flows.titles.get(name)}". ${this.arrival(flows, run, flow, first)}`;
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
      if (args.stop) return this.stopRun(run, args.outcome.trim() || 'stopped', this.who(callerId));
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
      const sessions = Object.entries(run.sessions).map(([b, s]) => `${titleOf(run, b)}: ${s}`);
      return [
        `${runLabel(run)} in the flow "${flows?.titles.get(run.flow) ?? run.flow}", coordinated by ${this.who(run.coordinator)}: ${this.stateLine(run, titleOf(run, run.at))}.`,
        run.parent ? `Started by "${run.parent.block}" of ${run.parent.run}, which waits for it.` : '',
        counts.length ? `Counts: ${counts.join('; ')}.` : '',
        sessions.length ? `Sessions: ${sessions.join('; ')}.` : '',
        run.history.length ? `History:\n${run.history.map((h) => `- ${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')} ${titleOf(run, h.block)}: "${h.word}"${h.n > 1 ? ` (${ordinal(h.n)} time)` : ''} by ${h.by} → ${h.to === null ? 'end' : titleOf(run, h.to)}`).join('\n')}` : 'No steps yet.',
      ].filter(Boolean).join('\n');
    }
    const runs = this.p.runs.list(caller.project, { limit: STATUS_LISTED });
    if (!runs.length) return 'No runs in your project yet; flow_start starts one.';
    return runs.map((r) => `- ${runLabel(r)}, flow "${flows?.titles.get(r.flow) ?? r.flow}": ${this.stateLine(r, titleOf(r, r.at))}`).join('\n');
  }

  /** The project's runs for the page, the latest changed first. */
  list(project: string): FlowRun[] {
    return this.p.runs.list(project);
  }

  // --- moving a run ----------------------------------------------------------------------------------

  private stateLine(run: FlowRun, at: string): string {
    if (run.state === 'ended') return `ended "${run.ending}"`;
    if (run.state === 'stopped') return `stopped (${run.ending})`;
    return `${run.state === 'waiting' ? 'waiting' : 'at'} "${at}" since ${new Date(run.atSince).toISOString().slice(0, 16).replace('T', ' ')}`;
  }

  /** Records a step and moves the run on; what the coordinator does next. */
  private applyStep(flows: ProjectFlows, flow: Flow, run: FlowRun, block: FlowBlock, word: string, by: string, note?: string): string {
    let decision;
    try {
      decision = decideStep(flow, block.id, word, run.counts[block.id]);
    } catch (e) {
      throw new FlowRunError(`${(e as Error).message} Nothing was recorded.`);
    }
    const key = word.trim().toLowerCase();
    const counts = { ...run.counts, [block.id]: { ...run.counts[block.id], [key]: decision.n } };
    const said = decision.kind === 'end' ? decision.word : decision.outcome.word;
    const step: RunStep = {
      block: block.id, word: said, n: decision.n, to: decision.kind === 'move' ? decision.to : null, by, at: this.now(),
      ...(note?.trim() ? { note: note.trim().slice(0, NOTE_KEPT) } : {}),
    };
    const history = [...run.history, step];
    const counted = decision.kind === 'move' && decision.outcome.times ? ` (its ${ordinal(decision.n)} time)` : '';
    if (decision.kind === 'end') {
      const ended = this.p.runs.update(run.id, { at: null, atSince: this.now(), counts, history, state: 'ended', ending: decision.word, question: null }, this.now());
      this.p.changed(run.project);
      return `Recorded "${said}" for "${block.title}". ${runLabel(ended)} has ended: "${decision.word}".`;
    }
    const next = flow.blocks.find((b) => b.id === decision.to)!;
    const moved = this.p.runs.update(run.id, { at: next.id, atSince: this.now(), counts, history, state: 'running', question: null }, this.now());
    this.p.changed(run.project);
    return `Recorded "${said}" for "${block.title}"${counted}: ${runLabel(moved)} goes to "${next.title}". ${this.arrival(flows, moved, flow, next)}`;
  }

  private stopRun(run: FlowRun, why: string, by: string): string {
    const step: RunStep = { block: run.at ?? '', word: 'stopped', n: 1, to: null, by, at: this.now(), note: why.slice(0, NOTE_KEPT) };
    this.p.runs.update(run.id, { state: 'stopped', ending: why, history: [...run.history, step], question: null }, this.now());
    this.p.changed(run.project);
    return `${runLabel(run)} is stopped at "${run.at}": ${why}.`;
  }

  /** What to do at a block the run has just reached. */
  private arrival(flows: ProjectFlows, run: FlowRun, flow: Flow, block: FlowBlock): string {
    const titleOf = (id: string) => flow.blocks.find((b) => b.id === id)?.title ?? id;
    const brief = block.brief ? ` Its brief: ${block.brief} in ${flows.folder}.` : '';
    const subs = block.substeps?.length ? ` Its one starts these subagents, in order: ${block.substeps.map((s) => `${s.title} (${s.when ?? 'done'}${s.model ? `, ${s.model}` : ''}${s.brief ? `, ${s.brief}` : ''})`).join('; ')}.` : '';
    const outs = `Its outcomes: ${outcomeList(flow, block, run.counts[block.id])}.`;
    const report = `Then report with flow_step (run "${run.id}", the outcome's word).`;
    const at = `"${block.title}" (${block.id})`;
    switch (block.kind === 'person' ? 'person' : block.kind === 'flow' ? 'flow' : block.runs) {
      case 'person':
        return `At ${at}, a person's step: ask ${this.p.userName} (${block.ask === 'review' ? 'a review' : 'a question'}, the outcomes as the answers).${brief} ${outs} ${report}`;
      case 'flow':
        return `At ${at}, which runs the flow "${flows.titles.get(block.flow ?? '') ?? block.flow}": its ending is this block's outcome. ${outs} ${report}`;
      case 'new-session':
        return `At ${at}: start a new session for it${block.model ? ` with model ${block.model}` : ''}${block.profile ? `, profile ${block.profile}` : ''}.${brief}${subs} ${outs} ${report}`;
      case 'continue':
        return `At ${at}: give it to the session that ran "${titleOf(block.continues ?? '')}"${run.sessions[block.continues ?? ''] ? ` (${run.sessions[block.continues ?? '']})` : ''}.${brief}${subs} ${outs} ${report}`;
      default:
        return `At ${at}: ${block.runs === 'manager' ? 'your own step' : 'a step for you to see through'}.${brief}${subs} ${outs} ${report}`;
    }
  }
}
