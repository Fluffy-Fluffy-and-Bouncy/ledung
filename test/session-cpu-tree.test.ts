// #169: machine_status read a session as "idle … 0.0 cores" while its own background command loaded
// the machine. The command had lost its line to the session's host (a process between them exited),
// so it counted for the machine total but not for the session. A session's processes are its host's
// tree plus whatever left that tree since the last sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { hostsDir } from '../src/host/client.ts';
import { parsePs, sessionTree, type ProcInfo, type ProcessList } from '../src/platform/processes.ts';
import { ResourceMonitor, treeSample } from '../src/resources/monitor.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

// A data folder of its own, also when run with plain `node --test`: the pretend host's record goes there.
process.env.LEDUNG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-169-'));

const proc = (pid: number, ppid: number, cpuSeconds: number, pgid?: number): ProcInfo =>
  pgid === undefined ? { pid, ppid, cpuSeconds, memBytes: 0 } : { pid, ppid, cpuSeconds, memBytes: 0, pgid };
const listOf = (...ps: ProcInfo[]): ProcessList => new Map(ps.map((p) => [p.pid, p]));
const pids = (ps: ProcInfo[]) => ps.map((p) => p.pid).sort((a, b) => a - b);

test('ps with the process group column', () => {
  const list = parsePs('  10     1 00:00:03  2048    10\n  11    10 00:01:00  1024    11\n');
  assert.deepEqual(list.get(11), { pid: 11, ppid: 10, cpuSeconds: 60, memBytes: 1024 * 1024, pgid: 11 });
});

test('macOS/Linux: a background command whose shell exited (moved to pid 1) still counts for its session', () => {
  // Host 50 → Claude Code 60 → shell 70 → busy command 80. The shell exits; 80 moves to pid 1.
  // Each process here is in a group of its own (no group rule), so only the memory keeps 80.
  const before = listOf(proc(50, 1, 0), proc(60, 50, 1), proc(70, 60, 0), proc(80, 70, 0), proc(90, 1, 0));
  const after = listOf(proc(50, 1, 0), proc(60, 50, 1), proc(80, 1, 5), proc(90, 1, 3));
  const first = sessionTree(before, 50, null);
  assert.deepEqual(pids(first.tree), [50, 60, 70, 80]);
  // Without the memory it is the plain tree, which has lost 80: the bug.
  assert.deepEqual(pids(sessionTree(after, 50, null).tree), [50, 60]);
  assert.deepEqual(pids(sessionTree(after, 50, first.memory).tree), [50, 60, 80]);
  // 90 never belonged to the session: 80's 5 s of CPU over 5 s is 1 core, and 90's 3 s are not in it.
  const s = treeSample(before, after, 50, 5, 12, first.memory);
  assert.equal(s.cpuSeconds, 5);
  assert.equal(s.cores, 1);
});

test('Windows: the child of a session process that exited between two samples still counts', () => {
  // 70 was the session's at the last sample; it started 80 and exited before the next one. Windows
  // keeps 80's parent id at 70. 95's parent 99 is gone too, but 99 was never the session's.
  const before = listOf(proc(50, 4, 0), proc(60, 50, 0), proc(70, 60, 0));
  const after = listOf(proc(50, 4, 0), proc(60, 50, 0), proc(80, 70, 2), proc(95, 99, 2));
  const { memory } = sessionTree(before, 50, null);
  assert.deepEqual(pids(sessionTree(after, 50, memory).tree), [50, 60, 80]);
});

test("macOS/Linux: a command in a session process's group counts, even when its shell lived between two samples", () => {
  // Shell 70 (group 70) was seen; it started 75, which started 80 and exited, all within one interval;
  // 80 moved to pid 1 but stayed in group 70. 91 is in a group the session never had.
  const before = listOf(proc(50, 1, 0, 50), proc(60, 50, 0, 50), proc(70, 60, 0, 70));
  const after = listOf(proc(50, 1, 0, 50), proc(60, 50, 0, 50), proc(80, 1, 4, 70), proc(91, 1, 4, 91));
  const { memory } = sessionTree(before, 50, null);
  assert.deepEqual(pids(sessionTree(after, 50, memory).tree), [50, 60, 80]);
});

test('a reused process id is not taken for the process the session had', () => {
  // 80 was the session's with 30 s of CPU. Later list: 80 is a new process, 0.1 s of CPU, under 90,
  // a living process the session never had. Positive branch: the real 80 (more CPU, same parent) stays.
  const before = listOf(proc(50, 4, 0), proc(70, 50, 0), proc(80, 70, 30), proc(90, 4, 0));
  const { memory } = sessionTree(before, 50, null);
  const reused = listOf(proc(50, 4, 0), proc(70, 50, 0), proc(90, 4, 0), proc(80, 90, 0.1));
  assert.deepEqual(pids(sessionTree(reused, 50, memory).tree), [50, 70]);
  const same = listOf(proc(50, 4, 0), proc(90, 4, 0), proc(80, 70, 31));
  assert.deepEqual(pids(sessionTree(same, 50, memory).tree), [50, 80]);
});

test('a session process stays counted after its host exits, and the session ends with it', () => {
  const before = listOf(proc(50, 4, 0), proc(80, 50, 0));
  const { memory } = sessionTree(before, 50, null);
  assert.deepEqual(pids(sessionTree(listOf(proc(80, 50, 1)), 50, memory).tree), [80]);
  assert.deepEqual(sessionTree(listOf(proc(80, 50, 1)), 50, null).tree, []);
});

/** Starts a pretend host: it starts a middle process, which starts a busy command and exits. */
function startHost(): { host: ChildProcess; pids: Promise<{ middle: number; busy: number }> } {
  // The busy command spins for at most WAIT_MS, so a failed test leaves nothing running for long.
  const busy = `const end = Date.now() + ${WAIT_MS}; while (Date.now() < end) {}`;
  const middle = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(busy)}], { stdio: 'ignore', windowsHide: true });
    console.log(JSON.stringify({ middle: process.pid, busy: c.pid })); c.unref(); setTimeout(() => process.exit(0), 2500);`;
  const hostCode = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    c.stdout.pipe(process.stdout); setInterval(() => {}, 1000);`;
  const host = spawn(process.execPath, ['-e', hostCode], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const pids = new Promise<{ middle: number; busy: number }>((resolve) => {
    readline.createInterface({ input: host.stdout! }).once('line', (l) => resolve(JSON.parse(l)));
  });
  return { host, pids };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a session whose background command keeps running after its middle process exited reads that CPU, with no turn under way', { timeout: HANG_MS }, async () => {
  const id = `test-169-${process.pid}`;
  const { host, pids } = startHost();
  const record = path.join(hostsDir(), `${id}.json`);
  let busyPid = 0;
  const monitor = new ResourceMonitor({ intervalSec: 1, targets: () => [{ id, kind: 'local' }], withDocker: () => false, onSample: () => {} });
  try {
    fs.writeFileSync(record, JSON.stringify({ sessionId: id, hostPid: host.pid, startedAt: Date.now() }));
    const { middle, busy } = await pids;
    busyPid = busy;
    monitor.start();
    // No beginTurn: the session is between turns, as in the issue.
    const until = Date.now() + WAIT_MS;
    while (alive(middle) && Date.now() < until) await sleep(200);
    assert.equal(alive(middle), false, 'the middle process exited');
    assert.equal(alive(busy), true, 'the busy command outlived it');
    // Two more samples, so the reading is over an interval with the middle process gone.
    await sleep(3500);
    const f = monitor.figures()[id];
    assert.ok(f, 'the session is measured');
    // The busy command spins one core; the host and the rest are idle. Before #169 this read 0.0.
    assert.ok(f.cores >= 0.5, `session reads ${f.cores.toFixed(2)} cores, expected about 1`);
    assert.ok(f.cores <= monitor.machine().cpus, 'never more than the machine has');
  } finally {
    monitor.stop();
    if (busyPid && alive(busyPid)) process.kill(busyPid);
    host.kill();
    fs.rmSync(record, { force: true });
  }
});
