import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSize, parseStoredSize, sizeForKey, sizeLimits } from '../web/src/sidebarSize.ts';

test('width: default 290, at most half the window, never below the minimum', () => {
  assert.deepEqual(sizeLimits('width', 1280), { min: 220, max: 640, def: 290 });
  assert.deepEqual(sizeLimits('width', 500), { min: 220, max: 250, def: 250 });
  assert.equal(sizeLimits('width', 300).max, 220);
});

test('height: default 55% of the window, at most 75%', () => {
  assert.deepEqual(sizeLimits('height', 800), { min: 120, max: 600, def: 440 });
  assert.equal(sizeLimits('height', 100).def, 120);
});

test('clamping rounds and stays inside the limits', () => {
  assert.equal(clampSize(10, 220, 640), 220);
  assert.equal(clampSize(9999, 220, 640), 640);
  assert.equal(clampSize(300.4, 220, 640), 300);
});

test('stored values: only positive numbers count', () => {
  assert.equal(parseStoredSize('310'), 310);
  for (const bad of [null, '', 'abc', '0', '-5', 'NaN', 'Infinity']) assert.equal(parseStoredSize(bad), null);
});

test('keys: arrows along the axis, Home and End, others ignored', () => {
  assert.equal(sizeForKey('ArrowRight', 'width', 300, 220, 640), 320);
  assert.equal(sizeForKey('ArrowLeft', 'width', 230, 220, 640), 220);
  assert.equal(sizeForKey('ArrowDown', 'width', 300, 220, 640), null);
  assert.equal(sizeForKey('ArrowDown', 'height', 300, 120, 560), 320);
  assert.equal(sizeForKey('ArrowUp', 'height', 300, 120, 560), 280);
  assert.equal(sizeForKey('Home', 'width', 300, 220, 640), 220);
  assert.equal(sizeForKey('End', 'height', 300, 120, 560), 560);
  assert.equal(sizeForKey('a', 'width', 300, 220, 640), null);
});
