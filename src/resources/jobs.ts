// What reserved jobs really used, remembered by kind (docs/steps/resource-limits.md, "Learning"), and which commands
// are known to be heavy ("Recognising heavy commands"). Amounts are kept without the GPU's id ("gpu", "vram"): a
// Windows GPU's id changes with each reboot, and a job's figure is about the work, not the card.
import type { DatabaseSync } from 'node:sqlite';
import { ALLOWANCE, isMemory, p90, type Amounts } from './limits.ts';

export interface JobRun {
  project: string;
  /** The reservation's `what`, normalised; "(unreserved)" for heavy work without one; "session:<role>" for a new session. */
  kind: string;
  commands: string[];
  asked: Amounts;
  peak: Amounts;
  mean: Amounts;
  durationMs: number;
  over: boolean;
  undeclared: boolean;
  endedAt: number;
}

export interface JobKindSummary {
  project: string;
  kind: string;
  runs: number;
  /** The last run's ask and the learned figure (90th percentile of the peaks), generic dims. */
  asked: Amounts;
  learned: Amounts;
  /** Runs that used more than they asked, beyond the margin's reach. */
  underDeclared: number;
  lastAt: number;
}

export interface HeavyCommand {
  project: string;
  command: string;
  runs: number;
  /** Typical peak (90th percentile), generic dims. */
  peak: Amounts;
  never: boolean;
}

/** How many runs before a learned figure replaces the session's guess (open choice 8). */
export const LEARN_AFTER = 3;
/** How many of the latest runs a figure is learned from. */
const LEARN_FROM = 20;
/** Runs of a command over the allowance before it needs a reservation. */
export const HEAVY_AFTER = 2;

/** A job's kind as it is kept: trimmed, one space, lower case, at most 60 characters. */
export function normaliseKind(what: string): string {
  return what.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
}

/** Amounts on one GPU, without its id ("gpu:<id>" → "gpu"); other GPUs' figures are left out. */
export function toGeneric(a: Amounts, gpu: string | null): Amounts {
  const out: Amounts = {};
  for (const [dim, v] of Object.entries(a)) {
    if (dim === 'cpu' || dim === 'ram') out[dim] = v;
    else if (gpu && dim === `gpu:${gpu}`) out.gpu = v;
    else if (gpu && dim === `vram:${gpu}`) out.vram = v;
  }
  return out;
}

export function fromGeneric(a: Amounts, gpu: string | null): Amounts {
  const out: Amounts = {};
  for (const [dim, v] of Object.entries(a)) {
    if (dim === 'cpu' || dim === 'ram') out[dim] = v;
    else if (gpu && (dim === 'gpu' || dim === 'vram')) out[`${dim}:${gpu}`] = v;
  }
  return out;
}

/** Memory, generic dims included ("vram" without a GPU's id). */
const memoryDim = (d: string) => d === 'vram' || isMemory(d);

/** Clearly above what work without a reservation may use (twice the allowance), on any resource. */
function aboveAllowance(peak: Amounts): boolean {
  return Object.entries(peak).some(([dim, v]) => v > (memoryDim(dim) ? ALLOWANCE.bytes * 2 : ALLOWANCE.percent * 2));
}

function parse(json: unknown): Amounts {
  try {
    const v = JSON.parse(String(json));
    return v && typeof v === 'object' ? v as Amounts : {};
  } catch {
    return {};
  }
}

export class JobStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(r: JobRun): void {
    this.db.prepare('INSERT INTO job_runs (project, kind, commands, asked, peak, mean, duration_ms, over, undeclared, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      r.project, r.kind, JSON.stringify(r.commands.slice(0, 40)), JSON.stringify(r.asked), JSON.stringify(r.peak), JSON.stringify(r.mean),
      Math.round(r.durationMs), r.over ? 1 : 0, r.undeclared ? 1 : 0, r.endedAt,
    );
  }

  private rows(project: string, kind: string, limit = LEARN_FROM): { peak: Amounts; asked: Amounts; endedAt: number }[] {
    return (this.db.prepare('SELECT peak, asked, ended_at FROM job_runs WHERE project = ? AND kind = ? ORDER BY ended_at DESC LIMIT ?').all(project, kind, limit) as Record<string, unknown>[])
      .map((r) => ({ peak: parse(r.peak), asked: parse(r.asked), endedAt: Number(r.ended_at) }));
  }

  /** The learned figure for a kind, once it has LEARN_AFTER runs: per resource the 90th percentile of the peaks. */
  learned(project: string, kind: string): { runs: number; need: Amounts } | null {
    const rows = this.rows(project, kind);
    if (rows.length < LEARN_AFTER) return null;
    const dims = new Set(rows.flatMap((r) => Object.keys(r.peak)));
    const need: Amounts = {};
    for (const d of dims) need[d] = p90(rows.map((r) => r.peak[d] ?? 0));
    return { runs: rows.length, need };
  }

  /** A new session's memory, measured: the 90th percentile of its kind's first minutes; null: not measured yet. */
  footprint(project: string, role: string): number | null {
    const rows = this.rows(project, `session:${role}`, 10);
    if (!rows.length) return null;
    return p90(rows.map((r) => r.peak.ram ?? 0)) || null;
  }

  /** Per kind of reserved job, for the usage page. */
  kinds(): JobKindSummary[] {
    const pairs = this.db.prepare("SELECT project, kind, COUNT(*) AS runs, MAX(ended_at) AS last FROM job_runs WHERE undeclared = 0 AND kind NOT LIKE 'session:%' GROUP BY project, kind ORDER BY last DESC LIMIT 200").all() as Record<string, unknown>[];
    return pairs.map((p) => {
      const project = String(p.project);
      const kind = String(p.kind);
      const rows = this.rows(project, kind);
      const dims = new Set(rows.flatMap((r) => Object.keys(r.peak)));
      const learned: Amounts = {};
      for (const d of dims) learned[d] = p90(rows.map((r) => r.peak[d] ?? 0));
      const under = rows.filter((r) => Object.entries(r.peak).some(([d, v]) => {
        const asked = r.asked[d] ?? 0;
        return v > asked + (memoryDim(d) ? Math.max(0.1 * asked, 0.5 * 1024 ** 3) : 10);
      })).length;
      return { project, kind, runs: Number(p.runs), asked: rows[0]?.asked ?? {}, learned, underDeclared: under, lastAt: Number(p.last) };
    });
  }

  /** Forget a kind (one button on the usage page): a figure learned from a bad run starts over. */
  forget(project: string, kind: string): void {
    this.db.prepare('DELETE FROM job_runs WHERE project = ? AND kind = ?').run(project, kind);
  }

  /** The person's mark: this command never needs a reservation (or does again). */
  markNever(project: string, command: string, never: boolean): void {
    if (never) this.db.prepare('INSERT INTO command_marks (project, command, never) VALUES (?, ?, 1) ON CONFLICT (project, command) DO UPDATE SET never = 1').run(project, command);
    else this.db.prepare('DELETE FROM command_marks WHERE project = ? AND command = ?').run(project, command);
  }

  /**
   * Commands known to be heavy: in at least HEAVY_AFTER recent runs (reserved or unreserved) that used more than the
   * allowance. Those the person marked "never" are listed with `never`.
   */
  heavyCommands(project?: string): HeavyCommand[] {
    const rows = (project === undefined
      ? this.db.prepare("SELECT project, commands, peak FROM job_runs WHERE kind NOT LIKE 'session:%' ORDER BY ended_at DESC LIMIT 2000").all()
      : this.db.prepare("SELECT project, commands, peak FROM job_runs WHERE project = ? AND kind NOT LIKE 'session:%' ORDER BY ended_at DESC LIMIT 500").all(project)) as Record<string, unknown>[];
    const by = new Map<string, { project: string; command: string; peaks: Amounts[] }>();
    for (const r of rows) {
      const peak = parse(r.peak);
      if (!aboveAllowance(peak)) continue;
      let commands: unknown;
      try {
        commands = JSON.parse(String(r.commands));
      } catch {
        continue;
      }
      if (!Array.isArray(commands)) continue;
      for (const c of new Set(commands.filter((x): x is string => typeof x === 'string'))) {
        const key = `${r.project}\u0000${c}`;
        const e = by.get(key) ?? { project: String(r.project), command: c, peaks: [] };
        e.peaks.push(peak);
        by.set(key, e);
      }
    }
    const marks = new Set((this.db.prepare('SELECT project, command FROM command_marks WHERE never = 1').all() as Record<string, unknown>[]).map((m) => `${m.project}\u0000${m.command}`));
    const out: HeavyCommand[] = [];
    for (const [key, e] of by) {
      if (e.peaks.length < HEAVY_AFTER) continue;
      const dims = new Set(e.peaks.flatMap((p) => Object.keys(p)));
      const peak: Amounts = {};
      for (const d of dims) peak[d] = p90(e.peaks.map((p) => p[d] ?? 0));
      out.push({ project: e.project, command: e.command, runs: e.peaks.length, peak, never: marks.has(key) });
    }
    return out.sort((a, b) => b.runs - a.runs);
  }
}
