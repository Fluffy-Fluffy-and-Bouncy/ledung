// What the published usage file is built from (issue #363). Daily figures come from #362's daily totals table
// (usage_daily) when this database has it, else from the call records grouped the same way (the computer's local
// date, as that table keeps it); hourly figures always come from the last 8 days of calls, which the index on the
// calls' time keeps small. Building over 400 days of calls held Ledung up for seconds (review of PR #370, finding 3).
import type { DatabaseSync } from 'node:sqlite';
import type { PublishedTotals } from '../shared/published-usage.ts';

export interface UsageSlice extends PublishedTotals {
  account: string;
  model: string;
  project: string;
}

export interface UsageSlices {
  /** Per local day ("YYYY-MM-DD"). */
  daily: (UsageSlice & { day: string })[];
  /** Per hour, by the hour's start (ms since 1970, UTC). */
  hourly: (UsageSlice & { hour: number })[];
}

const HOUR = 60 * 60 * 1000;
const SUMS = `SUM(input) AS input, SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read, SUM(output) AS output, SUM(COALESCE(cost, 0)) AS cost`;

function slice(r: Record<string, number | string>): UsageSlice {
  return {
    account: String(r.account), model: String(r.model), project: String(r.project),
    input: Number(r.input), cacheWrite: Number(r.cache_write), cacheRead: Number(r.cache_read), output: Number(r.output), cost: Number(r.cost), calls: Number(r.calls),
  };
}

function hasDailyTable(db: DatabaseSync): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_daily'`).get();
}

/** Days from `sinceDay` (inclusive; `since` is its start in ms), hours from `hourSince`. */
export function usageSlices(db: DatabaseSync, range: { since: number; sinceDay: string; hourSince: number }): UsageSlices {
  const daily = (hasDailyTable(db)
    ? db.prepare(`SELECT day, account, model, project, ${SUMS}, SUM(calls) AS calls FROM usage_daily WHERE day >= ? GROUP BY day, account, model, project`).all(range.sinceDay)
    : db.prepare(
      `SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, COALESCE(account, 'default') AS account, model, project, ${SUMS}, COUNT(*) AS calls
       FROM usage WHERE at >= ? GROUP BY 1, 2, 3, 4`,
    ).all(range.since)) as Record<string, number | string>[];
  const hourly = db.prepare(
    `SELECT CAST(at / ${HOUR} AS INTEGER) * ${HOUR} AS hour, COALESCE(account, 'default') AS account, model, project, ${SUMS}, COUNT(*) AS calls
     FROM usage WHERE at >= ? GROUP BY 1, 2, 3, 4`,
  ).all(range.hourSince) as Record<string, number | string>[];
  return {
    daily: daily.map((r) => ({ day: String(r.day), ...slice(r) })),
    hourly: hourly.map((r) => ({ hour: Number(r.hour), ...slice(r) })),
  };
}

/**
 * A cheap mark that moves when a call is recorded: the newest call's row and the number of calls. A call recorded
 * again with larger figures keeps both, so the publisher also builds again once an hour whatever this says.
 */
export function usageMark(db: DatabaseSync): string {
  const r = db.prepare('SELECT MAX(id) AS id, COUNT(*) AS n FROM usage').get() as { id: number | null; n: number };
  return `${r.id ?? 0}:${r.n}`;
}
