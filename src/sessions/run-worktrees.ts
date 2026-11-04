// A git worktree per run (workflow part 3f, docs/steps/workflow-fit.md, approved by Simon 2026-11-03, question #1593).
// Ledung makes it when the run starts, in the project's .ledung/worktrees/<run>, on a branch of the run's own, and runs
// the project's own setup command there; every session of the run works in it. When the run ends Ledung removes it,
// but only after a plain safety check: nothing uncommitted (untracked files count) and the branch merged into its base
// or pushed with nothing more; otherwise it keeps it and says why. A container project's goes through `docker exec`.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DockerProjectConfig } from '../config.ts';
import { DEFAULT_BRANCH, type FlowWorktree } from '../shared/flow.ts';
import type { RunWorktree } from '../shared/flow-run.ts';
import type { ShellSpawn } from '../runners/shell-run.ts';

/** Where runs' worktrees go, inside the project folder (so its sessions may work there), kept out of git's view. */
export const WORKTREES_FOLDER = '.ledung/worktrees';
/** How long a project's setup command may take in a new worktree; it holds the project's runs meanwhile. */
const SETUP_MS = 5 * 60_000;
const GIT_MS = 120_000;

/** How Ledung reaches a project's git and shell: on this computer, or inside its container. */
export interface WorktreeHost {
  /** The project folder as its sessions see it. */
  root: string;
  join(...parts: string[]): string;
  /** git with these arguments in `cwd`; its output, or an Error with what git said. */
  git(args: string[], cwd: string): Promise<string>;
  /** Adds a line to the repository's own exclude file (never .gitignore, which is the project's), once. */
  exclude(line: string): Promise<void>;
  /** The project's setup command, as a person's "!" command would run in `cwd`. */
  shell(command: string, cwd: string): ShellSpawn;
}

const run = promisify(execFile);
const said = (e: unknown) => {
  const x = e as { stderr?: string; stdout?: string; message?: string };
  return (x.stderr?.trim() || x.stdout?.trim() || x.message || String(e)).split('\n').slice(-6).join('\n');
};

/** A local project's host: git on this computer. */
export function localWorktreeHost(root: string, shell: (command: string, cwd: string) => ShellSpawn): WorktreeHost {
  return {
    root,
    join: (...parts) => path.join(...parts),
    git: async (args, cwd) => {
      try {
        return (await run('git', ['-C', cwd, ...args], { windowsHide: true, timeout: GIT_MS, maxBuffer: 4 * 1024 * 1024 })).stdout;
      } catch (e) {
        throw new Error(said(e));
      }
    },
    exclude: async (line) => {
      const file = path.resolve(root, (await run('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { windowsHide: true, timeout: GIT_MS })).stdout.trim());
      const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (now.split(/\r?\n/).includes(line)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${now && !now.endsWith('\n') ? '\n' : ''}${line}\n`);
    },
    shell,
  };
}

/** A container project's host: git inside its container. */
export function dockerWorktreeHost(project: DockerProjectConfig, shell: (command: string, cwd: string) => ShellSpawn): WorktreeHost {
  const user = project.user ? ['-u', project.user] : [];
  const exec = async (script: string, args: string[]) => {
    try {
      return (await run('docker', ['exec', ...user, project.container, 'sh', '-c', script, 'sh', ...args], { windowsHide: true, timeout: GIT_MS, maxBuffer: 4 * 1024 * 1024 })).stdout;
    } catch (e) {
      throw new Error(said(e));
    }
  };
  return {
    root: project.pathInContainer,
    join: (...parts) => path.posix.join(...parts),
    git: (args, cwd) => exec('cd "$1" && shift && git "$@"', [cwd, ...args]),
    exclude: async (line) => {
      await exec('f=$(git -C "$1" rev-parse --git-path info/exclude) && cd "$1" && mkdir -p "$(dirname "$f")" && { grep -qxF "$2" "$f" 2>/dev/null || printf "%s\\n" "$2" >> "$f"; }', [project.pathInContainer, line]);
    },
    shell,
  };
}

/** A ref as part of a branch name: "#142" → "142", "PR 7" → "pr-7". */
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'none';

/** The branch a run's worktree gets, from the flow's pattern ({id}, {ref}). */
export function branchFor(pattern: string | undefined, run: { id: string; ref: string | null }): string {
  return (pattern ?? DEFAULT_BRANCH).replaceAll('{id}', run.id).replaceAll('{ref}', slug(run.ref ?? ''));
}

/** Runs the setup command in the new worktree; null when it went through, else what it said. */
function setUp(host: WorktreeHost, command: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const spec = host.shell(command, cwd);
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true });
    let out = '';
    const keep = (d: Buffer) => { out = (out + d.toString()).slice(-4000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    // The whole tree, so nothing of it goes on in the worktree (review of 3f); a container's, through its own stop.
    const stopAll = () => {
      if (spec.endInside) void spec.endInside().catch(() => {});
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    };
    const timer = setTimeout(() => { stopAll(); resolve(`it was stopped after ${SETUP_MS / 60000} minutes.`); }, SETUP_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve(e.message); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : `it ended with exit code ${code}: ${out.trim().split('\n').slice(-6).join('\n')}`);
    });
  });
}

/** The ignored files in a worktree, by their path there (folders as git lists them). */
async function ignoredIn(host: WorktreeHost, where: string): Promise<string[]> {
  const out = await host.git(['status', '--porcelain', '--ignored', '--untracked-files=all'], where).catch(() => '');
  return out.split('\n').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3).trim()).sort();
}

/**
 * Makes a run's worktree: from the flow's base (none: the branch the project folder is on), on the run's branch, in
 * .ledung/worktrees/<run>, with the project's setup command run in it. Throws with the reason when git refuses; a setup
 * command that fails leaves the worktree made and says so in `setupProblem`.
 */
export async function makeWorktree(host: WorktreeHost, run: { id: string; ref: string | null }, w: FlowWorktree, setup: string | undefined): Promise<{ worktree: RunWorktree; setupProblem: string | null }> {
  const branch = branchFor(w.branch, run);
  await host.git(['check-ref-format', '--branch', branch], host.root);
  // A detached folder's base is its commit, so "merged" never means whatever it points at later (review of 3f).
  const named = w.base ?? (await host.git(['rev-parse', '--abbrev-ref', 'HEAD'], host.root)).trim();
  const base = !named || named === 'HEAD' ? (await host.git(['rev-parse', 'HEAD'], host.root)).trim() : named;
  await host.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], host.root).catch(() => { throw new Error(`there is no branch or commit "${base}" to start from.`); });
  const where = host.join(host.root, ...WORKTREES_FOLDER.split('/'), run.id);
  // Anchored where the project folder is in its repository, which may be a folder inside it (review of 3f).
  const prefix = (await host.git(['rev-parse', '--show-prefix'], host.root)).trim();
  await host.exclude(`/${prefix}${WORKTREES_FOLDER}/`);
  await host.git(['worktree', 'add', '-b', branch, '--end-of-options', where, base], host.root);
  const setupProblem = setup?.trim() ? await setUp(host, setup, where) : null;
  const ignored = await ignoredIn(host, where);
  return { worktree: { path: where, branch, base, own: true, ...(ignored.length ? { ignored } : {}) }, setupProblem };
}

/**
 * Removes a run's worktree if it is safe (part 3f): nothing uncommitted, untracked files included, and its branch merged
 * into its base or pushed with nothing more; the branch is deleted when merged. Otherwise it stays, with the reason.
 */
export async function removeWorktree(host: WorktreeHost, wt: RunWorktree): Promise<{ removed: true } | { kept: string }> {
  try {
    // Untracked files counted whatever the repository's settings say (review of 3f).
    const dirty = (await host.git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], wt.path)).trim();
    if (dirty) return { kept: `it has changes that are not committed (${dirty.split('\n').length} file${dirty.split('\n').length === 1 ? '' : 's'})` };
    // Its HEAD must be its branch: commits on a detached HEAD, or a rebase or merge under way, would be lost (review of 3f).
    const head = (await host.git(['symbolic-ref', '-q', 'HEAD'], wt.path).catch(() => '')).trim();
    if (head !== `refs/heads/${wt.branch}`) return { kept: `its HEAD is not on its branch ${wt.branch} (${head ? head.replace('refs/heads/', '') : 'detached, or a rebase under way'})` };
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      if (await host.git(['rev-parse', '-q', '--verify', ref], wt.path).then(() => true, () => false)) return { kept: `a ${ref.split('_')[0]!.toLowerCase().replace('cherry', 'cherry-pick')} is under way in it` };
    }
    // Ignored files beyond those it had once set up (an .env, notes, results): git would delete them silently.
    const before = new Set(wt.ignored ?? []);
    const extra = (await ignoredIn(host, wt.path)).filter((f) => !before.has(f));
    if (extra.length) return { kept: `it has ignored files it didn't have when it was made (${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''})` };
    const merged = await host.git(['merge-base', '--is-ancestor', wt.branch, wt.base], host.root).then(() => true, () => false);
    if (!merged) {
      const upstream = await host.git(['rev-parse', '--abbrev-ref', `${wt.branch}@{upstream}`], host.root).then((s) => s.trim(), () => '');
      if (!upstream) return { kept: `its branch ${wt.branch} is neither merged into ${wt.base} nor pushed` };
      const ahead = Number((await host.git(['rev-list', '--count', `${upstream}..${wt.branch}`], host.root)).trim());
      if (ahead > 0) return { kept: `its branch ${wt.branch} has ${ahead} commit${ahead === 1 ? '' : 's'} not pushed and is not merged into ${wt.base}` };
    }
    await host.git(['worktree', 'remove', wt.path], host.root);
    if (merged) await host.git(['branch', '-d', wt.branch], host.root).catch(() => '');
    return { removed: true };
  } catch (e) {
    return { kept: `git refused: ${(e as Error).message}` };
  }
}
