// Issue #231 (audit O1): a page gets the messages of the session it shows and no other's; everything that is not one
// session's message still reaches every page. And the page's read plus its watch leave no gap.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { ServerEvent, StoredMessage } from '../src/shared/protocol.ts';
import { OpenSession, type OpenSessionView } from '../web/src/openSession.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';
import { WAIT_MS } from './limits.ts';

const TOKEN = 'f'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-session-watch-'));
let port: number;
let origin: string;
let store: Store;
let server: LedungServer;

before(async () => {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  store = new Store(openDatabase(':memory:'));
  for (const id of ['A', 'B', 'C', 'D']) store.createSession({ id, project: 'p', runner: 'local', title: id, parentId: null, permissionMode: 'default', role: 'session' });
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  server = new LedungServer({ port, token: TOKEN, store, manager, webRoot });
  await server.listen();
});

after(async () => {
  await server.close();
  removeTemp(dir);
});

/** A message stored and published the way a session does it (session.ts record, main.ts's broadcast). */
function say(sessionId: string, text: string): StoredMessage {
  const message = store.addMessage(sessionId, 'user', { text });
  server.broadcast({ type: 'message', message });
  return message;
}

/** Polls until `done` holds, failing after WAIT_MS. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (const end = Date.now() + WAIT_MS; !done(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
  }
}

/** A live connection as a page opens it, keeping every event after its hello. */
async function page(): Promise<{ ws: WebSocket; events: ServerEvent[]; next(type: ServerEvent['type']): Promise<ServerEvent> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: COOKIE, origin } });
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (data) => {
      const e = JSON.parse(String(data)) as ServerEvent;
      if (e.type === 'hello') resolve();
      else events.push(e);
    });
    ws.on('error', reject);
  });
  // The next event of a type, each taken once, in the order they came.
  const taken = new Map<string, number>();
  const next = async (type: ServerEvent['type']) => {
    const n = taken.get(type) ?? 0;
    const ofType = () => events.filter((e) => e.type === type);
    await until(() => ofType().length > n, `a ${type} event`);
    taken.set(type, n + 1);
    return ofType()[n]!;
  };
  return { ws, events, next };
}

const watch = (ws: WebSocket, sessionId: string | null) => ws.send(JSON.stringify({ type: 'watch', sessionId }));
/** The message texts a page got, of every session, in order. */
const texts = (events: ServerEvent[]) => events.flatMap((e) => (e.type === 'message' ? [`${e.message.sessionId}:${e.message.data.text}`] : []));

test('a page gets the messages of the session it shows only, none with none shown, and switches without a reload', async () => {
  const [showsA, showsNone, notSaid] = [await page(), await page(), await page()];
  try {
    watch(showsA.ws, 'A');
    watch(showsNone.ws, null);
    assert.deepEqual(await showsA.next('watching'), { type: 'watching', sessionId: 'A' });
    assert.deepEqual(await showsNone.next('watching'), { type: 'watching', sessionId: null });

    say('A', 'a1');
    say('B', 'b1');
    // Not per session: still to every page.
    server.broadcast({ type: 'workflows' });
    for (const p of [showsA, showsNone, notSaid]) await p.next('workflows');
    // The positive branch of the same probe: a page that has not said what it shows (one loaded before this release)
    // still gets every message, so the events were sent and the probe reads them.
    assert.deepEqual(texts(notSaid.events), ['A:a1', 'B:b1']);
    assert.deepEqual(texts(showsA.events), ['A:a1'], 'only the shown session');
    assert.deepEqual(texts(showsNone.events), [], 'no session shown, no messages');

    // Opening B: from Ledung's answer on, B's messages and no longer A's.
    watch(showsA.ws, 'B');
    assert.deepEqual(await showsA.next('watching'), { type: 'watching', sessionId: 'B' });
    say('A', 'a2');
    say('B', 'b2');
    server.broadcast({ type: 'workflows' });
    for (const p of [showsA, showsNone, notSaid]) await p.next('workflows');
    assert.deepEqual(texts(notSaid.events), ['A:a1', 'B:b1', 'A:a2', 'B:b2']);
    assert.deepEqual(texts(showsA.events), ['A:a1', 'B:b2']);
    assert.deepEqual(texts(showsNone.events), []);
  } finally {
    for (const p of [showsA, showsNone, notSaid]) p.ws.close();
  }
});

test("opening a session misses none of its messages: stored before Ledung's answer, between it and the read, and while the read is on its way", async () => {
  say('C', 'before');
  const live = await page();
  const views: OpenSessionView[] = [];
  const get = async (q: string) => (await fetch(`${origin}/api/sessions/C/messages?limit=500${q}`, { headers: { cookie: COOKIE } })).json() as Promise<StoredMessage[]>;
  // Each message is stored at the step it is named after; the steps run exactly when the page reaches them.
  let watchSent = false;
  let reads = 0;
  const open = new OpenSession({
    send: (text) => {
      live.ws.send(text);
      // Stored while the watch is on its way: Ledung has not read it, so this one is not sent to the page.
      if (JSON.parse(text).sessionId === 'C' && !watchSent) {
        watchSent = true;
        say('C', 'in flight');
      }
    },
    messages: async () => {
      // After Ledung's answer and before the read: sent to the page and in the read too.
      say('C', 'before the read');
      const list = await get('');
      // After the read and before the page has it: sent to the page only. Waits until the page shows it, so the
      // read's answer lands after it.
      say('C', 'during the read');
      await until(() => !!views.at(-1)?.messages.some((m) => m.data.text === 'during the read'), 'the live message shown');
      reads++;
      return list;
    },
    messagesBefore: async () => [],
    messagesAfter: async (_id, afterId) => get(`&after=${afterId}`),
    changed: (v) => views.push(v),
  });
  live.ws.on('message', (data) => {
    const e = JSON.parse(String(data)) as ServerEvent;
    if (e.type === 'message') open.message(e.message);
    if (e.type === 'watching') void open.watching(e.sessionId);
  });
  try {
    open.connected();
    open.open('C');
    // The page reads once Ledung has answered; a timer's turn after the read's answer, the page has used it.
    await until(() => reads === 1, 'the read');
    await new Promise((r) => setTimeout(r, 5));
    const want = store.listMessages('C', { limit: 500 }).map((m) => m.data.text);
    assert.deepEqual(want, ['before', 'in flight', 'before the read', 'during the read'], 'the premise: every step stored its message');
    assert.deepEqual(views.at(-1)!.messages.map((m) => m.data.text), want, 'each once, in order, none missed');
    // A's messages never show, though B's page might still be sent one while its watch is on its way.
    open.message(store.addMessage('A', 'user', { text: 'a3' }));
    assert.deepEqual(views.at(-1)!.messages.map((m) => m.data.text), want);
    // After the read, new messages come on the connection.
    say('C', 'after');
    await until(() => views.at(-1)!.messages.length > want.length, 'the message after the read');
    assert.deepEqual(views.at(-1)!.messages.map((m) => m.data.text), [...want, 'after']);
  } finally {
    live.ws.close();
  }
});

test("opened while the connection is down, the page reads at once, and the connection's answer adds what came since", async () => {
  say('D', 'd1');
  const views: OpenSessionView[] = [];
  const get = async (q: string) => (await fetch(`${origin}/api/sessions/D/messages?limit=500${q}`, { headers: { cookie: COOKIE } })).json() as Promise<StoredMessage[]>;
  let live: Awaited<ReturnType<typeof page>> | null = null;
  const open = new OpenSession({
    send: (text) => live!.ws.send(text),
    messages: () => get(''),
    messagesBefore: async () => [],
    messagesAfter: (_id, afterId) => get(`&after=${afterId}`),
    changed: (v) => views.push(v),
  });
  open.open('D');
  await until(() => views.at(-1)?.messages.length === 1, 'read with no connection');
  assert.deepEqual(views.at(-1)!.messages.map((m) => m.data.text), ['d1']);
  // Stored while the page has no connection: nothing sends it to the page.
  say('D', 'd2');
  live = await page();
  live.ws.on('message', (data) => {
    const e = JSON.parse(String(data)) as ServerEvent;
    if (e.type === 'message') open.message(e.message);
    if (e.type === 'watching') void open.watching(e.sessionId);
  });
  try {
    open.connected();
    await live.next('watching');
    await until(() => views.at(-1)?.messages.length === 2, 'caught up after the answer');
    say('D', 'd3');
    await until(() => views.at(-1)?.messages.length === 3, 'the next message on the connection');
    assert.deepEqual(views.at(-1)!.messages.map((m) => m.data.text), ['d1', 'd2', 'd3']);
  } finally {
    live.ws.close();
  }
});
