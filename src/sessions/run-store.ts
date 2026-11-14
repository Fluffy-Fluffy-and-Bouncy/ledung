// Runs in Ledung's database (migrations 42 and 44, workflow parts 3 and 3f; a fork's branches, #193): per project, nothing written into the project's files.
import type { DatabaseSync } from 'node:sqlite';
import type { FlowRun, RunState, RunStep } from '../shared/flow-run.ts';

type Row = Record<string, any>;

/** "run-12" ↔ 12: the id the tools and the page use is Ledung's own row number. */
export const runId = (n: number): string => `run-${n}`;
export function runNumber(id: string): number | null {
  const m = /^\s*(?:run-)?(\d{1,12})\s*$/i.exec(id);
  return m ? Number(m[1]) : null;
}

function toRun(r: Row): FlowRun {
  return {
    id: runId(Number(r.id)),
    project: r.project,
    title: r.title,
    ref: r.ref ?? null,
    flow: r.flow,
    at: r.at ?? null,
    fork: r.fork ? JSON.parse(r.fork) : null,
    atSince: Number(r.at_since),
    counts: JSON.parse(r.counts),
    sessions: JSON.parse(r.sessions),
    parent: r.parent_run == null ? null : { run: runId(Number(r.parent_run)), block: r.parent_block },
    history: JSON.parse(r.history),
    state: r.state,
    ending: r.ending ?? null,
    coordinator: r.coordinator,
    question: r.question == null ? null : Number(r.question),
    worktree: r.worktree ? JSON.parse(r.worktree) : null,
    queue: r.queue ?? null,
    startedAt: Number(r.started_at),
    updatedAt: Number(r.updated_at),
  };
}

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(r: { project: string; title: string; ref: string | null; flow: string; at: string; coordinator: string; parent: { run: string; block: string } | null; now: number }): FlowRun {
    const row = this.db.prepare(`INSERT INTO flow_runs (project, title, ref, flow, at, at_since, counts, sessions, parent_run, parent_block, history, state, coordinator, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, '[]', 'running', ?, ?, ?) RETURNING *`)
      .get(r.project, r.title, r.ref, r.flow, r.at, r.now, r.parent ? runNumber(r.parent.run) : null, r.parent?.block ?? null, r.coordinator, r.now, r.now);
    return toRun(row!);
  }

  get(id: string): FlowRun | undefined {
    const n = runNumber(id);
    const row = n === null ? undefined : this.db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(n);
    return row ? toRun(row) : undefined;
  }

  /** A project's runs, the latest changed first; `open`: only those not ended or stopped. */
  list(project: string, opts: { open?: boolean; limit?: number } = {}): FlowRun[] {
    const open = opts.open ? ` AND state IN ('running', 'waiting', 'queued')` : '';
    return this.db.prepare(`SELECT * FROM flow_runs WHERE project = ?${open} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(project, opts.limit ?? 200).map(toRun);
  }

  /** For the page: every open run, and the latest `ended` of the others (review of 3c: each change goes to every page). */
  forPage(project: string, ended = 30): FlowRun[] {
    return this.db.prepare(`SELECT * FROM flow_runs WHERE project = ? AND (state IN ('running', 'waiting', 'queued') OR id IN (
      SELECT id FROM flow_runs WHERE project = ? AND state NOT IN ('running', 'waiting', 'queued') ORDER BY updated_at DESC, id DESC LIMIT ?)) ORDER BY updated_at DESC, id DESC`)
      .all(project, project, ended).map(toRun);
  }

  /**
   * Runs of every project waiting with no question since `before` or earlier (#291): at a person block, those wait for
   * their coordinator's write-up; a wait or a Run flow block waits the same way, and the caller tells them apart.
   */
  awaitingWriteUp(before: number): FlowRun[] {
    return this.db.prepare(`SELECT * FROM flow_runs WHERE state = 'waiting' AND question IS NULL AND at IS NOT NULL AND at_since <= ? ORDER BY at_since, id`).all(before).map(toRun);
  }

  /** The run a person block's question belongs to. */
  byQuestion(question: number): FlowRun | undefined {
    const row = this.db.prepare(`SELECT * FROM flow_runs WHERE question = ? AND state IN ('running', 'waiting')`).get(question);
    return row ? toRun(row) : undefined;
  }

  /** The queued runs of a project, first in line first (part 3f). */
  queued(project: string): FlowRun[] {
    return this.db.prepare(`SELECT * FROM flow_runs WHERE project = ? AND state = 'queued' ORDER BY at_since, id`).all(project).map(toRun);
  }

  /** The runs a Run flow block of this run waits for. */
  children(id: string): FlowRun[] {
    return this.db.prepare('SELECT * FROM flow_runs WHERE parent_run = ? ORDER BY id').all(runNumber(id)).map(toRun);
  }

  update(id: string, fields: Partial<{ at: string | null; atSince: number; counts: FlowRun['counts']; sessions: FlowRun['sessions']; history: RunStep[]; state: RunState; ending: string | null; question: number | null; coordinator: string; worktree: FlowRun['worktree']; queue: FlowRun['queue']; fork: FlowRun['fork'] }>, now: number): FlowRun {
    const columns: Record<string, string> = { at: 'at', atSince: 'at_since', counts: 'counts', sessions: 'sessions', history: 'history', state: 'state', ending: 'ending', question: 'question', coordinator: 'coordinator', worktree: 'worktree', queue: 'queue', fork: 'fork' };
    const entries = Object.entries(fields).filter(([k, v]) => k in columns && v !== undefined);
    const values = entries.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v) as string | number | null);
    this.db.prepare(`UPDATE flow_runs SET ${[...entries.map(([k]) => `${columns[k]} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...values, now, runNumber(id));
    return this.get(id)!;
  }
}
