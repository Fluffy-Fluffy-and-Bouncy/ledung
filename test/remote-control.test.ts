// Remote Control for managers (#19). The query objects are stand-ins for the SDK's, shaped as the issue's
// evidence found them (SDK 0.3.295, 2026-10-12): enableRemoteControl(enabled, name) answers with session_url.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteControl, remoteControlName } from '../src/sessions/remote-control.ts';
import { parseConfig } from '../src/config.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';

const URL = 'https://claude.ai/code/session_01Test';

function sdk(answer: (enabled: boolean, name?: string) => Promise<unknown>) {
  const calls: [boolean, string | undefined][] = [];
  return { calls, q: { enableRemoteControl: (enabled: boolean, name?: string) => (calls.push([enabled, name]), answer(enabled, name)) } };
}

function control(name = 'Shop lead') {
  const notes: string[] = [];
  let changes = 0;
  const rc = new RemoteControl(name, () => changes++, (t) => notes.push(t));
  return { rc, notes, changes: () => changes };
}

test('only managers get Remote Control, named "<project> lead", and the config switch turns it off for all', () => {
  assert.equal(remoteControlName('manager', 'Shop', true), 'Shop lead');
  assert.equal(remoteControlName('session', 'Shop', true), null);
  assert.equal(remoteControlName('manager', 'Shop', false), null);
});

test('the config switch is on unless set to false', () => {
  assert.equal(parseConfig({}).remoteControl, true);
  assert.equal(parseConfig({ remoteControl: false }).remoteControl, false);
});

test('turning it on asks Claude Code once, with the name, and keeps the link', async () => {
  const { q, calls } = sdk(async () => ({ session_url: URL, bridge_session_id: 'cse_01Test' }));
  const { rc, notes, changes } = control();
  await rc.enable(q);
  await rc.enable(q);
  assert.deepEqual(calls, [[true, 'Shop lead']]);
  assert.deepEqual(rc.info, { state: 'on', url: URL, bridge: null, error: null });
  assert.ok(changes() >= 1);
  assert.match(notes.join('\n'), /Remote Control on, as "Shop lead"/);
});

test('an SDK without the method means "unavailable", not a crash', async () => {
  const { rc, notes } = control();
  await rc.enable({});
  assert.equal(rc.info?.state, 'unavailable');
  assert.equal(rc.info?.url, null);
  assert.match(notes.join('\n'), /Remote Control unavailable/);
  await rc.disable({});
});

test('a call that fails, or gives no link, is "unavailable" with the reason', async () => {
  const failing = control();
  await failing.rc.enable(sdk(async () => { throw new Error('Remote Control is disabled by policy'); }).q);
  assert.deepEqual(failing.rc.info, { state: 'unavailable', url: null, bridge: null, error: 'Remote Control is disabled by policy' });
  const empty = control();
  await empty.rc.enable(sdk(async () => undefined).q);
  assert.equal(empty.rc.info?.state, 'unavailable');
});

test('bridge_state messages are kept as the bridge state and leave the link alone', async () => {
  const { rc } = control();
  await rc.enable(sdk(async () => ({ session_url: URL })).q);
  rc.onBridgeState({ state: 'connected' });
  assert.deepEqual(rc.info, { state: 'on', url: URL, bridge: 'connected', error: null });
});

test('stopping turns it off in Claude Code, and the info goes', async () => {
  const { q, calls } = sdk(async (on) => (on ? { session_url: URL } : undefined));
  const { rc, notes } = control();
  await rc.enable(q);
  await rc.disable(q);
  assert.deepEqual(calls.at(-1), [false, undefined]);
  assert.equal(rc.info, null);
  assert.match(notes.at(-1)!, /^Remote Control off\.$/);
});

test('a Claude Code that does not answer the off call does not hold up the stop', async () => {
  const { q } = sdk(async (on) => (on ? { session_url: URL } : new Promise(() => {})));
  const { rc, notes } = control();
  await rc.enable(q);
  const started = Date.now();
  await rc.disable(q, 50);
  assert.ok(Date.now() - started < 2000);
  assert.match(notes.at(-1)!, /turning it off first failed/);
});

// #49: a new manager whose first turn is long, or waits on a permission prompt, must be in the Claude app
// during that turn. The Session is real and goes through start(); only the SDK's query is a stand-in, whose
// messages the test sends, so nothing has come in when start() returns.
async function manager(opts: { resume?: string } = {}) {
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['Shop'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  const info = store.createSession({ id: 'mgr', project: 'Shop', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'default', role: 'manager' });
  const { q, calls } = sdk(async () => ({ session_url: URL }));
  // Messages from Claude Code, one at a time as the test sends them.
  const waiting: ((m: IteratorResult<unknown>) => void)[] = [];
  const sent: unknown[] = [];
  const stream = {
    ...q,
    accountInfo: async () => ({}),
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((r) => waiting.push(r)) }),
  };
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management, resume: opts.resume, remoteControl: 'Shop lead',
    runner: { cwd: '.', prepare: async () => {}, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: (() => stream) as never,
  });
  await session.start();
  const feed = async (m: unknown) => {
    sent.push(m);
    waiting.shift()!({ value: m, done: false });
    await new Promise((r) => setImmediate(r));
  };
  return { calls, sent, feed };
}

const RESULT = { type: 'result', subtype: 'success', num_turns: 1, result: 'done', usage: {}, modelUsage: {} };

test('a new manager turns Remote Control on as its query starts, before any result, and only once', async () => {
  const { calls, sent, feed } = await manager();
  assert.deepEqual(sent, [], 'no message has come in yet');
  assert.deepEqual(calls, [[true, 'Shop lead']], 'on before the first turn has ended');
  await feed(RESULT);
  assert.deepEqual(calls, [[true, 'Shop lead']], 'the first result asks nothing more');
});

test('a resumed manager turns it on as its query starts, as before', async () => {
  const { calls } = await manager({ resume: 'claude-session-1' });
  assert.deepEqual(calls, [[true, 'Shop lead']]);
});
