import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, parsePsTime, parseWindowsLines, treeOf } from '../src/platform/processes.ts';
import { parseDockerBytes, parseProcTrees } from '../src/platform/containers.ts';

test('ps CPU time and memory', () => {
  assert.equal(parsePsTime('00:01:05'), 65);
  assert.equal(parsePsTime('1-02:00:00'), 93600);
  assert.equal(parsePsTime('03:07.50'), 187.5);
  const list = parsePs('  10     1 00:00:03  2048\n  11    10 00:01:00  1024\n');
  assert.deepEqual(list.get(11), { pid: 11, ppid: 10, cpuSeconds: 60, memBytes: 1024 * 1024 });
});

test('Windows lines: CPU in 100-ns units', () => {
  const list = parseWindowsLines(['4,0,0,0', '500,4,25000000,104857600']);
  assert.equal(list.get(500)!.cpuSeconds, 2.5);
  assert.equal(list.get(500)!.memBytes, 104857600);
});

test('a process tree includes everything a session started', () => {
  const list = parseWindowsLines(['100,1,10000000,1000', '101,100,20000000,2000', '102,101,30000000,3000', '200,1,0,99']);
  assert.deepEqual(treeOf(list, 100).map((p) => p.pid), [100, 101, 102]);
  assert.deepEqual(treeOf(list, 999), []);
});

test('/proc stat inside a container, summed over a process tree', () => {
  // pid (comm with space) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime … rss
  const line = (pid: number, ppid: number, pgrp: number, utime: number, stime: number, rss: number) =>
    `${pid} (node run) S ${ppid} ${pgrp} 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 100 1000 ${rss} 0`;
  // 40 is Claude Code; 41 a command it started in a group of its own, 42 that command's child; 7 is unrelated.
  const trees = parseProcTrees([line(40, 1, 40, 100, 50, 256), line(41, 40, 41, 200, 0, 512), line(42, 41, 41, 100, 0, 128), line(7, 1, 7, 10, 0, 1)].join('\n'), [40, 99]);
  assert.deepEqual(trees.get(40), { cpuSeconds: 4.5, memBytes: 896 * 4096 });
  assert.equal(trees.has(99), false);
});

test('Docker memory figures', () => {
  assert.equal(parseDockerBytes('1.5GiB / 7.6GiB'), 1.5 * 1024 ** 3);
  assert.equal(parseDockerBytes('512MiB'), 512 * 1024 ** 2);
});
