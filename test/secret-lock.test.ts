// The message box's lock (issue #468): what is locked, the value gone from the box and the saved draft at
// once, and the tokens the box keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipsFor, insertToken, lockInDraft, lockRange, onSecrets, renameToken, secretsChanged } from '../web/src/secretLock.ts';
import { readDraft, writeDraft, type DraftStore } from '../web/src/drafts.ts';
import type { SecretInfo } from '../src/shared/secrets.ts';

function memoryStore(): DraftStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) };
}

const info = (name: string): SecretInfo => ({ id: `id-${name}`, name, env: name.toUpperCase(), lifetime: 'session', createdAt: 0, reachesNow: true });

test('the lock takes the selection without the spaces around it, and never an empty one or one across a token', () => {
  const text = 'password:  hunter2  then';
  assert.deepEqual(lockRange(text, 9, 20), { start: 11, end: 18 });
  assert.deepEqual(lockRange(text, 20, 9), { start: 11, end: 18 }, 'backwards too');
  assert.equal(lockRange(text, 9, 11), null, 'spaces only');
  assert.equal(lockRange(text, 5, 5), null, 'nothing selected');
  const withToken = 'use [🔑 password] now';
  assert.equal(lockRange(withToken, 0, 9), null, 'into a token');
  assert.equal(lockRange(withToken, 6, 18), null, 'across a token');
  assert.deepEqual(lockRange(withToken, 18, 21), { start: 18, end: 21 }, 'beside a token');
});

test('locking replaces the value with its token and writes the saved draft at once: the value is gone from this browser', () => {
  const store = memoryStore();
  const text = 'log in with hunter2 please';
  writeDraft(store, 's1', text);
  const locked = lockInDraft(store, 's1', text, { start: 12, end: 19 }, 'password');
  assert.equal(locked.text, 'log in with [🔑 password] please');
  assert.equal(locked.caret, 12 + '[🔑 password]'.length);
  assert.equal(readDraft(store, 's1'), locked.text);
  assert.ok(![...store.items.values()].some((v) => v.includes('hunter2')), 'nowhere in the store');
});

test('the masked field puts its token at the caret, with spaces where words would run into it', () => {
  assert.deepEqual(insertToken('deploy with', 11, 'npm-token'), { text: 'deploy with [🔑 npm-token]', caret: 26 });
  assert.equal(insertToken('a b', 1, 'k').text, 'a [🔑 k] b');
  assert.equal(insertToken('', 0, 'k').text, '[🔑 k]');
});

test('renaming a chip renames its tokens; removing one takes them out', () => {
  const text = 'use [🔑 secret] and again [🔑 secret]. [🔑 other]';
  assert.equal(renameToken(text, 'secret', 'db-password'), 'use [🔑 db-password] and again [🔑 db-password]. [🔑 other]');
  assert.equal(renameToken(text, 'secret', null), 'use and again . [🔑 other]');
});

test('the chips are the secrets the text names; a name without one shows as removed', () => {
  const chips = chipsFor('a [🔑 pass] b [🔑 gone] [🔑 pass]', [info('pass'), info('unused')]);
  assert.deepEqual(chips.known.map((s) => s.name), ['pass']);
  assert.deepEqual(chips.missing, ['gone']);
});

test('a session\'s secrets reach whatever shows them, and only that session\'s', () => {
  const got: string[][] = [];
  const off = onSecrets('s1', (list) => got.push(list.map((s) => s.name)));
  secretsChanged('s1', [info('a')]);
  secretsChanged('s2', [info('b')]);
  off();
  secretsChanged('s1', [info('c')]);
  assert.deepEqual(got, [['a']]);
});
