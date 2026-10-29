// The page's folder browser (projects and accounts, P2): folder names only, never files or their
// contents, and on this computer only under the allowed folders (decided 2026-10-11), because Ledung
// may be open to the home network without sign-in. Links and junctions are resolved before checking,
// so they can't lead outside. Defaults come from whoever runs Ledung, never from the code.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FolderEntry {
  name: string;
  path: string;
  /** For a git repository: its branch ("" if unknown). Null otherwise. */
  git: string | null;
  /** The project already at this folder, if any. */
  project: string | null;
}

export interface FolderListing {
  path: string;
  /** One level up, if that is still allowed. */
  parent: string | null;
  /** Where browsing may start: the allowed folders. */
  roots: string[];
  entries: FolderEntry[];
}

export class BrowseError extends Error {}

export function defaultRoots(configured?: string[]): string[] {
  return (configured?.length ? configured : [os.homedir()]).map((r) => path.resolve(r));
}

export function defaultProjectsFolder(configured?: string): string {
  return path.resolve(configured ?? path.join(os.homedir(), 'Projects'));
}

function real(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** True if the folder, with links resolved, is one of the roots or inside one. */
export function isInside(folder: string, roots: string[]): boolean {
  const target = real(folder);
  if (!target) return false;
  return roots.some((r) => {
    const root = real(r);
    if (!root) return false;
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** The branch from .git/HEAD without running git; "" if the repository has no branch checked out. */
export function gitBranch(folder: string): string | null {
  const dotGit = path.join(folder, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return '';
  try {
    const head = fs.readFileSync(path.join(dotGit, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : '';
  } catch {
    return '';
  }
}

const sameFolder = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The folders in one folder on this computer. */
export function listLocal(folder: string | undefined, roots: string[], projects: { name: string; path: string }[]): FolderListing {
  const dir = path.resolve(folder || roots[0]!);
  if (!isInside(dir, roots)) throw new BrowseError('That folder is outside the folders Ledung may show.');
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new BrowseError(`Can't read that folder: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const entries: FolderEntry[] = [];
  for (const d of names) {
    // Hidden and system folders (".git", "$Recycle.Bin") are left out.
    if (d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const full = path.join(dir, d.name);
    if (d.isSymbolicLink()) {
      if (!isInside(full, roots)) continue;
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
    } else if (!d.isDirectory()) continue;
    entries.push({ name: d.name, path: full, git: gitBranch(full), project: projects.find((p) => sameFolder(path.resolve(p.path), full))?.name ?? null });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const up = path.dirname(dir);
  const isRoot = roots.some((r) => sameFolder(r, dir));
  return { path: dir, parent: !isRoot && up !== dir && isInside(up, roots) ? up : null, roots, entries };
}

// --- In a container ----------------------------------------------------------------------------

export interface ContainerInfo {
  name: string;
  image: string;
  /** The container's own default user, if it has one. */
  user: string;
}

export async function listContainers(): Promise<ContainerInfo[]> {
  let out: string;
  try {
    out = (await run('docker', ['ps', '--format', '{{json .}}'], { windowsHide: true, timeout: 15000 })).stdout;
  } catch {
    throw new BrowseError("Docker isn't running, or the docker command isn't available.");
  }
  const rows = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { Names: string; Image: string });
  if (!rows.length) return [];
  const users = new Map<string, string>();
  try {
    const inspect = (await run('docker', ['inspect', '-f', '{{.Name}}\t{{.Config.User}}', ...rows.map((r) => r.Names)], { windowsHide: true, timeout: 15000 })).stdout;
    for (const line of inspect.split('\n')) {
      const [name, user] = line.split('\t');
      if (name) users.set(name.replace(/^\//, ''), (user ?? '').trim());
    }
  } catch {
    // Users stay unknown.
  }
  return rows.map((r) => ({ name: r.Names, image: r.Image, user: users.get(r.Names) ?? '' }));
}

// Lists the folders in "$1" (or the user's home): first line the folder itself, then one line per
// folder: "G<tab>name<tab>branch" for a git repository, "D<tab>name" otherwise.
const CONTAINER_LIST = `
cd -- "\${1:-$HOME}" 2>/dev/null || cd -- "$HOME" 2>/dev/null || cd /
pwd
for d in *; do
  [ -d "$d" ] || continue
  if [ -d "$d/.git" ]; then
    b=$(sed -n 's#^ref: refs/heads/##p' "$d/.git/HEAD" 2>/dev/null)
    printf 'G\\t%s\\t%s\\n' "$d" "$b"
  else
    printf 'D\\t%s\\n' "$d"
  fi
done`;

/** The folders in one folder inside a container (its whole file system; it is the container's own). */
export async function listContainer(
  container: string, user: string | undefined, folder: string | undefined, projects: { name: string; container: string; path: string }[],
): Promise<FolderListing> {
  const u = user ? ['-u', user] : [];
  let out: string;
  try {
    out = (await run('docker', ['exec', ...u, container, 'sh', '-c', CONTAINER_LIST, 'sh', folder ?? ''], {
      windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    })).stdout;
  } catch (e) {
    throw new BrowseError(`Can't look inside "${container}": ${(e as Error).message.split('\n')[0]}`);
  }
  const [dir = '/', ...lines] = out.split('\n').map((l) => l.replace(/\r$/, ''));
  const entries: FolderEntry[] = lines.filter(Boolean).map((l) => {
    const [kind, name = '', branch = ''] = l.split('\t');
    const full = path.posix.join(dir, name);
    return {
      name, path: full, git: kind === 'G' ? branch : null,
      project: projects.find((p) => p.container === container && p.path === full)?.name ?? null,
    };
  });
  return { path: dir, parent: dir === '/' ? null : path.posix.dirname(dir), roots: ['/'], entries };
}

// --- A new project ------------------------------------------------------------------------------

/**
 * Creates a new project's folder and its git repository; with `github`, also a private repository on
 * GitHub through the GitHub CLI. A GitHub failure doesn't undo the folder: it comes back as a warning.
 */
export async function createProjectFolder(
  parent: string, name: string, allowed: string[], github: boolean,
): Promise<{ path: string; warning: string | null; githubUrl: string | null }> {
  const parentDir = path.resolve(parent);
  if (!isInside(parentDir, allowed)) throw new BrowseError('That folder is outside the folders Ledung may use.');
  const dir = path.join(parentDir, name);
  if (fs.existsSync(dir)) throw new BrowseError(`There is already a folder named "${name}" there.`);
  fs.mkdirSync(dir);
  try {
    await run('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true, timeout: 30000 });
  } catch (e) {
    return { path: dir, warning: `The folder was created, but git init failed: ${(e as Error).message.split('\n')[0]}`, githubUrl: null };
  }
  if (!github) return { path: dir, warning: null, githubUrl: null };
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  try {
    const { stdout } = await run('gh', ['repo', 'create', slug, '--private', '--source', dir, '--remote', 'origin'], {
      cwd: dir, windowsHide: true, timeout: 60000,
    });
    return { path: dir, warning: null, githubUrl: stdout.match(/https:\/\/github\.com\/\S+/)?.[0] ?? null };
  } catch (e) {
    return { path: dir, warning: `The project was created, but the GitHub repository wasn't: ${(e as Error).message.split('\n')[0]}`, githubUrl: null };
  }
}
