// The relay's byte cap (issue #161) for streamed files (#159), issue #177: while the relay says this computer's owner is
// past their monthly cap, its Ledung offers no streamed file and serves none (the send side, with #161's "Not sent"
// sentence), and takes none to pull nor starts, resumes or goes on pulling one (the receive side, "Not kept"); nothing
// is fetched or kept. Once the cap is lifted, both go again without a restart. Two real Ledungs linked over their
// tunnels, as in stream-files.test.ts; the cap is what the tunnel hands the server when the relay's status says so, as
// in relay-cap-ledung.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline, Transform } from 'node:stream';
import type { Management } from '../src/sessions/management.ts';
import type { LinkedComputers } from '../src/remote/linked.ts';
import { relayCapSentence } from '../src/remote/tunnel.ts';
import { LinkedNodes, type Node } from './linked-nodes.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

const nodes = new LinkedNodes();
const temps: string[] = [];
// This run's own data folder, so the EXERCISED line goes to exercised.log there, never to the real Ledung's.
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-cap-stream-')));
temps.push(dataDir);
process.env.LEDUNG_DATA_DIR = dataDir;
after(async () => {
  await nodes.close();
  for (const t of temps) removeTemp(t);
});

const RESETS = '2026-12-01';
const SENT = relayCapSentence(RESETS, true);
const KEPT = relayCapSentence(RESETS, false);

const temp = (what: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ledung-cap-${what}-`)));
  temps.push(dir);
  return dir;
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const management = (n: Node) => (n.manager as unknown as { management: Management }).management;
const linkedOf = (n: Node) => (n.server as unknown as { linked: LinkedComputers }).linked;
const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : []);
/** What the tunnel hands the server when the relay's status message says the owner is capped, or not. */
const capped = (n: Node, resetsOn: string | null) => n.server.setRemote({ state: 'connected', publicName: n.name, error: null, ...(resetsOn ? { relayCap: { resetsOn } } : {}) });

/** A WAV file's header (RIFF … WAVE) and `bytes` of random sound, so the SHA-256 tells every byte. */
function wav(bytes: number): Buffer {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(bytes + 4, 4);
  head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, crypto.randomBytes(bytes)]);
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

/**
 * The PC's calls for a streamed file's bytes, recorded by where each asked from; `onChunk` sees each chunk as it comes
 * (the bytes seen so far with it) and may cut the connection by returning an Error: the network, not the code under test.
 */
function watch(n: Node, onChunk?: (seen: number, call: number) => Error | void) {
  const linked = linkedOf(n);
  const real = linked.fetchStream.bind(linked);
  const asked: number[] = [];
  linked.fetchStream = async (id, route, query, from, idle) => {
    asked.push(from);
    const call = asked.length;
    const got = await real(id, route, query, from, idle);
    if (!onChunk) return got;
    let seen = 0;
    // Piped, not a 'data' listener: one of those would start the body flowing before the fetch reads it.
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        const cut = onChunk(seen, call);
        if (!cut) return done(null, chunk);
        got.body.destroy();
        done(cut);
      },
    });
    // pipeline, not pipe: a body the sender cuts off must end the tap with its error, as it would end the real body.
    pipeline(got.body, tap, () => {});
    return { body: tap as unknown as typeof got.body, start: got.start };
  };
  return asked;
}

/** A Mac and a PC, linked, a manager on each; `take.wav` (3 MB unless said) in the Mac's project. */
async function pair(tag: string, mb = 3) {
  const alpha = temp(`${tag}-alpha`);
  const common = { userName: 'Martin', browseRoots: [os.tmpdir()] };
  const mac = await nodes.ledung(`mac-${tag}.capstream.test`, undefined, undefined, undefined, { ...common, projects: [{ name: 'Alpha', runner: 'local', path: alpha }] });
  const pc = await nodes.ledung(`pc-${tag}.capstream.test`, undefined, undefined, undefined, { ...common, projects: [{ name: 'Beta', runner: 'local', path: temp(`${tag}-beta`) }] });
  const dirs = { macFiles: temp(`${tag}-mac-linked`), pcFiles: temp(`${tag}-pc-linked`), macOutbox: temp(`${tag}-mac-outbox`), pcOutbox: temp(`${tag}-pc-outbox`) };
  mac.manager.linkedFilesDir = () => dirs.macFiles;
  pc.manager.linkedFilesDir = () => dirs.pcFiles;
  mac.manager.linkedOutboxDir = () => dirs.macOutbox;
  pc.manager.linkedOutboxDir = () => dirs.pcOutbox;
  await nodes.link(mac, pc, 'Mac');
  for (const [n, id, project] of [[mac, 'mac-alpha', 'Alpha'], [pc, 'pc-beta', 'Beta']] as const) {
    n.store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
    n.store.updateSession(id, { status: 'idle' });
  }
  management(pc).fetchOptions = { backoffMs: 10 };
  const sound = wav(mb * 1024 * 1024);
  fs.writeFileSync(path.join(alpha, 'take.wav'), sound);
  const toPc = (text: string) => management(mac).messageComputerManager('mac-alpha', `pc-${tag}`, 'pc-beta', text, ['take.wav']);
  const inbox = () => pc.store.undeliveredInbox('pc-beta').map((i) => i.text);
  const outboxRows = () => (mac.db.prepare('SELECT COUNT(*) AS n FROM linked_outbox').get() as { n: number }).n;
  const arrived = () => inbox().find((t) => /^Ledung: take\.wav .* is here, its size and SHA-256 checked/.test(t));
  const failed = () => inbox().find((t) => /^Ledung: take\.wav .* could not be fetched: /.test(t));
  const copyOk = () => filesIn(dirs.pcFiles).some((f) => f.endsWith('.wav') && sha(fs.readFileSync(path.join(dirs.pcFiles, f))) === sha(sound));
  const nothingKept = () => filesIn(dirs.pcFiles).filter((f) => f.endsWith('.wav') || f.endsWith('.part'));
  return { mac, pc, ...dirs, sound, toPc, inbox, outboxRows, arrived, failed, copyOk, nothingKept };
}

/** The line the PC's manager gets when a pull ends with `problem`, a sentence whose own full stop ends that part. */
const failLine = (problem: string, mb = 3) => `Ledung: take.wav (WAV audio, ${mb}.0 MB) from your computer "Mac" could not be fetched: ${problem} Nothing of it is kept here; ask that manager to send it again.`;

test('ledung#177: a capped sender offers no streamed file (#161\'s sentence, no snapshot, no message); lifted, the same file goes and arrives', { timeout: HANG_MS }, async () => {
  const p = await pair('offer');
  capped(p.mac, RESETS);
  await assert.rejects(p.toPc('sound'), (e: Error) => e.message === SENT || assert.fail(e.message));
  assert.equal(p.outboxRows(), 0, 'nothing snapshotted or offered');
  assert.deepEqual(filesIn(p.macOutbox), [], 'no snapshot on disk');
  assert.deepEqual(p.inbox(), [], 'the message with it did not go');

  // The positive branch: the cap lifted, the same call offers it and the PC pulls it whole.
  capped(p.mac, null);
  assert.match(await p.toPc('sound'), /With 1 file\(s\): take\.wav \(WAV audio, 3\.0 MB, fetched from here by that computer\)/);
  await until(p.arrived, 'the file to arrive after the lift');
  assert.ok(p.copyOk(), 'the copy has the SHA-256 sent');
});

test('ledung#177: a capped receiver takes no streamed file to pull ("Not kept", back to the sender, whose offer is dropped); lifted, it does', { timeout: HANG_MS }, async () => {
  const p = await pair('take');
  const asked = watch(p.pc);
  capped(p.pc, RESETS);
  await assert.rejects(p.toPc('sound'), (e: Error) => e.message.endsWith(`answered 429: ${KEPT}`) || assert.fail(e.message));
  assert.equal(p.outboxRows(), 0, 'the sender dropped its offer again');
  assert.deepEqual(p.inbox(), [], 'no message arrived');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(asked, [], 'nothing was pulled');
  assert.deepEqual(p.nothingKept(), [], 'nothing kept');

  capped(p.pc, null);
  await p.toPc('sound');
  await until(p.arrived, 'the file to arrive after the lift');
  assert.ok(p.copyOk());
  assert.equal(asked[0], 0, 'pulled once lifted');
});

test('ledung#177: a pull cut off while the receiver became capped is not resumed: no second call, the manager told with the sentence, no part kept', { timeout: HANG_MS }, async () => {
  const p = await pair('resume');
  // The connection drops after a megabyte, and the relay's cap arrives in that moment.
  const asked = watch(p.pc, (seen, call) => {
    if (call !== 1 || seen <= 1024 * 1024) return;
    capped(p.pc, RESETS);
    return new Error('connection reset');
  });
  await p.toPc('sound');
  assert.equal(await until(p.failed, 'the refusal line'), failLine(KEPT));
  assert.deepEqual(asked, [0], 'not resumed: one call only');
  assert.deepEqual(p.nothingKept(), [], 'the part is gone');

  capped(p.pc, null);
  await p.toPc('again');
  await until(p.arrived, 'the next file to arrive after the lift');
  assert.ok(p.copyOk());
  const log = fs.readFileSync(path.join(dataDir, 'exercised.log'), 'utf8');
  assert.equal(log.match(/EXERCISED #177 /g)?.length, 1, log);
});

test('ledung#177: a receiver capped mid-pull stops at the next chunk, with the sentence, and keeps nothing', { timeout: HANG_MS }, async () => {
  const p = await pair('midpull');
  // The cap arrives once a megabyte is in; the bytes keep coming.
  const asked = watch(p.pc, (seen, call) => {
    if (call === 1 && seen > 1024 * 1024) capped(p.pc, RESETS);
  });
  await p.toPc('sound');
  assert.equal(await until(p.failed, 'the refusal line'), failLine(KEPT));
  assert.deepEqual(asked, [0]);
  assert.equal(p.arrived(), undefined, 'not delivered');
  assert.deepEqual(p.nothingKept(), [], 'no part, no copy');

  capped(p.pc, null);
  await p.toPc('again');
  await until(p.arrived, 'the next file to arrive after the lift');
  assert.ok(p.copyOk());
});

test('ledung#177: a sender capped after its offer serves none of it (403 with its sentence, at once); lifted, it serves', { timeout: HANG_MS }, async () => {
  const p = await pair('serve');
  const linked = linkedOf(p.pc);
  const real = linked.fetchStream.bind(linked);
  const asked: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  // The PC's first call held until the Mac's cap is on: the cap arriving between the offer and the pull.
  linked.fetchStream = async (id, route, query, from, idle) => {
    asked.push(from);
    if (asked.length === 1) await held;
    return real(id, route, query, from, idle);
  };
  await p.toPc('sound');
  capped(p.mac, RESETS);
  release();
  assert.equal(await until(p.failed, 'the refusal line'), failLine(`${p.mac.name} answered 403: ${SENT}`));
  assert.deepEqual(asked, [0], 'refused for good, not tried again');
  assert.deepEqual(p.nothingKept(), []);

  capped(p.mac, null);
  await p.toPc('again');
  await until(p.arrived, 'the next file to arrive after the lift');
  assert.ok(p.copyOk());
});

test('ledung#177: a sender capped while it serves stops within a mebibyte; the receiver keeps nothing', { timeout: HANG_MS }, async () => {
  const p = await pair('midserve', 8);
  // The Mac's cap arrives once the PC has its first bytes; the Mac has read at most a little ahead of them.
  const asked = watch(p.pc, (seen, call) => {
    if (call === 1 && seen > 0) capped(p.mac, RESETS);
  });
  await p.toPc('sound');
  const line = await until(p.failed, 'the refusal line');
  // Cut off mid-stream by the Mac, then refused at the start of the resume, with the Mac's sentence.
  assert.equal(line, failLine(`${p.mac.name} answered 403: ${SENT}`, 8));
  assert.equal(asked.length, 2, `asked from ${asked.join(', ')}`);
  assert.ok(asked[1]! > 0 && asked[1]! < p.sound.length, `the resume asked from where the cut left it: ${asked[1]}`);
  assert.deepEqual(p.nothingKept(), []);
});

