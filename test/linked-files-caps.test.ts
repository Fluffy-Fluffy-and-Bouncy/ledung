// Streamed files from a linked computer (Project-Ledung#479, audit L14): an offer above the size caps, per file or for
// a whole message, is refused before a byte is fetched, and a zip's directory is checked when it arrives, before it
// counts as received; a failing one is marked failed with the reason and nothing of it is kept.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { LinkedFileError, LinkedFiles, type FetchFrom, type StreamLimits } from '../src/remote/linked-files.ts';
import { MAX_ZIP_ENTRIES, MAX_ZIP_UNPACKED_BYTES } from '../src/remote/stream-kinds.ts';
import { openDatabase } from '../src/store/database.ts';
import { removeTemp } from './temp.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-linked-caps-'));
after(() => removeTemp(base));

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const MB = 1024 * 1024;

function store(limits: StreamLimits) {
  const dir = fs.mkdtempSync(path.join(base, 'copies-'));
  return { dir, files: new LinkedFiles(openDatabase(':memory:'), () => dir, () => 30, Date.now, () => limits) };
}

/** A fetch that serves `bytes` and counts how often it was asked. */
function serving(bytes: Buffer): { get: FetchFrom; calls: () => number } {
  let calls = 0;
  return { get: async (from) => (calls++, { body: Readable.from([bytes.subarray(from)]), start: from }), calls: () => calls };
}

/**
 * A zip by the format (APPNOTE 4.3), stored entries: each local header, then the central directory and its end record.
 * `unpacked` writes another uncompressed size into an entry's directory record than its data has.
 */
function zip(entries: { name: string; data: Buffer; unpacked?: number }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, e.data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(e.data.length, 20);
    dir.writeUInt32LE(e.unpacked ?? e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const offer = (name: string, kind: string, size: number) => ({ id: crypto.randomBytes(8).toString('hex'), name, kind, size, sha: 'a'.repeat(64) });

test('Project-Ledung#479: a streamed offer above the cap per file or per message is refused before anything is recorded or fetched', () => {
  const { files } = store({ maxFileBytes: 10 * MB, maxMessageBytes: 15 * MB });
  const refused = (offers: unknown[]) => {
    try {
      files.expect('link-a', 'mgr-1', offers, 0);
    } catch (e) {
      assert.ok(e instanceof LinkedFileError);
      return { status: e.status, message: e.message };
    }
    return null;
  };
  // One file over the cap per file: refused, with a sentence that says why.
  const one = refused([offer('talk.wav', 'wav', 10 * MB + 1)]);
  assert.equal(one?.status, 413);
  assert.match(one!.message, /^talk\.wav is not taken: it is .*; this computer takes streamed files up to 10(\.0)? MB each\.$/);
  // Each under the cap per file, more than the cap per message together.
  const all = refused([offer('a.wav', 'wav', 8 * MB), offer('b.zip', 'zip', 8 * MB)]);
  assert.equal(all?.status, 413);
  assert.match(all!.message, /in all; this computer takes up to 15(\.0)? MB in one message/);
  assert.deepEqual(files.remote(), [], 'nothing recorded, so nothing is fetched');
  // The positive branch: at the caps exactly, the message is taken and its files wait to be fetched.
  const taken = files.expect('link-a', 'mgr-1', [offer('a.wav', 'wav', 10 * MB), offer('b.zip', 'zip', 5 * MB)], 0);
  assert.equal(taken.length, 2);
  assert.equal(files.remote().length, 2);
});

test('Project-Ledung#479: a file recorded before a lower cap is refused at fetch, before the other computer is asked for a byte', async () => {
  let limits: StreamLimits = { maxFileBytes: 10 * MB, maxMessageBytes: 10 * MB };
  const dir = fs.mkdtempSync(path.join(base, 'copies-'));
  const files = new LinkedFiles(openDatabase(':memory:'), () => dir, () => 30, Date.now, () => limits);
  const bytes = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), Buffer.alloc(2 * MB)]);
  const [f] = files.expect('link-a', 'mgr-1', [{ ...offer('talk.wav', 'wav', bytes.length), sha: sha(bytes) }], 0);
  limits = { maxFileBytes: MB, maxMessageBytes: MB };
  const server = serving(bytes);
  const result = await files.fetch(f!.id, server.get, { tries: 1, backoffMs: 1 });
  assert.equal(result.ok, false);
  assert.match((result as { problem: string }).problem, /this computer takes streamed files up to 1(\.0)? MB each/);
  assert.equal(server.calls(), 0, 'not a byte asked for');
});

test('Project-Ledung#479: a zip is checked when it arrives; a broken, too large or escaping one is failed with the reason and nothing kept', async () => {
  const { dir, files } = store({ maxFileBytes: 1024 * MB, maxMessageBytes: 1024 * MB });
  const fetchZip = async (bytes: Buffer) => {
    const [f] = files.expect('link-a', 'mgr-1', [{ ...offer('pack.zip', 'zip', bytes.length), sha: sha(bytes) }], 0);
    const result = await files.fetch(f!.id, serving(bytes).get, { tries: 1, backoffMs: 1 });
    return { result, problem: result.ok ? null : result.problem };
  };
  const kept = () => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((p) => fs.statSync(path.join(dir, p)).isFile()) : []);
  const small = (name: string) => ({ name, data: Buffer.from('hello') });

  // The positive branch: a plain zip arrives and is kept.
  const good = await fetchZip(zip([small('notes/a.txt'), small('b.txt')]));
  assert.equal(good.result.ok, true, String(good.problem));
  assert.equal(kept().length, 1, 'the good zip is kept');

  const cases: [string, Buffer, RegExp][] = [
    ['an absolute entry', zip([small('/etc/passwd')]), /entry \/etc\/passwd has a path that leads out of the zip/],
    ['a drive letter', zip([small('C:\\Windows\\x.txt')]), /leads out of the zip/],
    ['an entry climbing out', zip([small('notes/../../x.txt')]), /entry notes\/\.\.\/\.\.\/x\.txt has a path that leads out of the zip/],
    ['an entry climbing out with backslashes', zip([small('notes\\..\\..\\x.txt')]), /leads out of the zip/],
    ['too many entries', zip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `${i}`, data: Buffer.alloc(0) }))), new RegExp(`it has ${MAX_ZIP_ENTRIES + 1} entries; this computer takes at most ${MAX_ZIP_ENTRIES}`)],
    // Five entries each saying 4 GiB unpacked: 20 GiB, over the 16 GiB the zip may unpack to.
    ['too much unpacked', zip(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.bin`, data: Buffer.from('x'), unpacked: 0xfffffff0 }))), /it unpacks to more than 16 GB/],
    // Starts like a zip, but has no directory.
    ['no central directory', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]), /not a zip file Ledung can read \(no central directory\)/],
  ];
  assert.equal(MAX_ZIP_UNPACKED_BYTES, 16 * 1024 ** 3);
  for (const [what, bytes, why] of cases) {
    const { result, problem } = await fetchZip(bytes);
    assert.equal(result.ok, false, what);
    assert.match(problem!, why, what);
    assert.equal(kept().length, 1, `${what}: nothing of it kept, not even a part`);
  }
  // At the limit exactly, entries and unpacked size both pass.
  const atLimit = await fetchZip(zip(Array.from({ length: MAX_ZIP_ENTRIES }, (_, i) => ({ name: `${i}`, data: Buffer.alloc(0) }))));
  assert.equal(atLimit.result.ok, true, String(atLimit.problem));
});
