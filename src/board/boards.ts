// The boards of this Ledung (docs/steps/message-board.md, "Per project", 2026-10-14): each project names
// its own board repo and allowlist; several projects may share a repo. One Board per repo a project names,
// polled only while some project there has the board on, so a shared repo is polled once. The page's
// settings and the managers' tools come here and go to the project's board.
import { BOARD_REPO, type BoardConfig } from '../config.ts';
import type { BoardOwnersView, BoardRepoChoicesView, BoardStatus, BoardThreadsView, BoardThreadView, ProjectBoardView, QuestionInfo } from '../shared/protocol.ts';
import { formatAddress, parseAddress, sameLogin } from './address.ts';
import { BOARD_FILE_PREFIX, parseBoardFile, readCachedImage, readEvidence, repoCacheDir, type AttachmentKind } from './attachments.ts';
import { FileError, type ProjectImage } from '../sessions/files.ts';
import { Board, type BoardContext, type PostArgs } from './board.ts';
import type { RepoDirectory } from './repos.ts';
import type { BoardStore, ProjectBoardSetting } from './store.ts';
import { BoardError, type BoardBackend, type BoardPeople } from './types.ts';

/** A cached attachment of a received post, as cacheFile names it: <thread>/<post>-<n>.<ext>. */
const CACHED_POST_FILE = /^(?!outbox\/)[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9-]{1,60}-[1-5]\.(png|jpg|txt)$/;

export interface BoardsContext extends Omit<BoardContext, 'repo' | 'store' | 'settings' | 'backend' | 'publish'> {
  store: BoardStore;
  /** A backend for a repo (GitHub in Ledung, a fake board in tests). */
  backendFor(repo: string): BoardBackend;
  publish(status: BoardStatus): void;
  /** The GitHub repos the picker offers, and the create call; none: the picker offers only typing. */
  directory?: RepoDirectory;
}

/** What the page sends for a project ("Per project"): the whole setting at once, so "copy from" is a filled-in form. */
export interface ProjectBoardInput {
  enabled: boolean;
  repo: string | null;
  allow: string[];
  channels: string[];
  /** true: this project gets posts to just "@me" on its repo; false: it gives that up. */
  frontDesk: boolean;
}

/** Done once per old repo, so a later change in the page is never overwritten. */
const LEGACY_MOVED = 'board-legacy-moved:';
/** The Board view lists this many threads, and shows this many posts of one. */
const THREAD_LIST_MAX = 300;
const THREAD_POSTS_MAX = 200;

export class Boards {
  private readonly ctx: BoardsContext;
  private readonly boards = new Map<string, Board>();
  private running = false;

  constructor(ctx: BoardsContext) {
    this.ctx = ctx;
    this.refresh();
  }

  private get settings(): BoardStore {
    return this.ctx.store;
  }

  /**
   * The config's board block from before boards were per project: its repo, the allowlist and front desk
   * (the page's, else the block's) go to every project that has the board on, and to the front desk; the
   * front desk becomes that repo's; posts, threads and the cursor become that repo's. Once per repo.
   */
  adoptLegacy(legacy: BoardConfig | undefined): string[] {
    const repo = legacy?.repo;
    if (!repo || this.settings.getMeta(LEGACY_MOVED + repo)) return [];
    const storedAllow = this.settings.getMeta('board-allow');
    const allow = storedAllow ? JSON.parse(storedAllow) as string[] : legacy.allow;
    const storedDesk = this.settings.getMeta('board-front-desk');
    const names = this.ctx.projectNames();
    const deskName = storedDesk !== null ? storedDesk || null : legacy.frontDesk ?? null;
    const desk = deskName && names.includes(deskName) ? deskName : null;
    const moved: string[] = [];
    for (const name of names) {
      const s = this.settings.projectSetting(name);
      if (s.repo || !(s.enabled || name === desk)) continue;
      this.settings.setProjectSetting(name, { ...s, repo, allow });
      moved.push(name);
    }
    if (desk) this.settings.setFrontDesk(repo, desk);
    this.settings.adoptLegacy(repo, this.settings.getMeta('board-cursor'));
    this.settings.setMeta(LEGACY_MOVED + repo, String(this.ctx.now?.() ?? Date.now()));
    this.refresh();
    return moved;
  }

  /** A Board for every repo a project names; polling only where some project has it on. Again after a project is removed. */
  refresh(): void {
    const repos = new Set<string>();
    for (const name of this.ctx.projectNames()) {
      const repo = this.settings.projectSetting(name).repo;
      if (repo) repos.add(repo);
    }
    for (const repo of repos) if (!this.boards.has(repo)) this.boards.set(repo, this.create(repo));
    for (const [repo, board] of this.boards) {
      if (!repos.has(repo)) {
        board.stop();
        this.boards.delete(repo);
      } else if (this.running && board.active()) board.start();
      else board.stop();
    }
  }

  private create(repo: string): Board {
    const { store, backendFor, publish, ...rest } = this.ctx;
    return new Board({ ...rest, repo, store: store.repo(repo), settings: store, backend: backendFor(repo), publish: () => this.publish() });
  }

  start(): void {
    this.running = true;
    this.refresh();
  }

  stop(): void {
    this.running = false;
    for (const b of this.boards.values()) b.stop();
  }

  /** Some project names a board repo. */
  inUse(): boolean {
    return this.boards.size > 0;
  }

  /** The repos that are polled now (one poller each, however many projects share it). */
  polled(): string[] {
    return [...this.boards.values()].filter((b) => b.polling).map((b) => b.repo);
  }

  board(repo: string): Board | undefined {
    return this.boards.get(repo);
  }

  /** The board of a project's repo, whether the project has it on or not. */
  private boardOf(project: string): Board | undefined {
    const repo = this.settings.projectSetting(project).repo;
    return repo ? this.boards.get(repo) : undefined;
  }

  /** A manager gets the board tools when its project has the board on and names a repo (decision 9). */
  availableFor(project: string): boolean {
    return !!this.boardOf(project)?.availableFor(project);
  }

  status(): BoardStatus {
    const projects: Record<string, ProjectBoardView> = {};
    const unread: Record<string, number> = {};
    for (const name of this.ctx.projectNames()) {
      const s = this.settings.projectSetting(name);
      const board = this.boardOf(name);
      projects[name] = { ...s, ignored: board?.ignoredFor(name) ?? [] };
      const n = board?.unread(name) ?? 0;
      if (n) unread[name] = n;
    }
    const boards = [...this.boards.values()].map((b) => b.status()).sort((a, b) => a.repo.localeCompare(b.repo));
    return { configured: boards.length > 0, identity: boards.find((b) => b.identity)?.identity ?? null, boards, projects, unread };
  }

  // --- the page's Board view (read-only; read state stays the managers') ---------------------------

  /** Threads of every board here, newest activity first. */
  viewThreads(): BoardThreadsView {
    const all = [...this.boards.values()].flatMap((b) => b.threadList(THREAD_LIST_MAX + 1));
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return { threads: all.slice(0, THREAD_LIST_MAX), truncated: all.length > THREAD_LIST_MAX };
  }

  viewThread(repo: string, id: string): BoardThreadView {
    const board = this.boards.get(repo);
    if (!board) throw new BoardError('access', `No project here uses the board "${repo}".`);
    return board.threadDetail(id, THREAD_POSTS_MAX);
  }

  private publish(): void {
    this.ctx.publish(this.status());
  }

  /** Saves a project's setting from the page; checks every part first, so a bad one changes nothing. */
  setProjectSetting(project: string, input: ProjectBoardInput): ProjectBoardView {
    if (!this.ctx.projectNames().includes(project)) throw new BoardError('access', `There is no project named "${project}".`);
    const repo = input.repo?.trim() || null;
    if (repo && !BOARD_REPO.test(repo)) throw new BoardError('access', `"${repo}" is not a repo: write it as owner/name.`);
    if (input.enabled && !repo) throw new BoardError('access', 'Name the board repo (owner/name) to turn the board on.');
    const allow: string[] = [];
    for (const raw of input.allow) {
      const login = raw.trim().replace(/^@/, '');
      const a = parseAddress(`@${login}`);
      if (typeof a === 'string' || a.kind !== 'person') throw new BoardError('access', `"${raw}" is not a login.`);
      if (!allow.some((c) => sameLogin(c, login))) allow.push(login);
    }
    const channels: string[] = [];
    for (const c of input.channels) {
      const a = parseAddress(c.trim().startsWith('#') ? c : `#${c.trim()}`);
      if (typeof a === 'string' || a.kind !== 'channel') throw new BoardError('access', typeof a === 'string' ? a : `"${c}" is not a channel.`);
      if (!channels.includes(formatAddress(a))) channels.push(formatAddress(a));
    }
    const before = this.settings.projectSetting(project);
    const setting: ProjectBoardSetting = { enabled: input.enabled, repo, allow, channels };
    this.settings.setProjectSetting(project, setting);
    // The front desk follows the project: leaving a repo gives up its desk there; asking for it moves it here.
    if (before.repo && before.repo !== repo && this.settings.frontDesk(before.repo) === project) this.settings.setFrontDesk(before.repo, null);
    if (repo && input.frontDesk) this.settings.setFrontDesk(repo, project);
    else if (repo && this.settings.frontDesk(repo) === project) this.settings.setFrontDesk(repo, null);
    this.refresh();
    this.publish();
    return { ...setting, ignored: this.boardOf(project)?.ignoredFor(project) ?? [] };
  }

  /** Who has access to a project's board repo, for its allowlist picker and the warning that they can all read it. */
  async people(project: string): Promise<BoardPeople & { lostAccess: string[] }> {
    if (!this.ctx.projectNames().includes(project)) throw new BoardError('access', `There is no project named "${project}".`);
    const s = this.settings.projectSetting(project);
    const board = this.boardOf(project);
    if (!board) throw new BoardError('access', `"${project}" names no board repo yet.`);
    return board.people(s.allow);
  }

  /**
   * A board attachment's image from the board cache ("board:owner/name/<thread>/<file>"), with the file
   * viewer's rules (inside that repo's cache folder, PNG or JPEG by its bytes, size); only of a board some
   * project here uses. project: also only of that project's own board (ask_user's screenshots).
   */
  attachmentImage(link: string, project?: string): ProjectImage & { file: string } {
    return this.fromCache(link, project, (cacheDir, f) => {
      const img = readCachedImage(cacheDir, f.repo, f.rel);
      return { ...img, file: `${BOARD_FILE_PREFIX}${f.repo}/${img.path}` };
    });
  }

  /**
   * A board attachment as a review's evidence (docs/steps/pr-review.md): an image or a text file, by its
   * first bytes, with attachmentImage's rules on where it may come from.
   */
  attachmentEvidence(link: string, project?: string): { file: string; kind: AttachmentKind; bytes: Buffer } {
    return this.fromCache(link, project, (cacheDir, f) => {
      // Only a received post's file (cacheFile's form), never a held post's copy in outbox/ (review finding 3).
      if (!CACHED_POST_FILE.test(f.rel)) throw new FileError('Only a file received with a board post can be evidence.');
      const ev = readEvidence(repoCacheDir(cacheDir, f.repo), f.rel);
      return { file: `${BOARD_FILE_PREFIX}${f.repo}/${ev.path}`, kind: ev.kind, bytes: ev.bytes };
    });
  }

  private fromCache<T>(link: string, project: string | undefined, read: (cacheDir: string, f: { repo: string; rel: string }) => T): T {
    const f = parseBoardFile(link);
    if (!f || !this.ctx.cacheDir) throw new BoardError('access', 'That is not a board attachment.');
    if (!this.boards.has(f.repo)) throw new BoardError('access', `No project here uses the board "${f.repo}".`);
    if (project !== undefined && this.settings.projectSetting(project).repo !== f.repo) throw new BoardError('access', `That attachment is on the board ${f.repo}, not on the board of "${project}".`);
    // A locked project, or one with its board off, is off the board for its attachments too (issue #109).
    if (project !== undefined && !this.availableFor(project)) throw new BoardError('access', `The board is off for "${project}".`);
    try {
      return read(this.ctx.cacheDir, f);
    } catch (e) {
      throw e instanceof FileError ? new BoardError('access', e.message) : e;
    }
  }

  // --- the repo picker of a project's settings (page only; no manager tool reaches these) ----------

  private directory(): RepoDirectory {
    if (!this.ctx.directory) throw new BoardError('access', 'Listing GitHub repositories is not available in this Ledung; type owner/name.');
    return this.ctx.directory;
  }

  /** Boards other projects use first (not the asking project's own, which the form shows), then what the login can reach. */
  async repoChoices(project: string, refresh: boolean): Promise<BoardRepoChoicesView> {
    const byRepo = new Map<string, string[]>();
    for (const name of this.ctx.projectNames()) {
      const repo = this.settings.projectSetting(name).repo;
      if (repo && name !== project) byRepo.set(repo, [...(byRepo.get(repo) ?? []), name]);
    }
    const used = [...byRepo].map(([repo, projects]) => ({ repo, projects })).sort((a, b) => a.repo.localeCompare(b.repo));
    try {
      const c = await this.directory().choices(refresh);
      return { used, repos: c.repos, truncated: c.truncated, error: null };
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      // The used boards and typing still work without GitHub's list.
      return { used, repos: [], truncated: false, error: e.message };
    }
  }

  async repoOwners(): Promise<BoardOwnersView> {
    return { owners: await this.directory().owners() };
  }

  /** The one GitHub write of the picker: a private repo for a board, after the user's own Confirm in the page. */
  async createRepo(owner: string, name: string, confirmed: boolean): Promise<{ repo: string; private: boolean }> {
    if (!confirmed) throw new BoardError('access', 'Creating a repository on GitHub needs your confirmation.');
    return this.directory().create(owner, name);
  }

  // --- the managers' tools, sent to the project's board -------------------------------------------

  private require(project: string): Board {
    const board = this.boardOf(project);
    if (!board || !board.availableFor(project)) throw new BoardError('access', `The board is off for "${project}"; ${this.ctx.userName} turns it on in the project's settings.`);
    return board;
  }

  async post(managerId: string, project: string, args: PostArgs): Promise<string> {
    return this.require(project).post(managerId, project, args);
  }

  async read(project: string, args: { thread?: string; last?: number }): Promise<string> {
    return this.require(project).read(project, args);
  }

  threads(project: string, all: boolean): string {
    return this.require(project).threads(project, all);
  }

  /** The user answered a question; one about a held post goes to the board it was held on. */
  async onUserAnswered(q: QuestionInfo): Promise<void> {
    const item = this.settings.outboxByQuestion(q.id);
    if (!item) return;
    const board = this.boards.get(item.board);
    if (board) return board.onUserAnswered(q, item);
    if (item.status !== 'waiting' || q.answeredBy !== 'user') return;
    // Its project has left that repo meanwhile: nothing is sent.
    this.settings.repo(item.board).setOutboxStatus(item.id, 'failed');
    this.ctx.inbox(item.managerId, 'board', `Ledung: your held board post to ${item.recipients.join(', ')} was not sent: no project here uses the board ${item.board} any more.`);
  }
}
