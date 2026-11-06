// The checks every file that leaves this Ledung goes through: board attachments (trust rule 4) and files sent to a
// manager on a linked computer (issue #158). Apart from attachments.ts, which address.ts imports.
import { sensitiveInText, tokenLike } from './address.ts';
import type { OutgoingFile } from './attachments.ts';

/** What an outgoing file's checks found: a sensitive pattern, a locked secret, or something token-like; null: none. */
export type OutgoingFinding = { sensitive: string } | { locked: true } | { token: string } | null;

/**
 * The checks every file that leaves this Ledung goes through (trust rule 4 of the board, reused for linked computers,
 * issue #158): its own path, and a text file's content, against the project's sensitive patterns, a secret locked in
 * Ledung, and text that looks like a token. An image's pixels can't be checked.
 */
export function outgoingFinding(f: Pick<OutgoingFile, 'inside' | 'text'>, rules: { commandPatterns: string[]; pathPatterns: string[] }, holdsSecret?: (text: string) => boolean): OutgoingFinding {
  const sensitive = sensitiveInText(f.inside, rules) ?? (f.text === null ? null : sensitiveInText(f.text, rules));
  if (sensitive) return { sensitive };
  if (f.text !== null && holdsSecret?.(f.text)) return { locked: true };
  const token = f.text === null ? null : tokenLike(f.text);
  return token ? { token } : null;
}
