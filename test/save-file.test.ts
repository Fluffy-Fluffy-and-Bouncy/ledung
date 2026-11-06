// save_linked_file (issue #160): a manager writes a file a linked computer sent it into one of its own sessions'
// worktree. The writer (src/sessions/save-file.ts) first, on its own: each refusal leaves nothing behind, in the
// worktree or outside it. Then the tool through two real linked Ledungs (linked-nodes.ts), as #158's tests send files:
// the Mac's manager sends a PNG, the PC's manager saves it into its worker's worktree.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-save-file-')));
// The EXERCISED line goes to exercised.log in the data folder: this run's own (src/platform/exercised.ts).
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');

const { saveIntoWorktree, pathProblem } = await import('../src/sessions/save-file.ts');
const { FileError } = await import('../src/sessions/files.ts');
const { COOKIE, LinkedNodes } = await import('./linked-nodes.ts');
type Node = import('./linked-nodes.ts').Node;
type Management = import('../src/sessions/management.ts').Management;
const { removeTemp } = await import('./temp.ts');
const { HANG_MS } = await import('./limits.ts');

const nodes = new LinkedNodes();
after(async () => {
  await nodes.close();
  removeTemp(base);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const NO_RULES = { pathPatterns: [], refused: [] };
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

// --- The writer -----------------------------------------------------------------------------------------------

test('ledung#160: the writer saves the bytes at the path in the worktree, making missing folders; same SHA-256, not executable, no temp file left', () => {
  const wt = fresh('wt');
  const saved = saveIntoWorktree(wt, 'evidence/shot.png', 'png', PNG, NO_RULES);
  assert.equal(saved.inside, 'evidence/shot.png');
  // The native real path: on Windows the temp folder's JS real path keeps an 8.3 name (C:\\Users\\RUNNER~1) the writer's
  // has the long one for (Windows CI on PR #172).
  assert.equal(saved.full, path.join(fs.realpathSync.native(wt), 'evidence', 'shot.png'));
  assert.equal(saved.size, PNG.length);
  assert.equal(saved.sha, sha(PNG));
  assert.equal(sha(fs.readFileSync(path.join(wt, 'evidence', 'shot.png'))), sha(PNG));
  assert.deepEqual(filesIn(wt), ['evidence/shot.png'], 'only the file: no temp file beside it');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved.full).mode & 0o111, 0, 'no execute bit');
  // A text file under a nested folder, and .jpeg as well as .jpg.
  saveIntoWorktree(wt, 'logs/run/today.log', 'text', Buffer.from('ok'), NO_RULES);
  saveIntoWorktree(wt, 'a.jpeg', 'jpeg', Buffer.from([0xff, 0xd8, 0xff, 0]), NO_RULES);
  assert.deepEqual(filesIn(wt), ['a.jpeg', 'evidence/shot.png', 'logs/run/today.log']);
});

test('ledung#160: on a file system that ignores case, a path typed in another case than the folder on disk is still saved, in that folder', (t) => {
  const wt = fresh('wt');
  fs.mkdirSync(path.join(wt, 'Evidence'));
  if (!fs.existsSync(path.join(wt, 'evidence'))) {
    t.skip('this file system tells case apart');
    return;
  }
  const saved = saveIntoWorktree(wt, 'evidence/shot.png', 'png', PNG, NO_RULES);
  assert.equal(saved.size, PNG.length);
  assert.deepEqual(filesIn(wt), ['Evidence/shot.png']);
});

test('ledung#160: a path out of the worktree, a hidden path or one of the wrong kind is refused with its reason, and nothing is written', () => {
  const wt = fresh('wt');
  const outside = path.join(path.dirname(wt), 'escaped.png');
  const refused: [string, 'png' | 'text', RegExp][] = [
    ['../escaped.png', 'png', /no empty, "\." or "\.\." part/],
    ['a/../../escaped.png', 'png', /no empty, "\." or "\.\." part/],
    [outside, 'png', /not a path inside the worktree/],
    ['C:\\Windows\\x.png', 'png', /not a path inside the worktree/],
    ['\\\\server\\share\\x.png', 'png', /not a path inside the worktree/],
    ['a//b.png', 'png', /no empty/],
    ['./a.png', 'png', /no empty, "\." or "\.\." part/],
    ['.git/hooks/pre-commit.txt', 'text', /hidden path/],
    ['.env', 'text', /hidden path/],
    ['src/.claude/settings.md', 'text', /hidden path/],
    ['notes.txt:stream', 'text', /not a file or folder name that works on every computer/],
    ['bad\u0000.png', 'png', /NUL/],
    ['run.sh', 'text', /must end in \.txt or \.log or \.md/],
    ['shot.txt', 'png', /must end in \.png/],
    ['', 'png', /Give the path/],
  ];
  for (const [rel, kind, why] of refused) {
    assert.throws(() => saveIntoWorktree(wt, rel, kind, kind === 'png' ? PNG : Buffer.from('x'), NO_RULES), (e: unknown) => e instanceof FileError && why.test(e.message), rel);
  }
  assert.deepEqual(filesIn(wt), [], 'nothing in the worktree');
  assert.ok(!fs.existsSync(outside), 'nothing beside it');
  // The same probe finds a file that is there: a plain path is saved.
  saveIntoWorktree(wt, 'ok.png', 'png', PNG, NO_RULES);
  assert.deepEqual(filesIn(wt), ['ok.png']);
  assert.equal(pathProblem('evidence/ok.md', 'text').toString(), 'evidence,ok.md');
});

test('ledung#160: never over a file that is there, nor a link at the name, dangling or not', (t) => {
  const wt = fresh('wt');
  fs.writeFileSync(path.join(wt, 'shot.png'), 'MINE');
  assert.throws(() => saveIntoWorktree(wt, 'shot.png', 'png', PNG, NO_RULES), /shot\.png already exists; Ledung never saves over a file/);
  assert.equal(fs.readFileSync(path.join(wt, 'shot.png'), 'utf8'), 'MINE', 'the file is untouched');
  fs.mkdirSync(path.join(wt, 'dir.png'));
  assert.throws(() => saveIntoWorktree(wt, 'dir.png', 'png', PNG, NO_RULES), /dir\.png already exists/);
  if (process.platform === 'win32') {
    t.diagnostic('file links need a privilege on Windows; the folder link tests cover links there');
  } else {
    const target = path.join(path.dirname(wt), `dangling-${n}.png`);
    fs.symlinkSync(target, path.join(wt, 'dangling.png'));
    assert.throws(() => saveIntoWorktree(wt, 'dangling.png', 'png', PNG, NO_RULES), /dangling\.png is a link/);
    assert.ok(!fs.existsSync(target), 'nothing written through the dangling link');
  }
  assert.deepEqual(filesIn(wt).filter((f) => f !== 'dangling.png'), ['shot.png'], 'nothing new');
});

test('ledung#160: a folder on the way that is a link or junction out of the worktree is refused; nothing lands outside', () => {
  const wt = fresh('wt');
  const outside = fresh('outside');
  fs.symlinkSync(outside, path.join(wt, 'evidence'), 'junction');
  assert.throws(() => saveIntoWorktree(wt, 'evidence/shot.png', 'png', PNG, NO_RULES), /evidence is a link; Ledung saves only into the worktree itself/);
  // One deeper, too: a real folder, then a link.
  fs.mkdirSync(path.join(wt, 'real'));
  fs.symlinkSync(outside, path.join(wt, 'real', 'out'), 'junction');
  assert.throws(() => saveIntoWorktree(wt, 'real/out/x/shot.png', 'png', PNG, NO_RULES), /real\/out is a link/);
  assert.deepEqual(filesIn(outside), [], 'nothing outside');
  assert.ok(!fs.existsSync(path.join(outside, 'x')), 'no folder made through the link');
  // A file where a folder should be.
  fs.writeFileSync(path.join(wt, 'plain.txt'), 'x');
  assert.throws(() => saveIntoWorktree(wt, 'plain.txt/shot.png', 'png', PNG, NO_RULES), /plain\.txt is not a folder/);
  // The positive branch: a real folder takes it.
  saveIntoWorktree(wt, 'real/shot.png', 'png', PNG, NO_RULES);
  assert.ok(fs.existsSync(path.join(wt, 'real', 'shot.png')));
});

// As the flow builder's writer is tested (files.test.ts, security review of PR #89, finding 4): the folder is swapped
// for a link after the first walk and before the file goes in place.
test('ledung#160: a folder swapped for a link between the check and the write is refused, and nothing is left outside or behind', () => {
  const wt = fresh('wt');
  const outside = fresh('outside');
  const evidence = path.join(wt, 'evidence');
  fs.mkdirSync(evidence);
  let swapped = false;
  assert.throws(() => saveIntoWorktree(wt, 'evidence/shot.png', 'png', PNG, NO_RULES, {
    beforePlace: () => {
      fs.renameSync(evidence, `${evidence}-old`);
      fs.symlinkSync(outside, evidence, 'junction');
      swapped = true;
    },
  }), /evidence is a link/);
  assert.ok(swapped, 'the swap ran');
  assert.deepEqual(filesIn(outside), [], 'nothing outside');
  assert.ok(!fs.existsSync(path.join(outside, 'shot.png')));
  assert.deepEqual(filesIn(wt).filter((f) => f !== 'evidence'), [], 'nothing in the worktree but the link: the temp file was taken away');
  assert.deepEqual(filesIn(`${evidence}-old`), []);
});

// The last check (review of PR #172): the swap comes after the second walk, so only where the file really landed shows
// it went through a link; it is taken away from there and the save refused.
test('ledung#160: a folder swapped for a link after the second check is caught where the file landed: refused, taken away, nothing left outside or behind', () => {
  const wt = fresh('wt');
  const outside = fresh('outside');
  const evidence = path.join(wt, 'evidence');
  fs.mkdirSync(evidence);
  let swapped = false;
  assert.throws(() => saveIntoWorktree(wt, 'evidence/shot.png', 'png', PNG, NO_RULES, {
    beforeLink: () => {
      fs.renameSync(evidence, `${evidence}-old`);
      fs.symlinkSync(outside, evidence, 'junction');
      swapped = true;
    },
  }), /^Error: evidence\/shot\.png was not saved: a folder on the way changed while it was written\.$/);
  assert.ok(swapped, 'the swap ran');
  assert.deepEqual(filesIn(outside), [], 'the file that went through the link was taken away again');
  assert.deepEqual(filesIn(wt).filter((f) => f !== 'evidence'), [], 'no temp file left');
  assert.deepEqual(filesIn(`${evidence}-old`), []);
  // The positive branch: the same save with no swap lands.
  const again = fresh('wt');
  fs.mkdirSync(path.join(again, 'evidence'));
  saveIntoWorktree(again, 'evidence/shot.png', 'png', PNG, NO_RULES, { beforeLink: () => {} });
  assert.deepEqual(filesIn(again), ['evidence/shot.png']);
});

test('ledung#160: a sensitive path pattern, the locked secrets\' folder and another locked project\'s folder are refused', () => {
  const wt = fresh('wt');
  const rules = { pathPatterns: ['private-notes', 'customer'], refused: [path.join(wt, 'island')] };
  assert.throws(() => saveIntoWorktree(wt, 'docs/private-notes/a.md', 'text', Buffer.from('x'), rules), /matches the sensitive path pattern \/private-notes\//);
  // Case-insensitive, as sensitive patterns are everywhere (src/board/address.ts).
  assert.throws(() => saveIntoWorktree(wt, 'Customer-List.txt', 'text', Buffer.from('x'), rules), /sensitive path pattern \/customer\//);
  assert.throws(() => saveIntoWorktree(wt, 'ledung-secrets-0123abcd/x.txt', 'text', Buffer.from('x'), rules), /where Ledung keeps locked secrets/);
  assert.throws(() => saveIntoWorktree(wt, 'island/shot.png', 'png', PNG, rules), /in a locked project's folder/);
  // A worktree inside a locked folder refuses every path (test review of PR #172, finding 2: the worktree must exist).
  fs.mkdirSync(path.join(wt, 'island'));
  assert.throws(() => saveIntoWorktree(path.join(wt, 'island'), 'x.png', 'png', PNG, { pathPatterns: [], refused: [wt] }), /^Error: x\.png is in a locked project's folder; Ledung saves no file there\.$/);
  assert.deepEqual(filesIn(wt), [], 'nothing written');
  saveIntoWorktree(wt, 'docs/public/a.md', 'text', Buffer.from('x'), rules);
  assert.deepEqual(filesIn(wt), ['docs/public/a.md'], 'the positive branch: a path no rule names is saved');
});

test('ledung#160: a locked folder spelled another way than on disk (another case, or an 8.3 name on Windows) is still refused', (t) => {
  const wt = fresh('wt');
  // The worktree's own name in another case, with a locked folder under it that isn't there yet: the JS real path keeps
  // the spelling as typed, as it keeps C:\\Users\\RUNNER~1 on Windows CI, where the writer's real path has the disk's.
  const other = path.join(path.dirname(wt), path.basename(wt).toUpperCase());
  if (!fs.existsSync(other) || fs.realpathSync(other) === fs.realpathSync.native(other)) {
    t.skip('this file system tells case apart, or its JS real path already gives the name on disk');
    return;
  }
  assert.throws(() => saveIntoWorktree(wt, 'island/shot.png', 'png', PNG, { pathPatterns: [], refused: [path.join(other, 'island')] }), /^Error: island\/shot\.png is in a locked project's folder; Ledung saves no file there\.$/);
  // And the other way round: the locked folder is there, the path typed in another case than it.
  fs.mkdirSync(path.join(wt, 'island'));
  assert.throws(() => saveIntoWorktree(wt, 'ISLAND/shot.png', 'png', PNG, { pathPatterns: [], refused: [path.join(wt, 'island')] }), /in a locked project's folder/);
  assert.deepEqual(filesIn(wt), [], 'nothing written');
});

// --- The tool, between two linked Ledungs ------------------------------------------------------------------------

const management = (node: Node) => (node.manager as unknown as { management: Management }).management;
const manager = (node: Node, id: string, project: string) => {
  node.store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
  node.store.updateSession(id, { status: 'idle' });
};
/** A worker under `parent` that moved itself into a worktree with EnterWorktree, as workers do (issue #225). */
const worker = (node: Node, id: string, project: string, parent: string, worktree: string) => {
  node.store.createSession({ id, project, runner: 'local', title: id, parentId: parent, permissionMode: 'default', role: 'session' });
  node.store.addMessage(id, 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'EnterWorktree', input: { name: path.basename(worktree) } }] } });
  node.store.addMessage(id, 'sdk', { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Created worktree at ${worktree} on branch worktree-${path.basename(worktree)}.` }] } });
};

/** A Mac and a PC, linked. The PC has Beta (with a worker in a worktree), Gamma, and Box, a container project. */
async function pair(tag: string, config: Record<string, unknown> = {}) {
  const alpha = fresh(`${tag}-alpha`);
  const beta = fresh(`${tag}-beta`);
  const gamma = fresh(`${tag}-gamma`);
  const common = { ...config, userName: 'Martin', browseRoots: [os.tmpdir()], sensitive: { commandPatterns: [], pathPatterns: ['private-notes'], mcpTools: [] } };
  const mac = await nodes.ledung(`mac-${tag}.save.test`, undefined, undefined, undefined, { ...common, projects: [{ name: 'Alpha', runner: 'local', path: alpha }] });
  const pc = await nodes.ledung(`pc-${tag}.save.test`, undefined, undefined, undefined, {
    ...common,
    projects: [
      { name: 'Beta', runner: 'local', path: beta },
      { name: 'Gamma', runner: 'local', path: gamma },
      { name: 'Box', runner: 'docker', container: 'box', pathInContainer: '/work' },
    ],
  });
  mac.manager.linkedFilesDir = () => path.join(base, `${tag}-mac-linked`);
  const pcFiles = path.join(base, `${tag}-pc-linked`);
  pc.manager.linkedFilesDir = () => pcFiles;
  await nodes.link(mac, pc, 'Mac');
  manager(mac, 'mac-alpha', 'Alpha');
  manager(pc, 'pc-beta', 'Beta');
  manager(pc, 'pc-gamma', 'Gamma');
  manager(pc, 'pc-box', 'Box');
  const worktree = path.join(beta, '.claude', 'worktrees', 'fix-1');
  fs.mkdirSync(worktree, { recursive: true });
  worker(pc, 'pc-worker', 'Beta', 'pc-beta', worktree);
  fs.writeFileSync(path.join(alpha, 'shot.png'), PNG);
  /** Sends shot.png from the Mac to the PC's manager `to`; the handle its message names. */
  const send = async (to: string): Promise<string> => {
    await management(mac).messageComputerManager('mac-alpha', `pc-${tag}`, to, 'A screenshot.', ['shot.png']);
    const text = pc.store.undeliveredInbox(to).at(-1)!.text;
    const handle = /"(linked:[0-9a-f]{16}\/shot\.png)"/.exec(text)?.[1];
    assert.ok(handle, text);
    return handle;
  };
  return { mac, pc, beta, worktree, pcFiles, send };
}

test('ledung#160: the PC manager saves a PNG from the Mac into its worker\'s worktree: same SHA-256, the worker reads it and its Files pane shows it; the answer gives path, size and SHA', { timeout: HANG_MS }, async () => {
  const p = await pair('save');
  const handle = await p.send('pc-beta');
  const out = management(p.pc).saveLinkedFile('pc-beta', handle, 'pc-worker', 'evidence/shot.png');
  const full = path.join(fs.realpathSync.native(p.worktree), 'evidence', 'shot.png');
  assert.equal(out, `Saved into "pc-worker"'s worktree: evidence/shot.png (${full}), ${PNG.length} bytes, SHA-256 ${sha(PNG)}. Tell the session that line; the file is its own now, Ledung doesn't remove it.`);
  assert.equal(sha(fs.readFileSync(full)), sha(PNG), 'the same bytes as were sent');
  assert.ok(!fs.existsSync(path.join(p.beta, 'evidence')), 'in the worktree it entered, not the project folder');
  // The worker reads it with the file viewer's rules, and its Files pane lists it in its worktree.
  const image = await p.pc.manager.readImage('pc-worker', 'evidence/shot.png', 'session');
  assert.equal(sha(image.bytes), sha(PNG));
  const shown = await nodes.local(p.pc, { path: `/api/sessions/pc-worker/image?path=${encodeURIComponent('evidence/shot.png')}&in=session`, headers: { cookie: COOKIE } });
  assert.equal(shown.status, 200);
  const listing = await p.pc.manager.listFolder('pc-worker', 'session', 'evidence');
  assert.ok(JSON.stringify(listing).includes('shot.png'), JSON.stringify(listing));
  // A second save to the same path is refused: never over a file.
  assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', handle, 'pc-worker', 'evidence/shot.png'), /Not saved: evidence\/shot\.png already exists/);
  // The trace line, once, in this run's data folder.
  const log = fs.readFileSync(path.join(process.env.LEDUNG_DATA_DIR!, 'exercised.log'), 'utf8');
  assert.equal(log.match(/EXERCISED #160 /g)?.length, 1, log);
});

test('ledung#160: refused with a reason and nothing written: not the manager\'s own session, another manager\'s file, a made-up handle, a hidden or outside path, a sensitive path', { timeout: HANG_MS }, async () => {
  const p = await pair('refuse');
  const handle = await p.send('pc-beta');
  const gammaHandle = await p.send('pc-gamma');
  const save = (by: string, h: string, session: string, rel: string) => () => management(p.pc).saveLinkedFile(by, h, session, rel);
  // A session another manager started.
  worker(p.pc, 'gamma-worker', 'Gamma', 'pc-gamma', fresh('gamma-wt'));
  assert.throws(save('pc-beta', handle, 'gamma-worker', 'x.png'), /Session gamma-worker is not one you started/);
  // The manager itself is not one of its sessions.
  assert.throws(save('pc-beta', handle, 'pc-beta', 'x.png'), /Session pc-beta is not one you started/);
  // A file sent to another manager, here or on another link: the copy is only the manager it was sent to.
  assert.throws(save('pc-beta', gammaHandle, 'pc-worker', 'x.png'), /Ledung has no file shot\.png from a linked computer for this session/);
  assert.throws(save('pc-beta', `linked:${'0'.repeat(16)}/shot.png`, 'pc-worker', 'x.png'), /Ledung has no file shot\.png from a linked computer for this session/);
  assert.throws(save('pc-beta', handle.replace('shot.png', 'other.png'), 'pc-worker', 'x.png'), /Ledung has no file other\.png/);
  // Paths: out of the worktree, absolute, hidden, sensitive, a link out.
  assert.throws(save('pc-beta', handle, 'pc-worker', '../../../escaped.png'), /Not saved: .*no empty, "\." or "\.\." part/);
  assert.throws(save('pc-beta', handle, 'pc-worker', path.join(p.beta, 'abs.png')), /Not saved: .*not a path inside the worktree/);
  assert.throws(save('pc-beta', handle, 'pc-worker', '.git/x.png'), /Not saved: .*hidden path/);
  assert.throws(save('pc-beta', handle, 'pc-worker', 'private-notes/x.png'), /Not saved: .*sensitive path pattern \/private-notes\//);
  const outside = fresh('outside');
  fs.symlinkSync(outside, path.join(p.worktree, 'out'), 'junction');
  assert.throws(save('pc-beta', handle, 'pc-worker', 'out/x.png'), /Not saved: out is a link/);
  assert.deepEqual(filesIn(outside), []);
  assert.deepEqual(filesIn(p.worktree).filter((f) => f !== 'out'), [], 'nothing in the worktree');
  assert.ok(!fs.existsSync(path.join(path.dirname(p.beta), 'escaped.png')));
  assert.ok(!fs.existsSync(path.join(p.beta, 'abs.png')));
  // The positive branch: the same handle, session and a plain path are saved.
  management(p.pc).saveLinkedFile('pc-beta', handle, 'pc-worker', 'shot.png');
  assert.deepEqual(filesIn(p.worktree).filter((f) => f !== 'out'), ['shot.png']);
});

test('ledung#160: a pruned copy, a project locked after the file came, and a container project are refused, and nothing is written', { timeout: HANG_MS }, async () => {
  const p = await pair('later', { board: { evidenceDays: 2 } });
  const [old, kept, boxed] = [await p.send('pc-beta'), await p.send('pc-beta'), await p.send('pc-box')];
  // Pruned: received three days ago with two evidence days (#158's prune).
  p.pc.db.prepare('UPDATE linked_files SET received_at = ? WHERE id = ?').run(Date.now() - 3 * 86400000, old.slice(7, 23));
  p.pc.manager.linkedFiles.prune(true);
  assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', old, 'pc-worker', 'old.png'), /^Error: shot\.png was pruned: copies from linked computers are kept for a limited number of days\.$/);
  // A container project: its worktree is inside the container.
  p.pc.store.createSession({ id: 'box-worker', project: 'Box', runner: 'docker', title: 'box-worker', parentId: 'pc-box', permissionMode: 'default', role: 'session' });
  assert.throws(() => management(p.pc).saveLinkedFile('pc-box', boxed, 'box-worker', 'shot.png'), /"box-worker" works in a container project; saving a file from a linked computer into a container is not available yet\. Nothing was saved\./);
  // The fresh copy is saved while Beta is open, then refused once Beta is locked: the level is read on each call.
  management(p.pc).saveLinkedFile('pc-beta', kept, 'pc-worker', 'before.png');
  const beta = (p.pc.manager as unknown as { projectStore: { get(n: string): { config: Record<string, unknown> } } }).projectStore.get('Beta').config;
  p.pc.manager.updateProject('Beta', { ...beta, lockdown: { level: 'A', board: false, remoteControl: false } } as never);
  assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', kept, 'pc-worker', 'after.png'), /Not saved: the project "Beta" is in lockdown; no file from a linked computer goes into it\./);
  assert.deepEqual(filesIn(p.worktree), ['before.png'], 'only the save made before the lock');
  // Level B as well, where it is offered (not on native Windows).
  if (process.platform !== 'win32') {
    p.pc.manager.updateProject('Beta', { ...beta, lockdown: { level: 'B', board: false, remoteControl: false } } as never);
    assert.throws(() => management(p.pc).saveLinkedFile('pc-beta', kept, 'pc-worker', 'after-b.png'), /Not saved: the project "Beta" is in lockdown level B \(nearly air-gapped\); no file from a linked computer goes into it\./);
    assert.deepEqual(filesIn(p.worktree), ['before.png']);
  }
});
