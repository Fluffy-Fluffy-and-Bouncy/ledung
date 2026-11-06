// Loopback for issue #159: managers (Haiku) on two linked throwaway Ledungs behind a real relay, and a 200 MB WAV
// streamed between them by handle. The Mac's manager sends the WAV and a zip; the PC's manager is told their handles at
// once, the PC pulls them from the Mac's outbox, and a Ledung line tells it when they are here. While the WAV crosses,
// both Ledungs' memory (RSS) and their pages' answer times are sampled; the Mac is restarted once and the PC once, and
// the fetch resumes from its part each time. Then: the SHA-256 of the copy, the bytes in Settings, the PC manager's
// ask_user refused with save_linked_file named, and a zip with a .env refused at the Mac naming the entry. Not in CI
// (two Ledungs, 600 MB of disk for a while, a few Haiku turns).
//
//   node test/loopback/link-streams.ts              # ports 4398 and 4399
//   SIZE_MB=50 node test/loopback/link-streams.ts   # a smaller file
//
// The two Ledungs, the relay and the front: linked-pair.ts. Logs land in .test/link-streams; the large files are
// deleted at the end, pass or fail.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { check, failed, link, type Page, repo, startPair, until } from './linked-pair.ts';

const work = path.join(repo, '.test', 'link-streams');
const TURN_MS = 240_000;
const SIZE = Number(process.env.SIZE_MB ?? 200) * 1024 * 1024;

/** A zip by the format: stored or deflated entries (as test/stream-files.test.ts builds them). */
function zip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(zlib.crc32(e.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(e.deflate ? 8 : 0, 10);
    dir.writeUInt32LE(zlib.crc32(e.data), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** A WAV of `bytes` random sound, written a megabyte at a time; its SHA-256. */
function writeWav(file: string, bytes: number): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'w');
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE((bytes + 4) >>> 0, 4);
  head.write('WAVE', 8, 'latin1');
  fs.writeSync(fd, head);
  hash.update(head);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let left = bytes; left > 0; left -= chunk.length) {
    const part = chunk.subarray(0, Math.min(chunk.length, left));
    crypto.randomFillSync(part);
    fs.writeSync(fd, part);
    hash.update(part);
  }
  fs.closeSync(fd);
  return hash.digest('hex');
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(c as Buffer);
  return hash.digest('hex');
}

// A session's history as plain text: quotes inside nested JSON (tool results) come out escaped once or twice.
const messages = async (page: Page, id: string) => JSON.stringify((await page.api('GET', `sessions/${id}/messages?limit=500`)).json).replace(/\\+"/g, '"').replace(/\\+n/g, '\n');
const idle = (page: Page, id: string, what: string) => until(async () => ((await page.api('GET', 'state')).json.sessions as { id: string; status: string }[]).find((s) => s.id === id)?.status === 'idle', what, TURN_MS);
const filesOf = async (page: Page) => (await page.api('GET', 'links')).json.links[0].files as { today: { sent: number; received: number } };
/** The PC's copy of a WAV, or its part while it comes: the largest .wav or .wav.part under linked-files. */
function pcWav(data: string): { file: string; size: number; part: boolean } | null {
  const dir = path.join(data, 'linked-files');
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.wav(\.part)?$/.test(f))
    .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size, part: f.endsWith('.part') }));
  return hits.sort((a, b) => b.size - a.size)[0] ?? null;
}
const rssMb = (pid: number | undefined): number | null => {
  if (!pid) return null;
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
  } catch {
    return null;
  }
};

async function main(): Promise<void> {
  const project = (name: string) => ({ name, runner: 'local', path: path.join(work, `project-${name}`), model: 'haiku', managerModel: 'haiku', permissionMode: 'default' });
  const pair = await startPair(work, { mac: [project('Alpha')], pc: [project('Beta')] }, { ports: { mac: 4398, pc: 4399 } });
  const { mac, pc } = pair.pages;
  const alphaDir = path.join(work, 'project-Alpha');
  const bigWav = path.join(alphaDir, 'big.wav');
  try {
    const t0 = Date.now();
    const soundSha = writeWav(bigWav, SIZE - 12);
    const archive = zip([{ name: 'notes/readme.md', data: Buffer.from('# Notes\nnothing secret here\n'), deflate: true }, { name: 'data.bin', data: Buffer.concat([Buffer.alloc(8), crypto.randomBytes(4000)]) }]);
    fs.writeFileSync(path.join(alphaDir, 'bundle.zip'), archive);
    fs.writeFileSync(path.join(alphaDir, 'bad.zip'), zip([{ name: 'notes/readme.md', data: Buffer.from('fine') }, { name: 'config/.env', data: Buffer.from('API_KEY=x') }]));
    console.log(`(a ${SIZE / 1048576} MB WAV written in ${Math.round((Date.now() - t0) / 1000)} s)`);

    console.log('== 1. Link, and start the PC\'s manager ==');
    await link(pair.pages);
    check(true, 'linked through the relay');
    const beta = (await pc.api('POST', 'projects/Beta/manager', {
      text: 'Test manager in a Ledung loopback. Reply with the single word "ready" and stop. Later a manager on another computer sends you a WAV file and a zip. Wait until a line from Ledung says the WAV file "is here". Then call ask_user exactly once, with tier "Record only", title "Sound", question "Does it play?", and screenshots [{"file": <the WAV\'s linked: name from that line, exactly>, "look_for": "the sound"}]. It is expected to fail: quote the tool\'s answer exactly and stop. Use no other tools.',
    })).json;
    await idle(pc, beta.id, 'Beta to be ready');
    check(true, 'Beta is idle', beta.id);

    console.log(`== 2. The Mac's manager sends a ${SIZE / 1048576} MB WAV and a zip ==`);
    const base = { mac: rssMb(pair.ledungs.mac.pid)!, pc: rssMb(pair.ledungs.pc.pid)! };
    console.log(`(RSS before: Mac ${base.mac.toFixed(0)} MB, PC ${base.pc.toFixed(0)} MB)`);
    // Sampled from before the send: memory per process, and how long each page takes to answer.
    const peak = { mac: 0, pc: 0 };
    // Each process against its own start: the first two from before the send, a restarted one from its first sample.
    const pidBase = new Map<number, number>([[pair.ledungs.mac.pid!, base.mac], [pair.ledungs.pc.pid!, base.pc]]);
    let slowest = { mac: 0, pc: 0 };
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        for (const n of ['mac', 'pc'] as const) {
          const pid = pair.ledungs[n].pid;
          const rss = rssMb(pid);
          // A restarted process counts once it is up (its baseline taken then, below), not while it starts.
          if (pid && rss !== null && pidBase.has(pid)) peak[n] = Math.max(peak[n], rss - pidBase.get(pid)!);
          const at = Date.now();
          const ok = await pair.pages[n].api('GET', 'state').then(() => true, () => false);
          if (ok) slowest = { ...slowest, [n]: Math.max(slowest[n], Date.now() - at) };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    /** Watched every 20 ms: a local relay moves tens of MB a second. */
    const reached = async (fraction: number, what: string) => {
      const end = Date.now() + 10 * 60_000;
      for (;;) {
        const w = pcWav(pair.pages.pc.data);
        if (w && w.part && w.size >= SIZE * fraction) return w;
        if (w && !w.part) throw new Error(`the WAV was complete before ${what}: too fast to cut off here; try a larger SIZE_MB`);
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    /** One Ledung killed at once (its session hosts live on, as at a crash); started again later with pair.on. */
    const kill = async (n: 'mac' | 'pc') => {
      const child = pair.ledungs[n];
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await gone;
    };
    const t1 = Date.now();
    const alpha = (await mac.api('POST', 'projects/Alpha/manager', {
      text: `Test manager in a Ledung loopback. Call message_manager once: id "${beta.id}", computer "PC", text "a sound file and a zip", attachments ["big.wav", "bundle.zip"]. Quote the tool's answer exactly and stop.`,
    })).json;

    console.log('== 3. While it crosses: memory and answer times, the Mac restarted once and the PC once ==');
    const at30 = await reached(0.3, 'a third of the WAV at the PC');
    console.log(`(30 % after ${Math.round((Date.now() - t1) / 1000)} s; the Mac off)`);
    // Killed, not stopped: a stop lets the server finish the stream it is sending, and the point is a cut-off.
    await kill('mac');
    const partWhileOff = pcWav(pair.pages.pc.data)!;
    if (!partWhileOff.part) throw new Error('the WAV was complete before the Mac went off: too fast to cut off here; try a larger SIZE_MB');
    await new Promise((r) => setTimeout(r, 3000));
    await pair.on('mac');
    pidBase.set(pair.ledungs.mac.pid!, rssMb(pair.ledungs.mac.pid)!);
    const resumedMac = await until(() => { const w = pcWav(pair.pages.pc.data); return w && w.size > partWhileOff.size ? w : null; }, 'the fetch going on after the Mac came back', 5 * 60_000);
    check(partWhileOff.size >= at30.size && resumedMac.part, 'with the Mac off and back, the PC went on from its part, not from the start', `part ${partWhileOff.size} → ${resumedMac.size} bytes`);
    const at65 = await reached(0.65, 'two thirds at the PC');
    console.log('(65 %: the PC off and on)');
    await kill('pc');
    const partAtStop = pcWav(pair.pages.pc.data)!;
    await pair.on('pc');
    pidBase.set(pair.ledungs.pc.pid!, rssMb(pair.ledungs.pc.pid)!);
    const resumedPc = await until(() => { const w = pcWav(pair.pages.pc.data); return w && w.size > partAtStop.size ? w : null; }, 'the fetch going on after the PC came back', 5 * 60_000);
    check(partAtStop.size >= at65.size && partAtStop.part, 'with the PC restarted, it fetched on from its part (hashed again at its start)', `part ${partAtStop.size} → ${resumedPc.size} bytes`);
    const done = await until(() => { const w = pcWav(pair.pages.pc.data); return w && !w.part && w.size === SIZE ? w : null; }, 'the WAV complete at the PC', 10 * 60_000);
    sampling = false;
    await sampler;
    const secs = (Date.now() - t1) / 1000;
    console.log(`(the WAV complete in ${Math.round(secs)} s with two restarts, ${(SIZE / 1048576 / secs).toFixed(1)} MB/s)`);
    check(await hashFile(done.file) === soundSha, 'the PC\'s copy has the SHA-256 of the WAV on the Mac', soundSha.slice(0, 16));
    const half = SIZE / 1048576 / 2;
    check(peak.mac < half, `the Mac's memory never grew by the file's size (less than half of it, ${half} MB)`, `peak growth ${peak.mac.toFixed(0)} MB`);
    check(peak.pc < half, `the PC's memory never grew by the file's size (less than half of it, ${half} MB)`, `peak growth ${peak.pc.toFixed(0)} MB`);
    check(slowest.mac < 2000 && slowest.pc < 2000, 'both pages answered within 2 s throughout', `slowest: Mac ${slowest.mac} ms, PC ${slowest.pc} ms`);

    console.log('== 4. Beta was told of the files at once, then that the WAV is here; it can\'t put it in a question ==');
    const atBeta = await until(async () => { const m = await messages(pc, beta.id); return m.includes('Files it sends to fetch') ? m : null; }, 'the message at Beta', TURN_MS);
    const wavHandle = /"(linked:[0-9a-f]{16}\/big\.wav)"/.exec(atBeta)?.[1];
    const sizeShown = `${(SIZE / 1048576).toFixed(1)} MB`;
    check(!!wavHandle && atBeta.includes(`big.wav (WAV audio, ${sizeShown}), "${wavHandle}": being fetched from your computer "Mac"`), 'Beta\'s message lists the WAV: handle, kind and size, as being fetched', `${wavHandle} ${sizeShown}`);
    check(/"linked:[0-9a-f]{16}\/bundle\.zip": being fetched/.test(atBeta), 'and the zip');
    const told = await until(async () => { const m = await messages(pc, beta.id); return m.includes(`big.wav (WAV audio, ${sizeShown}) from your computer "Mac" is here, its size and SHA-256 checked`) ? m : null; }, 'the "is here" line at Beta', TURN_MS);
    check(!!told, 'a later Ledung line tells Beta the WAV is here, with its handle');
    const refused = await until(async () => { const m = await messages(pc, beta.id); return m.includes('it can\'t be shown in a question or a review. Save it into a session\'s worktree with save_linked_file') ? m : null; }, 'Beta\'s ask_user refused', TURN_MS);
    check(!!refused, 'Beta\'s ask_user with the WAV as a screenshot was refused, naming save_linked_file');
    check(!(((await pc.api('GET', 'state')).json.questions as unknown[]) ?? []).length, 'no question was made on the PC');

    console.log('== 5. Bytes in Settings ==');
    await idle(mac, alpha.id, 'Alpha to finish');
    const macBytes = await filesOf(mac);
    const pcBytes = await filesOf(pc);
    const total = SIZE + archive.length;
    check(pcBytes.today.received === total, 'the PC shows the WAV and the zip received today, once', JSON.stringify(pcBytes.today));
    // The sender counts a mebibyte at a time as it streams (server.ts, LINK_COUNT_EVERY): killed mid-stream, it lost at
    // most that much of its count; what a resume sent again counts too.
    check(macBytes.today.sent >= total - 1024 * 1024, 'the Mac shows them sent today (within the 1 MiB a kill can lose)', JSON.stringify(macBytes.today));

    console.log('== 6. A zip with a .env is refused at the Mac, naming the entry ==');
    await mac.api('POST', `sessions/${alpha.id}/messages`, { text: `Call message_manager once: id "${beta.id}", computer "PC", text "another zip", attachments ["bad.zip"]. It is expected to fail: quote the tool's answer exactly and stop.` });
    const badSaid = await until(async () => { const m = await messages(mac, alpha.id); return m.includes('entry config/.env is a .env file, which never leaves') ? m : null; }, 'the refusal at Alpha', TURN_MS);
    check(!!badSaid, 'refused: "Not sent: attachment bad.zip: entry config/.env is a .env file, which never leaves"');
    check((await filesOf(mac)).today.sent === macBytes.today.sent, 'nothing more counted as sent');

    console.log('== 7. The trace ==');
    const trace = fs.readFileSync(path.join(pair.pages.pc.data, 'exercised.log'), 'utf8');
    check(/EXERCISED #159 a file streamed from a linked computer arrived, its SHA-256 matching/.test(trace), 'EXERCISED #159 in the PC\'s exercised.log');
    // The front sees the caller's side: here the PC's GETs, so no route or key in clear (the file comes the other way).
    check(!pair.seen.clear && pair.seen.bytes > 0, 'the callers\' side through the server carried only TLS: no route or key in clear', `${pair.seen.bytes} bytes`);
  } finally {
    await pair.close();
    // The large files go, pass or fail: the WAV, the Mac's snapshot and the PC's copy (the Mac is short on disk).
    for (const p of [bigWav, path.join(pair.pages.mac.data, 'linked-outbox'), path.join(pair.pages.pc.data, 'linked-files')]) fs.rmSync(p, { recursive: true, force: true });
  }
  console.log(failed() ? `${failed()} FAILED` : 'ALL PASSED');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
