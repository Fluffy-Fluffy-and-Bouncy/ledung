// Display only: the short line Claude Code forces after an ask_user call ("Waiting for your answer.") repeats
// what the question card already shows, so the page hides it (decisions, 2026-10-12). Shared by the page and
// the Overview's last-reply preview so both agree. The stored messages are never changed.

/** Ledung's ask_user (src/sessions/tools.ts). */
export function isAskUser(toolName: string): boolean {
  return toolName === 'mcp__ledung__ask_user';
}

const MAX_QUIET = 200;

/** A single short paragraph: no code block, no list, no blank line, at most 200 characters. */
export function isShortText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= MAX_QUIET && !t.includes('```') && !/\n\s*\n/.test(t) && !/^\s*([-*+•]|\d+[.)])\s/m.test(t);
}

export type TurnEntry =
  | { kind: 'text'; text: string; sub?: boolean }
  | { kind: 'tool'; name: string; sub?: boolean }
  /** A turn boundary: the user's message, or the turn's result. */
  | { kind: 'end' }
  /** Anything else in the list (questions, events, permissions): ignored. */
  | { kind: 'other' };

/** Indexes of the texts to hide: in each turn whose last tool call is ask_user, the short texts after it. Subagent entries are ignored. */
export function quietTexts(entries: TurnEntry[]): Set<number> {
  const quiet = new Set<number>();
  let askAt = -1; // index of the turn's last tool call if it is ask_user, else -1
  let after: number[] = [];
  const close = () => {
    if (askAt >= 0) after.forEach((i) => quiet.add(i));
    askAt = -1;
    after = [];
  };
  entries.forEach((e, i) => {
    if (e.kind === 'end') close();
    else if (e.kind === 'tool' && !e.sub) {
      askAt = isAskUser(e.name) ? i : -1;
      after = [];
    } else if (e.kind === 'text' && !e.sub && askAt >= 0 && isShortText(e.text)) after.push(i);
  });
  close();
  return quiet;
}
