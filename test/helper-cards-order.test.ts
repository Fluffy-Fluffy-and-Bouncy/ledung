// The Ledung Helper's cards in its chat (Simon's try-out, 2026-11-12: "messages and input boxes twice"): a card shows
// under the helper's words of its turn, and the same card twice in a turn shows once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCards } from '../web/src/helper/cardOrder.ts';

const card = (title: string, id?: string) => ({ type: 'card', card: { kind: 'text' as const, title, ...(id ? { id } : {}) } });
const said = (text: string) => ({ type: 'assistant', text });
const person = (text: string) => ({ type: 'user', byLedung: false, text });
const ledung = { type: 'user', byLedung: true, text: 'delivered' };
const shape = (xs: { type: string; text?: string; card?: { title: string }; answered?: boolean }[]) =>
  xs.map((x) => x.type === 'card' ? `card:${x.card!.title}${x.answered ? '✓' : ''}` : `${x.type}:${x.text}`);

test('a card shows under the words of its turn, once, and is answered by the person\'s next message', () => {
  assert.deepEqual(shape(placeCards([ledung, card('Your name'), card('Your name'), said('Hi, what should I call you?')])),
    ['user:delivered', 'said', 'card:Your name'].map((s) => s === 'said' ? 'assistant:Hi, what should I call you?' : s));
  assert.deepEqual(shape(placeCards([card('A'), said('x'), person('Ada'), card('B', 'b'), card('B2', 'b'), said('y')])),
    ['assistant:x', 'card:A✓', 'user:Ada', 'assistant:y', 'card:B2']);
  // The same title in another turn is another card.
  assert.deepEqual(shape(placeCards([card('A'), person('1'), card('A')])), ['card:A✓', 'user:1', 'card:A']);
});
