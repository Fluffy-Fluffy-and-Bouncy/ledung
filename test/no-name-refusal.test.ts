// Issue #500 (Simon, 2026-11-23, "Go with B"): no shell call is refused or held by its command's name. The PreToolUse
// hook only follows the call for learning; what actually runs is measured and judged (test/resource-limits.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';

function setup(held: boolean) {
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
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default' });
  const followed: { callId: string; kinds: string[] }[] = [];
  // The check the hook used to ask (before #500), refusing everything: if the hook ever asks it again, this test fails.
  const oldCheck = { commandCheck: () => 'This usually uses ~6 GB memory: call reserve first.' };
  const session = new Session({
    info: store.getSession('s')!, store, publish: () => {}, userName: 'Simon', management,
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: {
      mayStart: () => true, started: () => {}, ended: () => {},
      reserve: () => 'Go', release: () => 'Released', resourceHeld: () => held,
      callStarted: (_id, callId, kinds) => followed.push({ callId, kinds }),
      ...oldCheck,
    },
  });
  return { session, followed };
}

const COMMANDS = [
  'python train.py', 'npm run build', 'git status', 'git add -A', './scripts/build-all.sh', 'node scripts/emulator-lock.mjs release',
  'for f in a b; do echo $f; done', 'node -e "const x = 1"', 'bash -c "make -j16"',
];

for (const held of [false, true]) {
  test(`no Bash call is refused by its command's name${held ? ', also while the session is held' : ''}, nor a subagent's (issue #500)`, async () => {
    const { session, followed } = setup(held);
    const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    let n = 0;
    for (const command of COMMANDS) {
      for (const agent of [undefined, 'sub1']) {
        const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(agent ? { agent_id: agent } : {}) } as never, `tu${n++}`, { signal: new AbortController().signal }) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        };
        assert.notEqual(out.hookSpecificOutput?.permissionDecision, 'deny', `${command}${agent ? ' (subagent)' : ''}: ${out.hookSpecificOutput?.permissionDecisionReason}`);
      }
    }
    // Followed for learning: the heavy-looking ones, never the light ones (git status, shell syntax).
    const kinds = new Set(followed.flatMap((f) => f.kinds));
    for (const k of ['python train.py', 'npm run build', 'build-all.sh', 'node scripts/emulator-lock.mjs', 'make']) assert.ok(kinds.has(k), k);
    for (const k of ['git status', 'for', 'const']) assert.ok(!kinds.has(k), k);
  });
}
