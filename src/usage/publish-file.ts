// Builds the usage file a computer publishes to the shared repo (issue #363; the format is
// src/shared/published-usage.ts). Only totals go in, under labels made here: an account's name and a salted hash
// of its email, a project's display name when its owner switched it on, else `other#` and 4 characters from a
// keyed hash (#312, #316). Nothing from the records' text (prompts, paths, branches, titles) is ever read.
import crypto from 'node:crypto';
import { DEFAULT_ACCOUNT } from '../accounts/store.ts';
import { PUBLISHED_DAYS, PUBLISHED_HOURS, PUBLISHED_USAGE_VERSION, type PublishedAccount, type PublishedLimit, type PublishedTotals, type PublishedUsage } from '../shared/published-usage.ts';
import type { LimitInfo } from '../shared/protocol.ts';
import { shortModel } from './queries.ts';
import type { UsageSlices } from './publish-source.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A git remote's address, normalised so one repo written in different ways is one identity: lower case, no
 * scheme, no credentials, no ".git", no trailing "/"; "git@host:owner/repo" reads as "host/owner/repo".
 */
export function normaliseRemote(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Credentials: everything up to the last "@" before the first "/".
  const slash = u.indexOf('/');
  const at = u.lastIndexOf('@', slash === -1 ? u.length : slash);
  if (at !== -1) u = u.slice(at + 1);
  // scp-like "host:owner/repo"; a port ("host:22/owner") is dropped the same way.
  u = u.replace(/^([^/:]+):(\d+\/)?/, '$1/');
  return u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

const LABEL_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * `other#` and 4 characters (0–9, a–z) for a project that is not published by name: an HMAC with the person's
 * usage key of its normalised git remote, or of its Ledung name when it has none. Stable, the same on every
 * computer that shares the key, and nothing of the name can be read from it.
 */
export function otherLabel(identity: { remote?: string | null; name: string }, key: Buffer): string {
  const id = identity.remote ? `remote:${normaliseRemote(identity.remote)}` : `name:${identity.name}`;
  const mac = crypto.createHmac('sha256', key).update(id).digest();
  let n = mac.readUInt32BE(0);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += LABEL_CHARS[n % 36];
    n = Math.floor(n / 36);
  }
  return `other#${out}`;
}

/** SHA-256 of the email salted with the repo's name, so one account is one card without the email in the file. */
export function accountFingerprint(email: string, repo: string): string {
  return crypto.createHash('sha256').update(`ledung-usage\n${repo.trim().toLowerCase()}\n${email.trim().toLowerCase()}`).digest('hex');
}

/** "YYYY-MM-DD" in the computer's own time zone. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface BuildInput {
  login: string;
  computer: string;
  computerId: string;
  repo: string;
  now: number;
  slices: UsageSlices;
  limits: LimitInfo[];
  /** An account's sign-in email when known ("default": the computer's own login). */
  emailOf: (account: string) => string | null;
  /** The projects published by name. */
  named: Set<string>;
  /** A project's git remote address, when it has one. */
  remoteOf: (project: string) => string | null;
  /** The usage key. */
  key: Buffer;
}

/** What a file covers: PUBLISHED_DAYS whole local days, and the PUBLISHED_HOURS whole hours up to now. */
export function publishRange(now: number): { since: number; sinceDay: string; hourSince: number } {
  const d = new Date(now - (PUBLISHED_DAYS - 1) * DAY);
  d.setHours(0, 0, 0, 0);
  return { since: d.getTime(), sinceDay: localDay(d.getTime()), hourSince: Math.floor(now / HOUR) * HOUR - (PUBLISHED_HOURS - 1) * HOUR };
}

const zero = (): PublishedTotals => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, calls: 0 });
const add = (t: PublishedTotals, s: PublishedTotals) => {
  t.input += s.input;
  t.cacheWrite += s.cacheWrite;
  t.cacheRead += s.cacheRead;
  t.output += s.output;
  t.cost += s.cost;
  t.calls += s.calls;
};

export function buildPublishedUsage(input: BuildInput): PublishedUsage {
  const labels = new Map<string, string>();
  const label = (project: string) => {
    let l = labels.get(project);
    if (!l) {
      l = input.named.has(project) ? project : otherLabel({ remote: input.remoteOf(project), name: project }, input.key);
      labels.set(project, l);
    }
    return l;
  };
  const range = publishRange(input.now);
  const accounts = new Map<string, { daily: Map<string, PublishedTotals & { t: string; model: string; project: string }>; hourly: Map<string, PublishedTotals & { t: number; model: string; project: string }> }>();
  const of = (name: string) => {
    let a = accounts.get(name);
    if (!a) accounts.set(name, (a = { daily: new Map(), hourly: new Map() }));
    return a;
  };
  // Models and labels are summed again: two full model names can be one short one, two projects one label.
  for (const s of input.slices.daily) {
    if (s.day < range.sinceDay) continue;
    const a = of(s.account || DEFAULT_ACCOUNT);
    const model = shortModel(s.model);
    const project = label(s.project);
    const dk = `${s.day}\n${model}\n${project}`;
    let d = a.daily.get(dk);
    if (!d) a.daily.set(dk, (d = { t: s.day, model, project, ...zero() }));
    add(d, s);
  }
  for (const s of input.slices.hourly) {
    if (s.hour < range.hourSince || s.hour > input.now) continue;
    const a = of(s.account || DEFAULT_ACCOUNT);
    const model = shortModel(s.model);
    const project = label(s.project);
    const hk = `${s.hour}\n${model}\n${project}`;
    let h = a.hourly.get(hk);
    if (!h) a.hourly.set(hk, (h = { t: s.hour, model, project, ...zero() }));
    add(h, s);
  }
  const limitsOf = (account: string): PublishedLimit[] => input.limits
    .filter((l) => l.account === account)
    .map((l) => ({ kind: l.kind, status: l.status, utilization: l.utilization, resetsAt: l.resetsAt, seenAt: l.seenAt ?? l.at }));
  for (const l of input.limits) of(l.account);
  const byT = <T extends { t: string | number; model: string; project: string }>(x: T, y: T) =>
    (x.t < y.t ? -1 : x.t > y.t ? 1 : 0) || x.model.localeCompare(y.model) || x.project.localeCompare(y.project);
  const out: PublishedAccount[] = [...accounts.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([name, a]) => {
    const email = input.emailOf(name);
    return {
      label: name,
      fingerprint: email ? accountFingerprint(email, input.repo) : null,
      daily: [...a.daily.values()].sort(byT).map(round),
      hourly: [...a.hourly.values()].sort(byT).map(round),
      limits: limitsOf(name),
    };
  });
  return {
    version: PUBLISHED_USAGE_VERSION,
    login: input.login,
    computer: input.computer,
    computerId: input.computerId,
    asOf: input.now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    accounts: out,
  };
}

/** Costs to a hundredth of a cent: the file stays small and the sums stay right. */
function round<T extends PublishedTotals>(t: T): T {
  return { ...t, cost: Math.round(t.cost * 10_000) / 10_000 };
}

/** What changed in a file between two publishes: everything but its time. */
export function contentKey(file: PublishedUsage): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...file, asOf: 0 })).digest('hex');
}
