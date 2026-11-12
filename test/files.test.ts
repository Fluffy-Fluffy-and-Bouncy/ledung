import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hiddenProblem, readProjectBytes, readProjectFile, readProjectImage } from '../src/sessions/files.ts';
import { readCachedImage, readEvidence } from '../src/board/attachments.ts';
import { removeTemp } from './temp.ts';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

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

// ledung#111: a brief may be in the folder a shared workflow's .ledung/workflow is in ("folder:process/briefs/x.md"),
// read with the same rules: inside that folder, links resolved, the text limit; a path out of it is still refused.
test('ledung#111: a "folder:" brief is read from the shared workflow\'s own folder, never from outside it', async (t) => {
  const { flowPlaces, localReader, readFlowView } = await import('../src/sessions/flow-files.ts');
  const { parseFlow } = await import('../src/shared/flow-check.ts');
  const { parseProject } = await import('../src/config.ts');
  const shared = fs.mkdtempSync(path.join(base, 'shared-'));
  const project = fs.mkdtempSync(path.join(base, 'follower-'));
  fs.mkdirSync(path.join(shared, '.ledung', 'workflow'), { recursive: true });
  fs.mkdirSync(path.join(shared, 'process', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'process', 'briefs', 'review.md'), '# Review');
  fs.writeFileSync(path.join(shared, 'process', 'briefs', 'big.md'), 'x'.repeat(256 * 1024 + 1));
  const block = (id: string, brief: string) => ({ id, kind: 'check', title: id, runs: 'new-session', brief, outcomes: [{ word: 'Done', end: true }] });
  fs.writeFileSync(path.join(shared, '.ledung', 'workflow', 'flow.json'), JSON.stringify({
    version: 1, blocks: [block('review', 'folder:process/briefs/review.md'), block('gone', 'folder:process/briefs/gone.md'), block('big', 'folder:process/briefs/big.md')],
  }));
  const workflow = { name: 'team', folder: shared, managerFile: 'm.md', sessionFile: 's.md', projectConfig: 'p.json' };
  const places = flowPlaces(parseProject({ name: 'shop', runner: 'local', path: project, workflow: { name: 'team' } }), workflow);
  const view = await readFlowView('shop', places);
  assert.equal(view.source?.kind, 'workflow');
  // The page has its text under the brief's own name, so a block click opens it.
  assert.equal(view.texts['folder:process/briefs/review.md'], '# Review');
  const problems = view.problems.map((p) => `${p.at}: ${p.message}`);
  assert.ok(!problems.some((p) => p.includes('review.md')), problems.join('\n'));
  assert.ok(problems.some((p) => p === 'blocks.gone.brief: The brief process/briefs/gone.md is not in the folder the workflow folder is in.'), 'a missing one is said, where it was looked for');
  assert.ok(problems.some((p) => p.startsWith('folder:process/briefs/big.md:') && /too large/.test(p)), 'the text limit holds');
  // Out of the folder: refused by the format, and by the reader as well.
  const bad = (brief: string) => parseFlow(JSON.stringify({ version: 1, blocks: [block('a', brief)] })).problems.filter((p) => p.at === 'blocks.a.brief');
  for (const brief of ['folder:../secret.md', 'folder:/etc/x.md', 'folder:C:/x.md', 'folder:process\\x.md', 'folder:folder:x.md', '../../process/briefs/review.md']) {
    assert.equal(bad(brief).length, 1, brief);
  }
  assert.equal(bad('folder:process/briefs/review.md').length, 0, 'the folder form is a brief');
  assert.equal(bad('briefs/review.md').length, 0, 'and so is a path in the workflow folder');
  fs.writeFileSync(path.join(base, 'secret.md'), 'outside');
  const read = localReader(shared, '.ledung/workflow');
  const outside = `folder:${path.join(base, 'secret.md')}`;
  const got = await read(['folder:../secret.md', outside, 'folder:process/briefs/review.md']);
  assert.match((got.get('folder:../secret.md') as { refused: string }).refused, /inside the project folder/);
  assert.match((got.get(outside) as { refused: string }).refused, /inside the project folder/);
  assert.deepEqual(got.get('folder:process/briefs/review.md'), { text: '# Review' });
  try {
    fs.symlinkSync(path.join(base, 'secret.md'), path.join(shared, 'process', 'briefs', 'out.md'));
  } catch {
    t.skip('this machine does not allow links');
    return;
  }
  assert.match(((await read(['folder:process/briefs/out.md'])).get('folder:process/briefs/out.md') as { refused: string }).refused, /inside the project folder/);
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

// ledung#111 in a container project: a "folder:" brief is asked for in the project folder in the container, not in
// .ledung/workflow, and the container's own script still refuses what leads out (test review of PR #136, finding 1).
test('ledung#111: a container project reads a "folder:" brief from its project folder; "..", a link out and one to a name ending in a newline are refused', async (t) => {
  if (spawnSync('sh', ['-c', 'readlink -f .'], { windowsHide: true }).status !== 0) {
    t.skip('no sh with readlink here');
    return;
  }
  const { INSIDE_PROJECT_SCRIPT, splitMarked } = await import('../src/runners/docker-runner.ts');
  const { flowPlaces } = await import('../src/sessions/flow-files.ts');
  const { parseProject } = await import('../src/config.ts');
  // The container's project folder, here on this computer; read with the very script docker exec runs.
  const box = fs.mkdtempSync(path.join(base, 'box-111-')).replaceAll('\\', '/');
  const outside = fs.mkdtempSync(path.join(base, 'box-111-outside-'));
  fs.mkdirSync(path.join(box, '.ledung', 'workflow'), { recursive: true });
  fs.mkdirSync(path.join(box, 'process', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(box, 'process', 'briefs', 'review.md'), '# Review in the box');
  // What "folder:../secret.md" would reach: there, so a refusal is not a file merely missing.
  fs.writeFileSync(path.join(base, 'secret.md'), 'SECRET-OUTSIDE');
  fs.writeFileSync(path.join(outside, 'x.md'), 'SECRET-OUTSIDE');
  const asked: string[][] = [];
  const read = async (files: string[], maxBytes: number, budget: number) => {
    asked.push(files);
    const run = spawnSync('sh', ['-c', INSIDE_PROJECT_SCRIPT, 'sh', 'MARK', box, String(maxBytes), String(budget), ...files], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes('SECRET-OUTSIDE'), 'the text outside is never printed');
    return splitMarked(run.stdout, files, 'MARK');
  };
  const project = parseProject({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work' });
  const [place] = flowPlaces(project, undefined, { read, list: async () => [], write: async () => {} });
  const wanted = ['folder:process/briefs/review.md', 'folder:../secret.md'];
  let linked = true;
  try {
    fs.symlinkSync(path.join(outside, 'x.md'), path.join(box, 'process', 'briefs', 'out.md'));
    fs.writeFileSync(path.join(outside, 'nl.md\n'), 'SECRET-OUTSIDE');
    fs.symlinkSync(path.join(outside, 'nl.md\n'), path.join(box, 'process', 'briefs', 'nl.md'));
    wanted.push('folder:process/briefs/out.md', 'folder:process/briefs/nl.md');
  } catch {
    linked = false;
  }
  const got = await place!.read(wanted);
  assert.deepEqual(asked[0]!.slice(0, 2), ['process/briefs/review.md', '../secret.md'], 'asked in the project folder, not in .ledung/workflow');
  assert.deepEqual(got.get('folder:process/briefs/review.md'), { text: '# Review in the box' });
  for (const f of wanted.slice(1)) assert.match((got.get(f) as { refused: string }).refused, /leads outside the project folder/, f);
  if (!linked) t.diagnostic('this machine does not allow links: the two link cases are left out');
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

// Issue #131: in the workflow scripts, a name ending in a newline never stands for the name without it. Command
// substitution drops trailing newlines, so a plain $(readlink -f …) turns "notes.md⏎" into "notes.md", another file.
const newlineNames = process.platform !== 'win32' && spawnSync('sh', ['-c', 'readlink -n -f .'], { windowsHide: true }).status === 0;
test("a container's workflow read script refuses a link to a name ending in a newline, and doesn't read the one without it", { skip: !newlineNames && 'needs a newline in a file name and sh with readlink -n' }, async () => {
  const { INSIDE_PROJECT_SCRIPT, splitMarked } = await import('../src/runners/docker-runner.ts');
  const project = fs.realpathSync(fs.mkdtempSync(path.join(base, 'nl-read-box-')));
  const folder = path.join(project, '.ledung', 'workflow');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'notes.md\n'), '# the newline one\n');
  fs.writeFileSync(path.join(folder, 'notes.md'), '# the other one\n');
  fs.symlinkSync(path.join(folder, 'notes.md\n'), path.join(folder, 'manager.md'));
  const files = ['.ledung/workflow/manager.md', '.ledung/workflow/notes.md'];
  const run = spawnSync('sh', ['-c', INSIDE_PROJECT_SCRIPT, 'sh', 'MARK', project, '1000', '10000', ...files], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const got = splitMarked(run.stdout, files, 'MARK');
  // The file without the newline reads by its own name, so the script can read it: the link just may not stand for it.
  assert.deepEqual(got.get('.ledung/workflow/notes.md'), { text: '# the other one\n' });
  assert.deepEqual(got.get('.ledung/workflow/manager.md'), { refused: '.ledung/workflow/manager.md leads outside the project folder.' });
});

// ledung#111, review of PR #136 round 2: a "folder:" brief reaches the whole project folder, so a link to "name.md⏎"
// inside it, with "name.md" there too, must be refused rather than read as "name.md".
test('ledung#111: a container "folder:" brief that is a link to a name ending in a newline inside the project is refused, not read as the name without it', { skip: !newlineNames && 'needs a newline in a file name and sh with readlink -n' }, async () => {
  const { INSIDE_PROJECT_SCRIPT, splitMarked } = await import('../src/runners/docker-runner.ts');
  const { flowPlaces } = await import('../src/sessions/flow-files.ts');
  const { parseProject } = await import('../src/config.ts');
  const box = fs.realpathSync(fs.mkdtempSync(path.join(base, 'nl-folder-box-')));
  const briefs = path.join(box, 'process', 'briefs');
  fs.mkdirSync(path.join(box, '.ledung', 'workflow'), { recursive: true });
  fs.mkdirSync(briefs, { recursive: true });
  fs.writeFileSync(path.join(briefs, 'name.md\n'), '# the newline one\n');
  fs.writeFileSync(path.join(briefs, 'name.md'), '# the other one\n');
  fs.symlinkSync(path.join(briefs, 'name.md\n'), path.join(briefs, 'nl.md'));
  const read = async (files: string[], maxBytes: number, budget: number) => {
    const run = spawnSync('sh', ['-c', INSIDE_PROJECT_SCRIPT, 'sh', 'MARK', box, String(maxBytes), String(budget), ...files], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return splitMarked(run.stdout, files, 'MARK');
  };
  const project = parseProject({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work' });
  const [place] = flowPlaces(project, undefined, { read, list: async () => [], write: async () => {} });
  const got = await place!.read(['folder:process/briefs/nl.md', 'folder:process/briefs/name.md']);
  // The positive branch: the file without the newline reads by its own name, through the same reader.
  assert.deepEqual(got.get('folder:process/briefs/name.md'), { text: '# the other one\n' });
  const nl = got.get('folder:process/briefs/nl.md');
  assert.ok(nl && 'refused' in nl, `refused, not read: ${JSON.stringify(nl)}`);
  assert.match(nl.refused, /leads outside the project folder/);
});

test("a container's workflow writer script refuses a folder swapped for a link to its name with a newline before the rename", { skip: !newlineNames && 'needs a newline in a file name and sh with readlink -n' }, async () => {
  const { WRITE_FLOW_SCRIPT } = await import('../src/runners/docker-runner.ts');
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(base, 'nl-swap-box-')));
  const workflow = path.join(fresh, '.ledung', 'workflow');
  fs.mkdirSync(path.join(workflow, 'briefs\n'), { recursive: true });
  // As in the swap test above: the briefs folder the script makes is swapped, right after, for a link to "briefs⏎".
  const front = 'mkdir() { command mkdir "$@" || return; case "$2" in */.ledung/workflow/briefs) command mv -- "$2" "$2-old" && command ln -s -- "$SWAP_TO" "$2";; esac; }\n';
  const env = { ...process.env, SWAP_TO: path.join(workflow, 'briefs\n') };
  const swapped = spawnSync('sh', ['-c', front + WRITE_FLOW_SCRIPT, 'sh', 'write', fresh, 'briefs/a.md'], { input: 'CHANGED', encoding: 'utf8', windowsHide: true, env });
  assert.ok(fs.lstatSync(path.join(workflow, 'briefs')).isSymbolicLink() && fs.existsSync(path.join(workflow, 'briefs-old')), `the swap ran: ${swapped.stdout}${swapped.stderr}`);
  assert.equal(swapped.status, 3, swapped.stdout + swapped.stderr);
  assert.match(swapped.stdout, /became a link/);
  assert.deepEqual(fs.readdirSync(path.join(workflow, 'briefs\n')), [], 'nothing left in the folder with the newline');
});

// The read script's last check, that the open descriptor's path (/proc/$$/fd/3, Linux and Git Bash) is still the
// checked one (review of PR #132, Minor finding). No /proc on a Mac, so the line itself runs with a link in its
// place: "outside" when the link names anything but the checked file, nothing when it names that file.
test("a container's read script: the open file's path, checked again, doesn't drop a trailing newline", { skip: !newlineNames && 'needs a newline in a file name and sh with readlink -n' }, async () => {
  const { READ_SCRIPT } = await import('../src/sessions/container-files.ts');
  const line = READ_SCRIPT.split('\n').find((l) => l.includes('/proc/$$/fd/3') && !l.startsWith('//'));
  assert.ok(line, 'the read script checks the open descriptor');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'nl-fd-')));
  fs.writeFileSync(path.join(dir, 'nl.md'), 'a');
  fs.writeFileSync(path.join(dir, 'nl.md\n'), 'b');
  fs.writeFileSync(path.join(dir, 'other.md'), 'c');
  const fd = (target: string) => {
    const l = path.join(dir, `fd-${target.replace('\n', 'NL')}`);
    fs.symlinkSync(path.join(dir, target), l);
    const run = spawnSync('sh', ['-c', `r=$1; ${line!.replace('/proc/$$/fd/3', '$2')}; echo same`, 'sh', path.join(dir, 'nl.md'), l], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  assert.equal(fd('nl.md'), 'same');
  assert.equal(fd('other.md'), 'outside');
  assert.equal(fd('nl.md\n'), 'outside');
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

// Files from managers on linked computers (issue #158): the sender reads with the viewer's rules and the attachment
// kinds, text up to 512 KB; the receiver serves a copy by its handle only to the manager it was sent to, only while
// its bytes are what came, and prunes it after evidenceDays.
test('ledung#158: a file sent to a linked computer is read inside the folder only, PNG, JPEG or .txt/.log/.md text, within the limits', async () => {
  const { readLinkOutgoing, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } = await import('../src/board/attachments.ts');
  const dir = path.join(base, 'link-out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
  fs.writeFileSync(path.join(dir, 'run.log'), 'x'.repeat(MAX_TEXT_BYTES));
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(MAX_TEXT_BYTES + 1));
  fs.writeFileSync(path.join(dir, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=1');
  fs.writeFileSync(path.join(dir, 'fake.png'), 'not a png');
  fs.writeFileSync(path.join(base, 'outside.png'), PNG);
  const shot = readLinkOutgoing(dir, 'shot.png');
  assert.deepEqual([shot.kind, shot.bytes, shot.text, shot.inside], ['png', PNG, null, 'shot.png']);
  const log = readLinkOutgoing(dir, 'run.log');
  assert.deepEqual([log.kind, log.bytes.length], ['text', MAX_TEXT_BYTES], 'text up to 512 KB, not cut at what a board post shows');
  assert.throws(() => readLinkOutgoing(dir, 'big.log'), /too large .* at most 512 KB/);
  assert.throws(() => readLinkOutgoing(dir, 'huge.png'), /too large/);
  assert.throws(() => readLinkOutgoing(dir, '.env'), /only PNG and JPEG images and \.txt, \.log or \.md/);
  assert.throws(() => readLinkOutgoing(dir, 'fake.png'), /not really a PNG/);
  assert.throws(() => readLinkOutgoing(dir, '../outside.png'), /Only files inside the project folder/);
  assert.throws(() => readLinkOutgoing(dir, path.join(base, 'outside.png')), /Only files inside the project folder/);
});

test('ledung#158: a copy from a linked computer is served by its handle to the manager it went to only, never once changed, and pruned after evidenceDays', async () => {
  const { LinkedFiles, PENDING_MS } = await import('../src/remote/linked-files.ts');
  const { openDatabase } = await import('../src/store/database.ts');
  const { sha256 } = await import('../src/board/attachments.ts');
  const dir = path.join(base, 'linked-copies');
  let now = Date.UTC(2026, 10, 6, 12);
  const files = new LinkedFiles(openDatabase(':memory:'), () => dir, () => 30, () => now);
  const meta = (to: string) => ({ to, name: 'shot.png', kind: 'png' as const, size: PNG.length, sha: sha256(PNG) });
  const id = files.receive('link-a', meta('mgr-1'), PNG);
  const [got] = files.claim('link-a', 'mgr-1', [id]);
  const handle = got!.handle;
  assert.equal(handle, `linked:${id}/shot.png`);
  assert.deepEqual(files.read('mgr-1', handle, ['png', 'jpeg']).bytes, PNG);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'link-a', `${id}.png`)).mode & 0o777, 0o600, 'mode 0600');
  // Another manager here, a path, a made-up id: refused (the page route goes through this, server-security.test.ts).
  assert.throws(() => files.read('mgr-2', handle, ['png']), /no file shot\.png from a linked computer for this session/);
  // The right id with another name: refused, so a question never shows a name the file did not come with.
  for (const bad of ['linked:../../x/shot.png', `linked:${id}`, path.join(dir, 'link-a', `${id}.png`), 'linked:0000000000000000/shot.png', `linked:${id}/anything.png`]) {
    assert.throws(() => files.read('mgr-1', bad, ['png']), /not a file from a linked computer|no file/, bad);
  }
  assert.throws(() => files.read('mgr-1', handle, ['text']), /not a PNG or JPEG image or a text file/);
  // Claimed once only, and only by the link and manager it came from and for.
  const id2 = files.receive('link-a', meta('mgr-1'), PNG);
  assert.throws(() => files.claim('link-b', 'mgr-1', [id2]), /did not get from you/, 'another link');
  assert.throws(() => files.claim('link-a', 'mgr-2', [id2]), /did not get from you/, 'another manager');
  assert.throws(() => files.claim('link-a', 'mgr-1', [id]), /did not get from you/, 'already claimed');
  assert.throws(() => files.claim('link-a', 'mgr-1', ['../x']), /by the ids/);
  // Changed on disk: not shown.
  fs.writeFileSync(path.join(dir, 'link-a', `${id}.png`), Buffer.concat([PNG, Buffer.from([1])]));
  assert.throws(() => files.read('mgr-1', handle, ['png']), /has changed/);
  // A pending file no message claimed goes after an hour; a delivered one after evidenceDays (30 here), its row kept.
  now += PENDING_MS + 1;
  files.prune(true);
  assert.ok(!fs.existsSync(path.join(dir, 'link-a', `${id2}.png`)), 'unclaimed: gone');
  assert.ok(fs.existsSync(path.join(dir, 'link-a', `${id}.png`)), 'delivered: still kept after an hour');
  now += 30 * 86400000;
  files.prune(true);
  assert.ok(!fs.existsSync(path.join(dir, 'link-a', `${id}.png`)), 'delivered: gone after evidenceDays');
  assert.throws(() => files.read('mgr-1', handle, ['png']), /was pruned/);
  // A wrong hash or kind is never kept.
  assert.throws(() => files.receive('link-a', { ...meta('mgr-1'), sha: 'f'.repeat(64) }, PNG), /content is not what/);
  assert.throws(() => files.receive('link-a', { ...meta('mgr-1'), kind: 'jpeg' }, PNG), /not really a JPEG/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'link-a')), [], 'nothing left behind');
});

// Project-Ledung#474: a project whose folder holds Ledung's data folder (a project of the whole user folder), and links
// inside a project that lead into the data folder, a locked project's folder or out of the project.
test("Project-Ledung#474: a project's Files pane and viewer keep Ledung's data folder shut, and links can't lead around the folder checks", async (t) => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-474-')));
  const whole = path.join(top, 'user');
  const data = path.join(whole, 'ledung-data');
  // Both names longer than 8.3, so Windows can give each a short name (LOCKED~1, LEDUNG~1).
  const locked = path.join(whole, 'locked-project');
  const outside = path.join(top, 'outside');
  for (const d of [data, locked, path.join(whole, 'notes'), outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, 'auth-token'), 'secret');
  fs.writeFileSync(path.join(locked, 'secret.md'), 'locked');
  fs.writeFileSync(path.join(whole, 'notes', 'a.md'), '# a');
  fs.writeFileSync(path.join(outside, 'x.md'), 'outside');
  // Junctions on Windows: no admin rights needed, so no platform skips these.
  fs.symlinkSync(data, path.join(whole, 'notes', 'data-link'), 'junction');
  fs.symlinkSync(locked, path.join(whole, 'notes', 'locked-link'), 'junction');
  fs.symlinkSync(outside, path.join(whole, 'notes', 'out-link'), 'junction');
  // The same project reached through a link to its folder, as a project under macOS's /tmp or /var is, one level
  // deeper than the folder itself: "../user" climbs out of the link's real folder, not out of the path as written.
  const via = path.join(top, 'deep', 'via');
  fs.mkdirSync(path.dirname(via));
  fs.symlinkSync(whole, via, 'junction');
  const before = process.env.LEDUNG_DATA_DIR;
  const made: SessionManager[] = [];
  const ledung = (lock: boolean) => {
    const m = refuseRealSignInStores(new SessionManager(parseConfig({
      projects: [
        { name: 'user', runner: 'local', path: whole },
        { name: 'via', runner: 'local', path: via },
        { name: 'locked', runner: 'local', path: locked, ...(lock ? { lockdown: { level: 'A' } } : {}) },
      ],
    }), new Store(openDatabase(':memory:')), () => {}));
    made.push(m);
    const store = (m as unknown as { store: Store }).store;
    store.createSession({ id: 's', project: 'user', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
    store.createSession({ id: 'v', project: 'via', runner: 'local', title: 'v', parentId: null, permissionMode: 'default', role: 'session' });
    return m;
  };
  t.after(() => {
    for (const m of made) m.detachAll();
    if (before === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = before;
    removeTemp(top);
  });

  // The premise: with nothing locked and Ledung's data folder elsewhere, the same probes find the folders, the links
  // and their files, so each refusal below is the rule and not a probe that finds nothing.
  process.env.LEDUNG_DATA_DIR = path.join(top, 'elsewhere');
  const open = ledung(false);
  const openNames = async (rel: string) => (await open.listFolder('s', 'session', rel)).entries.map((e) => e.name);
  assert.ok((await openNames('')).includes('ledung-data'), 'listed while it is not the data folder');
  const openNotes = await openNames('notes');
  assert.ok(openNotes.includes('data-link') && openNotes.includes('locked-link'), openNotes.join(', '));
  assert.ok(!openNotes.includes('out-link'), 'a link out of the project is never listed');
  assert.equal((await open.readFile('s', 'ledung-data/auth-token', 'session')).content, 'secret');
  assert.equal((await open.readFile('s', 'notes/data-link/auth-token', 'session')).content, 'secret', 'through the link');
  assert.equal((await open.readFile('s', 'notes/locked-link/secret.md', 'session')).content, 'locked', 'through the link, while not locked');
  assert.equal((await open.readFile('v', '../user/ledung-data/auth-token', 'session')).content, 'secret', 'from the project reached through a link');

  const manager = ledung(true);
  const names = async (rel: string) => (await manager.listFolder('s', 'session', rel)).entries.map((e) => e.name);

  // The data folder inside the project: refused to the tree and the viewer, through the pane and from a chat link.
  process.env.LEDUNG_DATA_DIR = data;
  const listed = await names('');
  assert.ok(listed.includes('notes') && !listed.includes('ledung-data'), listed.join(', '));
  await assert.rejects(manager.listFolder('s', 'session', 'ledung-data'), /settings and sign-ins/);
  await assert.rejects(manager.readFile('s', 'ledung-data/auth-token', 'session'), /Ledung's data folder/);
  await assert.rejects(manager.readFile('s', 'ledung-data/auth-token'), /Ledung's data folder/, 'a link in the chat');
  await assert.rejects(manager.readFile('s', 'ledung-data%2Fauth-token#x'), /Ledung's data folder/, 'encoded, with a fragment');
  await assert.rejects(manager.readFile('s', path.join(data, 'auth-token')), /Ledung's data folder/, 'an absolute path');
  // A project whose folder is reached through a link, with ".." in the path: the same folder, the same answer.
  await assert.rejects(manager.readFile('v', '../user/ledung-data/auth-token', 'session'), /Ledung's data folder/);
  await assert.rejects(manager.readFile('v', '../user/ledung-data/auth-token'), /Ledung's data folder/);
  await assert.rejects(manager.listFolder('v', 'session', 'ledung-data'), /settings and sign-ins/);

  // Links inside the project: into the data folder, a locked project's folder, or out of the project.
  const notes = await names('notes');
  assert.ok(notes.includes('a.md'), notes.join(', '));
  for (const link of ['data-link', 'locked-link', 'out-link']) assert.ok(!notes.includes(link), `${link} left out of the tree`);
  await assert.rejects(manager.listFolder('s', 'session', 'notes/data-link'), /settings and sign-ins/);
  await assert.rejects(manager.readFile('s', 'notes/data-link/auth-token', 'session'), /Ledung's data folder/);
  await assert.rejects(manager.readFile('s', 'notes/data-link/auth-token'), /Ledung's data folder/);
  await assert.rejects(manager.listFolder('s', 'session', 'notes/locked-link'), /settings and sign-ins/);
  await assert.rejects(manager.readFile('s', 'notes/locked-link/secret.md', 'session'), /locked project's folder/);
  await assert.rejects(manager.listFolder('s', 'session', 'notes/out-link'), /inside the session's folder/);
  await assert.rejects(manager.readFile('s', 'notes/out-link/x.md', 'session'), /inside the project/);

  // Windows: a folder's 8.3 short name is the same folder, so it can't lead around either check.
  if (process.platform === 'win32') {
    const shortLocked = shortName(locked);
    const shortData = shortName(data);
    if (shortLocked) await assert.rejects(manager.readFile('s', `${shortLocked}/secret.md`, 'session'), /locked project's folder/, `${shortLocked} is the locked folder`);
    if (shortData) await assert.rejects(manager.readFile('s', `${shortData}/auth-token`, 'session'), /Ledung's data folder/, `${shortData} is the data folder`);
    if (!shortLocked || !shortData) t.diagnostic('this volume makes no 8.3 short names; the short-name step did not run');
  }

  // Ordinary files still list and open.
  assert.equal((await manager.readFile('s', 'notes/a.md', 'session')).content, '# a');
  assert.equal((await manager.readFile('s', 'notes/a.md')).content, '# a');
});
