import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOrder, mayStart } from '../src/resources/line.ts';
import { commandKinds } from '../src/resources/commands.ts';
import { typicalCosts } from '../src/resources/typical.ts';
import { parseMeminfo, parseVmStat } from '../src/platform/memory.ts';

test('the line: priority first, then who waited longest', () => {
  const line = [
    { id: 'a', priority: 'normal' as const, since: 1 },
    { id: 'b', priority: 'high' as const, since: 5 },
    { id: 'c', priority: 'critical' as const, since: 9 },
    { id: 'd', priority: 'normal' as const, since: 0 },
  ];
  assert.deepEqual(lineOrder(line), ['c', 'b', 'd', 'a']);
  // With 1 of 2 places taken, only the first in line may start; someone new joins at the back.
  assert.equal(mayStart('c', 1, 2, line), true);
  assert.equal(mayStart('b', 1, 2, line), false);
  assert.equal(mayStart('new', 1, 2, line), false);
  assert.equal(mayStart('new', 1, 2, []), true);
  assert.equal(mayStart('new', 2, 2, []), false);
});

test('kinds of command, without the ones that only look around', () => {
  assert.deepEqual(commandKinds('cd app && npm run build 2>&1 | tail -5'), ['npm run build']);
  assert.deepEqual(commandKinds('CI=1 pnpm test --watch=false'), ['pnpm test']);
  assert.deepEqual(commandKinds('python -m pytest tests/ -x; git status'), ['python pytest', 'git status']);
  assert.deepEqual(commandKinds('ls -la\ncat x'), []);
  assert.deepEqual(commandKinds('"C:/Program Files/nodejs/npx.cmd" tsc -p .'), ['npx tsc']);
});

test('typical costs per project and kind of command', () => {
  const t = (project: string, commands: string[], peakMem: number) => ({
    sessionId: 's', project, startedAt: 0, durationMs: 60000, avgCores: 1, peakCores: 2, peakMem, model: null, trigger: 'user', commands,
  });
  const costs = typicalCosts([t('p', ['npm run build'], 2e9), t('p', ['npm run build', 'git status'], 4e9), t('p', [], 1e8), t('q', ['npm run build'], 1e9)]);
  const build = costs.find((c) => c.project === 'p' && c.command === 'npm run build')!;
  assert.equal(build.turns, 2);
  assert.equal(build.peakMem, 3e9);
  assert.ok(costs.some((c) => c.project === 'p' && c.command === ''));
});

test('memory in use: macOS counts app memory, wired and compressed, not cache', () => {
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                     4321.',
    'Pages active:                                 231059.',
    'Pages inactive:                               229556.',
    'Pages wired down:                             241074.',
    'Pages purgeable:                                3981.',
    'File-backed pages:                            172506.',
    'Anonymous pages:                              288887.',
    'Pages occupied by compressor:                 302699.',
  ].join('\n');
  assert.equal(parseVmStat(vmStat), (288887 - 3981 + 241074 + 302699) * 16384);
  assert.equal(parseVmStat('nonsense'), null);
  const meminfo = 'MemTotal:       16000000 kB\nMemFree:          200000 kB\nMemAvailable:    9000000 kB\n';
  assert.equal(parseMeminfo(meminfo), 7000000 * 1024);
  assert.equal(parseMeminfo('MemTotal: 5 kB'), null);
});
