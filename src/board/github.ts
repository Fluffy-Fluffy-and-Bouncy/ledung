// The board on GitHub (docs/steps/message-board.md): one repo, a thread is an issue, the first post is
// its body and replies are comments. Polled with two conditional REST calls: a 304 costs nothing
// (experiment 1), so a quiet board is nearly free; step 0 measured ~1 s from a post to a changed answer.
import { execFile } from 'node:child_process';
import { ATTACHMENTS_MARK, readHeader, withHeader } from './address.ts';
import { kindLabel, MAX_IMAGE_BYTES, sizeLabel, type AttachmentRef } from './attachments.ts';
import { BoardError, type BoardAuthor, type BoardBackend, type BoardPeople, type IncomingPost, type OutgoingPost, type PollResult } from './types.ts';

export interface HttpAnswer { status: number; headers: Record<string, string>; body: unknown }
/** One HTTP call; tests pass recorded answers. Headers' names are lower case. */
export type Http = (method: string, url: string, headers: Record<string, string>, body?: unknown) => Promise<HttpAnswer>;

const API = 'https://api.github.com';
/** Under this share of the hourly budget left, poll every 15 s instead (decision 2). */
const LOW_BUDGET = 0.2;
const SLOW_MS = 15_000;
/** How far before the cursor each poll asks from. */
const OVERLAP_MS = 60_000;
const SIGN_IN = 'Board off: sign in with `gh auth login`.';
/** Asks the contents API for a file's bytes (board attachments). */
const RAW = 'application/vnd.github.raw+json';
/** Board attachments live on this branch, replaced on every change so it has no history (replaceEvidence). */
export const EVIDENCE_BRANCH = 'ledung-evidence';
/** How often a change of the evidence branch is built again when another Ledung moved it meanwhile. */
const REPLACE_ATTEMPTS = 5;
/** A file's bytes are read up to this many (the largest attachment); more is refused while reading (review M4). */
export const RAW_LIMIT = MAX_IMAGE_BYTES;

/** A response's body, refused as soon as it is larger than `max`: by its length if given, else while reading. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const tooLarge = () => new Error(`the file is larger than ${Math.round(max / 1048576)} MB, more than any attachment`);
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Leaving the loop (the throw) cancels the stream, so the rest is never read.
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export const fetchHttp: Http = async (method, url, headers, body) => {
  // A hung call would hold up the poller and every post behind it (they run one at a time).
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
  // A file's bytes (RAW) stay bytes; everything else is JSON.
  if (headers.accept === RAW && res.ok) return { status: res.status, headers: h, body: await readCapped(res, RAW_LIMIT) };
  const text = res.status === 304 ? '' : await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch { /* not JSON: kept as text */ }
  return { status: res.status, headers: h, body: parsed };
};

/** The PC's `gh` login (decision 8): asked for at each start, never stored by Ledung. */
export function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      const token = String(stdout ?? '').trim();
      if (err || !token) reject(new BoardError('signin', SIGN_IN));
      else resolve(token);
    });
  });
}

interface GhUser { login: string; name?: string | null; avatar_url?: string }
interface GhIssue { number: number; id: number; title: string; body: string | null; user: GhUser; created_at: string; updated_at: string; state?: string; pull_request?: unknown }
interface GhComment { id: number; body: string | null; user: GhUser; created_at: string; updated_at: string; issue_url: string }

/** The cursor: the newest `updated_at` seen; "since" is inclusive, so the overlap is de-duplicated by id. */
interface Cursor { since: string }

export class GitHubBackend implements BoardBackend {
  readonly id = 'github';
  readonly label = 'GitHub';
  private readonly repo: string;
  private readonly http: Http;
  private readonly token: () => Promise<string>;
  private readonly pollMs: number;
  private readonly now: () => number;
  private tokenValue: string | null = null;
  private readonly etags = new Map<string, { etag: string; body: unknown; link: string | null }>();

  constructor(opts: { repo: string; pollMs: number; http?: Http; token?: () => Promise<string>; now?: () => number }) {
    this.repo = opts.repo;
    this.pollMs = opts.pollMs;
    this.http = opts.http ?? fetchHttp;
    this.token = opts.token ?? ghToken;
    this.now = opts.now ?? Date.now;
  }

  /** A call to GitHub; conditional (If-None-Match) when `conditional`, answering a 304 from what was kept. */
  private async call(method: string, path: string, body?: unknown, conditional = false, accept = 'application/vnd.github+json'): Promise<{ body: unknown; headers: Record<string, string>; fresh: boolean }> {
    if (!this.tokenValue) this.tokenValue = await this.token();
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const kept = conditional ? this.etags.get(url) : undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.tokenValue}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'Ledung',
      ...(kept ? { 'if-none-match': kept.etag } : {}),
    };
    let res: HttpAnswer;
    try {
      res = await this.http(method, url, headers, body);
    } catch (e) {
      throw new BoardError('unreachable', `GitHub could not be reached: ${(e as Error).message}`);
    }
    this.lastHeaders = res.headers;
    if (res.status === 304 && kept) return { body: kept.body, headers: { ...res.headers, link: kept.link ?? '' }, fresh: false };
    if (res.status >= 200 && res.status < 300) {
      if (conditional && res.headers.etag) this.etags.set(url, { etag: res.headers.etag, body: res.body, link: res.headers.link ?? null });
      return { body: res.body, headers: res.headers, fresh: true };
    }
    throw this.failure(res);
  }

  private lastHeaders: Record<string, string> = {};

  private failure(res: HttpAnswer): BoardError {
    const message = typeof res.body === 'object' && res.body && 'message' in res.body ? String((res.body as { message: unknown }).message) : `HTTP ${res.status}`;
    const remaining = Number(res.headers['x-ratelimit-remaining']);
    const retryAfter = Number(res.headers['retry-after']);
    const reset = Number(res.headers['x-ratelimit-reset']);
    if (res.status === 429 || (res.status === 403 && (remaining === 0 || retryAfter > 0 || /rate limit/i.test(message)))) {
      const ms = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? Math.max(0, reset * 1000 - this.now()) : 60_000;
      return new BoardError('limited', `GitHub's rate limit (${message})`, ms);
    }
    if (res.status === 401) {
      // The token may have changed (gh auth login again): ask gh afresh next time.
      this.tokenValue = null;
      return new BoardError('signin', SIGN_IN);
    }
    if (res.status === 403 || res.status === 404) {
      return new BoardError('access', `The board ${this.repo} is missing, or the GitHub login has no access to it (${message}).`);
    }
    return new BoardError('unreachable', `GitHub answered ${res.status} (${message})`);
  }

  /** The issue, or its comment; built only from the validated repo and numbers, so a stored id can't make another link. */
  url(threadId: string, postId?: string): string | null {
    if (!/^\d+$/.test(threadId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repo)) return null;
    const issue = `https://github.com/${this.repo}/issues/${threadId}`;
    const comment = /^comment:(\d+)$/.exec(postId ?? '');
    return comment ? `${issue}#issuecomment-${comment[1]}` : issue;
  }

  async identity(): Promise<BoardAuthor> {
    const { body } = await this.call('GET', '/user');
    const u = body as GhUser;
    // The repo must be there and readable, so a wrong name shows at once rather than at the first post.
    await this.call('GET', `/repos/${this.repo}`);
    return { id: u.login, display: u.name || u.login };
  }

  async send(post: OutgoingPost): Promise<{ postId: string; threadId: string; at: number }> {
    const body = withHeader(post.to, post.fromProject, post.text, post.attachments) + this.attachmentList(post.attachments ?? []);
    if (post.threadId === null) {
      // Labels for people reading on GitHub; the header carries the exact recipients. A login with Read
      // access can't label, and GitHub then drops them silently.
      const labels = [...new Set(post.to.filter((t) => t.startsWith('@')).map((t) => `to:${t.slice(1).split('/')[0]!.toLowerCase()}`))];
      const { body: issue } = await this.call('POST', `/repos/${this.repo}/issues`, { title: post.title ?? 'Board thread', body, labels });
      const i = issue as GhIssue;
      return { postId: `issue:${i.number}`, threadId: String(i.number), at: Date.parse(i.created_at) || this.now() };
    }
    const { body: comment } = await this.call('POST', `/repos/${this.repo}/issues/${encodeURIComponent(post.threadId)}/comments`, { body });
    const c = comment as GhComment;
    return { postId: `comment:${c.id}`, threadId: post.threadId, at: Date.parse(c.created_at) || this.now() };
  }

  private incomingIssue(i: GhIssue): IncomingPost {
    const h = readHeader(i.body ?? '');
    return {
      postId: `issue:${i.number}`, threadId: String(i.number), title: i.title, author: { id: i.user.login, display: i.user.login },
      to: h.to, fromProject: h.fromProject, text: h.text, at: Date.parse(i.created_at), viaLedung: h.viaLedung, attachments: h.attachments,
    };
  }

  private incomingComment(c: GhComment, titles: Map<string, string>): IncomingPost {
    const h = readHeader(c.body ?? '');
    const threadId = c.issue_url.split('/').pop()!;
    return {
      postId: `comment:${c.id}`, threadId, title: titles.get(threadId), author: { id: c.user.login, display: c.user.login },
      to: h.to, fromProject: h.fromProject, text: h.text, at: Date.parse(c.created_at), viaLedung: h.viaLedung, attachments: h.attachments,
    };
  }

  /** All pages of a list, following Link: rel="next"; every page conditional. Fresh: anything changed. */
  private async list<T>(path: string): Promise<{ items: T[]; fresh: boolean }> {
    const items: T[] = [];
    let fresh = false;
    let next: string | null = path;
    for (let page = 0; next && page < 20; page++) {
      const r = await this.call('GET', next, undefined, true);
      fresh ||= r.fresh;
      items.push(...(r.body as T[]));
      next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.link ?? '')?.[1] ?? null;
    }
    return { items, fresh };
  }

  /**
   * What is new since the cursor: the issues list (new threads) and the comments list (replies), both
   * conditional every round, since a 304 is free. Checking comments only after the issues list changed
   * missed nothing but was slow: that list showed a new comment 6–12 s late when it had been empty, the
   * comments list within 2 s (step 2 smoke test). No cursor: from now on, so a first start delivers no history.
   */
  async poll(cursor: string | null): Promise<PollResult> {
    const since = cursor ? (JSON.parse(cursor) as Cursor).since : new Date(this.now()).toISOString();
    // Asked from a little before the cursor, so a post one list shows later than the other (its time
    // before the newest one seen) is still found; the core drops what it already has.
    const from = new Date(Date.parse(since) - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const q = `since=${encodeURIComponent(from)}&sort=updated&direction=asc&per_page=100`;
    const issues = await this.list<GhIssue>(`/repos/${this.repo}/issues?state=all&${q}`);
    const comments = await this.list<GhComment>(`/repos/${this.repo}/issues/comments?${q}`);
    const posts: IncomingPost[] = [];
    let newest = since;
    const titles = new Map<string, string>();
    const closed: string[] = [];
    for (const i of issues.items) {
      if (i.pull_request) continue;
      titles.set(String(i.number), i.title);
      if (i.state === 'closed') closed.push(String(i.number));
      if (i.updated_at > newest) newest = i.updated_at;
      // The issue body is the thread's first post; an issue only updated since is not new.
      if (issues.fresh && i.created_at >= from) posts.push(this.incomingIssue(i));
    }
    for (const c of comments.items) {
      if (c.updated_at > newest) newest = c.updated_at;
      if (comments.fresh && c.created_at >= from) posts.push(this.incomingComment(c, titles));
    }
    return { posts, cursor: JSON.stringify({ since: newest } satisfies Cursor), nextPollMs: this.interval(), closed };
  }

  /** 5 s, or 15 s while the budget is short (decision 2). */
  private interval(): number {
    const remaining = Number(this.lastHeaders['x-ratelimit-remaining']);
    const limit = Number(this.lastHeaders['x-ratelimit-limit']);
    return limit > 0 && remaining / limit < LOW_BUDGET ? Math.max(SLOW_MS, this.pollMs) : this.pollMs;
  }

  async readThread(threadId: string, last: number): Promise<{ title: string; posts: IncomingPost[] }> {
    const { body } = await this.call('GET', `/repos/${this.repo}/issues/${encodeURIComponent(threadId)}`);
    const issue = body as GhIssue & { comments: number };
    const titles = new Map([[threadId, issue.title]]);
    const pages = Math.max(1, Math.ceil(issue.comments / 100));
    const comments: GhComment[] = [];
    // The last page, and the one before when it is short, cover the last `last` (at most 50) posts.
    for (const page of [...new Set([pages - 1, pages])].filter((p) => p >= 1)) {
      const r = await this.call('GET', `/repos/${this.repo}/issues/${encodeURIComponent(threadId)}/comments?per_page=100&page=${page}`);
      comments.push(...(r.body as GhComment[]));
    }
    const posts = [this.incomingIssue(issue), ...comments.map((c) => this.incomingComment(c, titles))];
    return { title: issue.title, posts: posts.slice(-last) };
  }

  /** For people reading on GitHub: the attachments under the text, pictures shown (the repo is private, so only its readers see them). */
  private attachmentList(files: AttachmentRef[]): string {
    if (!files.length) return '';
    const lines = files.map((f) => {
      const link = `https://github.com/${this.repo}/blob/${EVIDENCE_BRANCH}/${f.path}`;
      return f.kind === 'text' ? `- [${f.name}](${link}) (text, ${sizeLabel(f.size)})` : `- ${f.name} (${kindLabel(f.kind)}, ${sizeLabel(f.size)})<br>![${f.name}](${link}?raw=true)`;
    });
    return `\n\n${ATTACHMENTS_MARK}\n**Attachments**\n${lines.join('\n')}`;
  }

  /** The evidence branch's commit and tree; null: no branch yet (GitHub answers 404). */
  private async evidenceHead(): Promise<{ commit: string; tree: string } | null> {
    try {
      const ref = (await this.call('GET', `/repos/${this.repo}/git/ref/heads/${EVIDENCE_BRANCH}`)).body as { object: { sha: string } };
      const commit = (await this.call('GET', `/repos/${this.repo}/git/commits/${ref.object.sha}`)).body as { tree: { sha: string } };
      return { commit: ref.object.sha, tree: commit.tree.sha };
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'access') return null;
      throw e;
    }
  }

  /** The evidence branch's commit; null: no branch. One call: whether it moved since a head was read. */
  private async evidenceRef(): Promise<string | null> {
    try {
      return ((await this.call('GET', `/repos/${this.repo}/git/ref/heads/${EVIDENCE_BRANCH}`)).body as { object: { sha: string } }).object.sha;
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'access') return null;
      throw e;
    }
  }

  /** Whether the branch moved from `commit` since it was read (then the change is built again), up to REPLACE_ATTEMPTS. */
  private async moved(commit: string | null, attempt: number): Promise<boolean> {
    if (await this.evidenceRef() === commit) return false;
    if (attempt >= REPLACE_ATTEMPTS) throw new BoardError('unreachable', `the board's ${EVIDENCE_BRANCH} branch kept changing while Ledung changed it`);
    return true;
  }

  /**
   * Replaces the evidence branch with one commit without parents holding its tree changed by `entries`
   * (sha null: removed), so the branch never has history: a pruned file is in no branch's history, only in
   * unreachable objects until GitHub collects them (and GitHub's activity view may still name the old
   * commits meanwhile). GitHub's force-update has no compare-and-swap, so a replace built on a head another
   * Ledung has replaced since would undo that change, bringing back a file it pruned (review I1): the
   * branch is read again just before the update, and the change is built again on the new head if it moved.
   * What is left is the moment between that read and the update.
   */
  private async replaceEvidence(entries: { path: string; sha: string | null }[], message: string): Promise<void> {
    const refPath = `/repos/${this.repo}/git/refs/heads/${EVIDENCE_BRANCH}`;
    for (let attempt = 1; ; attempt++) {
      const head = await this.evidenceHead();
      let changes = entries;
      if (entries.some((e) => e.sha === null)) {
        if (!head) return;
        const { body } = await this.call('GET', `/repos/${this.repo}/git/trees/${head.tree}?recursive=1`);
        const blobs = new Set((body as { tree: { path: string; type: string }[] }).tree.filter((t) => t.type === 'blob').map((t) => t.path));
        // Removing a path that isn't there is refused by GitHub; it is gone already.
        changes = entries.filter((e) => e.sha !== null || blobs.has(e.path));
        const left = [...blobs].filter((p) => !changes.some((e) => e.path === p && e.sha === null));
        if (!left.length && changes.every((e) => e.sha === null)) {
          if (await this.moved(head.commit, attempt)) continue;
          await this.call('DELETE', refPath);
          return;
        }
        if (!changes.length) return;
      }
      const tree = (await this.call('POST', `/repos/${this.repo}/git/trees`, {
        ...(head ? { base_tree: head.tree } : {}), tree: changes.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
      })).body as { sha: string };
      const commit = (await this.call('POST', `/repos/${this.repo}/git/commits`, { message, tree: tree.sha, parents: [] })).body as { sha: string };
      if (await this.moved(head?.commit ?? null, attempt)) continue;
      if (head) await this.call('PATCH', refPath, { sha: commit.sha, force: true });
      else await this.call('POST', `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: commit.sha });
      return;
    }
  }

  /**
   * GitHub's Git data calls refuse an empty repository (a board repo used only for issues is one), so it
   * gets a README on its default branch first, once: nothing about any post, only what the repo is for.
   */
  private async initRepo(): Promise<void> {
    const readme = '# Ledung message board\n\nThreads are the issues. Evidence files of posts are on the `ledung-evidence` branch, which Ledung replaces on every change.\n';
    await this.call('PUT', `/repos/${this.repo}/contents/README.md`, { message: 'Ledung message board', content: Buffer.from(readme).toString('base64') });
  }

  async putFiles(files: { path: string; bytes: Buffer }[], message: string): Promise<void> {
    if (!files.length) return;
    const blob = (bytes: Buffer) => this.call('POST', `/repos/${this.repo}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' });
    let first: string;
    try {
      first = ((await blob(files[0]!.bytes)).body as { sha: string }).sha;
    } catch (e) {
      if (!(e instanceof BoardError) || !/empty/i.test(e.message)) throw e;
      await this.initRepo();
      first = ((await blob(files[0]!.bytes)).body as { sha: string }).sha;
    }
    const entries = [{ path: files[0]!.path, sha: first }];
    for (const f of files.slice(1)) entries.push({ path: f.path, sha: ((await blob(f.bytes)).body as { sha: string }).sha });
    await this.replaceEvidence(entries, message);
  }

  async getFile(path: string): Promise<Buffer> {
    const url = `/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${EVIDENCE_BRANCH}`;
    let body: unknown;
    try {
      body = (await this.call('GET', url, undefined, false, RAW)).body;
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'access') throw new BoardError('access', 'it is not on the board (pruned, or never uploaded)');
      throw e;
    }
    if (!Buffer.isBuffer(body)) throw new BoardError('unreachable', `GitHub did not send the file ${path}.`);
    return body;
  }

  async deleteFiles(paths: string[], message: string): Promise<void> {
    if (paths.length) await this.replaceEvidence(paths.map((path) => ({ path, sha: null })), message);
  }

  /**
   * People for the allowlist picker (decision 5): the repo's collaborators with name and picture (needs
   * write access), else the organisation's members, else none (type logins).
   */
  async people(): Promise<BoardPeople> {
    const owner = this.repo.split('/')[0]!;
    const withNames = async (users: GhUser[]) => Promise.all(users.slice(0, 100).map(async (u) => {
      let name: string | null = null;
      try {
        name = ((await this.call('GET', `/users/${encodeURIComponent(u.login)}`)).body as GhUser).name ?? null;
      } catch { /* a name is a nicety */ }
      return { id: u.login, name, avatarUrl: u.avatar_url ?? null };
    }));
    try {
      const { items } = await this.list<GhUser>(`/repos/${this.repo}/collaborators?per_page=100`);
      return { source: 'collaborators', people: await withNames(items), note: null };
    } catch (e) {
      if (!(e instanceof BoardError) || e.kind !== 'access') throw e;
    }
    try {
      const { items } = await this.list<GhUser>(`/orgs/${encodeURIComponent(owner)}/members?per_page=100`);
      return { source: 'members', people: await withNames(items), note: `Listing the board's collaborators needs write access to ${this.repo}; these are the organisation's members instead, and some may not see the board.` };
    } catch (e) {
      if (!(e instanceof BoardError) || e.kind !== 'access') throw e;
    }
    return { source: 'none', people: [], note: `This GitHub login can list neither ${this.repo}'s collaborators nor ${owner}'s members; type logins instead.` };
  }
}
