// "Earlier in the conversation" (issue #368): the last messages of a session's conversation before it asked a
// question, word for word, kept with the question. A question saying "the 12 points above" then leads to them on
// the question page (Martin, 2026-10-28, Ledung questions 313 and 320).
import type { ConversationLine, StoredMessage } from '../shared/protocol.ts';
import { withoutContextSentence } from '../shared/delivery.ts';

/** At most this many messages, the latest. */
export const EARLIER_LINES = 5;
/** Characters per message and for them all: a long report is cut, newest kept first, so a question stays small. */
export const EARLIER_LINE_CHARS = 12_000;
export const EARLIER_TOTAL_CHARS = 30_000;

/**
 * The last messages before the end of `messages` (oldest first, as stored): the session's own replies, merged
 * within a turn so tool calls between them don't split one reply into many; what Ledung delivered to it; and what
 * the user wrote. Subagents' words and tool calls are left out.
 */
export function conversationBefore(messages: readonly StoredMessage[]): ConversationLine[] {
  const lines: ConversationLine[] = [];
  for (const m of messages) {
    if (m.kind === 'user') {
      const text = userText(m.data);
      if (text) lines.push({ at: m.at, kind: m.data?.from === 'ledung' ? 'delivered' : 'user', text });
      continue;
    }
    if (m.kind !== 'sdk' || m.data?.type !== 'assistant' || m.data.parent_tool_use_id) continue;
    const text = (m.data.message?.content ?? [])
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
      .map((b: any) => b.text.trim())
      .join('\n\n');
    if (!text) continue;
    const last = lines.at(-1);
    if (last?.kind === 'reply') last.text += `\n\n${text}`;
    else lines.push({ at: m.at, kind: 'reply', text });
  }
  return fit(lines.slice(-EARLIER_LINES));
}

/** A user message as the session got it: the user's words, or what Ledung delivered, without its fixed sentence. */
function userText(data: any): string {
  const own = withoutContextSentence(String(data?.text ?? '')).trim();
  const context = typeof data?.context === 'string' ? data.context.trim() : '';
  return [own, context].filter(Boolean).join('\n\n');
}

/** Cuts the lines to the limits, keeping the latest whole as far as they go; older ones that no longer fit are dropped. */
function fit(lines: ConversationLine[]): ConversationLine[] {
  const out: ConversationLine[] = [];
  let left = EARLIER_TOTAL_CHARS;
  for (let i = lines.length - 1; i >= 0 && left > 0; i--) {
    const l = lines[i]!;
    const room = Math.min(left, EARLIER_LINE_CHARS);
    out.unshift(l.text.length > room ? { ...l, text: l.text.slice(0, room), cut: true } : l);
    left -= Math.min(l.text.length, room);
  }
  return out;
}
