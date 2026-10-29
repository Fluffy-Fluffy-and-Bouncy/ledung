// Issue #178: a reconnect adds what an open chat missed instead of replacing it with the newest 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { fetchNewer, PAGE, withNewer } from '../web/src/catchUp.ts';

function chat(count: number) {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const add = (text: string) => store.addMessage('s1', 'user', { text });
  for (let i = 0; i < count; i++) add(`m${i}`);
  // What the messages endpoint answers, with the page size the page asks for.
  const after = async (afterId: number) => store.listMessages('s1', { afterId, limit: PAGE });
  return { store, add, after };
}

test('a reconnect appends what was missed and keeps the earlier messages loaded with Load earlier', async () => {
  const { store, add, after } = chat(700);
  // Opened: the newest 500, then Load earlier for the 200 before them.
  const newest = store.listMessages('s1', { limit: PAGE });
  const shown = [...store.listMessages('s1', { beforeId: newest[0]!.id, limit: PAGE }), ...newest];
  assert.equal(shown.length, 700);
  // Away: three messages arrive that the page never saw.
  for (const t of ['x1', 'x2', 'x3']) add(t);
  const caught = withNewer(shown, await fetchNewer(shown.at(-1)!.id, after));
  assert.equal(caught.length, 703, 'nothing dropped');
  assert.equal(caught[0]!.data.text, 'm0', 'the earlier messages stay');
  shown.forEach((m, i) => assert.equal(caught[i], m, 'the shown messages are kept as they were, in place'));
  assert.deepEqual(caught.slice(-3).map((m) => m.data.text), ['x1', 'x2', 'x3']);
});

test('nothing missed leaves the list as it is', async () => {
  const { store, after } = chat(5);
  const shown = store.listMessages('s1');
  assert.equal(withNewer(shown, await fetchNewer(shown.at(-1)!.id, after)), shown);
});

test('a long absence is fetched page by page', async () => {
  const { store, add, after } = chat(3);
  const shown = store.listMessages('s1');
  for (let i = 0; i < 2 * PAGE + 7; i++) add(`x${i}`);
  const asked: number[] = [];
  const newer = await fetchNewer(shown.at(-1)!.id, (id) => (asked.push(id), after(id)));
  assert.equal(asked.length, 3, 'two full pages, then the rest');
  assert.equal(newer.length, 2 * PAGE + 7);
  assert.equal(withNewer(shown, newer).length, 3 + 2 * PAGE + 7);
});

test('a live message that arrived during the catch-up is kept once, in order', async () => {
  const { store, add, after } = chat(2);
  const shown = store.listMessages('s1');
  add('missed');
  const live = add('live');
  // The live connection delivered the newest one before the catch-up's answer came back.
  const withLive = [...shown, live];
  const caught = withNewer(withLive, await fetchNewer(shown.at(-1)!.id, after));
  assert.deepEqual(caught.map((m) => m.data.text), ['m0', 'm1', 'missed', 'live']);
});

test('a page that does not move forward ends the catch-up instead of asking again forever', async () => {
  const { store } = chat(PAGE);
  const full = store.listMessages('s1', { limit: PAGE });
  let asked = 0;
  // A server that ignores "after" answers the newest page every time.
  const newer = await fetchNewer(full.at(-1)!.id, async () => (asked++, full));
  assert.equal(asked, 1);
  assert.equal(withNewer(full, newer), full, 'and nothing is added twice');
});
