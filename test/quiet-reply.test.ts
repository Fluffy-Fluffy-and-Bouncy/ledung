// The line after an ask_user call is hidden only when it is short, and only after the turn's last tool call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAskUser, isShortText, quietTexts, type TurnEntry } from '../src/shared/quiet-reply.ts';

const text = (t: string, sub = false): TurnEntry => ({ kind: 'text', text: t, sub });
const tool = (name: string, sub = false): TurnEntry => ({ kind: 'tool', name, sub });
const end: TurnEntry = { kind: 'end' };
const ask = 'mcp__ledung__ask_user';

test("ask_user is recognised under Ledung's server name only", () => {
  assert.ok(isAskUser('mcp__ledung__ask_user'));
  assert.ok(!isAskUser('mcp__fleet__ask_user'));
  assert.ok(!isAskUser('mcp__ledung__withdraw_question'));
  assert.ok(!isAskUser('ask_user'));
});

test('short means one paragraph, up to 200 characters, no code or list', () => {
  assert.ok(isShortText('Waiting for your answer on the release.'));
  assert.ok(isShortText('x'.repeat(200)));
  assert.ok(!isShortText('x'.repeat(201)));
  assert.ok(!isShortText(''));
  assert.ok(!isShortText('One.\n\nTwo.'));
  assert.ok(!isShortText('Use `a` ```b```'));
  assert.ok(!isShortText('Options:\n- a\n- b'));
  assert.ok(!isShortText('1. first'));
  assert.ok(isShortText('Line one\nline two'));
});

test('hides the short text after the last tool call when it is ask_user', () => {
  assert.deepEqual([...quietTexts([text('Asking.'), tool(ask), text('Waiting for your answer.'), end])], [2]);
});

test('keeps long text, and text after any other last tool', () => {
  assert.equal(quietTexts([tool(ask), text('x'.repeat(300)), end]).size, 0);
  assert.equal(quietTexts([tool(ask), tool('Bash'), text('Done.'), end]).size, 0);
  assert.equal(quietTexts([text('Hello.'), end]).size, 0);
});

test('a text between ask_user and a later tool call stays', () => {
  assert.equal(quietTexts([tool(ask), text('Meanwhile.'), tool('Read'), end]).size, 0);
});

test('turns are separate, and subagent entries are ignored', () => {
  const entries = [tool(ask), text('Waiting.'), end, text('Thanks, done.'), end];
  assert.deepEqual([...quietTexts(entries)], [1]);
  assert.equal(quietTexts([tool(ask), tool('Read', true), text('Waiting.'), end]).size, 1);
  assert.equal(quietTexts([tool(ask), text('Sub says hi.', true), end]).size, 0);
});
