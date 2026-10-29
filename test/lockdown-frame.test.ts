// A locked project's vault border (issue #129): which border is drawn for off, A and B, as in the chosen mockup
// (Vault 1, "the whole chat panel framed"): A a single riveted frame with the out-only slot », B a heavy double
// frame with the lock in red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { borderRuns, frameLevel, frameThickness, vaultBorder } from '../web/src/lockdownFrame.ts';

const rows = (b: { ch: string[][] }) => b.ch.map((r) => r.join(''));

test('off, no lockdown and a removed project draw no frame; A and B draw theirs', () => {
  assert.equal(frameLevel({ lockdown: { level: 'off' } }), null);
  assert.equal(frameLevel({}), null);
  assert.equal(frameLevel(null), null);
  assert.equal(frameLevel(undefined), null);
  assert.equal(frameLevel({ lockdown: { level: 'A' } }), 'A');
  assert.equal(frameLevel({ lockdown: { level: 'B' } }), 'B');
});

test('level A: one riveted single frame, the lock in the top edge, the dial at the top right and the slot » half-way down the right', () => {
  assert.equal(frameThickness('A'), 1);
  const b = vaultBorder('A', 30, 8);
  const r = rows(b);
  assert.equal(r.length, 8);
  assert.ok(r.every((l) => l.length === 30));
  // Rivets every sixth cell along the top and bottom edges, from the fourth; the lock and dial sit over them.
  assert.equal(r[0], '┌──┤ LOCK A ├──o─────o─(|)─o─┐');
  assert.equal(r[7], '└──o─────o─────o─────o─────o─┘');
  // Left edge: rivets every third row, never right above the corner.
  assert.deepEqual(r.map((l) => l[0]), ['┌', '│', 'o', '│', '│', 'o', '│', '└']);
  assert.deepEqual(r.map((l) => l[29]), ['┐', '│', 'o', '│', '»', 'o', '│', '┘']);
  // Inside is empty: the framed piece shows through.
  assert.ok(r.slice(1, 7).every((l) => l.slice(1, 29).trim() === ''));
  // The lock and the slot in the accent colour, nothing in red.
  assert.equal(b.kind[0]!.slice(3, 13).join(''), 'aaaaaaaaaa');
  assert.equal(b.kind[4]![29], 'a');
  assert.ok(b.kind.every((l) => !l.includes('d')));
});

test('level B: a heavy riveted frame with a light one inside, the lock and dial in red, and no slot', () => {
  assert.equal(frameThickness('B'), 2);
  const b = vaultBorder('B', 30, 8);
  const r = rows(b);
  assert.equal(r[0], '┏━━┤ LOCK B ├━━o━━━━━o━(|)━o━┓');
  assert.equal(r[1], '┃┌──────────────────────────┐┃');
  assert.equal(r[6], '┃└──────────────────────────┘┃');
  assert.equal(r[7], '┗━━o━━━━━o━━━━━o━━━━━o━━━━━o━┛');
  assert.deepEqual(r.map((l) => l[29]), ['┓', '┃', 'o', '┃', '┃', 'o', '┃', '┛']);
  assert.ok(!r.join('').includes('»'));
  assert.ok(r.slice(2, 6).every((l) => l.slice(2, 28).trim() === ''));
  assert.equal(b.kind[0]!.slice(3, 13).join(''), 'dddddddddd');
  assert.equal(b.kind[0]!.slice(23, 26).join(''), 'ddd');
});

test('the runs put the rows back together, one colour per run', () => {
  const b = vaultBorder('A', 24, 5);
  const runs = borderRuns(b);
  assert.deepEqual(runs.map((row) => row.map((x) => x.text).join('')), rows(b));
  for (const row of runs) for (let i = 1; i < row.length; i++) assert.notEqual(row[i]!.kind, row[i - 1]!.kind);
});
