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
  assert.deepEqual(shape(placeCards([card('A'), person('1'), card('A'), said('Next?')])), ['card:A✓', 'user:1', 'assistant:Next?', 'card:A']);
  // A card never shows before the helper's words of its turn, even for a moment (acceptance round 2, 20).
  assert.deepEqual(shape(placeCards([person('New project'), card('Name')])), ['user:New project']);
});

test("the step's card waits for the helper's words since the last message it was given", async () => {
  const { helperHasSpoken } = await import('../web/src/helper/cardOrder.ts');
  const said = (text: string) => ({ kind: 'sdk', data: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } });
  const tool = { kind: 'sdk', data: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use' }] } } };
  const given = { kind: 'user', data: { text: 'Call me Ada.' } };
  assert.equal(helperHasSpoken([]), false, 'nothing yet: no card at the top');
  assert.equal(helperHasSpoken([{ kind: 'user', data: { from: 'ledung' } }, tool]), false);
  assert.equal(helperHasSpoken([given, tool, said('Hi Ada. Next…'), { kind: 'event', data: {} }]), true);
  assert.equal(helperHasSpoken([said('Hi'), given]), false, 'the person answered: the old card goes');
});

test('the helper\'s same words twice in a turn show once; a card stays in its own turn (acceptance round 1, 6.1 and 6.3)', () => {
  assert.deepEqual(shape(placeCards([person('Skip'), said('Now your first project?'), said('Now your first project?')])),
    ['user:Skip', 'assistant:Now your first project?']);
  // A message from Ledung (an answer delivered) starts a new turn: the review card stays above the next step's words.
  assert.deepEqual(shape(placeCards([said('Proposed.'), card('Review'), ledung, said('Saved. Next: shortcuts.')])),
    ['assistant:Proposed.', 'card:Review', 'user:delivered', 'assistant:Saved. Next: shortcuts.']);
  // The same words in another turn do show.
  assert.deepEqual(shape(placeCards([said('Hi'), person('x'), said('Hi')])), ['assistant:Hi', 'user:x', 'assistant:Hi']);
});

test('a card waits for the end of its turn and a short line after it is narration (acceptance round 3, 20)', () => {
  const turn = [person('New project'), said('Sure. What should it be called?'), card('Name'), said('Waiting for the name.')];
  assert.deepEqual(shape(placeCards(turn, true)), ['user:New project', 'assistant:Sure. What should it be called?'], 'in the turn: no card yet');
  assert.deepEqual(shape(placeCards(turn, false)), ['user:New project', 'assistant:Sure. What should it be called?', 'card:Name']);
  // A real message after the card still shows, and the card goes under it.
  const long = 'x'.repeat(150);
  assert.deepEqual(shape(placeCards([person('a'), said('Hi'), card('C'), said(long)])), ['user:a', 'assistant:Hi', `assistant:${long}`, 'card:C']);
});

test('a card stands right under its turn\'s last words, before a later line such as "Session resumed"', () => {
  const resumed = { type: 'event', text: 'Session resumed.' };
  assert.deepEqual(shape(placeCards([person('a'), said('Pick the folder.'), card('Folder'), resumed, person('b')])),
    ['user:a', 'assistant:Pick the folder.', 'card:Folder✓', 'event:Session resumed.', 'user:b']);
});
