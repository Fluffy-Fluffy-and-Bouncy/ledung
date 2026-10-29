// A clear after a resume (#24): the clear's turn ends and the session goes back to idle.
// The messages fed in are the ones Claude Code sent in a probe (2026-10-13): on a resumed session,
// "/clear" as the first input gives a conversation reset, a new init and a zero-turn result, nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';

function setup(resume: string | undefined) {
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'default', role: 'manager' });
  const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: 'mgr', permissionMode: 'default' });
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management, resume,
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  // As if start() had connected: deliver() only needs a query to be there, and messages come in through onMessage.
  const s = session as unknown as { q: unknown; onMessage(m: unknown): void };
  s.q = {};
  store.updateSession('s', { status: 'idle' });
  return { store, management, session, feed: (m: unknown) => s.onMessage(m), status: () => store.getSession('s')!.status };
}

const CLEAR_ENDS = [
  { type: 'system', subtype: 'conversation_reset' },
  { type: 'system', subtype: 'init', session_id: 'new-sid', model: 'haiku', claude_code_version: 'x', cwd: '.' },
  { type: 'result', subtype: 'success', num_turns: 0 },
];

for (const resume of [undefined, 'old-sid']) {
  const label = resume ? 'a resumed session' : 'a live session';

  test(`clear_session on ${label}: the clear's turn ends and the session is idle`, async () => {
    const { store, management, session, feed, status } = setup(resume);
    await management.clearSession('mgr', 's');
    store.updateSession('s', { clearDue: Date.now() - 1 });
    session.deliver();
    assert.equal(status(), 'running', 'the clear went in');
    for (const m of CLEAR_ENDS) feed(m);
    assert.equal(status(), 'idle');
  });

  test(`/clear typed by the user on ${label}: the session is idle again`, () => {
    const { session, feed, status } = setup(resume);
    session.send('/clear');
    assert.equal(status(), 'running');
    for (const m of CLEAR_ENDS) feed(m);
    assert.equal(status(), 'idle');
  });
}

test('a slash command typed during a resumed session\'s first turn leaves that turn protected', () => {
  const { session, feed, status } = setup('old-sid');
  session.send('Carry on.');
  session.send('/cost');
  feed({ type: 'result', subtype: 'success', num_turns: 0 });
  assert.equal(status(), 'running', 'the empty result on resume is still not the first turn\'s end');
});

test('an empty result right after a resume still does not end a delivered message\'s turn (spike finding 7)', () => {
  const { session, feed, status } = setup('old-sid');
  session.send('Carry on.');
  assert.equal(status(), 'running');
  feed({ type: 'result', subtype: 'success', num_turns: 0 });
  assert.equal(status(), 'running', 'the empty result on resume is not the turn\'s end');
  feed({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } });
  feed({ type: 'result', subtype: 'success', num_turns: 1 });
  assert.equal(status(), 'idle');
});
