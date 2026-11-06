// #157: Peak CPU per turn read 26 cores on a 12-thread PC. The sample interval must be the one the
// process list was read at, and no figure may exceed the machine's thread count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsBatchReader, type ProcessList } from '../src/platform/processes.ts';
import { capCores, treeSample } from '../src/resources/monitor.ts';
import { capTurnCores, typicalCosts } from '../src/resources/typical.ts';

/** Feeds PowerShell's lines to the reader the way readline does and returns the batches. */
function readBatches(lines: string[], now: () => number): { list: ProcessList; at: number }[] {
  const out: { list: ProcessList; at: number }[] = [];
  const onLine = windowsBatchReader((list, at) => out.push({ list, at }), now);
  for (const l of lines) onLine(l);
  return out;
}

test('two batches Node handles 3 ms apart keep the 5 s PowerShell read them at', () => {
  // PowerShell read the list at t and t + 5 s; a busy Ledung handles both batches back to back,
  // its clock moving 3 ms between them. The session's process (pid 100, under host 50) used
  // 12.5 s of CPU between the two reads (1.25e8 units of 100 ns): 12.5 / 5 = 2.5 cores.
  let clock = 2_000_000;
  const now = () => (clock += 3);
  const batches = readBatches([
    '#BEGIN 1000000', '50,1,0,1000', '100,50,0,2000', '#END',
    '#BEGIN 1005000', '50,1,0,1000', '100,50,125000000,2000', '#END',
  ], now);
  assert.equal(batches.length, 2);
  const dt = (batches[1]!.at - batches[0]!.at) / 1000;
  assert.equal(dt, 5);
  const s = treeSample(batches[0]!.list, batches[1]!.list, 50, dt, 12);
  assert.equal(s.cpuSeconds, 12.5);
  assert.equal(s.cores, 2.5);
  assert.equal(s.memBytes, 3000);
});

test('a batch without a read time falls back to the time it is handled', () => {
  const batches = readBatches(['#BEGIN', '50,1,0,0', '#END'], () => 1234);
  assert.equal(batches[0]!.at, 1234);
  assert.equal(batches[0]!.list.get(50)!.pid, 50);
});

test('a sample never reads more cores than the machine has threads', () => {
  // 130 s of CPU over 5 s would be 26 cores; a 12-thread machine can't do that, so it reads 12.
  const prev: ProcessList = new Map([[50, { pid: 50, ppid: 1, cpuSeconds: 0, memBytes: 0 }]]);
  const list: ProcessList = new Map([[50, { pid: 50, ppid: 1, cpuSeconds: 130, memBytes: 0 }]]);
  assert.equal(treeSample(prev, list, 50, 5, 12).cores, 12);
  // Positive branch: a figure below the limit passes unchanged (30 s / 5 s = 6 cores).
  const list6: ProcessList = new Map([[50, { pid: 50, ppid: 1, cpuSeconds: 30, memBytes: 0 }]]);
  assert.equal(treeSample(prev, list6, 50, 5, 12).cores, 6);
  assert.equal(capCores(26, 12), 12);
  assert.equal(capCores(3, 12), 3);
});

test('turns recorded with a peak above the thread count are held at it, on their own and in the typical row', () => {
  const t = (peakCores: number, avgCores: number) => ({
    sessionId: 's', project: 'p', startedAt: 0, durationMs: 60000, avgCores, peakCores, peakMem: 1e9, model: null, trigger: 'user', commands: ['npm run check'],
  });
  assert.equal(capTurnCores(t(26, 14), 12).peakCores, 12);
  assert.equal(capTurnCores(t(26, 14), 12).avgCores, 12);
  assert.equal(capTurnCores(t(3, 1), 12).peakCores, 3);
  // One turn at 26 (held at 12) and one at 2: the typical Peak CPU is (12 + 2) / 2 = 7, not 14.
  const row = typicalCosts([t(26, 1), t(2, 1)], 12).find((c) => c.command === 'npm run check')!;
  assert.equal(row.peakCores, 7);
  assert.ok(row.peakCores <= 12);
});
