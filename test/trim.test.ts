// ledung.db stays small (issue #349): images in tool results are stored without their data, a result's text is cut
// at 64 KB with a note the page shows, the results of sessions ended long ago are cut further, and the space comes back.
// Usage, limits, costs, questions and permissions are unchanged by any of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { compactAtStart, HistoryTrimmer, OLD_RESULT_LIMIT, RESULT_LIMIT, trimForStorage } from '../src/store/trim.ts';
import { UsageQueries } from '../src/usage/queries.ts';
import { cutChars, cutNote } from '../src/shared/cut-note.ts';
import { parseConfig } from '../src/config.ts';
import { pathToFileURL } from 'node:url';
import { removeTemp } from './temp.ts';

const DAY = 24 * 60 * 60 * 1000;
// A screenshot as Claude Code streams it: a PNG of about 1.5 MB, base64.
const png = Buffer.alloc(1_100_000, 7).toString('base64');
const big = (n: number, ch = 'x') => ch.repeat(n);

function toolUse(id: string, name = 'Bash', input: Record<string, unknown> = { command: 'npm test' }) {
  return { type: 'assistant', parent_tool_use_id: null, message: { id: `msg-${id}`, model: 'claude-haiku-5-5', content: [{ type: 'text', text: `Running ${id}.` }, { type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } } };
}

function toolResult(id: string, content: unknown, structured?: unknown) {
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...(structured === undefined ? {} : { tool_use_result: structured }) };
}

function storedResult(store: Store, sessionId: string, id: string): any {
  const m = store.allMessages(sessionId).find((x) => x.kind === 'sdk' && x.data.type === 'user' && x.data.message.content[0]?.tool_use_id === id);
  return m!.data.message.content[0];
}

function rowLength(db: DatabaseSync, sessionId: string, id: string): number {
  const r = db.prepare(`SELECT length(data) AS n FROM messages WHERE session_id = ? AND data LIKE ?`).get(sessionId, `%"tool_use_id":"${id}"%`) as { n: number };
  return Number(r.n);
}

test('a big image and a big text result are both stored small', () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'w', parentId: null, permissionMode: 'default' });
  const text = big(RESULT_LIMIT + 300_000, 'y');
  store.addHostLine('s', 1, 1, toolUse('t1', 'Read', { file_path: 'shot.png' }));
  store.addHostLine('s', 2, 2, toolResult('t1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }], { type: 'image', file: { base64: png, type: 'image/png' } }));
  store.addHostLine('s', 3, 3, toolUse('t2'));
  store.addHostLine('s', 4, 4, toolResult('t2', text, { stdout: text, stderr: '' }));

  // The screenshot: the block stays an image (the page shows "[image]" as before), without its data, here or in the copy.
  const image = storedResult(store, 's', 't1');
  assert.equal(image.content[0].type, 'image');
  assert.equal(image.content[0].source, undefined);
  assert.ok(rowLength(db, 's', 't1') < 1000, `stored ${rowLength(db, 's', 't1')} characters for a 1.5 MB screenshot`);
  // The text: its first 64 KB, and how much was cut.
  const result = storedResult(store, 's', 't2');
  assert.equal(result.content, text.slice(0, RESULT_LIMIT));
  assert.equal(cutChars(result), 300_000);
  assert.ok(rowLength(db, 's', 't2') < RESULT_LIMIT + 1000);
  // The tool call itself (name and input) is kept whole.
  const call = store.allMessages('s').find((m) => m.kind === 'sdk' && m.data.type === 'assistant')!;
  assert.deepEqual(call.data, toolUse('t1', 'Read', { file_path: 'shot.png' }));
});

test('a result under the limit, and every other line, are stored as they came', () => {
  const small = toolResult('t', [{ type: 'text', text: 'ok' }], { stdout: 'ok' });
  assert.equal(trimForStorage(small), small);
  for (const m of [toolUse('t'), { type: 'result', subtype: 'success', num_turns: 1, usage: {} }, { type: 'system', subtype: 'init' }]) assert.equal(trimForStorage(m), m);
  // Text blocks share the limit: the second is cut where the first left off.
  const two = trimForStorage(toolResult('t', [{ type: 'text', text: big(40_000) }, { type: 'text', text: big(40_000) }]));
  const blocks = two.message.content[0].content;
  assert.deepEqual(blocks.map((b: any) => b.text.length), [40_000, RESULT_LIMIT - 40_000]);
  assert.equal(cutChars(two.message.content[0]), 80_000 - RESULT_LIMIT);
});

test('the page shows the note under a cut result', () => {
  assert.equal(cutNote(300_000), "Ledung kept only the start of this output (about 293 KB more was cut). The full output is in Claude Code's own transcript of the session.");
  assert.match(cutNote(3 * 1024 * 1024), /about 3\.0 MB more was cut/);
  assert.equal(cutChars({ type: 'tool_result', content: 'x' }), 0);
});

test('the Files pane still finds the folder a session entered, from a cut result', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'w', parentId: null, permissionMode: 'default' });
  const said = `Created worktree at /work/tree on branch x.${big(RESULT_LIMIT)}`;
  store.addHostLine('s', 1, 1, toolUse('e1', 'EnterWorktree', { name: 'x' }));
  store.addHostLine('s', 2, 2, toolResult('e1', said));
  assert.equal(store.lastToolCall('s', ['EnterWorktree'])!.result, said.slice(0, RESULT_LIMIT));
});

/** A database with an old ended session, a recent ended one and a running one, each with usage, a question and a permission. */
function history(db: DatabaseSync, now: number) {
  const store = new Store(db);
  const sessions = [['old', now - 20 * DAY], ['recent', now - 2 * DAY], ['live', null]] as const;
  let seq = 0;
  for (const [id, endedAt] of sessions) {
    store.createSession({ id, project: 'p', runner: 'local', title: id, parentId: null, permissionMode: 'default' });
    for (let i = 0; i < 30; i++) {
      const tid = `${id}-${i}`;
      store.addHostLine(id, ++seq, now - 30 * DAY + seq, toolUse(tid));
      store.addHostLine(id, ++seq, now - 30 * DAY + seq, toolResult(tid, big(10_000 + i)));
      store.addUsage({
        sessionId: id, messageId: `msg-${tid}`, at: now - 30 * DAY + seq, model: 'claude-haiku-5-5', input: 100 + i, cacheWrite: 7, cacheRead: 9, output: 50, thinking: null, cost: 0.001 * i,
        project: 'p', role: 'session', team: null, subagent: null, branch: 'main', trigger: 'user', machine: 'pc',
      });
    }
    store.addHostLine(id, ++seq, now - 30 * DAY + seq, { type: 'result', subtype: 'success', num_turns: 3, usage: { input_tokens: 1 }, total_cost_usd: 0.12 });
    const q = store.createQuestion({ sessionId: id, question: `Merge ${id}?`, options: ['yes', 'no'], addressedTo: 'user' });
    store.answerQuestion(q.id, 'yes', 'Simon');
    store.addMessage(id, 'question', { questionId: q.id });
    store.addMessage(id, 'decision', { permissionId: `perm-${id}`, behavior: 'allowed', by: 'Simon', message: null });
    if (endedAt !== null) store.updateSession(id, { status: 'ended', endedAt });
  }
  store.addLimit({ account: 'default', at: now, kind: 'seven_day', status: 'allowed', utilization: 0.4, resetsAt: now + DAY, data: {} });
  return store;
}

/** Everything that must not change: usage, limits, questions, permissions, grants, and every message but tool results. */
function kept(db: DatabaseSync, store: Store) {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    usage: all('SELECT * FROM usage ORDER BY id'),
    limits: all('SELECT * FROM limits ORDER BY id'),
    questions: all('SELECT * FROM questions ORDER BY id'),
    permissions: all('SELECT * FROM permissions ORDER BY id'),
    grants: all('SELECT * FROM grants ORDER BY id'),
    messages: all(`SELECT * FROM messages WHERE NOT (kind = 'sdk' AND data LIKE '{"type":"user"%') ORDER BY id`),
    report: new UsageQueries(db).report({ period: 'all' }, store.listSessions(), store.latestLimits()),
    perSession: new UsageQueries(db).perSession(),
  };
}

test('the tool results of a session ended over N days ago are cut; usage, limits, costs and questions are unchanged', async () => {
  const db = openDatabase(':memory:');
  const now = Date.now();
  const store = history(db, now);
  const before = kept(db, store);
  const trimmer = new HistoryTrimmer(db, { days: () => 14, now: () => now, pauseMs: 0 });
  const r = await trimmer.run();
  assert.equal(r.sessions, 1, 'only the session ended 20 days ago (the default is 14)');
  assert.equal(r.rows, 30);

  const old = storedResult(store, 'old', 'old-7');
  assert.equal(old.content, big(OLD_RESULT_LIMIT));
  assert.equal(cutChars(old), 10_007 - OLD_RESULT_LIMIT);
  for (const id of ['recent', 'live']) assert.equal(storedResult(store, id, `${id}-7`).content, big(10_007), `${id} is untouched`);
  assert.deepEqual(kept(db, store), before);

  // Done once: a second pass finds nothing; the session resumed and ended again is cut again.
  assert.equal((await trimmer.run()).sessions, 0);
  store.addHostLine('old', 9999, now, toolUse('old-new'));
  store.addHostLine('old', 10000, now, toolResult('old-new', big(9000)));
  store.updateSession('old', { status: 'ended', endedAt: now + 1 });
  const later = new HistoryTrimmer(db, { days: () => 14, now: () => now + 15 * DAY, pauseMs: 0 });
  // Fifteen days on, the session ended 2 days ago is old too: its 30 results, and the one new result of the resumed one.
  assert.deepEqual(await later.run().then((x) => [x.sessions, x.rows]), [2, 31]);
  assert.equal(storedResult(store, 'old', 'old-new').content, big(OLD_RESULT_LIMIT));
});

test('rows stored before #349 are cut once like new ones, in every session, the running ones too', async () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 'live', project: 'p', runner: 'local', title: 'live', parentId: null, permissionMode: 'default' });
  // As a Ledung from before stored them: whole.
  const insert = db.prepare(`INSERT INTO messages (session_id, at, kind, data) VALUES ('live', 1, 'sdk', ?)`);
  insert.run(JSON.stringify(toolUse('shot')));
  insert.run(JSON.stringify(toolResult('shot', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }])));
  insert.run(JSON.stringify(toolResult('log', big(RESULT_LIMIT + 5000))));
  insert.run(JSON.stringify(toolResult('small', big(5000))));
  const trimmer = new HistoryTrimmer(db, { days: () => 14, pauseMs: 0 });
  assert.equal((await trimmer.run()).rows, 2);
  assert.equal(storedResult(store, 'live', 'shot').content[0].source, undefined);
  assert.equal(cutChars(storedResult(store, 'live', 'log')), 5000);
  assert.equal(storedResult(store, 'live', 'small').content, big(5000), 'a running session keeps results under 64 KB whole');
  // Once: a row put back whole is not looked at again.
  insert.run(JSON.stringify(toolResult('log2', big(RESULT_LIMIT + 5000))));
  assert.equal((await trimmer.run()).rows, 0);
});

test('tool results are kept whole for 14 days after a session ends unless the config says otherwise', () => {
  assert.equal(parseConfig({}).keepToolResultsDays, 3);
  assert.equal(parseConfig({ keepToolResultsDays: 30 }).keepToolResultsDays, 30);
  assert.throws(() => parseConfig({ keepToolResultsDays: 0 }));
});

test('a session resumed while a pass runs keeps what it says from then on whole', async () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const now = Date.now();
  // The one-off cut of old rows is done: this pass is only the one for old sessions.
  store.setMeta('tool-results-cut', 'done');
  let seq = 0;
  for (const id of ['a', 'b']) {
    store.createSession({ id, project: 'p', runner: 'local', title: id, parentId: null, permissionMode: 'default' });
    for (let i = 0; i < 30; i++) {
      store.addHostLine(id, ++seq, now, toolUse(`${id}-${i}`));
      store.addHostLine(id, ++seq, now, toolResult(`${id}-${i}`, big(10_000)));
    }
    store.updateSession(id, { status: 'ended', endedAt: now - (id === 'a' ? 21 : 20) * DAY });
  }
  // One short batch at a time, so the test gets in while "a" is being walked.
  const pass = new HistoryTrimmer(db, { days: () => 14, now: () => now, pauseMs: 5, batchChars: 1 }).run();
  await new Promise((r) => setTimeout(r, 1));
  for (const id of ['a', 'b']) store.updateSession(id, { status: 'running' });
  store.addHostLine('a', ++seq, now, toolUse('a-new'));
  store.addHostLine('a', ++seq, now, toolResult('a-new', big(10_000)));
  const r = await pass;
  assert.equal(r.sessions, 1, '"b" was resumed before its turn: skipped');
  assert.equal(storedResult(store, 'a', 'a-29').content, big(OLD_RESULT_LIMIT), 'what "a" said before is cut');
  assert.equal(storedResult(store, 'a', 'a-new').content, big(10_000), 'what it said after the resume is whole');
  assert.equal(storedResult(store, 'b', 'b-0').content, big(10_000));
});

test('a result cut at storage and cut again later counts both cuts', () => {
  const once = trimForStorage(toolResult('t', big(RESULT_LIMIT + 1000)));
  const twice = trimForStorage(once, OLD_RESULT_LIMIT);
  assert.equal(cutChars(twice.message.content[0]), RESULT_LIMIT + 1000 - OLD_RESULT_LIMIT);
});

test('a new database gives freed space back; an old one is switched at a start, and the file shrinks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-trim-'));
  try {
    const fresh = openDatabase(path.join(dir, 'new.db'));
    assert.equal((fresh.prepare('PRAGMA auto_vacuum').get() as any).auto_vacuum, 2);
    fresh.close();

    // An old database: no incremental vacuum, as every one made before #349.
    const file = path.join(dir, 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA auto_vacuum = NONE; CREATE TABLE before_349 (x)');
    raw.close();
    const db = openDatabase(file);
    assert.equal((db.prepare('PRAGMA auto_vacuum').get() as any).auto_vacuum, 0);
    const now = Date.now();
    const store = history(db, now);
    const before = kept(db, store);
    // Small enough to switch at once (below 64 MB the VACUUM takes no time to speak of).
    assert.ok(compactAtStart(db));
    assert.equal((db.prepare('PRAGMA auto_vacuum').get() as any).auto_vacuum, 2);
    assert.equal(compactAtStart(db), null, 'once switched, never again');
    const pages = () => Number((db.prepare('PRAGMA page_count').get() as any).page_count);
    const start = pages();
    const r = await new HistoryTrimmer(db, { days: () => 14, now: () => now, pauseMs: 0 }).run();
    assert.ok(r.reclaimed > 0, 'freed pages are given back');
    assert.ok(pages() < start, `the file shrank from ${start} to ${pages()} pages`);
    assert.equal(Number((db.prepare('PRAGMA freelist_count').get() as any).freelist_count), 0);
    assert.deepEqual(kept(db, store), before);
    db.close();
  } finally {
    removeTemp(dir);
  }
});

/** A database as Ledung made them before #349 (no incremental vacuum), in `dir`. */
function oldDatabase(dir: string): { file: string; db: DatabaseSync } {
  const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA auto_vacuum = NONE; CREATE TABLE before_349 (x)');
  raw.close();
  return { file, db: openDatabase(file) };
}

const autoVacuum = (db: DatabaseSync) => Number((db.prepare('PRAGMA auto_vacuum').get() as any).auto_vacuum);

test('a compaction that fails never stops a start: it is logged and tried again at the next one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-trim-'));
  try {
    const { file, db } = oldDatabase(dir);
    history(db, Date.now());
    db.exec('PRAGMA busy_timeout = 50');
    // Another program holds the database (a DB browser, a second Ledung on the same folder).
    const other = new DatabaseSync(file);
    other.exec('BEGIN IMMEDIATE');
    const lines: string[] = [];
    assert.equal(compactAtStart(db, { log: (l) => lines.push(l) }), null);
    assert.match(lines.at(-1)!, /^Could not give the freed space back: .*locked.*; Ledung tries again at the next start\.$/);
    assert.equal(autoVacuum(db), 0, 'nothing changed');
    other.exec('ROLLBACK');
    other.close();
    // Too little disk for the copy VACUUM writes: not even tried.
    lines.length = 0;
    assert.equal(compactAtStart(db, { log: (l) => lines.push(l), diskFree: () => 1024 }), null);
    assert.match(lines[0]!, /^Could not give the freed space back: the disk has 0\.0 MB free/);
    assert.equal(autoVacuum(db), 0);
    // The next start, with the cause gone, does it.
    assert.ok(compactAtStart(db));
    assert.equal(autoVacuum(db), 2);
    db.close();
  } finally {
    removeTemp(dir);
  }
});

test('a big database is compacted at a start only once half of it is free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-trim-'));
  try {
    const { db } = oldDatabase(dir);
    const store = new Store(db);
    const now = Date.now();
    store.createSession({ id: 'old', project: 'p', runner: 'local', title: 'old', parentId: null, permissionMode: 'default' });
    for (let i = 0; i < 50; i++) {
      store.addHostLine('old', 2 * i + 1, now, toolUse(`t${i}`));
      store.addHostLine('old', 2 * i + 2, now, toolResult(`t${i}`, big(20_000)));
    }
    store.updateSession('old', { status: 'ended', endedAt: now - 20 * DAY });
    // "Big" here is 64 KB, standing for the 64 MB a real start uses: the file is over 1 MB.
    const size = () => Number((db.prepare('PRAGMA page_count').get() as any).page_count) * Number((db.prepare('PRAGMA page_size').get() as any).page_size);
    assert.ok(size() > 1024 * 1024);
    // Nothing free yet: no VACUUM of the whole file at the first start after the release.
    assert.equal(compactAtStart(db, { threshold: 64 * 1024 }), null);
    assert.equal(autoVacuum(db), 0);
    // The shrink frees about nine tenths (20,000 characters to 2,000 per result); the next start compacts.
    await new HistoryTrimmer(db, { days: () => 14, now: () => now, pauseMs: 0 }).run();
    const before = size();
    const c = compactAtStart(db, { threshold: 64 * 1024 });
    assert.ok(c);
    assert.equal(autoVacuum(db), 2);
    assert.ok(size() < before / 2, `the file went from ${before} to ${size()} bytes`);
    db.close();
  } finally {
    removeTemp(dir);
  }
});

test('the conversation shows a cut result with its note, and a screenshot as [image] as before', async () => {
  const { build, stop } = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-trim-page-'));
  const { Window } = await import('happy-dom');
  const win = new Window({ url: 'http://127.0.0.1:4396/' });
  try {
    const out = path.join(dir, 'page.mjs');
    await build({
      stdin: {
        contents: "export { MessageList } from './web/src/components/MessageList.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server.browser';",
        resolveDir: path.join(import.meta.dirname, '..'), loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
      loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    // What the page's modules read from the browser as they load.
    for (const key of ['window', 'document', 'localStorage', 'location', 'matchMedia', 'navigator']) {
      Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
    }
    // React's MessageChannel ports would keep Node from exiting (as in typing-renders.test.ts).
    (globalThis as any).MessageChannel = class {
      port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
      port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
    };
    const page = await import(pathToFileURL(out).href);
    const store = new Store(openDatabase(':memory:'));
    store.createSession({ id: 's', project: 'p', runner: 'local', title: 'w', parentId: null, permissionMode: 'default' });
    store.addHostLine('s', 1, 1, toolUse('t1', 'Read', { file_path: 'shot.png' }));
    store.addHostLine('s', 2, 2, toolResult('t1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]));
    store.addHostLine('s', 3, 3, toolUse('t2'));
    store.addHostLine('s', 4, 4, toolResult('t2', big(RESULT_LIMIT + 300_000, 'y')));
    const html: string = page.renderToStaticMarkup(page.createElement(page.MessageList, {
      messages: store.listMessages('s'), permissions: {}, showTechnical: true, hasEarlier: false, onLoadEarlier: () => {}, questions: {}, userName: 'Simon',
    }));
    const results = [...html.matchAll(/<pre class="tool-result">([^<]*)<\/pre>/g)].map((m) => m[1]!);
    // The screenshot reads [image], as it always did; the text shows as far as the page always showed one (20,000).
    assert.deepEqual(results.map((r) => r.length), ['[image]'.length, 20000]);
    assert.equal(results[0], '[image]');
    assert.equal(html.split(cutNote(300_000).replace(/'/g, '&#x27;')).length - 1, 1, 'one note, under the cut result');
  } finally {
    await win.happyDOM.close();
    await stop();
    removeTemp(dir);
  }
});
