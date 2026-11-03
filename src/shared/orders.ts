// Orders on record (issue #105): the person's own word, attested by Ledung, allowing one command in a manager and in
// the session it sent the order to. Shared by the core and the page.

/**
 * The same five statuses as the process's GOAL.md "## Standing orders" block (Magto/agent-workflow v126), so the page
 * and the file agree: open, done, refused, waiting on the person's word, dropped.
 */
export type OrderStatus = 'open' | 'done' | 'refused' | 'waiting' | 'dropped';

/** Where the person's words come from: their answer to one of the manager's questions, or what they typed into it. */
export type OrderSource = { kind: 'question'; questionId: number } | { kind: 'typed'; messageId: number };

export interface OrderInfo {
  id: number;
  /** The manager that recorded it; the ordered command is allowed in it too. */
  managerId: string;
  /** The session the order went to with start_session or send_message. */
  sessionId: string;
  project: string;
  /** The command as ordered: exactly this, or a pattern where `*` stands for any text. */
  command: string;
  match: 'exact' | 'pattern';
  /** `once`: until it has run once without failing; `done`: until the manager marks it done. */
  until: 'once' | 'done';
  source: OrderSource;
  /** The person's words, verbatim, as Ledung has them. */
  words: string;
  /** When the person said them. */
  wordsAt: number;
  createdAt: number;
  /** The start of the away period it was recorded in, or null when the person was here. */
  awaySince: number | null;
  status: OrderStatus;
  statusAt: number;
  /** Why it is refused, what the last run's error was, or who dropped it and when. */
  note: string | null;
  runs: number;
  lastRunAt: number | null;
  /** The "keep it?" question asked at the end of an away period, while it waits on the person's word. */
  keepQuestion: number | null;
}

/** A Ledung question about an order (issue #105): the end of away asks whether a not-done order stays. */
export interface OrderQuestionDetails {
  orderId: number;
}

export const KEEP = 'Keep it';
export const DROP = 'Drop it';

/** Whether the order still lets its command through: open, or refused (it may still run once allowed). */
export const inForce = (o: Pick<OrderInfo, 'status'>): boolean => o.status === 'open' || o.status === 'refused';

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The status as the process's GOAL.md writes it: `open`, `done 07:56`, `refused: <reason>`, … */
export function statusText(o: Pick<OrderInfo, 'status' | 'statusAt' | 'note' | 'keepQuestion'>, userName: string): string {
  switch (o.status) {
    case 'open': return 'open';
    case 'done': return `done ${hhmm(o.statusAt)}`;
    case 'refused': return `refused: ${o.note ?? 'no reason given'}`;
    case 'waiting': return `waiting on your word${o.keepQuestion !== null ? ` (Ledung question #${o.keepQuestion})` : ''}`;
    case 'dropped': return `dropped on ${userName}'s word ${hhmm(o.statusAt)}`;
  }
}

/** Where the words come from, for the page, the note after a call and the session's task. */
export function sourceText(o: Pick<OrderInfo, 'source' | 'wordsAt'>): string {
  return o.source.kind === 'question'
    ? `answer to question #${o.source.questionId}, ${hhmm(o.wordsAt)}`
    : `typed on this computer, ${hhmm(o.wordsAt)}`;
}
