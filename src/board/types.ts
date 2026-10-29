// The message board between managers (docs/steps/message-board.md): what any board service gives
// Ledung. GitHub is the first; the core never knows which one runs.
import type { AttachmentRef } from './attachments.ts';

/** Who wrote a post, as the service records it: never taken from the text (trust rule 1). */
export interface BoardAuthor {
  /** The service's login, e.g. a GitHub login. */
  id: string;
  display: string;
}

export interface IncomingPost {
  /** Unique on the service, e.g. "issue:12" or "comment:9876". */
  postId: string;
  /** The thread it belongs to, e.g. a GitHub issue number. */
  threadId: string;
  /** The thread's title, when the service gave it with the post. */
  title?: string;
  author: BoardAuthor;
  /** The recipients from Ledung's header ("@login", "@login/Project", "#channel"); empty without one. */
  to: string[];
  /** The sending manager's project, from the header; a claim inside the sender's own Ledung, never a sender. */
  fromProject?: string;
  text: string;
  /** When the service says it was written (ms). */
  at: number;
  /** It carried Ledung's header; without it a person typed it on the service (decision 10). */
  viaLedung: boolean;
  /** Files in the board repo the header lists (board attachments); checked again when fetched. */
  attachments?: AttachmentRef[];
}

export interface OutgoingPost {
  /** Null: a new thread with this title. */
  threadId: string | null;
  title?: string;
  to: string[];
  fromProject: string;
  text: string;
  /** Already uploaded with putFile; listed in the header and, for people, under the text. */
  attachments?: AttachmentRef[];
}

export interface PollResult {
  posts: IncomingPost[];
  cursor: string;
  /** When to ask again; the backend slows down on a short budget. */
  nextPollMs: number;
  /** Threads the service reports closed among those it looked at (their evidence is pruned). */
  closed?: string[];
}

/** Someone who can read the board, for the allowlist picker (decision 5). */
export interface BoardPerson {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface BoardPeople {
  /** Where the list came from: the repo's collaborators (needs write access), the organisation's members, or nothing. */
  source: 'collaborators' | 'members' | 'none';
  people: BoardPerson[];
  /** Why the list is shorter than it could be, in plain words. */
  note: string | null;
}

export interface BoardBackend {
  readonly id: string;
  /** Who this Ledung posts as. Throws a BoardError when nobody is signed in. */
  identity(): Promise<BoardAuthor>;
  send(post: OutgoingPost): Promise<{ postId: string; threadId: string; at: number }>;
  /** Pull style (GitHub): what is new since the cursor, and when to ask again. */
  poll(cursor: string | null): Promise<PollResult>;
  /** Push style (Slack, Discord; later): the backend calls back. */
  subscribe?(onPost: (p: IncomingPost) => void): () => void;
  /** The last posts of a thread, oldest first. */
  readThread(threadId: string, last: number): Promise<{ title: string; posts: IncomingPost[] }>;
  people?(): Promise<BoardPeople>;
  /** Where a thread, or one post of it, can be read on the service (for the page's links); null: nowhere. */
  url?(threadId: string, postId?: string): string | null;
  /** The service's name for people ("GitHub"). */
  readonly label?: string;
  /**
   * Board attachments: files in the board's own storage (on GitHub, a branch of their own that each change
   * replaces, so no history keeps them). putFiles stores a post's files in one change; deleteFiles of files
   * that are gone is no error. Without them a board takes no attachments.
   */
  putFiles?(files: { path: string; bytes: Buffer }[], message: string): Promise<void>;
  getFile?(path: string): Promise<Buffer>;
  deleteFiles?(paths: string[], message: string): Promise<void>;
}

export type BoardErrorKind =
  /** Nobody is signed in, or the sign-in tool is missing: the board stays off until fixed. */
  | 'signin'
  /** The board does not exist or this login can't reach it. */
  | 'access'
  /** Rate limited: wait retryAfterMs. */
  | 'limited'
  /** Down, a 5xx or a network error: try again later. */
  | 'unreachable';

export class BoardError extends Error {
  readonly kind: BoardErrorKind;
  readonly retryAfterMs: number | null;
  constructor(kind: BoardErrorKind, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A post is at most this long, both ways; longer incoming posts are cut with a mark. */
export const MAX_POST_CHARS = 4000;
