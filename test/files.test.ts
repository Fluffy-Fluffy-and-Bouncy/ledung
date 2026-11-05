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

test("a workflow's files (issue #310) keep the viewer's rules: inside the folder, links resolved, a text limit", async (t) => {
  const { localReader } = await import('../src/sessions/flow-files.ts');
  fs.mkdirSync(path.join(root, '.ledung', 'workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ledung', 'workflow', 'rules.md'), '# Rules');
  fs.writeFileSync(path.join(root, '.ledung', 'workflow', 'bin.md'), Buffer.from([0x23, 0, 0x41]));
  fs.writeFileSync(path.join(root, '.ledung', 'workflow', 'big.md'), 'x'.repeat(256 * 1024 + 1));
  const read = localReader(root, '.ledung/workflow');
  const got = await read(['rules.md', 'bin.md', 'big.md', 'missing.md', '../../../secret.txt', '../../CLAUDE.md']);
  assert.deepEqual(got.get('rules.md'), { text: '# Rules' });
  assert.deepEqual(got.get('missing.md'), { missing: true });
  for (const f of ['bin.md', 'big.md', '../../../secret.txt']) assert.ok('refused' in got.get(f)!, f);
  assert.match((got.get('../../../secret.txt') as { refused: string }).refused, /inside the project folder/);
  // The reader itself keeps to the project folder; staying inside the workflow folder is the format's rule (src/shared/flow-check.ts).
  assert.deepEqual(got.get('../../CLAUDE.md'), { text: '# Notes\n' });
  try {
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, '.ledung', 'workflow', 'out.md'));
  } catch {
    t.skip('this machine does not allow links');
    return;
  }
  assert.match(((await read(['out.md'])).get('out.md') as { refused: string }).refused, /inside the project folder/);
});

// The builder's writer (issue #311): only into the project's own .ledung/workflow, never through a link, folders made
// as needed, every file checked before any is written, each written whole.
test("the workflow writer (issue #311) writes inside the project's own workflow folder only, never through a link", async (t) => {
  const { localWriter, localLister } = await import('../src/sessions/flow-files.ts');
  const project = fs.mkdtempSync(path.join(base, 'writer-'));
  const outside = fs.mkdtempSync(path.join(base, 'writer-outside-'));
  const write = localWriter(project);
  const folder = path.join(project, '.ledung', 'workflow');
  await write([{ path: 'briefs/a.md', text: '# A' }, { path: 'manager.md', text: '# M' }, { path: 'rules.md', text: 'rules' }, { path: 'flow.json', text: '{}' }]);
  assert.equal(fs.readFileSync(path.join(folder, 'briefs', 'a.md'), 'utf8'), '# A');
  assert.equal(fs.readFileSync(path.join(folder, 'flow.json'), 'utf8'), '{}');
  await write([{ path: 'briefs/a.md', text: '# A again' }]);
  assert.equal(fs.readFileSync(path.join(folder, 'briefs', 'a.md'), 'utf8'), '# A again');
  assert.deepEqual(fs.readdirSync(path.join(folder, 'briefs')), ['a.md'], 'no temporary file left behind');
  assert.deepEqual(await localLister(project, '.ledung/workflow')(), ['manager.md', 'briefs/a.md'], "the manager's file is listed too (#322)");
  // Something in the way that isn't a folder or a file: refused, and nothing of the save is written.
  fs.mkdirSync(path.join(folder, 'overlays', 'x.md'), { recursive: true });
  await assert.rejects(write([{ path: 'briefs/b.md', text: 'b' }, { path: 'overlays/x.md', text: 'x' }]), /overlays\/x\.md is not a file/);
  assert.equal(fs.existsSync(path.join(folder, 'briefs', 'b.md')), false, 'all checked before any is written');
  // Links: the workflow folder, .ledung or a brief that is a link (a junction on Windows) is not written through.
  fs.writeFileSync(path.join(outside, 'target.md'), 'KEEP');
  let linked = true;
  try {
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(folder, 'briefs', 'linked.md'));
  } catch {
    linked = false;
  }
  if (linked) {
    await assert.rejects(write([{ path: 'briefs/linked.md', text: 'CHANGED' }]), /briefs\/linked\.md is a link/);
    assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'KEEP');
  }
  const other = fs.mkdtempSync(path.join(base, 'writer-'));
  fs.symlinkSync(outside, path.join(other, '.ledung'), 'junction');
  await assert.rejects(localWriter(other)([{ path: 'rules.md', text: 'CHANGED' }]), /^Error: \.ledung is a link/);
  assert.equal(fs.existsSync(path.join(outside, 'workflow')), false, 'nothing made outside');
  if (!linked) t.diagnostic('this machine does not allow file links: the brief link case was not run');
});

// The same rules in a container (issue #311): WRITE_FLOW_SCRIPT run by a real sh here, as docker exec runs it there.
test("a container's workflow writer script: folders made, the text from stdin, links and other things in the way refused", (t) => {
  if (spawnSync('sh', ['-c', 'readlink -f .'], { windowsHide: true }).status !== 0) {
    t.skip('no sh with readlink here');
    return;
  }
  return import('../src/runners/docker-runner.ts').then(({ WRITE_FLOW_SCRIPT, LIST_FLOW_SCRIPT }) => {
    const project = fs.mkdtempSync(path.join(base, 'box-')).replaceAll('\\', '/');
    const sh = (args: string[], input = '') => spawnSync('sh', ['-c', WRITE_FLOW_SCRIPT, 'sh', ...args], { input, encoding: 'utf8', windowsHide: true });
    assert.equal(sh(['check', project, 'briefs/a.md', 'flow.json']).status, 0);
    assert.equal(fs.existsSync(path.join(project, '.ledung')), false, 'checking makes nothing');
    const written = sh(['write', project, 'briefs/a.md'], '# A\nwith "quotes" and $HOME\n');
    assert.equal(written.status, 0, written.stdout + written.stderr);
    assert.equal(fs.readFileSync(path.join(project, '.ledung', 'workflow', 'briefs', 'a.md'), 'utf8'), '# A\nwith "quotes" and $HOME\n');
    assert.deepEqual(fs.readdirSync(path.join(project, '.ledung', 'workflow', 'briefs')), ['a.md'], 'no temporary file left behind');
    assert.equal(sh(['write', project, 'manager.md'], '# M\n').status, 0);
    const listed = spawnSync('sh', ['-c', LIST_FLOW_SCRIPT, 'sh', project], { encoding: 'utf8', windowsHide: true });
    assert.equal(listed.stdout, 'manager.md\nbriefs/a.md\n', "the manager's file is listed too (#322)");
    fs.mkdirSync(path.join(project, '.ledung', 'workflow', 'rules.md'));
    const inTheWay = sh(['check', project, 'briefs/b.md', 'rules.md']);
    assert.equal(inTheWay.status, 3);
    assert.match(inTheWay.stdout, /rules\.md is not a file/);
    const noRoot = sh(['check', path.join(project, 'missing', 'deeper').replaceAll('\\', '/'), 'flow.json']);
    assert.equal(noRoot.status, 3);
  });
});

// The local writer checks the way again just before each rename (security review of PR #89, finding 4): a folder
// swapped for a link (a junction on Windows) after the first check, so the file goes through it, is refused, and what
// was written through it is taken away again.
test('the workflow writer refuses a folder swapped for a link between its check and the rename', async () => {
  const { localWriter } = await import('../src/sessions/flow-files.ts');
  const project = fs.mkdtempSync(path.join(base, 'swap-'));
  const outside = fs.mkdtempSync(path.join(base, 'swap-outside-'));
  const briefs = path.join(project, '.ledung', 'workflow', 'briefs');
  fs.mkdirSync(briefs, { recursive: true });
  const write = localWriter(project, {
    beforeWrite: () => {
      fs.renameSync(briefs, `${briefs}-old`);
      fs.symlinkSync(outside, briefs, 'junction');
    },
  });
  await assert.rejects(write([{ path: 'briefs/a.md', text: 'CHANGED' }]), /briefs is a link/);
  assert.ok(fs.existsSync(`${briefs}-old`), 'the swap ran');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing left through the link');
});

// The container's read script run by a real sh here, as docker exec runs it there (security review of PR #89,
// finding 1): it must compare the file's real path with the project's, so a link out of the folder is refused.
test("a container's workflow read script reads only inside the project: a link out is refused, a plain file read", (t) => {
  if (spawnSync('sh', ['-c', 'readlink -f .'], { windowsHide: true }).status !== 0) {
    t.skip('no sh with readlink here');
    return;
  }
  return import('../src/runners/docker-runner.ts').then(({ INSIDE_PROJECT_SCRIPT, splitMarked }) => {
    const project = fs.mkdtempSync(path.join(base, 'read-box-')).replaceAll('\\', '/');
    const outside = fs.mkdtempSync(path.join(base, 'read-outside-'));
    const folder = path.join(project, '.ledung', 'workflow');
    fs.mkdirSync(path.join(folder, 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'x.md'), 'SECRET-OUTSIDE');
    fs.symlinkSync(outside, path.join(folder, 'briefs'), 'junction');
    fs.writeFileSync(path.join(folder, 'rules.md'), '# Rules\n');
    fs.writeFileSync(path.join(folder, 'overlays', 'big.md'), 'x'.repeat(200));
    fs.writeFileSync(path.join(folder, 'overlays', 'bin.md'), 'a\0b');
    const files = ['rules.md', 'briefs/x.md', 'overlays/big.md', 'overlays/bin.md', 'manager.md'].map((f) => `.ledung/workflow/${f}`);
    const run = spawnSync('sh', ['-c', INSIDE_PROJECT_SCRIPT, 'sh', 'MARK', project, '100', '10000', ...files], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes('SECRET-OUTSIDE'), 'the text outside is never printed');
    const got = splitMarked(run.stdout, files, 'MARK');
    assert.deepEqual(got.get('.ledung/workflow/rules.md'), { text: '# Rules\n' });
    assert.deepEqual(got.get('.ledung/workflow/briefs/x.md'), { refused: '.ledung/workflow/briefs/x.md leads outside the project folder.' });
    assert.deepEqual(got.get('.ledung/workflow/overlays/big.md'), { refused: '.ledung/workflow/overlays/big.md is larger than 100 bytes.' });
    assert.deepEqual(got.get('.ledung/workflow/overlays/bin.md'), { refused: '.ledung/workflow/overlays/bin.md is not a text file.' });
    assert.deepEqual(got.get('.ledung/workflow/manager.md'), { missing: true });
  });
});

// The container's write script, by a real sh (security review of PR #89, findings 3 and 4): a file that is a link is
// refused, and so is a folder swapped for a link after the first check, just before the rename. The swap is made by
// a readlink put in front of the real one, when the script checks the folder again.
test("a container's workflow writer script refuses a file that is a link, and a folder that became one before the rename", (t) => {
  if (spawnSync('sh', ['-c', 'readlink -f .'], { windowsHide: true }).status !== 0) {
    t.skip('no sh with readlink here');
    return;
  }
  return import('../src/runners/docker-runner.ts').then(({ WRITE_FLOW_SCRIPT }) => {
    const project = fs.mkdtempSync(path.join(base, 'write-box-')).replaceAll('\\', '/');
    const outside = fs.mkdtempSync(path.join(base, 'write-outside-'));
    const briefs = path.join(project, '.ledung', 'workflow', 'briefs');
    fs.mkdirSync(briefs, { recursive: true });

    // A brief that is a link to a file outside.
    fs.writeFileSync(path.join(outside, 'target.md'), 'KEEP');
    let linked = true;
    try {
      fs.symlinkSync(path.join(outside, 'target.md'), path.join(briefs, 'linked.md'));
    } catch {
      linked = false;
    }
    if (linked) {
      const refused = spawnSync('sh', ['-c', WRITE_FLOW_SCRIPT, 'sh', 'write', project, 'briefs/linked.md'], { input: 'CHANGED', encoding: 'utf8', windowsHide: true });
      assert.equal(refused.status, 3, refused.stdout + refused.stderr);
      assert.match(refused.stdout, /briefs\/linked\.md is a link/);
      assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'KEEP');
      fs.rmSync(path.join(briefs, 'linked.md'));
    } else {
      t.diagnostic('this machine does not allow file links: the linked brief case was not run');
    }

    // The folder swapped for a junction to outside right after the script makes it, so the text goes through it: a
    // mkdir in front of the real one (a shell function, so no file needs to run from the temp folder).
    const fresh = fs.mkdtempSync(path.join(base, 'swap-box-')).replaceAll('\\', '/');
    const away = fs.mkdtempSync(path.join(base, 'swap-outside-'));
    fs.mkdirSync(path.join(fresh, '.ledung', 'workflow'), { recursive: true });
    const spare = path.join(fresh, 'briefs-link');
    fs.symlinkSync(away, spare, 'junction');
    const front = 'mkdir() { command mkdir "$@" || return; case "$2" in */.ledung/workflow/briefs) command mv -- "$2" "$2-old" && command mv -- "$SWAP_FROM" "$2";; esac; }\n';
    const env = { ...process.env, SWAP_FROM: spare.replaceAll('\\', '/') };
    const swapped = spawnSync('sh', ['-c', front + WRITE_FLOW_SCRIPT, 'sh', 'write', fresh, 'briefs/a.md'], { input: 'CHANGED', encoding: 'utf8', windowsHide: true, env });
    assert.ok(fs.existsSync(path.join(fresh, '.ledung', 'workflow', 'briefs-old')), `the swap ran: ${swapped.stdout}${swapped.stderr}`);
    assert.equal(swapped.status, 3, swapped.stdout + swapped.stderr);
    assert.match(swapped.stdout, /became a link/);
    assert.deepEqual(fs.readdirSync(away), [], 'nothing left through the link');
  });
});

// --- A container project's files (issue #122) ------------------------------------------------------------
// The scripts run by a real sh here, as `docker exec … sh -c` runs them in the container: the same fake runner
// test/server-security.test.ts uses. The folder by its long real name, so Git Bash's /proc agrees with readlink.
const hasSh = spawnSync('sh', ['-c', 'readlink -f . && head -c 1 /dev/null'], { windowsHide: true }).status === 0;
const ctBase = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-ctfiles-')));
after(() => removeTemp(ctBase));
const ctDir = path.join(ctBase, 'project');
// The path as the container's sh sees it: POSIX, so /c/... under Git Bash.
const posix = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : p).replaceAll('\\', '/');
const ctRoot = posix(ctDir);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SECRETS_NAME = 'ledung-1234abcd-0000-0000-0000-000000000000.env.txt';
fs.mkdirSync(path.join(ctDir, 'shots'), { recursive: true });
fs.mkdirSync(path.join(ctDir, '.hidden'), { recursive: true });
fs.mkdirSync(path.join(ctDir, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(ctDir, 'locked'), { recursive: true });
fs.writeFileSync(path.join(ctDir, 'shots', 'home.png'), PNG_BYTES);
fs.writeFileSync(path.join(ctDir, 'shots', 'fake.png'), 'not a png');
fs.writeFileSync(path.join(ctDir, 'notes.md'), '# Notes\n');
fs.writeFileSync(path.join(ctDir, 'run.log'), 'ok\n');
fs.writeFileSync(path.join(ctDir, 'main.ts'), 'export {};\n');
fs.writeFileSync(path.join(ctDir, '.env'), 'TOKEN=x\n');
fs.writeFileSync(path.join(ctDir, 'big.txt'), 'x'.repeat(3 * 1024 * 1024));
fs.writeFileSync(path.join(ctDir, 'deploy-keys.txt'), 'secret\n');
fs.writeFileSync(path.join(ctDir, SECRETS_NAME), 'x\n');
fs.writeFileSync(path.join(ctDir, 'locked', 'plan.md'), '# locked\n');
fs.writeFileSync(path.join(ctBase, 'outside.md'), '# outside\n');

async function containerFiles() {
  const cf = await import('../src/sessions/container-files.ts');
  const { runCappedBytes } = await import('../src/sessions/git-read.ts');
  const access = (over: Partial<import('../src/sessions/container-files.ts').ContainerAccess> = {}): import('../src/sessions/container-files.ts').ContainerAccess => ({
    container: 'test-ct', project: ctRoot, locked: [], pathPatterns: [],
    exec: (script, args, opts) => runCappedBytes('sh', ['-c', script, 'sh', ...args], opts),
    ...over,
  });
  return { ...cf, access };
}

test("a container's file viewer: .md, .txt and .log text and PNG or JPEG images, inside the project folder only", { skip: !hasSh && 'no sh with readlink here' }, async () => {
  const { access, readContainerText, readContainerImage } = await containerFiles();
  assert.deepEqual(await readContainerText(access(), ctRoot, 'notes.md'), { path: 'notes.md', kind: 'markdown', content: '# Notes\n' });
  assert.equal((await readContainerText(access(), ctRoot, 'run.log#end')).kind, 'text');
  assert.equal((await readContainerText(access(), ctRoot, `${ctRoot}/notes.md`)).path, 'notes.md', 'absolute inside the folder');
  assert.equal((await readContainerText(access(), ctRoot, 'shots%2F..%2Fnotes.md')).path, 'notes.md', 'encoded');
  const image = await readContainerImage(access(), ctRoot, 'shots/home.png');
  assert.equal(image.type, 'image/png');
  assert.deepEqual(image.bytes, PNG_BYTES);
});

test("a container's files: a path that leads out, the wrong type, too large or a folder is refused", { skip: !hasSh && 'no sh with readlink here' }, async (t) => {
  const { access, readContainerText, readContainerImage, readContainerBytes } = await containerFiles();
  const a = access();
  await assert.rejects(readContainerText(a, ctRoot, '../outside.md'), /inside the project folder/);
  await assert.rejects(readContainerText(a, ctRoot, `${posix(ctBase)}/outside.md`), /inside the project folder/);
  await assert.rejects(readContainerText(a, ctRoot, '..%2Foutside.md'), /inside the project folder/);
  await assert.rejects(readContainerText(a, ctRoot, 'main.ts'), /only \.md, \.txt and \.log/);
  await assert.rejects(readContainerText(a, ctRoot, '.env'), /only \.md, \.txt and \.log/);
  await assert.rejects(readContainerImage(a, ctRoot, 'notes.md'), /not a PNG or JPEG/);
  await assert.rejects(readContainerImage(a, ctRoot, 'shots/fake.png'), /not really a PNG/);
  await assert.rejects(readContainerText(a, ctRoot, 'big.txt'), /too large/);
  await assert.rejects(readContainerBytes(a, ctRoot, 'notes.md', 4, () => null), /too large/, 'checked before it is read');
  await assert.rejects(readContainerText(a, ctRoot, 'shots'), /is a folder/);
  await assert.rejects(readContainerText(a, ctRoot, 'nope.md'), /no file nope\.md/);
  await assert.rejects(readContainerText(a, ctRoot, 'a\nb.md'), /not a file name/);
  // A link: judged by where it leads, so out of the folder is refused and x.png to notes.md is notes.md.
  try {
    fs.symlinkSync(path.join(ctBase, 'outside.md'), path.join(ctDir, 'out.md'));
    fs.symlinkSync(path.join(ctDir, 'notes.md'), path.join(ctDir, 'shots', 'renamed.png'));
  } catch {
    t.diagnostic('this machine does not allow file links: the link cases were not run');
    return;
  }
  await assert.rejects(readContainerText(a, ctRoot, 'out.md'), /inside the project folder/);
  await assert.rejects(readContainerImage(a, ctRoot, 'shots/renamed.png'), /notes\.md is not a PNG or JPEG/);
  fs.rmSync(path.join(ctDir, 'out.md'));
  fs.rmSync(path.join(ctDir, 'shots', 'renamed.png'));
});

test("a container's files: another locked project's folder, sensitive paths and the secrets files are never shown", { skip: !hasSh && 'no sh with readlink here' }, async () => {
  const { access, readContainerText, listContainerFolder } = await containerFiles();
  const locked = access({ locked: [`${ctRoot}/locked`] });
  assert.equal((await readContainerText(access(), ctRoot, 'locked/plan.md')).path, 'locked/plan.md', 'open while not locked');
  await assert.rejects(readContainerText(locked, ctRoot, 'locked/plan.md'), /locked project/);
  await assert.rejects(listContainerFolder(locked, ctRoot, 'locked'), /locked project/);
  assert.ok(!(await listContainerFolder(locked, ctRoot, '')).entries.some((e) => e.name === 'locked'), 'left out of the tree');
  const sensitive = access({ pathPatterns: ['deploy-keys'] });
  await assert.rejects(readContainerText(sensitive, ctRoot, 'deploy-keys.txt'), /sensitive path pattern/);
  assert.ok(!(await listContainerFolder(sensitive, ctRoot, '')).entries.some((e) => e.name === 'deploy-keys.txt'));
  await assert.rejects(readContainerText(access(), ctRoot, SECRETS_NAME), /inside the project folder/);
  assert.ok(!(await listContainerFolder(access(), ctRoot, '')).entries.some((e) => e.name === SECRETS_NAME));
});

test("a container's Files pane tree: hidden names, links out and the secrets files left out, node_modules greyed", { skip: !hasSh && 'no sh with readlink here' }, async () => {
  const { access, listContainerFolder } = await containerFiles();
  const top = await listContainerFolder(access(), ctRoot, '');
  assert.deepEqual(top.entries.map((e) => e.name), ['locked', 'node_modules', 'shots', 'big.txt', 'deploy-keys.txt', 'main.ts', 'notes.md', 'run.log']);
  assert.equal(top.entries.find((e) => e.name === 'node_modules')!.skipped, 'heavy');
  assert.equal(top.entries.find((e) => e.name === 'notes.md')!.size, 8);
  assert.deepEqual((await listContainerFolder(access(), ctRoot, 'shots')).entries.map((e) => e.path), ['shots/fake.png', 'shots/home.png']);
  await assert.rejects(listContainerFolder(access(), ctRoot, '.hidden'), /Hidden folders/);
  await assert.rejects(listContainerFolder(access(), ctRoot, '..'), /inside the session's folder/);
  await assert.rejects(listContainerFolder(access(), ctRoot, 'notes.md'), /is a file/);
});

test("a container that can't be reached is said plainly, and every call has a time limit", async () => {
  const { access, readContainerText, listContainerFolder, containerFailure } = await containerFiles();
  const seen: number[] = [];
  const down = access({ exec: async (_s, _a, opts) => { seen.push(opts.timeoutMs); return { failed: containerFailure('test-ct', 'Error response from daemon: container abc is not running', false, opts.timeoutMs) }; } });
  await assert.rejects(readContainerText(down, '/work', 'notes.md'), /The container "test-ct" is not running/);
  await assert.rejects(listContainerFolder(down, '/work', ''), /is not running/);
  assert.ok(seen.length === 2 && seen.every((ms) => ms > 0 && ms <= 30000), 'a time limit on each');
  assert.match(containerFailure('x', 'Error: No such container: x', false, 1000), /was not found/);
  assert.match(containerFailure('x', '', true, 15000), /no answer within 15 s/);
  assert.match(containerFailure('x', 'error during connect: open //./pipe/docker_engine', false, 1000), /Docker is not running/);
});

test('a container file kept for a question: served by its hash, only to its own project, never once changed', async () => {
  const { keepCopy, readCopy } = await import('../src/sessions/container-files.ts');
  const dir = path.join(ctBase, 'copies');
  const ref = keepCopy(dir, 'ct', 'shots/home.png', PNG_BYTES);
  assert.match(ref, /^container:[0-9a-f]{32}\/shots\/home\.png$/);
  assert.deepEqual(readCopy(dir, 'ct', ref, ['png', 'jpeg']).bytes, PNG_BYTES);
  assert.throws(() => readCopy(dir, 'other', ref, ['png', 'jpeg']), /no copy/, "another project's");
  assert.throws(() => readCopy(dir, 'ct', ref.replace('home.png', 'home.md'), ['text']), /not a PNG or JPEG image or a \.txt/);
  assert.throws(() => readCopy(dir, 'ct', 'container:../../x/a.png', ['png']), /not a file Ledung kept/);
  const file = path.join(dir, fs.readdirSync(dir)[0]!, ref.slice('container:'.length, 'container:'.length + 32));
  fs.writeFileSync(file, Buffer.concat([PNG_BYTES, Buffer.from([9])]));
  assert.throws(() => readCopy(dir, 'ct', ref, ['png']), /has changed/);
});

test('copies no question names go once they are old; named or recent ones stay', async () => {
  const { keepCopy, pruneCopies } = await import('../src/sessions/container-files.ts');
  const dir = path.join(ctBase, 'prune');
  const hashOf = (ref: string) => ref.slice('container:'.length, 'container:'.length + 32);
  const named = keepCopy(dir, 'ct', 'a.md', Buffer.from('named'));
  const old = keepCopy(dir, 'ct', 'b.md', Buffer.from('old'));
  const fresh = keepCopy(dir, 'ct', 'c.md', Buffer.from('fresh'));
  const folder = path.join(dir, fs.readdirSync(dir)[0]!);
  const past = new Date(Date.now() - 2 * 86400000);
  for (const ref of [named, old]) fs.utimesSync(path.join(folder, hashOf(ref)), past, past);
  pruneCopies(dir, 'ct', new Set([hashOf(named)]), Date.now() - 86400000);
  assert.deepEqual(fs.readdirSync(folder).sort(), [hashOf(named), hashOf(fresh)].sort());
});

// Security review of #122: the run worktree swapped for a link out of the project folder (finding 1), git in a locked
// folder or outside (finding 2), a name with a newline standing for another file (finding 5), and the time limit
// inside the container (finding 7).
test("a container session's folder that leads out of the project folder is refused, for reads, the tree and git", { skip: !hasSh && 'no sh with readlink here' }, async (t) => {
  const { access, readContainerText, listContainerFolder, containerGit } = await containerFiles();
  const worktrees = path.join(ctDir, '.ledung', 'worktrees');
  fs.mkdirSync(worktrees, { recursive: true });
  try {
    fs.symlinkSync(ctBase, path.join(worktrees, 'run-1'), 'junction');
  } catch {
    t.diagnostic('this machine does not allow links: not run');
    return;
  }
  const run1 = `${ctRoot}/.ledung/worktrees/run-1`;
  await assert.rejects(readContainerText(access(), run1, 'outside.md'), /inside the project folder/);
  await assert.rejects(listContainerFolder(access(), run1, ''), /inside the session's folder/);
  await assert.rejects(containerGit(access(), run1, ['status']), /not inside the project folder/);
  await assert.rejects(containerGit(access({ locked: [`${ctRoot}/locked`] }), `${ctRoot}/locked`, ['status']), /locked project's folder/);
  fs.rmSync(path.join(worktrees, 'run-1'));
});

test("a container's changes leave out a locked project's folder, sensitive paths and the secrets files", async () => {
  const { access, diffHidden } = await containerFiles();
  const hidden = diffHidden(access({ locked: ['/work/app/locked', '/elsewhere'], pathPatterns: ['deploy-keys'] }), '/work/app');
  assert.deepEqual(['src/a.ts', 'locked/plan.md', 'lockedness.md', 'config/deploy-keys.txt', SECRETS_NAME].map(hidden), [false, true, false, true, true]);
});

test("a link whose target ends in a newline can't stand for the file without it", { skip: (!hasSh || process.platform === 'win32') && 'needs a newline in a file name' }, async () => {
  // The refusal is "outside" on every system: the link's real path can't be written without its newline, so it is not a
  // path inside the project folder. "Not a file that can be read" (what macOS gave before issue #127) meant the
  // newline had been cut off and the file without it looked up, which is the file that must not stand in for it.
  const { access, readContainerText } = await containerFiles();
  fs.writeFileSync(path.join(ctDir, 'nl.md\n'), '# the newline one\n');
  fs.symlinkSync(path.join(ctDir, 'nl.md\n'), path.join(ctDir, 'nl-link.md'));
  await assert.rejects(readContainerText(access(), ctRoot, 'nl-link.md'), /inside the project folder/);
  // With the file without the newline there too, the link still doesn't read it, though that file itself reads.
  fs.writeFileSync(path.join(ctDir, 'nl.md'), '# the other one\n');
  assert.equal((await readContainerText(access(), ctRoot, 'nl.md')).content, '# the other one\n');
  await assert.rejects(readContainerText(access(), ctRoot, 'nl-link.md'), /inside the project folder/);
});

test("the container's time limit wrapper runs the script with its arguments, and stops it inside at the limit", { skip: !hasSh && 'no sh here' }, async () => {
  const { TIMED_SCRIPT } = await import('../src/runners/docker-runner.ts');
  const ok = spawnSync('sh', ['-c', TIMED_SCRIPT, 'sh', '5', 'printf "%s|%s" "$1" "$2"', 'a b', '$(c)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.stdout, 'a b|$(c)');
  if (spawnSync('sh', ['-c', 'command -v timeout'], { windowsHide: true }).status !== 0) return;
  const started = Date.now();
  const slow = spawnSync('sh', ['-c', TIMED_SCRIPT, 'sh', '1', 'sleep 20'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(slow.status, 0);
  assert.ok(Date.now() - started < 10000, 'ended by the limit');
});
