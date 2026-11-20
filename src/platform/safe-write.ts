// Private state files written so a crash can't leave them empty (issue #460): a power loss right after links.json was
// renamed into place left it as zeros, because the rename reached the disk before the data did (NTFS, and any file
// system with delayed allocation). So the data is flushed before the rename, and the folder after it where it can be.
import fs from 'node:fs';
import path from 'node:path';

export interface SafeWriteOptions {
  /** The file's mode when it is made, e.g. 0o600 for a file private to this user. */
  mode?: number;
  /** The temporary file next to it; default `<file>.<pid>.tmp`. */
  temp?: string;
  /** Refuse to write through a temporary file that is already there (a link someone else put there). */
  exclusive?: boolean;
}

/**
 * Writes the file whole or not at all, and durably: to a temporary file next to it, flushed to the disk, renamed over
 * it, then the folder flushed so the rename is kept too. Throws when it can't, with the old file left as it was.
 */
export function writeFileSafely(file: string, data: string | Buffer, opts: SafeWriteOptions = {}): void {
  const temp = opts.temp ?? `${file}.${process.pid}.tmp`;
  // Opened outside the try: a temporary file that `exclusive` refused is someone else's, never removed here.
  const fd = fs.openSync(temp, opts.exclusive ? 'wx' : 'w', opts.mode ?? 0o666);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
  syncFolder(path.dirname(file));
}

/**
 * Flushes a folder's entries, so a rename in it survives a crash. Windows can't open a folder this way, and NTFS
 * journals the rename itself; elsewhere a file system that refuses (some network shares) is left as it is: the data
 * itself is already on the disk.
 */
function syncFolder(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // See above: the file's data is flushed; only the folder's entry may be late.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
