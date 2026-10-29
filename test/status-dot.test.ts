import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STATUS_DOT_KEY, readStatusDot, rowStatus, saveStatusDot, type DotStore } from '../web/src/statusDot.ts';

// Issue #151: the status dot left of every sidebar row can be switched off in Settings, per browser,
// shown by default. With it off, the row's status is its tooltip and an ended session looks ended.

function memoryStore(): DotStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('the dot is shown in a browser that never switched it off', () => {
  assert.equal(readStatusDot(memoryStore()), true);
});

test('the switch is kept in this browser and back on removes the entry', () => {
  const store = memoryStore();
  saveStatusDot(store, false);
  assert.equal(readStatusDot(store), false);
  saveStatusDot(store, true);
  assert.equal(readStatusDot(store), true);
  assert.equal(store.data.has(STATUS_DOT_KEY), false);
});

test('a browser whose storage refuses shows the dot and saving does not throw', () => {
  const broken: DotStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readStatusDot(broken), true);
  assert.doesNotThrow(() => saveStatusDot(broken, false));
});

test('on: every row has its dot and nothing else changes, as before the switch', () => {
  for (const status of ['running', 'waiting', 'idle', 'ended'] as const) {
    assert.deepEqual(rowStatus(true, { status }), { dot: true, ended: false });
  }
});

test('off: no dot, the status label as the row\'s tooltip, and only an ended session marked ended', () => {
  assert.deepEqual(rowStatus(false, { status: 'running' }), { dot: false, tooltip: 'Working', ended: false });
  assert.deepEqual(rowStatus(false, { status: 'waiting' }), { dot: false, tooltip: 'Needs your answer', ended: false });
  assert.deepEqual(rowStatus(false, { status: 'idle' }), { dot: false, tooltip: 'Ready', ended: false });
  assert.deepEqual(rowStatus(false, { status: 'ended' }), { dot: false, tooltip: 'Ended', ended: true });
});

// The sidebar row must follow the switch: its dot, tooltip and ended look come from rowStatus.
test('the sidebar row draws its dot, tooltip and ended look from the switch', () => {
  const app = readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'App.tsx'), 'utf8');
  const sidebar = app.slice(app.indexOf('function Sidebar('), app.indexOf('<aside className="sidebar">'));
  assert.match(sidebar, /const \[dotShown\] = useStatusDot\(\);/);
  assert.match(sidebar, /\{rowStatus\(dotShown, s\)\.dot && <span className=\{`dot /);
  assert.match(sidebar, /title=\{rowTooltip\(compact, rowStatus\(dotShown, s\)\.tooltip/);
  assert.match(sidebar, /rowStatus\(dotShown, s\)\.ended \? ' ended-row'/);
  // No other dot in the row that ignores the switch.
  assert.equal(sidebar.match(/className=\{`dot /g)?.length, 1);
  const css = readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.session-item\.ended-row \.session-title \{[^}]*opacity/);
});
