// Which processes a stop or a timed-out update step ends. Pure process lists only: nothing here
// lists or ends a real process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeFrom, type ProcessInfo } from '../src/platform/process-tree.ts';

const proc = (pid: number, ppid: number, started: string, name = 'node.exe'): ProcessInfo => ({ pid, ppid, started, name });

test('a tree is the process and everything it started', () => {
  const all = [proc(100, 1, '1000'), proc(101, 100, '1001'), proc(102, 101, '1002'), proc(200, 1, '1003')];
  assert.deepEqual(treeFrom(all, 100).map((p) => p.pid), [100, 101, 102]);
  assert.deepEqual(treeFrom(all, 999), []);
});

test("a reused id does not adopt the old process's children (session hosts outlive their Ledung)", () => {
  // Ledung 500 started two hosts, then restarted; Windows still names 500 as their parent. A test
  // process later gets id 500 and starts a child of its own.
  const all = [
    proc(600, 500, '133400000000000001'), proc(601, 500, '133400000000000002'),
    proc(650, 600, '133400000000000003', 'claude.exe'),
    proc(500, 40, '133400000000900000'), proc(700, 500, '133400000000900001'),
  ];
  assert.deepEqual(treeFrom(all, 500).map((p) => p.pid), [500, 700]);
});

test('start times are compared exactly, beyond what a Number holds', () => {
  // 100 ns apart: equal once rounded to a double.
  const all = [proc(500, 1, '133400000000000002'), proc(600, 500, '133400000000000001')];
  assert.deepEqual(treeFrom(all, 500).map((p) => p.pid), [500]);
});

test("ps start times: a child in the same second counts, an older one doesn't", () => {
  const all = [
    proc(10, 1, 'Sat Oct 17 12:05:59 2026'), proc(11, 10, 'Sat Oct 17 12:05:59 2026'),
    proc(12, 10, 'Sat Oct 17 11:00:00 2026'),
  ];
  assert.deepEqual(treeFrom(all, 10).map((p) => p.pid), [10, 11]);
});

test('a root that is gone has no tree, even where processes still name it as parent', () => {
  const orphans = [proc(600, 500, '133400000000000001'), proc(601, 500, '133400000000000002')];
  assert.deepEqual(treeFrom(orphans, 500), []);
  // The same children with their parent still running.
  assert.deepEqual(treeFrom([proc(500, 40, '133400000000000000'), ...orphans], 500).map((p) => p.pid), [500, 600, 601]);
});

test('a child without a start time is left alone', () => {
  const all = [proc(10, 1, '1000'), proc(11, 10, '')];
  assert.deepEqual(treeFrom(all, 10).map((p) => p.pid), [10]);
});
