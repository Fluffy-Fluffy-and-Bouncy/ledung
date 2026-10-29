import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COMPACT_KEY, COMPACT_STEPS, compactRows, readCompact, rowTooltip, saveCompact, type CompactStore } from '../web/src/compactSidebar.ts';

// Issue #153: a Compact sidebar slider in Settings, four steps from None to Tightest, kept per
// browser. Step 2 drops the time row, steps 3 and 4 the usage line too and turn "+ Session" into
// "+"; the ship stays at every step; what a step hides goes into the row's tooltip.

function memoryStore(): CompactStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', ...file.split('/')), 'utf8');

test('a browser that never moved the slider is at None', () => {
  assert.equal(readCompact(memoryStore()), 1);
});

test('the step is kept in this browser, and back at None removes the entry', () => {
  const store = memoryStore();
  for (const step of [2, 3, 4] as const) {
    saveCompact(store, step);
    assert.equal(readCompact(store), step);
  }
  saveCompact(store, 1);
  assert.equal(readCompact(store), 1);
  assert.equal(store.data.has(COMPACT_KEY), false);
});

test('a stored value it does not know reads as None', () => {
  for (const bad of ['0', '5', '2.5', 'max', '']) {
    const store = memoryStore();
    store.setItem(COMPACT_KEY, bad);
    assert.equal(readCompact(store), 1, bad);
  }
});

test('a browser whose storage refuses is at None and saving does not throw', () => {
  const broken: CompactStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readCompact(broken), 1);
  assert.doesNotThrow(() => saveCompact(broken, 4));
});

test('four steps, None first, in the order of the mockup columns', () => {
  assert.deepEqual(COMPACT_STEPS.map((s) => s.step), [1, 2, 3, 4]);
  assert.equal(COMPACT_STEPS[0]!.label, 'None');
});

test('each step keeps the rows the issue gives it', () => {
  // 1 None: as before.
  assert.deepEqual(compactRows(1), { time: true, usage: true, plusOnly: false });
  // 2: no time row, the usage line kept.
  assert.deepEqual(compactRows(2), { time: false, usage: true, plusOnly: false });
  // 3: title, ship and badge only; "+".
  assert.deepEqual(compactRows(3), { time: false, usage: false, plusOnly: true });
  // 4: as 3, tightest; the ship at 6 px, the size a click steps to from the 7 px default.
  assert.deepEqual(compactRows(4), { time: false, usage: false, plusOnly: true, shipMax: 6 });
});

test('step 1 leaves the tooltip as it was; steps 2–4 add the time and the usage line with its branch', () => {
  const usage = '72k today · ctx 35% · am/writer';
  assert.equal(rowTooltip(1, undefined, 'Today 14:02', usage), undefined);
  assert.equal(rowTooltip(1, 'Working', 'Today 14:02', usage), 'Working');
  for (const step of [2, 3, 4] as const) {
    assert.equal(rowTooltip(step, undefined, 'Today 14:02', usage), `Today 14:02\n${usage}`);
    assert.equal(rowTooltip(step, 'Working', 'Today 14:02', usage), `Working\nToday 14:02\n${usage}`);
    assert.equal(rowTooltip(step, undefined, 'Today 14:02', ''), 'Today 14:02');
  }
});

// The sidebar must follow the slider: its rows, the project buttons and the ship's size come from compactRows.
test('the sidebar draws its rows, tooltip, ship and project buttons from the step', () => {
  const app = read('web/src/App.tsx');
  const sidebar = app.slice(app.indexOf('function Sidebar('), app.indexOf('function SessionView('));
  assert.match(sidebar, /const \[compact\] = useCompactSidebar\(\);/);
  assert.match(sidebar, /const shows = compactRows\(compact\);/);
  // The step marks the sidebar only from step 2 on, so None is the page as before.
  assert.match(sidebar, /<nav className="session-list" data-compact=\{compact > 1 \? compact : undefined\}/);
  assert.match(sidebar, /\{shows\.time && <span className="session-sub">\{time\}<\/span>\}/);
  assert.match(sidebar, /\{shows\.usage && usage && <span className="session-sub usage-line">\{usage\}<\/span>\}/);
  assert.match(sidebar, /title=\{rowTooltip\(compact, rowStatus\(dotShown, s\)\.tooltip, time, usage\)\}/);
  // The ship is drawn at every step: no step condition in front of it, only its size capped.
  assert.match(sidebar, /return mode && <span className=\{`session-ship [^`]*`\}><SailingShip [^>]*maxSize=\{shows\.shipMax\}/);
  assert.match(sidebar, /shows\.plusOnly \? \(\s*<button className="mini" title=\{`New session in \$\{g\.name\}`\}/);
  // No other time or usage row that ignores the step.
  assert.equal(sidebar.match(/className="session-sub/g)?.length, 2);
});

test('each step has its padding in the stylesheet, and step 4 its 28 px rows', () => {
  const css = read('web/src/styles.css');
  for (const step of [2, 3, 4]) assert.match(css, new RegExp(`\\.session-list\\[data-compact="${step}"\\] \\.session-item \\{[^}]*padding(-block)?:`));
  assert.match(css, /\.session-list\[data-compact="4"\] \.session-item \{[^}]*min-height: 28px/);
});

test('Settings → Sidebar has the slider, live: it saves on every change', () => {
  const settings = read('web/src/components/SettingsView.tsx');
  const sidebar = settings.slice(settings.indexOf('<h3>Sidebar</h3>'), settings.indexOf('<h3>Notifications</h3>'));
  assert.match(sidebar, /<CompactSlider \/>/);
  assert.match(settings, /<input type="range" min=\{1\} max=\{COMPACT_STEPS\.length\} step=\{1\} value=\{step\}[^>]*onChange=\{\(e\) => set\(/);
});
