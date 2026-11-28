// The Range header of a video request (issue #520), as RFC 9110 §14.1.2 and §14.4 give it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteRange } from '../src/server/range.ts';

test('a byte range from its start, or start and end, both ends included; the end is cut to the file', () => {
  assert.deepEqual(byteRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(byteRange('bytes=500-', 1000), { start: 500, end: 999 });
  // Safari's first probe: two bytes, to see ranges work.
  assert.deepEqual(byteRange('bytes=0-1', 1000), { start: 0, end: 1 });
  assert.deepEqual(byteRange('bytes=10-19', 1000), { start: 10, end: 19 });
  assert.deepEqual(byteRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.deepEqual(byteRange('bytes=999-999', 1000), { start: 999, end: 999 });
});

test('the last N bytes; more than the file is the whole file', () => {
  assert.deepEqual(byteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('no header, or one that is not a single byte range, is the whole file', () => {
  for (const h of [undefined, '', 'bytes=', 'bytes=-', 'items=0-10', 'bytes=0-1,5-9', 'bytes=10-5', 'bytes=a-b', 'bytes=99999999999999999999-']) {
    assert.equal(byteRange(h, 1000), 'whole', String(h));
  }
});

test('a range that starts past the end, or asks for no bytes, cannot be satisfied', () => {
  assert.equal(byteRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(byteRange('bytes=1000-2000', 1000), 'unsatisfiable');
  assert.equal(byteRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(byteRange('bytes=0-', 0), 'unsatisfiable');
  assert.equal(byteRange('bytes=-10', 0), 'unsatisfiable');
});
