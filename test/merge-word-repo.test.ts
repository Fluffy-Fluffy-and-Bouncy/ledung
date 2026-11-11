// A merge on the person's word runs only in the project's own repository, and typed words count only when typed on
// this computer (Project-Ledung#475). The person's "merge #N" names a PR of the manager's project; the repository
// that is comes from the project's git remote, as `git config --get-regexp` prints it. The expected commands are
// derived from gh's own -R form, [HOST/]OWNER/REPO, not from running the new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { pinMergeRepo, type OwnRepo } from '../src/sessions/sensitive.ts';
import { projectRepo } from '../src/sessions/pr-poll.ts';

const OWN: OwnRepo = { host: 'github.com', owner: 'o', name: 'r' };
const MERGE_SENSITIVE = String.raw`\bgh\s+pr\s+merge\b`;

// ---------------------------------------------------------------- the rule itself

test('a merge that names the project repository with -R runs as sent; one naming another repository is not let through', () => {
  for (const command of ['gh pr merge 12 -R o/r --merge', 'gh pr merge 12 --repo O/R', 'gh pr merge 12 -R github.com/o/r --squash']) {
    assert.equal(pinMergeRepo(command, OWN, false), command, command);
  }
  for (const command of ['gh pr merge 12 -R x/r --merge', 'gh pr merge 12 -R o/other', 'gh pr merge 12 -R ghe.example.com/o/r', 'gh pr merge 12 -R o/r -R x/y']) {
    assert.equal(pinMergeRepo(command, OWN, true), null, command);
  }
  // A project on another host must name its host: without one, -R means github.com.
  const ghe: OwnRepo = { host: 'ghe.example.com', owner: 'o', name: 'r' };
  assert.equal(pinMergeRepo('gh pr merge 12 -R o/r', ghe, true), null);
  assert.equal(pinMergeRepo('gh pr merge 12 -R ghe.example.com/o/r', ghe, true), 'gh pr merge 12 -R ghe.example.com/o/r');
});

test('a merge that names no repository runs only alone and from the project folder, pinned to the project repository', () => {
  assert.equal(pinMergeRepo('gh pr merge 12 --merge', OWN, true), 'gh pr merge 12 --merge -R github.com/o/r');
  assert.equal(pinMergeRepo('gh pr merge 12 --merge', OWN, false), null, 'the shell is outside the project folder');
  assert.equal(pinMergeRepo('cd ../other && gh pr merge 12 --merge', OWN, true), null, 'something else runs with it');
  // A comment is not part of what runs, so the pin is never swallowed by one.
  assert.equal(pinMergeRepo('gh pr merge 12 # merge it', OWN, true), 'gh pr merge 12 -R github.com/o/r');
});

test('with the project repository unknown, no merge is let through', () => {
  assert.equal(pinMergeRepo('gh pr merge 12 -R o/r', null, true), null);
  assert.equal(pinMergeRepo('gh pr merge 12', null, true), null);
});

test("the project repository is origin's, or the only remote's; unclear or not GitHub gives none", () => {
  const state = (config: string) => ({ head: 'main', config, refs: '' });
  assert.deepEqual(projectRepo(state('remote.origin.url https://github.com/o/r.git\nremote.private.url git@github.com:o/p.git')), OWN);
  assert.deepEqual(projectRepo(state('branch.main.remote upstream\nremote.upstream.url git@github.com:o/r.git')), OWN);
  assert.equal(projectRepo(state('remote.a.url https://github.com/o/r\nremote.b.url https://github.com/x/y')), null, 'two remotes, no origin');
  assert.equal(projectRepo(state('remote.origin.url https://gitlab.com/o/r.git')), null, 'not GitHub');
  assert.equal(projectRepo(state('')), null, 'no remote');
});

// ---------------------------------------------------------------- through a manager's PreToolUse hook

function setup() {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-475-')));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-475-other-')));
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Martin', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'auto', role: 'manager' });
  const session = new Session({
    info: store.getSession('mgr')!, store, publish: () => {}, userName: 'Martin', management, away: null as never, devShip: null,
    runner: {
      cwd: folder, currentBranch: async () => null,
      // The project's remotes as git prints them: origin is o/r, and a second remote names another repository.
      gitState: async () => ({ head: 'main', config: 'remote.origin.url https://github.com/o/r.git\nremote.fork.url https://github.com/x/r.git', refs: '' }),
    } as never,
    sensitive: { commandPatterns: [MERGE_SENSITIVE] },
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const s = session as unknown as { q: unknown; ask(question: string, options: string[] | null, about: number | null, aboutRequest?: string | null, details?: { tier: string }): { id: number } };
  s.q = {};
  store.updateSession('mgr', { status: 'idle' });
  let n = 0;
  /** Ledung's PreToolUse answer for the manager's Bash call, with the shell's folder as Claude Code gives it. */
  const hook = async (command: string, cwd: string | null = folder) => {
    const pre = (await session.claudeOptions({ onLine: () => {}, onStderr: () => {} })).hooks!.PreToolUse![0]!.hooks[0]!;
    const out = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'Merge' }, ...(cwd ? { cwd } : {}) } as never, `tu-${++n}`, { signal: new AbortController().signal }) as
      { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
    return { decision: out.hookSpecificOutput?.permissionDecision ?? 'none', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '', updatedInput: out.hookSpecificOutput?.updatedInput };
  };
  return { store, session: s, hook, folder, elsewhere };
}

test("a merge on the person's word: allowed in the project repository, asked in another one or where unclear", async () => {
  const t = setup();
  assert.equal((await t.hook('gh pr merge 12 -R o/r --merge')).decision, 'ask', 'premise: no word yet, asked');
  t.store.addMessage('mgr', 'user', { text: 'merge #12', here: true });
  const named = await t.hook('gh pr merge 12 -R o/r --merge');
  assert.equal(named.decision, 'allow', 'the project repository named with -R');
  assert.match(named.reason, /Martin said yes to merging #12 in what they typed/);
  assert.equal(named.updatedInput, undefined, 'runs as sent');
  assert.equal((await t.hook('gh pr merge 12 -R x/r --merge')).decision, 'ask', "another repository, even one of the project's remotes");
  const bare = await t.hook('gh pr merge 12 --merge');
  assert.equal(bare.decision, 'allow', 'no repository named, from the project folder');
  assert.equal(bare.updatedInput?.command, 'gh pr merge 12 --merge -R github.com/o/r', 'pinned to the project repository');
  assert.equal(bare.updatedInput?.description, 'Merge', 'the rest of the input kept');
  assert.equal((await t.hook('gh pr merge 12 --merge', t.elsewhere)).decision, 'ask', 'no repository named, the shell outside the project folder');
  assert.equal((await t.hook('gh pr merge 12 --merge', null)).decision, 'ask', "no repository named, the shell's folder unknown");
});

test('a typed merge word counts only when typed on this computer; an answer to the manager\'s question counts as before', async () => {
  const t = setup();
  t.store.addMessage('mgr', 'user', { text: 'merge #12' });
  assert.equal((await t.hook('gh pr merge 12 -R o/r')).decision, 'ask', 'typed, but not on this computer');
  // The positive branch: the same words typed on this computer.
  t.store.addMessage('mgr', 'user', { text: 'merge #12', here: true });
  assert.equal((await t.hook('gh pr merge 12 -R o/r')).decision, 'allow', 'typed on this computer');
  // The person's answer to the manager's own question about another PR, wherever they gave it.
  const q = t.session.ask('Merge PR #13?', ['Merge', 'Hold'], null, null, { tier: 'Process' });
  assert.ok(t.store.answerQuestion(q.id, 'Merge', 'user'));
  const answered = await t.hook('gh pr merge 13 -R o/r');
  assert.equal(answered.decision, 'allow');
  assert.match(answered.reason, new RegExp(`in their answer to question #${q.id}`));
  assert.equal((await t.hook('gh pr merge 13 -R x/r')).decision, 'ask', 'and still only in the project repository');
});
