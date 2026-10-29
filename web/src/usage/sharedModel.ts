// The Shared tab's figures (issue #364), worked out from the files every computer publishes (#363): limit cards per
// account split by computer, one daily chart stackable five ways, and who's who. Pure, so the tests can check the sums.
import type { UsagePeriod } from '../../../src/shared/protocol.ts';
import { atReset, WINDOW_MS } from './projection.ts';
import { hasReset } from './readingAge.ts';
import type { PublishedAccount, PublishedBucket, PublishedUsage, SharedUsageView } from '../../../src/shared/published-usage.ts';

type PublishedFile = PublishedUsage;
type PublishedTotal = PublishedBucket;

const DAY = 86_400_000;
/** A computer that has not published for a day is marked stale (issue #364). */
export const STALE_MS = DAY;

/** One computer's file, with its account entries, as the tab reads them. */
interface Source { file: PublishedFile; account: PublishedAccount; key: string }

/** An account's card key: its fingerprint, or, before the email is known, the one computer's own entry. */
function accountKey(file: PublishedFile, account: PublishedAccount): string {
  return account.fingerprint ?? `${file.login}/${file.computerId}/${account.label}`;
}

export const tokensOf = (t: PublishedTotal) => t.input + t.cacheWrite + t.cacheRead + t.output;

/** The signed-in login: the one this computer publishes under; null while it publishes nothing. */
export function viewerLogin(view: SharedUsageView): string | null {
  return view.entries.find((e) => e.own)?.login ?? null;
}

/** The files the tab draws from: every readable one, or with Mine only the signed-in login's own. */
export function visibleFiles(view: SharedUsageView, mine: boolean): PublishedFile[] {
  const login = viewerLogin(view);
  return view.entries.flatMap((e) => (e.state === 'ok' && e.file && (!mine || e.file.login === login) ? [e.file] : []));
}

function sources(files: PublishedFile[]): Source[] {
  return files.flatMap((file) => file.accounts.map((account) => ({ file, account, key: accountKey(file, account) })));
}

/** The day a period starts on (YYYY-MM-DD, local), or null for all time. "week" is the earliest weekly window start among the accounts shown. */
export function periodStart(period: UsagePeriod, files: PublishedFile[], now: number): string | null {
  if (period === 'all') return null;
  let from: number;
  if (period === 'week') {
    const starts = sources(files).flatMap(({ account }) => account.limits.filter((l) => l.kind === 'seven_day' && l.resetsAt && l.resetsAt > now).map((l) => l.resetsAt! - WINDOW_MS.seven_day!));
    from = starts.length ? Math.min(...starts) : now - 6 * DAY;
  } else {
    from = now - (Number(period.replace('d', '')) - 1) * DAY;
  }
  return localDay(from);
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface LimitShare { computer: string; computerId: string; login: string; cost: number; share: number }
export interface LimitCardRow {
  kind: string;
  /** The freshest reading among the account's computers; reset: its window has reset since. */
  reading: { utilization: number | null; status: string; resetsAt: number | null; at: number; seenAt: number } | null;
  reset: boolean;
  /** "≈ N% by reset" at this pace; null with nothing to tell it from yet. */
  pace: number | null;
  /** Each computer's share of the API-equivalent cost since the window started. */
  shares: LimitShare[];
}
export interface AccountCard { fingerprint: string; label: string; people: string[]; computers: string[]; rows: LimitCardRow[] }

/** Cost on a computer since `from`: hourly totals where the file has them, daily ones for the days before that. */
export function costSince(account: PublishedAccount, from: number, model?: (m: string) => boolean): number {
  const take = (t: PublishedTotal) => !model || model(t.model);
  const hourly = account.hourly.filter(take);
  const firstHour = hourly.length ? Math.min(...hourly.map((h) => h.t)) : Infinity;
  let cost = 0;
  // An hour that began before the window's start still counts: hours are the finest the file gives.
  for (const h of hourly) if (h.t + 3_600_000 > from) cost += h.cost;
  const fromDay = localDay(from);
  const hourlyDay = Number.isFinite(firstHour) ? localDay(firstHour) : null;
  for (const d of account.daily) {
    if (!take(d) || d.t < fromDay) continue;
    // Days the hourly totals cover are counted from those (the first of them only partly, so not from the day's total).
    if (hourlyDay && d.t >= hourlyDay) continue;
    cost += d.cost;
  }
  return cost;
}

/** "seven_day_opus" counts only Opus models; the other windows count every model. */
function modelOf(kind: string): ((m: string) => boolean) | undefined {
  const family = /^seven_day_(opus|sonnet|haiku|fable)$/.exec(kind)?.[1];
  return family ? (m) => m.toLowerCase().includes(family) : undefined;
}

const KIND_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** One card per account (the fingerprint), however many computers or people share it. */
export function accountCards(files: PublishedFile[], now: number): AccountCard[] {
  const byAccount = new Map<string, Source[]>();
  for (const s of sources(files)) {
    const list = byAccount.get(s.key);
    if (list) list.push(s);
    else byAccount.set(s.key, [s]);
  }
  const cards: AccountCard[] = [];
  for (const [fingerprint, list] of byAccount) {
    // The label of the freshest file: owners name an account themselves, and the newest name is the likeliest current.
    const newest = [...list].sort((a, b) => b.file.asOf - a.file.asOf)[0]!;
    const kinds = [...new Set(list.flatMap((s) => s.account.limits.map((l) => l.kind)))]
      .filter((k) => k !== 'overage' && k !== 'seven_day_overage_included')
      .sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const rows = kinds.map((kind): LimitCardRow => {
      const readings = list.flatMap((s) => s.account.limits.filter((l) => l.kind === kind));
      const latest = readings.sort((a, b) => b.seenAt - a.seenAt)[0];
      const reading = latest ? { ...latest, at: latest.seenAt } : null;
      const reset = reading ? hasReset(reading, now) : false;
      const length = WINDOW_MS[kind] ?? WINDOW_MS.seven_day!;
      const from = reading?.resetsAt && !reset ? reading.resetsAt - length : now - length;
      const costs = list.map((s) => ({ computer: s.file.computer, computerId: s.file.computerId, login: s.file.login, cost: costSince(s.account, from, modelOf(kind)) }));
      const total = costs.reduce((n, c) => n + c.cost, 0);
      return {
        kind, reading, reset,
        pace: reading && !reset && reading.utilization != null ? atReset(kind.startsWith('seven_day') ? 'seven_day' : kind, reading.utilization, reading.resetsAt, now) : null,
        shares: costs.filter((c) => c.cost > 0).map((c) => ({ ...c, share: c.cost / total })).sort((a, b) => b.cost - a.cost),
      };
    });
    cards.push({
      fingerprint, label: newest.account.label, rows,
      people: [...new Set(list.map((s) => s.file.login))].sort(),
      computers: [...new Set(list.map((s) => s.file.computer))].sort(),
    });
  }
  return cards.sort((a, b) => a.label.localeCompare(b.label));
}

export type StackBy = 'person' | 'account' | 'computer' | 'model' | 'project';

/** The key a total is stacked under. Projects not published by name arrive as their "other#xxxx" label already. */
function keyOf(by: StackBy, s: Source, t: PublishedTotal): string {
  if (by === 'person') return s.file.login;
  if (by === 'account') return s.account.label;
  if (by === 'computer') return s.file.computer;
  if (by === 'model') return t.model;
  return t.project;
}

export interface DailyColumn { day: string; values: Record<string, number> }

/** Tokens per day from `from` to today, stacked by `by`; days without use are kept so the gaps show. */
export function dailyStack(files: PublishedFile[], by: StackBy, from: string | null, now: number): { keys: string[]; columns: DailyColumn[] } {
  const days = new Map<string, Record<string, number>>();
  const keys = new Set<string>();
  for (const s of sources(files)) {
    for (const t of s.account.daily) {
      if (from && t.t < from) continue;
      const k = keyOf(by, s, t);
      keys.add(k);
      // No prototype: the keys are labels from other people's files, and "__proto__" must stay a plain key (review of PR #372, finding 1).
      const row = days.get(t.t) ?? (Object.create(null) as Record<string, number>);
      row[k] = (row[k] ?? 0) + tokensOf(t);
      days.set(t.t, row);
    }
  }
  const first = from ?? [...days.keys()].sort()[0];
  const today = localDay(now);
  const columns: DailyColumn[] = [];
  if (first) {
    for (let d = new Date(`${first}T12:00:00`); localDay(d.getTime()) <= today; d.setDate(d.getDate() + 1)) {
      const day = localDay(d.getTime());
      columns.push({ day, values: days.get(day) ?? (Object.create(null) as Record<string, number>) });
    }
  }
  return { keys: [...keys].sort(), columns };
}

export interface WhoRow { login: string; account: string; fingerprint: string; computer: string; computerId: string; tokens: number; cost: number; asOf: number; stale: boolean }

/** Person → account → computer, with the period's tokens and cost and when the computer last published. */
export function whosWho(files: PublishedFile[], from: string | null, now: number): WhoRow[] {
  return sources(files).map(({ file, account, key }) => {
    const totals = account.daily.filter((t) => !from || t.t >= from);
    return {
      login: file.login, account: account.label, fingerprint: key, computer: file.computer, computerId: file.computerId,
      tokens: totals.reduce((n, t) => n + tokensOf(t), 0), cost: totals.reduce((n, t) => n + t.cost, 0),
      asOf: file.asOf, stale: now - file.asOf > STALE_MS,
    };
  }).sort((a, b) => a.login.localeCompare(b.login) || a.account.localeCompare(b.account) || a.computer.localeCompare(b.computer));
}
