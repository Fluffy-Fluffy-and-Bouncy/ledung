// The open session's messages (issue #231): the page tells Ledung on the live connection which session it shows, and
// Ledung sends that session's messages only. The page reads the messages from the API after Ledung's answer, never
// before: a message stored before the answer is in what it reads, one stored after it comes on the connection, and one
// that does both is shown once.
import type { PageEvent, StoredMessage } from '../../src/shared/protocol.ts';
import { fetchNewer, PAGE, withNewer } from './catchUp.ts';

export type OpenSessionView = { messages: StoredMessage[]; hasEarlier: boolean };

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
  /** The newest page has been read for the open session since it was opened; after that a reconnect reads only what is newer (#178). */
  private loaded = false;
  private hasEarlier = false;
  /** The live connection has said hello and not closed: a watch can go. */
  private ready = false;
  private readonly deps: OpenSessionDeps;

  constructor(deps: OpenSessionDeps) {
    this.deps = deps;
  }

  get sessionId(): string | null {
    return this.id;
  }

  /** The page shows another session, or none: nothing is shown until Ledung answers the watch. */
  open(sessionId: string | null): void {
    this.id = sessionId;
    this.shown = [];
    this.loaded = false;
    this.hasEarlier = false;
    this.emit();
    this.watch();
    // With no connection (first load, a reconnect under way) the page reads now rather than show nothing; once the
    // connection is back, Ledung's answer catches it up on what came since.
    if (!this.ready && sessionId) this.load(sessionId).catch(() => {});
  }

  /** The live connection's hello: a new connection has not been told what the page shows. */
  connected(): void {
    this.ready = true;
    this.watch();
  }

  /** The live connection closed or was replaced; the next hello watches again. */
  disconnected(): void {
    this.ready = false;
  }

  /** Ledung's answer to a watch: from here on the session's new messages come on the connection, so read the rest now. */
  async watching(sessionId: string | null): Promise<void> {
    if (sessionId === null || sessionId !== this.id) return;
    const last = this.shown.at(-1);
    if (!this.loaded || !last) return this.load(sessionId);
    const newer = await fetchNewer(last.id, (after) => this.deps.messagesAfter(sessionId, after));
    if (this.id !== sessionId) return;
    this.set(withNewer(this.shown, newer));
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
    this.loaded = true;
    this.hasEarlier = list.length >= PAGE;
    // Messages that came on the connection while the page was being read stay: some are newer than what was read.
    this.set(withNewer(list, this.shown));
  }

  private watch(): void {
    if (this.ready) this.deps.send(watchFrame(this.id));
  }

  private set(messages: StoredMessage[]): void {
    this.shown = messages;
    this.emit();
  }

  private emit(): void {
    this.deps.changed({ messages: this.shown, hasEarlier: this.hasEarlier });
  }
}
