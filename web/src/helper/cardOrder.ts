// Where the Ledung Helper's cards stand in its chat (Simon's try-out, 2026-11-12: "messages and input boxes twice"):
// a card shows under the helper's words of its turn, whatever order they came in, and a card shown again under the
// same key in the same turn replaces the earlier one, so each shows once. Pure, so it can be tested.
import type { HelperCard } from '../../../src/shared/helper-cards.ts';

type Entry = { type: string; byLedung?: boolean; card?: HelperCard | null; answered?: boolean; text?: string; sub?: boolean };

/** A card's key: its id, else its kind and title. */
export function cardKey(card: HelperCard): string {
  return 'id' in card && card.id ? `id:${card.id}` : `${card.kind}:${card.title}`;
}

const persons = (e: Entry) => e.type === 'user' && !e.byLedung;

/** Any message given to the helper, the person's or Ledung's, starts a new turn. */
const given = (e: Entry) => e.type === 'user';
const words = (t: string) => t.replace(/\s+/g, ' ').trim();
/** At most this long, a line after a turn's card is taken for narration and not shown. */
const NARRATION = 100;

/**
 * The entries with each turn's cards moved after its other entries, repeats of a card key and of the helper's own
 * words in a turn dropped (acceptance round 1, 6.1: a message twice), and cards answered marked. A card stays in its
 * own turn: it never moves under a later turn's message (6.3).
 */
export function placeCards<T extends Entry>(raw: T[], turnOpen = false): T[] {
  const out: T[] = [];
  let held: T[] = [];
  // The last turn's cards wait until the helper has written in it: a card never shows before its words (round 2, 20).
  const flush = (spoke: boolean) => {
    if (!spoke) {
      held = [];
      return;
    }
    // The last card of each key in this turn, in the order those last ones came.
    const last = new Map<string, T>();
    for (const c of held) {
      last.delete(cardKey(c.card!));
      last.set(cardKey(c.card!), c);
    }
    // Right under the turn's last words, before any later line such as "Session resumed".
    out.splice(lastSaid >= 0 ? lastSaid + 1 : out.length, 0, ...last.values());
    held = [];
  };
  let lastSaid = -1;
  let said = new Set<string>();
  for (const e of raw) {
    if (e.type === 'card') held.push(e);
    else if (given(e)) {
      flush(true);
      said = new Set();
      lastSaid = -1;
      out.push(e);
    } else if (e.type === 'assistant' && !e.sub && e.text) {
      if (said.has(words(e.text))) continue;
      // A short line after the turn's card is narration ("Waiting for the name."): the card says it (round 3, 20).
      if (held.length && said.size && words(e.text).length <= NARRATION) continue;
      said.add(words(e.text));
      out.push(e);
      lastSaid = out.length - 1;
    } else out.push(e);
  }
  // The last turn's card shows once that turn has ended, under its last words: it never jumps (round 3, 20).
  flush(said.size > 0 && !turnOpen);
  // Answered once the person wrote anything after it (their pick is their message).
  let later = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (persons(e)) later = true;
    else if (e.type === 'card' && later) out[i] = { ...e, answered: true };
  }
  return out;
}

type Turned = { type: string; byLedung?: boolean; sub?: boolean; text?: string; answered?: boolean; card?: unknown; apiError?: boolean };

/**
 * The Ledung Helper's chat, a turn at a time (acceptance round 4): a turn with a reply shows only that reply (the
 * helper's other words are its own, not shown); a turn with none shows its words once it has ended, as a fallback.
 * A reply's card is answered once the person wrote anything after it.
 */
export function helperTurns<T extends Turned>(raw: T[], turnOpen = false): T[] {
  const out: T[] = [];
  let turn: T[] = [];
  const close = (ended: boolean) => {
    const replied = turn.some((e) => e.type === 'reply');
    const seen = new Set<string>();
    for (const e of turn) {
      // Claude Code's own error and usage-limit lines always show (code review, finding 4).
      if (e.type === 'assistant' && !e.sub && !e.apiError) {
        if (replied || !ended) continue;
        const w = (e.text ?? '').replace(/\s+/g, ' ').trim();
        if (seen.has(w)) continue;
        seen.add(w);
      }
      out.push(e);
    }
    turn = [];
  };
  for (const e of raw) {
    if (e.type === 'user') {
      close(true);
      out.push(e);
    } else turn.push(e);
  }
  close(!turnOpen);
  let later = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.type === 'user' && !e.byLedung) later = true;
    else if ((e.type === 'reply' || e.type === 'card') && later) out[i] = { ...e, answered: true };
  }
  return out;
}

type Stored = { kind: string; data: any };

/**
 * Whether the helper has said something since the last message it was given (the person's or Ledung's): the step's
 * card shows only then, so it always stands under the helper's words for that step (Simon, 2026-11-12: the card stood
 * above the greeting).
 */
export function helperHasSpoken(messages: Stored[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'user') return false;
    if (m.kind === 'reply') return true;
    if (m.kind === 'sdk' && m.data?.type === 'assistant' && m.data.parent_tool_use_id == null
      && (m.data.message?.content ?? []).some((b: { type?: string; text?: string }) => b?.type === 'text' && b.text?.trim())) return true;
  }
  return false;
}
