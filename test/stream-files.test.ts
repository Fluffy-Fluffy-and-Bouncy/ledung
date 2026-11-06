// Files streamed between managers on linked computers (issue #159): audio and zip files of any size go with
// message_manager as a handle; the sender keeps a snapshot in its outbox, the receiver pulls it with /link/file-get
// (Range for a resume), streamed to disk and checked by size, SHA-256 and kind. A zip is checked entry by entry before
// it leaves. Two real Ledungs, each reaching the other over its tunnel with TLS ending in that Ledung (linked-nodes.ts);
// the loopback with a real relay and a 200 MB file is test/loopback/link-streams.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';
import { Secrets } from '../src/secrets/secrets.ts';
import type { Management } from '../src/sessions/management.ts';
import { linkOutgoing, streamKindOf, zipProblem } from '../src/remote/stream-kinds.ts';
import type { LinkedComputers } from '../src/remote/linked.ts';
import { keyFor, LinkedNodes, type Node } from './linked-nodes.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

const nodes = new LinkedNodes();
const temps: string[] = [];
// This run's own data folder, also when the file is run on its own and not through scripts/test.ts: the EXERCISED
// line goes to exercised.log there (src/platform/exercised.ts), never to the real Ledung's.
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-stream-files-')));
temps.push(dataDir);
process.env.LEDUNG_DATA_DIR = dataDir;
after(async () => {
  await nodes.close();
  for (const t of temps) removeTemp(t);
});

const temp = (what: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ledung-${what}-`)));
  temps.push(dir);
  return dir;
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const management = (n: Node) => (n.manager as unknown as { management: Management }).management;
const manager = (n: Node, id: string, project: string) => {
  n.store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
  n.store.updateSession(id, { status: 'idle' });
};
/** A worker under `parent` in a worktree it entered, as #160's tests make one. */
const worker = (n: Node, id: string, project: string, parent: string, worktree: string) => {
  n.store.createSession({ id, project, runner: 'local', title: id, parentId: parent, permissionMode: 'default', role: 'session' });
  n.store.addMessage(id, 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'EnterWorktree', input: { name: path.basename(worktree) } }] } });
  n.store.addMessage(id, 'sdk', { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Created worktree at ${worktree} on branch worktree-${path.basename(worktree)}.` }] } });
};
const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : []);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
/** A WAV file's header (RIFF … WAVE) and `bytes` of sound: random, so the SHA-256 tells every byte. */
function wav(bytes: number): Buffer {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(bytes + 4, 4);
  head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, crypto.randomBytes(bytes)]);
}

/** A zip, by the format (APPNOTE 4.3): stored or deflated entries, each with its local header and its directory record. */
/**
 * Options for the crafted cases: `hidden` writes the local entry but leaves it out of the directory, `before` puts bytes
 * ahead of its local header, `descriptor` follows its data with a signed data descriptor (flag bit 3), `comment` is its
 * directory comment; `comment` on the zip is the archive comment.
 */
type ZipEntry = { name: string; data: Buffer; deflate?: boolean; flags?: number; localName?: string; hidden?: boolean; before?: Buffer; descriptor?: boolean; comment?: string };
function zip(entries: ZipEntry[], comment = ''): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const localName = Buffer.from(e.localName ?? e.name, 'utf8');
    const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const crc = zlib.crc32(e.data);
    const method = e.deflate ? 8 : 0;
    const flags = (e.flags ?? 0) | 0x800 | (e.descriptor ? 0x8 : 0);
    if (e.before) {
      parts.push(e.before);
      offset += e.before.length;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    parts.push(local, localName, body);
    const descriptor = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(e.data.length, 12);
      parts.push(descriptor);
    }
    const listed = !e.hidden;
    const note = Buffer.from(e.comment ?? '', 'utf8');
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(note.length, 32);
    dir.writeUInt32LE(offset, 42);
    if (listed) central.push(dir, name, note);
    offset += 30 + localName.length + body.length + descriptor.length;
  }
  const cd = Buffer.concat(central);
  const listed = entries.filter((e) => !e.hidden).length;
  const note = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(listed, 8);
  end.writeUInt16LE(listed, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...parts, cd, end, note]);
}

async function until<T>(get: () => T | null | undefined, what: string, ms = WAIT_MS): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A Mac and a PC, linked; Alpha on the Mac, Beta (with a worker in a worktree) and Fort (locked) on the PC. */
async function pair(tag: string, config: Record<string, unknown> = {}) {
  const alpha = temp(`${tag}-alpha`);
  const beta = temp(`${tag}-beta`);
  const common = { ...config, userName: 'Martin', browseRoots: [os.tmpdir()], sensitive: { commandPatterns: [], pathPatterns: ['private-notes'], mcpTools: [] } };
  const mac = await nodes.ledung(`mac-${tag}.stream.test`, undefined, undefined, undefined, { ...common, projects: [{ name: 'Alpha', runner: 'local', path: alpha }] });
  const pc = await nodes.ledung(`pc-${tag}.stream.test`, undefined, undefined, undefined, {
    ...common, projects: [{ name: 'Beta', runner: 'local', path: beta }, { name: 'Fort', runner: 'local', path: temp(`${tag}-fort`), lockdown: { level: 'A' } }],
  });
  const dirs = { macFiles: temp(`${tag}-mac-linked`), pcFiles: temp(`${tag}-pc-linked`), macOutbox: temp(`${tag}-mac-outbox`), pcOutbox: temp(`${tag}-pc-outbox`) };
  mac.manager.linkedFilesDir = () => dirs.macFiles;
  pc.manager.linkedFilesDir = () => dirs.pcFiles;
  mac.manager.linkedOutboxDir = () => dirs.macOutbox;
  pc.manager.linkedOutboxDir = () => dirs.pcOutbox;
  await nodes.link(mac, pc, 'Mac');
  manager(mac, 'mac-alpha', 'Alpha');
  manager(pc, 'pc-beta', 'Beta');
  manager(pc, 'pc-fort', 'Fort');
  const worktree = path.join(beta, '.claude', 'worktrees', 'fix-1');
  fs.mkdirSync(worktree, { recursive: true });
  worker(pc, 'pc-worker', 'Beta', 'pc-beta', worktree);
  management(pc).fetchOptions = { backoffMs: 10 };
  const toPc = (to: string, text: string, files: string[]) => management(mac).messageComputerManager('mac-alpha', `pc-${tag}`, to, text, files);
  const bytes = (n: Node) => n.manager.linkBytes((n.server as unknown as { linked: LinkedComputers }).linked.list()[0]!.id).today;
  const inbox = (id = 'pc-beta') => p.pc.store.undeliveredInbox(id).map((i) => i.text);
  const p = { mac, pc, alpha, beta, worktree, ...dirs, toPc, bytes, inbox };
  return p;
}

const handleOf = (text: string, name: string) => new RegExp(`"(linked:[0-9a-f]{16}/${name.replace('.', '\\.')})"`).exec(text)?.[1];

test('ledung#159: audio and zip by their first bytes and extension; any other kind is refused before a byte is sent, with the kinds that can go', () => {
  const head = (s: string, at = 0) => Buffer.concat([Buffer.alloc(at), Buffer.from(s, 'latin1'), Buffer.alloc(16)]);
  assert.equal(streamKindOf(wav(16), 'a.wav'), 'wav');
  assert.equal(streamKindOf(head('ID3'), 'a.mp3'), 'mp3');
  assert.equal(streamKindOf(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'a.MP3'), 'mp3', 'an MPEG-1 layer III frame with no tag');
  assert.equal(streamKindOf(head('fLaC'), 'a.flac'), 'flac');
  assert.equal(streamKindOf(head('OggS'), 'a.ogg'), 'ogg');
  assert.equal(streamKindOf(head('ftypM4A ', 4), 'a.m4a'), 'm4a');
  assert.equal(streamKindOf(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'a.zip'), 'zip');
  // Both must agree: the right bytes with another name, or the name with other bytes, is none of them.
  assert.equal(streamKindOf(wav(16), 'a.mp3'), null);
  assert.equal(streamKindOf(wav(16), 'a.txt'), null);
  assert.equal(streamKindOf(head('OggS'), 'a.wav'), null);
  assert.equal(streamKindOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.mp3'), null, 'a JPEG\'s start is not an MPEG frame');

  const dir = temp('kinds');
  fs.writeFileSync(path.join(dir, 'song.wav'), wav(1000));
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
  fs.writeFileSync(path.join(dir, 'fake.wav'), 'not a wav at all');
  fs.writeFileSync(path.join(dir, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));
  fs.writeFileSync(path.join(dir, '.env'), 'X=1');
  const song = linkOutgoing(dir, 'song.wav');
  assert.ok('streamed' in song && song.kind === 'wav' && song.size === 1012, JSON.stringify(song));
  const shot = linkOutgoing(dir, 'shot.png');
  assert.ok(!('streamed' in shot) && shot.kind === 'png', 'a PNG still goes as #158 sends it');
  const list = /can't be sent: only PNG and JPEG images and \.txt, \.log or \.md text files \(up to 5 MB and 512 KB\), and \.wav, \.mp3, \.flac, \.ogg or \.m4a audio and \.zip files \(any size\)\./;
  assert.throws(() => linkOutgoing(dir, 'tool.exe'), list);
  assert.throws(() => linkOutgoing(dir, '.env'), list);
  assert.throws(() => linkOutgoing(dir, 'fake.wav'), /fake\.wav is not really WAV audio\./);
});

test('ledung#159: a 6 MB WAV and a zip go as handles at once, are fetched in chunks and match their SHA-256; they can\'t go in a question but can be saved into a worktree; bytes counted both ways', { timeout: HANG_MS }, async () => {
  const p = await pair('send');
  const sound = wav(6 * 1024 * 1024);
  const archive = zip([{ name: 'notes/readme.md', data: Buffer.from('# Readme\nnothing secret\n'), deflate: true }, { name: 'data.bin', data: Buffer.concat([Buffer.alloc(4), crypto.randomBytes(5000)]) }]);
  fs.writeFileSync(path.join(p.alpha, 'take.wav'), sound);
  fs.writeFileSync(path.join(p.alpha, 'bundle.zip'), archive);
  fs.writeFileSync(path.join(p.alpha, 'shot.png'), PNG);
  const out = await p.toPc('pc-beta', 'Sound, a zip and a screenshot.', ['take.wav', 'bundle.zip', 'shot.png']);
  assert.match(out, /With 3 file\(s\): shot\.png \(PNG, 1 KB\), take\.wav \(WAV audio, 6\.0 MB, fetched from here by that computer\), bundle\.zip \(zip, 5 KB, fetched from here by that computer\)\.$/);

  // At once: the message, with each streamed file's handle, kind and size, and the pushed PNG as #158 gives it.
  const first = p.inbox()[0]!;
  assert.match(first, /^Message from manager "Manager: Alpha" \(mac-alpha\) of Alpha on your computer "Mac":\n\nSound, a zip and a screenshot\./);
  assert.match(first, /- shot\.png \(PNG, 1 KB\): to show it to Martin, give ask_user's screenshots file "linked:[0-9a-f]{16}\/shot\.png"/);
  assert.match(first, /- take\.wav \(WAV audio, 6\.0 MB\), "linked:[0-9a-f]{16}\/take\.wav": being fetched from your computer "Mac"; Ledung tells you when it is here, or why not\./);
  assert.match(first, /- bundle\.zip \(zip, 5 KB\), "linked:[0-9a-f]{16}\/bundle\.zip": being fetched/);
  const wavHandle = handleOf(first, 'take.wav')!;
  const zipHandle = handleOf(first, 'bundle.zip')!;
  const pngHandle = handleOf(first, 'shot.png')!;

  // Then a Ledung line for each once it is here; the copy is the bytes that were sent.
  await until(() => p.inbox().filter((t) => / is here, its size and SHA-256 checked/.test(t)).length === 2 || null, 'both fetched');
  assert.ok(p.inbox().some((t) => t === `Ledung: take.wav (WAV audio, 6.0 MB) from your computer "Mac" is here, its size and SHA-256 checked: "${wavHandle}". It can't be shown in a question or a review; to give it to one of your sessions, save it into its worktree with save_linked_file.`), p.inbox().join('\n---\n'));
  const copies = filesIn(p.pcFiles);
  assert.deepEqual(copies.filter((f) => f.endsWith('.part')), [], 'no part left');
  assert.ok(copies.some((f) => f.endsWith('.wav') && sha(fs.readFileSync(path.join(p.pcFiles, f))) === sha(sound)), 'the WAV copy has the SHA-256 sent');
  assert.ok(copies.some((f) => f.endsWith('.zip') && sha(fs.readFileSync(path.join(p.pcFiles, f))) === sha(archive)), 'the zip copy too');
  assert.equal(filesIn(p.macOutbox).length, 2, 'the Mac keeps both snapshots in its outbox');

  // A sound file can't be put in a question's screenshots, nor a zip in a review; the PNG of the same message can.
  assert.throws(() => management(p.pc).screenshots('pc-beta', [{ file: wavHandle, look_for: 'x' }], null), /take\.wav is WAV audio; it can't be shown in a question or a review\. Save it into a session's worktree with save_linked_file\./);
  assert.throws(() => management(p.pc).reviewEvidence('pc-beta', [{ file: zipHandle, caption: 'c' }]), /bundle\.zip is zip; it can't be shown .*save_linked_file/);
  assert.equal(management(p.pc).screenshots('pc-beta', [{ file: pngHandle, look_for: 'x' }], null)![0]!.path, pngHandle);

  // With #160: saved into the worker's worktree, same SHA-256; with the wrong extension, refused.
  const saved = management(p.pc).saveLinkedFile('pc-beta', wavHandle, 'pc-worker', 'audio/take.wav');
  // The native real path, as #172 gives it: on Windows the temp folder's JS real path keeps an 8.3 name (RUNNER~1).
  const full = path.join(fs.realpathSync.native(p.worktree), 'audio', 'take.wav');
  assert.equal(saved, `Saved into "pc-worker"'s worktree: audio/take.wav (${full}), ${sound.length} bytes, SHA-256 ${sha(sound)}. Tell the session that line; the file is its own now, Ledung doesn't remove it.`);
  assert.equal(sha(fs.readFileSync(full)), sha(sound));
  assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', zipHandle, 'pc-worker', 'bundle.txt'), /must end in \.zip: the file is zip/);

  // Counted per link: what crossed, on both sides.
  const total = PNG.length + sound.length + archive.length;
  assert.equal(p.bytes(p.mac).sent, total);
  assert.equal(p.bytes(p.pc).received, total);
  const log = fs.readFileSync(path.join(process.env.LEDUNG_DATA_DIR!, 'exercised.log'), 'utf8');
  assert.equal(log.match(/EXERCISED #159 /g)?.length, 1, log);
});

test('ledung#159: a zip with a .env, a key, a token file, a sensitive path, a secret in a text entry, an encrypted entry, an archive inside or a path out is refused before it leaves, naming the entry', { timeout: HANG_MS }, async () => {
  const p = await pair('zips');
  p.mac.manager.attachSecrets(Secrets.memory(), temp('zips-locked'));
  await (p.mac.manager as unknown as { secrets: Secrets }).secrets.add({ sessionId: 'mac-alpha', project: 'Alpha' }, 'db', 'hunter2-stream-files', 'session');
  const ok = { name: 'ok/readme.md', data: Buffer.from('fine\n'), deflate: true };
  // A key that straddles the first text window (1 MiB characters): found by the overlap, not lost between windows.
  const longText = Buffer.from(`${'word '.repeat(Math.floor((1024 * 1024 - 20) / 5))}-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n`);
  const cases: [string, Parameters<typeof zip>[0], RegExp][] = [
    ['env', [ok, { name: 'app/.env', data: Buffer.from('X=1') }], /entry app\/\.env is a \.env file, which never leaves/],
    ['envlocal', [{ name: '.env.local', data: Buffer.from('X=1') }], /entry \.env\.local is a \.env file/],
    ['ssh', [{ name: 'home/id_ed25519', data: Buffer.from('k') }], /entry home\/id_ed25519 is an SSH private key/],
    ['pem', [{ name: 'certs/server.pem', data: Buffer.from('k') }], /entry certs\/server\.pem is a key file/],
    ['token', [{ name: 'auth-token', data: Buffer.from('t') }], /entry auth-token is a token or secrets file/],
    ['npmrc', [{ name: 'pkg/.npmrc', data: Buffer.from('t') }], /entry pkg\/\.npmrc is a credentials file/],
    ['sensitive', [ok, { name: 'private-notes/plan.txt', data: Buffer.from('p') }], /entry private-notes\/plan\.txt: "private-notes\/plan\.txt" matches the sensitive path pattern \/private-notes\//],
    ['key', [{ name: 'notes.txt', data: Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n'), deflate: true }], /entry notes\.txt: it contains what looks like a private key/],
    ['long', [{ name: 'big.log', data: longText, deflate: true }], /entry big\.log: it contains what looks like a private key/],
    ['locked', [{ name: 'db.cfg', data: Buffer.from('host=x\npass=hunter2-stream-files\n') }], /entry db\.cfg: it contains a secret locked in Ledung/],
    ['crypt', [{ name: 'secret.bin', data: Buffer.alloc(10), flags: 1 }], /entry secret\.bin is encrypted; Ledung can't check it/],
    ['nested', [{ name: 'inner.zip', data: zip([{ name: '.env', data: Buffer.from('X=1') }]) }], /entry inner\.zip is an archive inside the zip; Ledung can't check what is in it/],
    ['slip', [{ name: '../escape.txt', data: Buffer.from('x') }], /entry \.\.\/escape\.txt has a path that leads out of the zip/],
    ['names', [{ name: 'ok.txt', localName: '.env', data: Buffer.from('X=1') }], /entry ok\.txt has another name inside the zip than its directory gives/],
    // Review finding 1 on PR #175: a .env a streaming unzip (bsdtar from a pipe) extracts, though the directory doesn't list it.
    ['prefix', [{ name: '.env', data: Buffer.from('TOKEN=hidden-value\n'), hidden: true }, { name: 'readme.txt', data: Buffer.from('fine\n') }], /it has bytes Ledung can't place \(at byte 0\)/],
    ['gap', [ok, { name: 'b.txt', data: Buffer.from('fine\n'), before: Buffer.from('TOKEN=hidden-value-between-entries\n') }], /it has bytes Ledung can't place \(at byte \d+\)/],
  ];
  for (const [tag, entries, reason] of cases) {
    fs.writeFileSync(path.join(p.alpha, `${tag}.zip`), zip(entries));
    await assert.rejects(p.toPc('pc-beta', 'a zip', [`${tag}.zip`]), (e: Error) => {
      assert.match(e.message, new RegExp(`^Not sent: attachment ${tag}\\.zip: `));
      assert.match(e.message, reason);
      return true;
    }, tag);
  }
  // Nothing left: no message, no row or copy on the PC, no snapshot on the Mac, nothing counted.
  const outboxRows = () => (p.mac.db.prepare('SELECT COUNT(*) AS n FROM linked_outbox').get() as { n: number }).n;
  const pcRows = () => (p.pc.db.prepare('SELECT COUNT(*) AS n FROM linked_files').get() as { n: number }).n;
  assert.deepEqual(p.inbox(), []);
  assert.equal(pcRows(), 0);
  assert.equal(outboxRows(), 0);
  assert.deepEqual(filesIn(p.macOutbox), []);
  assert.equal(p.bytes(p.mac).sent, 0);
  // A streamed file to a locked project is refused there, and its snapshot goes again.
  fs.writeFileSync(path.join(p.alpha, 'take.wav'), wav(1000));
  await assert.rejects(management(p.mac).messageComputerManager('mac-alpha', 'pc-zips', 'pc-fort', 'x', ['take.wav']), /No files go to or from a locked project/);
  assert.equal(outboxRows(), 0);
  assert.deepEqual(filesIn(p.macOutbox), []);
  // The positive branch of the same probes: a zip of text and binary entries, nothing refused, goes; one row, one snapshot.
  fs.writeFileSync(path.join(p.alpha, 'clean.zip'), zip([ok, { name: 'lib/data.bin', data: Buffer.concat([Buffer.alloc(8), crypto.randomBytes(100)]) }, { name: 'docs/', data: Buffer.alloc(0) }]));
  await p.toPc('pc-beta', 'a clean zip', ['clean.zip']);
  assert.equal(p.inbox().length, 1);
  assert.equal(pcRows(), 1);
  assert.equal(outboxRows(), 1);
});

test('ledung#159: zipProblem reads a zip made by the format and refuses one that is not a zip or is cut off', async () => {
  const dir = temp('zipread');
  const ok = path.join(dir, 'ok.zip');
  fs.writeFileSync(ok, zip([{ name: 'a.txt', data: Buffer.from('hello'), deflate: true }, { name: 'b/c.bin', data: Buffer.from([0, 1, 2]) }]));
  const checks = { name: () => null, text: (_e: string, t: string) => (t.includes('hello') ? 'saw hello' : null) };
  // The text check sees the deflated entry's text: the reader opens it.
  assert.equal(await zipProblem(ok, checks), 'entry a.txt: saw hello');
  assert.equal(await zipProblem(ok, { name: () => null, text: () => null }), null);
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]));
  assert.match((await zipProblem(bad, checks))!, /not a zip file Ledung can read/);
  const cut = path.join(dir, 'cut.zip');
  const whole = fs.readFileSync(ok);
  fs.writeFileSync(cut, Buffer.concat([whole.subarray(0, 40), whole.subarray(whole.length - 22)]));
  assert.ok(await zipProblem(cut, checks), 'a zip cut short is refused');
  // Data descriptors (flag bit 3, as a zip written while streaming has them) fill the file too, and go.
  const streamed = path.join(dir, 'streamed.zip');
  fs.writeFileSync(streamed, zip([{ name: 'a.txt', data: Buffer.from('fine'), deflate: true, descriptor: true }, { name: 'b.bin', data: Buffer.from([0, 1]), descriptor: true }]));
  assert.equal(await zipProblem(streamed, checks), null);
  // Bytes after the end record, or between the directory and it, are not placed either.
  fs.writeFileSync(streamed, Buffer.concat([fs.readFileSync(ok), Buffer.from('trailing')]));
  assert.match((await zipProblem(streamed, checks))!, /bytes Ledung can't place/);
  // Review finding 2 on PR #175: the zip comment, an entry's comment and a folder entry's data go through the text check.
  const quiet = [{ name: 'b.bin', data: Buffer.from([0, 1]) }];
  const said = async (z: Buffer) => {
    fs.writeFileSync(streamed, z);
    return zipProblem(streamed, checks);
  };
  assert.equal(await said(zip(quiet, 'just a note')), null);
  assert.equal(await said(zip(quiet, 'key hello-abc')), "the zip's comment: saw hello");
  assert.equal(await said(zip([{ ...quiet[0]!, comment: 'hello there' }])), "entry b.bin's comment: saw hello");
  assert.equal(await said(zip([{ name: 'docs/', data: Buffer.from('hello in a folder') }])), 'entry docs/: saw hello');
});

test('ledung#159: /link/file-get gives the bytes only to the link and the manager the message went to, from where it is asked (Range)', { timeout: HANG_MS }, async () => {
  const p = await pair('get');
  const other = await nodes.ledung('other-get.stream.test');
  await nodes.link(p.mac, other, 'Mac');
  const sound = wav(200_000);
  fs.writeFileSync(path.join(p.alpha, 'take.wav'), sound);
  await p.toPc('pc-beta', 'sound', ['take.wav']);
  const id = (p.mac.db.prepare('SELECT id FROM linked_outbox').get() as { id: string }).id;
  /** One GET through the Mac's tunnel, its body as bytes. */
  const get = (key: string | null, q: Record<string, string>, range?: string) => new Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer }>((resolve, reject) => {
    const req = https.request({
      method: 'GET', path: `/link/file-get?${new URLSearchParams(q)}`, createConnection: () => nodes.connect(p.mac.name),
      headers: { host: p.mac.name, connection: 'keep-alive', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(range ? { range } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end();
  });
  const pcKey = keyFor(p.pc, p.mac);
  assert.equal((await get(null, { id, to: 'pc-beta' })).status, 401, 'no key');
  assert.equal((await get(keyFor(other, p.mac), { id, to: 'pc-beta' })).status, 403, 'another link\'s key');
  assert.equal((await get(pcKey, { id, to: 'pc-fort' })).status, 403, 'a manager the message did not name');
  assert.equal((await get(pcKey, { id: 'f'.repeat(16), to: 'pc-beta' })).status, 404, 'no such file');
  assert.equal((await get(pcKey, { id, to: 'pc-beta' }, `bytes=${sound.length}-`)).status, 416, 'past its end');
  // The positive branches: the whole file, and the rest of it from a byte on.
  const whole = await get(pcKey, { id, to: 'pc-beta' });
  assert.equal(whole.status, 200);
  assert.equal(sha(whole.bytes), sha(sound));
  const rest = await get(pcKey, { id, to: 'pc-beta' }, 'bytes=150000-');
  assert.equal(rest.status, 206);
  assert.equal(rest.headers['content-range'], `bytes 150000-${sound.length - 1}/${sound.length}`);
  assert.equal(sha(rest.bytes), sha(sound.subarray(150000)));
  // Only GET, and only through the tunnel: POST is not this route.
  assert.equal((await nodes.viaTunnel(p.mac.name, `/link/file-get?id=${id}&to=pc-beta`, { headers: { authorization: `Bearer ${pcKey}` } })).status, 404);
});

test('ledung#159: a fetch cut off midway resumes from where it stopped; one whose sender went offline fails with the reason, leaves no part, and the manager is told', { timeout: HANG_MS }, async () => {
  const p = await pair('resume');
  const sound = wav(3 * 1024 * 1024);
  fs.writeFileSync(path.join(p.alpha, 'take.wav'), sound);
  fs.writeFileSync(path.join(p.alpha, 'late.wav'), wav(100_000));
  const linked = (p.pc.server as unknown as { linked: LinkedComputers }).linked;
  const real = linked.fetchStream.bind(linked);
  const asked: number[] = [];
  let cut = true;
  // The connection cut after a megabyte, once: the network failing, not the code under test.
  linked.fetchStream = async (id, route, query, from, idle) => {
    asked.push(from);
    const got = await real(id, route, query, from, idle);
    if (!cut) return got;
    cut = false;
    // Piped, not a 'data' listener: one of those would start the body flowing before the fetch reads it.
    let seen = 0;
    const cutter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen <= 1024 * 1024) return done(null, chunk);
        got.body.destroy();
        done(new Error('connection reset'));
      },
    });
    got.body.pipe(cutter);
    return { body: cutter as unknown as typeof got.body, start: got.start };
  };
  await p.toPc('pc-beta', 'sound', ['take.wav']);
  await until(() => p.inbox().find((t) => /^Ledung: take\.wav .* is here/.test(t)), 'the resumed fetch');
  assert.equal(asked.length, 2, `asked from ${asked.join(', ')}`);
  assert.equal(asked[0], 0);
  // From the end of what the first call put on disk: past the start, short of the end (what was still on its way
  // when the connection went is asked for again).
  assert.ok(asked[1]! > 0 && asked[1]! <= 1024 * 1024, `the second call asked from where the first stopped on disk: ${asked[1]}`);
  const copy = filesIn(p.pcFiles).find((f) => f.endsWith('.wav'))!;
  assert.equal(sha(fs.readFileSync(path.join(p.pcFiles, copy))), sha(sound));
  assert.equal(p.bytes(p.pc).received, sound.length, 'received counted once, the whole file');

  // The Mac goes offline once the message is there: every try fails, the manager is told why, nothing is kept.
  management(p.pc).fetchOptions = { tries: 2, backoffMs: 10 };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  linked.fetchStream = async (id, route, query, from, idle) => {
    await held;
    return real(id, route, query, from, idle);
  };
  await p.toPc('pc-beta', 'more', ['late.wav']);
  const handle = handleOf(p.inbox().at(-1)!, 'late.wav')!;
  nodes.offline(p.mac.name);
  release();
  const failed = await until(() => p.inbox().find((t) => /late\.wav/.test(t) && /could not be fetched/.test(t)), 'the failure line');
  assert.match(failed, new RegExp(`^Ledung: late\\.wav \\(WAV audio, 98 KB\\) from your computer "Mac" could not be fetched: mac-resume\\.stream\\.test is offline \\(its Ledung is not connected to the relay\\)\\. \\(tried 2 times\\)\\. Nothing of it is kept here; ask that manager to send it again\\.$`));
  assert.deepEqual(filesIn(p.pcFiles).filter((f) => f.endsWith('.part') || /late/.test(f)), [], 'no part, no copy');
  assert.equal(filesIn(p.pcFiles).filter((f) => f.endsWith('.wav')).length, 1, 'only the first file\'s copy');
  assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', handle, 'pc-worker', 'late.wav'), /late\.wav could not be fetched from the linked computer \(.*offline.*\); nothing of it is kept/);
  assert.equal(p.bytes(p.pc).received, sound.length, 'nothing more counted');
});

test('ledung#159: the sender\'s snapshots and the receiver\'s copies are pruned after board.evidenceDays; a snapshot read to its end goes an hour later, not before', { timeout: HANG_MS }, async () => {
  const p = await pair('prune', { board: { evidenceDays: 2 } });
  fs.writeFileSync(path.join(p.alpha, 'a.wav'), wav(1000));
  fs.writeFileSync(path.join(p.alpha, 'b.wav'), wav(1000));
  fs.writeFileSync(path.join(p.alpha, 'c.wav'), wav(1000));
  fs.writeFileSync(path.join(p.alpha, 'd.wav'), wav(1000));
  // Four snapshots offered; none fetched yet (the PC's fetches are held).
  const linked = (p.pc.server as unknown as { linked: LinkedComputers }).linked;
  const real = linked.fetchStream.bind(linked);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  linked.fetchStream = async (...a) => {
    await held;
    return real(...a);
  };
  await p.toPc('pc-beta', 'four', ['a.wav', 'b.wav', 'c.wav', 'd.wav']);
  const rows = p.mac.db.prepare('SELECT id, name FROM linked_outbox').all() as { id: string; name: string }[];
  const byName = (n: string) => rows.find((r) => r.name === n)!.id;
  const day = 86400000;
  // a: made three days ago (past 2 evidence days); b: read to its end two hours ago; c: fresh, never read; d: read to
  // its end half an hour ago, inside the hour (test review on PR #175: the near side of FETCHED_KEEP_MS).
  p.mac.db.prepare('UPDATE linked_outbox SET created_at = ? WHERE id = ?').run(Date.now() - 3 * day, byName('a.wav'));
  p.mac.db.prepare('UPDATE linked_outbox SET fetched_at = ? WHERE id = ?').run(Date.now() - 2 * 3600_000, byName('b.wav'));
  p.mac.db.prepare('UPDATE linked_outbox SET fetched_at = ? WHERE id = ?').run(Date.now() - 1800_000, byName('d.wav'));
  p.mac.manager.linkedOutbox.prune(true);
  const left = filesIn(p.macOutbox).map((f) => path.basename(f, '.wav')).sort();
  assert.deepEqual(left, [byName('c.wav'), byName('d.wav')].sort(), 'the fresh one and the one read half an hour ago are kept');
  const pruned = (p.mac.db.prepare('SELECT name FROM linked_outbox WHERE pruned_at IS NOT NULL ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(pruned, ['a.wav', 'b.wav']);
  release();
  // a and b are gone on the Mac: their fetches fail with that reason; c and d arrive.
  await until(() => p.inbox().filter((t) => /^Ledung: /.test(t)).length === 4 || null, 'four fetch lines');
  assert.ok(p.inbox().some((t) => /^Ledung: d\.wav .* is here/.test(t)), p.inbox().join('\n'));
  assert.ok(p.inbox().some((t) => /^Ledung: a\.wav .* could not be fetched: .*answered 404: a\.wav is no longer kept here/.test(t)), p.inbox().join('\n'));
  const cLine = p.inbox().find((t) => /^Ledung: c\.wav .* is here/.test(t))!;
  // The receiver's copy of c: three days old with 2 evidence days, pruned; save_linked_file then says so. d's is fresh, kept.
  const cId = handleOf(cLine, 'c.wav')!.slice(7, 23);
  p.pc.db.prepare('UPDATE linked_files SET received_at = ? WHERE id = ?').run(Date.now() - 3 * day, cId);
  assert.equal(filesIn(p.pcFiles).filter((f) => f.endsWith('.wav')).length, 2);
  p.pc.manager.linkedFiles.prune(true);
  assert.equal(filesIn(p.pcFiles).filter((f) => f.endsWith('.wav')).length, 1);
  assert.ok(!filesIn(p.pcFiles).some((f) => f.includes(cId)), "c's copy is gone");
  assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', handleOf(cLine, 'c.wav')!, 'pc-worker', 'c.wav'), /c\.wav was pruned/);
});
