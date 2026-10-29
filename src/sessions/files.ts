// Reading files from a session's project folder, for the page's file viewer. Read-only, and only
// inside the project folder: the page can be reachable from the local network without sign-in.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export interface ProjectFile {
  /** The path relative to the project folder, with forward slashes. */
  path: string;
  kind: 'markdown' | 'text';
  content: string;
}

export class FileError extends Error {}

/** Resolves `link` (see readProjectFile) to a file inside `root`: its real path and its project-relative path. */
function resolveInside(root: string, link: string): { real: string; inside: string } {
  let wanted = link.replace(/[?#].*$/, '');
  try {
    wanted = decodeURIComponent(wanted);
  } catch {
    // Not encoded; use as is.
  }
  if (!wanted.trim()) throw new FileError('No file given.');

  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    // realpath also resolves links, so a link inside the folder can't lead outside it.
    real = fs.realpathSync(path.resolve(realRoot, wanted));
  } catch {
    throw new FileError(`There is no file ${wanted} in the project.`);
  }
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new FileError('Only files inside the project folder can be shown.');
  }
  if (fs.statSync(real).isDirectory()) throw new FileError(`${inside} is a folder; only files can be shown.`);
  return { real, inside: inside.split(path.sep).join('/') };
}

/**
 * Why `link` in `root` is not shown to a chat (issue #211, Martin 18:14 on question #293), or null: a chat
 * can run in the whole home folder and the page can be reached from a phone, so nothing under a folder or
 * file whose name starts with a dot (.ssh, .claude, .aws, .npmrc …) is shown. Checked on the real path,
 * from the browse root it is under, so a link to one, or a chat started inside one, can't get around it.
 */
export function hiddenProblem(root: string, link: string, roots: readonly string[], refused: readonly string[] = []): string | null {
  const { real: typed, inside } = resolveInside(root, link);
  // The native realpath on every side (review round 2, finding 1): the JS one keeps a Windows 8.3 short name
  // as typed, so SSH~1 for .ssh has no dot; the native one gives the long name and the case on disk.
  const longName = (p: string): string | null => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  };
  const real = longName(typed) ?? typed;
  // Folders that hold settings and tokens without a dot in their name (Martin, question #317): on the real path,
  // so a link into one or a chat started inside one is refused too. path.relative ignores case on Windows.
  for (const folder of refused) {
    const at = longName(folder);
    if (!at) continue;
    const rel = path.relative(at, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return `${inside} is not shown: it is inside ${folder}, where settings and sign-ins are kept.`;
  }
  const from = (r: string): string | null => {
    const at = longName(r);
    return at === null ? null : path.relative(at, real);
  };
  const under = roots.map(from).find((rel) => rel !== null && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  const parts = (under ?? from(root) ?? inside).split(/[\\/]/);
  return parts.some((p) => p.startsWith('.')) ? `${inside} is in a hidden folder or is a hidden file; a chat's file viewer doesn't show those.` : null;
}

/**
 * Reads `link` (as it appears in a chat: relative to the project folder, or an absolute path inside
 * it, possibly URL-encoded and with a #fragment) from the project folder `root`.
 */
export function readProjectFile(root: string, link: string): ProjectFile {
  const { real, inside } = resolveInside(root, link);
  const size = fs.statSync(real).size;
  if (size > MAX_BYTES) throw new FileError(`${inside} is too large to show (${Math.round(size / 1024)} KB).`);

  const bytes = fs.readFileSync(real);
  if (bytes.subarray(0, 8192).includes(0)) throw new FileError(`${inside} is not a text file.`);
  return { path: inside, kind: /\.(md|markdown)$/i.test(inside) ? 'markdown' : 'text', content: bytes.toString('utf8') };
}

export interface ProjectImage {
  path: string;
  type: 'image/png' | 'image/jpeg';
  bytes: Buffer;
}

/** Only PNG and JPEG are shown (decision 2026-10-14); SVG in particular can carry script. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Reads a PNG or JPEG from the project folder with the same path rules as readProjectFile. The type
 * comes from the file's first bytes, which must agree with its extension, so a renamed file of
 * another kind is never served as an image.
 */
export function readProjectImage(root: string, link: string): ProjectImage {
  const { real, inside } = resolveInside(root, link);
  const wantPng = /\.png$/i.test(inside);
  if (!wantPng && !/\.jpe?g$/i.test(inside)) throw new FileError(`${inside} is not a PNG or JPEG image.`);
  const size = fs.statSync(real).size;
  if (size > MAX_IMAGE_BYTES) {
    throw new FileError(`${inside} is too large to show (${(size / 1048576).toFixed(1)} MB; the limit is 10 MB).`);
  }
  const bytes = fs.readFileSync(real);
  const isPng = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = bytes.subarray(0, 3).equals(JPEG_SIGNATURE);
  if (wantPng ? !isPng : !isJpeg) throw new FileError(`${inside} is not really a ${wantPng ? 'PNG' : 'JPEG'} image.`);
  return { path: inside, type: wantPng ? 'image/png' : 'image/jpeg', bytes };
}

/**
 * A file's bytes from the project folder, with readProjectFile's path rules; refused above `maxBytes`
 * before it is read. For callers that decide the kind from the bytes (board attachments, review M3).
 */
export function readProjectBytes(root: string, link: string, maxBytes: number): { path: string; bytes: Buffer } {
  const { real, inside } = resolveInside(root, link);
  const size = fs.statSync(real).size;
  if (size > maxBytes) throw new FileError(`${inside} is too large (${Math.round(size / 1024)} KB).`);
  return { path: inside, bytes: fs.readFileSync(real) };
}

/** A handoff must be fresh, so an old file can't stand in for one (clear_self, docs/steps/clear-and-compact.md). */
export const HANDOFF_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Why `file` can't serve as a session's handoff before it clears itself, or null if it can: the file
 * viewer's rules (inside the project folder, no way out through `..` or links), not empty, changed
 * within the last hour.
 */
export function handoffProblem(root: string, file: string, now = Date.now()): string | null {
  let found: ProjectFile;
  try {
    found = readProjectFile(root, file);
  } catch (e) {
    if (e instanceof FileError) return `The handoff file can't be used: ${e.message}`;
    throw e;
  }
  if (!found.content.trim()) return `The handoff file ${found.path} is empty; write the handoff first.`;
  const age = now - fs.statSync(path.join(fs.realpathSync(root), found.path)).mtimeMs;
  if (age > HANDOFF_MAX_AGE_MS) {
    return `The handoff file ${found.path} was last changed ${Math.round(age / 60000)} minutes ago; write the handoff first (it must be changed within the last hour).`;
  }
  return null;
}
