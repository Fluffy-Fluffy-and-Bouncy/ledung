// The shared usage repo on GitHub (issue #363), through the `gh` login as the board uses it. Each computer owns
// one branch, `ledung-usage/<login>/<computer id>`, and replaces it on every publish with one commit without
// parents (#311, as the board's evidence branch is replaced), so writers never conflict and the repo does not
// grow. Reading lists those branches with a conditional call, free when nothing changed (board experiment 1),
// and fetches only the files whose branch moved.
import { fetchHttp, ghToken, RAW_LIMIT, type Http } from '../board/github.ts';
import { BoardError } from '../board/types.ts';
import { USAGE_BRANCH_PREFIX, USAGE_FILE_PATH } from '../shared/published-usage.ts';

const API = 'https://api.github.com';
const RAW = 'application/vnd.github.raw+json';
const SIGN_IN = 'Sign in with `gh auth login` to publish and read usage.';
/** A login (GitHub's rules) and the computer id this Ledung makes: nothing else is ever put in a branch name. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const COMPUTER_ID = /^[0-9a-f]{16,64}$/;

/** `ledung-usage/<login>/<computer id>`. */
export function usageBranch(login: string, computerId: string): string {
  if (!LOGIN.test(login) || !COMPUTER_ID.test(computerId)) throw new Error('Not a usage branch.');
  return `${USAGE_BRANCH_PREFIX}${login}/${computerId}`;
}

/** The branch's login and computer id, or null when it is not one Ledung makes. */
export function parseUsageBranch(ref: string): { login: string; computerId: string } | null {
  const m = /^(?:refs\/heads\/)?ledung-usage\/([^/]+)\/([^/]+)$/.exec(ref);
  return m && LOGIN.test(m[1]!) && COMPUTER_ID.test(m[2]!) ? { login: m[1]!, computerId: m[2]! } : null;
}

export interface UsageBranchHead {
  branch: string;
  /** The branch's commit. */
  sha: string;
}

export class UsageRepo {
  readonly repo: string;
  private readonly http: Http;
  private readonly token: () => Promise<string>;
  private tokenValue: string | null = null;
  private listTag: { etag: string; heads: UsageBranchHead[] } | null = null;

  constructor(opts: { repo: string; http?: Http; token?: () => Promise<string> }) {
    this.repo = opts.repo;
    this.http = opts.http ?? fetchHttp;
    this.token = opts.token ?? ghToken;
  }

  private async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    if (!this.tokenValue) this.tokenValue = await this.token().catch(() => { throw new BoardError('signin', SIGN_IN); });
    const headers = { authorization: `Bearer ${this.tokenValue}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Ledung', ...extra };
    let res;
    try {
      res = await this.http(method, `${API}${path}`, headers, body);
    } catch (e) {
      throw new BoardError('unreachable', `GitHub could not be reached: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      this.tokenValue = null;
      throw new BoardError('signin', SIGN_IN);
    }
    return res;
  }

  private failure(what: string, res: { status: number; body: unknown; headers: Record<string, string> }): BoardError {
    const why = typeof res.body === 'object' && res.body && 'message' in res.body ? String((res.body as { message: unknown }).message) : '';
    if (res.status === 429 || (res.status === 403 && (res.headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(why)))) {
      return new BoardError('limited', `GitHub's rate limit stopped ${what}.`, 60_000);
    }
    if (res.status === 403 || res.status === 404) return new BoardError('access', `GitHub refused ${what}: ${this.repo} is missing, or the login can't write to it${why ? ` (${why})` : ''}.`);
    return new BoardError('unreachable', `GitHub answered ${res.status} for ${what}${why ? ` (${why})` : ''}.`);
  }

  private async ok(what: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.call(method, path, body);
    if (res.status < 200 || res.status >= 300) throw this.failure(what, res);
    return res.body;
  }

  /** The `gh` login's name. */
  async login(): Promise<string> {
    const u = await this.ok('reading your account', 'GET', '/user') as { login?: unknown };
    if (typeof u.login !== 'string' || !LOGIN.test(u.login)) throw new BoardError('unreachable', 'GitHub did not say who is signed in.');
    return u.login;
  }

  /** Whether the login can write to the repo (and so remove another computer's branch). */
  async canWrite(): Promise<boolean> {
    const r = await this.ok(`reading ${this.repo}`, 'GET', `/repos/${this.repo}`) as { permissions?: { push?: boolean } };
    return r.permissions?.push === true;
  }

  /**
   * Replaces the branch with one commit without parents holding only the file: a tree, a commit and the ref
   * (about 3 calls). An empty repo refuses Git data calls, so it gets a README first, once, as a board repo does.
   */
  async publish(branch: string, bytes: Buffer, message: string): Promise<void> {
    const tree = { tree: [{ path: USAGE_FILE_PATH, mode: '100644', type: 'blob', content: bytes.toString('utf8') }] };
    let res = await this.call('POST', `/repos/${this.repo}/git/trees`, tree);
    if (res.status === 409 || (res.status === 422 && /empty/i.test(JSON.stringify(res.body)))) {
      await this.ok(`setting up ${this.repo}`, 'PUT', `/repos/${this.repo}/contents/README.md`, {
        message: 'Ledung usage', content: Buffer.from('# Ledung usage\n\nEach computer that publishes its usage owns one `ledung-usage/…` branch, which its Ledung replaces on every publish.\n').toString('base64'),
      });
      res = await this.call('POST', `/repos/${this.repo}/git/trees`, tree);
    }
    if (res.status !== 201) throw this.failure('publishing usage', res);
    const commit = await this.ok('publishing usage', 'POST', `/repos/${this.repo}/git/commits`, { message, tree: (res.body as { sha: string }).sha, parents: [] }) as { sha: string };
    const update = await this.call('PATCH', `/repos/${this.repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
    if (update.status === 200) return;
    if (update.status !== 422 && update.status !== 404) throw this.failure('publishing usage', update);
    // No branch yet.
    await this.ok('publishing usage', 'POST', `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  /** Deletes a branch; one that is gone already is fine. */
  async deleteBranch(branch: string): Promise<void> {
    const res = await this.call('DELETE', `/repos/${this.repo}/git/refs/heads/${branch}`);
    if (res.status === 204 || res.status === 404 || res.status === 422) return;
    throw this.failure('removing a computer\'s usage', res);
  }

  /**
   * Every computer's branch and its commit. Conditional: a 304 costs nothing against the rate limit, and the
   * heads kept from the last answer stand. `changed` is false then.
   */
  async heads(): Promise<{ heads: UsageBranchHead[]; changed: boolean }> {
    const res = await this.call('GET', `/repos/${this.repo}/git/matching-refs/heads/${USAGE_BRANCH_PREFIX}?per_page=100`, undefined, this.listTag ? { 'if-none-match': this.listTag.etag } : {});
    if (res.status === 304 && this.listTag) return { heads: this.listTag.heads, changed: false };
    // An empty repo has no refs at all.
    if (res.status === 409) return { heads: [], changed: this.listTag !== null };
    if (res.status !== 200) throw this.failure(`reading ${this.repo}`, res);
    const heads = (Array.isArray(res.body) ? res.body as { ref?: unknown; object?: { sha?: unknown } }[] : [])
      .filter((r) => typeof r.ref === 'string' && typeof r.object?.sha === 'string' && parseUsageBranch(r.ref))
      .map((r) => ({ branch: (r.ref as string).replace(/^refs\/heads\//, ''), sha: r.object!.sha as string }));
    if (res.headers.etag) this.listTag = { etag: res.headers.etag, heads };
    return { heads, changed: true };
  }

  /** The file at a branch's commit, parsed as JSON; at most RAW_LIMIT bytes. */
  async readFile(sha: string): Promise<unknown> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('Not a commit.');
    const res = await this.call('GET', `/repos/${this.repo}/contents/${USAGE_FILE_PATH}?ref=${sha}`, undefined, { accept: RAW });
    if (res.status !== 200) throw this.failure('reading a usage file', res);
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    if (text.length > RAW_LIMIT) throw new BoardError('unreachable', 'A usage file is too large.');
    return JSON.parse(text);
  }
}
