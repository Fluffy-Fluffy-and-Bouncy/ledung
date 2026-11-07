// Issue #186: the composer's 🔑 and 📎 move from beside Send into the macros' ＋ menu, the ＋ is always "＋" (never
// "+1"/"+2"), and the menu takes the arrow keys (Martin, 2026-11-07 13:44, Ledung question #671: "Yes, build it, with
// a fixed + icon that always shows (not "+1"), and arrow-key navigation in the menu").
// The arrow-key rule is tested on its own; the bar and the whole session view are drawn in a small browser stand-in
// (happy-dom), as macro-plus.test.ts and typing-renders.test.ts do.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { Window } from 'happy-dom';
import type { Macro } from '../src/shared/macros.ts';
import { menuStep } from '../web/src/menuNav.ts';
import { removeTemp } from './temp.ts';

// ---- The arrow-key rule ----

test('Down and Up move one item and wrap around at either end', () => {
  const all = [true, true, true];
  assert.equal(menuStep(all, 0, 'ArrowDown'), 1);
  assert.equal(menuStep(all, 2, 'ArrowDown'), 0, 'Down from the last goes to the first');
  assert.equal(menuStep(all, 1, 'ArrowUp'), 0);
  assert.equal(menuStep(all, 0, 'ArrowUp'), 2, 'Up from the first goes to the last');
});

test('with nothing focused, Down and Home land on the first item, Up and End on the last', () => {
  const all = [true, true, true, true];
  assert.equal(menuStep(all, -1, 'ArrowDown'), 0);
  assert.equal(menuStep(all, -1, 'Home'), 0);
  assert.equal(menuStep(all, -1, 'ArrowUp'), 3);
  assert.equal(menuStep(all, -1, 'End'), 3);
  assert.equal(menuStep(all, 2, 'Home'), 0);
  assert.equal(menuStep(all, 1, 'End'), 3);
});

test('disabled items are stepped over (the 🔑 and 📎 on a session that takes no messages)', () => {
  const m = [false, false, true, true];
  assert.equal(menuStep(m, -1, 'ArrowDown'), 2);
  assert.equal(menuStep(m, 3, 'ArrowDown'), 2, 'wraps past the disabled first two');
  assert.equal(menuStep(m, 2, 'ArrowUp'), 3, 'wraps past them going up too');
  assert.equal(menuStep(m, -1, 'Home'), 2);
  assert.equal(menuStep([true, false, true], 0, 'ArrowDown'), 2);
});

test('other keys and a menu with nothing to pick move nowhere', () => {
  assert.equal(menuStep([true, true], 0, 'a'), null);
  assert.equal(menuStep([true, true], 0, 'Enter'), null);
  assert.equal(menuStep([false, false], 0, 'ArrowDown'), null);
  assert.equal(menuStep([], -1, 'ArrowDown'), null);
});

// ---- The bar and the session view, drawn ----

const root = path.join(import.meta.dirname, '..');
let page: any;
let dir: string;
let win: Window;

before(async () => {
  win = new Window({ url: 'http://127.0.0.1:4398/' });
  for (const key of ['window', 'document', 'localStorage', 'location', 'history', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Bundled, act() queues through a new MessageChannel each time, whose ports keep Node from exiting.
  (globalThis as any).MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
  };
  dir = mkdtempSync(path.join(tmpdir(), 'ledung-plus-menu-'));
  const out = path.join(dir, 'page.mjs');
  await build({
    stdin: {
      contents: [
        "export { MacroChips } from './web/src/components/MacroChips.tsx';",
        "export { SessionView } from './web/src/App.tsx';",
        "export { createElement, act } from 'react';",
        "export { createRoot } from 'react-dom/client';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  });
  page = await import(pathToFileURL(out).href);
});

after(async () => {
  await win.happyDOM.close();
  await stop();
  removeTemp(dir);
});

type Action = { id: string; label: string; title: string; disabled?: boolean; onPick: () => void };

async function drawBar(macros: Macro[], actions?: Action[]) {
  const used: { name: string; other: boolean }[] = [];
  const edits: number[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = page.createRoot(host);
  await page.act(async () => r.render(page.createElement(page.MacroChips, {
    macros, actions, onUse: (m: Macro, other: boolean) => used.push({ name: m.name, other }), onEdit: () => edits.push(1),
  })));
  return {
    host, used, edits,
    done: async () => { await page.act(async () => r.unmount()); host.remove(); },
  };
}

const plusOf = (host: HTMLElement) => host.querySelector('button.macro-more') as HTMLButtonElement;
const menuOf = (host: HTMLElement) => host.querySelector('.macro-menu') as HTMLElement | null;
/** The menu as read top to bottom: each item's text, and "—" for a divider. */
const readMenu = (host: HTMLElement) => [...(menuOf(host)?.children ?? [])].map((el) => (el.tagName === 'HR' ? '—' : el.textContent));
const focused = () => (document.activeElement?.textContent ?? '');
async function press(key: string, shiftKey = false) {
  const at = document.activeElement as HTMLElement;
  await page.act(async () => { at.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); });
}

const macro = (id: string, name: string, over: Partial<Macro> = {}): Macro => ({ id, name, text: name, send: false, chip: true, key: null, project: null, ...over });
const actions = (picked: string[], disabled = false): Action[] => [
  { id: 'secret', label: '🔑 Lock a secret…', title: 'secret', disabled, onPick: () => picked.push('secret') },
  { id: 'images', label: '📎 Add images…', title: 'images', disabled, onPick: () => picked.push('images') },
];

test('the ＋ reads "＋" whatever number of macros are in its menu, never "+N" (Done 2)', async () => {
  for (const extra of [0, 1, 2, 5]) {
    const macros = Array.from({ length: extra }, (_, i) => macro(`k${i}`, `Keyed ${i}`, { chip: false, key: `Alt+${i}` }));
    const bar = await drawBar([macro('a', 'Go on'), ...macros], actions([]));
    try {
      // A keybind-only macro is always in the menu, so `extra` of them is what read "+extra" before.
      assert.equal(plusOf(bar.host).textContent, '＋', `${extra} macro(s) in the menu`);
    } finally {
      await bar.done();
    }
  }
});

test('the menu opens with "Lock a secret…" and "Add images…", a divider, the macros, then "Edit macros…" (Done 3)', async () => {
  const picked: string[] = [];
  const bar = await drawBar([macro('a', 'Go on'), macro('k', 'Keyed', { chip: false, key: 'Alt+K' })], actions(picked));
  try {
    await page.act(async () => plusOf(bar.host).click());
    const read = readMenu(bar.host);
    assert.equal(read[0], '🔑 Lock a secret…');
    assert.equal(read[1], '📎 Add images…');
    assert.equal(read[2], '—');
    assert.ok(read[3]?.startsWith('Keyed'), `the macro after the divider: ${read[3]}`);
    assert.equal(read[4], '—');
    assert.equal(read[5], 'Edit macros…');
    assert.equal(read.length, 6);
    // Each of the two does what its old button did: the caller's action, and the menu closes.
    await page.act(async () => (menuOf(bar.host)!.children[1] as HTMLButtonElement).click());
    assert.deepEqual(picked, ['images']);
    assert.equal(menuOf(bar.host), null, 'picking closes the menu');
    await page.act(async () => plusOf(bar.host).click());
    await page.act(async () => (menuOf(bar.host)!.children[0] as HTMLButtonElement).click());
    assert.deepEqual(picked, ['images', 'secret']);
  } finally {
    await bar.done();
  }
});

test('with the menu open, Down and Up move between its entries, Enter picks one (Done 4)', async () => {
  const picked: string[] = [];
  const bar = await drawBar([macro('k', 'Keyed', { chip: false, key: 'Alt+K' })], actions(picked));
  try {
    await page.act(async () => plusOf(bar.host).click());
    assert.equal(focused(), '🔑 Lock a secret…', 'opening puts the focus on the first entry');
    await press('ArrowDown');
    assert.equal(focused(), '📎 Add images…');
    await press('ArrowDown');
    assert.ok(focused().startsWith('Keyed'), `the divider is skipped: ${focused()}`);
    await press('ArrowDown');
    assert.equal(focused(), 'Edit macros…');
    await press('ArrowDown');
    assert.equal(focused(), '🔑 Lock a secret…', 'Down from the last wraps to the first');
    await press('ArrowUp');
    assert.equal(focused(), 'Edit macros…', 'Up from the first wraps to the last');
    await press('ArrowUp');
    await press('Enter', true);
    assert.deepEqual(bar.used, [{ name: 'Keyed', other: true }], 'Enter picks the macro, Shift+Enter its other way as Shift+click does');
    assert.equal(menuOf(bar.host), null);

    await page.act(async () => plusOf(bar.host).click());
    await press('ArrowDown');
    await press('Enter');
    assert.deepEqual(picked, ['images'], 'Enter on "Add images…" picks it');
  } finally {
    await bar.done();
  }
});

test('Escape closes the menu and gives the focus back to the ＋ (Done 4)', async () => {
  const bar = await drawBar([], actions([]));
  try {
    await page.act(async () => plusOf(bar.host).click());
    assert.ok(menuOf(bar.host), 'the menu is open');
    // Booleans, not elements: a failing assert on two DOM nodes prints happy-dom's whole object graph and runs out of memory.
    assert.ok(menuOf(bar.host)!.contains(document.activeElement), 'the focus is in the menu');
    await press('Escape');
    assert.equal(menuOf(bar.host), null, 'Escape closes it');
    assert.ok(document.activeElement === plusOf(bar.host), 'and the focus is on the ＋ again');
    // From the ＋ the keyboard opens it again: Down to the first entry, Up to the last.
    await press('ArrowDown');
    assert.equal(focused(), '🔑 Lock a secret…');
    await press('Escape');
    await press('ArrowUp');
    assert.equal(focused(), 'Edit macros…');
  } finally {
    await bar.done();
  }
});

test('on a session that takes no messages the two entries are greyed out and the arrows skip them', async () => {
  const picked: string[] = [];
  const bar = await drawBar([], actions(picked, true));
  try {
    await page.act(async () => plusOf(bar.host).click());
    const items = [...menuOf(bar.host)!.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    assert.deepEqual(items.map((b) => b.disabled), [true, true, false]);
    assert.equal(focused(), 'Edit macros…', 'the focus lands on the first entry that can be picked');
    await press('ArrowDown');
    assert.equal(focused(), 'Edit macros…');
    assert.deepEqual(picked, []);
  } finally {
    await bar.done();
  }
});

// ---- The session view: Send alone, and the menu reaching the composer ----

function session(status = 'idle') {
  return {
    id: 's1', project: 'demo', runner: 'local', title: 'Plus menu', role: 'session', status, permissionMode: 'default',
    claudeSessionId: 'c1', model: null, requestedModel: null, profile: null, clearDue: null, clearedAt: null, compacting: null,
    claudeVersion: null, cwd: null, workDir: null, createdAt: 1, endedAt: null, endReason: null, parentId: null, backgroundTasks: 0,
    branch: null, contextTokens: null, contextWindow: null, pr: null, tickets: [], priority: 'normal', priorityNote: null, paused: false,
    queuedAt: null, account: null, archivedAt: null, order: null, remoteControl: null,
  };
}

async function drawSession() {
  const s = session();
  const l = {
    sessions: [s], projects: [{ name: 'demo', colours: null }], workflows: {}, runs: {}, chats: null, machine: null, overview: null, board: null, away: null,
    questions: {}, permissions: {}, messages: [], hasEarlier: false, loadEarlier: async () => {}, userName: 'Simon', bangShell: 'bash',
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = page.createRoot(host);
  await page.act(async () => r.render(page.createElement(page.SessionView, {
    session: s, ledung: l, pendingCount: 0, run: async (a: () => Promise<unknown>) => { await a(); },
    focusQuestion: null, cameFrom: null, onOpenQuestion: () => {}, onOpenBoardThread: () => {}, onBack: () => {},
  })));
  return { host, done: async () => { await page.act(async () => r.unmount()); host.remove(); } };
}

test('in the session view Send sits alone, and the ＋ menu opens the masked field and the file picker (Done 1, 3)', async () => {
  const view = await drawSession();
  try {
    const row = view.host.querySelector('.composer .send-row')!;
    const buttons = [...row.querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['Send'], 'no 🔑 or 📎 beside Send');
    assert.equal(view.host.querySelector('.composer .secret-pop'), null, 'no masked field yet');

    const plus = plusOf(view.host);
    assert.ok(plus, 'the ＋ is in the bar above the box');
    await page.act(async () => plus.click());
    assert.deepEqual(readMenu(view.host).slice(0, 3), ['🔑 Lock a secret…', '📎 Add images…', '—']);
    await page.act(async () => (menuOf(view.host)!.children[0] as HTMLButtonElement).click());
    assert.ok(view.host.querySelector('.composer .secret-pop[aria-label="Lock a secret"]'), '"Lock a secret…" opens the masked field');

    const picker = view.host.querySelector('.composer input[type="file"]') as HTMLInputElement;
    let opened = 0;
    picker.click = () => { opened++; };
    await page.act(async () => plus.click());
    await page.act(async () => (menuOf(view.host)!.children[1] as HTMLButtonElement).click());
    assert.equal(opened, 1, '"Add images…" opens the file picker');
  } finally {
    await view.done();
  }
});
