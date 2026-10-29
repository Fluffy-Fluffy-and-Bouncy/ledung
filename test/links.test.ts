import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTickets } from '../src/usage/links.ts';

test('tickets found by the project pattern, once each', () => {
  const config = { pattern: '\\b[A-Z]{2,}-\\d+\\b', url: 'https://tracker.example/{id}' };
  assert.deepEqual(findTickets(['Fix ABC-12 and ABC-12', 'feature/XY-7-login'], config), [
    { id: 'ABC-12', url: 'https://tracker.example/ABC-12' },
    { id: 'XY-7', url: 'https://tracker.example/XY-7' },
  ]);
  assert.deepEqual(findTickets(['ABC-12'], undefined), []);
  assert.deepEqual(findTickets(['ABC-12'], { pattern: '(', url: 'x' }), [], 'a broken pattern finds nothing');
});
