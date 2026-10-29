import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hiddenProblem, readProjectBytes, readProjectFile, readProjectImage } from '../src/sessions/files.ts';
import { readCachedImage, readEvidence } from '../src/board/attachments.ts';
import { removeTemp } from './temp.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-files-'));
const root = path.join(base, 'project with space');
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Notes\n');
fs.writeFileSync(path.join(root, 'docs', 'brief.md'), 'brief');
fs.writeFileSync(path.join(root, 'main.ts'), 'export {};\n');
fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
fs.writeFileSync(path.join(base, 'secret.txt'), 'outside');
after(() => removeTemp(base));

test('reads Markdown and text files inside the project', () => {
  assert.deepEqual(readProjectFile(root, 'CLAUDE.md'), { path: 'CLAUDE.md', kind: 'markdown', content: '# Notes\n' });
  assert.equal(readProjectFile(root, 'main.ts').kind, 'text');
});

test('accepts chat-style links: encoded, with a #fragment, or absolute inside the project', () => {
  assert.equal(readProjectFile(root, 'docs/brief.md#section').path, 'docs/brief.md');
  assert.equal(readProjectFile(root, 'docs%2Fbrief.md').path, 'docs/brief.md');
  assert.equal(readProjectFile(root, path.join(root, 'docs', 'brief.md')).path, 'docs/brief.md');
});

test('never reads outside the project folder', () => {
  assert.throws(() => readProjectFile(root, '../secret.txt'), /inside the project/);
  assert.throws(() => readProjectFile(root, path.join(base, 'secret.txt')), /inside the project/);
  assert.throws(() => readProjectFile(root, '..%2Fsecret.txt'), /inside the project/);
});

test('refuses folders, binary files and missing files', () => {
  assert.throws(() => readProjectFile(root, 'docs'), /folder/);
  assert.throws(() => readProjectFile(root, 'image.png'), /not a text file/);
  assert.throws(() => readProjectFile(root, 'nope.md'), /no file/);
});

// Images (decision 2026-10-14: PNG and JPEG only).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
fs.writeFileSync(path.join(root, 'docs', 'real.png'), PNG);
fs.writeFileSync(path.join(root, 'photo.JPG'), JPEG);
fs.writeFileSync(path.join(root, 'photo.jpeg'), JPEG);
fs.writeFileSync(path.join(root, 'fake.png'), 'not an image at all');
fs.writeFileSync(path.join(root, 'swapped.jpg'), PNG);
fs.writeFileSync(path.join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
fs.writeFileSync(path.join(root, 'anim.gif'), 'GIF89a');
fs.writeFileSync(path.join(root, 'pic.webp'), 'RIFFxxxxWEBP');
fs.writeFileSync(path.join(base, 'outside.png'), PNG);

test('reads PNG and JPEG images inside the project, with the type from the extension in any case', () => {
  const png = readProjectImage(root, 'docs/real.png');
  assert.equal(png.type, 'image/png');
  assert.equal(png.path, 'docs/real.png');
  assert.deepEqual(png.bytes, PNG);
  assert.equal(readProjectImage(root, 'photo.JPG').type, 'image/jpeg');
  assert.equal(readProjectImage(root, 'photo.jpeg').type, 'image/jpeg');
  assert.equal(readProjectImage(root, 'docs%2Freal.png#x').path, 'docs/real.png');
});

test('images are never read from outside the project folder', () => {
  assert.throws(() => readProjectImage(root, '../outside.png'), /inside the project/);
  assert.throws(() => readProjectImage(root, '..%2Foutside.png'), /inside the project/);
  assert.throws(() => readProjectImage(root, path.join(base, 'outside.png')), /inside the project/);
  assert.throws(() => readProjectImage(root, 'docs/../../outside.png'), /inside the project/);
});

test('a link inside the project that leads outside it is refused', (t) => {
  try {
    fs.symlinkSync(path.join(base, 'outside.png'), path.join(root, 'link.png'));
  } catch {
    t.skip('this machine does not allow links');
    return;
  }
  assert.throws(() => readProjectImage(root, 'link.png'), /inside the project/);
});

test('other extensions are refused as images, even when the content is an image', () => {
  for (const name of ['logo.svg', 'anim.gif', 'pic.webp', 'main.ts', 'CLAUDE.md']) {
    assert.throws(() => readProjectImage(root, name), /not a PNG or JPEG/, name);
  }
});

test('a file whose first bytes are not those of its extension is refused', () => {
  assert.throws(() => readProjectImage(root, 'fake.png'), /not really a PNG/);
  assert.throws(() => readProjectImage(root, 'swapped.jpg'), /not really a JPEG/);
});

test('refuses missing images, folders and images over 10 MB', () => {
  assert.throws(() => readProjectImage(root, 'nope.png'), /no file/);
  assert.throws(() => readProjectImage(root, 'docs'), /folder/);
  const big = path.join(root, 'big.png');
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
  assert.throws(() => readProjectImage(root, 'big.png'), /too large.*10 MB/);
});

// A session with its own folder (start_session's cwd, decision of 2026-10-14) has that folder as the
// root: the project folder next to it is outside, the same as any other folder.
test("a session's own folder is the root: nothing outside it, not even the project folder", () => {
  const worktree = path.join(base, 'project-wt', '12');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'NOTES.md'), 'in the worktree');
  assert.equal(readProjectFile(worktree, 'NOTES.md').content, 'in the worktree');
  assert.equal(readProjectFile(worktree, path.join(worktree, 'NOTES.md')).path, 'NOTES.md');
  assert.throws(() => readProjectFile(worktree, '../../project with space/CLAUDE.md'), /inside the project/);
  assert.throws(() => readProjectFile(worktree, path.join(root, 'CLAUDE.md')), /inside the project/);
  assert.throws(() => readProjectImage(worktree, path.join(root, 'docs', 'real.png')), /inside the project/);
});

// Board attachments are read from the board cache with the same rules: the repo's cache folder is the root.
test("board attachment images: only inside the repo's cache folder, never another repo's or the cache around it", () => {
  const cache = path.join(base, 'board-cache');
  fs.mkdirSync(path.join(cache, 'org', 'board', '3'), { recursive: true });
  fs.mkdirSync(path.join(cache, 'org', 'other', '1'), { recursive: true });
  fs.copyFileSync(path.join(root, 'docs', 'real.png'), path.join(cache, 'org', 'board', '3', 'aaaaaaaaaaaa-a.png'));
  fs.copyFileSync(path.join(root, 'docs', 'real.png'), path.join(cache, 'org', 'other', '1', 'bbbbbbbbbbbb-b.png'));
  assert.equal(readCachedImage(cache, 'org/board', '3/aaaaaaaaaaaa-a.png').path, '3/aaaaaaaaaaaa-a.png');
  assert.throws(() => readCachedImage(cache, 'org/board', '../other/1/bbbbbbbbbbbb-b.png'), /inside the project/);
  assert.throws(() => readCachedImage(cache, 'org/board', path.join(root, 'image.png')), /inside the project/);
  assert.throws(() => readCachedImage(cache, 'org/..', 'board/3/aaaaaaaaaaaa-a.png'), /not a board repo/);
  assert.throws(() => readCachedImage(cache, 'org', '3/aaaaaaaaaaaa-a.png'), /not a board repo/);
});

// Board attachments read a file's bytes to decide its kind from them: the same path rules, and the size before reading.
test('raw bytes: the same path rules, and a file over the limit refused before it is read', () => {
  assert.equal(readProjectBytes(root, 'docs/real.png', 1024 * 1024).path, 'docs/real.png');
  assert.throws(() => readProjectBytes(root, '../secret.txt', 1024), /inside the project/);
  assert.throws(() => readProjectBytes(root, path.join(base, 'secret.txt'), 1024), /inside the project/);
  assert.throws(() => readProjectBytes(root, 'docs', 1024), /is a folder/);
  assert.throws(() => readProjectBytes(root, 'docs/real.png', 4), /too large/);
});

// A review's evidence (docs/steps/pr-review.md): a board attachment's kinds and limits, by the first bytes,
// with the file viewer's path rules.
test("review evidence: images and text files inside the folder only, each kind by its first bytes, text up to 512 KB", () => {
  fs.mkdirSync(path.join(root, 'ev'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ev', 'run.log'), 'ok\n');
  fs.writeFileSync(path.join(root, 'ev', 'notes.md'), '# n');
  fs.writeFileSync(path.join(root, 'ev', '.env'), 'TOKEN=x');
  fs.writeFileSync(path.join(root, 'ev', 'fake.png'), 'not a png');
  fs.writeFileSync(path.join(root, 'ev', 'png.txt'), fs.readFileSync(path.join(root, 'docs', 'real.png')));
  fs.writeFileSync(path.join(root, 'ev', 'binary.log'), Buffer.from([0x41, 0, 0x42]));
  fs.writeFileSync(path.join(root, 'ev', 'big.log'), 'x'.repeat(512 * 1024 + 1));
  assert.deepEqual(readEvidence(root, 'ev/run.log'), { path: 'ev/run.log', kind: 'text', bytes: Buffer.from('ok\n') });
  assert.equal(readEvidence(root, 'ev/notes.md').kind, 'text');
  assert.equal(readEvidence(root, 'docs/real.png').kind, 'png');
  assert.throws(() => readEvidence(root, '../secret.txt'), /inside the project/);
  assert.throws(() => readEvidence(root, path.join(base, 'secret.txt')), /inside the project/);
  assert.throws(() => readEvidence(root, 'ev'), /is a folder/);
  for (const bad of ['ev/.env', 'main.ts', 'ev/png.txt', 'ev/binary.log']) assert.throws(() => readEvidence(root, bad), /can't be attached: only PNG and JPEG/, bad);
  assert.throws(() => readEvidence(root, 'ev/fake.png'), /not really a PNG/);
  assert.throws(() => readEvidence(root, 'ev/big.log'), /too large .*512 KB/);
});

test("a chat's dot rule (issue #211) counts from the browse root: a chat folder inside a dot-folder, or a link to one, can't get around it", () => {
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key');
  fs.writeFileSync(path.join(home, 'plain', 'notes.txt'), 'notes');
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'plain', 'keys'), 'junction');
  const roots = [home];
  assert.equal(hiddenProblem(home, 'plain/notes.txt', roots), null, 'a plain file in a plain folder is shown');
  assert.match(hiddenProblem(home, '.ssh/id_ed25519', roots) ?? '', /hidden/);
  // The chat runs in ~/.ssh itself: a plain-named file there is still under a dot-folder of the browse root.
  assert.match(hiddenProblem(path.join(home, '.ssh'), 'id_ed25519', roots) ?? '', /hidden/);
  // A plain-named link that leads into a dot-folder: the real path is what counts.
  assert.match(hiddenProblem(home, 'plain/keys/id_ed25519', roots) ?? '', /hidden/);
});

/** The Windows 8.3 short name of `dir` (for example SSH~1 for .ssh), or null when the volume makes none. */
function shortName(dir: string): string | null {
  const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout.trim();
  const name = path.basename(out);
  return name && name !== path.basename(dir) ? name : null;
}

test("a chat's dot rule can't be got round through a dot-folder's Windows short name (SSH~1 for .ssh; review round 2, finding 1)", { skip: process.platform !== 'win32' }, (t) => {
  const home = path.join(base, 'home-short');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key');
  const short = shortName(path.join(home, '.ssh'));
  if (!short) {
    t.skip('this volume makes no 8.3 short names');
    return;
  }
  assert.match(hiddenProblem(home, `${short}/id_ed25519`, [home]) ?? '', /hidden/, `${short} is .ssh`);
  // A chat started in the short name is in .ssh too.
  assert.match(hiddenProblem(path.join(home, short), 'id_ed25519', [home]) ?? '', /hidden/);
});

test("a chat's file viewer also refuses folders that hold settings and tokens without a dot (Martin, question #317): on the real path, from inside one too", () => {
  const home = path.join(base, 'home-private');
  const appData = path.join(home, 'AppData', 'Roaming', 'tool');
  const data = path.join(base, 'ledung-data');
  for (const d of [appData, data, path.join(home, 'work')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(appData, 'token.txt'), 't');
  fs.writeFileSync(path.join(data, 'auth-token'), 't');
  fs.writeFileSync(path.join(home, 'work', 'notes.txt'), 'n');
  fs.symlinkSync(path.join(home, 'AppData'), path.join(home, 'work', 'app'), 'junction');
  const roots = [home, base];
  const refused = [path.join(home, 'AppData'), data];
  assert.equal(hiddenProblem(home, 'work/notes.txt', roots, refused), null, 'an ordinary file is shown');
  assert.match(hiddenProblem(home, 'AppData/Roaming/tool/token.txt', roots, refused) ?? '', /not shown/);
  assert.match(hiddenProblem(home, 'work/app/Roaming/tool/token.txt', roots, refused) ?? '', /not shown/, 'a link into it');
  assert.match(hiddenProblem(appData, 'token.txt', roots, refused) ?? '', /not shown/, 'a chat started inside it');
  assert.match(hiddenProblem(base, 'ledung-data/auth-token', roots, refused) ?? '', /not shown/, "Ledung's data folder, wherever it is");
});
