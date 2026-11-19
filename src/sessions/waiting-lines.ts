// "Waiting for you" lines in a manager's chat (issue #350). Ledung watches what it publishes about questions and
// permission requests: one addressed to the person that the manager's chat does not show already gets one line there
// (Done looks like 1 and 4), and the line is changed in place when the item is decided (Done 3). Watching the events,
// not each place that asks or decides, catches every path: the page, a manager's tools, a run, a withdrawal.
import type { PermissionInfo, QuestionInfo, ServerEvent, StoredMessage } from '../shared/protocol.ts';
import { permissionLine, questionLine, sameLine, type WaitingLine } from '../shared/waiting-line.ts';
import type { Store } from '../store/store.ts';

export interface WaitingLinesDeps {
  store: Store;
  publish: (event: ServerEvent) => void;
  userName: () => string;
}

export class WaitingLines {
  private readonly d: WaitingLinesDeps;

  constructor(deps: WaitingLinesDeps) {
    this.d = deps;
  }

  /** Called with every event Ledung publishes; never throws, a line is not worth breaking a publish for. */
  seen(event: ServerEvent): void {
    try {
      if (event.type === 'question') this.question(event.question);
      else if (event.type === 'permission') this.permission(event.permission);
    } catch (e) {
      console.warn('Ledung: a Waiting for you line could not be written.', e);
    }
  }

  private question(q: QuestionInfo): void {
    if (q.addressedTo !== 'user') return;
    const line = questionLine(q, this.d.userName(), this.titleOf);
    this.place(line, () => this.questionChat(q));
  }

  /**
   * A manager's session's prompt is addressed to that manager (Management.addresseeFor), not to the person: a running
   * session's prompt is never to the person while it has a manager (re-review of #350, finding 2). The person can
   * decide it too ("Its manager asks you about it"), and a sensitive one only the person can allow, so it gets its line.
   */
  private permission(p: PermissionInfo): void {
    const manager = this.managerOf(p.sessionId);
    if (p.addressedTo !== 'user' && p.addressedTo !== manager) return;
    const line = permissionLine(p, this.d.userName(), this.titleOf);
    this.place(line, () => manager);
  }

  /** Updates the item's line if it has one; else adds it to `chat()`'s chat while the item is still waiting. */
  private place(line: WaitingLine, chat: () => string | null): void {
    const had = this.d.store.waitingLineOf(line.item, line.ref);
    let message: StoredMessage | null = null;
    if (had) {
      if (!sameLine(had.data as WaitingLine, line)) message = this.d.store.updateWaitingLine(had.id, line);
    } else if (line.state === 'waiting') {
      const to = chat();
      if (to) message = this.d.store.addWaitingLine(to, line);
    }
    if (message) this.d.publish({ type: 'message', message });
  }

  /**
   * Where a question's line goes. A run's person step Ledung asked itself belongs to the run's coordinator, whose chat
   * does not show it (Done 1); the coordinator's own write-up was asked with ask_user and is in its chat already
   * (Done 8). Any other question goes to the asker's manager: the asker's chat has its own card.
   */
  private questionChat(q: QuestionInfo): string | null {
    const run = q.details?.run;
    if (run && !run.writeUp) return this.d.store.getSession(q.sessionId) ? q.sessionId : null;
    return this.managerOf(q.sessionId);
  }

  /** The manager that started a session, in the same project (Done 8: no lines from other projects); null: none. */
  private managerOf(sessionId: string): string | null {
    const s = this.d.store.getSession(sessionId);
    if (!s?.parentId || s.parentId === s.id) return null;
    const m = this.d.store.getSession(s.parentId);
    return m && m.role === 'manager' && m.project === s.project ? m.id : null;
  }

  private titleOf = (id: string): string | undefined => this.d.store.getSession(id)?.title;
}
