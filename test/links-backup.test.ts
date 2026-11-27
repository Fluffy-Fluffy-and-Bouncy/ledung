// links.json's backup (issue #460): a power loss right after a save left links.json as 975 bytes of zeros, every read
// failed, and Ledung showed no linked computers while the other computers still held their side of each link.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LINKS_FILE, LinkedComputers } from '../src/remote/linked.ts';
import { removeTemp } from './temp.ts';

/** The backup's name, as the issue gives it. */
const BACKUP = `${LINKS_FILE}.bak`;

const dirs: string[] = [];
after(() => dirs.forEach(removeTemp));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-links-backup-'));
  dirs.push(dir);
  return dir;
};

const link = (n: number) => ({
  id: `id-${n}`, name: `Computer ${n}`, publicName: `c${n}.example.net`, linkedAt: 1_700_000_000_000, lastUsedAt: null,
  sendKey: crypto.randomBytes(32).toString('base64url'), acceptSha256: 'a'.repeat(64),
});
const saved = (...links: ReturnType<typeof link>[]) => JSON.stringify({ links }, null, 2);

test('a zero-filled links.json next to a good backup: the links come back, the log says so, the file is put back', (t) => {
  const dir = tempDir();
  const good = saved(link(1), link(2));
  // As the crash left it: the size of a real save, every byte 0x00 (the issue's evidence: 975 bytes).
  fs.writeFileSync(path.join(dir, LINKS_FILE), Buffer.alloc(975));
  fs.writeFileSync(path.join(dir, BACKUP), good);
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));

  const linked = new LinkedComputers({ dir, publicName: 'here.example.net' });
  assert.deepEqual(linked.list().map((l) => l.publicName), ['c1.example.net', 'c2.example.net']);
  assert.equal(logged.filter((l) => /links\.json can't be read: .*loaded 2 link\(s\) from its backup/.test(l)).length, 1, logged.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, LINKS_FILE), 'utf8')), JSON.parse(good), 'links.json put back from the backup');

  // Read again: from links.json itself now, so the log doesn't repeat.
  assert.equal(linked.list().length, 2);
  assert.equal(logged.filter((l) => l.includes('from its backup')).length, 1);
});

test('a zero-filled links.json with no backup: an empty list, and the log says neither could be read', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, LINKS_FILE), Buffer.alloc(975));
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  assert.deepEqual(new LinkedComputers({ dir, publicName: 'here.example.net' }).list(), []);
  assert.ok(logged.some((l) => /links\.json can't be read: .*nor can its backup/.test(l)), logged.join('\n'));
});

test('every save writes the backup too, with the same links', () => {
  const dir = tempDir();
  // A key that link accepts: its use is noted (lastUsedAt), a save that calls no other computer.
  const key = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dir, LINKS_FILE), saved({ ...link(1), acceptSha256: crypto.createHash('sha256').update(key).digest('hex') }));
  const linked = new LinkedComputers({ dir, publicName: 'here.example.net', now: () => 1_800_000_000_000 });
  assert.equal(fs.existsSync(path.join(dir, BACKUP)), false, 'no backup before a save');
  assert.equal(linked.byKey(`Bearer ${key}`)?.id, 'id-1');
  const main = fs.readFileSync(path.join(dir, LINKS_FILE), 'utf8');
  assert.equal(JSON.parse(main).links[0].lastUsedAt, 1_800_000_000_000);
  assert.equal(fs.readFileSync(path.join(dir, BACKUP), 'utf8'), main);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, BACKUP)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), [LINKS_FILE, BACKUP], 'no temporary file left');
});

test('a links.json that can\'t be read at all (here a folder in its place) also loads the backup', (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, LINKS_FILE));
  fs.writeFileSync(path.join(dir, BACKUP), saved(link(3)));
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  assert.deepEqual(new LinkedComputers({ dir, publicName: 'here.example.net' }).list().map((l) => l.publicName), ['c3.example.net']);
  assert.ok(logged.some((l) => /links\.json can't be read: .*loaded 1 link\(s\) from its backup/.test(l)), logged.join('\n'));
});
