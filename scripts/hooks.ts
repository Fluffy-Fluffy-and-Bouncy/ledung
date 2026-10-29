// Switches on the committed git hooks in .githooks (issue #48: a push runs `npm run check` first).
// Runs as npm's `prepare` script, so `npm install` / `npm ci` in a clone sets it up with no manual
// step; git keeps core.hooksPath in the clone's shared config, so its worktrees get it too.
//
// It must never make an install fail: without git, outside a git repository (a release copy, a
// tarball) or inside someone else's repository, it changes nothing and says nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HOOKS_PATH = '.githooks';

export type HooksResult = 'set' | 'already' | 'other' | 'no-git' | 'not-repo-root' | 'no-hooks';

export interface HooksOptions {
  /** The git command; a test passes one that doesn't exist to stand for a machine without git. */
  git?: string;
}

/** Points the repository whose root is `root` at its .githooks folder, if it is one. */
export function setupHooks(root: string, o: HooksOptions = {}): { result: HooksResult; message?: string } {
  if (!fs.existsSync(path.join(root, HOOKS_PATH, 'pre-push'))) return { result: 'no-hooks' };
  // npm run from inside a git hook inherits GIT_DIR; without this, git would answer for that repository.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = (...args: string[]) =>
    execFileSync(o.git ?? 'git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  let prefix: string;
  try {
    prefix = git('rev-parse', '--show-prefix');
  } catch {
    return { result: 'no-git' }; // no git, or not a repository
  }
  // A package unpacked inside another repository must not change that repository's hooks.
  if (prefix !== '') return { result: 'not-repo-root' };

  let current = '';
  try {
    current = git('config', '--get', 'core.hooksPath');
  } catch {
    // not set: git exits 1
  }
  if (current === HOOKS_PATH) return { result: 'already' };
  if (current !== '') {
    return {
      result: 'other',
      message: `Git hooks: core.hooksPath is already "${current}", so the pre-push check in ${HOOKS_PATH} is not switched on.`,
    };
  }
  git('config', 'core.hooksPath', HOOKS_PATH);
  // A copy that lost the file mode (an archive) would have git skip the hook as not executable.
  if (process.platform !== 'win32') fs.chmodSync(path.join(root, HOOKS_PATH, 'pre-push'), 0o755);
  return { result: 'set', message: `Git hooks: a push now runs npm run check first (core.hooksPath = ${HOOKS_PATH}).` };
}

/** npm's `prepare` calls this through an import that gives up quietly where scripts/ wasn't copied (a release). */
export function main(): void {
  try {
    const { message } = setupHooks(path.join(import.meta.dirname, '..'));
    if (message) console.log(message);
  } catch (err) {
    console.log(`Git hooks: not switched on (${(err as Error).message}).`);
  }
}

if (import.meta.main) main();
