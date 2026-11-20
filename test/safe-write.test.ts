// The safe write for private state files (issue #460): a crash right after a save left links.json as zeros, because
// the temporary file was renamed into place before its data was flushed to the disk.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileSafely } from '../src/platform/safe-write.ts';
import { removeTemp } from './temp.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-safe-write-'));
after(() => removeTemp(dir));

test('the data is flushed to the disk before the rename puts it in place, and the folder after it', (t) => {
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');
  // What happened, in order: which file each flush was for, and each rename. fs itself is watched, not the helper.
  const events: string[] = [];
  const fdPath = new Map<number, string>();
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (p: fs.PathLike, ...rest: unknown[]) => {
    const fd = (open as (...a: unknown[]) => number)(p, ...rest);
    fdPath.set(fd, String(p));
    return fd;
  });
  const fsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    events.push(`fsync ${path.basename(fdPath.get(fd) ?? '?')}`);
    fsync(fd);
  });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    events.push(`rename ${path.basename(String(from))} -> ${path.basename(String(to))}`);
    rename(from, to);
  });

  writeFileSafely(file, 'new', { temp: path.join(dir, 'state.json.tmp') });

  const expected = ['fsync state.json.tmp', 'rename state.json.tmp -> state.json'];
  // Windows can't open a folder to flush it (NTFS journals the rename); elsewhere the folder is flushed last.
  if (process.platform !== 'win32') expected.push(`fsync ${path.basename(dir)}`);
  assert.deepEqual(events, expected);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('state.json')), ['state.json'], 'no temporary file left');
});

test('a private file is made readable by this user only, and replaces the one there', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const file = path.join(dir, 'private.json');
  writeFileSafely(file, Buffer.from('secret'), { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeFileSafely(file, 'again', { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'again');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a write that fails leaves the old file as it was and no temporary file', () => {
  // A rename onto a folder that holds a file fails on every platform.
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'x'), 'kept');
  assert.throws(() => writeFileSafely(blocked, 'new', { temp: path.join(dir, 'blocked.tmp') }));
  assert.equal(fs.existsSync(path.join(dir, 'blocked.tmp')), false, 'the temporary file is removed');
  assert.equal(fs.readFileSync(path.join(blocked, 'x'), 'utf8'), 'kept');
  // The same call on a plain file works, so the throw above was the rename's.
  const file = path.join(dir, 'kept.json');
  writeFileSafely(file, 'new', { temp: path.join(dir, 'kept.tmp') });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('exclusive: a temporary file already there is refused and left alone', () => {
  const file = path.join(dir, 'creds.json');
  const temp = path.join(dir, 'creds.json.ledung-1');
  fs.writeFileSync(temp, "someone else's");
  assert.throws(() => writeFileSafely(file, 'mine', { temp, exclusive: true }), /EEXIST/);
  assert.equal(fs.readFileSync(temp, 'utf8'), "someone else's");
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(temp);
  writeFileSafely(file, 'mine', { temp, exclusive: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
});
