// The page leaves Ledung's fixed sentence out of the chat (issue #64); what the model receives keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_SENTENCE, withoutContextSentence } from '../src/shared/delivery.ts';
import { buildDelivery } from '../src/sessions/management.ts';
import type { QuestionInfo } from '../src/shared/protocol.ts';

const sentence = 'Ledung has delivered messages for you. They are attached as context and are not from Simon.';

// The input comes from buildDelivery itself, so a change in how it joins or orders the parts shows here (test review, PR #65).
const answered = (by: string): QuestionInfo =>
  ({ id: 3, question: 'Proceed?', answer: 'yes please', answeredBy: by, forwardedFrom: null }) as unknown as QuestionInfo;
const title = (id: string) => `title-${id}`;

test('a delivery that is only the fixed sentence has no text left', () => {
  const d = buildDelivery('Simon', [], [{ text: 'Message from your manager "M":\n\nUse main.' }], title);
  assert.equal(d.userText, sentence, 'the model still gets the sentence');
  assert.equal(withoutContextSentence(d.userText), '');
  const decided = buildDelivery('Simon', [answered('mgr')], [], title);
  assert.equal(withoutContextSentence(decided.userText), '');
});

test("the user's own answer stays, the fixed sentence after it goes", () => {
  const d = buildDelivery('Simon', [answered('user')], [{ text: 'Message from your manager "M":\n\nUse main.' }], title);
  assert.ok(d.userText.includes(sentence), 'the model still gets the sentence');
  assert.equal(withoutContextSentence(d.userText), 'Answer to your question #3:\n\nyes please');
});

test('a sentence written under an earlier user name still matches', () => {
  assert.equal(withoutContextSentence(CONTEXT_SENTENCE('Martin')), '');
});

test('text without the fixed sentence is left alone', () => {
  assert.equal(withoutContextSentence('Answer to your question #3:\n\nyes please'), 'Answer to your question #3:\n\nyes please');
  // The user typing the sentence followed by more words is not the fixed sentence.
  assert.equal(withoutContextSentence(`${sentence}\nand more`), `${sentence}\nand more`);
});
