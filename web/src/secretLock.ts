// Locking a secret in the message box (issue #468): the selected text becomes a token `[🔑 name]`, and the
// value leaves the box and the saved draft at once (#73, #323). Pure helpers, kept apart from the components
// so they can be tested; the value itself goes to Ledung on its own (api.addSecret) and is not kept here.
import { secretToken, tokenNames, type SecretInfo } from '../../src/shared/secrets.ts';
import { writeDraft, type DraftStore } from './drafts.ts';

/** The part of a selection to lock, without the spaces around it; null when nothing is left or it touches a token. */
export function lockRange(text: string, start: number, end: number): { start: number; end: number } | null {
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (s >= e) return null;
  // Not across a token already there, which would lock the token's own text.
  for (const m of text.matchAll(/\[🔑 [^\]\n]*\]/g)) if (m.index! < e && m.index! + m[0].length > s) return null;
  return { start: s, end: e };
}

/**
 * The box's text with the range replaced by the token, written to the saved draft at once (not after the
 * usual delay) so the value is gone from this browser's storage immediately; and where the caret goes.
 */
export function lockInDraft(store: DraftStore, sessionId: string, text: string, range: { start: number; end: number }, name: string): { text: string; caret: number } {
  const token = secretToken(name);
  const next = text.slice(0, range.start) + token + text.slice(range.end);
  writeDraft(store, sessionId, next);
  return { text: next, caret: range.start + token.length };
}

/** The text with a token put in at the caret, a space either side where the words would run into it. */
export function insertToken(text: string, at: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const token = `${before && !/\s$/.test(before) ? ' ' : ''}${secretToken(name)}${after && !/^\s/.test(after) ? ' ' : ''}`;
  return { text: before + token + after, caret: before.length + token.length };
}

/** Every token of one name renamed, or taken out (`to` null) with the space after it. */
export function renameToken(text: string, from: string, to: string | null): string {
  const token = secretToken(from);
  return to === null ? text.split(`${token} `).join('').split(token).join('') : text.split(token).join(secretToken(to));
}

/** The chips over the box: the session's secrets the text names, and the names it has no secret for (removed). */
export function chipsFor(text: string, secrets: readonly SecretInfo[]): { known: SecretInfo[]; missing: string[] } {
  const names = tokenNames(text);
  return {
    known: names.map((n) => secrets.find((s) => s.name === n)).filter((s): s is SecretInfo => !!s),
    missing: names.filter((n) => !secrets.some((s) => s.name === n)),
  };
}

// The page hears of a session's secrets from the live connection (useLedung) and its own changes; whatever
// shows them (the message box, the ⚙ menu) listens here.
const listeners = new Map<string, Set<(list: SecretInfo[]) => void>>();

export function secretsChanged(sessionId: string, list: SecretInfo[]): void {
  for (const fn of listeners.get(sessionId) ?? []) fn(list);
}

export function onSecrets(sessionId: string, fn: (list: SecretInfo[]) => void): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(fn);
  listeners.set(sessionId, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(sessionId);
  };
}
