// Choosing a board repo (docs/steps/message-board.md, "Per project"; decision 2026-10-14): the repos the PC's
// `gh` login can reach, so the page offers them in a picker instead of a typed name, and the one write the
// picker can do, creating a private repo for a board. Reads are cached briefly; the create is only ever
// called from the page's route, with an explicit confirm (it writes to GitHub), never from a manager's tool.
import { BOARD_REPO } from '../config.ts';
import { fetchHttp, ghToken, type Http } from './github.ts';
import { BoardError } from './types.ts';

export interface AccessibleRepo {
  /** "owner/name". */
  repo: string;
  private: boolean;
}

export interface RepoOwner {
  login: string;
  /** The signed-in user's own account, or an organisation they belong to. */
  kind: 'user' | 'org';
}

export interface RepoChoices {
  repos: AccessibleRepo[];
  /** More repos exist than the pages read; the search box can still take a typed name. */
  truncated: boolean;
  fetchedAt: number;
}

/** What the server needs from the repo directory; the fake in tests and GitHub's implementation both fit. */
export interface RepoDirectory {
  choices(refresh: boolean): Promise<RepoChoices>;
  owners(): Promise<RepoOwner[]>;
  /** Creates a private repo owned by `owner` and returns "owner/name" as GitHub spells it. */
  create(owner: string, name: string): Promise<AccessibleRepo>;
}

const API = 'https://api.github.com';
const PER_PAGE = 100;
/** 10 pages: 1000 repos is far more than a picker is for; past that, search by typing. */
const MAX_PAGES = 10;
const CACHE_MS = 60_000;
const SIGN_IN = 'Sign in with `gh auth login` to list your repositories.';

interface GhRepo { full_name: string; private: boolean }

/** A GitHub repo name: letters, digits, `-`, `_`, `.`; not `.` or `..`, at most 100 characters. */
export function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(name) && name !== '.' && name !== '..' && !name.endsWith('.git');
}

export class GitHubRepos implements RepoDirectory {
  private readonly http: Http;
  private readonly token: () => Promise<string>;
  private readonly now: () => number;
  private tokenValue: string | null = null;
  private cache: RepoChoices | null = null;
  private login: string | null = null;

  constructor(opts: { http?: Http; token?: () => Promise<string>; now?: () => number } = {}) {
    this.http = opts.http ?? fetchHttp;
    this.token = opts.token ?? ghToken;
    this.now = opts.now ?? Date.now;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    if (!this.tokenValue) this.tokenValue = await this.token().catch(() => { throw new BoardError('signin', SIGN_IN); });
    const headers = { authorization: `Bearer ${this.tokenValue}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Ledung' };
    let res;
    try {
      res = await this.http(method, path.startsWith('http') ? path : `${API}${path}`, headers, body);
    } catch (e) {
      throw new BoardError('unreachable', `GitHub could not be reached: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      this.tokenValue = null;
      throw new BoardError('signin', SIGN_IN);
    }
    return res;
  }

  private static message(body: unknown): string {
    if (typeof body !== 'object' || !body) return '';
    const b = body as { message?: unknown; errors?: unknown };
    const detail = Array.isArray(b.errors) ? b.errors.map((e) => (typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : '')).filter(Boolean).join('; ') : '';
    return [typeof b.message === 'string' ? b.message : '', detail].filter(Boolean).join(': ');
  }

  private failure(what: string, status: number, body: unknown): BoardError {
    const why = GitHubRepos.message(body);
    if (status === 429 || (status === 403 && /rate limit/i.test(why))) return new BoardError('limited', `GitHub's rate limit stopped ${what}; try again in a minute.`, 60_000);
    if (status === 403 || status === 404) return new BoardError('access', `GitHub refused ${what}${why ? ` (${why})` : ''}.`);
    return new BoardError('unreachable', `GitHub answered ${status} for ${what}${why ? ` (${why})` : ''}.`);
  }

  /**
   * Every repo this login can reach: its own, the ones it collaborates on, and the organisations' (one
   * endpoint covers all three), newest push first. Cached for a minute; `refresh` reads again.
   */
  async choices(refresh = false): Promise<RepoChoices> {
    if (!refresh && this.cache && this.now() - this.cache.fetchedAt < CACHE_MS) return this.cache;
    const repos: AccessibleRepo[] = [];
    let next: string | null = `/user/repos?per_page=${PER_PAGE}&sort=pushed&affiliation=owner,collaborator,organization_member`;
    let pages = 0;
    for (; next && pages < MAX_PAGES; pages++) {
      const res = await this.call('GET', next);
      if (res.status !== 200) throw this.failure('listing your repositories', res.status, res.body);
      for (const r of res.body as GhRepo[]) repos.push({ repo: r.full_name, private: r.private });
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link ?? '')?.[1] ?? null;
    }
    this.cache = { repos, truncated: !!next, fetchedAt: this.now() };
    return this.cache;
  }

  /** Who a repo can be created under: the user, and every organisation they belong to (GitHub says no where they may not create). */
  async owners(): Promise<RepoOwner[]> {
    const me = await this.call('GET', '/user');
    if (me.status !== 200) throw this.failure('reading your account', me.status, me.body);
    this.login = (me.body as { login: string }).login;
    const owners: RepoOwner[] = [{ login: this.login, kind: 'user' }];
    let next: string | null = `/user/orgs?per_page=${PER_PAGE}`;
    for (let pages = 0; next && pages < MAX_PAGES; pages++) {
      const res = await this.call('GET', next);
      if (res.status !== 200) throw this.failure('listing your organisations', res.status, res.body);
      for (const o of res.body as { login: string }[]) owners.push({ login: o.login, kind: 'org' });
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link ?? '')?.[1] ?? null;
    }
    return owners;
  }

  /** Always private. The route has checked the user's confirm; this checks the names, so nothing odd reaches GitHub. */
  async create(owner: string, name: string): Promise<AccessibleRepo> {
    if (!validRepoName(name)) throw new BoardError('access', `"${name}" is not a repository name: use letters, digits, - _ and . only.`);
    if (!BOARD_REPO.test(`${owner}/${name}`)) throw new BoardError('access', `"${owner}" is not an account name.`);
    const owners = await this.owners();
    const found = owners.find((o) => o.login.toLowerCase() === owner.toLowerCase());
    if (!found) throw new BoardError('access', `You can't create repositories under "${owner}": it is neither your account nor an organisation you belong to.`);
    const path = found.kind === 'user' ? '/user/repos' : `/orgs/${encodeURIComponent(found.login)}/repos`;
    const res = await this.call('POST', path, { name, private: true, description: 'Message board for Ledung managers' });
    if (res.status === 422) {
      const why = GitHubRepos.message(res.body);
      if (/already exists|name already/i.test(why)) throw new BoardError('access', `${found.login}/${name} already exists. Pick another name, or choose it from the list.`);
      throw new BoardError('access', `GitHub did not accept the name "${name}"${why ? ` (${why})` : ''}.`);
    }
    if (res.status === 403 || res.status === 404) {
      throw new BoardError('access', found.kind === 'org'
        ? `You may not create repositories in ${found.login}${GitHubRepos.message(res.body) ? ` (${GitHubRepos.message(res.body)})` : ''}. Ask an owner of the organisation, or choose another owner.`
        : `GitHub refused to create the repository (${GitHubRepos.message(res.body) || res.status}). The \`gh\` login may lack the "repo" permission.`);
    }
    if (res.status !== 201) throw this.failure('creating the repository', res.status, res.body);
    const created = res.body as GhRepo;
    const made = { repo: created.full_name, private: created.private };
    // The new repo belongs in the picker at once.
    this.cache = null;
    return made;
  }
}
