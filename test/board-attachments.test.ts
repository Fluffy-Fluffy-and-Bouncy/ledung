// Board attachments: evidence files a manager posts with a board post. Upload paths and integrity, the
// header, what may leave (folder, kinds, the outgoing checks) and the user's OK with every file shown,
// lockdown both ways, fetching into the board cache under Ledung's own names (checked against the
// header, once per content), the image reader's limits, pruning, and the GitHub adapter's evidence branch
// (one commit without parents, so no history keeps a file); with boards in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { openDatabase } from '../src/store/database.ts';
import { Boards } from '../src/board/boards.ts';
import { BoardStore } from '../src/board/store.ts';
import { FakeBackend, FakeBoard } from '../src/board/fake.ts';
import { readHeader, withHeader } from '../src/board/address.ts';
import { bytesKind, cacheFile, evidencePath, parseBoardFile, readCachedImage, safeName, sha256, validRef, type AttachmentRef } from '../src/board/attachments.ts';
import { EVIDENCE_BRANCH, fetchHttp, GitHubBackend, RAW_LIMIT, type Http, type HttpAnswer } from '../src/board/github.ts';
import { BoardError } from '../src/board/types.ts';
import type { QuestionInfo, QuestionShot } from '../src/shared/protocol.ts';
import { listenOk } from './free-port.ts';

const REPO = 'org/board';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);
const LOG = 'step 1 ok\nstep 2 ok\n';
const KEY = '0123456789ab';
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ledung-att-${name}-`));

interface Side {
  boards: Boards;
  backend: FakeBackend;
  root: string;
  cache: string;
  inbox: { id: string; source: string; text: string }[];
  asked: { id: number; question: string; options: string[] | null; shots: QuestionShot[] | undefined }[];
  clock: { now: number };
  store: BoardStore;
  locked: { value: boolean };
}

/** One Ledung on a shared board: project P, the board on, allowing the other login, approved to post to it. */
function side(login: string, other: string, fake: FakeBoard, over: { evidenceDays?: number; approved?: boolean } = {}): Side {
  const root = tmp(`${login}-proj`);
  const cache = tmp(`${login}-cache`);
  const store = new BoardStore(openDatabase(':memory:'));
  const locked = { value: false };
  const s: Side = { boards: null as never, backend: new FakeBackend(fake, login), root, cache, inbox: [], asked: [], clock: { now: Date.parse('2026-10-16T08:00:00Z') }, store, locked };
  s.boards = new Boards({
    store, config: parseConfig({ board: { burstSeconds: 0, evidenceDays: over.evidenceDays ?? 30 } }).board!, userName: 'Sam', cacheDir: cache,
    attachmentRoot: () => root,
    backendFor: () => s.backend,
    projectNames: () => ['P'],
    closed: () => locked.value,
    manager: async () => `m-${login}`,
    inbox: (id, source, text) => void s.inbox.push({ id, source, text }),
    wake: async () => {},
    sensitive: () => ({ commandPatterns: [String.raw`\bkubectl\b`], pathPatterns: [String.raw`(^|[\\/])secrets[\\/]`] }),
    askUser: (_m, question, options, shots) => {
      const id = 500 + s.asked.length + 1;
      s.asked.push({ id, question, options, shots });
      return id;
    },
    publish: () => {},
    now: () => s.clock.now,
    setTimer: (fn) => {
      fn();
      return () => {};
    },
  });
  s.boards.setProjectSetting('P', { enabled: true, repo: REPO, allow: [other], channels: [], frontDesk: true });
  if (over.approved !== false) store.approveContact(other, null, 0);
  return s;
}

const answer = (id: number, text: string) => ({ id, answer: text, answeredBy: 'user' }) as QuestionInfo;

/** Posts with files: held, then allowed as the user would (Pass on every screenshot, or Allow). */
async function postAllowed(s: Side, args: Parameters<Boards['post']>[2]): Promise<string> {
  const held = await s.boards.post(`m-${s.backend.login}`, 'P', args);
  assert.match(held, /Not sent yet/);
  const q = s.asked.at(-1)!;
  await s.boards.onUserAnswered(answer(q.id, q.shots?.length ? `Screenshot verdicts: Pass ${q.shots.length}` : 'Allow'));
  return s.inbox.at(-1)!.text;
}

function pair(over: { evidenceDays?: number } = {}) {
  const fake = new FakeBoard();
  const a = side('alice', 'bob', fake, over);
  const b = side('bob', 'alice', fake, over);
  fs.writeFileSync(path.join(a.root, 'cart.png'), PNG);
  fs.writeFileSync(path.join(a.root, 'run.log'), LOG);
  return { fake, a, b, poll: async (x: Side) => void (await x.boards.board(REPO)!.pollOnce()) };
}

test('upload paths are evidence/<thread>/<post key>/<n>.<ext>: Ledung\'s names only, never the file\'s', () => {
  assert.equal(evidencePath('12', KEY, 1, 'png'), `evidence/12/${KEY}/1.png`);
  assert.equal(evidencePath(null, KEY, 2, 'jpeg'), `evidence/new/${KEY}/2.jpg`);
  assert.equal(evidencePath('3', KEY, 5, 'text'), `evidence/3/${KEY}/5.txt`);
  assert.throws(() => evidencePath('../x', KEY, 1, 'png'));
  assert.throws(() => evidencePath('1', '../../etc', 1, 'png'));
  assert.throws(() => evidencePath('1', KEY, 6, 'png'));
  assert.equal(safeName('..\\..\\evil.png'), 'evil.png');
  assert.equal(sha256(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test("the header carries each file's path and SHA-256; ones Ledung wouldn't write are dropped, and the list for people is not text", () => {
  const ref: AttachmentRef = { path: evidencePath('3', KEY, 1, 'png'), name: 'a.png', kind: 'png', size: PNG.length, sha: sha256(PNG) };
  const body = `${withHeader(['@bob'], 'P', 'see the shot', [ref])}\n\n<!-- ledung-attachments -->\n**Attachments**\n- a.png`;
  const h = readHeader(body);
  assert.equal(h.text, 'see the shot');
  assert.deepEqual(h.attachments, [ref]);
  for (const bad of [
    { ...ref, path: 'src/main.ts' }, { ...ref, path: `evidence/3/${KEY}/../../x.png` }, { ...ref, path: `evidence/3/${KEY}/1.jpg` }, { ...ref, kind: 'svg' },
    { ...ref, size: 50 * 1024 * 1024 }, { ...ref, sha: 'f'.repeat(40) }, { ...ref, path: `evidence/3/${KEY}/cart.png` }, { ...ref, path: `evidence/3/${KEY}/9.png` },
  ]) {
    assert.deepEqual(readHeader(withHeader(['@bob'], 'P', 'x', [bad as AttachmentRef])).attachments, [], JSON.stringify(bad));
  }
  assert.equal(validRef({ ...ref, name: '../../x.png' })!.name, 'x.png');
  // At most five, whatever a header lists.
  assert.equal(readHeader(withHeader(['@bob'], 'P', 'x', Array.from({ length: 9 }, () => ref))).attachments.length, 5);
  assert.doesNotMatch(withHeader(['@bob'], 'P', 'x'), /att/);
});

test('the user sees what leaves: a post with files is held, its screenshots to judge and its text in full; it goes only with Pass on each', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  const held = await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'Sign-off', text: 'Please look', attachments: ['cart.png', 'run.log'] });
  assert.match(held, /Not sent yet: it carries files, so Sam is asked \(question #501\)/);
  const q = a.asked[0]!;
  assert.equal(q.options, null, 'no Allow button that skips the screenshots');
  // The screenshot is the copy Ledung took, the bytes that leave, not the live file (PR #131 review: the approval bound to the bytes shown).
  assert.equal(q.shots!.length, 1);
  assert.match(q.shots![0]!.path, /^board:org\/board\/outbox\/[0-9a-f]{12}-1\.png$/);
  assert.equal(q.shots![0]!.group, 'Leaves for the board org/board');
  assert.deepEqual(a.boards.attachmentImage(q.shots![0]!.path).bytes, PNG);
  assert.match(q.question, /with 2 files/);
  assert.match(q.question, /Everyone with access to org\/board can read these files/);
  assert.match(q.question, /\*\*run\.log\*\* \(text, 1 KB\):\n\n```\nstep 1 ok\nstep 2 ok\n/);
  assert.equal(fake.files.size, 0, 'nothing leaves before the answer');
  // Not every screenshot passed (or a typed "Allow"): not sent.
  await a.boards.onUserAnswered(answer(q.id, 'Allow'));
  assert.equal(fake.files.size, 0);
  assert.match(a.inbox.at(-1)!.text, /did not allow/);
  const again = await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'Sign-off', text: 'Please look', attachments: ['cart.png'] });
  assert.match(again, /question #502/);
  await a.boards.onUserAnswered(answer(502, 'Screenshot verdicts: Fail 1\n- x · cart.png: Fail — has a name in it'));
  assert.equal(fake.files.size, 0);
  // All Pass: sent, with its files.
  assert.match(await postAllowed(a, { to: ['@bob/P'], title: 'Sign-off', text: 'Please look', attachments: ['cart.png', 'run.log'] }), /with 2 attachments \(cart\.png, run\.log\)/);
  assert.equal(fake.files.size, 2);
});

test('what leaves is the copy the user was shown, whatever happens to the file meanwhile; a changed copy is not sent', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  // The review's probe: the file is swapped while the user looks, and swapped back before the answer.
  const secret = Buffer.concat([PNG, Buffer.from('a name')]);
  const other = Buffer.concat([PNG, Buffer.from('harmless')]);
  fs.writeFileSync(path.join(a.root, 'cart.png'), secret);
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] });
  const shot = a.asked[0]!.shots![0]!.path;
  fs.writeFileSync(path.join(a.root, 'cart.png'), other);
  assert.deepEqual(a.boards.attachmentImage(shot).bytes, secret, 'the user is shown the bytes held, not the live file');
  fs.writeFileSync(path.join(a.root, 'cart.png'), secret);
  fs.writeFileSync(path.join(a.root, 'cart.png'), other);
  await a.boards.onUserAnswered(answer(501, 'Screenshot verdicts: Pass 1'));
  assert.deepEqual([...fake.files.values()], [secret], 'exactly what the user judged left');
  assert.deepEqual(fs.readdirSync(path.join(a.cache, 'org', 'board', 'outbox')), [], 'the held copy goes once answered');
  // A held copy changed in the cache is not sent either.
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'y', attachments: ['cart.png'] });
  const [held] = fs.readdirSync(path.join(a.cache, 'org', 'board', 'outbox'));
  fs.writeFileSync(path.join(a.cache, 'org', 'board', 'outbox', held!), secret);
  await a.boards.onUserAnswered(answer(502, 'Screenshot verdicts: Pass 1'));
  assert.match(a.inbox.at(-1)!.text, /the copy of cart\.png Sam was shown changed; nothing was sent/);
  assert.equal(fake.files.size, 1);
  assert.equal(fake.posts.length, 1);
});

test('lockdown is checked again when the user answers: a held post of a project locked meanwhile sends nothing (review B1)', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png', 'run.log'] });
  a.locked.value = true;
  await a.boards.onUserAnswered(answer(501, 'Screenshot verdicts: Pass 1'));
  assert.equal(fake.files.size, 0);
  assert.equal(fake.posts.length, 0);
  assert.equal(a.store.outboxByQuestion(501)!.status, 'failed');
  assert.match(a.inbox.at(-1)!.text, /Sam allowed your board post, but the board is off for "P" now \(locked, or turned off in its settings\); nothing was sent/);
  assert.deepEqual(fs.readdirSync(path.join(a.cache, 'org', 'board', 'outbox')), []);
});

test('a text attachment leaves only as long as the question shows it whole: the bytes shown are the bytes sent (review B2)', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  // The review's probe: a 16 KB log with an ID on its last line is refused, never put to the user.
  fs.writeFileSync(path.join(a.root, 'long.log'), `${'step ok\n'.repeat(2000)}customer id 1234567890\n`);
  await assert.rejects(a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['long.log'] }),
    /long\.log is 16023 characters; a text attachment is at most 4000, all of which the user sees/);
  assert.equal(a.asked.length, 0);
  // At the limit: the question holds all of it, and exactly that leaves.
  const log = `${'x'.repeat(3990)}\nlast line: customer 42\n`.slice(-4000);
  fs.writeFileSync(path.join(a.root, 'edge.log'), log);
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['edge.log'] });
  const shown = /\*\*edge\.log\*\* \(text, 4 KB\):\n\n```\n([\s\S]*?)\n```/.exec(a.asked[0]!.question)![1]!;
  assert.equal(shown, log);
  await a.boards.onUserAnswered(answer(501, 'Allow'));
  assert.deepEqual([...fake.files.values()], [Buffer.from(shown)]);
});

test('text or image is decided by the file the link leads to, by its bytes (review M3)', async (t) => {
  assert.equal(bytesKind(PNG, 'a.png'), 'png');
  assert.equal(bytesKind(JPEG, 'a.JPEG'), 'jpeg');
  assert.equal(bytesKind(Buffer.from('notes'), 'notes.md'), 'text');
  assert.equal(bytesKind(Buffer.from('notes'), 'a.png'), null);
  assert.equal(bytesKind(PNG, 'a.log'), null, 'image bytes named as text: neither');
  assert.equal(bytesKind(Buffer.from('a\0b'), 'a.log'), null);
  assert.equal(bytesKind(Buffer.from('A=1'), '.env'), null);
  const { fake, a, poll } = pair();
  await poll(a);
  fs.writeFileSync(path.join(a.root, 'notes.md'), 'just notes\n');
  try {
    fs.symlinkSync(path.join(a.root, 'notes.md'), path.join(a.root, 'x.png'));
  } catch {
    t.skip('this system makes no file links without rights');
    return;
  }
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['x.png'] });
  assert.equal(a.asked[0]!.options?.[0], 'Allow', 'a text file, shown and allowed as text');
  assert.match(a.asked[0]!.question, /\*\*notes\.md\*\* \(text/);
  await a.boards.onUserAnswered(answer(501, 'Allow'));
  assert.match([...fake.files.keys()][0]!, /\/1\.txt$/);
});

test('evidence uploaded for a post that then fails leaves the board again, or is pruned at the next poll (review Important 3)', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  const send = a.backend.send.bind(a.backend);
  a.backend.send = async () => { throw new BoardError('unreachable', 'down'); };
  assert.match(await postAllowed(a, { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] }), /Not sent; the board is unreachable \(down\)/);
  assert.equal(fake.files.size, 0, 'taken off again');
  // Taking it off fails too: recorded, and the next poll prunes it.
  const deleteFiles = a.backend.deleteFiles.bind(a.backend);
  a.backend.deleteFiles = async () => { throw new BoardError('unreachable', 'down'); };
  await postAllowed(a, { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] });
  assert.equal(fake.files.size, 1);
  a.backend.send = send;
  a.backend.deleteFiles = deleteFiles;
  await poll(a);
  assert.equal(fake.files.size, 0);
});

test('the first post to a new login with files asks once, showing the files', async () => {
  const fake = new FakeBoard();
  const a = side('alice', 'bob', fake, { approved: false });
  fs.writeFileSync(path.join(a.root, 'cart.png'), PNG);
  await a.boards.board(REPO)!.pollOnce();
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] });
  assert.match(a.asked[0]!.question, /for the first time, with 1 file/);
  assert.match(a.asked[0]!.question, /also lets managers here post to @bob/);
  await a.boards.onUserAnswered(answer(501, 'Screenshot verdicts: Pass 1'));
  assert.equal(fake.files.size, 1);
  assert.ok(a.store.contactApproved('bob'));
});

test('a post with a screenshot and a log: in the board repo by path and SHA-256, fetched into the other cache under Ledung\'s names, shown to its manager', async () => {
  const { fake, a, b, poll } = pair();
  fs.writeFileSync(path.join(a.root, 'evil name (1).png'), PNG);
  await poll(a);
  await poll(b);
  await postAllowed(a, { to: ['@bob/P'], title: 'Sign-off', text: 'Please look', attachments: ['evil name (1).png', 'run.log'] });
  const [k1, k2] = [...fake.files.keys()];
  assert.match(k1!, /^evidence\/new\/[0-9a-f]{12}\/1\.png$/);
  assert.equal(k2, k1!.replace('1.png', '2.txt'));
  const header = readHeader(fake.posts[0]!.body).attachments;
  assert.deepEqual(header.map((r) => [r.path, r.sha, r.size]), [[k1, sha256(PNG), PNG.length], [k2, sha256(Buffer.from(LOG)), LOG.length]]);
  await poll(b);
  const delivered = b.inbox.find((i) => i.source.startsWith('board:'))!;
  assert.match(delivered.text, /evil-name-1-\.png \(PNG, 1 KB\): to show it to Sam, give ask_user's screenshots file "board:org\/board\/1\/issue-1-1\.png"/);
  assert.match(delivered.text, /issue-1-1\.png", or in a review its evidence file\./);
  // A text file is named too, so a review over the board shows it on the review page (docs/steps/pr-review.md).
  assert.match(delivered.text, /run\.log \(text, 1 KB\), in a review its evidence file "board:org\/board\/1\/issue-1-2\.txt":\n```\nstep 1 ok\nstep 2 ok\n/);
  // Named by Ledung: <thread>/<post id>-<n>.<ext>, whatever the sender called them; nothing in a project folder.
  assert.deepEqual(fs.readdirSync(path.join(b.cache, 'org', 'board', '1')).sort(), ['issue-1-1.png', 'issue-1-2.txt']);
  assert.deepEqual(fs.readdirSync(b.root), []);
  const img = b.boards.attachmentImage('board:org/board/1/issue-1-1.png', 'P');
  assert.deepEqual(img.bytes, PNG);
  assert.throws(() => b.boards.attachmentImage('board:org/board/1/issue-1-1.png', 'Other'), /not on the board of "Other"/);
  // As a review's evidence: images and text alike, with the same rules on where they may come from.
  assert.deepEqual(b.boards.attachmentEvidence('board:org/board/1/issue-1-2.txt', 'P'), { file: 'board:org/board/1/issue-1-2.txt', kind: 'text', bytes: Buffer.from(LOG) });
  assert.equal(b.boards.attachmentEvidence('board:org/board/1/issue-1-1.png').kind, 'png');
  assert.throws(() => b.boards.attachmentEvidence('board:org/board/1/issue-1-2.txt', 'Other'), /not on the board of "Other"/);
  assert.throws(() => b.boards.attachmentEvidence('board:org/board/../../outside.txt'), /Only a file received with a board post/);
  assert.throws(() => b.boards.attachmentEvidence('board:org/board/outbox/0123456789ab-1.txt'), /Only a file received with a board post/, 'never a held post');
  for (const x of [a, b]) {
    const view = x.boards.viewThread(REPO, '1');
    assert.deepEqual(view.posts[0]!.attachments.map((f) => [f.name, f.kind, !!f.file, f.error]), [['evil-name-1-.png', 'png', true, null], ['run.log', 'text', true, null]]);
  }
});

test('the same content is downloaded once', async () => {
  const { a, b, poll } = pair();
  await poll(a);
  await poll(b);
  let gets = 0;
  const getFile = b.backend.getFile.bind(b.backend);
  b.backend.getFile = async (p) => (gets++, getFile(p));
  await postAllowed(a, { to: ['@bob/P'], title: 'T', text: 'one', attachments: ['cart.png', './cart.png'] });
  await poll(b);
  await postAllowed(a, { thread: '1', text: 'two', attachments: ['cart.png'] });
  await poll(b);
  assert.equal(gets, 1);
  assert.deepEqual(b.boards.viewThread(REPO, '1').posts.map((p) => p.attachments.length), [1, 1]);
  assert.equal(fs.readdirSync(path.join(b.cache, 'org', 'board', '1')).length, 2);
});

test("receiving: a file that isn't what the header says (size, SHA-256, magic bytes) is not kept, and the post still arrives with the reason", async () => {
  const { fake, b, poll } = pair();
  await poll(b);
  const png: AttachmentRef = { path: evidencePath(null, KEY, 1, 'png'), name: 'cart.png', kind: 'png', size: PNG.length, sha: sha256(PNG) };
  fake.files.set(png.path, Buffer.from('<svg onload=alert(1)>'));
  // Right size and hash, but not a PNG: the extension and the header's kind are not enough.
  const svg = Buffer.from('<svg xmlns="x"/>');
  const fakePng: AttachmentRef = { path: evidencePath(null, KEY, 2, 'png'), name: 'b.png', kind: 'png', size: svg.length, sha: sha256(svg) };
  fake.files.set(fakePng.path, svg);
  const missing: AttachmentRef = { path: evidencePath(null, KEY, 3, 'jpeg'), name: 'gone.jpg', kind: 'jpeg', sha: sha256(JPEG), size: JPEG.length };
  fake.add('alice', null, withHeader(['@bob/P'], 'P', 'look', [png, fakePng, missing]), 'Forged');
  await poll(b);
  const text = b.inbox.find((i) => i.source.startsWith('board:'))!.text;
  assert.match(text, /cart\.png \(PNG, 1 KB\): could not be fetched: its size is 21 bytes/);
  assert.match(text, /b\.png \(PNG, 1 KB\): could not be fetched: it is not really a PNG image/);
  assert.match(text, /gone\.jpg \(JPEG, 1 KB\): could not be fetched: No file/);
  assert.equal(fs.existsSync(path.join(b.cache, 'org', 'board', '1')), false);
});

test('posts from senders no project allows, or for nobody here, fetch nothing', async () => {
  const fake = new FakeBoard();
  const b = side('bob', 'alice', fake);
  await b.boards.board(REPO)!.pollOnce();
  const ref: AttachmentRef = { path: evidencePath(null, KEY, 1, 'png'), name: 'x.png', kind: 'png', size: PNG.length, sha: sha256(PNG) };
  fake.files.set(ref.path, PNG);
  fake.add('mallory', null, withHeader(['@bob/P'], 'P', 'hi', [ref]), 'Hi');
  fake.add('alice', null, withHeader(['@carol/Q'], 'Q', 'not for bob', [ref]), 'Other team');
  await b.boards.board(REPO)!.pollOnce();
  assert.deepEqual(fs.readdirSync(b.cache), []);
  assert.equal(b.inbox.length, 0);
});

test('lockdown, both ways: a locked project neither posts files nor gets any fetched, and its board: files are refused', async () => {
  const { fake, a, b, poll } = pair();
  await poll(a);
  await poll(b);
  a.locked.value = true;
  await assert.rejects(a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] }), /board is off for "P"/);
  a.locked.value = false;
  b.locked.value = true;
  await postAllowed(a, { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] });
  await poll(b);
  assert.deepEqual(fs.readdirSync(b.cache), [], 'nothing fetched for a locked project');
  assert.equal(b.inbox.length, 0);
  // Its cache, had it one, is not readable for its manager either.
  fs.mkdirSync(path.join(b.cache, 'org', 'board', '1'), { recursive: true });
  fs.writeFileSync(path.join(b.cache, 'org', 'board', '1', 'issue-1-1.png'), PNG);
  assert.throws(() => b.boards.attachmentImage('board:org/board/1/issue-1-1.png', 'P'), /board is off for "P"/);
  assert.equal(fake.files.size, 1);
});

test("what may leave: only from the manager's folder, only PNG, JPEG or text (no .env, keys, tokens), within the limits and the post's checks", async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  fs.writeFileSync(path.join(path.dirname(a.root), 'outside.png'), PNG);
  for (const [name, content] of [['logo.svg', '<svg/>'], ['fake.png', 'not a png'], ['.env', 'A=1'], ['id_rsa', 'key'], ['auth-token', 'a'.repeat(64)],
    ['big.log', 'x'.repeat(600 * 1024)], ['huge.png', Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])], ['token.log', `GITHUB=ghp_${'A1b2'.repeat(9)}`], ['deploy.log', 'ran kubectl apply']] as const) {
    fs.writeFileSync(path.join(a.root, name), content);
  }
  fs.mkdirSync(path.join(a.root, 'secrets'));
  fs.writeFileSync(path.join(a.root, 'secrets', 'shot.png'), PNG);
  const cases: [string[], RegExp][] = [
    [['../outside.png'], /inside the project/],
    [[path.join(path.dirname(a.root), 'outside.png')], /inside the project/],
    [['logo.svg'], /only PNG and JPEG images and \.txt, \.log or \.md/],
    [['.env'], /only PNG and JPEG images/],
    [['id_rsa'], /only PNG and JPEG images/],
    [['auth-token'], /only PNG and JPEG images/],
    [['fake.png'], /not really a PNG/],
    [['nope.png'], /no file/],
    [['big.log'], /614400 characters; a text attachment is at most 4000/],
    [['huge.png'], /too large/],
    [['token.log'], /looks like a GitHub token/],
    [['deploy.log'], /sensitive command pattern/],
    [['secrets/shot.png'], /sensitive path pattern/],
    [['cart.png', 'cart.png', 'cart.png', 'cart.png', 'cart.png', 'cart.png'], /at most 5 attachments/],
  ];
  for (const [files, why] of cases) {
    await assert.rejects(a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: files }), (e: Error) => e instanceof BoardError && why.test(e.message), files.join(','));
  }
  assert.equal(a.asked.length, 0, 'a refused file is never even put to the user');
  assert.equal(fake.files.size, 0);
  assert.equal(fake.posts.length, 0);
});

test('pruning: a closed thread and old evidence leave the cache, and our own uploads leave the board repo', async () => {
  const { fake, a, b, poll } = pair({ evidenceDays: 7 });
  await poll(a);
  await poll(b);
  await postAllowed(a, { to: ['@bob/P'], title: 'T1', text: 'one', attachments: ['cart.png'] });
  fs.writeFileSync(path.join(a.root, 'other.jpg'), JPEG);
  await postAllowed(a, { to: ['@bob/P'], title: 'T2', text: 'two', attachments: ['other.jpg'] });
  await poll(b);
  assert.equal(fake.files.size, 2);
  fake.closed.add('1');
  await poll(b);
  await poll(a);
  assert.deepEqual(fs.readdirSync(path.join(b.cache, 'org', 'board', '1')), []);
  assert.deepEqual(fs.readdirSync(path.join(a.cache, 'org', 'board', '1')), []);
  assert.deepEqual([...fake.files.keys()].map((k) => k.split('/').pop()), ['1.jpg']);
  assert.equal(b.boards.viewThread(REPO, '1').posts[0]!.attachments[0]!.pruned, true);
  a.clock.now += 8 * 24 * 3600_000;
  b.clock.now += 8 * 24 * 3600_000;
  await poll(a);
  await poll(b);
  assert.equal(fake.files.size, 0);
  assert.deepEqual(fs.readdirSync(path.join(b.cache, 'org', 'board', '2')), []);
});

test('cached images are read only from inside their repo cache folder, as PNG or JPEG by their bytes', () => {
  const cache = tmp('read');
  const dir = path.join(cache, 'org', 'board', '4');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'issue-4-1.png'), PNG);
  fs.writeFileSync(path.join(dir, 'issue-4-2.png'), 'not png');
  fs.writeFileSync(path.join(dir, 'issue-4-3.svg'), '<svg/>');
  fs.writeFileSync(path.join(cache, 'org', 'secret.png'), PNG);
  assert.equal(readCachedImage(cache, 'org/board', '4/issue-4-1.png').type, 'image/png');
  assert.throws(() => readCachedImage(cache, 'org/board', '4/issue-4-2.png'), /not really a PNG/);
  assert.throws(() => readCachedImage(cache, 'org/board', '4/issue-4-3.svg'), /not a PNG or JPEG/);
  for (const out of ['../secret.png', '4/../../secret.png', '..%2Fsecret.png', path.join(cache, 'org', 'secret.png')]) {
    assert.throws(() => readCachedImage(cache, 'org/board', out), /inside the project/, out);
  }
  assert.throws(() => readCachedImage(cache, '../org', 'secret.png'), /not a board repo/);
  assert.throws(() => readCachedImage(cache, 'org/..', 'org/secret.png'), /not a board repo/);
  assert.throws(() => cacheFile(cache, 'org/board', '../4', 'issue:4', 1, 'png'), /not a thread id/);
  assert.equal(cacheFile(cache, 'org/board', '4', 'comment:99/../x', 2, 'jpeg').rel, '4/comment-99-x-2.jpg');
  assert.deepEqual(parseBoardFile('board:org/board/4/issue-4-1.png'), { repo: 'org/board', rel: '4/issue-4-1.png' });
  assert.equal(parseBoardFile('cart.png'), null);
});

/** A GitHub that answers the Git data and contents calls the evidence branch uses, starting empty. */
function fakeGitHub() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const state = { empty: true, ref: null as string | null, readme: false, seq: 0 };
  const id = () => (++state.seq).toString(16).padStart(40, '0');
  const notFound = { status: 404, headers: {}, body: { message: 'Not Found' } };
  const http: Http = async (method, url, headers, body): Promise<HttpAnswer> => {
    calls.push({ method, url, body });
    const u = url.replace('https://api.github.com/repos/org/board', '');
    const b = body as Record<string, any>;
    if (method === 'PUT' && u === '/contents/README.md') {
      state.empty = false;
      state.readme = true;
      return { status: 201, headers: {}, body: {} };
    }
    if (u === '/git/blobs' && method === 'POST') {
      if (state.empty) return { status: 409, headers: {}, body: { message: 'Git Repository is empty.' } };
      const sha = id();
      blobs.set(sha, Buffer.from(b.content, 'base64'));
      return { status: 201, headers: {}, body: { sha } };
    }
    if (u === `/git/ref/heads/${EVIDENCE_BRANCH}`) return state.ref ? { status: 200, headers: {}, body: { object: { sha: state.ref } } } : notFound;
    const commit = /^\/git\/commits\/(\w+)$/.exec(u);
    if (commit) return { status: 200, headers: {}, body: { tree: { sha: commits.get(commit[1]!)!.tree } } };
    const tree = /^\/git\/trees\/(\w+)\?recursive=1$/.exec(u);
    if (tree) return { status: 200, headers: {}, body: { tree: [...trees.get(tree[1]!)!.keys()].map((p) => ({ path: p, type: 'blob' })) } };
    if (u === '/git/trees' && method === 'POST') {
      const t = new Map(b.base_tree ? trees.get(b.base_tree) : []);
      for (const e of b.tree) if (e.sha === null) t.delete(e.path); else t.set(e.path, e.sha);
      const sha = id();
      trees.set(sha, t);
      return { status: 201, headers: {}, body: { sha } };
    }
    if (u === '/git/commits' && method === 'POST') {
      const sha = id();
      commits.set(sha, { tree: b.tree, parents: b.parents });
      return { status: 201, headers: {}, body: { sha } };
    }
    if (u === '/git/refs' && method === 'POST') {
      state.ref = b.sha;
      return { status: 201, headers: {}, body: {} };
    }
    if (u === `/git/refs/heads/${EVIDENCE_BRANCH}` && method === 'PATCH') {
      assert.equal(b.force, true);
      state.ref = b.sha;
      return { status: 200, headers: {}, body: {} };
    }
    if (u === `/git/refs/heads/${EVIDENCE_BRANCH}` && method === 'DELETE') {
      state.ref = null;
      return { status: 204, headers: {}, body: null };
    }
    const file = /^\/contents\/(.+)\?ref=(.+)$/.exec(u);
    if (file && headers.accept === 'application/vnd.github.raw+json') {
      const sha = state.ref && decodeURIComponent(file[2]!) === EVIDENCE_BRANCH ? trees.get(commits.get(state.ref)!.tree)!.get(decodeURIComponent(file[1]!)) : undefined;
      return sha ? { status: 200, headers: {}, body: blobs.get(sha)! } : notFound;
    }
    if (method === 'POST' && u === '/issues') return { status: 201, headers: {}, body: { number: 9, created_at: '2026-10-16T08:00:00Z' } };
    if (u.startsWith('/issues?')) {
      return { status: 200, headers: { etag: '"i"' }, body: [{ number: 9, id: 1, title: 'T', body: 'x', user: { login: 'alice' }, created_at: '2026-10-16T08:00:00Z', updated_at: '2026-10-16T08:01:00Z', state: 'closed' }] };
    }
    if (u.startsWith('/issues/comments?')) return { status: 200, headers: { etag: '"c"' }, body: [] };
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { http, calls, state, commits, trees };
}

test('GitHub: evidence lives on its own branch, one commit without parents, so pruning leaves no history; an empty repo gets a README first', async () => {
  const gh_ = fakeGitHub();
  const gh = new GitHubBackend({ repo: REPO, pollMs: 5000, http: gh_.http, token: async () => 't', now: () => Date.parse('2026-10-16T08:00:30Z') });
  const p1 = evidencePath(null, KEY, 1, 'png');
  const p2 = evidencePath(null, KEY, 2, 'jpeg');
  await gh.putFiles([{ path: p1, bytes: PNG }, { path: p2, bytes: JPEG }], 'evidence');
  assert.equal(gh_.state.readme, true, 'the empty repo got its README');
  assert.deepEqual(await gh.getFile(p1), PNG);
  const p3 = evidencePath('9', 'aaaaaaaaaaaa', 1, 'text');
  await gh.putFiles([{ path: p3, bytes: Buffer.from(LOG) }], 'more');
  // Every commit of the branch has no parents: the branch is always one commit.
  assert.ok([...gh_.commits.values()].every((c) => c.parents.length === 0));
  assert.deepEqual([...gh_.trees.get(gh_.commits.get(gh_.state.ref!)!.tree)!.keys()].sort(), [p1, p2, p3].sort());
  await gh.deleteFiles([p1, 'evidence/new/bbbbbbbbbbbb/1.png'], 'prune');
  assert.deepEqual([...gh_.trees.get(gh_.commits.get(gh_.state.ref!)!.tree)!.keys()].sort(), [p2, p3].sort());
  await assert.rejects(gh.getFile(p1), /not on the board \(pruned, or never uploaded\)/);
  // The last files gone: the branch goes.
  await gh.deleteFiles([p2, p3], 'prune');
  assert.equal(gh_.state.ref, null);
  await gh.deleteFiles([p2], 'prune');
  // The post lists them for people, from the evidence branch, and the header for Ledung.
  const ref: AttachmentRef = { path: p1, name: 'cart.png', kind: 'png', size: PNG.length, sha: sha256(PNG) };
  await gh.send({ threadId: null, title: 'T', to: ['@bob'], fromProject: 'P', text: 'look', attachments: [ref] });
  const issueBody = (gh_.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'))!.body as { body: string }).body;
  assert.match(issueBody, /^<!-- ledung \{.*"att":\[\{"path":"evidence\/new\/0123456789ab\/1\.png"/);
  assert.match(issueBody, /<!-- ledung-attachments -->\n\*\*Attachments\*\*\n- cart\.png \(PNG, 1 KB\)<br>!\[cart\.png\]\(https:\/\/github\.com\/org\/board\/blob\/ledung-evidence\/evidence\/new\/0123456789ab\/1\.png\?raw=true\)/);
  assert.equal(readHeader(issueBody).text, 'look');
  assert.deepEqual((await gh.poll(null)).closed, ['9']);
});

test('GitHub: a replace built on a head another Ledung changed meanwhile is built again, so a pruned file stays gone (review I1)', async () => {
  const gh_ = fakeGitHub();
  let race: (() => Promise<void>) | null = null;
  // Ledung A's calls; the race runs just after A made its commit on the old head, before A's update.
  const httpA: Http = async (method, url, headers, body) => {
    const res = await gh_.http(method, url, headers, body);
    if (race && method === 'POST' && url.endsWith('/git/commits')) {
      const r = race;
      race = null;
      await r();
    }
    return res;
  };
  const opts = { repo: REPO, pollMs: 5000, token: async () => 't', now: () => Date.parse('2026-10-16T08:00:30Z') };
  const a = new GitHubBackend({ ...opts, http: httpA });
  const b = new GitHubBackend({ ...opts, http: gh_.http });
  const x = evidencePath('1', KEY, 1, 'png');
  const keep = evidencePath('1', KEY, 2, 'jpeg');
  const y = evidencePath('2', 'aaaaaaaaaaaa', 1, 'png');
  await b.putFiles([{ path: x, bytes: PNG }, { path: keep, bytes: JPEG }], 'evidence');
  race = () => b.deleteFiles([x], 'prune');
  await a.putFiles([{ path: y, bytes: PNG }], 'more');
  assert.deepEqual([...gh_.trees.get(gh_.commits.get(gh_.state.ref!)!.tree)!.keys()].sort(), [keep, y].sort(), 'x stays pruned, y is there');
  assert.ok([...gh_.commits.values()].every((c) => c.parents.length === 0));
});

test('GitHub: a downloaded file is refused as soon as it is larger than any attachment, not read whole (review M4)', async (t) => {
  const http = await import('node:http');
  const big = Buffer.alloc(RAW_LIMIT + 1);
  const server = http.createServer((req, res) => {
    if (req.url === '/length') res.writeHead(200, { 'content-length': String(big.length) }).end(big);
    else if (req.url === '/chunked') {
      res.writeHead(200);
      for (let i = 0; i < 6; i++) res.write(Buffer.alloc(1024 * 1024));
      res.end();
    } else res.writeHead(200).end(PNG);
  });
  await listenOk(server);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const raw = { accept: 'application/vnd.github.raw+json' };
  await assert.rejects(fetchHttp('GET', `${base}/length`, raw), /larger than 5 MB/);
  await assert.rejects(fetchHttp('GET', `${base}/chunked`, raw), /larger than 5 MB/);
  assert.deepEqual((await fetchHttp('GET', `${base}/ok`, raw)).body, PNG);
});

const heldCopies = (s: Side): string[] => {
  const dir = path.join(s.cache, 'org', 'board', 'outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('a held copy does not stay for ever: dropped once its post is no longer waiting, or older than evidenceDays (review N3)', async () => {
  const { a, poll } = pair({ evidenceDays: 30 });
  await poll(a);
  // Not waiting any more (the item failed without its copies being dropped): the next poll drops them.
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] });
  assert.equal(heldCopies(a).length, 1);
  await poll(a);
  assert.equal(heldCopies(a).length, 1, 'still waiting and young: kept');
  a.store.repo(REPO).setOutboxStatus(a.store.repo(REPO).outboxItems()[0]!.id, 'failed');
  await poll(a);
  assert.equal(heldCopies(a).length, 0);
  // Waiting but never answered: dropped after evidenceDays, and then it cannot be sent.
  await a.boards.post('m-alice', 'P', { to: ['@bob/P'], title: 'T2', text: 'y', attachments: ['run.log'] });
  const q = a.asked.at(-1)!;
  assert.equal(heldCopies(a).length, 1);
  a.clock.now += 31 * 24 * 3600 * 1000;
  await poll(a);
  assert.equal(heldCopies(a).length, 0);
  await a.boards.onUserAnswered(answer(q.id, 'Allow'));
  assert.match(a.inbox.at(-1)!.text, /gone; nothing was sent/);
});

test('files are recorded before the upload: one that worked but whose answer was lost is pruned later (review N4)', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  const putFiles = a.backend.putFiles.bind(a.backend);
  const deleteFiles = a.backend.deleteFiles.bind(a.backend);
  a.backend.putFiles = async (files: { path: string; bytes: Buffer }[]) => {
    await putFiles(files);
    assert.equal(a.store.repo(REPO).prunable([], Infinity).length, 1, 'recorded before the upload returned');
    throw new BoardError('unreachable', 'response lost');
  };
  a.backend.deleteFiles = async () => { throw new BoardError('unreachable', 'down'); };
  assert.match(await postAllowed(a, { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] }), /Not sent; the board is unreachable \(response lost\)/);
  assert.equal(fake.files.size, 1, 'on the branch with no post');
  a.backend.putFiles = putFiles;
  a.backend.deleteFiles = deleteFiles;
  await poll(a);
  assert.equal(fake.files.size, 0);
});

test('a post that went leaves no record that would prune its files', async () => {
  const { fake, a, poll } = pair();
  await poll(a);
  await postAllowed(a, { to: ['@bob/P'], title: 'T', text: 'x', attachments: ['cart.png'] });
  await poll(a);
  assert.equal(fake.files.size, 1);
  assert.equal(a.store.repo(REPO).prunable([], Infinity).filter((x) => x.error === 'not sent').length, 0);
});
