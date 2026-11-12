// #230 (audit O4 and O6): process listings that cost more than they need to. A `!` command's recorder
// started a new PowerShell every 2 s and the starts overlapped under load; the resource monitor listed
// the whole machine every 5 s even with no local session, and sent `machine` to every page each time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAll, commandLines, type ProcessInfo } from '../src/platform/process-tree.ts';
import { SharedLister, listShared, parseListLines } from '../src/platform/process-lister.ts';
import { PowerShellWorker } from '../src/platform/powershell-worker.ts';
import { ProcessSampler } from '../src/platform/processes.ts';
import { ResourceMonitor, type MonitorTarget } from '../src/resources/monitor.ts';
import { startShell } from '../src/runners/shell-run.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { machineSender } from '../src/shared/machine-shown.ts';
import type { MachineInfo } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { WAIT_MS } from './limits.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the shared lister never reads two lists at once, and a call made during a read gets a list read after it', async () => {
  let running = 0;
  let most = 0;
  let reads = 0;
  const lister = new SharedLister(async () => {
    const n = ++reads;
    running++;
    most = Math.max(most, running);
    await sleep(60);
    running--;
    return [{ pid: n, ppid: 0, started: '', name: `read ${n}` }];
  });
  const first = lister.list();
  await sleep(10);
  // Both asked while read 1 runs: they share read 2, which starts once read 1 is done.
  const [a, b, c] = await Promise.all([first, lister.list(), lister.list()]);
  assert.equal(a[0]!.name, 'read 1');
  assert.equal(b[0]!.name, 'read 2');
  assert.equal(c[0]!.name, 'read 2');
  assert.equal(reads, 2);
  assert.equal(most, 1, 'never two reads at once');
  // Nothing running: the next call reads at once.
  assert.equal((await lister.list())[0]!.name, 'read 3');
});

test("a list still running when the recorder's next tick comes: no second one starts, and what the command left behind is still ended", { timeout: WAIT_MS * 3 }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-230-')));
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
  const half = `ledung-230-left-${process.pid}`;
  const marker = `${half}-${Date.now()}`;
  const node = JSON.stringify(process.execPath).replace(/\\\\/g, '/');
  // The marker is joined inside the script, so only the child's command line carries it whole, not the
  // command's own (self-check of #230, round 2): the probe then sees the child and nothing else.
  const script = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "${half}" + "${marker.slice(half.length)}"], { stdio: "ignore", detached: true }).unref(); setTimeout(()=>{}, 4000)`;
  let running = 0;
  let most = 0;
  let calls = 0;
  // Each list takes 300 ms more than a real one and the ticks come every 25 ms: before #230 a new list
  // started on every tick while the last still ran.
  const slow = async (): Promise<ProcessInfo[]> => {
    calls++;
    running++;
    most = Math.max(most, running);
    try {
      await sleep(300);
      return await listAll();
    } finally {
      running--;
    }
  };
  const there = async () => (await commandLines()).some((l) => l.includes(marker) && !l.includes('commandLines'));
  try {
    const run = startShell(runner.shell(`${node} -e '${script}'`, 'bash', process.env as never), { list: slow, recordEveryMs: 25 });
    // The probe that later finds it gone first finds it running, so "gone" is not a probe that sees nothing.
    let seen = false;
    for (const end = Date.now() + WAIT_MS; !seen && Date.now() < end; await sleep(100)) seen = await there();
    assert.equal(seen, true, 'the probe sees what the command started while it runs');
    const r = await run.done;
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(calls >= 2, `the recorder listed (${calls} lists)`);
    assert.equal(most, 1, `at most one list at a time (${calls} lists in ${r.durationMs} ms)`);
    // ~4 s of command and lists of at least 300 ms: one after another, far fewer than the 160 ticks.
    assert.ok(calls <= Math.ceil(r.durationMs / 300) + 2, `${calls} lists in ${r.durationMs} ms`);
    assert.equal(await there(), false, 'the process it left behind was ended');
  } finally {
    try {
      removeTemp(dir);
    } catch {
      // Left in the temp folder.
    }
  }
});

/** A stand-in for powershell.exe that speaks the worker's protocol; "die" makes it exit mid-answer. */
const FAKE = `let busy = false;
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l === 'die') process.exit(1);
  const overlap = busy;
  busy = true;
  setTimeout(() => {
    console.log('#BEGIN 42');
    console.log((overlap ? 'overlap ' : '') + process.pid + ' ' + l);
    console.log('#END');
    busy = false;
  }, 40);
});`;
const fake = () => spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'ignore'] });

test('the PowerShell worker answers one request at a time from one process, and starts a new one only after going idle', async () => {
  const worker = new PowerShellWorker({ answer: '', idleMs: 300, spawn: fake });
  try {
    const answers = await Promise.all(['a', 'b', 'c'].map((r) => worker.request(r)));
    const pids = new Set(answers.map((a) => a.lines[0]!.split(' ')[0]));
    assert.deepEqual(answers.map((a) => a.lines[0]!.split(' ').slice(1).join(' ')), ['a', 'b', 'c'], 'in order, none overlapping');
    assert.equal(answers[0]!.begin, '42');
    assert.equal(pids.size, 1, 'one process answered all three');
    assert.equal(worker.starts, 1);
    await sleep(800);
    const later = await worker.request('d');
    assert.equal(worker.starts, 2, 'after going idle, a new one');
    assert.notEqual(later.lines[0]!.split(' ')[0], [...pids][0]);
  } finally {
    worker.close();
  }
});

test('a PowerShell that dies mid-answer fails that request, and none is started again until the retry time has passed', async () => {
  const worker = new PowerShellWorker({ answer: '', retryMs: 500, spawn: fake });
  try {
    await assert.rejects(worker.request('die'), /ended/);
    await assert.rejects(worker.request('x'), /a moment ago/);
    assert.equal(worker.starts, 1);
    await sleep(600);
    assert.match((await worker.request('y')).lines[0]!, / y$/);
    assert.equal(worker.starts, 2);
  } finally {
    worker.close();
  }
});

test('the shared lister gives what listAll gives: this process, its parent and start time, on every platform', { timeout: WAIT_MS * 2 }, async () => {
  const [shared, plain] = await Promise.all([listShared(), listAll()]);
  const me = shared.find((p) => p.pid === process.pid);
  assert.ok(me, 'this process is listed');
  assert.equal(me.ppid, process.ppid);
  assert.equal(me.started, plain.find((p) => p.pid === process.pid)?.started);
  assert.ok(shared.length > 1);
});

test('lines from the Windows list read as listAll reads them', () => {
  assert.deepEqual(parseListLines(['12\t4\t133000000000000000\tnode.exe', '', '7\t0\t\tSystem']), [
    { pid: 12, ppid: 4, started: '133000000000000000', name: 'node.exe' },
    { pid: 7, ppid: 0, started: '', name: 'System' },
  ]);
});

test('the sampler reads no process list while none is wanted, and reads again once one is', { timeout: WAIT_MS * 2 }, async () => {
  let wanted = false;
  const skips: number[] = [];
  const lists: number[] = [];
  const sampler = new ProcessSampler(0.2, (list) => lists.push(list.size), { wanted: () => wanted, onSkip: (at) => skips.push(at) });
  sampler.start();
  try {
    await sleep(700);
    assert.ok(skips.length >= 2, `rounds went on (${skips.length})`);
    assert.equal(lists.length, 0, 'no list was read');
    wanted = true;
    for (const end = Date.now() + WAIT_MS; !lists.length && Date.now() < end;) await sleep(50);
    assert.ok(lists.length >= 1 && lists[0]! > 1, 'once wanted, the whole list is read');
  } finally {
    sampler.stop();
  }
});

// The monitor's own rule (Martin, #2059 a): no list while no local session is live, none or only container
// sessions; one again once a local session is. Test review finding 1: the test above hands the sampler its own
// `wanted`, so it never reached the monitor's. The sampler's read is wrapped to count, and still reads.
test('the monitor reads no process list with no session or only container sessions, and reads one once a local session is live', { timeout: WAIT_MS * 2 }, async () => {
  const proto = ProcessSampler.prototype as unknown as { read: () => Promise<void> };
  const read = proto.read;
  let reads = 0;
  proto.read = function (this: unknown) {
    reads++;
    return read.call(this);
  };
  let targets: MonitorTarget[] = [];
  let samples = 0;
  const monitor = new ResourceMonitor({ intervalSec: 0.2, targets: () => targets, withDocker: () => false, onSample: () => samples++ });
  const roundsGoOn = async (what: string) => {
    const from = samples;
    for (const end = Date.now() + WAIT_MS; samples < from + 2 && Date.now() < end;) await sleep(50);
    assert.ok(samples >= from + 2, `${what}: samples went on (${samples - from})`);
  };
  try {
    monitor.start();
    await roundsGoOn('no session');
    assert.equal(reads, 0, 'no session: no list was read');
    // A container session only: its figures come from the container, not from this computer's list.
    targets = [{ id: 'c1', kind: 'docker', container: `ledung-test-none-${process.pid}` }];
    await roundsGoOn('a container session only');
    assert.equal(reads, 0, 'a container session only: no list was read');
    targets = [...targets, { id: 'l1', kind: 'local' }];
    for (const end = Date.now() + WAIT_MS; !reads && Date.now() < end;) await sleep(50);
    assert.ok(reads >= 1, 'a local session live: a list is read');
  } finally {
    monitor.stop();
    proto.read = read;
  }
});

const MB = 1024 ** 2;
const info = (over: Partial<MachineInfo> = {}): MachineInfo => ({
  at: 1, cpus: 12, cores: 1.2, memTotal: 16e9, memUsed: 8e9, docker: null,
  sessions: { s1: { cores: 0.01, memBytes: 300 * MB } }, working: 0, limit: 4, line: [], ...over,
});
/** A sender, and how many it has sent; each `sample` returns whether that one was sent. */
const sender = () => {
  let n = 0;
  const send = machineSender(() => n++);
  return { sample: (m: MachineInfo) => { const before = n; send(m, true); return n > before; }, byHand: (m: MachineInfo) => send(m), count: () => n };
};

test("the machine's own meters are sent again only once they move 5 points from the last one sent, or turn busy or full (#2064 a)", () => {
  const s = sender();
  assert.equal(s.sample(info()), true, 'the first is sent');
  // CPU of 12 threads: 1.2 cores is 10 %. 1.7 is 14.2 % (4.2 points), 1.8 is 15 % (5 points).
  assert.equal(s.sample(info({ at: 2, cores: 1.7 })), false, '4.2 points: not sent, though "1.7 cores" reads differently from "1.2 cores"');
  assert.equal(s.sample(info({ cores: 1.8 })), true, '5 points: sent');
  // Measured from the last one sent (15 %), not from the sample before: 17.5 % no, 20 % yes.
  assert.equal(s.sample(info({ cores: 1.9 })), false);
  assert.equal(s.sample(info({ cores: 2.1 })), false);
  assert.equal(s.sample(info({ cores: 2.4 })), true, 'drift that adds up to 5 points is sent');
  // Memory of 16 GB: 8 GB is 50 %; 8.7 GB 54.4 %, 8.8 GB 55 %.
  assert.equal(s.sample(info({ cores: 2.4, memUsed: 8.7e9 })), false);
  assert.equal(s.sample(info({ cores: 2.4, memUsed: 8.8e9 })), true, 'memory 5 points: sent');

  // Busy from 80 %, full from 95 %: one point across either is sent.
  const b = sender();
  b.sample(info({ cores: 9.5 })); // 79.2 %
  assert.equal(b.sample(info({ cores: 9.62 })), true, '79.2 → 80.2 %: turned busy');
  b.sample(info({ cores: 11.3 })); // 94.2 %, sent: 14 points
  assert.equal(b.sample(info({ cores: 11.42 })), true, '94.2 → 95.2 %: turned full');

  // Docker's VM, 4 CPUs and 8 GB: memory 25 → 28.75 % no, → 30 % yes; its CPU 5 → 10 % yes.
  const d = sender();
  const vm = { cpus: 4, cores: 0.2, memTotal: 8e9, memUsed: 2e9 };
  assert.equal(d.sample(info()), true);
  assert.equal(d.sample(info({ docker: vm })), true, 'Docker coming up is sent');
  assert.equal(d.sample(info({ docker: { ...vm, memUsed: 2.3e9 } })), false);
  assert.equal(d.sample(info({ docker: { ...vm, memUsed: 2.4e9 } })), true);
  assert.equal(d.sample(info({ docker: { ...vm, memUsed: 2.4e9, cores: 0.4 } })), true);
});

test('per-session figures, the working count, the limit and the line are sent on any change the page shows; a change by hand always', () => {
  const s = sender();
  s.sample(info());
  // A later time, a session's 0.01 → 0.02 cores (both "0.0 cores") and 300 → 300.4 MB (both "300 MB"): the same on the page.
  assert.equal(s.sample(info({ at: 2, sessions: { s1: { cores: 0.02, memBytes: 300.4 * MB } } })), false, 'an idle sample is not sent');
  assert.equal(s.sample(info({ sessions: { s1: { cores: 0.06, memBytes: 300 * MB } } })), true, '"0.1 cores" is sent');
  assert.equal(s.sample(info({ sessions: { s1: { cores: 0.06, memBytes: 301 * MB } } })), true, '"301 MB" is sent');
  const two = { s1: { cores: 0.06, memBytes: 301 * MB }, s2: { cores: 0, memBytes: MB } };
  assert.equal(s.sample(info({ sessions: two })), true, 'a session that joined is sent');
  assert.equal(s.sample(info({ sessions: two, working: 1 })), true, 'the working count is sent');
  assert.equal(s.sample(info({ sessions: two, working: 1, limit: 5 })), true, 'the limit is sent');
  assert.equal(s.sample(info({ sessions: two, working: 1, limit: 5, line: ['s2'] })), true, 'a place in line is sent');
  assert.equal(s.sample(info({ sessions: two, working: 1, limit: 5, line: ['s2'] })), false, 'the same again is not');
  const before = s.count();
  s.byHand(info({ sessions: two, working: 1, limit: 5, line: ['s2'] }));
  assert.equal(s.count(), before + 1, 'a change by hand (the limit, a pause) is sent even when the figures are the same');
});
