// Calls the auto mode classifier refused (issue #104): Ledung sees the refusal in the session's stream and asks the
// person at once, at the top of Waiting for you and with a push, "Allow once" or "Deny". Allow once is a one-shot
// grant for that exact call in that session, honoured by Ledung's PreToolUse hook (an `allow` there gets past the
// classifier, as the merge on an answer showed). Nothing here grants anything without the person's own answer.
//
// The grant is kept as the answered question itself, and used up through the store's words_used (atomic), so a
// restart neither loses nor repeats it. Kept apart from the session so the order record (#105) can grant a call the
// same way: `sameCall` and `onceGrant` know nothing about where the grant came from but the question.
import type { QuestionInfo } from '../shared/protocol.ts';
import type { QuestionDetails, RefusalDetails } from '../shared/questions.ts';

/** What Claude Code puts in the tool result when the classifier refuses a call (its own text, Claude Code 2.1.x). */
export const CLASSIFIER_REFUSAL = 'Permission for this action was denied by the Claude Code auto mode classifier.';

/** The answers the person can give; the question offers them as its buttons. */
export const ALLOW_ONCE = 'Allow once';
export const DENY = 'Deny';

/** How long an Allow once waits for the retry: a day, then the session must be refused and asked again. */
export const ONCE_GRANT_MS = 24 * 3600 * 1000;

/** The words_used action a used grant is recorded under (with the question's key `q<id>`). */
export const ONCE_ACTION = 'once-grant';

/**
 * The classifier's reason when a tool result is its refusal, else null. `content` is the tool result's content as
 * Claude Code sends it: a string, or text blocks.
 */
export function classifierReason(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : '';
  const at = text.indexOf(CLASSIFIER_REFUSAL);
  if (at < 0) return null;
  const rest = text.slice(at + CLASSIFIER_REFUSAL.length);
  // "Reason: <why>", then Claude Code's own advice to the model on later lines, which the person needs no copy of.
  const m = /^\s*Reason:\s*([^\n]*)/.exec(rest);
  return m?.[1]?.trim() || 'none given';
}

/** The part of a call that makes it the same call: everything but its description, which is the model's own label. */
function callKey(input: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'description').map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    return typeof v === 'string' ? v.trim() : v;
  };
  return JSON.stringify(canonical(input));
}

/**
 * Whether a call is exactly the one granted: the same tool and the same input, the description aside. No prefix, no
 * wildcard: a command with anything chained onto it (`;`, `&&`, a pipe) is another command.
 */
export function sameCall(granted: { toolName: string; input: Record<string, unknown> }, toolName: string, input: Record<string, unknown>): boolean {
  return granted.toolName === toolName && callKey(granted.input) === callKey(input);
}

/** The refused call a question is about, when Ledung raised it; null for any other question. */
export function refusalOf(q: Pick<QuestionInfo, 'details'>): RefusalDetails | null {
  return q.details?.refusal ?? null;
}

/** Whether an answer is the person's Allow once: the button, or the button with a note under it. */
export function allowsOnce(answer: string | null): boolean {
  if (answer === null) return false;
  const a = answer.trim();
  return a === ALLOW_ONCE || a.startsWith(`${ALLOW_ONCE}\n\nNote: `);
}

/**
 * The person's Allow once that covers this call, if any: a refusal question of this session, answered Allow once by
 * the person themself (not passed on by a manager, which forward_answer does), within the last day, for exactly this
 * call. Whether it is still unused is the store's to say (words_used), so the caller uses it up atomically.
 */
export function onceGrant(
  questions: readonly QuestionInfo[], sessionId: string, toolName: string, input: Record<string, unknown>, now: number,
): QuestionInfo | null {
  return questions.find((q) => {
    const r = refusalOf(q);
    return !!r && q.sessionId === sessionId && q.status === 'answered' && q.answeredBy === 'user' && q.forwardedFrom === null
      && allowsOnce(q.answer) && (q.answeredAt ?? 0) > now - ONCE_GRANT_MS && sameCall(r, toolName, input);
  }) ?? null;
}

/** The call as the person reads it: a shell command as it is, any other tool as its input. */
export function callText(r: Pick<RefusalDetails, 'toolName' | 'input'>): string {
  const command = r.input.command;
  if ((r.toolName === 'Bash' || r.toolName === 'PowerShell') && typeof command === 'string') return command;
  return JSON.stringify(r.input, null, 2);
}

/** A fenced block that the text can't close early. */
function fenced(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * The question Ledung asks the person (issue #104): the session, its project, the exact call and the classifier's
 * reason, with Allow once and Deny. In the project's first tier and ranked first, so it heads Waiting for you.
 */
export function refusalQuestion(
  r: RefusalDetails, session: { title: string; project: string }, tier: string | undefined,
): { question: string; options: string[]; details: QuestionDetails } {
  const shell = r.toolName === 'Bash' || r.toolName === 'PowerShell';
  const title = `Auto mode refused a call in "${session.title}"`;
  const issue = [
    `The auto mode classifier refused this ${shell ? `${r.toolName} command` : `${r.toolName} call`} in the session "${session.title}" (project ${session.project}).`,
    fenced(callText(r), shell ? (r.toolName === 'Bash' ? 'bash' : 'powershell') : 'json'),
    `**The classifier's reason:** ${r.reason}`,
    `**${ALLOW_ONCE}** lets exactly this call run one time: Ledung tells the session to retry it, and lets the retry through. ` +
      `Any other command, and a second run of this one, is refused or asked as usual. **${DENY}** tells the session you said no.`,
  ].join('\n\n');
  const details: QuestionDetails = { title, issue, ...(tier ? { tier } : {}), rank: 0, refusal: r };
  return { question: `**${title}**\n\n${issue}`, options: [ALLOW_ONCE, DENY], details };
}

/** What the session is told when the person answered (buildDelivery): retry once, stop, or what they said instead. */
export function refusalAnswerText(q: QuestionInfo, userName: string): string {
  const r = refusalOf(q)!;
  const call = fenced(callText(r));
  if (allowsOnce(q.answer)) {
    const note = q.answer!.trim().slice(ALLOW_ONCE.length).replace(/^\s*Note:\s*/, '').trim();
    return `${userName} allowed, once, the call the auto mode classifier refused (Ledung's question #${q.id}). Retry exactly this call now, one time, unchanged:\n\n${call}\n\n` +
      'Ledung lets that one retry through; it does not cover any other command, a changed one, or a second run.' +
      (note ? `\n\n${userName}'s note: ${note}` : '');
  }
  if (q.answer?.trim() === DENY) {
    return `${userName} declined the call the auto mode classifier refused (Ledung's question #${q.id}):\n\n${call}\n\nDon't retry it, and don't ask again for it; go on without it, or say what you need instead.`;
  }
  return `${userName} answered Ledung's question #${q.id} about the call the auto mode classifier refused, without allowing it:\n\n${q.answer ?? ''}\n\nNothing was allowed; don't retry the call unless the answer tells you how.`;
}
