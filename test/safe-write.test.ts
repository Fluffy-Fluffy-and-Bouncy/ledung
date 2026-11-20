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

test('a write that fails leaves the old file as it was and no temporary file', (t) => {
  // A rename onto a folder that holds a file fails on every platform.
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'x'), 'kept');
  // The temporary file was there before the rename failed: the rename's own source, as it was called.
  const renamedFrom: string[] = [];
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    renamedFrom.push(`${path.basename(String(from))} ${fs.existsSync(from) ? 'there' : 'missing'}`);
    rename(from, to);
  });
  assert.throws(() => writeFileSafely(blocked, 'new', { temp: path.join(dir, 'blocked.tmp') }));
  assert.deepEqual(renamedFrom, ['blocked.tmp there']);
  assert.equal(fs.existsSync(path.join(dir, 'blocked.tmp')), false, 'the temporary file is removed');
  assert.equal(fs.readFileSync(path.join(blocked, 'x'), 'utf8'), 'kept');
  // The same call on a plain file works, so the throw above was the rename's.
  const file = path.join(dir, 'kept.json');
  writeFileSafely(file, 'new', { temp: path.join(dir, 'kept.tmp') });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

/**
 * The files that may still rename a file into place themselves, and why each needs no flush: none of them is state
 * whose loss costs the user something (issue #460). Private state goes through writeFileSafely instead.
 */
const BARE_RENAMES: Record<string, string> = {
  'src/platform/safe-write.ts': 'the safe write itself',
  'src/host/client.ts': "a session host's record: after a crash the host it names is gone too",
  'src/board/attachments.ts': 'a cache of attachments, fetched again when missing',
  'src/platform/desktop-app.ts': 'the desktop app bundle, made again from the package',
  'src/platform/background.ts': 'a log moved aside, not written',
  'src/remote/linked-files.ts': 'a file in transfer, with its database row; sent again when lost',
  'src/remote/linked-outbox.ts': 'a file in transfer, with its database row; sent again when lost',
  'src/sessions/container-files.ts': 'a copy cache for containers, made again from the project',
  'src/sessions/flow-files.ts': "the project's own files, checked for links between the write and the rename",
};

test('every rename into place in src/ is the safe write or a file on the list, with its reason', () => {
  const root = path.join(import.meta.dirname, '..');
  const found = new Set<string>();
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (child.endsWith('.ts') && fs.readFileSync(path.join(root, child), 'utf8').includes('renameSync(')) found.add(child);
    }
  };
  walk('src');
  // The search finds what it should: the safe write itself renames.
  assert.ok(found.has('src/platform/safe-write.ts'), [...found].join('\n'));
  const unlisted = [...found].filter((f) => !(f in BARE_RENAMES));
  assert.deepEqual(unlisted, [], 'a private state file renames by itself: write it with writeFileSafely, or list it here with why it needs no flush');
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
