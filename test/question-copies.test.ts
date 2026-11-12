// Waiting for you history keeps what was asked (issue #306): every project's screenshots and evidence are kept as
// Ledung's own copies when asked, images as WebP, so the question still shows them once the worktree is gone; copies
// no question names go; old questions' paths are still read; and history reaches 100 answered questions per project,
// or 30 days back if that is more.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { LEDUNG_SERVER } from '../src/sessions/tools.ts';
import { isWebp, pixelCount, toWebp, WEBP_MAX_PIXELS } from '../src/sessions/webp.ts';
import { keepCopy, moveCopies, pruneCopies, readCopy } from '../src/sessions/container-files.ts';
import { deskQuestion, HISTORY_DAYS, HISTORY_PER_PROJECT, LIGHT_TEXT_CHARS, lightQuestion, shownFile } from '../src/shared/questions.ts';
import type { QuestionInfo } from '../src/shared/protocol.ts';
import { opened, waitingLists, withHistory } from '../web/src/waitingLists.ts';
import { runCappedBytes } from '../src/sessions/git-read.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-copies-'));
after(() => removeTemp(base));
// A real dark-mode screenshot of Ledung, 1280 x 800, committed with an earlier step.
const SHOT = fs.readFileSync(fileURLToPath(new URL('../docs/steps/pinned-message-226/menu-wide-after-dark.png', import.meta.url)));
const DAY = 24 * 60 * 60 * 1000;
const folderOf = (project: string) => crypto.createHash('sha256').update(project).digest('hex').slice(0, 16);
const hashOf = (ref: string) => /^(?:container|kept):([0-9a-f]{32})\//.exec(ref)![1]!;

/** The pixels of a PNG or a WebP, decoded by the codecs' own decoders, to compare. */
async function pixels(bytes: Buffer, kind: 'png' | 'webp' | 'jpeg'): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const wasm = (spec: string) => WebAssembly.compile(fs.readFileSync(fileURLToPath(import.meta.resolve(spec))));
  const own = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
  if (kind === 'png') {
    const png = await import('@jsquash/png/decode.js');
    await png.init(await wasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
    return png.decode(own) as never;
  }
  if (kind === 'jpeg') {
    const jpeg = await import('@jsquash/jpeg/decode.js');
    await (jpeg.init as unknown as (m: WebAssembly.Module) => Promise<void>)(await wasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));
    return jpeg.default(own) as never;
  }
  const webp = await import('@jsquash/webp/decode.js');
  await (webp.init as unknown as (m: WebAssembly.Module) => Promise<void>)(await wasm('@jsquash/webp/codec/dec/webp_dec.wasm'));
  return webp.default(own) as never;
}

test('a PNG screenshot becomes a lossless WebP: smaller, and the same pixels', async () => {
  assert.equal(isWebp(SHOT), false, 'a PNG is not a WebP');
  const webp = await toWebp(SHOT, 'png');
  assert.equal(isWebp(webp), true);
  assert.ok(webp.length < SHOT.length, `${webp.length} bytes as WebP against ${SHOT.length} as PNG`);
  const [a, b] = await Promise.all([pixels(SHOT, 'png'), pixels(webp, 'webp')]);
  assert.deepEqual([b.width, b.height], [1280, 800]);
  assert.deepEqual([a.width, a.height], [1280, 800]);
  assert.ok(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength)), 'lossless: every pixel as it was');
});

test('a JPEG becomes a WebP of its size; an image too large or not an image is refused for conversion', async () => {
  const jpegEnc = await import('@jsquash/jpeg/encode.js');
  const wasm = await WebAssembly.compile(fs.readFileSync(fileURLToPath(import.meta.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'))));
  await (jpegEnc.init as unknown as (m: WebAssembly.Module) => Promise<void>)(wasm);
  const shot = await pixels(SHOT, 'png');
  const jpeg = Buffer.from(await jpegEnc.default(shot as never, { quality: 85 }));
  assert.equal(pixelCount(jpeg, 'jpeg'), 1280 * 800, "the JPEG's frame header read without decoding");
  assert.equal(pixelCount(SHOT, 'png'), 1280 * 800);
  const webp = await toWebp(jpeg, 'jpeg');
  assert.equal(isWebp(webp), true);
  const back = await pixels(webp, 'webp');
  assert.deepEqual([back.width, back.height], [1280, 800]);

  // Width and height in a PNG's header past the limit: refused before anything is decoded.
  const huge = Buffer.from(SHOT);
  huge.writeUInt32BE(10_000, 16);
  huge.writeUInt32BE(10_000, 20);
  assert.ok(10_000 * 10_000 > WEBP_MAX_PIXELS);
  await assert.rejects(toWebp(huge, 'png'), new RegExp(`at most ${WEBP_MAX_PIXELS} are converted`));
  await assert.rejects(toWebp(Buffer.concat([SHOT.subarray(0, 8), Buffer.alloc(16)]), 'png'));
});

/** The real chain for a local project: the session's ask_user → Management → the session manager → the store. */
function chain(root: string, project = 'p') {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: project, runner: 'local', path: root }] }), store, () => {}));
  const copies = path.join(base, `copies-${crypto.randomUUID()}`);
  manager.containerCopiesDir = () => copies;
  const info = store.createSession({ id: 's', project, runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default' });
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management: (manager as unknown as { management: Management }).management,
    runner: { cwd: root, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  return { store, manager, session, copies };
}

async function askTool(session: Session) {
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  return (options.mcpServers![LEDUNG_SERVER] as unknown as {
    instance: { _registeredTools: Record<string, { handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  }).instance._registeredTools.ask_user!;
}

test("a local project's screenshot and evidence are kept when asked, and still shown once the worktree is deleted", async () => {
  const root = path.join(base, 'local');
  const worktree = path.join(root, '.claude', 'worktrees', 'fix-1');
  fs.mkdirSync(path.join(worktree, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'shots', 'menu.png'), SHOT);
  fs.writeFileSync(path.join(worktree, 'run.log'), 'tests 12 passed\n');
  const { store, manager, session, copies } = chain(root);
  const ask = await askTool(session);
  const shot = await ask.handler({ question: 'Judge', tier: 'Process', screenshots: [{ file: '.claude/worktrees/fix-1/shots/menu.png', look_for: 'the menu' }] }, {});
  assert.equal(shot.isError, undefined, shot.content[0]!.text);
  const review = await ask.handler({ title: 'T', tier: 'Process', review: { solving: 's', done: 'd', evidence: [{ file: '.claude/worktrees/fix-1/run.log', caption: 'the run' }] } }, {});
  assert.equal(review.isError, undefined, review.content[0]!.text);
  const [first, second] = store.listQuestions();
  const shotRef = first!.shots![0]!.path;
  const logRef = second!.details!.review!.evidence![0]!.file;
  assert.match(shotRef, /^kept:[0-9a-f]{32}\/\.claude\/worktrees\/fix-1\/shots\/menu\.png$/);
  assert.match(logRef, /^kept:[0-9a-f]{32}\/\.claude\/worktrees\/fix-1\/run\.log$/);
  assert.equal(shownFile(shotRef), '.claude/worktrees/fix-1/shots/menu.png', 'the page shows the path in the project');
  // Kept in Ledung's data folder, the image as WebP and the text as it was.
  const kept = fs.readFileSync(path.join(copies, folderOf('p'), hashOf(shotRef)));
  assert.equal(isWebp(kept), true);
  assert.equal(fs.readFileSync(path.join(copies, folderOf('p'), hashOf(logRef)), 'utf8'), 'tests 12 passed\n');

  // The worktree is removed; the question's page still shows both, from the copies.
  fs.rmSync(worktree, { recursive: true, force: true });
  const image = await manager.readImage('s', shotRef);
  assert.equal(image.type, 'image/webp');
  assert.ok(image.bytes.equals(kept));
  assert.deepEqual(manager.readEvidenceText(second!.id, 0), { file: logRef, content: 'tests 12 passed\n' });
  // Positive branch of the old path: the same file by its path in the folder is gone with the worktree.
  await assert.rejects(manager.readImage('s', '.claude/worktrees/fix-1/shots/menu.png'), /There is no file/);
});

// A container project (issue #122): its files read through a fake runner that runs the container's scripts in a local
// sh, as reviews.test.ts does; here with a real screenshot, so the conversion runs (test review of PR #307, finding 1).
const hasSh = spawnSync('sh', ['-c', 'readlink -f . && head -c 1 /dev/null'], { windowsHide: true }).status === 0;
test("a container project's screenshot and image evidence are kept as WebP and shown with the container stopped", { skip: !hasSh && 'no sh with readlink here' }, async () => {
  const root = path.join(base, 'box');
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shots', 'menu.png'), SHOT);
  const long = fs.realpathSync.native(root);
  const posix = (process.platform === 'win32' ? long.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : long).replaceAll('\\', '/');
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'ct', runner: 'docker', container: 'test-ct', pathInContainer: posix }] }), store, () => {}));
  let up = true;
  manager.containerExecFor = () => (script, args, opts) => (up ? runCappedBytes('sh', ['-c', script, 'sh', ...args], opts) : Promise.resolve({ failed: 'The container "test-ct" is not running.' }));
  const copies = path.join(base, 'box-copies');
  manager.containerCopiesDir = () => copies;
  const info = store.createSession({ id: 'c', project: 'ct', runner: 'docker', title: 'Worker', parentId: null, permissionMode: 'default' });
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management: (manager as unknown as { management: Management }).management,
    runner: { cwd: posix, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const ask = await askTool(session);
  const asked = await ask.handler({ question: 'Judge', tier: 'Process', screenshots: [{ file: 'shots/menu.png', look_for: 'the menu' }] }, {});
  assert.equal(asked.isError, undefined, asked.content[0]!.text);
  const review = await ask.handler({ title: 'T', tier: 'Process', review: { solving: 's', done: 'd', evidence: [{ file: 'shots/menu.png', caption: 'the menu' }] } }, {});
  assert.equal(review.isError, undefined, review.content[0]!.text);
  const [first, second] = store.listQuestions();
  const shotRef = first!.shots![0]!.path;
  const evidenceRef = second!.details!.review!.evidence![0]!.file;
  assert.match(shotRef, /^container:[0-9a-f]{32}\/shots\/menu\.png$/);
  const kept = fs.readFileSync(path.join(copies, folderOf('ct'), hashOf(shotRef)));
  assert.equal(isWebp(kept), true, 'stored as WebP');
  assert.equal(isWebp(fs.readFileSync(path.join(copies, folderOf('ct'), hashOf(evidenceRef)))), true, 'the evidence image too');
  assert.equal(evidenceRef, shotRef, 'the same image, kept once');

  up = false;
  const image = await manager.readImage('c', shotRef);
  assert.equal(image.type, 'image/webp');
  assert.ok(image.bytes.equals(kept));
  const [a, b] = await Promise.all([pixels(SHOT, 'png'), pixels(image.bytes, 'webp')]);
  assert.ok(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength)), 'the pixels as the PNG in the container had them');
});

test('a question stored before copies were kept still shows its file from the project folder, while it is there', async () => {
  const root = path.join(base, 'old');
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shots', 'old.png'), SHOT);
  const { store, manager } = chain(root);
  const q = store.createQuestion({ sessionId: 's', question: 'Judge', options: null, addressedTo: 'user', shots: [{ path: 'shots/old.png', group: 'Screenshots', lookFor: 'x', doneWhen: null, facts: [], opinions: [] }] });
  const image = await manager.readImage('s', q.shots![0]!.path);
  assert.equal(image.type, 'image/png');
  assert.ok(image.bytes.equals(SHOT), 'read from the folder as before');
  fs.rmSync(path.join(root, 'shots', 'old.png'));
  await assert.rejects(manager.readImage('s', q.shots![0]!.path), /There is no file/);
});

test('a copy no question names is removed after a day; one a question names stays; both prefixes count', () => {
  const store = new Store(openDatabase(':memory:'));
  const dir = path.join(base, 'prune');
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'W', parentId: null, permissionMode: 'default' });
  const named = keepCopy(dir, 'p', 'a.md', Buffer.from('named'), 'kept:');
  const box = keepCopy(dir, 'p', 'b.md', Buffer.from('box'));
  const loose = keepCopy(dir, 'p', 'c.md', Buffer.from('loose'), 'kept:');
  store.createQuestion({ sessionId: 's', question: 'q', options: null, addressedTo: 'user', details: { review: { solving: 's', done: 'd', evidence: [{ file: named, caption: 'c', kind: 'text' }] } } });
  store.createQuestion({ sessionId: 's', question: 'q', options: null, addressedTo: 'user', shots: [{ path: box, group: 'g', lookFor: 'x', doneWhen: null, facts: [], opinions: [] }] });
  const refs = store.keptCopyRefs();
  assert.deepEqual([...refs].sort(), [hashOf(named), hashOf(box)].sort());
  const old = new Date(Date.now() - 2 * DAY);
  for (const ref of [named, box, loose]) fs.utimesSync(path.join(dir, folderOf('p'), hashOf(ref)), old, old);
  pruneCopies(dir, 'p', refs, Date.now() - DAY);
  assert.deepEqual(fs.readdirSync(path.join(dir, folderOf('p'))).sort(), [hashOf(named), hashOf(box)].sort(), 'the one no question names is gone');
  assert.equal(readCopy(dir, 'p', named, ['text']).bytes.toString(), 'named');
});

test("a renamed project's copies go with it, so its questions still show them", async () => {
  const dir = path.join(base, 'rename');
  const ref = keepCopy(dir, 'old name', 'shots/a.png', await toWebp(SHOT, 'png'), 'kept:');
  moveCopies(dir, 'old name', 'new name');
  const copy = readCopy(dir, 'new name', ref, ['png', 'jpeg']);
  assert.equal(copy.kind, 'webp');
  assert.throws(() => readCopy(dir, 'old name', ref, ['png']), /no copy/);
  assert.equal(fs.existsSync(path.join(dir, folderOf('old name'))), false);

  // Through Ledung: renaming the project moves them.
  const root = path.join(base, 'renamed');
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shots', 'menu.png'), SHOT);
  const { store, manager, session } = chain(root, 'before');
  const ask = await askTool(session);
  assert.equal((await ask.handler({ question: 'Judge', tier: 'Process', screenshots: [{ file: 'shots/menu.png', look_for: 'x' }] }, {})).isError, undefined);
  const shotRef = store.listQuestions()[0]!.shots![0]!.path;
  manager.renameProject('before', 'after');
  assert.equal((await manager.readImage('s', shotRef)).type, 'image/webp');
});

// The class (issue #306): a copy is named "container:" or "kept:", so a check for one prefix alone misses the other's
// copies. Only the helpers below recognise them; everything else asks them.
test('a kept copy is recognised by both its prefixes, only through the shared helpers', () => {
  const allowed = new Set([path.join('src', 'sessions', 'container-files.ts'), path.join('src', 'shared', 'questions.ts'), path.join('src', 'store', 'store.ts')]);
  const lone = /startsWith\(CONTAINER_FILE_PREFIX\)|startsWith\(KEPT_FILE_PREFIX\)|startsWith\('(?:container|kept):'\)|\^(?:container|kept):/;
  const found: string[] = [];
  const root = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !allowed.has(rel)) fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => { if (lone.test(line)) found.push(`${rel}:${i + 1}`); });
    }
  };
  for (const dir of ['src', path.join('web', 'src')]) walk(dir);
  assert.deepEqual(found, []);
  // The probe finds one where it is: in the helpers' own file.
  assert.ok(fs.readFileSync(path.join(root, 'src', 'sessions', 'container-files.ts'), 'utf8').split('\n').some((l) => lone.test(l)));
});

test('a copy that is a WebP counts only as the image its name says', async () => {
  const dir = path.join(base, 'kinds');
  const webp = await toWebp(SHOT, 'png');
  const asPng = keepCopy(dir, 'p', 'a.png', webp, 'kept:');
  assert.equal(readCopy(dir, 'p', asPng, ['png', 'jpeg']).kind, 'webp');
  assert.equal(readCopy(dir, 'p', asPng.replace('a.png', 'a.jpg'), ['png', 'jpeg']).kind, 'webp');
  assert.throws(() => readCopy(dir, 'p', asPng.replace('a.png', 'a.md'), ['png', 'jpeg', 'text']), /is not a PNG or JPEG image or a \.txt/);
  assert.throws(() => readCopy(dir, 'p', asPng, ['text']), /is not a PNG or JPEG image or a \.txt/);
});

/** Questions answered `ages` days ago (fractions allowed), in project `project`'s session `session`. */
function answered(store: Store, session: string, ages: number[], now: number, status: 'answered' | 'withdrawn' = 'answered'): number[] {
  const db = store.database;
  return ages.map((age) => {
    const q = store.createQuestion({ sessionId: session, question: `q ${age}`, options: null, addressedTo: 'user', earlier: [{ at: 1, kind: 'reply', text: 'before' }] });
    const at = Math.round(now - age * DAY);
    db.prepare(`UPDATE questions SET status = ?, answer = 'a', answered_at = ?, asked_at = ? WHERE id = ?`).run(status, at, at - 1000, q.id);
    return q.id;
  });
}

test('history: per project the last 100 answered, or every one of the last 30 days if more, light', () => {
  const now = Date.UTC(2026, 10, 12, 12);
  const store = new Store(openDatabase(':memory:'));
  for (const [id, project] of [['a', 'A'], ['b', 'B'], ['c', 'C']] as const) store.createSession({ id, project, runner: 'local', title: id, parentId: null, permissionMode: 'default' });
  // A: 130 answered, all older than 30 days: the 100 newest.
  const a = answered(store, 'a', Array.from({ length: 130 }, (_, i) => 40 + i), now);
  // B: 5 answered this month and 120 before: the 100 newest, these 5 among them.
  const b = answered(store, 'b', [...Array.from({ length: 5 }, (_, i) => 1 + i), ...Array.from({ length: 120 }, (_, i) => 31 + i)], now);
  // C: 120 answered within 30 days and 10 older: all 120 of the month (more than 100), none older.
  const c = answered(store, 'c', [...Array.from({ length: 120 }, (_, i) => (i + 1) * 0.2), ...Array.from({ length: 10 }, (_, i) => 60 + i)], now);
  // C's withdrawn questions are counted apart, so they don't push answered ones out.
  const cw = answered(store, 'c', Array.from({ length: 3 }, (_, i) => 70 + i), now, 'withdrawn');
  store.createQuestion({ sessionId: 'a', question: 'still open', options: null, addressedTo: 'user' });

  const history = store.questionHistory(HISTORY_PER_PROJECT, now - HISTORY_DAYS * DAY);
  const ids = new Set(history.map((q) => q.id));
  assert.deepEqual(a.filter((id) => ids.has(id)), a.slice(0, 100), 'A: its 100 newest');
  assert.deepEqual(b.filter((id) => ids.has(id)), b.slice(0, 100), 'B: its 100 newest, the month among them');
  assert.deepEqual(c.filter((id) => ids.has(id)), c.slice(0, 120), "C: the month's 120");
  assert.deepEqual(cw.filter((id) => ids.has(id)), cw, "C's withdrawn: counted apart");
  assert.equal(history.length, 100 + 100 + 120 + 3);
  assert.ok(history.every((q) => q.status !== 'open'));
  // Newest first, every one light: no kept conversation, marked so.
  const at = history.map((q) => q.answeredAt!);
  assert.deepEqual(at, [...at].sort((x, y) => y - x));
  assert.ok(history.every((q) => q.light === true && q.earlier === null));
  // The page asks for a light one whole.
  const light = history.at(-1)!;
  assert.deepEqual(store.getQuestion(light.id)!.earlier, [{ at: 1, kind: 'reply', text: 'before' }]);

  // The page's list keeps the same ones from what it has: the page load's whole ones and the history read.
  const projectOf = (s: string) => ({ a: 'A', b: 'B', c: 'C' })[s] ?? '?';
  const have = Object.values(withHistory(Object.fromEntries(store.listQuestions().map((q) => [q.id, q])), history));
  const { done } = waitingLists(have, projectOf, () => [], () => true, [], now);
  assert.deepEqual(done.map((i) => i.q.id).sort((x, y) => x - y), [...ids].sort((x, y) => x - y));
  // One project shown alone keeps its own 100, not 30 of all.
  const { done: onlyA } = waitingLists(have, projectOf, () => [], (p) => p === 'A', [], now);
  assert.equal(onlyA.length, 100);
});

test('a page load carries what it did before; history is its own read, with the sessions it names', () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'A', runner: 'local', path: base }] }), store, () => {}));
  store.createSession({ id: 'a', project: 'A', runner: 'local', title: 'a', parentId: null, permissionMode: 'default' });
  store.createSession({ id: 'other', project: 'A', runner: 'local', title: 'not named', parentId: null, permissionMode: 'default' });
  const now = Date.now();
  const old = answered(store, 'a', Array.from({ length: 70 }, (_, i) => 40 + i), now);
  const open = store.createQuestion({ sessionId: 'a', question: 'open', options: null, addressedTo: 'user' });
  // The page load: the open ones and the 50 most recently closed, whole, as before #306.
  const sent = manager.questions();
  assert.deepEqual(sent.map((q) => q.id), [open.id, ...old.slice(0, 50)]);
  assert.ok(sent.every((q) => !q.light));
  // The history read: all 70, light, and only the sessions they name.
  const history = manager.questionHistory(now);
  assert.deepEqual(history.questions.map((q) => q.id), old, 'all 70: more than the 50 a page load has');
  assert.ok(history.questions.every((q) => q.light));
  assert.deepEqual(history.sessions.map((s) => s.id), ['a']);
  assert.deepEqual(manager.question(old.at(-1)!).earlier, [{ at: 1, kind: 'reply', text: 'before' }]);
  assert.throws(() => manager.question(9999), /No such question/);
});

test("a light question's texts are cut, its files' names never; the page keeps what it has and opens one whole", () => {
  const long = 'x'.repeat(5000);
  const name = `kept:${'a'.repeat(32)}/${'deep/'.repeat(80)}shot.png`;
  const q = {
    id: 7, sessionId: 's', askedAt: 1, question: long, options: null, addressedTo: 'user', status: 'answered', answer: long, answeredAt: 2,
    answeredBy: 'user', aboutQuestion: null, forwardedFrom: null, aboutRequest: null, deliveredAt: 2, withdrawnReason: null,
    shots: [{ path: name, group: 'g', lookFor: long, doneWhen: null, facts: [long], opinions: [] }],
    details: { title: 'T', tier: 'Process', issue: long, review: { solving: long, done: 'd', evidence: [{ file: name, caption: long, kind: 'image' }] } },
    earlier: [{ at: 1, kind: 'reply', text: long }], sources: null, original: null,
  } as QuestionInfo;
  const light = lightQuestion(q);
  assert.equal(light.light, true);
  assert.equal(light.earlier, null);
  assert.equal(light.question.length, LIGHT_TEXT_CHARS + 1);
  assert.equal(light.answer!.length, LIGHT_TEXT_CHARS + 1);
  assert.equal(light.details!.issue!.length, LIGHT_TEXT_CHARS + 1);
  assert.equal(light.details!.review!.solving.length, LIGHT_TEXT_CHARS + 1);
  assert.equal(light.shots![0]!.lookFor.length, LIGHT_TEXT_CHARS + 1);
  assert.equal(light.shots![0]!.path, name, "a screenshot's name is whole");
  assert.equal(light.details!.review!.evidence![0]!.file, name, "an evidence file's name is whole");
  assert.equal(light.details!.title, 'T', 'a short text as it was');
  assert.ok(JSON.stringify(light).length < JSON.stringify(q).length / 5);

  // The page: a question it has whole is never replaced by its light entry; one it lacks is added.
  const whole = { ...q, id: 8 };
  const merged = withHistory({ 8: whole }, [lightQuestion(whole), light]);
  assert.equal(merged[8], whole);
  assert.equal(merged[7], light);
  // Opened, a light entry shows the whole question once read; a whole one is shown as it is.
  const item = { q: light, v: deskQuestion(light), project: 'p', tier: null };
  assert.equal(opened(item, null).q, light, 'still light while it is read');
  assert.equal(opened(item, { ...q, id: 9 }).q, light, "another question's answer is not taken");
  const shown = opened(item, q);
  assert.equal(shown.q, q);
  assert.equal(shown.v.review!.solving, long, "the desk reads the whole question");
  const wholeItem = { q: whole, v: deskQuestion(whole), project: 'p', tier: null };
  assert.equal(opened(wholeItem, q), wholeItem);
});
