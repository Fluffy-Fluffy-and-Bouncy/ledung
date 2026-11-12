import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragWidth, paneLimits, paneWidthForKey, PANES, storageKey } from '../web/src/paneSize.ts';

test('limits: the chat or diagram keeps its room; never below the minimum (issue #198)', () => {
  // Panel and chat share 1000 px: the chat keeps 360.
  assert.deepEqual(paneLimits(PANES['chat-pane'], 1000), { min: 280, max: 640 });
  assert.deepEqual(paneLimits(PANES['flow-panel'], 1000), { min: 256, max: 680 });
  assert.deepEqual(paneLimits(PANES['builder-panel'], 1000.6), { min: 272, max: 680 });
  // A small window: the panel keeps its minimum even if the chat then has less.
  assert.equal(paneLimits(PANES['chat-pane'], 500).max, 280);
  // Two of a kind showing at the one width: they share what the chat leaves.
  assert.deepEqual(paneLimits(PANES['chat-pane'], 1640, 2), { min: 280, max: 640 });
  assert.equal(paneLimits(PANES['chat-pane'], 1000, 0).max, 640);
});

test('dragging: the width runs from the pointer to the panel\'s right edge, clamped', () => {
  assert.equal(dragWidth(1280, 880, 280, 640), 400);
  assert.equal(dragWidth(1280, 1200, 280, 640), 280);
  assert.equal(dragWidth(1280, 100, 280, 640), 640);
  assert.equal(dragWidth(1280, 879.6, 280, 640), 400);
});

test('keys: the handle is on the left, so ← widens and → narrows; Home and End; others ignored', () => {
  assert.equal(paneWidthForKey('ArrowLeft', 400, 280, 640), 420);
  assert.equal(paneWidthForKey('ArrowRight', 400, 280, 640), 380);
  assert.equal(paneWidthForKey('ArrowRight', 290, 280, 640), 280);
  assert.equal(paneWidthForKey('ArrowLeft', 635, 280, 640), 640);
  assert.equal(paneWidthForKey('Home', 400, 280, 640), 280);
  assert.equal(paneWidthForKey('End', 400, 280, 640), 640);
  assert.equal(paneWidthForKey('ArrowUp', 400, 280, 640), null);
  assert.equal(paneWidthForKey('a', 400, 280, 640), null);
});

test('each kind is remembered on its own, in its own variable', () => {
  const kinds = Object.keys(PANES) as (keyof typeof PANES)[];
  assert.equal(new Set(kinds.map(storageKey)).size, kinds.length);
  assert.equal(new Set(kinds.map((k) => PANES[k].variable)).size, kinds.length);
});
