import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceFromBottom, isStuck, restoredScrollTop } from '../web/src/scrollAnchor.ts';

test('a scroller with no height reports no position', () => {
  assert.equal(distanceFromBottom(2000, 0, 0), null);
});

test('distance from the bottom, and sticking within 80 px', () => {
  assert.equal(distanceFromBottom(2000, 1200, 600), 200);
  assert.equal(isStuck(200), false);
  assert.equal(isStuck(79), true);
  assert.equal(distanceFromBottom(2000, 1500, 600), 0);
});

test('resize restores the bottom when stuck and the distance otherwise', () => {
  assert.equal(restoredScrollTop(true, 10, 3000, 500), 2500);
  assert.equal(restoredScrollTop(false, 200, 3000, 500), 2300);
  assert.equal(restoredScrollTop(false, 5000, 3000, 500), 0);
});
