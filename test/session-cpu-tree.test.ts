// #169: machine_status read a session as "idle … 0.0 cores" while its own background command loaded
// the machine. The command had lost its line to the session's host (a process between them exited),
// so it counted for the machine total but not for the session. A session's processes are its host's
// tree plus whatever left that tree since the last sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { hostsDir } from '../src/host/client.ts';
import { parsePs, parseWindowsLines, ProcessSampler, sessionTree, type ProcInfo, type ProcessList } from '../src/platform/processes.ts';
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

test('a reused process id whose old parent is gone too: less CPU time than before is another process', () => {
  // 80 had 30 s of CPU under 70. Later 70 is gone and 80 is a new process with 0.1 s under 99, also
  // gone and never the session's: only the CPU time tells them apart. Positive branch: 31 s is the same 80.
  const before = listOf(proc(50, 4, 0), proc(70, 50, 0), proc(80, 70, 30));
  const { memory } = sessionTree(before, 50, null);
  assert.deepEqual(pids(sessionTree(listOf(proc(50, 4, 0), proc(80, 99, 0.1)), 50, memory).tree), [50]);
  assert.deepEqual(pids(sessionTree(listOf(proc(50, 4, 0), proc(80, 99, 31)), 50, memory).tree), [50, 80]);
});

test('Windows creation times: exact milliseconds from a FILETIME, none for 0', () => {
  // FILETIME 133400000000000000 (100 ns since 1601) = 13 340 000 000 000 ms since 1601, less the
  // 11 644 473 600 000 ms from 1601 to 1970 = 1 695 526 400 000.
  const list = parseWindowsLines(['500,4,0,0,133400000000000000', '4,0,0,0,0', '600,500,0,0']);
  assert.equal(list.get(500)!.started, 1_695_526_400_000);
  assert.equal(list.get(4)!.started, undefined);
  assert.equal(list.get(600)!.started, undefined);
});

/** A Windows process: start time in ms. */
const win = (pid: number, ppid: number, started: number, cpuSeconds = 0): ProcInfo => ({ pid, ppid, cpuSeconds, memBytes: 0, started });

test("Windows: a reused id doesn't take another session's background command (review of PR #184, as #162)", () => {
  // Session B: host 200 → 205 → middle 210 → busy 220; 210 exits and B keeps 220. Windows then gives
  // id 210 to a cmd.exe in session A (host 100 → 110), started later than 220. 220 still names 210.
  const bBefore = listOf(win(200, 4, 1000), win(205, 200, 1001), win(210, 205, 1002), win(220, 210, 1003));
  const b = sessionTree(bBefore, 200, null);
  const later = listOf(win(100, 4, 900), win(110, 100, 901), win(200, 4, 1000), win(205, 200, 1001), win(220, 210, 1003, 5), win(210, 110, 2000));
  assert.deepEqual(pids(sessionTree(later, 100, null).tree), [100, 110, 210]);
  assert.deepEqual(pids(sessionTree(later, 200, b.memory).tree), [200, 205, 220]);
  // Positive branch: a child A's cmd.exe really started (after it) is A's.
  const withChild = new Map(later).set(230, win(230, 210, 2001));
  assert.deepEqual(pids(sessionTree(withChild, 100, null).tree), [100, 110, 210, 230]);
});

test("Windows: a remembered id with another start time is another process; a gone parent's older 'child' is not its child", () => {
  // 80 was the session's (started 1003). Later id 80 belongs to a process started at 5000 under 99,
  // gone and never the session's, with more CPU time (so only the start time tells), and 85 names gone
  // 70 as parent but started before 70 did (a stale parent id).
  const before = listOf(win(50, 4, 1000), win(70, 50, 1002), win(80, 70, 1003));
  const { memory } = sessionTree(before, 50, null);
  const later = listOf(win(50, 4, 1000), win(80, 99, 5000, 99), win(85, 70, 500));
  assert.deepEqual(pids(sessionTree(later, 50, memory).tree), [50]);
  // Positive branches: the same 80 (same start) stays, and a child 70 started (after it) is taken.
  const same = listOf(win(50, 4, 1000), win(80, 70, 1003, 1), win(86, 70, 1004));
  assert.deepEqual(pids(sessionTree(same, 50, memory).tree), [50, 80, 86]);
});

test("macOS/Linux: a group leader's id reused by another session's shell doesn't bring that group along", () => {
  // Session A's shell 70 led group 70 and exited; within one sample id 70 went to session B's new shell,
  // under B's host 150, leading its own group 70 with command 75.
  const before = listOf(proc(50, 1, 0, 50), proc(60, 50, 0, 50), proc(70, 60, 3, 70));
  const { memory } = sessionTree(before, 50, null);
  const later = listOf(proc(50, 1, 0, 50), proc(60, 50, 0, 50), proc(150, 1, 0, 150), proc(70, 150, 0, 70), proc(75, 70, 1, 70));
  assert.deepEqual(pids(sessionTree(later, 50, memory).tree), [50, 60]);
  // Positive branch: with 70 gone, its group's command 75 is still A's.
  const gone = listOf(proc(50, 1, 0, 50), proc(60, 50, 0, 50), proc(75, 1, 1, 70));
  assert.deepEqual(pids(sessionTree(gone, 50, memory).tree), [50, 60, 75]);
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
  // Detached on Windows only: there Node ends a child that isn't detached when its parent exits (Windows CI,
  // PR #184), so it could never outlive the middle process. Elsewhere it stays in its parent's group, as a
  // background command does.
  const middle = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(busy)}], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
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

const posixOnly = { skip: process.platform === 'win32' ? 'process groups are macOS and Linux only' : false };

test("macOS/Linux: the sampler's own list carries each process's group, as ps gives it", { ...posixOnly, timeout: HANG_MS }, async () => {
  const list = await new Promise<ProcessList>((resolve) => {
    const sampler = new ProcessSampler(1, (l) => {
      sampler.stop();
      resolve(l);
    });
    sampler.start();
  });
  const expected = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  assert.ok(expected > 0);
  assert.equal(list.get(process.pid)?.pgid, expected);
});

test('macOS/Linux: a background command whose shell came and went between two samples counts, through its group', { ...posixOnly, timeout: HANG_MS }, async () => {
  // Like a real host, the pretend host is detached: it leads its own group. On "go" it starts a short
  // shell that starts the busy command and exits after 100 ms, well within the 1 s between samples, so
  // no sample sees the busy command under the host: only the host's group keeps it.
  const busy = `const end = Date.now() + ${WAIT_MS}; while (Date.now() < end) {}`;
  const shell = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(busy)}], { stdio: 'ignore' });
    console.log(JSON.stringify({ shell: process.pid, busy: c.pid })); c.unref(); setTimeout(() => process.exit(0), 100);`;
  const hostCode = `require('readline').createInterface({ input: process.stdin }).once('line', () => {
      const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(shell)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.pipe(process.stdout);
    }); setInterval(() => {}, 1000);`;
  const host = spawn(process.execPath, ['-e', hostCode], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  const started = new Promise<{ shell: number; busy: number }>((resolve) => {
    readline.createInterface({ input: host.stdout! }).once('line', (l) => resolve(JSON.parse(l)));
  });
  const id = `test-169-group-${process.pid}`;
  const record = path.join(hostsDir(), `${id}.json`);
  let busyPid = 0;
  let sent = false;
  const monitor: ResourceMonitor = new ResourceMonitor({
    intervalSec: 1, targets: () => [{ id, kind: 'local' }], withDocker: () => false,
    // Right after a sample, so the shell lives and exits before the next one.
    onSample: () => {
      if (!sent && monitor.figures()[id]) {
        sent = true;
        host.stdin!.write('go\n');
      }
    },
  });
  try {
    fs.writeFileSync(record, JSON.stringify({ sessionId: id, hostPid: host.pid, startedAt: Date.now() }));
    monitor.start();
    const { shell, busy: b } = await started;
    busyPid = b;
    const until = Date.now() + WAIT_MS;
    while (alive(shell) && Date.now() < until) await sleep(50);
    assert.equal(alive(shell), false, 'the shell exited');
    assert.equal(alive(b), true, 'the busy command outlived it');
    await sleep(3500);
    const f = monitor.figures()[id];
    assert.ok(f, 'the session is measured');
    assert.ok(f.cores >= 0.5, `session reads ${f.cores.toFixed(2)} cores, expected about 1`);
  } finally {
    monitor.stop();
    if (busyPid && alive(busyPid)) process.kill(busyPid);
    host.kill();
    fs.rmSync(record, { force: true });
  }
});
