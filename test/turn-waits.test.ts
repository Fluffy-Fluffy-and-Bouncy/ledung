// work_history's work time (issue #254, review of PR #260): a pause or a usage stop holding a tool call is no work, and
// a turn that runs across Restart Ledung is measured from when it really began.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';

function setup(status: 'idle' | 'running' = 'idle') {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default' });
  db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, 's');
  const started: { at?: number }[] = [];
  const ended: { waits?: [number, number][] }[] = [];
  const make = (attachTo?: string) => new Session({
    info: store.getSession('s')!, store, publish: () => {}, userName: 'Simon', management, attachTo,
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: (_id, _t, at) => started.push({ at }), ended: (_id, _c, waits) => ended.push({ waits }) },
  });
  return { db, store, info, make, started, ended };
}

/** The session's turn, begun and ended as its messages do. */
const turn = (s: Session) => s as unknown as { beginTurn(trigger: string): void; endTurn(): void };

test('a tool call held by a pause is a wait the turn hands on, not work', async () => {
  const { make, ended } = setup();
  const session = make();
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const preToolUse = options.hooks!.PreToolUse![0]!.hooks[0]!;
  turn(session).beginTurn('user');
  session.setPaused(true, 'Simon');
  const call = preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as never, 'tu1', { signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 1200));
  session.setPaused(false, 'Simon');
  await call;
  turn(session).endTurn();
  const waits = ended.at(-1)!.waits!;
  assert.equal(waits.length, 1);
  assert.ok(waits[0]![1] - waits[0]![0] >= 1100, `waited ${waits[0]![1] - waits[0]![0]} ms`);
});

test('a tool call that does not wait leaves no wait behind', async () => {
  const { make, ended } = setup();
  const session = make();
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  turn(session).beginTurn('user');
  await options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as never, 'tu1', { signal: new AbortController().signal });
  turn(session).endTurn();
  assert.deepEqual(ended.at(-1)!.waits, []);
});

test('the turn under way is kept with the session, and a reattached session goes on from its real start', () => {
  const { store, make, started } = setup('running');
  const before = Date.now() - 20 * 60_000;
  // The turn began 20 minutes ago, before Restart Ledung; the new Ledung reattaches to the running host.
  store.setTurnStart('s', before);
  const session = make('pipe-of-a-running-host');
  turn(session).beginTurn('user');
  assert.equal(started.at(-1)!.at, before);
  turn(session).endTurn();
  assert.equal(store.turnStart('s'), null, 'cleared when the turn ends');
  // The next turn starts now, as any other.
  turn(session).beginTurn('user');
  assert.ok(started.at(-1)!.at! >= Date.now() - 1000);
  assert.equal(store.turnStart('s'), started.at(-1)!.at);
});

test('a session started fresh never takes an old turn start', () => {
  const { store, make, started } = setup('running');
  store.setTurnStart('s', Date.now() - 60 * 60_000);
  turn(make()).beginTurn('user');
  assert.ok(started.at(-1)!.at! >= Date.now() - 1000);
});

test('a restart that replays only the result ends the kept turn: the next turn starts now (review finding 6)', () => {
  const { store, make, started, ended } = setup('running');
  store.setTurnStart('s', Date.now() - 3 * 60 * 60_000);
  const session = make('pipe-of-a-running-host');
  // The replay brings only the result: no assistant message, so no turn opened here.
  turn(session).endTurn();
  assert.equal(ended.length, 0, 'no turn was open to record');
  assert.equal(store.turnStart('s'), null);
  // Hours later, a person's answer starts the next turn.
  turn(session).beginTurn('user');
  assert.ok(started.at(-1)!.at! >= Date.now() - 1000, 'starts now, not at the kept start');
});
