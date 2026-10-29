// The pre-push hook and the `prepare` step that switches it on (issue #48).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOKS_PATH, setupHooks } from '../scripts/hooks.ts';
import { removeTemp } from './temp.ts';

const repoRoot = path.join(import.meta.dirname, '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-hooks-')));
after(() => removeTemp(base));

// Git hands GIT_DIR and friends to hooks, and this file runs inside one when the pre-push check
// runs it: without this, the git commands below would act on the repository being pushed.
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
Object.assign(env, {
  GIT_CEILING_DIRECTORIES: base, // a temp folder inside some repository still counts as "no repository"
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
process.env.GIT_CEILING_DIRECTORIES = base;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hooksPathOf = (cwd: string) => spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd, env, encoding: 'utf8' }).stdout.trim();

let n = 0;
/** A folder holding the committed hook, as a clone or an unpacked copy would. */
function project(): string {
  const dir = path.join(base, `p${++n}`);
  fs.mkdirSync(path.join(dir, HOOKS_PATH), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, HOOKS_PATH, 'pre-push'), path.join(dir, HOOKS_PATH, 'pre-push'));
  return dir;
}
function repo(): string {
  const dir = project();
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

test('outside a git repository nothing is set and nothing is said', () => {
  assert.deepEqual(setupHooks(project()), { result: 'no-git' });
});

test('without git installed nothing is set and nothing is said', () => {
  assert.deepEqual(setupHooks(repo(), { git: 'ledung-no-such-git' }), { result: 'no-git' });
});

test('in a repository it points core.hooksPath at .githooks, once, and its worktrees get it', () => {
  const dir = repo();
  assert.equal(setupHooks(dir).result, 'set');
  assert.equal(hooksPathOf(dir), '.githooks');
  assert.deepEqual(setupHooks(dir), { result: 'already' });

  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'a');
  const wt = path.join(base, `wt${n}`);
  git(dir, 'worktree', 'add', '-q', wt);
  assert.equal(hooksPathOf(wt), '.githooks');
});

test('a hooks path someone else set is left alone', () => {
  const dir = repo();
  git(dir, 'config', 'core.hooksPath', 'my-hooks');
  const r = setupHooks(dir);
  assert.equal(r.result, 'other');
  assert.match(r.message ?? '', /my-hooks/);
  assert.equal(hooksPathOf(dir), 'my-hooks');
});

test('a copy unpacked inside another repository leaves that repository alone', () => {
  const outer = repo();
  const inner = path.join(outer, 'vendor', 'ledung');
  fs.mkdirSync(path.join(inner, HOOKS_PATH), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, HOOKS_PATH, 'pre-push'), path.join(inner, HOOKS_PATH, 'pre-push'));
  assert.deepEqual(setupHooks(inner), { result: 'not-repo-root' });
  assert.equal(hooksPathOf(outer), '');
});

// One command line through the shell, as npm is a script on every platform (npm.cmd on Windows).
const npm = (cwd: string, ...args: string[]) =>
  spawnSync(['npm', ...args].join(' '), { cwd, env, encoding: 'utf8', shell: true });

test('npm prepare succeeds quietly in a release copy, which has no scripts folder and no git', () => {
  const dir = path.join(base, 'release');
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(dir, 'package.json'));
  const r = npm(dir, 'run', 'prepare', '--silent');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});

test('npm prepare switches the hook on in a clone', () => {
  const dir = repo();
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(dir, 'package.json'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'hooks.ts'), path.join(dir, 'scripts', 'hooks.ts'));
  const r = npm(dir, 'run', 'prepare', '--silent');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hooksPathOf(dir), '.githooks');
});

test('a push runs npm run check: a failing check stops it, a passing one, a delete or no new commits do not', () => {
  const dir = repo();
  // The project's check fails while a file named "fail" exists in the working tree.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { check: 'node check.mjs' } }));
  fs.writeFileSync(path.join(dir, 'check.mjs'), "import fs from 'node:fs';\nif (fs.existsSync('fail')) { console.error('CHECK FAILED'); process.exit(1); }\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'fail\n');
  assert.equal(setupHooks(dir).result, 'set');
  const remote = path.join(base, `remote${n}.git`);
  git(base, 'init', '-q', '--bare', remote);
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  const push = (...args: string[]) => spawnSync('git', ['push', ...args], { cwd: dir, env, encoding: 'utf8' });
  const remoteHas = (ref: string) => spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: remote, env, encoding: 'utf8' }).stdout.trim();

  fs.writeFileSync(path.join(dir, 'fail'), '');
  const refused = push('origin', 'main');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /CHECK FAILED/);
  assert.match(refused.stderr, /npm run check failed, so the push was stopped/);
  assert.equal(remoteHas('refs/heads/main'), '');

  fs.rmSync(path.join(dir, 'fail'));
  const passed = push('origin', 'main');
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /pre-push: running npm run check/);
  assert.equal(remoteHas('refs/heads/main'), git(dir, 'rev-parse', 'HEAD'));

  // With the check failing again, pushes that carry no new commits still go through.
  fs.writeFileSync(path.join(dir, 'fail'), '');
  const sameCommit = push('origin', 'main:copy');
  assert.equal(sameCommit.status, 0, sameCommit.stderr);
  assert.doesNotMatch(sameCommit.stderr, /pre-push: running/);
  assert.equal(remoteHas('refs/heads/copy'), git(dir, 'rev-parse', 'HEAD'));
  const deleted = push('origin', '--delete', 'copy');
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.doesNotMatch(deleted.stderr, /pre-push: running/);
  assert.equal(remoteHas('refs/heads/copy'), '');
});

test('a push that changes the program needs a changelog bullet or a "Changelog: none" trailer (issue #86)', () => {
  const dir = repo();
  // The project's check fails while a file named "fail" exists in the working tree, as in the gate test.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { check: 'node check.mjs' } }));
  fs.writeFileSync(path.join(dir, 'check.mjs'), "import fs from 'node:fs';\nif (fs.existsSync('fail')) { console.error('CHECK FAILED'); process.exit(1); }\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'fail\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 2026-10-14\n- Something old. (no issue)\n');
  assert.equal(setupHooks(dir).result, 'set');
  const remote = path.join(base, `remote${n}.git`);
  git(base, 'init', '-q', '--bare', remote);
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'push', '-q', 'origin', 'main');
  const push = (branch: string) => spawnSync('git', ['push', 'origin', branch], { cwd: dir, env, encoding: 'utf8' });
  const branch = (name: string, change: () => void, message = 'change') => {
    git(dir, 'switch', '-q', '-c', name, 'main');
    change();
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
  };
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };

  const bullet = () => fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- Something new. (#1)\n');
  const remoteHas = (ref: string) => spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: remote, env, encoding: 'utf8' }).stdout.trim();

  // Each watched folder is refused on its own, and nothing runs the check after a refusal.
  const watched: [string, string][] = [['src', 'src/a.ts'], ['web-src', 'web/src/a.ts'], ['web-public', 'web/public/a.png'], ['web-index', 'web/index.html'], ['scripts', 'scripts/a.ts']];
  for (const [name, file] of watched) {
    branch(`no-line-${name}`, () => write(file, 'a\n'));
    const refused = push(`no-line-${name}`);
    assert.notEqual(refused.status, 0, file);
    assert.match(refused.stderr, /adds no '- ' bullet to CHANGELOG\.md/);
    assert.doesNotMatch(refused.stderr, /pre-push: running/);
    assert.equal(remoteHas(`refs/heads/no-line-${name}`), '');
  }

  // A logged change still meets npm run check: it runs, and a failing one stops the push.
  branch('with-line', () => {
    write('src/b.ts', 'b\n');
    bullet();
  });
  const logged = push('with-line');
  assert.equal(logged.status, 0, logged.stderr);
  assert.match(logged.stderr, /pre-push: running npm run check/);
  assert.equal(remoteHas('refs/heads/with-line'), git(dir, 'rev-parse', 'HEAD'));

  fs.writeFileSync(path.join(dir, 'fail'), '');
  branch('with-line-failing', () => {
    write('src/c.ts', 'c\n');
    bullet();
  });
  const failing = push('with-line-failing');
  assert.notEqual(failing.status, 0);
  assert.match(failing.stderr, /CHECK FAILED/);
  assert.match(failing.stderr, /npm run check failed, so the push was stopped/);
  assert.equal(remoteHas('refs/heads/with-line-failing'), '');
  fs.rmSync(path.join(dir, 'fail'));

  branch('trailer', () => write('scripts/c.ts', 'c\n'), 'Refactor\n\nChangelog: none');
  const trailer = push('trailer');
  assert.equal(trailer.status, 0, trailer.stderr);
  assert.match(trailer.stderr, /pre-push: running npm run check/);

  // Build output, if it is ever tracked, is not a change anyone made.
  branch('build-output', () => write('web/dist/e.js', 'e\n'));
  const dist = push('build-output');
  assert.equal(dist.status, 0, dist.stderr);

  branch('docs-only', () => write('docs/d.md', 'd\n'));
  const docs = push('docs-only');
  assert.equal(docs.status, 0, docs.stderr);
  assert.match(docs.stderr, /pre-push: running npm run check/);
});
