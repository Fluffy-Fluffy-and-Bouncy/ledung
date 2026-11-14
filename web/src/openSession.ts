// The open session's messages (issue #231): the page tells Ledung on the live connection which session it shows, and
// Ledung sends that session's messages only. The page reads the messages from the API at once, and when Ledung's
// answer comes, once that read is done, reads what is newer than it: a message stored before the answer is in one of
// the two reads, one stored after it comes on the connection, and one that does both is shown once.
import type { PageEvent, StoredMessage } from '../../src/shared/protocol.ts';
import { fetchNewer, PAGE, withNewer } from './catchUp.ts';

/** The messages shown and the session they belong to: for one render after a switch the page still has the old ones. */
export type OpenSessionView = { sessionId: string | null; messages: StoredMessage[]; hasEarlier: boolean };

const NONE: StoredMessage[] = [];

/**
 * The view as the session `sessionId` may show it: none of another session's messages (issue #328). A chat opened from
 * another chat is drawn before its open runs; drawn with the previous chat's messages, it converted and laid them all out
 * again (0.9-1.3 s at 4x CPU) only to clear them.
 */
export function viewFor(view: OpenSessionView, sessionId: string | null): OpenSessionView {
  return view.sessionId === sessionId ? view : { sessionId, messages: NONE, hasEarlier: false };
}

export type OpenSessionDeps = {
  /** Sends a frame on the live connection. Called only between the connection's hello and its close. */
  send(text: string): void;
  /** The newest page of a session's messages, oldest first. */
  messages(sessionId: string): Promise<StoredMessage[]>;
  /** The page before `beforeId`. */
  messagesBefore(sessionId: string, beforeId: number): Promise<StoredMessage[]>;
  /** The messages after `afterId`, oldest first, a page at most. */
  messagesAfter(sessionId: string, afterId: number): Promise<StoredMessage[]>;
  /** What the page shows changed. */
  changed(view: OpenSessionView): void;
};

export const watchFrame = (sessionId: string | null): string => JSON.stringify({ type: 'watch', sessionId } satisfies PageEvent);

export class OpenSession {
  private id: string | null = null;
  private shown: StoredMessage[] = [];
  /**
   * The newest message id the page has read or caught up to since the session was opened; null: not read yet. A catch-up
   * starts here, not at the last message shown: a live one shown during the read can be newer than one stored between
   * the read and Ledung taking the watch, which only the catch-up brings. After a reconnect only what is newer is read (#178).
   */
  private upTo: number | null = null;
  /** Caught up on this connection: every message since came live, in order, so the last one shown is read up to. */
  private caughtUp = false;
  /** Watches sent on this connection and not yet answered: answers come in order, so only the last one is current. */
  private unanswered = 0;
  /** Moves on with every watch sent and every connection lost: a catch-up that started before may not claim what came since. */
  private generation = 0;
  private hasEarlier = false;
  /** The read started by the last open; the answer to a watch waits for it, then catches up from where it ended. */
  private reading: Promise<void> | null = null;
  /** The live connection has said hello and not closed: a watch can go. */
  private ready = false;
  private readonly deps: OpenSessionDeps;

  constructor(deps: OpenSessionDeps) {
    this.deps = deps;
  }

  get sessionId(): string | null {
    return this.id;
  }

  /** The page shows another session, or none. */
  open(sessionId: string | null): void {
    this.id = sessionId;
    this.shown = [];
    this.upTo = null;
    this.caughtUp = false;
    this.generation++;
    this.hasEarlier = false;
    this.emit();
    this.watch();
    // Read now, not after the answer: a connection that died without closing (#303) never answers, and the chat
    // would stay empty. The answer catches up on what came since.
    this.reading = sessionId ? this.load(sessionId).catch(() => {}) : null;
  }

  /** The live connection's hello: a new connection has not been told what the page shows. */
  connected(): void {
    this.ready = true;
    this.watch();
  }

  /** The live connection closed or was replaced; the next hello watches again. */
  disconnected(): void {
    if (this.caughtUp) this.upTo = this.shown.at(-1)?.id ?? this.upTo;
    this.caughtUp = false;
    this.ready = false;
    this.unanswered = 0;
    this.generation++;
  }

  /** Ledung's answer to a watch: from here on the session's new messages come on the connection, so read the rest now. */
  async watching(sessionId: string | null): Promise<void> {
    this.unanswered = Math.max(0, this.unanswered - 1);
    // An answer to an earlier watch (A, then B, then A again quickly): the live feed it speaks of was cut off by the
    // next watch, so only the latest answer catches up (self-check of #231).
    if (this.unanswered > 0 || sessionId === null || sessionId !== this.id) return;
    const generation = this.generation;
    await this.reading;
    if (sessionId !== this.id || generation !== this.generation) return;
    if (this.upTo === null) await this.load(sessionId);
    else {
      const newer = await fetchNewer(this.upTo, (after) => this.deps.messagesAfter(sessionId, after));
      if (this.id !== sessionId || generation !== this.generation) return;
      this.set(withNewer(this.shown, newer));
    }
    if (this.id !== sessionId || generation !== this.generation) return;
    // Everything up to here is now shown: what was stored before the answer is in a read, and what after it came live.
    this.upTo = this.shown.at(-1)?.id ?? this.upTo;
    this.caughtUp = true;
  }

  /** A message from the live connection; one of another session (sent before Ledung read a watch) is not shown. */
  message(m: StoredMessage): void {
    if (m.sessionId !== this.id || this.shown.some((x) => x.id === m.id)) return;
    this.set([...this.shown, m]);
  }

  async loadEarlier(): Promise<void> {
    const sessionId = this.id;
    const first = this.shown[0];
    if (!sessionId || !first) return;
    const list = await this.deps.messagesBefore(sessionId, first.id);
    if (this.id !== sessionId) return;
    this.hasEarlier = list.length >= PAGE;
    this.set([...list, ...this.shown]);
  }

  private async load(sessionId: string): Promise<void> {
    const list = await this.deps.messages(sessionId);
    if (this.id !== sessionId) return;
    this.upTo = list.at(-1)?.id ?? 0;
    this.hasEarlier = list.length >= PAGE;
    // Messages that came on the connection while the page was being read stay: some are newer than what was read.
    this.set(withNewer(list, this.shown));
  }

  private watch(): void {
    if (!this.ready) return;
    this.unanswered++;
    this.generation++;
    this.deps.send(watchFrame(this.id));
  }

  private set(messages: StoredMessage[]): void {
    this.shown = messages;
    this.emit();
  }

  private emit(): void {
    this.deps.changed({ sessionId: this.id, messages: this.shown, hasEarlier: this.hasEarlier });
  }
}
