// The usage file each computer publishes to the shared git repo (issue #363), and what reads it (#364, the
// Shared tab). One file per computer, on a branch of its own that every publish replaces (#311). Only totals
// and labels: never prompts, replies, tool output, paths, folder or branch names, session titles, emails or
// tokens. A project is named only when its owner switched it on; every other one is `other#` and 4
// characters from a keyed hash (#312, #316, Martin 2026-10-28: "all other should be "other#123" so its not
// identical").

/** The format this Ledung writes. A file with a higher version is shown as "update Ledung", not guessed at. */
export const PUBLISHED_USAGE_VERSION = 1;

/** Each computer's branch: `ledung-usage/<login>/<computer id>`. The page never shows it; it shows the file's names. */
export const USAGE_BRANCH_PREFIX = 'ledung-usage/';

/** The file's path on its branch. */
export const USAGE_FILE_PATH = 'usage.json';

/** Days of daily totals and hours of hourly totals a file carries. */
export const PUBLISHED_DAYS = 400;
export const PUBLISHED_HOURS = 8 * 24;

/** A computer is shown as stale after this long without a publish. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** One bucket's totals. Tokens as Claude reported them; cost is the API-equivalent in dollars. */
export interface PublishedTotals {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  calls: number;
}

/** A day's or an hour's totals for one model in one project. */
export interface PublishedBucket extends PublishedTotals {
  /** Daily: the publishing computer's local date, "YYYY-MM-DD". Hourly: the hour's start, ms since 1970 (UTC). */
  t: string | number;
  /** The model as the usage page shows it, e.g. "opus-5-5". */
  model: string;
  /** A switched-on project's display name, or `other#` and 4 characters (0–9, a–z) for every other project. */
  project: string;
}

/** A plan limit's latest reading (#360). */
export interface PublishedLimit {
  /** five_hour, seven_day, … as Claude Code reports it. */
  kind: string;
  /** allowed, allowed_warning or rejected. */
  status: string;
  /** 0–1, when reported. */
  utilization: number | null;
  resetsAt: number | null;
  /** When Claude Code last reported these figures. */
  seenAt: number;
}

export interface PublishedAccount {
  /** The name the owner gave the account in Ledung ("default": the computer's own login). */
  label: string;
  /**
   * SHA-256 of the sign-in email (trimmed, lower case) salted with the repo's name (lower case), hex; null
   * when the email is not known yet. Two computers on one account have the same one, and the email is not in it.
   */
  fingerprint: string | null;
  daily: (PublishedBucket & { t: string })[];
  hourly: (PublishedBucket & { t: number })[];
  limits: PublishedLimit[];
}

export interface PublishedUsage {
  version: number;
  /** The GitHub login that published it. */
  login: string;
  /** The computer's display name. */
  computer: string;
  /** Random, made once per install; the branch is named by it, so a renamed computer keeps its branch. */
  computerId: string;
  /** When the file was built, ms since 1970. */
  asOf: number;
  /** The computer's time zone (IANA), which its daily dates are in. */
  timeZone: string;
  accounts: PublishedAccount[];
}

/** What a reader makes of a file: one it can read, one from a newer Ledung, or one that is not a usage file. */
export type ReadPublished =
  | { kind: 'ok'; file: PublishedUsage }
  | { kind: 'newer'; version: number; login: string | null; computer: string | null; asOf: number | null }
  | { kind: 'invalid'; reason: string };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

function bucket(b: unknown, daily: boolean): boolean {
  if (!b || typeof b !== 'object') return false;
  const r = b as Record<string, unknown>;
  return (daily ? str(r.t) && /^\d{4}-\d{2}-\d{2}$/.test(r.t) : num(r.t)) && str(r.model) && str(r.project)
    && ['input', 'cacheWrite', 'cacheRead', 'output', 'cost', 'calls'].every((k) => num(r[k]));
}

/** Checks a downloaded file's shape; anything this Ledung would not have written is refused, not guessed at. */
export function readPublishedUsage(raw: unknown): ReadPublished {
  if (!raw || typeof raw !== 'object') return { kind: 'invalid', reason: 'not a JSON object' };
  const f = raw as Record<string, unknown>;
  if (!num(f.version)) return { kind: 'invalid', reason: 'no format version' };
  if (f.version > PUBLISHED_USAGE_VERSION) {
    return { kind: 'newer', version: f.version, login: str(f.login) ? f.login : null, computer: str(f.computer) ? f.computer : null, asOf: num(f.asOf) ? f.asOf : null };
  }
  if (!str(f.login) || !str(f.computer) || !str(f.computerId) || !num(f.asOf) || !str(f.timeZone) || !Array.isArray(f.accounts)) {
    return { kind: 'invalid', reason: 'a field is missing' };
  }
  for (const a of f.accounts as unknown[]) {
    const r = a as Record<string, unknown>;
    if (!r || typeof r !== 'object' || !str(r.label) || !(r.fingerprint === null || str(r.fingerprint))) return { kind: 'invalid', reason: 'an account is malformed' };
    if (!Array.isArray(r.daily) || !r.daily.every((b) => bucket(b, true))) return { kind: 'invalid', reason: 'a daily total is malformed' };
    if (!Array.isArray(r.hourly) || !r.hourly.every((b) => bucket(b, false))) return { kind: 'invalid', reason: 'an hourly total is malformed' };
    if (!Array.isArray(r.limits) || !r.limits.every((l) => l && str(l.kind) && str(l.status) && num(l.seenAt))) return { kind: 'invalid', reason: 'a limit is malformed' };
  }
  return { kind: 'ok', file: f as unknown as PublishedUsage };
}

/** A repository to publish to, as owner/name: the publisher's rule, and managers' usage_publish checks it before asking (issue #376). */
export const USAGE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * A change to publishing, from Settings or usage_publish (issue #380). enabled false switches every account off.
 * enabled true alone keeps the accounts that are on, or from off switches every account on. allAccounts and accounts, when given, replace what is kept.
 */
export interface UsagePublishChange { enabled: boolean; repo: string | null; allAccounts?: boolean; accounts?: string[] }

/** Settings' view of publishing on this computer. */
export interface UsagePublishView {
  /** Some account is published (issue #380): all of them, or one switched on. */
  enabled: boolean;
  /** "owner/name"; null: none chosen yet. The computer's default repo: every project without a repo of its own goes there. */
  repo: string | null;
  /** Every Claude account is published, ones added later too (#380). */
  allAccounts: boolean;
  /** The accounts switched on one by one ("default": the computer's own login); they count while allAccounts is off. */
  accounts: string[];
  /** The projects with a usage repo of their own, by repo, published there instead of to the default one (#380). */
  projectRepos?: { repo: string; projects: string[] }[];
  /** The computer's display name, as the file carries it. */
  computer: string;
  /** When a publish last went through; null: never. */
  lastPublishedAt: number | null;
  /** Why the last publish failed, until one goes through; it is tried again. */
  error: string | null;
  /** This computer has a usage key (it makes or fetches one when publishing is switched on). */
  hasKey: boolean;
  /** Repos publishing was switched off or moved from, where this computer's file still has to be removed; tried again with the publishes. */
  pendingRemovals?: string[];
}

/** One computer's file in the shared repo, as the reader found it. */
export interface SharedUsageEntry {
  /** Opaque, for removing a stale computer's file; never shown. */
  id: string;
  /** This computer's own file. */
  own: boolean;
  state: 'ok' | 'newer' | 'invalid';
  /** From the file; null when a newer or broken file does not say. */
  login: string | null;
  computer: string | null;
  asOf: number | null;
  /** No publish for STALE_AFTER_MS, by the file's own time; a file that can't be read is never stale. */
  stale: boolean;
  /** The file, when its state is ok. */
  file?: PublishedUsage;
  /** Why a file is invalid. */
  reason?: string;
}

export interface SharedUsageView {
  repo: string | null;
  entries: SharedUsageEntry[];
  /** The login can write to the repo, so a stale computer's file may be removed. */
  canRemove: boolean;
  /** Why the repo could not be read; the entries are the last ones read. */
  error: string | null;
  checkedAt: number | null;
}
