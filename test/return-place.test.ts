// Back from a waiting line's Open comes to the line, not the chat's end (issue #350, acceptance round 1 point 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropReturnPlace, keepReturnPlace, peekReturnPlace, returnScrollTop } from '../web/src/returnPlace.ts';

test('the place is kept per chat until the chat takes it', () => {
  keepReturnPlace('a', { key: '12', offset: 150 });
  keepReturnPlace('b', { key: '40', offset: 219 });
  assert.deepEqual(peekReturnPlace('a'), { key: '12', offset: 150 });
  dropReturnPlace('a');
  assert.equal(peekReturnPlace('a'), undefined);
  assert.deepEqual(peekReturnPlace('b'), { key: '40', offset: 219 }, "another chat's place is its own");
  dropReturnPlace('b');
});

test('the line is put back where it was on screen', () => {
  // Drawn at the end: the line is 2000 px down at scrollTop 1800 (200 below the top); it was 150 below it.
  assert.equal(returnScrollTop(1800, 200, 150), 1850);
  // Was further down than it is now: scroll back up.
  assert.equal(returnScrollTop(1800, -210, 150), 1440);
  // Never above the start.
  assert.equal(returnScrollTop(0, 20, 150), 0);
});
