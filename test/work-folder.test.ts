// A session's own working folder (start_session's cwd, decision of 2026-10-14): only the project folder,
// folders inside it, or folders under the project's extra folders; never out through `..` or links.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { resolveWorkFolder, WorkFolderError } from '../src/sessions/work-folder.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-workdir-')));
const project = path.join(base, 'app');
const worktrees = path.join(base, 'app-wt');
const elsewhere = path.join(base, 'elsewhere');
for (const d of [path.join(project, 'sub', 'deeper'), path.join(worktrees, '12'), elsewhere]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, 'file.txt'), 'x');
// Links out of an allowed folder: a junction on Windows (no admin rights needed), a symlink elsewhere.
fs.symlinkSync(elsewhere, path.join(project, 'escape'), 'junction');
fs.symlinkSync(elsewhere, path.join(worktrees, 'escape'), 'junction');
fs.symlinkSync(path.join(worktrees, '12'), path.join(project, 'to-worktree'), 'junction');
after(() => removeTemp(base));

const refused = (wanted: string, roots: string[] = [], message?: RegExp) =>
  assert.throws(() => resolveWorkFolder(project, roots, wanted), (e) => e instanceof WorkFolderError && (!message || message.test(e.message)));

test('the project folder itself is no folder of its own; folders inside it are, as real paths', () => {
  assert.equal(resolveWorkFolder(project, [], project), null);
  assert.equal(resolveWorkFolder(project, [], '.'), null);
  assert.equal(resolveWorkFolder(project, [], 'sub'), path.join(project, 'sub'));
  assert.equal(resolveWorkFolder(project, [], path.join(project, 'sub', 'deeper')), path.join(project, 'sub', 'deeper'));
  assert.equal(resolveWorkFolder(project, [], 'sub/deeper/..'), path.join(project, 'sub'));
});

test('outside the project is refused, also through ..', () => {
  refused(elsewhere, [], /outside the project/);
  refused('..', [], /outside the project/);
  refused('../elsewhere');
  refused('sub/../../elsewhere');
  refused(path.join(worktrees, '12'), [], /extra folders, such as where its git worktrees go/);
});

test('a link or junction is followed, so it can not lead outside', () => {
  refused('escape', [], /outside the project/);
  refused(path.join(worktrees, 'escape'), [worktrees], /outside the project/);
  // A link inside the project that leads to an allowed place is that place.
  assert.equal(resolveWorkFolder(project, [worktrees], 'to-worktree'), path.join(worktrees, '12'));
  refused('to-worktree', []);
});

test('missing folders and files are refused', () => {
  refused('nope', [], /does not exist/);
  refused(path.join(worktrees, '99'), [worktrees], /does not exist/);
  refused('file.txt', [], /not a folder/);
  refused('   ', [], /No folder/);
  assert.throws(() => resolveWorkFolder(path.join(base, 'gone'), [], 'sub'), /project folder .* does not exist/);
});

test("a folder under one of the project's extra folders is allowed, and only then", () => {
  assert.equal(resolveWorkFolder(project, [worktrees], path.join(worktrees, '12')), path.join(worktrees, '12'));
  assert.equal(resolveWorkFolder(project, [path.join(base, 'missing'), worktrees], path.join(worktrees, '12')), path.join(worktrees, '12'));
  refused(path.join(worktrees, '12'), [path.join(base, 'missing')], /extra folders/);
  // Not a sibling that merely starts with the same name.
  fs.mkdirSync(path.join(base, 'app-wt-other'));
  refused(path.join(base, 'app-wt-other'), [worktrees]);
  refused(path.join(base, 'app2'), [], /does not exist/);
});

test('folder names differ only in case on Windows, so a check there ignores case', { skip: process.platform !== 'win32' }, () => {
  assert.equal(path.relative(resolveWorkFolder(project, [], project.toUpperCase() + path.sep + 'SUB')!, path.join(project, 'sub')), '');
});

test("the local runner starts Claude Code in the session's folder, or else the project folder", () => {
  const config = { name: 'p', runner: 'local' as const, path: project, sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } };
  const options = { command: 'claude', args: [], env: {}, signal: new AbortController().signal } as unknown as SpawnOptions;
  assert.equal(new LocalRunner(config).cwd, project);
  assert.equal(new LocalRunner(config, null).launchSpec(options).cwd, project);
  const wt = new LocalRunner(config, path.join(worktrees, '12'));
  assert.equal(wt.cwd, path.join(worktrees, '12'));
  assert.equal(wt.launchSpec(options).cwd, path.join(worktrees, '12'));
});

test('starting or resuming a session checks its folder before anything runs', async () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    projects: [
      { name: 'p', runner: 'local', path: project, extraFolders: [worktrees] },
      { name: 'c', runner: 'docker', container: 'nope', pathInContainer: '/app' },
    ],
  }), store, () => {}));
  await assert.rejects(manager.start('p', 'task', { cwd: elsewhere }), /outside the project/);
  await assert.rejects(manager.start('p', 'task', { cwd: 'escape' }), /outside the project/);
  await assert.rejects(manager.start('p', 'task', { cwd: path.join(project, 'sub'), role: 'manager' }), /manager always works in the project folder/);
  await assert.rejects(manager.start('c', 'task', { cwd: '/app/sub' }), /not available for container projects/);
  assert.equal(store.listSessions().length, 0, 'nothing is created for a refused folder');
  // A folder that was allowed when the session started but no longer is (the extra folder taken out of
  // the settings, here: never in them) is refused on resume, before a new Claude Code starts.
  store.createSession({ id: 'old', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', workDir: elsewhere });
  store.updateSession('old', { claudeSessionId: 'abc', status: 'ended' });
  await assert.rejects(manager.resume('old'), /outside the project/);
  assert.equal(store.getSession('old')!.status, 'ended');
});
