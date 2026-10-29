// Line comments on a session's changes (issue #225, a test feature) are drafts in this browser until Send, so a
// review round goes as one message, not a trickle (research notes for #225). Sending clears them.
import type { LineComment } from '../../src/shared/line-comments.ts';
import type { DraftStore } from './drafts.ts';

export interface DraftComment extends LineComment {
  id: string;
}

const key = (sessionId: string) => `ledung.lineComments.${sessionId}`;

export function readLineDrafts(store: DraftStore, sessionId: string): DraftComment[] {
  try {
    const list = JSON.parse(store.getItem(key(sessionId)) ?? '[]');
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && typeof c.body === 'string') : [];
  } catch {
    return [];
  }
}

/** An empty list removes the entry, so sent comments leave nothing behind. */
export function writeLineDrafts(store: DraftStore, sessionId: string, list: readonly DraftComment[]): void {
  try {
    if (list.length) store.setItem(key(sessionId), JSON.stringify(list));
    else store.removeItem(key(sessionId));
  } catch {
    // Private mode or a full store: kept for this visit only.
  }
}

/** The same line on the same side of the same file. */
export const sameLine = (a: Pick<LineComment, 'path' | 'line' | 'side'>, b: Pick<LineComment, 'path' | 'line' | 'side'>) =>
  a.path === b.path && a.line === b.line && a.side === b.side;

/** A draft written, or rewritten in place when that line already has one; an empty body takes it away. */
export function putLineDraft(list: readonly DraftComment[], c: DraftComment): DraftComment[] {
  const rest = list.filter((d) => d.id !== c.id && !sameLine(d, c));
  if (!c.body.trim()) return rest;
  const at = list.findIndex((d) => d.id === c.id || sameLine(d, c));
  if (at === -1) return [...rest, c];
  const out = [...rest];
  out.splice(Math.min(at, out.length), 0, c);
  return out;
}
