// The page's key from its live connection (#104): after Restart Ledung or a dropped connection the old key
// is dead, and a change the user makes in that moment must still go through, not be refused (review M1).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, connectionClosed, connectionHello, openConnection, setReconnect } from '../web/src/api.ts';

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
/** Timers a test leaves behind, cleared so a failing test's late hello can't land in the next one (test review round 3). */
let timers: ReturnType<typeof setTimeout>[] = [];
const later = (fn: () => void) => timers.push(setTimeout(fn, 50));
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
  timers.splice(0).forEach(clearTimeout);
  setReconnect(null);
  connectionClosed();
});

/** The page's live connection, opened the way the page opens it, on a socket the test can close. */
function connection(): EventTarget {
  globalThis.WebSocket = class extends EventTarget {} as unknown as typeof WebSocket;
  return openConnection('ws://127.0.0.1/ws') as unknown as EventTarget;
}

/** Stands in for Ledung: what each request carried, and an answer chosen per request. */
function ledung(answer: (key: string | null, n: number) => number) {
  const keys: (string | null)[] = [];
  globalThis.fetch = (async (_path: string, init: { headers: Record<string, string> }) => {
    const key = init.headers['X-Ledung-Page'] ?? null;
    keys.push(key);
    const status = answer(key, keys.length);
    const body = status === 200 ? {} : { error: "Only Ledung's open page can do this: it can allow a sensitive call." };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return keys;
}

test('a change refused with a key that died with its connection goes again, once, with the new key', async () => {
  const ws = connection();
  connectionHello('old');
  const keys = ledung((key) => {
    if (key === 'old') {
      // Ledung restarted: the old connection closes, then the page reconnects and gets a new key.
      ws.dispatchEvent(new Event('close'));
      later(() => connectionHello('new'));
      return 403;
    }
    return 200;
  });
  await api.send('m1', 'merge #1 when green');
  assert.deepEqual(keys, ['old', 'new']);
});

test('a change made after the connection closed waits for the next key, not the dead one', async () => {
  const ws = connection();
  connectionHello('old');
  ws.dispatchEvent(new Event('close'));
  const keys = ledung(() => 200);
  later(() => connectionHello('back'));
  await api.send('m1', 'hello');
  assert.deepEqual(keys, ['back']);
});

test('a change made while the page has no connection waits for the next key', async () => {
  const keys = ledung(() => 200);
  later(() => connectionHello('back'));
  await api.send('m1', 'hello');
  assert.deepEqual(keys, ['back']);
});

test('a refusal with the live key goes nowhere twice, and says why', async () => {
  connectionHello('live');
  const keys = ledung(() => 403);
  await assert.rejects(api.send('m1', 'hello'), /open page/);
  assert.deepEqual(keys, ['live']);
});

test('reading needs no key and never waits for one', async () => {
  const keys = ledung(() => 200);
  await api.messages('s1');
  assert.deepEqual(keys, [null]);
});

/**
 * The page's own reconnect (useLedung), as it behaves: the dead connection is left and a new one opened, whose hello
 * brings `next` (none: Ledung doesn't answer). Counts how often it was asked.
 */
function reconnects(next: string | null): { count: number } {
  const asked = { count: 0 };
  setReconnect(() => {
    asked.count++;
    connection();
    if (next) later(() => connectionHello(next));
  });
  return asked;
}

// Issue #303: a framed computer page through the relay, after the Mac slept. Ledung dropped the connection; the
// browser never heard it close, so the page still holds the key Ledung no longer has.
test('a change refused for the key the page still holds goes again, once, on a new connection\'s key (#303)', async () => {
  connection();
  connectionHello('dead');
  const asked = reconnects('fresh');
  const keys = ledung((key) => (key === 'fresh' ? 200 : 403));
  await api.send('m1', 'hello');
  assert.deepEqual(keys, ['dead', 'fresh']);
  assert.equal(asked.count, 1);
});

test('a change without a live page\'s key is still refused after the new connection (#104, #303)', async () => {
  connection();
  connectionHello('dead');
  const asked = reconnects('fresh');
  const keys = ledung(() => 403);
  await assert.rejects(api.send('m1', 'hello'), /open page/);
  assert.deepEqual(keys, ['dead', 'fresh']);
  assert.equal(asked.count, 1);
});

test('two changes refused together for the same held key open one new connection (#303)', async () => {
  connection();
  connectionHello('dead');
  const asked = reconnects('fresh');
  const keys = ledung((key) => (key === 'fresh' ? 200 : 403));
  await Promise.all([api.send('m1', 'one'), api.send('m2', 'two')]);
  assert.deepEqual(keys, ['dead', 'dead', 'fresh', 'fresh']);
  assert.equal(asked.count, 1);
});

test('another refusal than the page key\'s does not replace the connection (#303)', async () => {
  connection();
  connectionHello('live');
  const asked = reconnects('fresh');
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Not found.' }), { status: 403 })) as typeof fetch;
  await assert.rejects(api.send('m1', 'hello'), /Not found/);
  assert.equal(asked.count, 0);
});

test('a replaced connection closing late does not end its successor\'s key (#303)', async () => {
  const old = connection();
  connectionHello('old');
  connection();
  connectionHello('new');
  old.dispatchEvent(new Event('close'));
  const keys = ledung(() => 200);
  await api.send('m1', 'hello');
  assert.deepEqual(keys, ['new']);
});
