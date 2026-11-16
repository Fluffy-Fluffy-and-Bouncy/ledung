// A file dropped or picked in the message box that Ledung can't attach as an image (issue #339; Martin, 2026-11-16
// 14:44, question #912: "a — Copy it in and link the copy"). A browser never tells a page where a dropped file is on
// disk, only its name and bytes, so Ledung keeps a copy in the folder the session works in, under .ledung/drops/, and
// the message names that copy. The page sends the bytes to the Ledung the session runs on, so a tab of a linked
// computer or a phone puts the file on that computer.
//
// The rules, each a refusal with its reason and nothing written:
// - at most MAX_DROP_BYTES;
// - only into a local project: a container project's folder is inside the container, and Ledung knows only the
//   container's name and the path in it, not where (or whether) that folder is on this computer's disk;
// - not into Ledung's own data folder (Project-Ledung#478, as save-file.ts refuses it);
// - .ledung and .ledung/drops are folders, never links, and are made one at a time;
// - the name is Ledung's: the date, then the file's own name with every path part and odd character made plain, and a
//   number added when it is taken; the file is created only where nothing is (O_EXCL, which a link at the name fails);
// - where it landed is checked once more after the write, so a folder swapped for a link meanwhile is refused.
// The drops folder holds a .gitignore of "*", so a drop never shows in git status (and the .gitignore with it).
import fs from 'node:fs';
import path from 'node:path';
import { within } from '../projects/lockdown.ts';
import { userDataDir } from '../platform/paths.ts';
import { FileError } from './files.ts';

/** The most a dropped file may have (issue #339). */
export const MAX_DROP_BYTES = 50 * 1024 * 1024;
/** Where drops are kept, relative to the session's folder, with forward slashes as the message names them. */
export const DROPS_FOLDER = '.ledung/drops';
/**
 * The longest file name a drop keeps, in UTF-8 bytes, the date and number included: inside 255 bytes (ext4 and most
 * Linux file systems, APFS) and so inside 255 UTF-16 units too (NTFS), whatever the script (self-check of #339).
 */
const MAX_NAME_BYTES = 200;
/** The longest extension a cut name keeps, in UTF-8 bytes; a longer "extension" is just part of the name. */
const MAX_EXT_BYTES = 16;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
// Characters no Windows file name holds (":" also opens an alternate data stream), control characters, and the
// separators of every system: a name never becomes a path.
const ODD = /[<>:"|?*\\/\u0000-\u001f\u007f]/g;
// Names Windows keeps for devices, with any extension.
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const DROP_TOO_LARGE = `The file is too large: at most ${MAX_DROP_BYTES / 1024 / 1024} MB.`;

/** The day as yyyy-mm-dd on this computer's clock. */
function day(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Cuts `s` to at most `max` UTF-8 bytes, a whole character at a time. */
function cut(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (bytes(out) + bytes(ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * The plain form of a dropped file's name: path parts and odd characters become "_", no dot or space at either end
 * (no hidden file, no "..", nothing Windows trims), never a device name, never empty; long names keep their extension.
 */
export function plainDropName(name: string): string {
  let plain = String(name ?? '').normalize('NFC').replace(ODD, '_').replace(/^[ .]+|[ .]+$/g, '');
  if (!plain) plain = 'file';
  if (DEVICE.test(plain)) plain = `_${plain}`;
  const room = MAX_NAME_BYTES - 'yyyy-mm-dd-'.length - '-999'.length;
  if (bytes(plain) > room) {
    const ext = path.extname(plain);
    const keep = ext.length > 0 && bytes(ext) <= MAX_EXT_BYTES ? ext : '';
    plain = `${cut(plain.slice(0, plain.length - keep.length), room - bytes(keep)).replace(/[ .]+$/, '')}${keep}`;
  }
  return plain || 'file';
}

/** A folder on the way: made when missing, refused when it is a link or not a folder. */
function folderAt(at: string, shown: string): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(at);
  } catch {
    // Not there yet.
  }
  if (stat?.isSymbolicLink()) throw new FileError(`${shown} is a link; Ledung saves a dropped file only into the folder itself, never through a link.`);
  if (stat && !stat.isDirectory()) throw new FileError(`${shown} is not a folder.`);
  if (!stat) {
    try {
      fs.mkdirSync(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new FileError(`${shown} could not be made: ${(e as Error).message}`);
      folderAt(at, shown);
    }
  }
}

export interface Dropped {
  /** The path relative to the session's folder, with forward slashes: what the message names. */
  path: string;
  /** The full path it was written to. */
  full: string;
  size: number;
}

/**
 * Saves a dropped file's bytes in `root`'s .ledung/drops under a plain, unique name; never over anything there.
 * `hooks.beforeWrite` is for tests: a step between the folders' checks and the write, where one can be swapped for a link.
 */
export function saveDrop(root: string, name: string, bytes: Buffer, now = new Date(), hooks: { beforeWrite?: (folder: string) => void } = {}): Dropped {
  if (bytes.length > MAX_DROP_BYTES) throw new FileError(DROP_TOO_LARGE);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    throw new FileError("The session's folder is not there.");
  }
  // Read on each call, so the folder a test or a throwaway Ledung sets is the one refused.
  if (within(userDataDir(), realRoot)) throw new FileError("The session's folder is in Ledung's own data folder; Ledung saves no dropped file there.");
  const ledung = path.join(realRoot, '.ledung');
  const drops = path.join(ledung, 'drops');
  folderAt(ledung, '.ledung');
  folderAt(drops, DROPS_FOLDER);
  try {
    // "*" leaves out everything in the folder, this file too; written once, never over one there.
    fs.writeFileSync(path.join(drops, '.gitignore'), '# Files dropped in Ledung\'s message box (issue #339): never committed.\n*\n', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new FileError(`${DROPS_FOLDER}/.gitignore could not be written: ${(e as Error).message}`);
  }

  const plain = `${day(now)}-${plainDropName(name)}`;
  const ext = path.extname(plain);
  const stem = plain.slice(0, plain.length - ext.length);
  hooks.beforeWrite?.(drops);
  for (let n = 1; n <= 999; n++) {
    const file = n === 1 ? plain : `${stem}-${n}${ext}`;
    const full = path.join(drops, file);
    // Checked again right before the write: a folder swapped for a link since is refused.
    for (const [at, shown] of [[ledung, '.ledung'], [drops, DROPS_FOLDER]] as const) {
      if (fs.lstatSync(at).isSymbolicLink()) throw new FileError(`${shown} is a link; Ledung saves a dropped file only into the folder itself, never through a link.`);
    }
    try {
      // A plain file: no mode bits asked for, so nothing dropped is executable.
      fs.writeFileSync(full, bytes, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      fs.rmSync(full, { force: true });
      throw new FileError(`${DROPS_FOLDER}/${file} could not be saved: ${(e as Error).message}`);
    }
    // Where it really is: a folder swapped for a link between the check and the write put it elsewhere. Then it is
    // taken away again (through the same link, so from where it went) and refused.
    let landed: string | null = null;
    try {
      landed = fs.realpathSync.native(full);
    } catch {
      // Gone already.
    }
    const same = (a: string) => a.normalize('NFC').toLowerCase();
    if (landed === null || same(path.relative(realRoot, landed)) !== same(path.join('.ledung', 'drops', file))) {
      fs.rmSync(full, { force: true });
      throw new FileError(`${DROPS_FOLDER}/${file} was not saved: a folder on the way changed while it was written.`);
    }
    return { path: `${DROPS_FOLDER}/${file}`, full, size: bytes.length };
  }
  throw new FileError(`${DROPS_FOLDER} already holds 999 files named ${plain}; rename the file and drop it again.`);
}
