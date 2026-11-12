// Publishing this computer's usage to a shared git repo, and reading every computer's file back (issue #363).
// Off by default; switched on in Settings with a repo from the board's picker. Every 5 minutes, when the file
// would differ, the whole file is built again from the totals and replaces this computer's branch, so a
// computer that was offline catches up on its next publish. A failure is kept for Settings and tried again after
// 1, 2, then every 5 minutes, one retry at a time; it never reaches the rest of Ledung. Switching off deletes this
// computer's branch, or keeps trying to while GitHub refuses.
// Per account and per project (issue #380; Martin, 2026-10-28: "Different project should be able to publish to
// different boards. AND the publish usage should be per account."): only the accounts switched on (or all of them,
// ones added later too) are published, and a project with a repository of its own goes there instead of to the
// computer's default one. Each repository gets a file of its own on this computer's branch; a repository that is no
// longer published to has the branch deleted, the same way as switching off.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../board/types.ts';
import { readPublishedUsage, STALE_AFTER_MS, USAGE_REPO as REPO, type SharedUsageEntry, type SharedUsageView, type UsagePublishChange, type UsagePublishView } from '../shared/published-usage.ts';
import type { LimitInfo } from '../shared/protocol.ts';
import { DEFAULT_ACCOUNT } from '../accounts/store.ts';
import { buildPublishedUsage, contentKey, publishRange } from './publish-file.ts';
import type { UsageSlices } from './publish-source.ts';
import { parseUsageBranch, usageBranch, UsageRepo } from './publish-github.ts';
import { exercisedLine } from '../platform/exercised.ts';

export const PUBLISH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
/** A failed publish waits this long, longer each time it fails again, then 5 minutes each time. */
const RETRY_STEPS = [RETRY_MS, 2 * RETRY_MS, 5 * RETRY_MS];
const HOUR = 60 * 60 * 1000;
/** Reading the other computers' files: the list is conditional, so a quiet repo costs nothing. */
const READ_MS = 5 * 60 * 1000;
/** The usage key's file, next to the link keys in remoteDir(): never in the repo, the config or a release. */
export const USAGE_KEY_FILE = 'usage-key';
const KEY = /^[A-Za-z0-9_-]{43}$/;
const SETTING = 'usage-publish';
const COMPUTER_ID = 'usage-computer-id';
/** The repo this computer's branch still has to be deleted from, after a switch-off GitHub refused. */
const CLEANUP = 'usage-publish-cleanup';
/** The repos the last publish round published to, so one dropped since (a project moved, publishing off) is cleaned up (#380). */
const TARGETS = 'usage-publish-targets';

export interface PublisherProject {
  name: string;
  /** Published by its name (a project setting, off by default). */
  publishName: boolean;
  /** Its own usage repository (issue #380); null: the computer's default one. */
  repo: string | null;
  /** Removed from Ledung: only its repo counts, so its usage stays where it last went (Ledung question #366). */
  removed?: boolean;
}

export interface PublisherOptions {
  /** The database's meta table: the setting and the computer id live there. */
  meta: { get(key: string): string | null; set(key: string, value: string): void };
  /** remoteDir(), where the usage key is kept. */
  keyDir: string;
  slices: (range: { since: number; sinceDay: string; hourSince: number }) => UsageSlices;
  /** Moves when a call is recorded (usageMark): an unchanged mark skips building the file. */
  mark: () => string;
  limits: () => LimitInfo[];
  computer: () => string;
  projects: () => PublisherProject[];
  /** Each project's remote address, when it has one; read before every build, so a label never flips to the name's. */
  remotes: (projects: string[]) => Promise<Map<string, string | null>>;
  emailOf: (account: string) => string | null;
  /** Asks the linked computers for their usage key; null when none has one. */
  linkedKey: () => Promise<string | null>;
  repoFor?: (repo: string) => UsageRepo;
  now?: () => number;
  log?: (line: string) => void;
  /** Settings' view changed. */
  onChange?: () => void;
}

/**
 * The default repo, and which accounts are published: all of them (ones added later too), or those listed. Off is no
 * account on.
 */
interface Setting { repo: string | null; allAccounts: boolean; accounts: string[] }


const isOn = (s: Setting) => s.allAccounts || s.accounts.length > 0;

type ProjectSettings = { config: { name: string; publishUsageName?: boolean; usageRepo?: string } };
const ownRepo = (p: ProjectSettings) => (p.config.usageRepo && REPO.test(p.config.usageRepo) ? p.config.usageRepo : null);

/**
 * The projects as the publisher needs them: by name only when the project's own setting says so, which is off unless
 * set. A removed project that had a repo of its own keeps it, from its kept settings, so its usage never moves into
 * the default repo (Martin, 2026-10-28, Ledung question #366: "a — Keep the repository it last had"); it is never
 * published by name, as before.
 */
export function publisherProjects(projects: ProjectSettings[], removed: ProjectSettings[] = []): PublisherProject[] {
  const live = projects.map((p) => ({ name: p.config.name, publishName: p.config.publishUsageName === true, repo: ownRepo(p) }));
  const names = new Set(live.map((p) => p.name));
  const gone = removed.filter((p) => ownRepo(p) && !names.has(p.config.name)).map((p) => ({ name: p.config.name, publishName: false, repo: ownRepo(p), removed: true }));
  return [...live, ...gone];
}

/**
 * Which repo gets which projects' usage: the default repo everything but the projects with a repo of their own, each
 * of those its own projects. Empty when publishing is off. A project pointed at the default repo is the default's.
 * Without a default repo, only the projects' own (Settings' view; publishing never runs without one).
 */
export function publishTargets(s: { repo: string | null; on: boolean }, projects: PublisherProject[]): Map<string, { projects: Set<string>; rest: boolean }> {
  const out = new Map<string, { projects: Set<string>; rest: boolean }>();
  if (!s.on) return out;
  if (s.repo) out.set(s.repo, { projects: new Set(), rest: true });
  for (const p of projects) {
    if (!p.repo || p.repo.toLowerCase() === s.repo?.toLowerCase()) continue;
    const key = [...out.keys()].find((r) => r.toLowerCase() === p.repo!.toLowerCase()) ?? p.repo;
    if (!out.has(key)) out.set(key, { projects: new Set(), rest: false });
    out.get(key)!.projects.add(p.name);
  }
  return out;
}

export class UsagePublisher {
  private readonly opts: PublisherOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Where its EXERCISED lines go: the injected log in tests, else the trace that keeps them off the package's console (#422). */
  private readonly exercisedLine: (line: string) => void;
  /** One client per repo (#380), each with its login once read. */
  private clients = new Map<string, UsageRepo>();
  private logins = new Map<string, string>();
  /** Per repo: what its file last held, and the mark it was built at. */
  private lastKey = new Map<string, string>();
  private lastMark = new Map<string, string>();
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastPublishedAt: number | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private exercisedSplit = false;
  // The reader's state, for the default repo.
  private readRepo: string | null = null;
  private files = new Map<string, { sha: string; entry: SharedUsageEntry }>();
  private readError: string | null = null;
  private checkedAt: number | null = null;
  private writable: boolean | null = null;

  constructor(opts: PublisherOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.exercisedLine = opts.log ?? ((line) => exercisedLine(line));
  }

  private setting(): Setting {
    try {
      const s = JSON.parse(this.opts.meta.get(SETTING) ?? '') as Partial<Setting>;
      const repo = typeof s.repo === 'string' && REPO.test(s.repo) ? s.repo : null;
      const accounts = Array.isArray(s.accounts) ? [...new Set(s.accounts.filter((a): a is string => typeof a === 'string' && a.length > 0))].sort() : [];
      return { repo, allAccounts: s.allAccounts === true, accounts };
    } catch {
      return { repo: null, allAccounts: false, accounts: [] };
    }
  }

  private save(s: Setting): void {
    const value = JSON.stringify({ repo: s.repo, allAccounts: s.allAccounts, accounts: s.accounts });
    if (this.opts.meta.get(SETTING) !== value) this.opts.meta.set(SETTING, value);
  }

  private accountOn(s: Setting, account: string): boolean {
    return s.allAccounts || s.accounts.includes(account);
  }

  private targets(s = this.setting()): Map<string, { projects: Set<string>; rest: boolean }> {
    return publishTargets({ repo: s.repo, on: isOn(s) && s.repo !== null }, this.opts.projects());
  }

  /** Random, made once per install, so a renamed computer keeps its branch. */
  computerId(): string {
    let id = this.opts.meta.get(COMPUTER_ID);
    if (!id || !/^[0-9a-f]{16,64}$/.test(id)) {
      id = crypto.randomBytes(12).toString('hex');
      this.opts.meta.set(COMPUTER_ID, id);
    }
    return id;
  }

  private repo(name: string): UsageRepo {
    let client = this.clients.get(name);
    if (!client) this.clients.set(name, (client = this.opts.repoFor?.(name) ?? new UsageRepo({ repo: name })));
    return client;
  }

  private async login(repo: UsageRepo): Promise<string> {
    let login = this.logins.get(repo.repo);
    if (login === undefined) this.logins.set(repo.repo, (login = await repo.login()));
    return login;
  }

  /** The reader follows the default repo: a new one starts with nothing read. */
  private reader(name: string | null): UsageRepo | null {
    if (this.readRepo !== name) {
      this.readRepo = name;
      this.files = new Map();
      this.writable = null;
      this.checkedAt = null;
      this.readError = null;
    }
    return name ? this.repo(name) : null;
  }

  // --- The usage key ---------------------------------------------------------------------------------------

  private keyFile(): string {
    return path.join(this.opts.keyDir, USAGE_KEY_FILE);
  }

  /** The usage key, or null when this computer has none yet. */
  key(): string | null {
    try {
      const k = fs.readFileSync(this.keyFile(), 'utf8').trim();
      return KEY.test(k) ? k : null;
    } catch {
      return null;
    }
  }

  /** A pasted key (Settings), or one from a linked computer. */
  setKey(raw: unknown): void {
    const k = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY.test(k)) throw new BoardError('access', 'That is not a usage key: copy it whole from Settings on the other computer.');
    fs.mkdirSync(this.opts.keyDir, { recursive: true, mode: 0o700 });
    const temp = `${this.keyFile()}.${process.pid}.new`;
    fs.writeFileSync(temp, k, { mode: 0o600 });
    fs.renameSync(temp, this.keyFile());
    // Labels change with the key: the next publish carries them.
    this.forget();
    this.opts.onChange?.();
  }

  /** A linked computer's key when one has it, else a new one. */
  private async ensureKey(): Promise<Buffer> {
    let k = this.key();
    if (!k) {
      const theirs = await this.opts.linkedKey().catch(() => null);
      this.setKey(theirs && KEY.test(theirs) ? theirs : crypto.randomBytes(32).toString('base64url'));
      k = this.key()!;
    }
    return Buffer.from(k, 'base64url');
  }

  /** Takes the key a linked computer has (Settings' button), replacing this one's. */
  async takeLinkedKey(): Promise<boolean> {
    const theirs = await this.opts.linkedKey();
    if (!theirs) return false;
    this.setKey(theirs);
    return true;
  }

  // --- Settings ----------------------------------------------------------------------------------------------

  private forget(): void {
    this.lastKey.clear();
    this.lastMark.clear();
  }

  view(): UsagePublishView {
    const s = this.setting();
    // Where each project would go, on or off, so Settings shows it before publishing is switched on.
    const projects = this.opts.projects();
    const gone = new Set(projects.filter((p) => p.removed).map((p) => p.name));
    const projectRepos = [...publishTargets({ repo: s.repo, on: true }, projects)].filter(([, t]) => !t.rest)
      .map(([repo, t]) => ({ repo, projects: [...t.projects].sort().map((p) => (gone.has(p) ? `${p} (removed)` : p)) }));
    return {
      enabled: isOn(s), repo: s.repo, allAccounts: s.allAccounts, accounts: s.accounts, projectRepos,
      computer: this.opts.computer(), lastPublishedAt: this.lastPublishedAt, error: this.error, hasKey: this.key() !== null,
      pendingRemovals: this.cleanups(),
    };
  }

  /** What a change makes of the setting: the accounts given replace the ones kept; enabled alone is the old switch. */
  resolve(next: UsagePublishChange, before = this.setting()): Setting {
    if (next.repo !== null && !REPO.test(next.repo)) throw new BoardError('access', 'Write the repository as owner/name.');
    for (const a of next.accounts ?? []) if (typeof a !== 'string' || !a) throw new BoardError('access', 'Name each account to publish.');
    let s: Setting;
    if (next.enabled === false) s = { repo: next.repo, allAccounts: false, accounts: [] };
    else if (next.allAccounts !== undefined || next.accounts !== undefined) {
      s = { repo: next.repo, allAccounts: next.allAccounts ?? before.allAccounts, accounts: [...new Set(next.accounts ?? before.accounts)].sort() };
    } else {
      // The switch on alone: whatever was on stays; from off, every account.
      s = isOn(before) ? { ...before, repo: next.repo } : { repo: next.repo, allAccounts: true, accounts: [] };
    }
    if (isOn(s) && !s.repo) throw new BoardError('access', 'Choose the repository to publish to.');
    return s;
  }

  /**
   * Switches publishing on or off, chooses the accounts, or moves it to another repo. The setting is saved first, so
   * switching off always works; this computer's branch in each repo it no longer publishes to is then deleted, and
   * when GitHub can't be reached or refuses, the delete waits and is tried again with the publishes (review of
   * PR #370, finding 2). On publishes at once.
   */
  async configure(next: UsagePublishChange): Promise<UsagePublishView> {
    const s = this.resolve(next);
    this.save(s);
    this.forget();
    this.error = null;
    this.failures = 0;
    this.clearRetry();
    // A publish already under way ran on the old setting.
    await this.running;
    await this.publishNow();
    this.opts.onChange?.();
    return this.view();
  }

  /**
   * The repos this computer's branch still has to be deleted from. A list, so a second move while the first repo
   * still refuses doesn't forget it (review of PR #370, round 2, Minor). An entry of before is one repo, not a list.
   */
  private cleanups(): string[] {
    const raw = this.opts.meta.get(CLEANUP) ?? '';
    let list: unknown = raw;
    try {
      list = JSON.parse(raw);
    } catch { /* one repo, as round 1 kept it */ }
    const repos = Array.isArray(list) ? list : [list];
    return [...new Set(repos.filter((r): r is string => typeof r === 'string' && REPO.test(r)))];
  }

  private setCleanups(repos: string[]): void {
    this.opts.meta.set(CLEANUP, JSON.stringify([...new Set(repos)]));
  }

  /** The repos the last round published to. */
  private lastTargets(): string[] {
    try {
      const list = JSON.parse(this.opts.meta.get(TARGETS) ?? '[]') as unknown;
      return Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string' && REPO.test(r)) : [];
    } catch {
      return [];
    }
  }

  // --- Publishing --------------------------------------------------------------------------------------------

  start(): void {
    // The 5-minute round waits while a retry is pending, so a failure never adds a second chain (review of PR #370, finding 1).
    this.timer = setInterval(() => { if (!this.retryTimer) void this.publishNow(); }, PUBLISH_MS);
    this.timer.unref();
    this.readTimer = setInterval(() => void this.refresh().catch(() => {}), READ_MS);
    this.readTimer.unref();
    // Soon after the start, not during it.
    setTimeout(() => void this.publishNow(), 10_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.readTimer) clearInterval(this.readTimer);
    this.clearRetry();
    this.timer = this.readTimer = null;
  }

  /** A waiting branch delete, then one publish when switched on and the file would differ; never throws. */
  publishNow(): Promise<void> {
    this.running ??= this.publishOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Each waiting delete in a try of its own, then the publish to the chosen repo whatever they did: an old repo
   * that refuses for good (access removed) must not keep the new one from ever getting a publish (review of
   * PR #370, round 2, Important). Any failure keeps what failed and waits for the one retry.
   */
  private async publishOnce(): Promise<void> {
    const s = this.setting();
    const targets = this.targets(s);
    // A repo published to last time and not now (switched off, moved, its project moved or gone) is cleaned up.
    const dropped = this.lastTargets().filter((r) => !targets.has(r));
    if (dropped.length) this.setCleanups([...this.cleanups(), ...dropped]);
    this.opts.meta.set(TARGETS, JSON.stringify([...targets.keys()]));
    // Publishing to a repo again replaces the branch there, so a waiting delete in it is done.
    if (this.cleanups().some((r) => targets.has(r))) this.setCleanups(this.cleanups().filter((r) => !targets.has(r)));
    const pending = this.cleanups();
    if (!pending.length && !targets.size) return;
    const failures: { message: string; error: unknown }[] = [];
    for (const repo of pending) {
      try {
        await this.deleteOwn(repo);
        this.setCleanups(this.cleanups().filter((r) => r !== repo));
        this.lastKey.delete(repo);
        this.lastMark.delete(repo);
        if (!targets.size) this.lastPublishedAt = null;
      } catch (e) {
        failures.push({ message: `Removing this computer's usage from ${repo} failed: ${(e as Error).message}`, error: e });
      }
    }
    if (targets.size) {
      try {
        await this.publishTo(s, targets, failures);
      } catch (e) {
        failures.push({ message: (e as Error).message, error: e });
      }
    }
    if (!failures.length) {
      this.failures = 0;
      this.clearRetry();
      if (this.error !== null) {
        this.error = null;
        this.opts.onChange?.();
      }
      return;
    }
    this.failures++;
    this.error = failures.map((f) => f.message).join(' ');
    // At most one retry waits; repeated failures wait longer: 1, 2, then every 5 minutes.
    const asked = Math.max(0, ...failures.map((f) => (f.error instanceof BoardError && f.error.retryAfterMs ? f.error.retryAfterMs : 0)));
    const wait = Math.max(RETRY_STEPS[Math.min(this.failures, RETRY_STEPS.length) - 1]!, asked);
    this.log(`Usage publishing: ${this.error} Trying again in ${Math.round(wait / 60_000)} min.`);
    this.opts.onChange?.();
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.publishNow();
      }, wait);
      this.retryTimer.unref();
    }
  }

  /** Deletes this computer's branch in a repo it no longer publishes to, with a client of its own so the current repo's state stays. */
  private async deleteOwn(repoName: string): Promise<void> {
    const repo = this.repo(repoName);
    const branch = usageBranch(await this.login(repo), this.computerId());
    await repo.deleteBranch(branch);
    if (this.readRepo === repoName) this.files.delete(branch);
  }

  /**
   * One file per repo, from one build of the totals: each gets the accounts switched on, for its own projects (the
   * default repo: every project without a repo of its own, and usage no project claims, such as chats). An account's
   * plan limits go where its usage goes, and to the default repo when it has none yet, so an account used only by a
   * work project shows its limits to the work repo alone. Every repo is tried, whatever another one did.
   */
  private async publishTo(s: Setting, targets: Map<string, { projects: Set<string>; rest: boolean }>, failures: { message: string; error: unknown }[]): Promise<void> {
    // One repo's failure names it when there are several; alone, it is the message itself.
    const fail = (repo: string, e: unknown) => failures.push({ message: targets.size > 1 ? `Publishing to ${repo} failed: ${(e as Error).message}` : (e as Error).message, error: e });
    const logins = new Map<string, string>();
    for (const repo of targets.keys()) {
      try {
        logins.set(repo, await this.login(this.repo(repo)));
      } catch (e) {
        fail(repo, e);
      }
    }
    if (!logins.size) return;
    const key = await this.ensureKey();
    const now = this.now();
    const projects = this.opts.projects();
    const named = projects.filter((p) => p.publishName).map((p) => p.name).sort();
    const limits = this.opts.limits();
    // Nothing recorded, no new limit reading, the same hour and settings: the files would be the same, so they are not
    // even built (review of PR #370, finding 3). A new hour builds them, which also catches a call recorded again.
    const routing = JSON.stringify([s.allAccounts, s.accounts, [...targets].map(([r, t]) => [r, t.rest, [...t.projects].sort()])]);
    const mark = [this.opts.mark(), Math.floor(now / HOUR), Math.max(0, ...limits.map((l) => l.seenAt ?? l.at)), named.join('\n'), this.opts.computer(), routing].join('|');
    const due = [...logins.keys()].filter((r) => this.lastMark.get(r) !== `${mark}|${logins.get(r)}` || !this.lastKey.has(r));
    if (!due.length) return;
    const all = this.opts.slices(publishRange(now));
    const on = (account: string) => this.accountOn(s, account || DEFAULT_ACCOUNT);
    const owned = new Set([...targets.values()].filter((t) => !t.rest).flatMap((t) => [...t.projects]));
    const belongs = (t: { projects: Set<string>; rest: boolean }, project: string) => (t.rest ? !owned.has(project) : t.projects.has(project));
    const sliced = new Map([...targets].map(([repo, t]) => [repo, {
      daily: all.daily.filter((x) => on(x.account) && belongs(t, x.project)),
      hourly: all.hourly.filter((x) => on(x.account) && belongs(t, x.project)),
    } satisfies UsageSlices]));
    const used = new Map([...sliced].map(([repo, sl]) => [repo, new Set([...sl.daily, ...sl.hourly].map((x) => x.account || DEFAULT_ACCOUNT))]));
    const anywhere = new Set([...used.values()].flatMap((u) => [...u]));
    const remotes = await this.opts.remotes([...new Set([...all.daily, ...all.hourly].map((x) => x.project))]);
    for (const repoName of due) {
      const login = logins.get(repoName)!;
      const t = targets.get(repoName)!;
      const file = buildPublishedUsage({
        login, computer: this.opts.computer(), computerId: this.computerId(), repo: repoName, now,
        slices: sliced.get(repoName)!,
        limits: limits.filter((l) => on(l.account) && (used.get(repoName)!.has(l.account || DEFAULT_ACCOUNT) || (t.rest && !anywhere.has(l.account || DEFAULT_ACCOUNT)))),
        emailOf: this.opts.emailOf, named: new Set(named), remoteOf: (p) => remotes.get(p) ?? null, key,
      });
      const changed = contentKey(file);
      try {
        if (changed !== this.lastKey.get(repoName)) {
          await this.repo(repoName).publish(usageBranch(login, file.computerId), Buffer.from(JSON.stringify(file)), `Usage of ${file.computer}`);
          this.lastKey.set(repoName, changed);
          this.lastPublishedAt = now;
          if (targets.size > 1 && !this.exercisedSplit) {
            this.exercisedSplit = true;
            this.exercisedLine('EXERCISED #380 usage published to a repository per project');
          }
          this.opts.onChange?.();
        }
        this.lastMark.set(repoName, `${mark}|${login}`);
      } catch (e) {
        fail(repoName, e);
      }
    }
  }

  // --- Reading -------------------------------------------------------------------------------------------------

  /** Every computer's file in the repo, read again when it was last read over a minute ago. */
  async shared(fresh = false): Promise<SharedUsageView> {
    const s = this.setting();
    this.reader(s.repo);
    if (fresh || this.checkedAt === null || this.now() - this.checkedAt > RETRY_MS) await this.refresh().catch(() => {});
    const entries = [...this.files.values()].map((f) => ({ ...f.entry, stale: f.entry.asOf !== null && this.now() - f.entry.asOf > STALE_AFTER_MS }))
      .sort((a, b) => Number(b.own) - Number(a.own) || (a.computer ?? '').localeCompare(b.computer ?? ''));
    return { repo: s.repo, entries, canRemove: this.writable === true, error: this.readError, checkedAt: this.checkedAt };
  }

  /** Lists the branches (free when nothing changed) and fetches only the files whose branch moved. */
  async refresh(): Promise<void> {
    const s = this.setting();
    if (!s.repo) return;
    const repo = this.reader(s.repo)!;
    try {
      const { heads, changed } = await repo.heads();
      this.writable ??= await repo.canWrite().catch(() => false);
      this.checkedAt = this.now();
      this.readError = null;
      if (!changed && ![...this.files.values()].some((f) => f.sha === '')) return;
      const own = usageBranch(await this.login(repo), this.computerId());
      const next = new Map<string, { sha: string; entry: SharedUsageEntry }>();
      for (const h of heads) {
        const kept = this.files.get(h.branch);
        // A file that could not be downloaded is kept without its commit, so the next read tries it again.
        if (kept && kept.sha === h.sha) {
          next.set(h.branch, kept);
          continue;
        }
        const read = await this.readEntry(repo, h.branch, h.sha, h.branch === own);
        next.set(h.branch, { sha: read.downloaded ? h.sha : '', entry: read.entry });
      }
      this.files = next;
    } catch (e) {
      this.readError = (e as Error).message;
      throw e;
    }
  }

  private async readEntry(repo: UsageRepo, branch: string, sha: string, own: boolean): Promise<{ entry: SharedUsageEntry; downloaded: boolean }> {
    const id = branch.slice('ledung-usage/'.length);
    const from = parseUsageBranch(branch);
    let raw: unknown;
    try {
      raw = await repo.readFile(sha);
    } catch (e) {
      return { downloaded: false, entry: { id, own, state: 'invalid', login: from?.login ?? null, computer: null, asOf: null, stale: false, reason: `not downloaded: ${(e as Error).message}` } };
    }
    const read = readPublishedUsage(raw);
    if (read.kind === 'ok') return { downloaded: true, entry: { id, own, state: 'ok', login: read.file.login, computer: read.file.computer, asOf: read.file.asOf, stale: false, file: read.file } };
    if (read.kind === 'newer') return { downloaded: true, entry: { id, own, state: 'newer', login: read.login, computer: read.computer, asOf: read.asOf, stale: false } };
    return { downloaded: true, entry: { id, own, state: 'invalid', login: from?.login ?? null, computer: null, asOf: null, stale: false, reason: read.reason } };
  }

  /**
   * Removes a silent computer's branch: only one stale for 30 days, only for a login that can write to the
   * repo, and only after the page's confirm (the route checks it). This computer's own goes by switching off.
   */
  async removeStale(id: string): Promise<SharedUsageView> {
    const s = this.setting();
    if (!s.repo) throw new BoardError('access', 'No usage repository is chosen.');
    const branch = `ledung-usage/${id}`;
    const found = this.files.get(branch);
    if (!found || !parseUsageBranch(branch)) throw new BoardError('access', 'That computer is not in the usage repository.');
    const view = await this.shared();
    const entry = view.entries.find((e) => e.id === id);
    if (!entry?.stale) throw new BoardError('access', 'Only a computer silent for 30 days can be removed.');
    if (entry.own) throw new BoardError('access', 'Switch publishing off to remove this computer\'s own usage.');
    if (!view.canRemove) throw new BoardError('access', `Removing needs write access to ${s.repo}.`);
    await this.reader(s.repo)!.deleteBranch(branch);
    this.files.delete(branch);
    return this.shared(true);
  }
}
