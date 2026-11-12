// Where the Ledung Helper's cards stand in its chat (Simon's try-out, 2026-11-12: "messages and input boxes twice"):
// a card shows under the helper's words of its turn, whatever order they came in, and a card shown again under the
// same key in the same turn replaces the earlier one, so each shows once. Pure, so it can be tested.
import type { HelperCard } from '../../../src/shared/helper-cards.ts';

type Entry = { type: string; byLedung?: boolean; card?: HelperCard; answered?: boolean };

/** A card's key: its id, else its kind and title. */
export function cardKey(card: HelperCard): string {
  return 'id' in card && card.id ? `id:${card.id}` : `${card.kind}:${card.title}`;
}

const persons = (e: Entry) => e.type === 'user' && !e.byLedung;

/** The entries with each turn's cards moved after its other entries and repeats of a key dropped; answered marked. */
export function placeCards<T extends Entry>(raw: T[]): T[] {
  const out: T[] = [];
  let held: T[] = [];
  const flush = () => {
    // The last card of each key in this turn, in the order those last ones came.
    const last = new Map<string, T>();
    for (const c of held) {
      last.delete(cardKey(c.card!));
      last.set(cardKey(c.card!), c);
    }
    out.push(...last.values());
    held = [];
  };
  for (const e of raw) {
    if (e.type === 'card') held.push(e);
    else if (persons(e)) {
      flush();
      out.push(e);
    } else out.push(e);
  }
  flush();
  // Answered once the person wrote anything after it (their pick is their message).
  let later = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (persons(e)) later = true;
    else if (e.type === 'card' && later) out[i] = { ...e, answered: true };
  }
  return out;
}
