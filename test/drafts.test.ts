// The message box keeps each session's unsent text in this browser until it is sent (issue #73).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDraft, writeDraft, type DraftStore } from '../web/src/drafts.ts';

function memoryStore(): DraftStore & { size: () => number } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    size: () => m.size,
  };
}

test('a typed draft is read back for its own session only', () => {
  const store = memoryStore();
  writeDraft(store, 'a', 'half a thought');
  assert.equal(readDraft(store, 'a'), 'half a thought');
  assert.equal(readDraft(store, 'b'), '');
  writeDraft(store, 'b', 'other');
  assert.equal(readDraft(store, 'a'), 'half a thought');
  assert.equal(readDraft(store, 'b'), 'other');
});

test('text is kept exactly, quotes and blank lines included', () => {
  const store = memoryStore();
  const quoted = '> Claude, 15:02:\n> line one\n> \n> line two\n\n';
  writeDraft(store, 'a', quoted);
  assert.equal(readDraft(store, 'a'), quoted);
});

test('sending (an empty box) removes the saved text', () => {
  const store = memoryStore();
  writeDraft(store, 'a', 'to send');
  writeDraft(store, 'a', '');
  assert.equal(readDraft(store, 'a'), '');
  assert.equal(store.size(), 0);
});

test('a store that throws loses nothing but the draft', () => {
  const broken: DraftStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('full'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.doesNotThrow(() => writeDraft(broken, 'a', 'x'));
  assert.equal(readDraft(broken, 'a'), '');
});
