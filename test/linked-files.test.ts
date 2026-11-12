// Files between managers on linked computers (issue #158): message_manager with a computer carries up to five PNG, JPEG
// or text files from the manager's own folder, each on its own /link/file call before the message, with no hold for the
// person; the other computer checks each again, keeps a copy, and its manager gets images as "linked:" handles its
// questions and reviews take and text inline. Two real Ledungs here, each reaching the other over its tunnel with TLS
// ending in that Ledung, as the relay hands it a stream (linked-nodes.ts); the loopback with a real relay is
// test/loopback/link-files.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Secrets } from '../src/secrets/secrets.ts';
import type { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { LEDUNG_SERVER } from '../src/sessions/tools.ts';
import { shownFile } from '../src/shared/questions.ts';
import { COOKIE, keyFor, LinkedNodes, type Node } from './linked-nodes.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS } from './limits.ts';

const nodes = new LinkedNodes();
const temps: string[] = [];
after(async () => {
  await nodes.close();
  for (const t of temps) removeTemp(t);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
const temp = (what: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ledung-${what}-`)));
  temps.push(dir);
  return dir;
};
const management = (n: Node) => (n.manager as unknown as { management: Management }).management;
const manager = (n: Node, id: string, project: string) => {
  n.store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
  n.store.updateSession(id, { status: 'idle' });
};
const copies = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(png|jpg|txt)$/.test(f)) : []);

/**
 * A Mac and a PC, linked; each with an open project and a locked one (level A, or `locked`), and a manager for each.
 * `config`: more of both configs (board.evidenceDays).
 */
async function pair(tag: string, opts: { locked?: 'A' | 'B'; config?: Record<string, unknown> } = {}) {
  const level = opts.locked ?? 'A';
  const alpha = temp(`${tag}-alpha`);
  const beta = temp(`${tag}-beta`);
  const common = { ...opts.config, userName: 'Martin', browseRoots: [os.tmpdir()], sensitive: { commandPatterns: [], pathPatterns: ['private-notes'], mcpTools: [] } };
  const mac = await nodes.ledung(`mac-${tag}.files.test`, undefined, undefined, undefined, {
    ...common, projects: [{ name: 'Alpha', runner: 'local', path: alpha }, { name: 'Island', runner: 'local', path: temp(`${tag}-island`), lockdown: { level } }],
  });
  const pc = await nodes.ledung(`pc-${tag}.files.test`, undefined, undefined, undefined, {
    ...common, projects: [{ name: 'Beta', runner: 'local', path: beta }, { name: 'Fort', runner: 'local', path: temp(`${tag}-fort`), lockdown: { level } }],
  });
  const macFiles = temp(`${tag}-mac-linked`);
  const pcFiles = temp(`${tag}-pc-linked`);
  mac.manager.linkedFilesDir = () => macFiles;
  pc.manager.linkedFilesDir = () => pcFiles;
  await nodes.link(mac, pc, 'Mac');
  manager(mac, 'mac-alpha', 'Alpha');
  manager(mac, 'mac-island', 'Island');
  manager(pc, 'pc-beta', 'Beta');
  manager(pc, 'pc-fort', 'Fort');
  // The PC as the Mac names it: its public name's first part, as linking gives it (linked.ts, defaultName).
  const toPc = (from: string, to: string, text: string, files?: string[]) => management(mac).messageComputerManager(from, `pc-${tag}`, to, text, files);
  const bytes = async (n: Node) => ((await (await nodes.page(n))('GET', 'links')).json.links[0].files) as { today: { sent: number; received: number }; month: { sent: number; received: number } };
  return { mac, pc, alpha, beta, macFiles, pcFiles, toPc, bytes };
}

test('ledung#158: a PNG and a log go with a message to the other computer; its manager can show the image in a question and give the log as evidence; bytes are counted, nothing waits for Martin', { timeout: HANG_MS }, async () => {
  const p = await pair('send');
  fs.writeFileSync(path.join(p.alpha, 'shot.png'), PNG);
  // 4,504 characters: the first 4,000 inline, then a note that 504 more are in the file.
  const log = `${'a'.repeat(4000)}TAIL${'b'.repeat(500)}`;
  fs.writeFileSync(path.join(p.alpha, 'run.log'), log);
  const out = await p.toPc('mac-alpha', 'pc-beta', 'Screenshot and log attached.', ['shot.png', 'run.log']);
  assert.match(out, /^Sent to manager "Manager: Beta"\. \(on your computer "pc-send"\) With 2 file\(s\): shot\.png \(PNG, 1 KB\), run\.log \(text, 4 KB\)\.$/);

  const [item] = p.pc.store.undeliveredInbox('pc-beta');
  assert.ok(item, 'the message arrived');
  const text = item.text;
  assert.match(text, /^Message from manager "Manager: Alpha" \(mac-alpha\) of Alpha on your computer "Mac":\n\nScreenshot and log attached\./);
  const image = /- shot\.png \(PNG, 1 KB\): to show it to Martin, give ask_user's screenshots file "(linked:[0-9a-f]{16}\/shot\.png)"/.exec(text);
  const logLine = /- run\.log \(text, 4 KB\), in a review its evidence file "(linked:[0-9a-f]{16}\/run\.log)":\n```\na{4000}\n\[cut by Ledung: 504 more characters in the file\]\n```/.exec(text);
  assert.ok(image, text);
  assert.ok(logLine, text);
  assert.doesNotMatch(text, /TAIL/, 'inline text is cut at 4,000 characters');
  assert.match(text, /\(Answer with message_manager to mac-alpha, computer "Mac"\.\)$/);
  assert.equal(copies(p.pcFiles).length, 2, 'both copies kept on the PC');
  assert.deepEqual(copies(p.macFiles), [], 'nothing kept on the Mac');

  // ask_user on the PC takes the handle as a screenshot; the page shows it through that manager.
  const shots = management(p.pc).screenshots('pc-beta', [{ file: image[1]!, look_for: 'the screenshot' }], null);
  assert.equal(shots![0]!.path, image[1]);
  const shown = await nodes.local(p.pc, { path: `/api/sessions/pc-beta/image?path=${encodeURIComponent(image[1]!)}`, headers: { cookie: COOKIE } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/png');
  // The whole log as a review's evidence: accepted when asked, and read back whole for the review page.
  const evidence = management(p.pc).reviewEvidence('pc-beta', [{ file: logLine[1]!, caption: 'the log' }]);
  assert.deepEqual(evidence, [{ file: logLine[1], caption: 'the log', kind: 'text' }]);
  const q = p.pc.store.createQuestion({ sessionId: 'pc-beta', question: 'review', options: null, addressedTo: 'user', details: { title: 'T', tier: 'Process', review: { solving: 's', done: 'd', evidence } } });
  assert.equal(p.pc.manager.readEvidenceText(q.id, 0).content, log);

  // No question was asked on the Mac: a file to a linked computer is not held for Martin (question #598).
  assert.deepEqual(p.mac.store.listQuestions(), []);
  // Counted per link, on both sides; shown in Settings → Linked computers.
  const sent = PNG.length + Buffer.byteLength(log);
  assert.deepEqual(await p.bytes(p.mac), { today: { sent, received: 0 }, month: { sent, received: 0 } });
  assert.deepEqual(await p.bytes(p.pc), { today: { sent: 0, received: sent }, month: { sent: 0, received: sent } });
});

test('ledung#158: the reverse: a screenshot from a PC worker\'s worktree, sent by the PC\'s manager, goes into a question the Mac\'s manager asks', { timeout: HANG_MS }, async () => {
  const p = await pair('back');
  const worktree = path.join(p.beta, '.claude', 'worktrees', 'fix-1');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'cart.png'), PNG);
  await management(p.pc).messageComputerManager('pc-beta', 'Mac', 'mac-alpha', 'The worker\'s screenshot.', ['.claude/worktrees/fix-1/cart.png']);
  const [item] = p.mac.store.undeliveredInbox('mac-alpha');
  const handle = /"(linked:[0-9a-f]{16}\/cart\.png)"/.exec(item!.text)?.[1];
  assert.ok(handle, item!.text);
  assert.equal(management(p.mac).screenshots('mac-alpha', [{ file: handle, look_for: 'the cart' }], null)![0]!.path, handle);
  const shown = await nodes.local(p.mac, { path: `/api/sessions/mac-alpha/image?path=${encodeURIComponent(handle)}`, headers: { cookie: COOKIE } });
  assert.equal(shown.status, 200);
  // Only the manager it went to: another manager on the Mac can't name it.
  assert.throws(() => management(p.mac).screenshots('mac-island', [{ file: handle, look_for: 'x' }], null), /no file cart\.png from a linked computer for this session/);
});

test('ledung#158: what can\'t go is refused with the reason before anything is sent: outside the folder, .env, a sensitive path, a locked secret, a sixth file, too large', { timeout: HANG_MS }, async () => {
  const p = await pair('refuse');
  fs.writeFileSync(path.join(p.alpha, 'ok.png'), PNG);
  fs.writeFileSync(path.join(path.dirname(p.alpha), 'outside.png'), PNG);
  fs.writeFileSync(path.join(p.alpha, '.env'), 'X=1');
  fs.mkdirSync(path.join(p.alpha, 'private-notes'));
  fs.writeFileSync(path.join(p.alpha, 'private-notes', 'a.png'), PNG);
  fs.writeFileSync(path.join(p.alpha, 'secret.log'), 'the password is hunter2-linked-files\n');
  // A key file saved under a name text may have: stopped by the token check, not by its kind (test review of #162, 1).
  fs.writeFileSync(path.join(p.alpha, 'key.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(p.alpha, 'big.png'), Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
  fs.writeFileSync(path.join(p.alpha, 'big.log'), 'x'.repeat(512 * 1024 + 1));
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(p.alpha, `n${i}.log`), `file ${i}`);
  p.mac.manager.attachSecrets(Secrets.memory(), temp('refuse-secrets'));
  await (p.mac.manager as unknown as { secrets: Secrets }).secrets.add({ sessionId: 'mac-alpha', project: 'Alpha' }, 'db', 'hunter2-linked-files', 'session');

  const cases: [string[], RegExp][] = [
    [['ok.png', '../outside.png'], /Not sent: attachment \.\.\/outside\.png: Only files inside the project folder/],
    [['.env'], /Not sent: attachment \.env: .*only PNG and JPEG images and \.txt, \.log or \.md/],
    [['private-notes/a.png'], /Not sent: attachment private-notes\/a\.png: .*sensitive path pattern \/private-notes\//],
    [['secret.log'], /Not sent: attachment secret\.log contains a secret locked in Ledung/],
    [['key.txt'], /Not sent: attachment key\.txt contains what looks like a private key/],
    [['n1.log', 'n2.log', 'n3.log', 'n4.log', 'n5.log', 'n6.log'], /Not sent: at most 5 files per message, and this one has 6/],
    [['big.png'], /Not sent: attachment big\.png: big\.png is too large/],
    [['big.log'], /Not sent: attachment big\.log: big\.log is too large .*at most 512 KB/],
  ];
  for (const [files, reason] of cases) {
    await assert.rejects(p.toPc('mac-alpha', 'pc-beta', 'hi', files), reason, files.join(' '));
  }
  // Nothing went: no message, no copy, no bytes, on either side. The same probes see a send that works.
  assert.deepEqual(p.pc.store.undeliveredInbox('pc-beta'), []);
  assert.deepEqual(copies(p.pcFiles), []);
  assert.equal((await p.bytes(p.mac)).today.sent, 0);
  await p.toPc('mac-alpha', 'pc-beta', 'hi', ['ok.png']);
  assert.equal(p.pc.store.undeliveredInbox('pc-beta').length, 1);
  assert.equal(copies(p.pcFiles).length, 1);
  assert.equal((await p.bytes(p.mac)).today.sent, PNG.length);
});

test('ledung#158: no files to or from a locked project; offline fails at once and leaves nothing on either side', { timeout: HANG_MS }, async () => {
  const p = await pair('lock');
  fs.writeFileSync(path.join(p.alpha, 'ok.png'), PNG);
  const island = (p.mac.manager.projectStore.get('Island')!.config as { path: string }).path;
  fs.writeFileSync(path.join(island, 'ok.png'), PNG);
  // From a locked project (A): refused at the sender.
  await assert.rejects(p.toPc('mac-island', 'pc-beta', 'hi', ['ok.png']), /Not sent: the project "Island" is locked, so its manager sends no files to other computers/);
  // To a locked project (A): the PC refuses the file, so nothing is kept there and the message is not sent.
  await assert.rejects(p.toPc('mac-alpha', 'pc-fort', 'hi', ['ok.png']), /answered 403: No files go to or from a locked project/);
  assert.deepEqual(p.pc.store.undeliveredInbox('pc-fort'), []);
  assert.deepEqual(copies(p.pcFiles), []);

  // The PC off the relay: the offline sentence at once, nothing kept on either side, nothing counted.
  nodes.offline(p.pc.name);
  const t0 = Date.now();
  await assert.rejects(p.toPc('mac-alpha', 'pc-beta', 'hi', ['ok.png']), /pc-lock\.files\.test is offline \(its Ledung is not connected to the relay\)\./);
  assert.ok(Date.now() - t0 < 5000, 'at once, not after the file call\'s time limit');
  assert.deepEqual(copies(p.pcFiles), []);
  assert.deepEqual(copies(p.macFiles), []);
  assert.deepEqual(p.pc.store.undeliveredInbox('pc-beta'), []);
  assert.equal((await p.bytes(p.mac)).today.sent, 0);
});

/** One /link/file call through the tunnel, raw bytes, as another computer or a stranger would send it. */
function sendFile(nodeName: string, query: Record<string, string>, bytes: Buffer, key?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', path: `/link/file?${new URLSearchParams(query)}`, createConnection: () => nodes.connect(nodeName),
      headers: { host: nodeName, 'content-type': 'application/octet-stream', 'content-length': bytes.length, ...(key ? { authorization: `Bearer ${key}` } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    // A refusal before the whole body is sent may end the request early; the answer still counts.
    req.on('error', (e) => (bytes.length > 1024 * 1024 ? undefined : reject(e)));
    req.end(bytes);
  });
}

test('ledung#158: /link/file needs a link key, checks the hash, kind and size, and its own body limit; a message can\'t claim another link\'s or manager\'s file', { timeout: HANG_MS }, async () => {
  const p = await pair('route');
  const key = keyFor(p.mac, p.pc);
  const sha = crypto.createHash('sha256').update(PNG).digest('hex');
  const q = { to: 'pc-beta', name: 'x.png', kind: 'png', size: String(PNG.length), sha };
  assert.equal((await sendFile(p.pc.name, q, PNG)).status, 401, 'no key');
  assert.equal((await sendFile(p.pc.name, q, PNG, 'A'.repeat(43))).status, 401, 'a wrong key');
  const wrong = await sendFile(p.pc.name, { ...q, sha: 'e'.repeat(64) }, PNG, key);
  assert.equal(wrong.status, 400);
  assert.match(JSON.parse(wrong.body).error, /content is not what/);
  assert.equal((await sendFile(p.pc.name, { ...q, kind: 'jpeg' }, PNG, key)).status, 400, 'not the kind it says');
  assert.equal((await sendFile(p.pc.name, { ...q, to: 'nobody' }, PNG, key)).status, 400, 'not a manager there');
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  assert.equal((await sendFile(p.pc.name, { ...q, size: String(big.length) }, big, key)).status, 413, 'over its own limit');
  assert.deepEqual(copies(p.pcFiles), [], 'none of those kept');
  // The positive branch of the same probe: the right call is kept, pending until a message claims it.
  const ok = await sendFile(p.pc.name, q, PNG, key);
  assert.equal(ok.status, 200, ok.body);
  const id = JSON.parse(ok.body).id as string;
  assert.equal(copies(p.pcFiles).length, 1);
  // A message to another manager can't claim it, and that refusal drops the file: nothing of it is left.
  const other = await nodes.viaTunnel(p.pc.name, '/link/message', { headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ fromId: 'mac-alpha', toId: 'pc-fort', text: 'hi', files: [id] }) });
  assert.equal(other.status, 400);
  assert.deepEqual(copies(p.pcFiles), []);
});

const notOnWindows = { skip: process.platform === 'win32' ? 'level B is not offered on native Windows' : false };

test('ledung#158: lockdown B: the receiving computer keeps no file for a B project, and a B project\'s manager sends none', { timeout: HANG_MS, ...notOnWindows }, async () => {
  const p = await pair('lockb', { locked: 'B' });
  fs.writeFileSync(path.join(p.alpha, 'ok.png'), PNG);
  const island = (p.mac.manager.projectStore.get('Island')!.config as { path: string }).path;
  fs.writeFileSync(path.join(island, 'ok.png'), PNG);
  // To a B project: refused at /link/file, before anything is kept there.
  const key = keyFor(p.mac, p.pc);
  const sha = crypto.createHash('sha256').update(PNG).digest('hex');
  const refused = await sendFile(p.pc.name, { to: 'pc-fort', name: 'ok.png', kind: 'png', size: String(PNG.length), sha }, PNG, key);
  assert.equal(refused.status, 403);
  assert.match(JSON.parse(refused.body).error, /No files go to or from a locked project/);
  await assert.rejects(p.toPc('mac-alpha', 'pc-fort', 'hi', ['ok.png']), /answered 403: No files go to or from a locked project/);
  assert.deepEqual(copies(p.pcFiles), []);
  // From a B project: its manager reaches no other computer at all.
  await assert.rejects(p.toPc('mac-island', 'pc-beta', 'hi', ['ok.png']), /lockdown level B \(nearly air-gapped\)/);
  assert.equal((await p.bytes(p.mac)).today.sent, 0);
  assert.deepEqual(p.pc.store.undeliveredInbox('pc-beta'), []);
  // The positive branch of the same probes: an open project gets the file.
  await p.toPc('mac-alpha', 'pc-beta', 'hi', ['ok.png']);
  assert.equal(copies(p.pcFiles).length, 1);
  assert.equal((await p.bytes(p.mac)).today.sent, PNG.length);
});

test('ledung#158: copies are pruned after the config\'s board.evidenceDays, read by the manager', { timeout: HANG_MS }, async () => {
  const p = await pair('prune', { config: { board: { evidenceDays: 2 } } });
  fs.writeFileSync(path.join(p.alpha, 'a.png'), PNG);
  fs.writeFileSync(path.join(p.alpha, 'b.log'), 'kept');
  await p.toPc('mac-alpha', 'pc-beta', 'two files', ['a.png', 'b.log']);
  const text = p.pc.store.undeliveredInbox('pc-beta')[0]!.text;
  const [old, fresh] = [/"(linked:[0-9a-f]{16}\/a\.png)"/, /"(linked:[0-9a-f]{16}\/b\.log)"/].map((re) => re.exec(text)![1]!) as [string, string];
  // One received three days ago, one a day ago: with 2 evidence days only the first goes (the default 30 keeps both).
  const day = 86400000;
  p.pc.db.prepare('UPDATE linked_files SET received_at = ? WHERE id = ?').run(Date.now() - 3 * day, old.slice(7, 23));
  p.pc.db.prepare('UPDATE linked_files SET received_at = ? WHERE id = ?').run(Date.now() - 1 * day, fresh.slice(7, 23));
  p.pc.manager.linkedFiles.prune(true);
  assert.throws(() => management(p.pc).screenshots('pc-beta', [{ file: old, look_for: 'x' }], null), /was pruned/);
  assert.equal(management(p.pc).reviewEvidence('pc-beta', [{ file: fresh, caption: 'c' }])[0]!.kind, 'text', 'one day old: kept');
  assert.equal(copies(p.pcFiles).length, 1);
});

// Issue #306 (test review of PR #307, finding 2): a linked computer's file given to ask_user is kept as the question's
// own copy, as WebP, so the question still shows it once the linked copy is pruned (after evidenceDays).
test("ledung#306: a linked computer's screenshot given to ask_user is kept as Ledung's own copy and shown after the linked copy is gone", { timeout: HANG_MS }, async () => {
  const p = await pair('keep');
  const shot = fs.readFileSync(new URL('../docs/steps/pinned-message-226/menu-wide-after-dark.png', import.meta.url));
  fs.writeFileSync(path.join(p.alpha, 'shot.png'), shot);
  await p.toPc('mac-alpha', 'pc-beta', 'A screenshot.', ['shot.png']);
  const handle = /give ask_user's screenshots file "(linked:[0-9a-f]{16}\/shot\.png)"/.exec(p.pc.store.undeliveredInbox('pc-beta')[0]!.text)?.[1];
  assert.ok(handle, 'the PC manager got a linked: handle');
  const kept = temp('keep-copies');
  p.pc.manager.containerCopiesDir = () => kept;

  // The real chain on the PC: the manager's own ask_user tool → Session.ask → Management → the session manager.
  const session = new Session({
    info: p.pc.store.getSession('pc-beta')!, store: p.pc.store, publish: () => {}, userName: 'Martin', management: management(p.pc),
    runner: { cwd: p.beta, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const ask = (options.mcpServers![LEDUNG_SERVER] as unknown as {
    instance: { _registeredTools: Record<string, { handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  }).instance._registeredTools.ask_user!;
  const asked = await ask.handler({ question: 'Does it show?', tier: 'Process', screenshots: [{ file: handle, look_for: 'the menu' }] }, {});
  assert.equal(asked.isError, undefined, asked.content[0]!.text);
  const stored = p.pc.store.listQuestions().find((q) => q.sessionId === 'pc-beta')!.shots![0]!.path;
  assert.match(stored, /^kept:[0-9a-f]{32}\/linked: shot\.png$/);
  // It keeps its mark where it is shown (Martin, Ledung question #2148: "a — Keep the mark"), as the linked copy did.
  assert.equal(shownFile(stored), 'linked: shot.png');
  assert.equal(shownFile(handle), 'linked: shot.png');
  const served = () => nodes.local(p.pc, { path: `/api/sessions/pc-beta/image?path=${encodeURIComponent(stored)}`, headers: { cookie: COOKIE } });
  const before = await served();
  assert.equal(before.status, 200);
  assert.equal(before.headers['content-type'], 'image/webp');

  // The linked copy goes (pruned after evidenceDays; here removed): the handle no longer shows, the kept copy does.
  assert.equal(copies(p.pcFiles).length, 1);
  for (const f of copies(p.pcFiles)) fs.rmSync(path.join(p.pcFiles, f));
  const viaHandle = await nodes.local(p.pc, { path: `/api/sessions/pc-beta/image?path=${encodeURIComponent(handle)}`, headers: { cookie: COOKIE } });
  assert.notEqual(viaHandle.status, 200, 'the linked copy itself is gone');
  const after = await served();
  assert.equal(after.status, 200);
  assert.equal(after.headers['content-type'], 'image/webp');
  assert.equal(after.body, before.body);
});
