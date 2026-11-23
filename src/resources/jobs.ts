// What reserved jobs really used, remembered by kind (docs/steps/resource-limits.md, "Learning"), and which commands
// are known to be heavy ("Recognising heavy commands"). Amounts are kept without the GPU's id ("gpu", "vram"): a
// Windows GPU's id changes with each reboot, and a job's figure is about the work, not the card.
import type { DatabaseSync } from 'node:sqlite';
import { ALLOWANCE, isMemory, p90, type Amounts } from './limits.ts';
import { isLightKind } from './commands.ts';

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
  /** Where the figure comes from (R4): runs of reserved jobs and of unreserved stretches, and when the last ended. */
  reserved: number;
  unreserved: number;
  lastAt: number;
  /** How long its calls usually take (median of the latest), when Ledung has seen it finish. */
  usualMs: number | null;
}

/** How many runs before a learned figure replaces the session's guess (open choice 8). */
export const LEARN_AFTER = 3;
/** How many of the latest runs a figure is learned from. */
const LEARN_FROM = 20;
/** Runs of a command over the allowance before its figure is known (for estimates and the notice; never a refusal, #500). */
export const HEAVY_AFTER = 2;
/** Old records count for a kind only if its calls usually take longer than this (round 2, R4: the 10-second rule). */
export const SHORT_MS = 10_000;
/** How many of a kind's latest calls its usual duration is taken from (the median), and kept. */
const CALLS_KEPT = 10;

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
    this.db.prepare('INSERT INTO job_runs (project, kind, commands, asked, peak, mean, duration_ms, over, undeclared, ended_at, by_call) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
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

  /** A finished shell call (R4): how long it took, per kind; only the latest CALLS_KEPT per kind stay. */
  addCall(project: string, kind: string, durationMs: number, at: number): void {
    this.db.prepare('INSERT INTO command_calls (project, kind, duration_ms, at) VALUES (?, ?, ?, ?)').run(project, kind, Math.max(0, Math.round(durationMs)), at);
    this.db.prepare('DELETE FROM command_calls WHERE project = ? AND kind = ? AND id NOT IN (SELECT id FROM command_calls WHERE project = ? AND kind = ? ORDER BY at DESC, id DESC LIMIT ?)')
      .run(project, kind, project, kind, CALLS_KEPT);
  }

  /** How long a kind's calls usually take: the median of its latest calls; null if none has been seen to finish. */
  usualMs(project: string, kind: string): number | null {
    const ms = (this.db.prepare('SELECT duration_ms FROM command_calls WHERE project = ? AND kind = ? ORDER BY at DESC, id DESC LIMIT ?').all(project, kind, CALLS_KEPT) as Record<string, unknown>[])
      .map((r) => Number(r.duration_ms)).sort((a, b) => a - b);
    if (!ms.length) return null;
    const mid = ms.length >> 1;
    return ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
  }

  /**
   * Commands known to be heavy: in at least HEAVY_AFTER recent runs (reserved or unreserved) that used more than the
   * allowance. A figure for the page and the over-share notice only: no command is refused by it (issue #500; the old
   * "never needs a reservation" marks in command_marks are no longer read). Light commands are never heavy, and records
   * from before R4 count only for a kind whose calls usually take over 10 s, applied here when read, so old wrong
   * marks clear themselves.
   */
  heavyCommands(project?: string): HeavyCommand[] {
    const rows = (project === undefined
      ? this.db.prepare("SELECT project, commands, peak, undeclared, ended_at, by_call FROM job_runs WHERE kind NOT LIKE 'session:%' ORDER BY ended_at DESC LIMIT 2000").all()
      : this.db.prepare("SELECT project, commands, peak, undeclared, ended_at, by_call FROM job_runs WHERE project = ? AND kind NOT LIKE 'session:%' ORDER BY ended_at DESC LIMIT 500").all(project)) as Record<string, unknown>[];
    const by = new Map<string, { project: string; command: string; runs: { peak: Amounts; unreserved: boolean; at: number; byCall: boolean }[] }>();
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
        if (isLightKind(c)) continue;
        const key = `${r.project}\u0000${c}`;
        const e = by.get(key) ?? { project: String(r.project), command: c, runs: [] };
        e.runs.push({ peak, unreserved: Number(r.undeclared) === 1, at: Number(r.ended_at), byCall: Number(r.by_call) === 1 });
        by.set(key, e);
      }
    }
    const out: HeavyCommand[] = [];
    for (const e of by.values()) {
      const usualMs = this.usualMs(e.project, e.command);
      // Records from before R4 took every call made during a job: they count only once its calls are seen to be long
      // (the 10-second rule). Records since R4 are a call's own busy processes, and stay evidence however quick its
      // other calls were: one `python train.py &` that returns at once must not make a heavy command light (code
      // review of PR #400, round 2).
      const runs = usualMs !== null && usualMs > SHORT_MS ? e.runs : e.runs.filter((r) => r.byCall);
      if (runs.length < HEAVY_AFTER) continue;
      const dims = new Set(runs.flatMap((r) => Object.keys(r.peak)));
      const peak: Amounts = {};
      for (const d of dims) peak[d] = p90(runs.map((r) => r.peak[d] ?? 0));
      const unreserved = runs.filter((r) => r.unreserved).length;
      out.push({
        project: e.project, command: e.command, runs: runs.length, peak,
        reserved: runs.length - unreserved, unreserved, lastAt: Math.max(...runs.map((r) => r.at)), usualMs,
      });
    }
    return out.sort((a, b) => b.runs - a.runs);
  }
}
