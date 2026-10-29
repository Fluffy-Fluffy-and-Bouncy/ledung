// A board in memory, for tests: the core's behaviour without any service. Several FakeBackends can share
// one FakeBoard to stand for several Ledungs (each with its own login) on one board.
import { readHeader, withHeader } from './address.ts';
import { BoardError, type BoardAuthor, type BoardBackend, type BoardPeople, type IncomingPost, type OutgoingPost, type PollResult } from './types.ts';

interface FakePost { seq: number; postId: string; threadId: string; author: string; body: string; at: number }

export class FakeBoard {
  posts: FakePost[] = [];
  titles = new Map<string, string>();
  private seq = 0;
  private threads = 0;
  /** Set to make every call fail with it, e.g. new BoardError('unreachable', 'down'). */
  failWith: BoardError | null = null;
  /** The board's files (attachments), by path. */
  files = new Map<string, Buffer>();
  /** Threads closed on the board. */
  closed = new Set<string>();

  /** A post as the service stores it; body as typed (with or without Ledung's header). */
  add(author: string, threadId: string | null, body: string, title?: string, at = Date.now()): { postId: string; threadId: string } {
    const thread = threadId ?? String(++this.threads);
    if (!threadId) this.titles.set(thread, title ?? `Thread ${thread}`);
    const seq = ++this.seq;
    const postId = threadId ? `comment:${seq}` : `issue:${thread}`;
    this.posts.push({ seq, postId, threadId: thread, author, body, at });
    return { postId, threadId: thread };
  }

  incoming(p: FakePost): IncomingPost {
    const h = readHeader(p.body);
    return {
      postId: p.postId, threadId: p.threadId, title: this.titles.get(p.threadId), author: { id: p.author, display: p.author },
      to: h.to, fromProject: h.fromProject, text: h.text, at: p.at, viaLedung: h.viaLedung, attachments: h.attachments,
    };
  }
}

export class FakeBackend implements BoardBackend {
  readonly id = 'fake';
  readonly label = 'the fake board';
  readonly board: FakeBoard;
  readonly login: string | null;
  pollMs = 5000;
  sent: OutgoingPost[] = [];
  people?: () => Promise<BoardPeople>;

  constructor(board: FakeBoard, login: string | null) {
    this.board = board;
    this.login = login;
  }

  url(threadId: string, postId?: string): string | null {
    return `https://fake.invalid/threads/${encodeURIComponent(threadId)}${postId ? `#${encodeURIComponent(postId)}` : ''}`;
  }

  private check(): void {
    if (this.board.failWith) throw this.board.failWith;
  }

  async identity(): Promise<BoardAuthor> {
    this.check();
    if (!this.login) throw new BoardError('signin', 'Board off: sign in first.');
    return { id: this.login, display: this.login };
  }

  async send(post: OutgoingPost): Promise<{ postId: string; threadId: string; at: number }> {
    this.check();
    this.sent.push(post);
    const at = Date.now();
    return { ...this.board.add(this.login!, post.threadId, withHeader(post.to, post.fromProject, post.text, post.attachments), post.title, at), at };
  }

  /** The cursor is the last sequence number seen. */
  async poll(cursor: string | null): Promise<PollResult> {
    this.check();
    const from = Number(cursor ?? 0);
    const posts = this.board.posts.filter((p) => p.seq > from);
    return { posts: posts.map((p) => this.board.incoming(p)), cursor: String(Math.max(from, ...posts.map((p) => p.seq))), nextPollMs: this.pollMs, closed: [...this.board.closed] };
  }

  async readThread(threadId: string, last: number): Promise<{ title: string; posts: IncomingPost[] }> {
    this.check();
    const posts = this.board.posts.filter((p) => p.threadId === threadId).slice(-last);
    if (!posts.length) throw new BoardError('access', `No thread ${threadId}.`);
    return { title: this.board.titles.get(threadId) ?? `Thread ${threadId}`, posts: posts.map((p) => this.board.incoming(p)) };
  }

  async putFiles(files: { path: string; bytes: Buffer }[]): Promise<void> {
    this.check();
    for (const f of files) this.board.files.set(f.path, Buffer.from(f.bytes));
  }

  async getFile(path: string): Promise<Buffer> {
    this.check();
    const f = this.board.files.get(path);
    if (!f) throw new BoardError('access', `No file ${path}.`);
    return f;
  }

  async deleteFiles(paths: string[]): Promise<void> {
    this.check();
    for (const p of paths) this.board.files.delete(p);
  }
}
