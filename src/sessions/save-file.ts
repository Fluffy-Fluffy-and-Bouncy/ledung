// Writing a file a linked computer sent into one of the manager's own sessions' worktree (issue #160): the first write
// into a session's folder at a path an agent chooses, so it is its own module, beside the read-only file viewer
// (src/sessions/files.ts). Martin allowed it as its own card (question #597: "a — Yes, but as a follow-up").
//
// The rules, each a refusal with its reason and nothing written (the PC lead's refine notes on #160):
// - the path is relative, with no empty, "." or ".." segment, and no segment starting with a dot (.git, .env, .claude:
//   the chat viewer's rule, hiddenProblem in files.ts), nor a character a Windows file name can't hold;
// - its extension is the file's kind, so a received text never becomes a script or a config file;
// - not one of the sensitive path patterns, not Ledung's file of locked secrets, not inside another locked project;
// - no folder on the way and not the file itself is a link or junction, walked again after the bytes are written, as
//   the flow builder's writer does it (localWriter in flow-files.ts; security review of PR #89, finding 4);
// - never over anything already there, a dangling link included: the file is hard-linked into place, which fails if
//   the name is taken, where a rename would replace it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { linkedKindLabel, type LinkedKind } from '../remote/stream-kinds.ts';
import { within } from '../projects/lockdown.ts';
import { SECRET_RUNTIME_PATTERN } from '../shared/secrets.ts';
import { FileError } from './files.ts';

/** The extensions a saved file may have, by its kind (the kinds a linked computer can send, issue #158). */
export const SAVE_EXTENSIONS: Record<LinkedKind, readonly string[]> = {
  png: ['.png'], jpeg: ['.jpg', '.jpeg'], text: ['.txt', '.log', '.md'],
  // Streamed kinds (issue #159): the one extension each is recognised by.
  wav: ['.wav'], mp3: ['.mp3'], flac: ['.flac'], ogg: ['.ogg'], m4a: ['.m4a'], zip: ['.zip'],
};

export interface SaveRules {
  /** The sensitive path patterns, the config's and the project's: case-insensitive regular expressions. */
  pathPatterns: readonly string[];
  /** Folders the file may never land in: every other locked project's (extraFolders can overlap one). */
  refused: readonly string[];
}

export interface Saved {
  /** The path in the worktree, with forward slashes. */
  inside: string;
  /** The full path it was written to. */
  full: string;
  size: number;
  sha: string;
}

// Characters no Windows file name holds (":" also opens an alternate data stream), and control characters.
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Why `rel` can't be a saved file's path in a worktree, before anything on disk is looked at; else its segments. */
export function pathProblem(rel: string, kind: LinkedKind): string | string[] {
  if (typeof rel !== 'string' || !rel.trim()) return 'Give the path in the worktree to save it to.';
  if (rel.includes('\u0000')) return 'The path holds a NUL character.';
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return `${rel} is not a path inside the worktree; give it relative to the worktree, e.g. evidence/shot.png.`;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return `${rel} is not a plain path inside the worktree: no empty, "." or ".." part.`;
  if (parts.some((p) => p.startsWith('.'))) return `${rel} is a hidden path (a part starts with a dot, as .git, .env or .claude do); Ledung saves no file there.`;
  const bad = parts.find((p) => BAD_CHARS.test(p) || /[ .]$/.test(p));
  if (bad !== undefined) return `${rel}: "${bad}" is not a file or folder name that works on every computer.`;
  const ext = path.extname(parts[parts.length - 1]!).toLowerCase();
  const allowed = SAVE_EXTENSIONS[kind];
  if (!allowed.includes(ext)) return `${rel} must end in ${allowed.join(' or ')}: the file is ${kind === 'text' ? 'text' : kind === 'png' || kind === 'jpeg' ? `a ${kind === 'png' ? 'PNG' : 'JPEG'} image` : linkedKindLabel(kind)}.`;
  return parts;
}

/**
 * Saves `bytes` (already checked against what was sent) at `rel` inside the worktree `root`. Missing folders are made
 * one at a time, never through a link. Throws a FileError with the reason; on a refusal nothing is left behind.
 * `hooks` are for tests: `beforePlace` a step between writing the bytes and the second walk, `beforeLink` one between
 * the second walk and putting the file in place, where a folder on the way can be swapped for a link.
 *
 * A streamed copy (issue #159) comes as its file and SHA-256 instead: copied, never read whole, and the copy hashed
 * before it goes in place, so what lands is the bytes that were checked when they came.
 */
export function saveIntoWorktree(root: string, rel: string, kind: LinkedKind, bytes: Buffer | { file: string; sha: string }, rules: SaveRules, hooks: { beforePlace?: (target: string) => void; beforeLink?: (target: string) => void } = {}): Saved {
  const checked = pathProblem(rel, kind);
  if (typeof checked === 'string') throw new FileError(checked);
  const parts = checked;
  const inside = parts.join('/');
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    throw new FileError("The session's worktree is not there.");
  }
  const full = path.join(realRoot, ...parts);
  for (const p of rules.pathPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, 'i');
    } catch {
      continue;
    }
    if (re.test(inside) || re.test(full) || re.test(full.split(path.sep).join('/'))) throw new FileError(`${inside} matches the sensitive path pattern /${p}/; Ledung saves no file there.`);
  }
  if (SECRET_RUNTIME_PATTERN.test(full)) throw new FileError(`${inside} is where Ledung keeps locked secrets; Ledung saves no file there.`);
  // within compares real paths where they exist, so a link to a locked folder can't hide it. It takes them with the JS
  // realpath, which keeps an 8.3 name as typed (C:\Users\RUNNER~1) where the worktree's real path above has the long
  // one; so both sides are also taken in the native form, and compared without case where the disk ignores it
  // (Windows CI on PR #172: a save into a locked folder went through).
  const locked = (at: string) => rules.refused.some((f) => within(f, at) || nativeWithin(f, at));
  // The full path only: it is inside the worktree, so a worktree inside a locked folder is refused by it too.
  if (locked(full)) throw new FileError(`${inside} is in a locked project's folder; Ledung saves no file there.`);

  // Every folder on the way and the name itself: no link or junction (Node reports a junction as one), each folder a
  // folder; with `create`, a missing folder is made, on its own, so nothing is made through a link either.
  const walk = (create: boolean): string => {
    let at = realRoot;
    for (const [i, part] of parts.entries()) {
      at = path.join(at, part);
      const shown = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(at);
      } catch {
        // Not there yet.
      }
      if (stat?.isSymbolicLink()) throw new FileError(`${shown} is a link; Ledung saves only into the worktree itself, never through a link.`);
      if (last) {
        if (stat) throw new FileError(`${inside} already exists; Ledung never saves over a file. Give another path.`);
      } else if (stat && !stat.isDirectory()) {
        throw new FileError(`${shown} is not a folder.`);
      } else if (!stat) {
        if (!create) throw new FileError(`${shown} is not there any more.`);
        try {
          fs.mkdirSync(at);
        } catch (e) {
          throw new FileError(`${shown} could not be made: ${(e as Error).message}`);
        }
      }
    }
    return at;
  };

  const target = walk(true);
  // The bytes go first into the worktree's own top folder, whose real path was taken above, so the temp file is taken
  // away from where it really is even when a folder on the way is swapped for a link.
  const temp = path.join(realRoot, `ledung-save-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let size: number;
  let sha: string;
  try {
    if (Buffer.isBuffer(bytes)) {
      // A plain file: no mode bits asked for, so nothing saved is executable.
      fs.writeFileSync(temp, bytes, { flag: 'wx' });
      size = bytes.length;
      sha = crypto.createHash('sha256').update(bytes).digest('hex');
    } else {
      fs.copyFileSync(bytes.file, temp, fs.constants.COPYFILE_EXCL);
      // The copy kept the data folder's 0600; a plain file in the worktree instead, never executable.
      fs.chmodSync(temp, 0o644);
      ({ size, sha } = hashFile(temp));
      if (sha !== bytes.sha) throw new FileError(`Ledung's copy of the file has changed since it came; it is not saved.`);
    }
    hooks.beforePlace?.(target);
    // Walked again just before the file goes in place: a folder swapped for a link since is refused (PR #89, finding 4).
    walk(false);
    hooks.beforeLink?.(target);
    // A hard link fails if anything is at the name, a dangling link included; a rename would replace it.
    try {
      fs.linkSync(temp, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new FileError(`${inside} already exists; Ledung never saves over a file. Give another path.`);
      // A file system without hard links, or a folder on another volume: created only if nothing is there (O_EXCL, which
      // a link at the name also fails), walked once more first.
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS' && code !== 'EXDEV') throw e;
      walk(false);
      try {
        if (Buffer.isBuffer(bytes)) fs.writeFileSync(target, bytes, { flag: 'wx' });
        else fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') throw new FileError(`${inside} already exists; Ledung never saves over a file. Give another path.`);
        throw e2;
      }
    }
  } catch (e) {
    fs.rmSync(temp, { force: true });
    if (e instanceof FileError) throw e;
    throw new FileError(`${inside} could not be saved: ${(e as Error).message}`);
  }
  fs.rmSync(temp, { force: true });
  // Where it really is, once more: a folder swapped for a link between the second walk and the link put it elsewhere.
  // Then it is taken away again (through the same link, so from where it went) and refused. Path calls can't close the
  // last instant: a folder swapped and swapped back before this check leaves the new file (never over another) where
  // the link pointed, and the save is refused (review of PR #172); only a process racing inside the worktree can.
  let landed: string | null = null;
  try {
    landed = fs.realpathSync.native(target);
  } catch {
    // Gone already.
  }
  // Compared without case and in one Unicode form: the real path has the names as they are on disk, which on macOS and
  // Windows may differ from the path given in case (and on macOS in form) for the very same file.
  const same = (a: string) => a.normalize('NFC').toLowerCase();
  const at = landed === null ? null : path.relative(realRoot, landed);
  if (at === null || at.startsWith('..') || path.isAbsolute(at) || same(at) !== same(path.join(...parts))) {
    fs.rmSync(target, { force: true });
    throw new FileError(`${inside} was not saved: a folder on the way changed while it was written.`);
  }
  return { inside, full: target, size, sha };
}

/** A file's size and SHA-256, read a megabyte at a time: a streamed copy is never held whole (issue #159). */
function hashFile(file: string): { size: number; sha: string } {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  let size = 0;
  try {
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) {
      hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size, sha: hash.digest('hex') };
}

/** The native real path of `p`'s nearest folder that is there, with the rest as given: long names, case on disk. */
function nativeReal(p: string): string {
  const rest: string[] = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...rest.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return path.resolve(p);
      rest.push(path.basename(at));
      at = up;
    }
  }
}

/** Is `inner` the folder `outer` or inside it, both in their native real form; without case on macOS and Windows. */
function nativeWithin(outer: string, inner: string): boolean {
  const fold = (s: string) => (process.platform === 'darwin' || process.platform === 'win32' ? s.normalize('NFC').toLowerCase() : s);
  const rel = path.relative(fold(nativeReal(outer)), fold(nativeReal(inner)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
