// Names of the user's own for sessions, chats and managers (issue #223; Martin, 2026-10-18 22:02 and 22:03: "I want to be
// able to rename all chats and sessions I belive. espesially the managers and chats"). Claude Code is never started:
// the local runner's prepare refuses, so a started session ends at once, as in the chats tests.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { Management } from '../src/sessions/management.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const prepare = LocalRunner.prototype.prepare;
LocalRunner.prototype.prepare = async function () { throw new Error('no Claude Code in tests'); };

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-names-')));
const home = path.join(base, 'home');
// The home and data folders are the test's own, so no real host record or AppData is ever read.
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
const proj = path.join(home, 'proj');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
after(() => {
  LocalRunner.prototype.prepare = prepare;
  // Windows may hold a file of Ledung's data folder a moment longer: retried, and never the test's failure.
  try {
    removeTemp(base);
  } catch {
    // Left in the temp folder.
  }
});

function ledung(store = new Store(openDatabase(':memory:'))) {
  const events: { type: string; session?: { id: string; title: string } }[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon', browseRoots: [home], chats: { folder: home },
    projects: [{ name: 'acme', runner: 'local', path: proj }],
  }), store, (e) => events.push(e as never)));
  return { store, manager, events };
}

test('a rename stores the name, returns it and tells the page; it is one line, trimmed', async () => {
  const { manager, store, events } = ledung();
  const chat = await manager.startChat({});
  const renamed = manager.renameSession(chat.id, '  Tax   questions\n2026 ');
  assert.equal(renamed.title, 'Tax questions 2026');
  assert.equal(store.getSession(chat.id)!.title, 'Tax questions 2026');
  assert.ok(events.some((e) => e.type === 'session' && e.session?.id === chat.id && e.session.title === 'Tax questions 2026'), 'the page hears of it');
});

test('an empty, over-long or non-text name is refused and changes nothing', async () => {
  const { manager, store } = ledung();
  const chat = await manager.startChat({});
  assert.throws(() => manager.renameSession(chat.id, ''), /cannot be empty/);
  assert.throws(() => manager.renameSession(chat.id, '   \n '), /cannot be empty/);
  assert.throws(() => manager.renameSession(chat.id, 'x'.repeat(81)), /at most 80 characters/);
  assert.throws(() => manager.renameSession(chat.id, 42), /must be text/);
  assert.throws(() => manager.renameSession('nope', 'Name'), /No such session/);
  assert.equal(store.getSession(chat.id)!.title, 'New chat');
  assert.equal(manager.renameSession(chat.id, 'x'.repeat(80)).title, 'x'.repeat(80), '80 is allowed');
});

test('a name survives archive and unarchive, and a restart of Ledung', async () => {
  const { manager, store } = ledung();
  const chat = await manager.startChat({});
  manager.renameSession(chat.id, 'Holiday plans');
  manager.archive(chat.id);
  manager.unarchive(chat.id);
  assert.equal(store.getSession(chat.id)!.title, 'Holiday plans');
  // Restart: a new Ledung on the same database, read back without writing (review of PR #224, finding 1).
  const restarted = ledung(store);
  assert.equal(restarted.store.getSession(chat.id)!.title, 'Holiday plans', 'a new Ledung on the same database keeps it');
});

/** A running chat or session on a fake Claude Code, as in the "!" tests, sharing the manager's store. */
async function running(store: Store, id: string, title: string) {
  const info = store.createSession({ id, project: '~chats', runner: 'local', title, parentId: null, permissionMode: 'default', role: 'session' });
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  const stream = { accountInfo: async () => ({}), [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) };
  const s = new Session({
    info, store, publish: () => {}, userName: 'Simon',
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: '~chats', runner: 'local', path: home } as never),
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: ((args: { prompt: AsyncIterable<SDKUserMessage> }) => { prompt = args.prompt; return stream; }) as never,
  });
  // The fake runner must not refuse here: this session is on a fake Claude Code.
  LocalRunner.prototype.prepare = prepare;
  try {
    await s.start();
  } finally {
    LocalRunner.prototype.prepare = async function () { throw new Error('no Claude Code in tests'); };
  }
  assert.ok(prompt, 'started');
  return s;
}

test('a chat named before its first message keeps its name; one nobody named is titled after it (#211)', async () => {
  const { manager, store } = ledung();
  const named = await running(store, 'named', 'New chat');
  manager.renameSession('named', 'My own name');
  named.send('please look at the invoices');
  assert.equal(store.getSession('named')!.title, 'My own name');
  const plain = await running(store, 'plain', 'New chat');
  plain.send('please look at the invoices');
  assert.equal(store.getSession('plain')!.title, 'please look at the invoices', 'the first-message title still applies to the unnamed');
});

test('a renamed manager keeps its name through a project rename and when it is started again; an unnamed one follows the project', async () => {
  const { manager, store } = ledung();
  const first = await manager.start('acme', undefined, { role: 'manager' });
  assert.equal(first.title, 'Manager: acme');
  manager.renameProject('acme', 'acme2');
  assert.equal(store.getSession(first.id)!.title, 'Manager: acme2', 'not renamed: follows the project (#116)');

  manager.renameSession(first.id, 'Chief');
  manager.renameProject('acme2', 'acme3');
  assert.equal(store.getSession(first.id)!.title, 'Chief', 'a given name is not overwritten by a project rename');
  // It never got going (no Claude Code here), so starting it again makes a new manager: the name carries over.
  const again = await manager.start('acme3', undefined, { role: 'manager' });
  assert.notEqual(again.id, first.id);
  assert.equal(again.title, 'Chief');
});

test('a session a manager starts keeps a name given while it is starting; one nobody named is titled after its task', async () => {
  const { manager, store } = ledung();
  store.createSession({ id: 'lead', project: 'acme', runner: 'local', title: 'Manager: acme', parentId: null, permissionMode: 'default', role: 'manager' });
  // Claude Code is not started here: the start stands in for the seconds a container's start-up takes, during which
  // the user renames the row (review of PR #224, Minor 1); the task is then delivered as usual.
  const { start, deliver } = Session.prototype;
  let renameWhileStarting: string | null = null;
  Session.prototype.start = async function (this: Session) {
    if (renameWhileStarting) manager.renameSession(this.info.id, renameWhileStarting);
  };
  Session.prototype.deliver = function () {};
  try {
    renameWhileStarting = 'Invoice check';
    const named = await manager.start('acme', 'go through the March invoices', { parentId: 'lead' });
    assert.equal(store.getSession(named.id)!.title, 'Invoice check', 'the name given during start-up stays');
    renameWhileStarting = null;
    const plain = await manager.start('acme', 'go through the March invoices', { parentId: 'lead' });
    assert.equal(store.getSession(plain.id)!.title, 'go through the March invoices', 'titled after its task');
  } finally {
    Session.prototype.start = start;
    Session.prototype.deliver = deliver;
  }
});

test('other sessions see the new name: messages from a manager and the list of managers read it by id', () => {
  const { manager, store } = ledung();
  store.createSession({ id: 'm1', project: 'acme', runner: 'local', title: 'Manager: acme', parentId: null, permissionMode: 'default', role: 'manager' });
  store.updateSession('m1', { status: 'idle' });
  store.createSession({ id: 'm2', project: 'other', runner: 'local', title: 'Manager: other', parentId: null, permissionMode: 'default', role: 'manager' });
  store.updateSession('m2', { status: 'idle' });
  manager.renameSession('m1', 'Chief');
  const m = (manager as unknown as { management: Management }).management;
  assert.match(m.listManagers('m2'), /"Chief" \(m1\)/);
  assert.equal(m.title('m1'), 'Chief', 'the name in "Message from manager …", questions and permissions');
});
