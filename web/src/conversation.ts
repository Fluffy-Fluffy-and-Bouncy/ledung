// "Go to conversation" from Waiting for you (issue #61): which conversation a question is answered in, the
// address that opens it scrolled to the question, and the questions of other sessions shown in it.

/** Where Waiting for you was when the conversation was opened: Back returns there. */
export type CameFrom = 'queue' | 'question' | 'shots';

/**
 * The conversation a question is answered in: always the manager who owns it (Martin, 2026-10-14 13:07) —
 * the manager it went to (a session's question it handles), or the manager that asked (its own question, or
 * one about a session's question). A question addressed to the user by a session no manager runs is its own.
 */
export function conversationOf(q: { sessionId: string; addressedTo: string }): string {
  return q.addressedTo !== 'user' ? q.addressedTo : q.sessionId;
}

/** A session's conversation, scrolled to a question when one is given. */
export function conversationHash(sessionId: string, questionId: number | null = null): string {
  return questionId === null ? `#/s/${sessionId}` : `#/s/${sessionId}/q/${questionId}`;
}

/** The session and the question to scroll to, from an address made by conversationHash; null for any other address. */
export function conversationFromHash(hash: string): { sessionId: string; questionId: number | null } | null {
  const m = hash.match(/^#\/s\/([\w-]+)(?:\/q\/(\d+))?$/);
  return m ? { sessionId: m[1]!, questionId: m[2] ? Number(m[2]) : null } : null;
}

/** A session's conversation scrolled to one of its messages: an attached reply's link (issue #369). */
export function messageHash(sessionId: string, messageId: number): string {
  return `#/s/${sessionId}/m/${messageId}`;
}

/** The session and the message to scroll to, from an address made by messageHash; null for any other address. */
export function messageFromHash(hash: string): { sessionId: string; messageId: number } | null {
  const m = hash.match(/^#\/s\/([\w-]+)\/m\/(\d+)$/);
  return m ? { sessionId: m[1]!, messageId: Number(m[2]) } : null;
}

/**
 * The questions of other sessions a conversation shows besides its own: those it is answered in (a session's
 * question its manager handles). Older than the earliest loaded message (`earliest`, null when all are
 * loaded) they wait for "Load earlier messages", so a card never sits above messages that aren't there yet.
 */
export function wovenQuestions<Q extends { id: number; sessionId: string; addressedTo: string; askedAt: number }>(
  questions: readonly Q[], sessionId: string, earliest: number | null,
): Q[] {
  return questions
    .filter((q) => q.sessionId !== sessionId && conversationOf(q) === sessionId && (earliest === null || q.askedAt >= earliest))
    .sort((a, b) => a.askedAt - b.askedAt || a.id - b.id);
}

/** Puts timed entries into a list already in time order, each after the entries of the same time. */
export function insertByTime<T extends { at: number }>(list: readonly T[], extra: readonly T[]): T[] {
  const out = [...list];
  for (const e of extra) {
    let i = out.length;
    while (i > 0 && out[i - 1]!.at > e.at) i--;
    out.splice(i, 0, e);
  }
  return out;
}

/**
 * The woven questions a chat shows. A session's question to its manager is traffic between agents, so it shows
 * only with technical messages, like the deliveries hidden in #94 (Martin, 2026-10-16 07:59, issue #112) — and
 * the one Go to conversation opened the chat at, so that jump still lands on its card (issue #61).
 */
export function shownWoven<Q extends { id: number }>(woven: readonly Q[], showTechnical: boolean, focus: number | null): Q[] {
  return showTechnical ? [...woven] : woven.filter((q) => q.id === focus);
}
