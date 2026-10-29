// The Files pane's folder tree (issue #225, a test feature): one folder of a session's folder per request,
// read-only, with the file viewer's rules (src/sessions/files.ts). Only inside the folder, on the native real
// path so links, junctions and Windows 8.3 short names can't lead out or hide a dot (#211, #219); dot- and
// $-names hidden at every level, not only for chats; folders holding settings and sign-ins left out; and
// node_modules and what .gitignore names shown greyed, never opened.
import fs from 'node:fs';
import path from 'node:path';
import { FileError } from './files.ts';
import type { TreeEntry, TreeListing } from '../shared/files-pane.ts';
import { gitRead } from './git-read.ts';

export type { TreeEntry, TreeListing };

/** At most this many names per folder; a larger folder says it was cut. */
export const TREE_MAX_ENTRIES = 1000;

export interface TreeRules {
  /** Folders whose contents are never listed, wherever they turn up (AppData, Library, Ledung's data folder). */
  refused: readonly string[];
  /**
   * For a chat: the browse roots, so a dot-folder above the chat's folder counts too (a chat started inside
   * .ssh lists nothing). Empty for a project's session, whose folder may itself be a worktree under .claude.
   */
  hiddenFrom: readonly string[];
}

const HEAVY = new Set(['node_modules']);
const hiddenName = (name: string) => name.startsWith('.') || name.startsWith('$');

/** The native real path (long names, case on disk), or null. The JS realpath keeps an 8.3 name as typed. */
function longName(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** `real` relative to `root` when it is the root or inside it; null otherwise. path.relative ignores case on Windows. */
function within(root: string, real: string): string | null {
  const rel = path.relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : null;
}

/** Why the real path `real` (inside `realRoot`) is not listed, or null. */
function problem(realRoot: string, real: string, rules: TreeRules, refused: string[]): string | null {
  const inside = within(realRoot, real);
  if (inside === null) return 'Only folders inside the session\'s folder can be listed.';
  if (inside.split(path.sep).some(hiddenName)) return 'Hidden folders and files (names starting with . or $) are not listed.';
  if (refused.some((r) => within(r, real) !== null)) return 'Folders where settings and sign-ins are kept are not listed.';
  for (const r of rules.hiddenFrom) {
    const at = longName(r);
    const rel = at === null ? null : within(at, real);
    if (rel && rel.split(path.sep).some(hiddenName)) return 'Hidden folders and files (names starting with . or $) are not listed.';
  }
  return null;
}

/** The folder `rel` (relative to `root`, "" for the root) as a list of names, with the rules above. */
export async function listTree(root: string, rel: string, rules: TreeRules): Promise<TreeListing> {
  const realRoot = longName(root);
  if (!realRoot) throw new FileError(`The folder ${root} does not exist.`);
  const refused = rules.refused.map(longName).filter((r): r is string => r !== null);
  // An absolute path outside the folder is refused as outside, as on Windows; stripping its leading
  // slash below would turn a POSIX one into a missing folder under the root instead (#233).
  if (path.isAbsolute(rel) && /[^\\/]/.test(rel) && within(realRoot, longName(rel) ?? path.resolve(rel)) === null) throw new FileError('Only folders inside the session\'s folder can be listed.');
  const wanted = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const real = longName(path.resolve(realRoot, wanted));
  if (!real) throw new FileError(`There is no folder ${wanted} in the session's folder.`);
  const why = problem(realRoot, real, rules, refused);
  if (why) throw new FileError(why);
  if (!fs.statSync(real).isDirectory()) throw new FileError(`${wanted} is a file, not a folder.`);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(real, { withFileTypes: true });
  } catch (e) {
    throw new FileError(`Can't read that folder: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const at = within(realRoot, real)!.split(path.sep).filter(Boolean).join('/');
  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    if (hiddenName(d.name)) continue;
    const full = path.join(real, d.name);
    let dir: boolean;
    let size: number | null = null;
    // A link or junction is followed only to somewhere the same rules allow (Node reports a junction as a link).
    const target = d.isSymbolicLink() ? longName(full) : full;
    if (!target || problem(realRoot, target, rules, refused)) continue;
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) dir = true;
      else if (st.isFile()) {
        dir = false;
        size = st.size;
      } else continue;
    } catch {
      continue;
    }
    entries.push({ name: d.name, path: at ? `${at}/${d.name}` : d.name, dir, size, skipped: dir && HEAVY.has(d.name) ? 'heavy' : null });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  const truncated = entries.length > TREE_MAX_ENTRIES;
  const shown = entries.slice(0, TREE_MAX_ENTRIES);
  await markIgnored(real, shown);
  return { path: at, entries: shown, truncated };
}

/** Marks what .gitignore leaves out, by asking git in the folder itself; outside a repository nothing is marked. */
async function markIgnored(folder: string, entries: TreeEntry[]): Promise<void> {
  const ask = entries.filter((e) => !e.skipped);
  if (!ask.length) return;
  // A folder is asked with a trailing slash, so a pattern such as "dist/" matches it.
  const names = ask.map((e) => (e.dir ? `${e.name}/` : e.name));
  const r = await gitRead(folder, ['check-ignore', '--stdin', '-z'], { input: names.join('\0') + '\0', timeoutMs: 10000 });
  if (r.code !== 0) return; // 1: none ignored; 128: not a repository.
  const ignored = new Set(r.stdout.split('\0').filter(Boolean).map((n) => n.replace(/\/$/, '')));
  for (const e of ask) if (ignored.has(e.name)) e.skipped = 'ignored';
}
