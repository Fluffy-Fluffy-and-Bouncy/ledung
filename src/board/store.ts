// The board's part of Ledung's database (migrations 23 and 26): each project's board setting (its repo
// and allowlist, "Per project" in docs/steps/message-board.md), each repo's front desk and cursor, and per
// repo the threads, posts seen and sent, deliveries to projects and posts waiting for the user's answer;
// logins the user allowed posting to are per Ledung.
import type { DatabaseSync } from 'node:sqlite';
import type { AttachmentKind } from './attachments.ts';

export type PostStatus =
  /** Reached at least one manager's inbox. */
  | 'delivered'
  /** For this Ledung but nobody's inbox: a channel, a project with the board off, no front desk, a sender that project doesn't allow. */
  | 'quiet'
  /** Not for this Ledung. */
  | 'other'
  /** From a login no project on the repo allows: only the id is kept, never the text (trust rule 2). */
  | 'ignored'
  /** Sent by this Ledung. */
  | 'sent';

export interface StoredPost {
  id: string;
  threadId: string;
  author: string;
  viaLedung: boolean;
  fromProject: string | null;
  recipients: string[];
  text: string;
  at: number;
  receivedAt: number;
  direction: 'in' | 'out';
  status: PostStatus;
}

export interface StoredThread {
  id: string;
  title: string;
  /** Everyone who wrote or was addressed, as addresses ("@login", "@login/Project", "#channel"). */
  participants: string[];
  createdAt: number;
  updatedAt: number;
}

/** ignored: addressed to the project, from a sender its allowlist doesn't name; never in its inbox. */
export type DeliveryKind = 'wake' | 'quiet' | 'channel' | 'ignored';

/** The post id under which an upload is recorded until its post is known to have gone (or the files are gone). */
export const unsentId = (repoPath: string): string => `unsent-${repoPath}`;

export interface OutboxItem {
  id: number;
  board: string;
  project: string;
  managerId: string;
  threadId: string | null;
  title: string | null;
  recipients: string[];
  text: string;
  questionId: number | null;
  status: 'waiting' | 'sent' | 'refused' | 'failed';
  createdAt: number;
  /**
   * Files the manager attached: as found in its folder, their kind and SHA-256, and the copy of the bytes
   * the user is shown (in the board cache), which is what is sent (PR #131 review: the approval bound to the bytes shown: not the live file).
   */
  attachments: OutboxFile[];
}

export interface OutboxFile {
  file: string;
  sha: string;
  kind?: AttachmentKind;
  /** In the repo's board cache folder ("outbox/<key>-<n>.<ext>"); none: held before snapshots, not sendable. */
  snapshot?: string;
}

/** A post's attachment as this Ledung keeps it (board attachments). */
export interface StoredAttachment {
  postId: string;
  threadId: string;
  /** In the board repo. */
  repoPath: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  sha: string;
  direction: 'in' | 'out';
  /** In the board cache, relative to the repo's cache folder ("<thread>/<file>"); null: not there. */
  cacheFile: string | null;
  /** Why it could not be fetched. */
  error: string | null;
  at: number;
  prunedAt: number | null;
}

/** A project's board setting (docs/steps/message-board.md, "Per project"). */
export interface ProjectBoardSetting {
  enabled: boolean;
  /** "owner/name" of its board repo; null: none chosen. */
  repo: string | null;
  /** Logins whose posts may reach this project's manager. */
  allow: string[];
  channels: string[];
}

/** A thread as the page's Board view lists it (RepoStore.threadSummaries). */
export interface ThreadSummaryRow {
  thread: StoredThread;
  /** No thread row: only posts Ledung dropped made it known. */
  orphan: boolean;
  posts: number;
  /** Posts dropped because no project here allows their sender (no text kept). */
  dropped: number;
  /** Posts for this Ledung that reached nobody's inbox. */
  unsent: number;
  /** The last post that has text. */
  last: StoredPost | null;
  /** Per project and kind ('sent': the project posted in the thread): posts, and whether those are unread. */
  deliveries: { project: string; kind: DeliveryKind | 'sent'; unread: boolean; count: number }[];
}

const post = (r: Record<string, any>): StoredPost => ({
  id: r.id, threadId: r.thread_id, author: r.author, viaLedung: !!r.via_ledung, fromProject: r.from_project ?? null,
  recipients: JSON.parse(r.recipients), text: r.text, at: Number(r.at), receivedAt: Number(r.received_at), direction: r.direction, status: r.status,
});
const thread = (r: Record<string, any>): StoredThread => ({
  id: r.id, title: r.title, participants: JSON.parse(r.participants), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
const outbox = (r: Record<string, any>): OutboxItem => ({
  id: Number(r.id), board: r.board, project: r.project, managerId: r.manager_id, threadId: r.thread_id ?? null, title: r.title ?? null,
  recipients: JSON.parse(r.recipients), text: r.text, questionId: r.question_id == null ? null : Number(r.question_id), status: r.status, createdAt: Number(r.created_at),
  attachments: r.attachments ? JSON.parse(r.attachments) : [],
});
const attachment = (r: Record<string, any>): StoredAttachment => ({
  postId: r.post_id, threadId: r.thread_id, repoPath: r.repo_path, name: r.name, kind: r.kind, size: Number(r.size), sha: r.sha, direction: r.direction,
  cacheFile: r.cache_file ?? null, error: r.error ?? null, at: Number(r.at), prunedAt: r.pruned_at == null ? null : Number(r.pruned_at),
});

/** What is the same for every repo: the projects' settings, the repos' front desks, approved contacts. */
export class BoardStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** One repo's threads and posts. */
  repo(name: string): RepoStore {
    return new RepoStore(this.db, name);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  projectSetting(name: string): ProjectBoardSetting {
    const r = this.db.prepare('SELECT * FROM board_projects WHERE name = ?').get(name) as Record<string, any> | undefined;
    return r
      ? { enabled: !!r.enabled, repo: r.repo ?? null, allow: r.allow ? JSON.parse(r.allow) : [], channels: JSON.parse(r.channels) }
      : { enabled: false, repo: null, allow: [], channels: [] };
  }

  setProjectSetting(name: string, s: ProjectBoardSetting): void {
    this.db.prepare(`INSERT INTO board_projects (name, enabled, channels, repo, allow) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET
      enabled = excluded.enabled, channels = excluded.channels, repo = excluded.repo, allow = excluded.allow`)
      .run(name, s.enabled ? 1 : 0, JSON.stringify(s.channels), s.repo, JSON.stringify(s.allow));
  }

  frontDesk(repo: string): string | null {
    const r = this.db.prepare('SELECT front_desk FROM board_boards WHERE repo = ?').get(repo) as { front_desk: string | null } | undefined;
    return r?.front_desk || null;
  }

  setFrontDesk(repo: string, project: string | null): void {
    this.db.prepare('INSERT INTO board_boards (repo, front_desk) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET front_desk = excluded.front_desk').run(repo, project);
  }

  contactApproved(login: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM board_contacts WHERE lower(login) = lower(?)').get(login);
  }

  approveContact(login: string, questionId: number | null, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO board_contacts (login, approved_at, question_id) VALUES (?, ?, ?)').run(login.toLowerCase(), at, questionId);
  }

  /** Posts a project sent since a time, on any repo (the cap is the manager's, decision 7). */
  sentSince(project: string, since: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM board_posts WHERE direction = 'out' AND from_project = ? AND received_at >= ?`).get(project, since) as { n: number };
    return Number(r.n);
  }

  outboxByQuestion(questionId: number): OutboxItem | undefined {
    const r = this.db.prepare('SELECT * FROM board_outbox WHERE question_id = ?').get(questionId) as Record<string, any> | undefined;
    return r ? outbox(r) : undefined;
  }

  /** Rows from before boards were per project (board '') become the old config block's repo; their cursor too. */
  adoptLegacy(repo: string, cursor: string | null): void {
    for (const table of ['board_threads', 'board_posts', 'board_deliveries', 'board_outbox']) {
      this.db.prepare(`UPDATE ${table} SET board = ? WHERE board = ''`).run(repo);
    }
    if (cursor !== null) this.db.prepare('INSERT INTO board_boards (repo, cursor) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET cursor = excluded.cursor').run(repo, cursor);
  }
}

/** One repo's part: its threads, posts, deliveries, held posts and cursor. */
export class RepoStore {
  private readonly db: DatabaseSync;
  readonly board: string;

  constructor(db: DatabaseSync, board: string) {
    this.db = db;
    this.board = board;
  }

  cursor(): string | null {
    const r = this.db.prepare('SELECT cursor FROM board_boards WHERE repo = ?').get(this.board) as { cursor: string | null } | undefined;
    return r?.cursor ?? null;
  }

  setCursor(cursor: string | null): void {
    this.db.prepare('INSERT INTO board_boards (repo, cursor) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET cursor = excluded.cursor').run(this.board, cursor);
  }

  hasPost(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM board_posts WHERE board = ? AND id = ?').get(this.board, id);
  }

  addPost(p: StoredPost): void {
    this.db.prepare(`INSERT OR IGNORE INTO board_posts (board, id, thread_id, author, via_ledung, from_project, recipients, text, at, received_at, direction, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.board, p.id, p.threadId, p.author, p.viaLedung ? 1 : 0, p.fromProject, JSON.stringify(p.recipients), p.text, p.at, p.receivedAt, p.direction, p.status);
  }

  setPostStatus(id: string, status: PostStatus): void {
    this.db.prepare('UPDATE board_posts SET status = ? WHERE board = ? AND id = ?').run(status, this.board, id);
  }

  /**
   * The last posts of a thread, oldest first, that a project may see: this Ledung's own and those from
   * logins on its allowlist ("Per project": B never reads a sender only A allows). Ignored ones never.
   */
  threadPosts(threadId: string, last: number, allow: string[]): StoredPost[] {
    const rows = this.db.prepare(`SELECT * FROM board_posts WHERE board = ? AND thread_id = ? AND status != 'ignored'
      AND (direction = 'out' OR lower(author) IN (SELECT lower(value) FROM json_each(?))) ORDER BY at DESC, received_at DESC LIMIT ?`)
      .all(this.board, threadId, JSON.stringify(allow), last) as Record<string, any>[];
    return rows.map(post).reverse();
  }

  getThread(id: string): StoredThread | undefined {
    const r = this.db.prepare('SELECT * FROM board_threads WHERE board = ? AND id = ?').get(this.board, id) as Record<string, any> | undefined;
    return r ? thread(r) : undefined;
  }

  /** Creates or updates a thread; participants are added, never removed. */
  touchThread(id: string, title: string | undefined, add: string[], at: number): StoredThread {
    const old = this.getThread(id);
    const participants = [...(old?.participants ?? [])];
    for (const a of add) if (!participants.some((p) => p.toLowerCase() === a.toLowerCase())) participants.push(a);
    if (old) {
      this.db.prepare('UPDATE board_threads SET title = ?, participants = ?, updated_at = ? WHERE board = ? AND id = ?')
        .run(title ?? old.title, JSON.stringify(participants), Math.max(old.updatedAt, at), this.board, id);
    } else {
      this.db.prepare('INSERT INTO board_threads (board, id, title, participants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.board, id, title ?? `Thread ${id}`, JSON.stringify(participants), at, at);
    }
    return this.getThread(id)!;
  }

  /** Recent threads with at least one post the project may see (threadPosts' rule), or one delivered to it. */
  recentThreads(limit: number, project: string, allow: string[]): StoredThread[] {
    return (this.db.prepare(`SELECT * FROM board_threads t WHERE t.board = ? AND (
        EXISTS (SELECT 1 FROM board_posts p WHERE p.board = t.board AND p.thread_id = t.id AND p.status != 'ignored'
          AND (p.direction = 'out' OR lower(p.author) IN (SELECT lower(value) FROM json_each(?))))
        OR EXISTS (SELECT 1 FROM board_deliveries d JOIN board_posts p ON p.board = d.board AND p.id = d.post_id
          WHERE d.board = t.board AND d.project = ? AND d.kind != 'ignored' AND p.thread_id = t.id))
      ORDER BY t.updated_at DESC LIMIT ?`).all(this.board, JSON.stringify(allow), project, limit) as Record<string, any>[]).map(thread);
  }

  addDelivery(postId: string, project: string, kind: DeliveryKind, at: number, read: boolean): void {
    this.db.prepare('INSERT OR IGNORE INTO board_deliveries (board, post_id, project, kind, at, read_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.board, postId, project, kind, at, read ? at : null);
  }

  /** Wakes a project's manager had for a thread since a time (the per-thread cap). */
  wakesSince(project: string, threadId: string, since: number): number {
    const r = this.db.prepare(`SELECT COUNT(DISTINCT d.at) AS n FROM board_deliveries d JOIN board_posts p ON p.board = d.board AND p.id = d.post_id
      WHERE d.board = ? AND d.project = ? AND d.kind = 'wake' AND p.thread_id = ? AND d.at >= ?`).get(this.board, project, threadId, since) as { n: number };
    return Number(r.n);
  }

  /** Unread posts for a project, by thread: channel posts it follows and anything not yet read. */
  unread(project: string): { threadId: string; count: number }[] {
    return (this.db.prepare(`SELECT p.thread_id AS thread_id, COUNT(*) AS n FROM board_deliveries d JOIN board_posts p ON p.board = d.board AND p.id = d.post_id
      WHERE d.board = ? AND d.project = ? AND d.read_at IS NULL GROUP BY p.thread_id`).all(this.board, project) as Record<string, any>[])
      .map((r) => ({ threadId: r.thread_id, count: Number(r.n) }));
  }

  markRead(project: string, threadId: string, at: number): void {
    this.db.prepare(`UPDATE board_deliveries SET read_at = ? WHERE board = ? AND project = ? AND read_at IS NULL
      AND post_id IN (SELECT id FROM board_posts WHERE board = ? AND thread_id = ?)`).run(at, this.board, project, this.board, threadId);
  }

  /** Threads a project took part in: delivered to it, or posted by it. */
  projectThreads(project: string): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT p.thread_id AS t FROM board_posts p LEFT JOIN board_deliveries d ON d.board = p.board AND d.post_id = p.id
      WHERE p.board = ? AND ((d.project = ? AND d.kind != 'ignored') OR (p.direction = 'out' AND p.from_project = ?))`).all(this.board, project, project) as { t: string }[];
    return new Set(rows.map((r) => r.t));
  }

  /** Posts dropped because no project on this repo allows their sender, per login. */
  ignored(): { login: string; count: number; lastAt: number }[] {
    return (this.db.prepare(`SELECT author, COUNT(*) AS n, MAX(received_at) AS last FROM board_posts WHERE board = ? AND status = 'ignored' GROUP BY lower(author) ORDER BY last DESC`)
      .all(this.board) as Record<string, any>[]).map((r) => ({ login: r.author, count: Number(r.n), lastAt: Number(r.last) }));
  }

  /** Posts addressed to a project whose sender its allowlist doesn't name, per login. */
  ignoredFor(project: string): { login: string; count: number; lastAt: number }[] {
    return (this.db.prepare(`SELECT p.author AS author, COUNT(*) AS n, MAX(d.at) AS last FROM board_deliveries d JOIN board_posts p ON p.board = d.board AND p.id = d.post_id
      WHERE d.board = ? AND d.project = ? AND d.kind = 'ignored' GROUP BY lower(p.author) ORDER BY last DESC`)
      .all(this.board, project) as Record<string, any>[]).map((r) => ({ login: r.author, count: Number(r.n), lastAt: Number(r.last) }));
  }

  /** Posts for this Ledung that reached nobody's inbox (no front desk, board off), since a time. */
  quietCount(since: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM board_posts p WHERE p.board = ? AND p.status = 'quiet' AND p.received_at >= ?
      AND NOT EXISTS (SELECT 1 FROM board_deliveries d WHERE d.board = p.board AND d.post_id = p.id)`).get(this.board, since) as { n: number };
    return Number(r.n);
  }

  // --- the page's Board view: read-only, and not narrowed by an allowlist (the owner of this Ledung looks) ---

  /** Threads of this repo, newest activity first: the stored ones, and ones known only from dropped posts. */
  threadSummaries(limit: number): ThreadSummaryRow[] {
    const b = this.board;
    const rows = new Map<string, ThreadSummaryRow>();
    const blank = (t: StoredThread, orphan: boolean): ThreadSummaryRow => ({ thread: t, orphan, posts: 0, dropped: 0, unsent: 0, last: null, deliveries: [] });
    for (const t of this.db.prepare('SELECT * FROM board_threads WHERE board = ? ORDER BY updated_at DESC LIMIT ?').all(b, limit) as Record<string, any>[]) {
      rows.set(t.id, blank(thread(t), false));
    }
    for (const o of this.db.prepare(`SELECT thread_id AS id, MAX(at) AS last FROM board_posts p WHERE board = ?
      AND NOT EXISTS (SELECT 1 FROM board_threads t WHERE t.board = p.board AND t.id = p.thread_id) GROUP BY thread_id ORDER BY last DESC LIMIT ?`).all(b, limit) as Record<string, any>[]) {
      rows.set(o.id, blank({ id: o.id, title: `Thread ${o.id}`, participants: [], createdAt: Number(o.last), updatedAt: Number(o.last) }, true));
    }
    for (const r of this.db.prepare(`SELECT thread_id, COUNT(*) AS n, SUM(status = 'ignored') AS dropped,
        SUM(status = 'quiet' AND NOT EXISTS (SELECT 1 FROM board_deliveries d WHERE d.board = p.board AND d.post_id = p.id)) AS unsent
      FROM board_posts p WHERE board = ? GROUP BY thread_id`).all(b) as Record<string, any>[]) {
      const row = rows.get(r.thread_id);
      if (row) Object.assign(row, { posts: Number(r.n), dropped: Number(r.dropped), unsent: Number(r.unsent) });
    }
    for (const r of this.db.prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY at DESC, received_at DESC) AS rn
      FROM board_posts WHERE board = ? AND status != 'ignored') WHERE rn = 1`).all(b) as Record<string, any>[]) {
      const row = rows.get(r.thread_id);
      if (row) row.last = post(r);
    }
    for (const r of this.db.prepare(`SELECT p.thread_id AS thread_id, d.project AS project, d.kind AS kind, d.read_at IS NULL AS unread, COUNT(*) AS n
      FROM board_deliveries d JOIN board_posts p ON p.board = d.board AND p.id = d.post_id WHERE d.board = ? GROUP BY p.thread_id, d.project, d.kind, unread`).all(b) as Record<string, any>[]) {
      rows.get(r.thread_id)?.deliveries.push({ project: r.project, kind: r.kind, unread: !!r.unread, count: Number(r.n) });
    }
    for (const r of this.db.prepare(`SELECT thread_id, from_project, COUNT(*) AS n FROM board_posts WHERE board = ? AND direction = 'out' AND from_project IS NOT NULL
      GROUP BY thread_id, from_project`).all(b) as Record<string, any>[]) {
      rows.get(r.thread_id)?.deliveries.push({ project: r.from_project, kind: 'sent', unread: false, count: Number(r.n) });
    }
    return [...rows.values()].sort((x, y) => y.thread.updatedAt - x.thread.updatedAt).slice(0, limit);
  }

  /** One thread's last posts, oldest first, each with where it was delivered; a dropped post has no text. */
  threadView(threadId: string, last: number): { thread: StoredThread | undefined; posts: { post: StoredPost; deliveries: { project: string; kind: DeliveryKind; read: boolean }[] }[] } {
    const posts = (this.db.prepare('SELECT * FROM board_posts WHERE board = ? AND thread_id = ? ORDER BY at DESC, received_at DESC LIMIT ?')
      .all(this.board, threadId, last) as Record<string, any>[]).map(post).reverse();
    const byPost = new Map<string, { project: string; kind: DeliveryKind; read: boolean }[]>();
    for (const r of this.db.prepare(`SELECT d.post_id AS post_id, d.project AS project, d.kind AS kind, d.read_at IS NOT NULL AS read
      FROM board_deliveries d JOIN board_posts p ON p.board = d.board AND p.id = d.post_id WHERE d.board = ? AND p.thread_id = ? ORDER BY d.at`).all(this.board, threadId) as Record<string, any>[]) {
      byPost.set(r.post_id, [...(byPost.get(r.post_id) ?? []), { project: r.project, kind: r.kind, read: !!r.read }]);
    }
    return { thread: this.getThread(threadId), posts: posts.map((p) => ({ post: p, deliveries: byPost.get(p.id) ?? [] })) };
  }

  addOutbox(o: Omit<OutboxItem, 'id' | 'status' | 'questionId' | 'board'>): number {
    const r = this.db.prepare(`INSERT INTO board_outbox (board, project, manager_id, thread_id, title, recipients, text, status, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`)
      .run(this.board, o.project, o.managerId, o.threadId, o.title, JSON.stringify(o.recipients), o.text, o.createdAt, o.attachments.length ? JSON.stringify(o.attachments) : null);
    return Number(r.lastInsertRowid);
  }

  setOutboxQuestion(id: number, questionId: number): void {
    this.db.prepare('UPDATE board_outbox SET question_id = ? WHERE id = ?').run(questionId, id);
  }

  setOutboxStatus(id: number, status: OutboxItem['status']): void {
    this.db.prepare('UPDATE board_outbox SET status = ? WHERE id = ?').run(status, id);
  }

  /** Every held post of this board, whatever its state (the prune drops the copies of ones no longer waiting). */
  outboxItems(): OutboxItem[] {
    return (this.db.prepare('SELECT * FROM board_outbox WHERE board = ?').all(this.board) as Record<string, any>[]).map(outbox);
  }

  // --- attachments (board attachments) ---------------------------------------------------------------

  addAttachment(a: StoredAttachment): void {
    this.db.prepare(`INSERT OR IGNORE INTO board_attachments (board, post_id, thread_id, repo_path, name, kind, size, sha, direction, cache_file, error, at, pruned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.board, a.postId, a.threadId, a.repoPath, a.name, a.kind, a.size, a.sha, a.direction, a.cacheFile, a.error, a.at, a.prunedAt);
  }

  /** A post's attachments, in the order they were posted. */
  attachments(postId: string): StoredAttachment[] {
    return (this.db.prepare('SELECT * FROM board_attachments WHERE board = ? AND post_id = ? ORDER BY rowid').all(this.board, postId) as Record<string, any>[]).map(attachment);
  }

  /** The attachments still kept whose thread is closed, or that are older than a time. */
  prunable(closedThreads: string[], before: number): StoredAttachment[] {
    return (this.db.prepare(`SELECT * FROM board_attachments WHERE board = ? AND pruned_at IS NULL
      AND (thread_id IN (SELECT value FROM json_each(?)) OR at < ?) ORDER BY rowid`).all(this.board, JSON.stringify(closedThreads), before) as Record<string, any>[]).map(attachment);
  }

  /** A cached file with this SHA-256 not pruned, so the same content isn't downloaded again. */
  cachedBySha(sha: string): string | null {
    const r = this.db.prepare('SELECT cache_file FROM board_attachments WHERE board = ? AND sha = ? AND cache_file IS NOT NULL AND pruned_at IS NULL LIMIT 1').get(this.board, sha) as { cache_file: string } | undefined;
    return r?.cache_file ?? null;
  }

  /** Is a cached file still used by an attachment not pruned? */
  cacheFileInUse(cacheFile: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM board_attachments WHERE board = ? AND cache_file = ? AND pruned_at IS NULL').get(this.board, cacheFile);
  }

  /** Does an attachment not pruned still name this file in the board repo (the same content posted again)? */
  repoPathInUse(repoPath: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM board_attachments WHERE board = ? AND repo_path = ? AND pruned_at IS NULL').get(this.board, repoPath);
  }

  /** Forgets the "not sent" records of uploads that turned out fine (the post went), or were taken off again. */
  forgetUnsent(repoPaths: string[]): void {
    const del = this.db.prepare(`DELETE FROM board_attachments WHERE board = ? AND post_id = ? AND error = 'not sent'`);
    for (const p of repoPaths) del.run(this.board, unsentId(p));
  }

  setPruned(postId: string, repoPath: string, at: number): void {
    this.db.prepare('UPDATE board_attachments SET pruned_at = ? WHERE board = ? AND post_id = ? AND repo_path = ?').run(at, this.board, postId, repoPath);
  }
}
