// Issue #339: a file dropped or picked in the message box that Ledung can't attach as an image is saved in the
// session's folder under .ledung/drops, and its path goes into the box (Martin, 2026-11-16 14:44, question #912:
// "a — Copy it in and link the copy"). The writer (src/sessions/drops.ts) on its own: where the file lands, under what
// name, that git doesn't see it, and that each refusal leaves nothing behind. Then the manager's refusal of a container
// project, and the page's helpers (web/src/drops.ts). The route's locks are in test/server-security.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DROPS_FOLDER, MAX_DROP_BYTES, plainDropName, saveDrop } from '../src/sessions/drops.ts';
import { FileError } from '../src/sessions/files.ts';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { dropProblem, dropToken, insertAt, MAX_DROP_BYTES as PAGE_MAX_DROP_BYTES, splitDropped } from '../web/src/drops.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { removeTemp } from './temp.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-drops-')));
after(() => removeTemp(base));
let n = 0;
const fresh = (what: string) => {
  const dir = path.join(base, `${what}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/** Every file under `dir`, relative, with forward slashes; links not followed. */
const filesIn = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => !e.isDirectory())
  .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
  .sort();
// A fixed day, so the names are known: 16 November 2026 at noon on this computer's clock.
const DAY = new Date(2026, 10, 16, 12, 0, 0);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n', 'latin1');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

test('#339: a dropped PDF lands in .ledung/drops under the date and its name, with the same bytes', () => {
  const root = fresh('project');
  const saved = saveDrop(root, 'report.pdf', PDF, DAY);
  assert.equal(saved.path, '.ledung/drops/2026-11-16-report.pdf');
  assert.equal(saved.full, path.join(fs.realpathSync.native(root), '.ledung', 'drops', '2026-11-16-report.pdf'));
  assert.equal(saved.size, PDF.length);
  assert.deepEqual(fs.readFileSync(path.join(root, '.ledung', 'drops', '2026-11-16-report.pdf')), PDF);
  assert.deepEqual(filesIn(root), ['.ledung/drops/.gitignore', '.ledung/drops/2026-11-16-report.pdf'], 'the file and the folder\'s .gitignore, nothing else');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved.full).mode & 0o111, 0, 'no execute bit');
  // An empty file is a file too.
  assert.equal(saveDrop(root, 'empty.txt', Buffer.alloc(0), DAY).path, '.ledung/drops/2026-11-16-empty.txt');
});

test('#339: git status shows nothing new after a drop, and does show a file put beside the drops folder', { skip: git(base, '--version').status !== 0 && 'git is not installed' }, () => {
  const root = fresh('repo');
  assert.equal(git(root, 'init', '-q').status, 0);
  saveDrop(root, 'report.pdf', PDF, DAY);
  saveDrop(root, 'notes.docx', Buffer.from('PK\u0003\u0004'), DAY);
  const status = git(root, 'status', '--porcelain', '--untracked-files=all');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, '', 'the drops folder keeps itself out of git');
  // The probe sees an untracked file when there is one: one in .ledung but outside drops.
  fs.writeFileSync(path.join(root, '.ledung', 'other.txt'), 'x');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all').stdout.trim(), '?? .ledung/other.txt');
});

test('#339: a name already taken gets a number, and the file there is left as it was', () => {
  const root = fresh('taken');
  const first = saveDrop(root, 'report.pdf', PDF, DAY);
  const second = saveDrop(root, 'report.pdf', Buffer.from('second'), DAY);
  const third = saveDrop(root, 'report.pdf', Buffer.from('third'), DAY);
  assert.equal(second.path, '.ledung/drops/2026-11-16-report-2.pdf');
  assert.equal(third.path, '.ledung/drops/2026-11-16-report-3.pdf');
  assert.deepEqual(fs.readFileSync(first.full), PDF, 'never saved over');
  assert.equal(fs.readFileSync(second.full, 'utf8'), 'second');
  // A name with no extension gets its number at the end.
  saveDrop(root, 'Makefile', Buffer.from('a'), DAY);
  assert.equal(saveDrop(root, 'Makefile', Buffer.from('b'), DAY).path, '.ledung/drops/2026-11-16-Makefile-2');
});

test('#339: path parts and odd characters land as a plain name inside .ledung/drops, never outside it', () => {
  const root = fresh('odd');
  const cases: [string, string][] = [
    ['../x', '_x'],
    ['a/b', 'a_b'],
    ['..\\..\\y.txt', '_.._y.txt'],
    ['/etc/passwd', '_etc_passwd'],
    ['.env', 'env'],
    ['..', 'file'],
    ['', 'file'],
    ['a:b*c?.txt', 'a_b_c_.txt'],
    ['CON.txt', '_CON.txt'],
    ['nul', '_nul'],
    ['tab\there.pdf', 'tab_here.pdf'],
    ['trailing. ', 'trailing'],
  ];
  for (const [given, plain] of cases) {
    assert.equal(plainDropName(given), plain, given);
    const saved = saveDrop(root, given, PDF, DAY);
    assert.equal(path.posix.dirname(saved.path), DROPS_FOLDER, given);
    assert.equal(path.dirname(saved.full), path.join(fs.realpathSync.native(root), '.ledung', 'drops'), given);
  }
  // Everything is in the drops folder; nothing next to the project or above it.
  assert.ok(filesIn(root).every((f) => f.startsWith('.ledung/drops/')), filesIn(root).join(', '));
  assert.deepEqual(fs.readdirSync(path.dirname(root)).filter((f) => !/^(project|repo|taken|odd|big|link|swap|data|mgr)-\d+$/.test(f)), [], 'nothing beside the project');
  // A long name is cut, keeping its extension, so the whole name with date and number stays within 200 UTF-8 bytes
  // (ext4 counts bytes, 255 at most): 200 - 11 for "yyyy-mm-dd-" - 4 for "-999" = 185 for the name itself.
  const long = plainDropName(`${'x'.repeat(300)}.pdf`);
  assert.equal(long, `${'x'.repeat(181)}.pdf`);
  // Three bytes each: 60 of them fit in the 181 bytes before ".pdf"; never half a character.
  const cjk = plainDropName(`${'報'.repeat(105)}.pdf`);
  assert.equal(cjk, `${'報'.repeat(60)}.pdf`);
  const saved = saveDrop(root, `${'報'.repeat(105)}.pdf`, PDF, DAY);
  assert.ok(Buffer.byteLength(path.basename(saved.full)) <= 200, path.basename(saved.full));
  // Taken: the number still fits.
  assert.ok(Buffer.byteLength(path.basename(saveDrop(root, `${'報'.repeat(105)}.pdf`, PDF, DAY).full)) <= 200);
});

test('#339: a file over 50 MB is refused with the limit named, and nothing is written', () => {
  assert.equal(MAX_DROP_BYTES, 50 * 1024 * 1024);
  const root = fresh('big');
  assert.throws(() => saveDrop(root, 'big.bin', Buffer.alloc(MAX_DROP_BYTES + 1), DAY), (e: Error) => e instanceof FileError && /at most 50 MB/.test(e.message));
  assert.deepEqual(fs.readdirSync(root), [], 'not even the folders');
  // Exactly the limit is taken.
  assert.equal(saveDrop(root, 'edge.bin', Buffer.alloc(MAX_DROP_BYTES), DAY).size, MAX_DROP_BYTES);
});

test('#339: .ledung or its drops folder as a link is refused, before and during the write; nothing lands where it points', { skip: process.platform === 'win32' && 'links need rights on Windows; junctions are the same check' }, () => {
  const outside = fresh('link');
  // .ledung a link to a folder outside.
  const a = fresh('link');
  fs.symlinkSync(outside, path.join(a, '.ledung'), 'junction');
  assert.throws(() => saveDrop(a, 'r.pdf', PDF, DAY), /\.ledung is a link/);
  // .ledung/drops a link.
  const b = fresh('link');
  fs.mkdirSync(path.join(b, '.ledung'));
  fs.symlinkSync(outside, path.join(b, '.ledung', 'drops'), 'junction');
  assert.throws(() => saveDrop(b, 'r.pdf', PDF, DAY), /\.ledung\/drops is a link/);
  // The drops folder swapped for a link after the folders were checked.
  const c = fresh('swap');
  assert.throws(() => saveDrop(c, 'r.pdf', PDF, DAY, {
    beforeWrite: (folder) => {
      fs.rmSync(folder, { recursive: true });
      fs.symlinkSync(outside, folder, 'junction');
    },
  }), /\.ledung\/drops is a link/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through a link');
  // The same steps with no link save the file: the probe reaches the write.
  const d = fresh('swap');
  assert.equal(saveDrop(d, 'r.pdf', PDF, DAY, { beforeWrite: () => {} }).path, '.ledung/drops/2026-11-16-r.pdf');
});

test("#339: a session folder inside Ledung's own data folder is refused", () => {
  const data = process.env.LEDUNG_DATA_DIR;
  assert.ok(data, 'the tests run with their own data folder (scripts/test.ts)');
  const inside = path.join(data, `drops-test-${process.pid}`);
  fs.mkdirSync(inside, { recursive: true });
  try {
    assert.throws(() => saveDrop(inside, 'r.pdf', PDF, DAY), /Ledung's own data folder/);
    assert.deepEqual(fs.readdirSync(inside), []);
    // The data folder given in another form than the one on disk: Windows CI on PR #342 had it as an 8.3 name
    // (C:\Users\RUNNER~1). On a disk that ignores case (macOS, Windows) the same miss shows with the case changed:
    // the session's folder is compared in its native real form, which has the case on disk.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      process.env.LEDUNG_DATA_DIR = data.toUpperCase();
      try {
        assert.throws(() => saveDrop(inside, 'r.pdf', PDF, DAY), /Ledung's own data folder/, 'the data folder in upper case');
      } finally {
        process.env.LEDUNG_DATA_DIR = data;
      }
      assert.deepEqual(fs.readdirSync(inside), []);
    }
    // The same call for a folder outside it saves.
    assert.equal(saveDrop(fresh('data'), 'r.pdf', PDF, DAY).path, '.ledung/drops/2026-11-16-r.pdf');
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
  }
});

test('#339: the manager saves into the folder the session works in, and refuses a container project before anything', () => {
  const folder = fresh('mgr');
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    projects: [
      { name: 'p', runner: 'local', path: folder },
      { name: 'box', runner: 'docker', container: 'some-container', pathInContainer: '/work' },
    ],
  }), store, () => {}));
  store.createSession({ id: 'here', project: 'p', runner: 'local', title: 'here', parentId: null, permissionMode: 'default', role: 'session' });
  store.createSession({ id: 'boxed', project: 'box', runner: 'docker', title: 'boxed', parentId: null, permissionMode: 'default', role: 'session' });
  const today = new Date();
  const two = (v: number) => String(v).padStart(2, '0');
  const day = `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`;
  assert.deepEqual(manager.saveDrop('here', 'spec.pdf', PDF), { path: `.ledung/drops/${day}-spec.pdf` });
  assert.deepEqual(fs.readFileSync(path.join(folder, '.ledung', 'drops', `${day}-spec.pdf`)), PDF);
  // A session that moved itself into a worktree with EnterWorktree (issue #225): its drop lands in that worktree, where
  // the relative path resolves for Claude, not in the project's top folder (test review of PR #342, finding 1).
  const worktree = path.join(folder, '.claude', 'worktrees', 'fix-1');
  fs.mkdirSync(worktree, { recursive: true });
  store.createSession({ id: 'moved', project: 'p', runner: 'local', title: 'moved', parentId: null, permissionMode: 'default', role: 'session' });
  store.addMessage('moved', 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_moved', name: 'EnterWorktree', input: { name: 'fix-1' } }] } });
  store.addMessage('moved', 'sdk', { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_moved', content: `Created worktree at ${worktree} on branch worktree-fix-1.` }] } });
  assert.deepEqual(manager.saveDrop('moved', 'plan.pdf', PDF), { path: `.ledung/drops/${day}-plan.pdf` });
  assert.deepEqual(fs.readFileSync(path.join(worktree, '.ledung', 'drops', `${day}-plan.pdf`)), PDF, 'in the worktree');
  assert.equal(fs.existsSync(path.join(folder, '.ledung', 'drops', `${day}-plan.pdf`)), false, 'not in the project\'s top folder');
  assert.throws(() => manager.dropCheck('boxed'), /"boxed" works in a container project; Ledung can't put a dropped file into a container yet/);
  assert.throws(() => manager.saveDrop('boxed', 'spec.pdf', PDF), /container project/);
  assert.throws(() => manager.saveDrop('nope', 'spec.pdf', PDF), /No such session/);
});

test('#339 page: images go as images, every other file is saved; the limit and the path as the box gets it', () => {
  const files = [
    { name: 'a.png', type: 'image/png' }, { name: 'b.pdf', type: 'application/pdf' }, { name: 'c.jpg', type: 'image/jpeg' },
    { name: 'd.svg', type: 'image/svg+xml' }, { name: 'e.heic', type: 'image/heic' }, { name: 'f', type: '' },
    { name: 'g.gif', type: 'image/gif' }, { name: 'h.webp', type: 'image/webp' },
  ];
  const { images, others } = splitDropped(files);
  assert.deepEqual(images.map((f) => f.name), ['a.png', 'c.jpg', 'g.gif', 'h.webp']);
  // An image Ledung can't send as one (SVG, HEIC) is a file it saves.
  assert.deepEqual(others.map((f) => f.name), ['b.pdf', 'd.svg', 'e.heic', 'f']);
  assert.equal(PAGE_MAX_DROP_BYTES, MAX_DROP_BYTES, 'the page and Ledung have one limit');
  assert.match(dropProblem({ name: 'big.mov', size: MAX_DROP_BYTES + 1 }) ?? '', /big\.mov is too large: at most 50 MB/);
  assert.equal(dropProblem({ name: 'ok.mov', size: MAX_DROP_BYTES }), null);
  assert.equal(dropToken('.ledung/drops/2026-11-16-b.pdf'), '[file: .ledung/drops/2026-11-16-b.pdf]');
});

test('#339 page: the path goes in at the caret, with a space only where it touches other text', () => {
  assert.deepEqual(insertAt('', 0, '[file: x]'), { text: '[file: x]', caret: 9 });
  assert.deepEqual(insertAt('look at', 7, '[file: x]'), { text: 'look at [file: x]', caret: 17 });
  assert.deepEqual(insertAt('look at please', 8, '[file: x]'), { text: 'look at [file: x] please', caret: 18 });
  assert.deepEqual(insertAt('ab', 1, 'T'), { text: 'a T b', caret: 4 });
  // A caret past the end (the text changed meanwhile) puts it at the end.
  assert.deepEqual(insertAt('hi', 99, 'T'), { text: 'hi T', caret: 4 });
});
