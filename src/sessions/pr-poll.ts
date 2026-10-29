// The pull request each live session's branch has, for the page (step 5c), polled for every session at
// once (issue #252, Martin's decision of 2026-10-20, Ledung question 425: "a — Skip + batch"):
// - free local git checks first: a branch on the remote's default branch, or never pushed, has no pull
//   request to find, and a merged or closed one is not asked about again until the branch moves;
// - one GraphQL query per repo per round for all the sessions on it, with the budget it leaves
//   (`rateLimit`), instead of one `gh pr view` per session (≈1 point a round instead of one per session);
// - under 20 % of the budget left it polls every 10 minutes, under 5 % not until the reset. GitHub has
//   shown two GraphQL counters that disagree (research of 2026-10-20), so the worst reading counts.
// The calls go through each session's runner, so a container's sessions use the container's `gh`.
import type { GitHubBudget, PullRequestInfo } from '../shared/protocol.ts';

/** What git prints, raw: `rev-parse --abbrev-ref HEAD`, the GIT_STATE.config lines and the GIT_STATE.refs lines. */
export interface GitState { head: string; config: string; refs: string }

/** The git arguments the runners run for GitState, so a local and a container session read the same. */
export const GIT_STATE = {
  config: ['config', '--get-regexp', '^(branch|remote)\\.'],
  refs: ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/remotes'],
};

/** A `gh api` call's outcome: a GraphQL error still prints the body, so a failure keeps stdout. */
export type GhAnswer = { ok: true; stdout: string } | { ok: false; stdout: string; error: string };

/** What a session's runner offers the poller. */
export interface PrSource {
  readonly ghScope: string;
  gitState(): Promise<GitState | null>;
  ghApi(args: string[], input: string | null, timeoutMs: number): Promise<GhAnswer>;
}

/** Where a branch's pull request is looked for. */
export interface PrTarget { host: string; owner: string; name: string; branch: string; remoteBranch: string; sha: string }

/** Why a branch is not looked up: no branch, the remote's default branch, never pushed, or no GitHub remote. */
export type PrSkip = { skip: 'detached' | 'default' | 'unpushed' | 'remote'; branch: string | null };

/** Polling intervals and budget thresholds (Martin's decision of 2026-10-20). */
export const NORMAL_MS = 3 * 60 * 1000;
export const SLOW_MS = 10 * 60 * 1000;
export const LOW_SHARE = 0.2;
export const STOP_SHARE = 0.05;
/** A turn's end asks for a round this soon after, so turns ending together share one. */
export const SOON_MS = 3000;
const QUERY_TIMEOUT_MS = 20_000;
/** PRs asked for per branch: an open one is preferred over the newest closed one, as `gh pr view` does. */
const PRS_PER_BRANCH = 3;

/** owner/name and host of a GitHub remote URL (https, ssh or scp-like); null for anything else. */
export function parseRemoteUrl(url: string): { host: string; owner: string; name: string } | null {
  const u = url.trim();
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u)
    ?? /^(?:[^@/]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (!m) return null;
  // ssh over port 443 is still github.com; an Enterprise host carries "github" in its name as a rule.
  const host = m[1]!.toLowerCase() === 'ssh.github.com' ? 'github.com' : m[1]!.toLowerCase();
  if (!host.includes('github')) return null;
  return { host, owner: m[2]!, name: m[3]! };
}

/** Where to look for the branch's pull request, or why not to: decided from git alone, at no cost (issue #252). */
export function prTarget(state: GitState): PrTarget | PrSkip {
  const branch = state.head.trim();
  if (!branch || branch === 'HEAD') return { skip: 'detached', branch: null };
  const config = new Map<string, string>();
  for (const line of state.config.split(/\r?\n/)) {
    const at = line.indexOf(' ');
    if (at > 0) config.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const upstreamRemote = config.get(`branch.${branch}.remote`);
  const merge = config.get(`branch.${branch}.merge`);
  const hasUpstream = !!upstreamRemote && upstreamRemote !== '.' && !!merge?.startsWith('refs/heads/');
  const remote = hasUpstream ? upstreamRemote! : 'origin';
  const refs = new Map<string, { sha: string; symref: string }>();
  for (const line of state.refs.split(/\r?\n/)) {
    const [ref, sha = '', symref = ''] = line.trim().split(' ');
    if (ref) refs.set(ref, { sha, symref });
  }
  const base = `refs/remotes/${remote}/`;
  const head = refs.get(`${base}HEAD`)?.symref;
  const defaultBranch = head?.startsWith(base) ? head.slice(base.length) : null;
  // The branch pushed under its own name comes first: a branch made with `git switch -c x origin/main`
  // tracks main until it is pushed with -u, and may be pushed without it (seen in this project's worktrees).
  // Else the branch it tracks, which may not be fetched yet; else there is nothing pushed to look for.
  const remoteBranch = refs.has(base + branch) ? branch : hasUpstream ? merge!.slice('refs/heads/'.length) : branch;
  if (remoteBranch === defaultBranch) return { skip: 'default', branch };
  const sha = refs.get(base + remoteBranch)?.sha ?? '';
  if (!sha && !hasUpstream) return { skip: 'unpushed', branch };
  const repo = parseRemoteUrl(config.get(`remote.${remote}.url`) ?? '');
  if (!repo) return { skip: 'remote', branch };
  return { ...repo, branch, remoteBranch, sha };
}

const PR_NODES = `nodes{number title state isDraft url headRepositoryOwner{login} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}`;

/**
 * One query for the branches of one repo: per branch the ref's own pull requests (which also finds one from
 * a fork's branch) and the repo's pull requests by head branch name (which still finds a merged one after
 * GitHub deleted the branch), plus the budget. Strings go in as JSON, which GraphQL reads the same.
 */
export function batchQuery(owner: string, name: string, branches: string[]): string {
  const order = 'orderBy:{field:UPDATED_AT,direction:DESC}';
  const parts = branches.map((b, i) =>
    `r${i}:ref(qualifiedName:${JSON.stringify(`refs/heads/${b}`)}){associatedPullRequests(first:${PRS_PER_BRANCH},states:[OPEN,MERGED,CLOSED],${order}){${PR_NODES}}} ` +
    `h${i}:pullRequests(headRefName:${JSON.stringify(b)},first:${PRS_PER_BRANCH},${order}){${PR_NODES}}`);
  return `query{rateLimit{remaining limit resetAt} repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${parts.join(' ')}}}`;
}

/** A budget reading: points left of the hour's limit, and when it resets (ms). */
export interface Reading { remaining: number; limit: number; resetAt: number }

/** One GraphQL pull request node, as the page shows it. Checks are GitHub's own rollup of the head commit. */
function toInfo(pr: any): PullRequestInfo | null {
  if (!pr || typeof pr.number !== 'number') return null;
  const rollup = String(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? '').toUpperCase();
  return {
    number: pr.number,
    title: String(pr.title ?? ''),
    state: pr.isDraft && pr.state === 'OPEN' ? 'draft' : String(pr.state ?? '').toLowerCase() as PullRequestInfo['state'],
    url: String(pr.url ?? ''),
    checks: !rollup ? 'none' : ['FAILURE', 'ERROR'].includes(rollup) ? 'failing' : ['PENDING', 'EXPECTED'].includes(rollup) ? 'running' : 'passing',
  };
}

/** An open pull request first, else the most recently updated one. */
function pick(nodes: any[]): any {
  return nodes.find((n) => n?.state === 'OPEN') ?? nodes[0] ?? null;
}

/**
 * Reads a batchQuery answer: per branch its pull request (null: none), or null for all when the answer
 * is unusable; the budget it reports; and whether GitHub refused it for the rate limit.
 */
export function parseBatch(stdout: string, owner: string, count: number): { prs: (PullRequestInfo | null)[] | null; reading: Reading | null; rateLimited: boolean } {
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    return { prs: null, reading: null, rateLimited: /rate limit/i.test(stdout) };
  }
  const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
  const rateLimited = errors.some((e) => e?.type === 'RATE_LIMITED') || /rate limit/i.test(String(body?.message ?? ''));
  const rl = body?.data?.rateLimit;
  const reading = rl && typeof rl.remaining === 'number' && typeof rl.limit === 'number' && rl.limit > 0
    ? { remaining: rl.remaining, limit: rl.limit, resetAt: Date.parse(rl.resetAt) || 0 } : null;
  const repo = body?.data?.repository;
  if (body?.data === undefined || rateLimited) return { prs: null, reading, rateLimited };
  const prs = Array.from({ length: count }, (_, i) => {
    if (!repo) return null;
    const own = pick(repo[`r${i}`]?.associatedPullRequests?.nodes ?? []);
    // By name, only this repo owner's branch: another person's fork can have a branch of the same name.
    const byName = pick((repo[`h${i}`]?.nodes ?? []).filter((n: any) => String(n?.headRepositoryOwner?.login ?? '').toLowerCase() === owner.toLowerCase()));
    return toInfo(own ?? byName);
  });
  return { prs, reading, rateLimited };
}

/** `gh api rate_limit` (free: it counts against no budget): the GraphQL reading in it. */
export function parseRestReading(stdout: string): Reading | null {
  try {
    const g = JSON.parse(stdout)?.resources?.graphql;
    return g && typeof g.remaining === 'number' && typeof g.limit === 'number' && g.limit > 0
      ? { remaining: g.remaining, limit: g.limit, resetAt: Number(g.reset) * 1000 } : null;
  } catch {
    return null;
  }
}

/** The worst of the readings still in their hour; null when none is. */
export function worstReading(readings: (Reading | null)[], now: number): Reading | null {
  let worst: Reading | null = null;
  for (const r of readings) if (r && r.resetAt > now && (!worst || r.remaining / r.limit < worst.remaining / worst.limit)) worst = r;
  return worst;
}

/** How the poll runs at a reading: every 3 minutes, every 10, or not until the reset. */
export function pollingAt(r: Reading | null): GitHubBudget['polling'] {
  if (!r) return 'normal';
  const share = r.remaining / r.limit;
  return share < STOP_SHARE ? 'stopped' : share < LOW_SHARE ? 'slow' : 'normal';
}

interface Watched {
  source: PrSource;
  /** What was last looked up (repo, branch, pushed commit); a change asks again. */
  key: string | null;
  /** The local branch last seen, so a pruned remote branch doesn't hide a merged pull request. */
  branch: string | null;
  /** Its pull request was merged or closed for this key: not asked about again until the key changes. */
  done: boolean;
}

interface Budget { scope: string; host: string; rest: Reading | null; graphql: Reading | null }

export interface PullRequestPollerOptions {
  /** Shows a session's pull request (null: none); the session ignores an unchanged one. */
  show: (id: string, pr: PullRequestInfo | null) => void;
  /** The budgets changed. */
  onBudget: (budgets: GitHubBudget[]) => void;
  now?: () => number;
  /** Timers; tests pass their own. Returns a cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** The one pull request poll in Ledung: sessions are watched while live, and polled together in rounds. */
export class PullRequestPoller {
  private readonly watched = new Map<string, Watched>();
  /** Sessions whose turn ended (or that started) since the last round. */
  private readonly wanted = new Set<string>();
  private readonly budgetsByKey = new Map<string, Budget>();
  private readonly opts: PullRequestPollerOptions;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private cancelSoon: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again: 'soon' | 'all' | null = null;

  constructor(opts: PullRequestPollerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? realSchedule;
  }

  /** On start and after each turn: the session is polled in a round soon, then with the others. */
  watch(id: string, source: PrSource): void {
    const w = this.watched.get(id);
    if (w) w.source = source;
    else this.watched.set(id, { source, key: null, branch: null, done: false });
    this.wanted.add(id);
    if (!this.cancelSoon) this.cancelSoon = this.schedule(() => {
      this.cancelSoon = null;
      void this.run('soon');
    }, SOON_MS);
    if (!this.cancelTick) this.tick();
  }

  /** Stopped, archived or detached: not polled any more. */
  forget(id: string): void {
    this.watched.delete(id);
    this.wanted.delete(id);
    if (!this.watched.size) {
      this.cancelTick?.();
      this.cancelTick = null;
    }
  }

  /** The budgets as the page shows them, worst reading first per login and host. */
  budgets(): GitHubBudget[] {
    const now = this.now();
    const out: GitHubBudget[] = [];
    for (const b of this.budgetsByKey.values()) {
      const r = worstReading([b.rest, b.graphql], now);
      if (!r) continue;
      out.push({ host: b.host, container: b.scope === 'local' ? null : b.scope.replace(/^docker:/, '').split(':')[0]!, remaining: r.remaining, limit: r.limit, resetAt: r.resetAt, polling: pollingAt(r) });
    }
    return out;
  }

  /** The next all-session round, every 3 minutes, or 10 when a budget is low. */
  private tick(): void {
    this.cancelTick?.();
    if (!this.watched.size) {
      this.cancelTick = null;
      return;
    }
    const now = this.now();
    const slow = [...this.budgetsByKey.values()].some((b) => pollingAt(worstReading([b.rest, b.graphql], now)) !== 'normal');
    this.cancelTick = this.schedule(() => {
      this.cancelTick = null;
      void this.run('all').finally(() => this.tick());
    }, slow ? SLOW_MS : NORMAL_MS);
  }

  /** One round at a time; one asked for meanwhile runs after it. Exposed for tests. */
  run(kind: 'soon' | 'all'): Promise<void> {
    if (this.running) {
      this.again = this.again === 'all' || kind === 'all' ? 'all' : 'soon';
      return this.running;
    }
    this.running = this.round(kind).catch((e) => console.error(`Pull request poll: ${(e as Error).message}`)).finally(() => {
      this.running = null;
      const next = this.again;
      this.again = null;
      if (next) void this.run(next);
    });
    return this.running;
  }

  private async round(kind: 'soon' | 'all'): Promise<void> {
    const ids = kind === 'all' ? [...this.watched.keys()] : [...this.wanted].filter((id) => this.watched.has(id));
    for (const id of ids) this.wanted.delete(id);
    // 1. Local and free: where each branch's pull request would be, and whether to ask at all.
    const groups = new Map<string, { source: PrSource; host: string; owner: string; name: string; branches: Map<string, string[]> }>();
    await Promise.all(ids.map(async (id) => {
      const w = this.watched.get(id);
      if (!w) return;
      const state = await w.source.gitState();
      if (this.watched.get(id) !== w) return;
      const t = state ? prTarget(state) : { skip: 'detached' as const, branch: null };
      if ('skip' in t) {
        // A remote branch deleted after the merge (and pruned) leaves the same local branch: keep what is shown.
        const pruned = t.branch !== null && t.branch === w.branch && w.done;
        if (!pruned) {
          w.key = null;
          w.done = false;
          w.branch = t.branch;
          this.opts.show(id, null);
        }
        return;
      }
      const key = `${t.host}/${t.owner}/${t.name}#${t.branch}>${t.remoteBranch}@${t.sha}`;
      if (key !== w.key) {
        w.key = key;
        w.done = false;
      }
      w.branch = t.branch;
      if (w.done) return;
      const g = `${w.source.ghScope}\n${t.host}\n${t.owner}/${t.name}`.toLowerCase();
      const group = groups.get(g) ?? { source: w.source, host: t.host, owner: t.owner, name: t.name, branches: new Map() };
      group.branches.set(t.remoteBranch, [...group.branches.get(t.remoteBranch) ?? [], id]);
      groups.set(g, group);
    }));
    // 2. Per repo: one query, if the budget allows it.
    const readThisRound = new Set<string>();
    let budgetsChanged = false;
    for (const group of groups.values()) {
      const bk = `${group.source.ghScope}\n${group.host}`;
      const budget = this.budgetsByKey.get(bk) ?? { scope: group.source.ghScope, host: group.host, rest: null, graphql: null };
      this.budgetsByKey.set(bk, budget);
      const hostArgs = group.host === 'github.com' ? [] : ['--hostname', group.host];
      if (!readThisRound.has(bk)) {
        readThisRound.add(bk);
        const rest = await group.source.ghApi(['rate_limit', ...hostArgs], null, QUERY_TIMEOUT_MS);
        const reading = rest.ok ? parseRestReading(rest.stdout) : null;
        if (reading) {
          budget.rest = reading;
          budgetsChanged = true;
        }
      }
      const polling = pollingAt(worstReading([budget.rest, budget.graphql], this.now()));
      // Under 5 % nothing; under 20 % only the 10-minute rounds, not one per turn.
      if (polling === 'stopped' || (polling === 'slow' && kind === 'soon')) continue;
      const branches = [...group.branches.keys()];
      const answer = await group.source.ghApi(['graphql', ...hostArgs, '--input', '-'], JSON.stringify({ query: batchQuery(group.owner, group.name, branches) }), QUERY_TIMEOUT_MS);
      const parsed = parseBatch(answer.stdout, group.owner, branches.length);
      if (parsed.reading) {
        budget.graphql = parsed.reading;
        budgetsChanged = true;
      } else if (parsed.rateLimited || (!answer.ok && /rate limit/i.test(answer.error))) {
        // Refused for the limit: nothing more until the reset the free reading gives (else an hour).
        budget.graphql = { remaining: 0, limit: budget.rest?.limit ?? 5000, resetAt: budget.rest?.resetAt ?? this.now() + 60 * 60 * 1000 };
        budgetsChanged = true;
      }
      // Unusable (no gh, not signed in, offline): what is shown stays.
      if (!parsed.prs) continue;
      branches.forEach((b, i) => {
        const pr = parsed.prs![i] ?? null;
        for (const id of group.branches.get(b) ?? []) {
          const w = this.watched.get(id);
          if (!w) continue;
          w.done = pr?.state === 'merged' || pr?.state === 'closed';
          this.opts.show(id, pr);
        }
      });
    }
    if (budgetsChanged) this.opts.onBudget(this.budgets());
  }
}
