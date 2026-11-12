// Resource limits' decisions (docs/steps/resource-limits.md, "The model"), without side effects: averaging, whether a
// start fits under the limits, the order of the line, and whether a running job is over its own share.
// A resource is a "dim": 'cpu' (% of the whole PC), 'ram' (bytes), 'gpu:<adapter>' (% load), 'vram:<adapter>' (bytes).
import type { Priority } from '../shared/protocol.ts';

export type Amounts = Record<string, number>;

export const GB = 1024 ** 3;

export interface LimitSettings {
  /** The moving average every decision uses, in seconds (default 30). */
  averageSec: number;
  /** How far above its share a job may go, in points of CPU and GPU % (default 10); memory: see marginOf. */
  marginPoints: number;
  /** How long a job must stay above its share plus the margin to count as over, in seconds (default 60). */
  overSec: number;
}

export const DEFAULT_SETTINGS: LimitSettings = { averageSec: 30, marginPoints: 10, overSec: 60 };

/** What work without a reservation counts as reserving: almost nothing (point 7). */
export const ALLOWANCE = { percent: 5, bytes: 0.5 * GB };

export const isMemory = (dim: string) => dim === 'ram' || dim.startsWith('vram:');

/** The margin above a share: points for CPU and GPU; for memory 10% of the share, at least 0.5 GB (open choice 3). */
export function marginOf(dim: string, share: number, s: LimitSettings): number {
  return isMemory(dim) ? Math.max(0.1 * share, 0.5 * GB) : s.marginPoints;
}

/** A share where none was reserved for that resource: the allowance. */
export function shareOf(dim: string, reserved: Amounts): number {
  const r = reserved[dim];
  if (r !== undefined && r > 0) return r;
  return isMemory(dim) ? ALLOWANCE.bytes : ALLOWANCE.percent;
}

/** Moving averages per key, over the last `windowSec`; samples older than the longest window asked are dropped. */
export class Averages {
  private readonly samples = new Map<string, { at: number; v: number }[]>();

  add(key: string, at: number, value: number): void {
    let list = this.samples.get(key);
    if (!list) this.samples.set(key, (list = []));
    list.push({ at, v: value });
    // Ten minutes is far more than any window the settings allow.
    while (list.length && list[0]!.at < at - 600_000) list.shift();
  }

  /** The average over the window ending `now`; null with no sample in it. */
  get(key: string, now: number, windowSec: number): number | null {
    const list = this.samples.get(key);
    if (!list) return null;
    let n = 0;
    let sum = 0;
    for (let i = list.length - 1; i >= 0 && list[i]!.at > now - windowSec * 1000; i--) {
      sum += list[i]!.v;
      n++;
    }
    return n ? sum / n : null;
  }

  /** Every dim's average for one subject ("pc", "r:<id>", "s:<session>"). */
  all(subject: string, now: number, windowSec: number): Amounts {
    const out: Amounts = {};
    for (const key of this.samples.keys()) {
      if (!key.startsWith(`${subject}|`)) continue;
      const v = this.get(key, now, windowSec);
      if (v !== null) out[key.slice(subject.length + 1)] = v;
    }
    return out;
  }

  drop(subject: string): void {
    for (const key of [...this.samples.keys()]) if (key.startsWith(`${subject}|`)) this.samples.delete(key);
  }
}

/**
 * The dims where a start doesn't fit (point 3): the PC's averaged total, plus what jobs already going have reserved
 * but don't use yet, plus this request, must stay under the limit. Only dims the request needs and that have a limit.
 */
export function notFitting(need: Amounts, total: Amounts, unused: Amounts, limits: Amounts): string[] {
  const out: string[] = [];
  for (const [dim, n] of Object.entries(need)) {
    if (!(n > 0)) continue;
    const limit = limits[dim];
    if (limit === undefined) continue;
    if ((total[dim] ?? 0) + (unused[dim] ?? 0) + n > limit) out.push(dim);
  }
  return out;
}

/** What a going job holds but doesn't use yet, per dim: its reservation minus its use, never below 0. */
export function unusedOf(granted: Amounts, using: Amounts): Amounts {
  const out: Amounts = {};
  for (const [dim, g] of Object.entries(granted)) out[dim] = Math.max(0, g - (using[dim] ?? 0));
  return out;
}

export function addAmounts(a: Amounts, b: Amounts): Amounts {
  const out: Amounts = { ...a };
  for (const [dim, v] of Object.entries(b)) out[dim] = (out[dim] ?? 0) + v;
  return out;
}

export interface LineItem {
  id: string;
  priority: Priority;
  since: number;
  need: Amounts;
  /** Simon's Start now: goes whatever the limits say. */
  forced?: boolean;
  /** Its session is held (a job over its share): no new reservation is granted (open choice 1). */
  held?: boolean;
}

export type Waiting = { kind: 'room'; dims: string[] } | { kind: 'behind'; dims: string[]; behind: string } | { kind: 'held' };

const RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2 };

export function lineSort<T extends { priority: Priority; since: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.since - b.since);
}

/**
 * Who may go now, in line order (priority, then who waited longest). An entry that waits holds back only later
 * entries that need a resource it is waiting for (open choice 5); each one granted counts as reserved for the next.
 */
export function grantPass(items: LineItem[], total: Amounts, unused: Amounts, limits: Amounts): { granted: string[]; waiting: Map<string, Waiting> } {
  const granted: string[] = [];
  const waiting = new Map<string, Waiting>();
  const blocked = new Map<string, string>();
  let held: Amounts = { ...unused };
  for (const item of lineSort(items)) {
    if (item.forced) {
      granted.push(item.id);
      held = addAmounts(held, item.need);
      continue;
    }
    if (item.held) {
      waiting.set(item.id, { kind: 'held' });
      continue;
    }
    const dims = Object.keys(item.need).filter((d) => item.need[d]! > 0);
    const behind = dims.filter((d) => blocked.has(d));
    if (behind.length) {
      waiting.set(item.id, { kind: 'behind', dims: behind, behind: blocked.get(behind[0]!)! });
      continue;
    }
    const failing = notFitting(item.need, total, held, limits);
    if (!failing.length) {
      granted.push(item.id);
      held = addAmounts(held, item.need);
      continue;
    }
    waiting.set(item.id, { kind: 'room', dims: failing });
    // One that asks more than the limit itself waits for the person to raise it, and holds back no one meanwhile
    // (security review, finding 2): others that fit go past it.
    for (const d of failing) if (!(item.need[d]! > (limits[d] ?? Infinity))) blocked.set(d, item.id);
  }
  return { granted, waiting };
}

export interface OverState {
  /** Since when the average has been above share plus margin; null: it isn't. */
  since: number | null;
  /** Counted as over (above for the whole of overSec). */
  over: boolean;
  /** The dims above, at the last step. */
  dims: string[];
}

export const NOT_OVER: OverState = { since: null, over: false, dims: [] };

/**
 * One step of a running job's check against its own share (points 4–6): `using` its averages, `reserved` its share.
 * Over once above share plus margin for the whole of overSec; back as soon as every dim is within it again.
 */
export function overStep(state: OverState, using: Amounts, reserved: Amounts, s: LimitSettings, now: number): { state: OverState; change: 'over' | 'back' | null } {
  const dims = Object.entries(using).filter(([dim, v]) => {
    const share = shareOf(dim, reserved);
    return v > share + marginOf(dim, share, s);
  }).map(([dim]) => dim);
  if (!dims.length) {
    return { state: NOT_OVER, change: state.over ? 'back' : null };
  }
  const since = state.since ?? now;
  const over = state.over || now - since >= s.overSec * 1000;
  return { state: { since, over, dims }, change: over && !state.over ? 'over' : null };
}

/** The 90th percentile of a list (learned figures, "Learning"). */
export function p90(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]!;
}

/** A dim's figure for people: "40%", "6.5 GB". */
export function formatDim(dim: string, v: number): string {
  if (isMemory(dim)) return `${(v / GB).toFixed(v >= 10 * GB ? 0 : 1)} GB`;
  return `${Math.round(v)}%`;
}

/** "CPU", "memory", "GPU", "GPU memory", with the GPU's name when it isn't the main one. */
export function dimLabel(dim: string, gpuName?: (id: string) => string | null): string {
  if (dim === 'cpu') return 'CPU';
  if (dim === 'ram') return 'memory';
  const [kind, id] = dim.split(':') as [string, string];
  const name = gpuName?.(id);
  const base = kind === 'gpu' ? 'GPU' : 'GPU memory';
  return name ? `${base} (${name})` : base;
}

/**
 * Why an entry waits, for the line in the page and the session's answer: "Waiting for GPU room: needs ~100%,
 * limit 50%" when only a higher limit helps, else what is left under the limit.
 */
export function roomReason(dim: string, need: number, total: number, unused: number, limit: number, label: string): string {
  if (need > limit) return `Waiting for ${label} room: needs ~${formatDim(dim, need)}, limit ${formatDim(dim, limit)}`;
  const left = Math.max(0, limit - total - unused);
  return `Waiting for ${label} room: needs ~${formatDim(dim, need)}, ${formatDim(dim, left)} left under the ${formatDim(dim, limit)} limit`;
}
