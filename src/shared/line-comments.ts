// Line comments from the Files pane's Changes tab (issue #225, a test feature). Each is a draft in the page until
// sent; sent, they travel as text inside a review answer or one message, written so a manager can hand them on as
// a review round. Each keeps the line's own text and the commit it was made on, so it can still be placed after
// the worker's next push (research notes for #225: "how each comment is sent, so that it survives").
import type { QuestionInfo } from './protocol.ts';
import { ACCEPTED, CHANGES_NEEDED } from './questions.ts';

export interface LineComment {
  path: string;
  line: number;
  /** "new": the line as it is now (added or unchanged); "old": a deleted line, by its old number. */
  side: 'new' | 'old';
  /** The line as it read when the comment was written, without its +/- mark. */
  lineText: string;
  /** The commit the diff showed (the session folder's HEAD). */
  commit: string;
  body: string;
}

export const MAX_LINE_COMMENTS = 50;
const MAX_BODY = 4000;
const MAX_QUOTE = 300;

/** The comments as sent, checked; or why they can't be. */
export function checkLineComments(value: unknown): { comments: LineComment[] } | { problem: string } {
  if (!Array.isArray(value) || value.length === 0) return { problem: 'There are no line comments to send.' };
  if (value.length > MAX_LINE_COMMENTS) return { problem: `At most ${MAX_LINE_COMMENTS} line comments at a time.` };
  const comments: LineComment[] = [];
  for (const [i, c] of value.entries()) {
    const bad = (what: string) => ({ problem: `Line comment ${i + 1}: ${what}.` });
    if (!c || typeof c !== 'object') return bad('not a comment');
    const { path, line, side, lineText, commit, body } = c as Record<string, unknown>;
    if (typeof path !== 'string' || !path.trim() || path.length > 500 || /[\r\n]/.test(path)) return bad('the file is missing');
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return bad('the line number is missing');
    if (side !== 'new' && side !== 'old') return bad('the side is "new" or "old"');
    if (typeof lineText !== 'string') return bad('the line\'s text is missing');
    if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(commit)) return bad('the commit is missing');
    if (typeof body !== 'string' || !body.trim()) return bad('it is empty');
    if (body.length > MAX_BODY) return bad(`it is longer than ${MAX_BODY} characters`);
    comments.push({ path, line, side, lineText: lineText.slice(0, 2000), commit, body: body.trim() });
  }
  return { comments };
}

/** One quoted line: long ones cut, tabs as spaces, so the list stays readable in a conversation. */
function quote(text: string): string {
  const t = text.replace(/\t/g, '  ').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE)}…` : t;
}

/**
 * The comments as a numbered list a manager or worker reads at a glance and a script can still split:
 * `path:line` (with "(old)" for a deleted line), the quoted line, then the comment indented under it.
 */
export function formatLineComments(comments: readonly LineComment[], where: string): string {
  const commits = [...new Set(comments.map((c) => c.commit.slice(0, 7)))];
  const head = `${comments.length} line comment${comments.length === 1 ? '' : 's'} on ${where} at ${commits.join(', ')}:`;
  const items = comments.map((c, i) => {
    const mark = c.side === 'old' ? '-' : '+';
    const at = `${c.path}:${c.line}${c.side === 'old' ? ' (old)' : ''}`;
    const body = c.body.split('\n').map((l) => `   ${l}`).join('\n');
    return `${i + 1}. ${at}  ${mark} ${quote(c.lineText)}\n${body}`;
  });
  return [head, ...items].join('\n');
}

/** A review answer carrying the comments: Changes needed with them (text optional), or Accept with them as notes. */
export function reviewAnswerWithComments(verdict: 'accept' | 'changes', text: string, comments: string): string {
  const t = text.trim();
  if (verdict === 'accept') return `${ACCEPTED}\n\n${t ? `${t}\n\n` : ''}Notes, not blocking:\n${comments}`;
  return `${CHANGES_NEEDED} ${t ? `${t}\n\n` : ''}${comments}`;
}

/** The message when no review is open: the user's own words to the session's manager, or to the session itself. */
export function lineCommentsMessage(userName: string, text: string, comments: string, about: string | null): string {
  const t = text.trim();
  const lead = about
    ? `${userName}'s line comments on the changes of your session "${about}". Hand them on as a review round; each is a finding to check, not an order.`
    : `${userName}'s line comments on your changes. Each is a finding to check, not an order.`;
  return `${lead}\n\n${t ? `${t}\n\n` : ''}${comments}`;
}

/**
 * The open review that line comments on `sessionId`'s changes go with: one put to the user, asked by that
 * session, or by its manager about one of its questions. Newest first. `questions` is everything known.
 */
export function openReviewFor(sessionId: string, questions: readonly QuestionInfo[]): QuestionInfo | null {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const mine = questions.filter((q) => q.status === 'open' && q.addressedTo === 'user' && q.details?.review
    && (q.sessionId === sessionId || (q.aboutQuestion !== null && byId.get(q.aboutQuestion)?.sessionId === sessionId)));
  return mine.sort((a, b) => b.askedAt - a.askedAt)[0] ?? null;
}
