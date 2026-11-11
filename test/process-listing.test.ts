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
  const marker = `ledung-230-left-${process.pid}-${Date.now()}`;
  const node = JSON.stringify(process.execPath).replace(/\\\\/g, '/');
  const script = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "${marker}"], { stdio: "ignore", detached: true }).unref(); setTimeout(()=>{}, 2000)`;
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
  try {
    const r = await startShell(runner.shell(`${node} -e '${script}'`, 'bash', process.env as never), { list: slow, recordEveryMs: 25 }).done;
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(calls >= 2, `the recorder listed (${calls} lists)`);
    assert.equal(most, 1, `at most one list at a time (${calls} lists in ${r.durationMs} ms)`);
    // ~2 s of command and lists of at least 300 ms: one after another, far fewer than the 80 ticks.
    assert.ok(calls <= Math.ceil(r.durationMs / 300) + 2, `${calls} lists in ${r.durationMs} ms`);
    const left = (await commandLines()).some((l) => l.includes(marker) && !l.includes('commandLines'));
    assert.equal(left, false, 'the process it left behind was ended');
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

const info = (over: Partial<MachineInfo> = {}): MachineInfo => ({
  at: 1, cpus: 12, cores: 0.40, memTotal: 16e9, memUsed: 8.2e9, docker: null,
  sessions: { s1: { cores: 0.01, memBytes: 300 * 1024 ** 2 } }, working: 0, limit: 4, line: [], ...over,
});

test('a machine sample is sent only when what the page shows changed; a change made by hand is always sent', () => {
  const sent: MachineInfo[] = [];
  const send = machineSender((m) => sent.push(m));
  send(info(), true);
  assert.equal(sent.length, 1, 'the first is sent');
  // A later time, 0.40 → 0.41 cores (both "0.4 cores", 3 % of 12), 8.2 → 8.21 GB used (both "7.6 GB", 51 %),
  // a session's memory 300 → 300.4 MB (both "300 MB"): nothing on the page changes.
  send(info({ at: 2, cores: 0.41, memUsed: 8.21e9, sessions: { s1: { cores: 0.02, memBytes: 300.4 * 1024 ** 2 } } }), true);
  assert.equal(sent.length, 1, 'an idle sample is not sent');
  send(info({ cores: 0.48 }), true);
  assert.equal(sent.length, 2, '"0.5 cores" is sent');
  send(info({ cores: 0.48, sessions: { s1: { cores: 0.01, memBytes: 300 * 1024 ** 2 }, s2: { cores: 0, memBytes: 1024 ** 2 } } }), true);
  assert.equal(sent.length, 3, 'a session that joined is sent');
  send(info({ cores: 0.48, sessions: { s1: { cores: 0.01, memBytes: 300 * 1024 ** 2 }, s2: { cores: 0, memBytes: 1024 ** 2 } }, line: ['s2'] }), true);
  assert.equal(sent.length, 4, 'a place in line is sent');
  const same = sent[3]!;
  send(same);
  assert.equal(sent.length, 5, 'a change by hand (the limit, a pause) is sent even when the figures are the same');
});
