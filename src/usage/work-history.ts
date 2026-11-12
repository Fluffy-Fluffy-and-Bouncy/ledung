// work_history (issue #254): how long a project's sessions really took and what they used, so a manager
// estimates from measured numbers instead of human working days (Simon, 2026-11-12: "Claude is very happy with
// guessing things will take days, weeks, etc."). A tool rather than a line in the start text: it costs no context
// until asked, and is never stale.
//
// Work is the time in turns (turn_resources) less the time a turn stood still on a permission prompt; the time
// between turns, waiting for a person's answer or the next message, is not work. Plan use is the session's API-priced
// cost turned into a share of the account's 5-hour and weekly windows, at the rate the account's own recorded window
// figures rose against its recorded cost.
import type { DatabaseSync } from 'node:sqlite';
import { span } from '../sessions/elapsed.ts';

const DAY = 86_400_000;
/** The windows a share is given for, as Claude Code names them, with the words shown. */
const WINDOWS: [kind: string, label: string][] = [['five_hour', '5-hour'], ['seven_day', 'weekly']];
/** Below this much measured rise of a window (5 points), a rate is too rough to give. */
const MIN_RISE = 0.05;
/** Two figures belong to the same window when their reset times are this close. */
const SAME_WINDOW_MS = 10 * 60_000;

export interface WorkSession {
  id: string;
  title: string;
  kind: string;
  status: string;
  /** First turn's start to last turn's end; waits included. */
  wallMs: number;
  /** Time in turns, less permission waits. */
  workMs: number;
  turns: number;
  tokens: number;
  /** Share (0–1) of each window, by WINDOWS label; missing where the rate is unknown. */
  shares: Record<string, number>;
  lastAt: number;
}

export interface KindSummary {
  kind: string;
  count: number;
  work: { median: number; min: number; max: number };
  wallMedian: number;
  tokensMedian: number;
  shareMedians: Record<string, number>;
}

export interface WorkHistory {
  project: string;
  days: number;
  sessions: WorkSession[];
  kinds: KindSummary[];
  /** Per WINDOWS label, how the rate was measured; missing: unknown. */
  rates: Record<string, { rise: number; changes: number }>;
}

/** What a session was, for grouping: its workflow block when it ran one, else a guess from its title. */
export function kindOf(title: string, runBlock: string | null): string {
  if (runBlock) {
    try {
      const b = JSON.parse(runBlock) as { block?: unknown };
      if (typeof b.block === 'string' && b.block.trim()) return b.block.trim().toLowerCase();
    } catch { /* an unreadable block falls back to the title */ }
  }
  if (/\breview/i.test(title)) return 'review';
  if (/\b(fix|bug)/i.test(title)) return 'fix';
  if (/\b(build|implement|feature)/i.test(title)) return 'build';
  return 'other';
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Length of [a, b] that falls inside any of the intervals. */
function overlap(a: number, b: number, intervals: [number, number][]): number {
  let total = 0;
  for (const [s, e] of intervals) total += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return total;
}

/**
 * Per account and window, the share of the window one dollar of API-priced cost took: the window's recorded rises
 * within one window, against the account's recorded cost between those figures. Usage outside Ledung on the same
 * account raises the window without cost here, so shares read high rather than low. A gap with calls Ledung could not
 * price is left out whole, rise and cost, so it skews neither (review of #254, finding 2).
 */
function rates(db: DatabaseSync, accounts: string[], since: number): Map<string, Record<string, { perCost: number; rise: number; changes: number }>> {
  const out = new Map<string, Record<string, { perCost: number; rise: number; changes: number }>>();
  const costBetween = db.prepare('SELECT COALESCE(SUM(cost), 0) AS c, COALESCE(SUM(cost IS NULL), 0) AS unpriced FROM usage WHERE account = ? AND at > ? AND at <= ?');
  for (const account of accounts) {
    const byLabel: Record<string, { perCost: number; rise: number; changes: number }> = {};
    for (const [kind, label] of WINDOWS) {
      const rows = db.prepare('SELECT at, utilization, resets_at FROM limits WHERE account = ? AND kind = ? AND at >= ? AND utilization IS NOT NULL ORDER BY at')
        .all(account, kind, since) as { at: number; utilization: number; resets_at: number | null }[];
      let rise = 0;
      let cost = 0;
      let changes = 0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1]!;
        const b = rows[i]!;
        // Across a reset the figures belong to different windows: nothing to compare.
        if (a.resets_at == null || b.resets_at == null || Math.abs(Number(a.resets_at) - Number(b.resets_at)) > SAME_WINDOW_MS) continue;
        const d = b.utilization - a.utilization;
        if (d < 0) continue;
        const gap = costBetween.get(account, Number(a.at), Number(b.at)) as { c: number; unpriced: number };
        if (Number(gap.unpriced) > 0) continue;
        // A pair with no rise (a status change) still spent its cost inside the window (review of #254, finding 6).
        rise += d;
        cost += Number(gap.c);
        if (d > 0) changes++;
      }
      if (rise >= MIN_RISE && cost > 0) byLabel[label] = { perCost: rise / cost, rise, changes };
    }
    out.set(account, byLabel);
  }
  return out;
}

/** Statuses a session is mid-turn or about to start one in: its last turn is not recorded yet. */
const UNDER_WAY = new Set(['starting', 'queued', 'running', 'waiting']);

/** Intervals merged where they overlap, so two prompts open at once are one wait (review of #254, finding 3). */
function merged(intervals: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...intervals].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function summary(kind: string, g: WorkSession[]): KindSummary {
  const work = g.map((s) => s.workMs);
  const shareMedians: Record<string, number> = {};
  for (const [, label] of WINDOWS) {
    const xs = g.filter((s) => label in s.shares).map((s) => s.shares[label]!);
    if (xs.length) shareMedians[label] = median(xs);
  }
  return {
    kind, count: g.length, work: { median: median(work), min: Math.min(...work), max: Math.max(...work) },
    wallMedian: median(g.map((s) => s.wallMs)), tokensMedian: median(g.map((s) => s.tokens)), shareMedians,
  };
}

/** Adds to a list in a map in place (copying it per item is quadratic, #356). */
function add<T>(m: Map<string, T[]>, k: string, x: T): void {
  const list = m.get(k);
  if (list) list.push(x);
  else m.set(k, [x]);
}

/**
 * A project's sessions (not its manager) with a turn in the last `days` days, newest first, and medians by kind. A
 * session in the period is counted whole, turns and usage from before it too, so one that began earlier is not cut
 * short (review of #254, finding 4).
 */
export function workHistory(db: DatabaseSync, project: string, opts: { days?: number; now?: number } = {}): WorkHistory {
  const now = opts.now ?? Date.now();
  const days = Math.min(90, Math.max(1, Math.round(opts.days ?? 30)));
  const since = now - days * DAY;
  // turn_resources carries the project (kept in step on a rename), so its index finds the period's turns.
  const ids = (db.prepare(
    `SELECT DISTINCT t.session_id AS id FROM turn_resources t JOIN sessions s ON s.id = t.session_id
     WHERE t.project = ? AND t.started_at >= ? AND s.project = ? AND s.role = 'session'`,
  ).all(project, since, project) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return { project, days, sessions: [], kinds: [], rates: {} };
  const marks = ids.map(() => '?').join(',');
  const turns = new Map<string, [number, number][]>();
  for (const t of db.prepare(`SELECT session_id, started_at, duration_ms FROM turn_resources WHERE session_id IN (${marks}) ORDER BY started_at`).all(...ids) as
    { session_id: string; started_at: number; duration_ms: number }[]) {
    add(turns, t.session_id, [Number(t.started_at), Number(t.started_at) + Number(t.duration_ms)] as [number, number]);
  }
  const info = new Map((db.prepare(`SELECT id, title, status, run_block FROM sessions WHERE id IN (${marks})`).all(...ids) as
    { id: string; title: string; status: string; run_block: string | null }[]).map((r) => [r.id, r]));
  const waits = new Map<string, [number, number][]>();
  for (const w of db.prepare(`SELECT session_id, at, decided_at FROM permissions WHERE session_id IN (${marks}) AND decided_at IS NOT NULL`).all(...ids) as
    { session_id: string; at: number; decided_at: number }[]) {
    add(waits, w.session_id, [Number(w.at), Number(w.decided_at)] as [number, number]);
  }
  const used = db.prepare(
    `SELECT session_id, account, SUM(input + cache_write + cache_read + output) AS tokens, COALESCE(SUM(cost), 0) AS cost,
       COALESCE(SUM(cost IS NULL), 0) AS unpriced
     FROM usage WHERE session_id IN (${marks}) GROUP BY session_id, account`,
  ).all(...ids) as { session_id: string; account: string; tokens: number; cost: number; unpriced: number }[];
  const rateOf = rates(db, [...new Set(used.map((u) => u.account))], since);

  const sessions: WorkSession[] = ids.map((id) => {
    const list = turns.get(id)!;
    const s = info.get(id)!;
    const inTurns = list.reduce((a, [st, en]) => a + (en - st), 0);
    const waited = merged(waits.get(id) ?? []).reduce((a, [st, en]) => a + overlap(st, en, list), 0);
    const mine = used.filter((u) => u.session_id === id);
    const shares: Record<string, number> = {};
    for (const [, label] of WINDOWS) {
      let share = 0;
      // A share from part of the cost would read low: none at all unless every call was priced (finding 2).
      let known = mine.length > 0;
      for (const u of mine) {
        const r = rateOf.get(u.account)?.[label];
        if (!r || Number(u.unpriced) > 0) { known = false; break; }
        share += Number(u.cost) * r.perCost;
      }
      if (known) shares[label] = share;
    }
    return {
      id, title: s.title, kind: kindOf(s.title, s.run_block), status: s.status,
      wallMs: list.at(-1)![1] - list[0]![0], workMs: Math.max(0, inTurns - waited), turns: list.length,
      tokens: mine.reduce((a, u) => a + Number(u.tokens), 0), shares, lastAt: list.at(-1)![1],
    };
  }).sort((a, b) => b.lastAt - a.lastAt);

  // Medians only from sessions not under way. "all" is kept apart from the kinds: a block called "all" is a kind of
  // its own, and sharing the list with it grew the list while it was walked (review of #254, finding 1).
  const done = sessions.filter((s) => !UNDER_WAY.has(s.status));
  const groups = new Map<string, WorkSession[]>();
  for (const s of done) add(groups, s.kind, s);
  const kinds: KindSummary[] = done.length ? [summary('all', done)] : [];
  kinds.push(...[...groups.entries()].map(([kind, g]) => summary(kind, g)).sort((a, b) => b.count - a.count));

  const measured: WorkHistory['rates'] = {};
  for (const [, label] of WINDOWS) {
    const rs = [...rateOf.values()].map((r) => r[label]).filter((r) => r !== undefined);
    if (rs.length) measured[label] = { rise: rs.reduce((a, r) => a + r.rise, 0), changes: rs.reduce((a, r) => a + r.changes, 0) };
  }
  return { project, days, sessions, kinds, rates: measured };
}

/** A duration, with seconds below a minute: small sessions differ there, and "under 1 min" hid it (#254 try-out). */
export function duration(ms: number): string {
  return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : span(ms);
}

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return `${Math.round(n)} tokens`;
}

function share(x: number): string {
  const p = x * 100;
  return `${p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function shares(s: Record<string, number>): string {
  return WINDOWS.filter(([, l]) => l in s).map(([, l]) => `${share(s[l]!)} of ${l}`).join(', ');
}

/** work_history's text: short, since it lands in the manager's context. */
export function formatWorkHistory(h: WorkHistory, limit = 10): string {
  if (!h.sessions.length) {
    return `No sessions of "${h.project}" worked in the last ${h.days} days, so there is nothing measured yet. Estimate with the defaults in your instructions.`;
  }
  const lines = [
    `"${h.project}", sessions with work in the last ${h.days} days (managers left out). Work: time in turns, less waits for permission answers; ` +
      'time waiting for a person between turns is not work. Wall: first turn to last, waits included.',
    '',
    'By kind (from workflow block, else the title; "all" is every session not under way): median work (range), median wall, median tokens, median plan use.',
  ];
  for (const k of h.kinds) {
    const plan = shares(k.shareMedians);
    lines.push(`- ${k.kind} (${k.count}): ${duration(k.work.median)} (${duration(k.work.min)}–${duration(k.work.max)}), wall ${duration(k.wallMedian)}, ${tokens(k.tokensMedian)}${plan ? `, ${plan}` : ''}`);
  }
  if (limit > 0) lines.push('', `Recent (${Math.min(limit, h.sessions.length)} of ${h.sessions.length}):`);
  for (const s of h.sessions.slice(0, Math.max(0, limit))) {
    const plan = shares(s.shares);
    lines.push(`- "${s.title}" [${s.kind}${UNDER_WAY.has(s.status) ? ', still working' : ''}]: work ${duration(s.workMs)} in ${s.turns} turn${s.turns === 1 ? '' : 's'}, wall ${duration(s.wallMs)}, ${tokens(s.tokens)}${plan ? `, ${plan}` : ''}`);
  }
  const measured = WINDOWS.filter(([, l]) => h.rates[l]).map(([, l]) => `${l} from ${h.rates[l]!.changes} recorded rises (${share(h.rates[l]!.rise)} in all)`);
  lines.push('', measured.length
    ? `Plan use: API-priced cost at the rate the account's windows rose against it (${measured.join('; ')}); use of the account outside Ledung makes it read high. A window not named has too few figures yet: go by tokens there.`
    : 'Plan use: not enough recorded window figures for this project\'s account yet, so go by tokens.');
  return lines.join('\n');
}
