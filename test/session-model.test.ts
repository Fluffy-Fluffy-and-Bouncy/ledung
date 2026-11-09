// The sidebar menu's Change model (Simon, 2026-11-06): a running session changes through the SDK's setModel from its
// next reply, an ended one keeps the choice for its resume; either way it is the session's requestedModel, which a
// resume starts with, as start_session's model is. The query is a stand-in for the SDK's Query (setModel(model?)).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-model-')));
const home = path.join(base, 'home');
// The home and data folders are the test's own, so no real host record or AppData is ever read.
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
after(() => {
  try {
    removeTemp(base);
  } catch {
    // Left in the temp folder.
  }
});

/** A running Session whose query records each setModel, failing when told to. */
async function running(opts: { defaultModel?: string; fail?: boolean; start?: boolean } = {}) {
  const store = new Store(openDatabase(':memory:'));
  const info = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session', requestedModel: 'haiku' });
  const asked: (string | undefined)[] = [];
  const stream = {
    accountInfo: async () => ({}),
    setModel: async (model?: string) => {
      if (opts.fail) throw new Error('Claude Code said no');
      asked.push(model);
    },
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
  };
  const events: string[] = [];
  const launched: (string | undefined)[] = [];
  const s = new Session({
    info, store, publish: (e) => events.push(e.type), userName: 'Simon', model: 'haiku', defaultModel: opts.defaultModel,
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: base } as never),
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: ((args: { options: { model?: string } }) => { launched.push(args.options.model); return stream; }) as never,
  });
  if (opts.start !== false) await s.start();
  return { s, store, asked, events, launched };
}

const notes = (store: Store) => store.listMessages('s1', { limit: 50 }).filter((m) => m.kind === 'event').map((m) => String(m.data.text));

test('a running session changes model through setModel, keeps it for a resume and says so in its history', async () => {
  const { s, store, asked, events } = await running();
  await s.setModel('sonnet', 'user');
  assert.deepEqual(asked, ['sonnet']);
  assert.equal(store.getSession('s1')!.requestedModel, 'sonnet', 'what a resume starts with');
  assert.ok(notes(store).some((t) => t.includes('Model set to sonnet by Simon')));
  assert.ok(events.includes('session'), 'the page hears of it');
});

test("the project's default is named outright, never left to Claude Code's own default", async () => {
  const { s, store, asked } = await running({ defaultModel: 'opus' });
  await s.setModel(null, 'user');
  assert.deepEqual(asked, ['opus']);
  assert.equal(store.getSession('s1')!.requestedModel, null);
});

test('a session still starting gets the model it starts with: no SDK call before Claude Code is there', async () => {
  const { s, store, asked, launched } = await running({ start: false });
  await s.setModel('opus', 'user');
  assert.deepEqual(asked, []);
  assert.equal(store.getSession('s1')!.requestedModel, 'opus');
  await s.start();
  assert.deepEqual(launched, ['opus'], 'Claude Code is started with it');
});

test("a default only the project's Claude settings name isn't sent by name: it waits for the resume, which reads them", async () => {
  const { s, store, asked } = await running();
  await s.setModel(null, 'user');
  assert.deepEqual(asked, [], "setModel(undefined) would be Claude Code's own default, not the project's");
  assert.equal(store.getSession('s1')!.requestedModel, null);
  assert.ok(notes(store).some((t) => t.includes('applies when the session is resumed')));
});

test('a change Claude Code refuses leaves the stored model as it was', async () => {
  const { s, store } = await running({ fail: true });
  await assert.rejects(s.setModel('opus', 'user'), /Claude Code said no/);
  assert.equal(store.getSession('s1')!.requestedModel, 'haiku');
});

test('an ended session keeps the choice for its resume; only the offered models are taken', async () => {
  const prepare = LocalRunner.prototype.prepare;
  // Claude Code is never started: the chat ends at once, as in the chats tests.
  LocalRunner.prototype.prepare = async function () { throw new Error('no Claude Code in tests'); };
  try {
    const store = new Store(openDatabase(':memory:'));
    const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', browseRoots: [home], chats: { folder: home }, projects: [] }), store, () => {}));
    const chat = await manager.startChat({});
    assert.equal(store.getSession(chat.id)!.status, 'ended');
    assert.equal((await manager.setModel(chat.id, 'opus')).requestedModel, 'opus');
    assert.ok(store.listMessages(chat.id, { limit: 50 }).some((m) => String(m.data.text).includes('applies when the session is resumed')));
    assert.equal((await manager.setModel(chat.id, null)).requestedModel, null);
    await assert.rejects(manager.setModel(chat.id, 'gpt-5'), /Choose opus, sonnet, haiku/);
    await assert.rejects(manager.setModel(chat.id, 42), /Choose/);
    await assert.rejects(manager.setModel('nope', 'opus'), /No such session/);
    assert.equal(store.getSession(chat.id)!.requestedModel, null);
  } finally {
    LocalRunner.prototype.prepare = prepare;
  }
});
