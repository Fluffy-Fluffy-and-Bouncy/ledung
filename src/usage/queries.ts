// The figures behind the usage page, the per-session usage and the Overview (step 5). The page's totals, daily chart
// and project × model table add up the daily totals (issue #362), which the database keeps as each call is recorded;
// reading every call of the period took most of a second and a half at 149k calls. Recent sessions and a session's
// own usage read the calls, of the sessions shown only. Sums are done here rather than in SQL: summing in SQL was
// measured no faster (#362), and this keeps the filters and roll-ups in one readable place.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { exercisedLine } from '../platform/exercised.ts';
import type {
  LimitInfo,
  SessionInfo,
  UsageFilter,
  UsageReport,
  SessionUsage,
  UsageTotals,
  UsageCall,
} from '../shared/protocol.ts';

interface Row {
  session_id: string;
  at: number;
  model: string;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  thinking: number | null;
  cost: number | null;
  project: string;
  role: string;
  team: string | null;
  subagent: string | null;
  branch: string | null;
  trigger: string;
  machine: string;
  account: string;
  kind: string;
}

/**
 * One day's usage of one account, computer, model, project, role and trigger: a row of the daily totals, or a single
 * call (calls 1) where the report adds up calls.
 */
interface Part {
  day: string;
  account: string;
  machine: string;
  model: string;
  project: string;
  role: string;
  trigger: string;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  thinking: number;
  cost: number;
  calls: number;
  subagent_tokens: number;
}

const DAY = 24 * 60 * 60 * 1000;
const tokensOf = (r: Row | Part) => r.input + r.cache_write + r.cache_read + r.output;

/** Adds an item to its group's list in place: copying the list for every item made the report quadratic (#356). */
let exercised = false;
function push<K, T>(groups: Map<K, T[]>, key: K, r: T): void {
  const list = groups.get(key);
  if (!list) {
    groups.set(key, [r]);
    return;
  }
  list.push(r);
  if (!exercised) {
    exercised = true;
    exercisedLine('EXERCISED #356 usage report grouped calls in place');
  }
}

/** Shortens "claude-sonnet-5-5-20260101" to "sonnet-5-5", as the page shows models. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The midnight that ends the day `at` is in. */
function nextDay(at: number): number {
  const d = new Date(at);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function partOf(r: Row): Part {
  return {
    day: dayKey(r.at), account: r.account ?? 'default', machine: r.machine, model: r.model, project: r.project, role: r.role, trigger: r.trigger,
    input: r.input, cache_write: r.cache_write, cache_read: r.cache_read, output: r.output, thinking: r.thinking ?? 0, cost: r.cost ?? 0,
    calls: 1, subagent_tokens: r.subagent ? tokensOf(r) : 0,
  };
}

function totals(parts: Part[], sessions: number): UsageTotals {
  const t = { tokens: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, cost: 0, calls: 0, sessions, subagentTokens: 0 };
  for (const p of parts) {
    t.tokens += tokensOf(p);
    t.input += p.input;
    t.cacheWrite += p.cache_write;
    t.cacheRead += p.cache_read;
    t.output += p.output;
    t.thinking += p.thinking;
    t.cost += p.cost;
    t.calls += p.calls;
    t.subagentTokens += p.subagent_tokens;
  }
  return t;
}

let exercisedDaily = false;

/** When the period starts. "week" is since the plan's weekly limit last reset, when known. */
export function periodStart(period: UsageFilter['period'], limits: LimitInfo[], now = Date.now()): number {
  switch (period) {
    case 'week': {
      const weekly = limits.find((l) => l.kind === 'seven_day' && l.resetsAt);
      return weekly?.resetsAt ? weekly.resetsAt - 7 * DAY : startOfDay(now - 6 * DAY);
    }
    case '7d': return startOfDay(now - 6 * DAY);
    case '30d': return startOfDay(now - 29 * DAY);
    case '90d': return startOfDay(now - 89 * DAY);
    default: return 0;
  }
}

export class UsageQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private rows(sessionId: string): Row[] {
    return this.db.prepare('SELECT * FROM usage WHERE session_id = ? ORDER BY at, id').all(sessionId) as unknown as Row[];
  }

  /**
   * The period's usage from the daily totals. A period that starts during a day ("since the weekly reset") adds up
   * that first day from its calls, since the day's total would count the hours before the start too.
   */
  private daily(since: number): Part[] {
    const first = dayKey(since);
    const parts = this.db.prepare('SELECT * FROM usage_daily WHERE day > ?').all(first) as unknown as Part[];
    if (since <= startOfDay(since)) parts.push(...(this.db.prepare('SELECT * FROM usage_daily WHERE day = ?').all(first) as unknown as Part[]));
    else for (const r of this.db.prepare('SELECT * FROM usage WHERE at >= ? AND at < ?').all(since, nextDay(since)) as unknown as Row[]) parts.push(partOf(r));
    if (!exercisedDaily) {
      exercisedDaily = true;
      exercisedLine('EXERCISED #362 usage report read daily totals');
    }
    return parts;
  }

  report(filter: UsageFilter, sessions: SessionInfo[], limits: LimitInfo[]): UsageReport {
    // "Since the weekly reset" follows the chosen account's plan (the computer's own login otherwise).
    const since = periodStart(filter.period, limits.filter((l) => l.account === (filter.account ?? 'default')));
    const all = this.daily(since);
    // The daily totals have no branch, so a report for one branch adds up that branch's calls instead.
    const parts = (filter.branch
      ? (this.db.prepare('SELECT * FROM usage WHERE branch = ? AND at >= ?').all(filter.branch, since) as unknown as Row[]).map(partOf)
      : all
    ).filter((p) =>
      (!filter.project || p.project === filter.project) &&
      (!filter.model || shortModel(p.model) === filter.model) &&
      (!filter.role || p.role === filter.role) &&
      (!filter.trigger || p.trigger === filter.trigger) &&
      (!filter.account || p.account === filter.account));

    // Choices for the filters come from the whole period, so choosing one doesn't hide the others.
    const uniq = (values: (string | null)[]) => [...new Set(values)].filter((v): v is string => !!v).sort();
    const branches = this.db.prepare('SELECT branch FROM usage WHERE branch IS NOT NULL GROUP BY branch HAVING MAX(at) >= ?').all(since) as { branch: string }[];

    const byModelTotal = new Map<string, number>();
    for (const p of parts) byModelTotal.set(shortModel(p.model), (byModelTotal.get(shortModel(p.model)) ?? 0) + tokensOf(p));
    const models = [...byModelTotal.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);

    const matrixMap = new Map<string, Part[]>();
    for (const p of parts) push(matrixMap, p.project, p);
    const cell = (ps: Part[]) => {
      const byModel: Record<string, number> = {};
      for (const p of ps) byModel[shortModel(p.model)] = (byModel[shortModel(p.model)] ?? 0) + tokensOf(p);
      const t = totals(ps, 0);
      return { byModel, tokens: t.tokens, cost: t.cost, subagentShare: t.tokens ? t.subagentTokens / t.tokens : 0 };
    };
    const matrix = [...matrixMap.entries()]
      .map(([project, ps]) => ({
        project,
        ...cell(ps),
        roles: ['manager', 'session']
          .map((role) => ({ role, ps: ps.filter((p) => p.role === role) }))
          .filter((x) => x.ps.length)
          .map(({ role, ps: x }) => ({ role, ...cell(x) })),
      }))
      .sort((a, b) => b.tokens - a.tokens);

    const days = new Map<string, Part[]>();
    for (const p of parts) push(days, p.day, p);
    const sumBy = (ps: Part[], key: (p: Part) => string) => {
      const out: Record<string, number> = {};
      for (const p of ps) out[key(p)] = (out[key(p)] ?? 0) + tokensOf(p);
      return out;
    };
    const daily = [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, ps]) => ({
        day,
        tokens: ps.reduce((n, p) => n + tokensOf(p), 0),
        byModel: sumBy(ps, (p) => shortModel(p.model)),
        byProject: sumBy(ps, (p) => p.project),
        byTrigger: sumBy(ps, (p) => p.trigger),
      }));

    // The sessions with a call in the period that passes the filters, newest last call first; only the ones shown
    // have their calls read.
    const where = ['at >= ?'];
    const args: SQLInputValue[] = [since];
    for (const [column, value] of [['project', filter.project], ['branch', filter.branch], ['role', filter.role], ['trigger', filter.trigger], ['account', filter.account]] as const) {
      if (!value) continue;
      where.push(`${column} = ?`);
      args.push(value);
    }
    if (filter.model) {
      const full = uniq(all.map((p) => p.model)).filter((m) => shortModel(m) === filter.model);
      where.push(`model IN (${full.map(() => '?').join(', ')})`);
      args.push(...full);
    }
    const clause = where.join(' AND ');
    const found = this.db.prepare(`SELECT session_id, MAX(at) AS last FROM usage WHERE ${clause} GROUP BY session_id ORDER BY last DESC`).all(...args) as { session_id: string }[];
    // By session: with a branch filter SQLite chose the branch's index and read all its calls for each session (#362).
    const callsOf = this.db.prepare(
      `SELECT at, model, input, cache_write, cache_read, output, cost, subagent, project, branch FROM usage INDEXED BY usage_by_session
       WHERE session_id = ? AND ${clause} ORDER BY at, id`,
    );
    const recent = found
      .slice(0, 50)
      .map(({ session_id: sessionId }) => {
        const rs = callsOf.all(sessionId, ...args) as unknown as Row[];
        const s = sessions.find((x) => x.id === sessionId);
        const t = { tokens: 0, cost: 0, subagentTokens: 0 };
        for (const r of rs) {
          t.tokens += tokensOf(r);
          t.cost += r.cost ?? 0;
          if (r.subagent) t.subagentTokens += tokensOf(r);
        }
        return {
          sessionId,
          title: s?.title ?? 'Unknown session',
          role: s?.role ?? 'session',
          project: rs[0]!.project,
          branch: rs[rs.length - 1]!.branch,
          models: [...new Set(rs.map((r) => shortModel(r.model)))],
          firstAt: rs[0]!.at,
          lastAt: rs[rs.length - 1]!.at,
          calls: rs.length,
          tokens: t.tokens,
          cost: t.cost,
          subagentShare: t.tokens ? t.subagentTokens / t.tokens : 0,
        };
      });

    const projects = uniq(all.map((p) => p.project));
    return {
      since,
      totals: totals(parts, found.length),
      models,
      projects,
      options: { projects, models: uniq(all.map((p) => shortModel(p.model))), branches: uniq(branches.map((b) => b.branch)), accounts: uniq(all.map((p) => p.account)) },
      matrix,
      daily,
      recent,
    };
  }

  session(sessionId: string): SessionUsage {
    const rows = this.rows(sessionId);
    const t = totals(rows.map(partOf), rows.length ? 1 : 0);
    const calls: UsageCall[] = rows.map((r) => ({
      at: r.at,
      model: shortModel(r.model),
      input: r.input,
      cacheWrite: r.cache_write,
      cacheRead: r.cache_read,
      output: r.output,
      thinking: r.thinking,
      tokens: tokensOf(r),
      cost: r.cost,
      subagent: r.subagent,
      trigger: r.trigger,
      compaction: r.kind === 'compaction',
    }));
    return { totals: t, models: [...new Set(calls.map((c) => c.model))], calls };
  }

  /** Per session: tokens today and in total, for the session list and the Overview. */
  perSession(): Record<string, { today: number; total: number; costTotal: number }> {
    const today = startOfDay(Date.now());
    const out: Record<string, { today: number; total: number; costTotal: number }> = {};
    const rows = this.db.prepare(
      `SELECT session_id, SUM(input + cache_write + cache_read + output) AS total, SUM(COALESCE(cost, 0)) AS cost,
              SUM(CASE WHEN at >= ? THEN input + cache_write + cache_read + output ELSE 0 END) AS today
       FROM usage GROUP BY session_id`,
    ).all(today) as { session_id: string; total: number; cost: number; today: number }[];
    for (const r of rows) out[r.session_id] = { today: Number(r.today), total: Number(r.total), costTotal: Number(r.cost) };
    return out;
  }

  /** Tokens today across Ledung. */
  todayTotal(): number {
    const r = this.db.prepare('SELECT SUM(input + cache_write + cache_read + output) AS n FROM usage WHERE at >= ?').get(startOfDay(Date.now())) as { n: number | null };
    return Number(r.n ?? 0);
  }
}
