// A "Waiting for you" line in a manager's chat (issue #350, Simon 2026-11-17: "it's weird that I have a question here,
// but I have to look in the bar to the left to even get to the screen to answer it"). A run's person step, a question
// one of the manager's sessions put to the person, and a permission prompt from one of them (addressed to the manager,
// which the person may decide too), get one line in the manager's chat with Open; the line says how it ended once decided. Shared: Ledung stores the line's state with it (it survives a
// restart, Done looks like 7) and the page draws it from the live item when it has one. Plain text only (Done 5).
import type { PermissionInfo, QuestionInfo } from './protocol.ts';
import { ACCEPTED, CHANGES_NEEDED, deskQuestion } from './questions.ts';
import { callLine } from './tool-call.ts';

export type WaitingLineState = 'waiting' | 'accepted' | 'changes' | 'answered' | 'withdrawn' | 'allowed' | 'denied';

/** A line's stored data (message kind 'waiting'). */
export interface WaitingLine {
  item: 'question' | 'permission';
  /** The question's number as text, or the permission request's id. */
  ref: string;
  /** The session that asked: a permission's Open shows Waiting for you on it. */
  sessionId: string;
  label: 'Review' | 'Question' | 'Permission prompt';
  /** The question's number; null for a permission prompt, which has none. */
  number: number | null;
  title: string;
  state: WaitingLineState;
  /** The option picked, or the answer's first line, for an answered question. */
  answer: string | null;
  /** Who decided, by name. */
  by: string | null;
  at: number | null;
  /**
   * A permission prompt addressed to the session's manager, not the person (re-review of #350, finding 2): Waiting
   * for you doesn't list it, so Open goes to the session's chat, where its prompt can be decided. Absent: the person.
   */
  toManager?: boolean;
  /** A sensitive prompt, which only the person can allow: it waits for the person even when it is with a manager. */
  sensitive?: boolean;
}

const MAX_TITLE = 140;
const MAX_ANSWER = 80;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The name of who decided: the person, Ledung, or a manager by its title. */
function whoName(by: string | null, userName: string, titleOf: (id: string) => string | undefined): string | null {
  if (!by) return null;
  if (by === 'user') return userName;
  if (by === 'ledung') return 'Ledung';
  return titleOf(by) ?? 'a manager';
}

export function questionLine(q: QuestionInfo, userName: string, titleOf: (id: string) => string | undefined): WaitingLine {
  const review = !!q.details?.review;
  const base = {
    item: 'question' as const, ref: String(q.id), sessionId: q.sessionId, label: review ? 'Review' as const : 'Question' as const,
    number: q.id, title: cut(deskQuestion(q).title, MAX_TITLE),
  };
  if (q.status === 'open') return { ...base, state: 'waiting', answer: null, by: null, at: null };
  if (q.status === 'withdrawn') return { ...base, state: 'withdrawn', answer: null, by: null, at: q.answeredAt };
  const answer = q.answer ?? '';
  const by = whoName(q.answeredBy, userName, titleOf);
  if (review && answer.startsWith(ACCEPTED)) return { ...base, state: 'accepted', answer: null, by, at: q.answeredAt };
  if (review && answer.startsWith(CHANGES_NEEDED)) return { ...base, state: 'changes', answer: null, by, at: q.answeredAt };
  const option = deskQuestion(q).options.find((o) => answer === o.answer || answer.startsWith(`${o.answer}\n`));
  return { ...base, state: 'answered', answer: cut(option ? option.label : answer.split('\n')[0] ?? '', MAX_ANSWER), by, at: q.answeredAt };
}

/** A permission prompt's title: the request's own title, else its tool in plain words and what it is about (issue #399). */
function permissionTitle(p: PermissionInfo): string {
  if (p.title) return cut(p.title, MAX_TITLE);
  return cut(callLine(p.toolName, (p.input ?? {}) as Record<string, unknown>, MAX_TITLE), MAX_TITLE);
}

export function permissionLine(p: PermissionInfo, userName: string, titleOf: (id: string) => string | undefined): WaitingLine {
  const base = {
    item: 'permission' as const, ref: p.id, sessionId: p.sessionId, label: 'Permission prompt' as const, number: null, title: permissionTitle(p), answer: null,
    ...(p.addressedTo !== 'user' ? { toManager: true } : {}), ...(p.sensitive ? { sensitive: true } : {}),
  };
  const by = whoName(p.decidedBy, userName, titleOf);
  if (p.status === 'pending') return { ...base, state: 'waiting', by: null, at: null };
  if (p.status === 'allowed') return { ...base, state: 'allowed', by, at: p.decidedAt };
  if (p.status === 'denied') return { ...base, state: 'denied', by, at: p.decidedAt };
  return { ...base, state: 'withdrawn', by: null, at: p.decidedAt };
}

/** Whether two lines say the same: an unchanged one is not stored or sent again. */
export function sameLine(a: WaitingLine, b: WaitingLine): boolean {
  return a.state === b.state && a.title === b.title && a.answer === b.answer && a.by === b.by && a.at === b.at;
}

/**
 * The words before a waiting line's head. A prompt with the manager that the person may decide but the manager
 * usually does isn't "waiting for you" (the sidebar badge says the same, issue #322): it waits for a decision.
 */
export function lineLead(l: WaitingLine): string {
  return l.toManager && !l.sensitive ? 'Waiting for a decision' : 'Waiting for you';
}

/** What the line says before Open: "Waiting for you: Review #12 — Build: shop". */
export function lineHead(l: WaitingLine): string {
  return `${l.label}${l.number !== null ? ` #${l.number}` : ''} — ${l.title}`;
}

/** How it ended, without the time (the page adds it): "Accepted by Simon", "Answered by Simon: Merge". Null: waiting. */
export function lineOutcome(l: WaitingLine): string | null {
  const by = l.by ? ` by ${l.by}` : '';
  switch (l.state) {
    case 'waiting': return null;
    case 'accepted': return `Accepted${by}`;
    case 'changes': return `Changes needed${by}`;
    case 'answered': return `Answered${by}${l.answer ? `: ${l.answer}` : ''}`;
    case 'allowed': return `Allowed${by}`;
    case 'denied': return `Denied${by}`;
    case 'withdrawn': return 'Withdrawn';
  }
}
