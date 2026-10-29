// How much time has passed (issue #265): the time line on every prompt and the state with its duration in list_sessions.
// The zone is pinned so the expected texts are fixed: 12:04 UTC on 20 Oct 2026 is 14:04 summer time in Stockholm.
process.env.TZ = 'Europe/Stockholm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptTimeLine, span, stateFor } from '../src/sessions/elapsed.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';

const MIN = 60_000;
const NOW = new Date('2026-10-20T12:04:00Z');

test('spans are short: minutes, then hours and minutes, then days', () => {
  assert.equal(span(30_000), 'under 1 min');
  assert.equal(span(23 * MIN), '23 min');
  assert.equal(span(120 * MIN), '2 h');
  assert.equal(span(70 * MIN), '1 h 10 min');
  assert.equal(span(47 * 60 * MIN + 59 * MIN), '47 h 59 min');
  assert.equal(span(3 * 24 * 60 * MIN), '3 d');
});

test('the prompt time line: the time with its date and zone, the last message and the session start with how long ago', () => {
  assert.equal(
    promptTimeLine(NOW, NOW.getTime() - 23 * MIN, NOW.getTime() - 119 * MIN),
    'Current local time: Tue 20 Oct 2026 14:04 CEST · last message 13:41 (23 min ago) · session started 12:05 (1 h 59 min)',
  );
});

test('the prompt time line leaves out what does not exist yet, and names the day of an earlier one', () => {
  assert.equal(promptTimeLine(NOW, null, NOW.getTime()), 'Current local time: Tue 20 Oct 2026 14:04 CEST · session started 14:04 (under 1 min)');
  assert.equal(promptTimeLine(NOW, null, null), 'Current local time: Tue 20 Oct 2026 14:04 CEST');
  assert.equal(
    promptTimeLine(NOW, NOW.getTime() - 15 * 60 * MIN, NOW.getTime() - 3 * 24 * 60 * MIN),
    'Current local time: Tue 20 Oct 2026 14:04 CEST · last message Mon 19 Oct 23:04 (15 h ago) · session started Sat 17 Oct 14:04 (3 d)',
  );
});

test('a state with how long it has lasted; an unknown start shows the state alone', () => {
  const now = NOW.getTime();
  assert.equal(stateFor({ status: 'running', statusSince: now - 23 * MIN }, now), 'running for 23 min');
  assert.equal(stateFor({ status: 'idle', statusSince: now - 70 * MIN }, now), 'idle for 1 h 10 min');
  assert.equal(stateFor({ status: 'waiting', statusSince: now - 5 * MIN }, now), 'waiting for an answer for 5 min');
  assert.equal(stateFor({ status: 'ended', statusSince: now - 120 * MIN }, now), 'ended 2 h ago');
  assert.equal(stateFor({ status: 'running', statusSince: null }, now), 'running');
  assert.equal(stateFor({ status: 'waiting' }, now), 'waiting for an answer');
});

test('every prompt gets the time line with the previous prompt, which survives a new session object (a Ledung restart)', async () => {
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
  const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default' });
  const prompt = async () => {
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon', management,
      runner: { cwd: '.', currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const hook = options.hooks!.UserPromptSubmit![0]!.hooks[0]!;
    const out = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' } as never, undefined, { signal: new AbortController().signal });
    return (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  };
  const first = await prompt();
  assert.match(first, /^Current local time: \w{3} \d{1,2} \w{3} \d{4} \d\d:\d\d \S+ · session started \d\d:\d\d \(under 1 min\)$/, 'no earlier message: left out');
  store.addMessage('s', 'user', { text: 'hello' });
  assert.match(await prompt(), / · last message \d\d:\d\d \(under 1 min ago\) · session started /, 'the stored one, after a restart');
});
